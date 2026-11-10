import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { telemetry } from '../../../src';
import type { TraceEvent } from '../../../src/runtime/telemetry';

async function main() {
  const received: Record<string, any>[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()).data);
    await new Promise((resolve) => setTimeout(resolve, 500));
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const Constructor = process.env.N06_BASELINE_EXPORTER
    ? (await import(process.env.N06_BASELINE_EXPORTER)).OpenAITraceExporter
    : telemetry.OpenAITraceExporter;
  const exporter = new Constructor({
    apiKey: 'synthetic-key',
    endpoint: `http://127.0.0.1:${address.port}/ingest`,
  });
  const groups: (readonly TraceEvent[])[] = [];
  const observed: TraceEvent[] = [];
  let configured = false;
  let cleanupError: AggregateError | undefined;
  try {
    await telemetry.configure({
      traceProcessors: [
        exporter,
        {
          onEvent: (event) => {
            observed.push(event);
          },
          onEvents: (events) => {
            groups.push(events);
            observed.push(...events);
          },
        },
      ],
    });
    configured = true;
    await telemetry.withTrace(
      {
        name: 'batched-workflow',
        metadata: { tenant: 'native-tenant' },
        groupId: 'native-group',
      },
      async () => {
        for (let index = 0; index < 20; index++)
          await telemetry.withSpan(
            { name: `batched-${index}` },
            async () => {},
          );
      },
    );
    const started = performance.now();
    const result = await telemetry.forceFlush();
    const elapsed = (performance.now() - started) / 1000;
    const records = received.flat();
    const spans = records.filter((record) => record.object === 'trace.span');
    console.log(
      JSON.stringify({
        native_completed_spans: spans.length,
        http_requests: received.length,
        flush_seconds: Number(elapsed.toFixed(3)),
        flush_status: result.status,
      }),
    );
    assert.equal(result.status, 'success');
    assert.equal(spans.length, 21);
    assert.ok(received.length <= 4);
    assert.ok(elapsed < 4);
    assert.deepEqual(
      spans.map((row) => row.span_data.name),
      [
        ...Array.from({ length: 20 }, (_, index) => `batched-${index}`),
        'batched-workflow',
      ],
    );
    const root = records.find((row) => row.object === 'trace')!;
    assert.equal(root.metadata.tenant, 'native-tenant');
    assert.equal(root.group_id, 'native-group');
    assert.ok(groups.some((events) => events.length > 1));
    assert.ok(
      observed.every(
        (event, index) =>
          !index || event.sequence > observed[index - 1].sequence,
      ),
    );
    console.log('PASS native batch export and acknowledgement');
  } finally {
    const errors: unknown[] = [];
    try {
      if (configured) await telemetry.shutdown({ timeoutMs: 1000 });
    } catch (error) {
      errors.push(error);
    }
    server.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      cleanupError = new AggregateError(
        errors,
        'Batch collector cleanup failed',
      );
  }
  if (cleanupError) throw cleanupError;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
