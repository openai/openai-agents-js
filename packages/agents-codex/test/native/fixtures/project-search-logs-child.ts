import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, Environment, NativeProvider, telemetry } from '../../../src';
import type { JsonObject } from '../../../src/runtime/binding';
import { ModelServer, call, message } from './model-server';
import { nativeDescendantModel } from './native-descendant-model';
import { startPublicExecutor } from './public-executor';

type LogRecord = {
  attributes?: {
    key: string;
    value: { stringValue?: string; boolValue?: boolean; intValue?: string };
  }[];
};
type LogBatch = {
  resourceLogs?: { scopeLogs?: { logRecords?: LogRecord[] }[] }[];
};
function attributes(record: LogRecord) {
  return Object.fromEntries(
    (record.attributes ?? []).map(({ key, value }) => [
      key,
      value.stringValue ?? value.boolValue ?? value.intValue,
    ]),
  );
}
async function flush() {
  const result = await telemetry.forceFlush({ timeoutMs: 5_000 });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.droppedRecords, 0);
  assert.equal(result.failedDeliveries, 0);
}
async function enteredWithin(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Search callback did not enter')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const mode = process.argv[2];
  assert(
    typeof mode === 'string' &&
      ['direct-accept', 'code-accept', 'direct-reject', 'code-reject'].includes(
        mode,
      ),
  );
  const code = mode.startsWith('code');
  const reject = mode.endsWith('reject');
  const received: LogBatch[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.equal(request.url, '/v1/logs');
    received.push(JSON.parse(Buffer.concat(chunks).toString()) as LogBatch);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) =>
    collector.listen(0, '127.0.0.1', resolve),
  );
  const address = collector.address();
  assert(address && typeof address !== 'string');
  let configured = false;
  try {
    await telemetry.configure({
      logs: {
        kind: 'otlp-http',
        endpoint: `http://127.0.0.1:${address.port}/v1/logs`,
        protocol: 'json',
      },
      toolResultMaxBytes: 16_384,
    });
    configured = true;
    const records = () =>
      received.flatMap((batch) =>
        (batch.resourceLogs ?? []).flatMap((resource) =>
          (resource.scopeLogs ?? []).flatMap((scope) => scope.logRecords ?? []),
        ),
      );
    const searchRecords = () =>
      records()
        .map(attributes)
        .filter(
          (record) =>
            record['event.name'] === 'codex.tool_result' &&
            record.tool_name === 'project_grep',
        );
    const executor = await startPublicExecutor();
    try {
      const rawCanary = `raw-private-search-${mode}-b3ad`;
      const errorCanary = `private-callback-error-${mode}-c871`;
      const projection = {
        matches: [],
        redacted: true,
        marker: 'accepted-search-projection',
      };
      await writeFile(
        join(executor.cwd, 'fixture.txt'),
        `search-token ${rawCanary}\n`,
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const model = new ModelServer([
        code
          ? [
              {
                type: 'custom_tool_call',
                name: 'exec',
                call_id: 'observed-search',
                input:
                  'text(await tools.project_grep({pattern:"search-token"}));',
              },
            ]
          : [
              call(
                'project_grep',
                { pattern: 'search-token' },
                { callId: 'observed-search' },
              ),
            ],
        ...(!reject
          ? [
              (request: JsonObject) => {
                const item = (request.input as JsonObject[]).find(
                  (entry) =>
                    entry.call_id === 'observed-search' &&
                    entry.type ===
                      (code
                        ? 'custom_tool_call_output'
                        : 'function_call_output'),
                );
                assert(item);
                assert(JSON.stringify(item.output).includes(projection.marker));
                assert(!JSON.stringify(item.output).includes(rawCanary));
                return [message('accepted search')];
              },
            ]
          : []),
      ]);
      try {
        const config = await model.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-search-log-privacy',
          supportsWebsockets: false,
        });
        const environment = new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['project_grep'],
          async transformResult(_context, value) {
            calls++;
            assert(JSON.stringify(value).includes(rawCanary));
            entered.resolve();
            await release.promise;
            if (reject) throw new Error(errorCanary);
            return projection;
          },
        });
        await using session = await new Agent({
          provider,
          model: nativeDescendantModel,
          instructions: 'Search.',
          programmaticToolCalling: code,
        }).session({
          environment,
          tracing: {
            name: `search.log-privacy.${mode}`,
            includeSensitiveData: true,
          },
        });
        const turn = await session.submit('Go.');
        let settled = false;
        const outcome = turn
          .wait()
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          .finally(() => {
            settled = true;
          });
        try {
          await enteredWithin(entered.promise);
          assert.equal(calls, 1);
          assert.equal(settled, false);
          await flush();
          assert.equal(settled, false);
          assert.deepEqual(searchRecords(), []);
          assert(!JSON.stringify(received).includes(rawCanary));
          release.resolve();
          const result = await outcome;
          await flush();
          const completed = searchRecords();
          if (reject) {
            assert.equal(result.ok, false);
            if (result.ok) throw new Error('Expected policy failure');
            assert(result.error instanceof Error);
            assert.equal(result.error.name, 'NativeError');
            assert.equal(result.error.message, 'Executor policy failed');
            for (const record of completed) {
              assert.equal(record.success, 'false');
              assert(!String(record.output).includes(projection.marker));
            }
            assert.equal(model.requests.length, 1);
          } else {
            if (!result.ok) throw result.error;
            assert.equal(result.value.finalOutput, 'accepted search');
            assert.equal(completed.length, 1);
            assert(completed[0]);
            assert.equal(completed[0].success, 'true');
            assert.equal(completed[0].output_truncated, false);
            assert.equal(typeof completed[0].call_id, 'string');
            assert(String(completed[0].call_id).length > 0);
            if (!code) assert.equal(completed[0].call_id, 'observed-search');
            assert.deepEqual(
              JSON.parse(String(completed[0].output)),
              projection,
            );
          }
          assert.equal(calls, 1);
          for (const canary of [rawCanary, errorCanary]) {
            assert(!JSON.stringify(received).includes(canary));
            assert(!JSON.stringify(model.requests).includes(canary));
          }
          model.assertExhausted();
          console.log(
            JSON.stringify({
              mode,
              blockedRecords: 0,
              completed: completed.length,
              records: completed,
            }),
          );
        } finally {
          release.resolve();
          await outcome;
        }
      } finally {
        await ModelServer.closeAll();
      }
    } finally {
      await executor.close();
    }
    console.log(`PASS ${mode}`);
  } finally {
    try {
      if (configured) await telemetry.shutdown();
    } finally {
      collector.closeAllConnections();
      await new Promise<void>((resolve) => collector.close(() => resolve()));
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
