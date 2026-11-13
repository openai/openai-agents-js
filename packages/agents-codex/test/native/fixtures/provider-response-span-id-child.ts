import { z } from 'zod';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { Agent, NativeProvider, telemetry, tool } from '../../../src';
import type { TraceEvent } from '../../../src/runtime/telemetry';
import {
  hasCustomTracingIds,
  providerResponseSpanAdmission,
} from '../../../src/runtime/tracing-context';
import { call, message, ModelServer } from './model-server';

type ExportedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};
type Export = {
  resourceSpans?: { scopeSpans?: { spans?: ExportedSpan[] }[] }[];
};
const traceId = '11'.repeat(16);
const rootId = '12'.repeat(8);
const mode = process.argv[2];

function descends(
  span: ExportedSpan,
  ancestor: string,
  spans: ExportedSpan[],
): boolean {
  let parent = span.parentSpanId;
  for (let depth = 0; parent && depth <= spans.length; depth++) {
    if (parent === ancestor) return true;
    parent = spans.find(
      (candidate) => candidate.spanId === parent,
    )?.parentSpanId;
  }
  return false;
}

async function main() {
  const events: TraceEvent[] = [];
  const exports: Export[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    exports.push(
      JSON.parse(
        (request.headers['content-encoding'] === 'gzip'
          ? gunzipSync(raw)
          : raw
        ).toString(),
      ),
    );
    response.end('{}');
  });
  collector.listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const address = collector.address();
  assert(address && typeof address !== 'string');
  await telemetry.configure({
    traceProcessors: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
    traces: {
      kind: 'otlp-http',
      endpoint: `http://127.0.0.1:${address.port}`,
      protocol: 'json',
    },
  });
  try {
    if (mode === 'host') {
      await telemetry.withTrace(
        { name: 'response-id.application', traceId, spanId: rootId },
        async (root) => {
          const context = root.retain();
          try {
            await telemetry.forceFlush();
            const before = events.length;
            let calls = 0;
            telemetry.setTracingIdGenerator({
              generateTraceId() {
                throw Error('Child allocation must preserve its trace');
              },
              generateSpanId() {
                calls++;
                assert.equal(
                  telemetry.getCurrentSpan()?.context.spanId,
                  rootId,
                );
                return '34'.repeat(8);
              },
            });
            assert.equal(hasCustomTracingIds(), true);
            assert.deepEqual(
              await providerResponseSpanAdmission(
                context,
                new AbortController().signal,
              ),
              { span_id: '34'.repeat(8) },
            );
            assert.equal(calls, 1);
            telemetry.setTracingIdGenerator({
              generateSpanId: () => '0'.repeat(16),
            });
            await assert.rejects(
              providerResponseSpanAdmission(
                context,
                new AbortController().signal,
              ),
              /ID generator/i,
            );
            const aborted = new AbortController();
            aborted.abort(Error('already cancelled'));
            telemetry.setTracingIdGenerator({
              generateSpanId() {
                throw Error('Must not enter a retired callback');
              },
            });
            await assert.rejects(
              providerResponseSpanAdmission(context, aborted.signal),
              /already cancelled/,
            );
            // A different live signal becomes cancelled synchronously inside the policy.
            const during = new AbortController();
            telemetry.setTracingIdGenerator({
              generateSpanId() {
                during.abort(Error('cancelled during allocation'));
                return '56'.repeat(8);
              },
            });
            await assert.rejects(
              providerResponseSpanAdmission(context, during.signal),
              /cancelled during allocation/,
            );
            telemetry.setTracingIdGenerator();
            assert.equal(hasCustomTracingIds(), false);
            assert.deepEqual(
              await providerResponseSpanAdmission(
                context,
                new AbortController().signal,
              ),
              { span_id: null },
            );
            await telemetry.withSpan(
              { name: 'disabled', disabled: true },
              async (disabled) => {
                const token = disabled.retain();
                try {
                  telemetry.setTracingIdGenerator({
                    generateSpanId() {
                      throw Error('Disabled allocation must not enter policy');
                    },
                  });
                  assert.equal(
                    await providerResponseSpanAdmission(
                      token,
                      new AbortController().signal,
                    ),
                    null,
                  );
                } finally {
                  disabled.releaseContext(token);
                  telemetry.setTracingIdGenerator();
                }
              },
            );
            await telemetry.forceFlush();
            assert.equal(
              events.length,
              before,
              'ID admission must not create processor lifecycle events',
            );
          } finally {
            root.releaseContext(context);
          }
        },
      );
      console.log('PASS response span host');
      return;
    }
    const cancelled = new AbortController();
    const supplied = new Set<string>();
    telemetry.setTracingIdGenerator({
      generateTraceId() {
        throw Error('Child scopes must preserve the explicit trace');
      },
      generateSpanId() {
        const parent = telemetry.getCurrentSpan()?.context.spanId;
        if (parent !== rootId && mode === 'invalid') return 'invalid';
        if (parent !== rootId && mode === 'cancel')
          cancelled.abort(Error('response policy cancelled'));
        const id = (0xfeed000000000000n + BigInt(supplied.size + 1)).toString(
          16,
        );
        supplied.add(id);
        return id;
      },
    });
    const rounds = mode === 'rounds';
    let entered!: () => void;
    let release!: () => void;
    const enteredRequest = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasedRequest = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new ModelServer([
      ...(rounds ? [[call('local_echo', {}, { callId: 'call_1' })]] : []),
      ...(mode === 'retry'
        ? [
            {
              status: 503,
              body: JSON.stringify({
                error: {
                  message: 'Synthetic transient failure',
                  type: 'server_error',
                },
              }),
              headers: { 'retry-after-ms': '0' },
            },
          ]
        : []),
      ...(mode === 'cancel-io'
        ? [
            async () => {
              entered();
              await releasedRequest;
              return [message('Observed.')];
            },
          ]
        : [[message('Observed.')]]),
    ]);
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-response-id',
      supportsWebsockets: false,
    });
    let effects = 0;
    const echo = tool({
      name: 'local_echo',
      description: 'Return fixture answer.',
      parameters: z.object({}),
      execute() {
        effects++;
        return 'fixture-tool-result';
      },
    });
    let failure: unknown;
    try {
      await telemetry.withTrace(
        { name: 'response-id.application', traceId, spanId: rootId },
        async () => {
          const agent = new Agent({
            instructions: 'Answer.',
            model: 'gpt-5',
            provider,
            tools: rounds ? [echo] : [],
          });
          try {
            const pending = agent.run('Answer once.', {
              signal: cancelled.signal,
            });
            if (mode === 'cancel-io') {
              await enteredRequest;
              cancelled.abort(Error('after provider I/O'));
            }
            const result = await pending;
            assert.equal(result.finalOutput, 'Observed.');
          } catch (error) {
            failure = error;
          }
        },
      );
      await telemetry.forceFlush();
      const rows = exports
        .flatMap((payload) => payload.resourceSpans ?? [])
        .flatMap((resource) => resource.scopeSpans ?? [])
        .flatMap((scope) => scope.spans ?? [])
        .filter((span) => span.traceId === traceId);
      const responses = rows.filter((span) => span.name === 'response');
      console.log(
        JSON.stringify({
          mode,
          requests: server.requests.length,
          effects,
          response_ids: responses.map((span) => span.spanId),
          error: String(failure),
          supplied: [...supplied],
        }),
      );
      if (mode === 'retry' || mode === 'cancel-io') {
        assert.equal(server.requests.length, mode === 'retry' ? 2 : 1);
        assert.equal(effects, 0);
        assert.equal(responses.length, 1);
        assert(supplied.has(responses[0].spanId));
        assert(
          rows.some(
            (row) =>
              row.name === 'agent.operation' &&
              descends(responses[0], row.spanId, rows),
          ),
        );
        const ends = events.filter(
          (event) =>
            event.trace_id === traceId &&
            event.name === 'response' &&
            event.lifecycle === 'end',
        );
        assert.equal(
          events.filter(
            (event) =>
              event.trace_id === traceId &&
              event.name === 'response' &&
              event.lifecycle === 'start',
          ).length,
          1,
        );
        assert.equal(ends.length, 1);
        assert.equal(ends[0].span_id, responses[0].spanId);
        assert.equal(
          ends[0].attributes['sdk.outcome'],
          mode === 'retry' ? 'ok' : 'cancelled',
        );
        if (mode === 'retry') assert.equal(failure, undefined);
        else assert(failure, 'Cancellation after provider I/O must reject');
      } else if (mode === 'invalid' || mode === 'cancel') {
        assert(failure, 'Invalid or cancelled allocation must reject');
        assert.equal(
          server.requests.length,
          0,
          'ID admission must precede provider I/O',
        );
        assert.equal(effects, 0);
      } else {
        assert.equal(failure, undefined);
        assert.equal(server.requests.length, rounds ? 2 : 1);
        assert.equal(effects, rounds ? 1 : 0);
        assert.equal(responses.length, rounds ? 2 : 1);
        assert(responses.every((span) => supplied.has(span.spanId)));
        assert(
          responses.every((span) =>
            rows.some(
              (parent) =>
                parent.name === 'agent.operation' &&
                descends(span, parent.spanId, rows),
            ),
          ),
        );
        const processor = events.filter(
          (event) => event.trace_id === traceId && event.name === 'response',
        );
        assert.deepEqual(
          new Set(processor.map((event) => event.span_id)),
          new Set(responses.map((span) => span.spanId)),
        );
        const receiving = rows.filter(
          (span) => span.name === 'receiving_stream',
        );
        assert.equal(receiving.length, rounds ? 2 : 1);
        assert(
          receiving.every(
            (span) =>
              !supplied.has(span.spanId) &&
              !responses.some((parent) => descends(span, parent.spanId, rows)),
          ),
        );
        const transport = rows.filter((span) => span.name === 'stream_request');
        assert.equal(transport.length, receiving.length);
        assert(
          transport.every(
            (span) =>
              responses.filter((parent) => descends(span, parent.spanId, rows))
                .length === 1,
          ),
        );
        server.assertExhausted();
      }
      console.log(`PASS response span ${mode}`);
    } finally {
      release();
      await ModelServer.closeAll();
    }
  } finally {
    telemetry.setTracingIdGenerator();
    await telemetry.shutdown();
    await new Promise<void>((resolve, reject) =>
      collector.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
