import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { telemetry } from '../../../src';
import type { TraceEvent } from '../../../src/runtime/telemetry';

async function main() {
  const received: {
    auth: string | undefined;
    organization: string | undefined;
    records: any[];
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      auth: request.headers.authorization,
      organization: request.headers['openai-organization'] as
        string | undefined,
      records: JSON.parse(Buffer.concat(chunks).toString()).data,
    });
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const exporter = new telemetry.OpenAITraceExporter({
    apiKey: 'fallback-secret',
    organization: 'fallback-org',
    endpoint: `http://127.0.0.1:${address.port}/ingest`,
  });
  const observed: TraceEvent[] = [];
  const groups: (readonly TraceEvent[])[] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await telemetry.configure({
      traceProcessors: [
        {
          onEvents: async (events) => {
            await ready;
            observed.push(...events);
            groups.push(events);
            const scoped = events.find(
              (event) => event.credential_required === true,
            );
            if (scoped)
              await assert.rejects(
                exporter.onEvent({ ...scoped, name: 'copied foreign root' }),
                /credential delivery is unavailable/,
              );
            await exporter.onEvents(events);
          },
        },
      ],
    });
    const a = new telemetry.TraceExportCredentials({
      headers: { Authorization: 'Bearer trace-secret-A' },
    });
    const rootA = await telemetry.startTrace({
      name: 'authenticated-A',
      exportCredential: a,
    });
    a.close();
    rootA.close();
    const b = new telemetry.TraceExportCredentials({
      headers: { Authorization: 'Bearer trace-secret-B' },
    });
    const rootB = await telemetry.startTrace({
      name: 'authenticated-B',
      exportCredential: b,
    });
    rootB.close();
    (
      await telemetry.startSpan({
        name: 'override-B-under-A',
        parent: rootA,
        exportCredential: b,
      })
    ).close();
    b.close();
    (
      await telemetry.startSpan({ name: 'late-child-A', parent: rootA })
    ).close();
    (
      await telemetry.startSpan({ name: 'late-child-B', parent: rootB })
    ).close();
    (await telemetry.startTrace({ name: 'fallback' })).close();
    release();
    const result = await telemetry.forceFlush();
    assert.equal(result.status, 'success');
    const expected = new Map([
      ['Bearer trace-secret-A', new Set(['authenticated-A', 'late-child-A'])],
      [
        'Bearer trace-secret-B',
        new Set(['authenticated-B', 'late-child-B', 'override-B-under-A']),
      ],
      ['Bearer fallback-secret', new Set(['fallback'])],
    ]);
    for (const [auth, names] of expected) {
      const requests = received.filter((request) => request.auth === auth);
      assert(requests.length > 0);
      assert(
        requests.every((request) => request.organization === 'fallback-org'),
      );
      const records = requests.flatMap((request) => request.records);
      assert.deepEqual(
        new Set(
          records
            .filter((record) => record.object === 'trace.span')
            .map((record) => record.span_data.name),
        ),
        names,
      );
      assert(records.some((record) => record.object === 'trace'));
    }
    assert(
      groups.some(
        (events) => new Set(events.map((event) => event.trace_id)).size >= 2,
      ),
    );
    assert(
      !/trace-secret-A|trace-secret-B|fallback-secret|authorization/i.test(
        JSON.stringify(observed),
      ),
    );
    const scoped = observed.find(
      (event) => event.credential_required === true,
    )!;
    const count = received.length;
    await assert.rejects(
      exporter.onEvent(scoped),
      /credential delivery is unavailable/,
    );
    assert.equal(received.length, count);
    await telemetry.shutdown();
    console.log('PASS host-auth native');
  } finally {
    release();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
