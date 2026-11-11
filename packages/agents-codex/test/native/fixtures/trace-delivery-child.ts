import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { telemetry } from '../../../src';
import { binding } from '../../../src/runtime/binding';

async function main() {
  const mode = process.argv[2];
  if (mode === 'invalid') {
    const native = await binding();
    for (const options of [
      { max_queue_size: 0 },
      { unknown: 1 },
      { export_trigger_ratio: 2 },
    ]) {
      await assert.rejects(
        native.configure_telemetry(
          JSON.stringify({ 'sdk.trace_delivery': options }),
        ),
        /Native telemetry operation failed\. Check the exporter settings/,
      );
    }
    await telemetry.configure();
    await telemetry.shutdown();
    console.log(`PASS ${mode}`);
    return;
  }

  const batches: number[][] = [];
  let releaseOverflow: () => void = () => {};
  const overflowGate = new Promise<void>((resolve) => {
    releaseOverflow = resolve;
  });
  const count = () => batches.reduce((total, batch) => total + batch.length, 0);
  const waitForCount = async (expected: number) => {
    const deadline = performance.now() + 3000;
    while (count() < expected && performance.now() < deadline) await delay(5);
    assert.equal(count(), expected);
  };
  await telemetry.configure({
    traceProcessors: [
      {
        async onEvents(events) {
          batches.push(events.map((event) => event.sequence));
          if (mode === 'overflow-count') await overflowGate;
        },
      },
    ],
    traceDelivery: {
      maxQueueSize: mode === 'overflow-count' ? 2 : 16,
      maxQueueBytes: mode === 'overflow-bytes' ? 1 : 4 * 1024 * 1024,
      maxBatchSize: 3,
      scheduleDelayMs: mode === 'timer' ? 40 : 60_000,
      exportTriggerRatio: 1,
    },
  });
  const emit = async (name: string) => {
    const span = await telemetry.startTrace({ name });
    span.end();
  };
  try {
    await emit('first');
    if (mode.startsWith('overflow')) {
      await emit('second');
      releaseOverflow();
      const result = await telemetry.forceFlush({ timeoutMs: 3000 });
      assert.equal(result.status, 'partial');
      assert.ok(result.droppedRecords >= (mode === 'overflow-bytes' ? 4 : 2));
      assert.equal(count(), mode === 'overflow-bytes' ? 0 : 2);
    } else if (mode === 'timer') {
      await waitForCount(2);
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 3000 })).status,
        'success',
      );
    } else {
      await delay(60);
      assert.equal(count(), 0);
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 3000 })).status,
        'success',
      );
      assert.equal(count(), 2);
      await emit('after-completed-flush');
      await delay(60);
      assert.equal(count(), 2);
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 3000 })).status,
        'success',
      );
      assert.equal(count(), 4);
      for (let index = 0; index < 8; index++) await emit(`trigger-${index}`);
      await waitForCount(20);
      assert.equal(
        (await telemetry.forceFlush({ timeoutMs: 3000 })).status,
        'success',
      );
      const flattened = batches.flat();
      assert.deepEqual(
        flattened,
        [...new Set(flattened)].sort((left, right) => left - right),
      );
    }
    assert.ok(batches.every((batch) => batch.length <= 3));
  } finally {
    releaseOverflow();
    await telemetry.shutdown({ timeoutMs: 3000 });
  }
  console.log(`PASS ${mode}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
