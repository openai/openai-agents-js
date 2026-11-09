import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { binding } from '../../../src/runtime/binding';
import type { TraceEvent } from '../../../src/runtime/telemetry';

async function main() {
  const telemetry = process.env.N06_LOSS_BASELINE_MODULE
    ? await import(process.env.N06_LOSS_BASELINE_MODULE)
    : await import('../../../src/runtime/telemetry');
  const longNames = process.argv.includes('--bytes');
  const records: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    records.push(...JSON.parse(Buffer.concat(chunks).toString()).data);
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const observed: TraceEvent[] = [];
  let phase = false;
  let groups = 0;
  let configured = false;
  try {
    const exporter = new telemetry.OpenAITraceExporter({
      apiKey: 'synthetic',
      endpoint: `http://127.0.0.1:${address.port}/ingest`,
    });
    await telemetry.configure({
      traceProcessors: [
        exporter,
        {
          onEvent() {},
          async onEvents(events: readonly TraceEvent[]) {
            observed.push(...events);
            if (
              phase &&
              events.some((event) => event.name.startsWith('burst-')) &&
              ++groups === 2
            ) {
              entered();
              await released;
            }
          },
        },
      ],
    });
    configured = true;
    const native = await binding();
    const start = (name: string) =>
      JSON.parse(
        native.start_trace_span(
          JSON.stringify({
            name,
            kind: 'workflow',
            detached: true,
            metadata: {},
            include_sensitive_data: false,
          }),
        ),
      ).handle as string;
    const end = (handle: string) => {
      native.end_trace_span(handle, '{"status":"ok"}');
      native.release_trace_span(handle);
    };
    const roots = Array.from({ length: 1024 }, (_, index) =>
      start(`active-${index}`),
    );
    assert.equal(
      (await telemetry.forceFlush({ timeoutMs: 15000 })).status,
      'success',
    );
    phase = true;
    for (let index = 0; index < 1600; index++)
      end(start(`burst-${longNames ? 'x'.repeat(4000) : index}`));
    for (const root of roots.slice(1)) end(root);
    await blocked;
    // The pump captured a watermark and acknowledged its first lossy batch.
    // Queue a fresh root while older records still occupy the native queue.
    end(start('post-loss-fresh-root'));
    release();
    for (
      let index = 0;
      index < 300 &&
      !records.some((row) => row.workflow_name === 'post-loss-fresh-root');
      index++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const oldChild = JSON.parse(
      native.start_trace_span(
        JSON.stringify({
          name: 'old-after-loss',
          kind: 'custom',
          parent: roots[0],
        }),
      ),
    ).handle;
    end(oldChild);
    end(roots[0]);
    const result = await telemetry.forceFlush({ timeoutMs: 15000 });
    assert.ok(result.droppedRecords > 0);
    assert.equal(result.status, 'partial');
    assert.ok(!records.some((row) => row.span_data?.name === 'old-after-loss'));
    const fresh = records.filter(
      (row) => row.workflow_name === 'post-loss-fresh-root',
    );
    assert.equal(fresh.length, 1);
    assert.ok(records.some((row) => row.trace_id === fresh[0].id));
    const oldSequences = observed
      .filter((event) => event.name.startsWith('burst-'))
      .map((event) => event.sequence);
    const freshSequences = observed
      .filter((event) => event.name === 'post-loss-fresh-root')
      .map((event) => event.sequence);
    assert.ok(Math.min(...freshSequences) > Math.max(...oldSequences) + 1);
    assert.equal(
      new Set(observed.map((event) => JSON.stringify(event.processor_ids)))
        .size,
      1,
    );
    assert.equal(observed[0].processor_ids.length, 2);
    console.log(
      `PASS native loss recovery bytes=${longNames} dropped=${result.droppedRecords}`,
    );
  } finally {
    release();
    try {
      if (configured) await telemetry.shutdown({ timeoutMs: 15000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
