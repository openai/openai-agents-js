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
  const overlappingLoss = process.argv.includes('--overlapping-loss');
  const retainedAfterRecovery = process.argv.includes(
    '--retained-after-recovery',
  );
  const native = await binding();
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
  const drain = native.drain_trace_events;
  const prefixQueued = Promise.withResolvers<void>();
  const shortDrain = Promise.withResolvers<string>();
  const burstQueued = Promise.withResolvers<void>();
  let primed = false;
  let prefixCaptured = false;
  let firstLossDrops = 0;
  let retainedFreshRoot: string | undefined;
  try {
    if (overlappingLoss) {
      native.drain_trace_events = async (limit) => {
        const readPrefix = primed && !prefixCaptured;
        // Park the next read after the initial roots drain, so it cannot
        // race the four prefix records as they enter the native queue.
        if (readPrefix) await prefixQueued.promise;
        const raw = await drain(limit);
        if (readPrefix) {
          prefixCaptured = true;
          shortDrain.resolve(raw);
          await burstQueued.promise;
        } else if (firstLossDrops === 0) {
          const batch = JSON.parse(raw);
          primed ||= batch.events.some(
            (event: TraceEvent) => event.name === 'active-1023',
          );
          firstLossDrops = batch.dropped_records;
        }
        return raw;
      };
    }
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
              // The normal fixture waits through a lossy acknowledgment.
              // The overlap case stops earlier with only four freed slots.
              ++groups === (overlappingLoss ? 2 : 3)
            ) {
              entered();
              await released;
            }
          },
        },
      ],
    });
    configured = true;
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
    const prefix = overlappingLoss ? 2 : 0;
    if (overlappingLoss) {
      end(start('burst-0'));
      end(start('burst-1'));
      prefixQueued.resolve();
      const snapshot = JSON.parse(await shortDrain.promise);
      assert.equal(snapshot.events.length, 4);
      assert.equal(snapshot.dropped_records, 0);
    }
    for (let index = prefix; index < 1600; index++)
      end(start(`burst-${longNames ? 'x'.repeat(4000) : index}`));
    for (const root of roots.slice(1)) end(root);
    burstQueued.resolve();
    await blocked;
    // Read the cutoff before queuing the markers while the pump is paused.
    const firstCutoff = overlappingLoss
      ? native.set_trace_routes('{"processor_ids":[],"replace":false}')
      : 0;
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
    const freshRoot = start('post-loss-fresh-root');
    if (overlappingLoss) {
      retainedFreshRoot = freshRoot;
      native.end_trace_span(freshRoot, '{"status":"ok"}');
    } else {
      end(freshRoot);
    }
    release();
    const result = await telemetry.forceFlush({ timeoutMs: 15000 });
    assert.ok(result.droppedRecords > 0);
    assert.equal(result.status, 'partial');
    if (overlappingLoss) {
      assert.ok(firstLossDrops > 0);
      assert.equal(result.droppedRecords, firstLossDrops + 1);
      assert.equal(result.barrier, firstCutoff + 5);
    }
    assert.ok(sawMixedBatch);
    assert.ok(!records.some((row) => row.span_data?.name === 'old-after-loss'));
    const fresh = records.filter(
      (row) => row.workflow_name === 'post-loss-fresh-root',
    );
    assert.equal(fresh.length, 1);
    let expectedFailures = result.failedDeliveries;
    if (overlappingLoss) {
      const markers = observed.filter(
        (event) =>
          event.name === 'old-after-loss' ||
          event.name === 'post-loss-fresh-root',
      );
      assert.deepEqual(
        markers.map((event) => [
          event.name,
          event.lifecycle,
          event.recovery_sequence,
        ]),
        [
          ['old-after-loss', 'start', firstCutoff],
          ['old-after-loss', 'end', firstCutoff],
          ['post-loss-fresh-root', 'start', firstCutoff],
        ],
      );
      const lateChild = JSON.parse(
        native.start_trace_span(
          JSON.stringify({
            name: 'child-after-second-loss',
            kind: 'custom',
            parent: freshRoot,
          }),
        ),
      ).handle;
      end(lateChild);
      // Flush the rejected events on their own so their failure count does
      // not depend on whether the native drain batches them with a live root.
      const rejected = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.equal(rejected.status, 'partial');
      assert.equal(rejected.droppedRecords, result.droppedRecords);
      expectedFailures += 2;
      assert.equal(rejected.failedDeliveries, expectedFailures);
      const lateEvents = observed.filter(
        (event) => event.name === 'child-after-second-loss',
      );
      assert.deepEqual(
        lateEvents.map((event) => [
          event.lifecycle,
          event.parent_span_id,
          event.recovery_sequence,
        ]),
        [
          ['start', markers[2].span_id, result.barrier],
          ['end', markers[2].span_id, result.barrier],
        ],
      );
      assert.ok(
        !records.some(
          (row) => row.span_data?.name === 'child-after-second-loss',
        ),
      );
      end(start('post-second-loss-root'));
      const recovered = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.equal(recovered.status, 'partial');
      assert.equal(recovered.droppedRecords, result.droppedRecords);
      assert.equal(recovered.failedDeliveries, expectedFailures);
      const later = observed.filter(
        (event) => event.name === 'post-second-loss-root',
      );
      assert.deepEqual(
        later.map((event) => [event.lifecycle, event.recovery_sequence]),
        [
          ['start', result.barrier],
          ['end', result.barrier],
        ],
      );
      assert.ok(
        records.some((row) => row.span_data?.name === 'post-second-loss-root'),
      );
      assert.ok(
        observed.every(
          (event, index) =>
            index === 0 ||
            (event.sequence > observed[index - 1].sequence &&
              (event.recovery_sequence ?? 0) >=
                (observed[index - 1].recovery_sequence ?? 0)),
        ),
      );
    } else {
      assert.ok(records.some((row) => row.trace_id === fresh[0].id));
    }
    if (forwarded) {
      const recoveredRoots = Array.from({ length: 1024 }, (_, i) =>
        start(`recovered-active-${i}`),
      );
      const active = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.equal(
        active.failedDeliveries,
        expectedFailures,
        'forwarding kept lost roots pinned',
      );
      recoveredRoots.forEach(end);
      const completed = await telemetry.forceFlush({ timeoutMs: 15000 });
      assert.equal(completed.failedDeliveries, expectedFailures);
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
    prefixQueued.resolve();
    burstQueued.resolve();
    if (overlappingLoss) native.drain_trace_events = drain;
    try {
      if (retainedFreshRoot) native.release_trace_span(retainedFreshRoot);
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
