import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { binding } from '../../../src/runtime/binding';
import type { TraceEvent, TraceSpan } from '../../../src/runtime/telemetry';

async function main() {
  const telemetry = process.env.N06_LOSS_BASELINE_MODULE
    ? await import(process.env.N06_LOSS_BASELINE_MODULE)
    : await import('../../../src/runtime/telemetry');
  const longNames = process.argv.includes('--bytes');
  const forwarded = process.argv.includes('--forward');
  const retainedAfterRecovery = process.argv.includes(
    '--retained-after-recovery',
  );
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
  let sawMixedBatch = false;
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
        forwarded
          ? { onEvent: (event: TraceEvent) => exporter.onEvent(event) }
          : exporter,
        {
          onEvent() {},
          async onEvents(events: readonly TraceEvent[]) {
            observed.push(...events);
            sawMixedBatch ||=
              events.some((event) => event.name === 'old-after-loss') &&
              events.some((event) => event.name === 'post-loss-fresh-root');
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
    end(start('post-loss-fresh-root'));
    release();
    const result = await telemetry.forceFlush({ timeoutMs: 15000 });
    assert.ok(result.droppedRecords > 0);
    assert.equal(result.status, 'partial');
    assert.ok(sawMixedBatch);
    assert.ok(!records.some((row) => row.span_data?.name === 'old-after-loss'));
    const fresh = records.filter(
      (row) => row.workflow_name === 'post-loss-fresh-root',
    );
    assert.equal(fresh.length, 1);
    assert.ok(records.some((row) => row.trace_id === fresh[0].id));
    if (forwarded) {
      const recoveredRoots = Array.from({ length: 1024 }, (_, i) =>
        start(`recovered-active-${i}`),
      );
      const active = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.equal(
        active.failedDeliveries,
        result.failedDeliveries,
        'forwarding kept lost roots pinned',
      );
      recoveredRoots.forEach(end);
      const completed = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.equal(completed.failedDeliveries, result.failedDeliveries);
      assert.equal(completed.droppedRecords, result.droppedRecords);
    }
    if (retainedAfterRecovery) {
      const failures = result.failedDeliveries;
      let parent!: TraceSpan;
      await telemetry.withTrace(
        {
          name: 'post-recovery-retained',
          detached: true,
          groupId: 'recovered-group',
          metadata: { tenant: 'recovered-tenant' },
        },
        (root: TraceSpan) => {
          parent = root;
        },
      );
      await telemetry.forceFlush({ timeoutMs: 15000 });
      for (let i = 0; i < 1024; i++) {
        await telemetry.withTrace(
          { name: `recovered-churn-${i}`, detached: true },
          () => {},
        );
        if (i % 32 === 31) await telemetry.forceFlush({ timeoutMs: 15000 });
      }
      await telemetry.withSpan(
        { name: 'post-recovery-late-child', parent },
        (child: TraceSpan) => {
          child.end({
            status: 'ok',
            data: { private: 'recovered-private-sentinel' },
          });
        },
      );
      const lateResult = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.equal(
        lateResult.failedDeliveries,
        failures,
        'post-recovery retained child was rejected after eviction',
      );
      const descriptors = records.filter(
        (row) =>
          row.object === 'trace' &&
          row.id === `trace_${parent.context.traceId}`,
      );
      assert.equal(descriptors.length, 2);
      assert.equal(descriptors[1].workflow_name, 'post-recovery-retained');
      assert.equal(descriptors[1].group_id, 'recovered-group');
      assert.equal(descriptors[1].metadata.tenant, 'recovered-tenant');
      const late = records.filter(
        (row) => row.span_data?.name === 'post-recovery-late-child',
      );
      assert.equal(late.length, 1);
      assert.equal(
        late[0].parent_id,
        `span_${parent.context.spanId.padStart(24, '0')}`,
      );
      assert.equal(
        JSON.stringify(records).includes('recovered-private-sentinel'),
        false,
      );
    }
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
