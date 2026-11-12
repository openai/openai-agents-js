import assert from 'node:assert/strict';
import { telemetry } from '../../../src';
import { traceCredentialRoute } from '../../../src/runtime/trace-delivery';
import type { TraceEvent } from '../../../src/runtime/telemetry';

async function main() {
  const mode = process.argv[2];
  const original: TraceEvent[] = [];
  await telemetry.configure({
    traceProcessors: [
      {
        onEvent(event) {
          original.push(event);
        },
      },
    ],
  });
  try {
    const source = await telemetry.startTrace({ name: 'recorded-observation' });
    source.end();
    assert.equal((await telemetry.forceFlush()).status, 'success');
    const snapshots = original.filter(
      (event) => event.name === 'recorded-observation',
    );
    assert.equal(snapshots.length, 2);
    const received: TraceEvent[] = [];
    const rejections: unknown[] = [];
    await telemetry.setTraceProcessors([
      {
        async onEvent(event) {
          received.push(event);
          if (mode === 'reentrant') {
            await assert.rejects(
              telemetry.dispatchTraceEvent(event),
              /trace processor async context/,
            );
            rejections.push('reentrant');
          }
          if (mode === 'credentials') {
            assert.throws(() => traceCredentialRoute(event), /credential/i);
            rejections.push('credential');
          }
        },
      },
    ]);
    for (const event of snapshots) {
      await telemetry.dispatchTraceEvent(
        mode === 'credentials'
          ? { ...event, credential_required: true }
          : event,
      );
    }
    assert.equal(received.length, 2);
    for (const [index, event] of received.entries()) {
      const expected = snapshots[index]!;
      for (const field of [
        'lifecycle',
        'trace_id',
        'span_id',
        'parent_span_id',
        'name',
        'kind',
        'start_time_unix_nanos',
        'end_time_unix_nanos',
        'attributes',
        'outcome',
        'dropped_attributes_count',
      ] as const)
        assert.deepEqual(event[field], expected[field], field);
      assert.ok(event.sequence > expected.sequence);
      assert.notDeepEqual(event.processor_ids, expected.processor_ids);
      assert.ok(Object.isFrozen(event));
    }
    if (mode !== 'lifecycle') assert.equal(rejections.length, 2);
    assert.equal(telemetry.getCurrentTrace(), undefined);
    telemetry.setTracingDisabled(true);
    await telemetry.dispatchTraceEvent(snapshots[0]!);
    assert.equal(received.length, 2);
    telemetry.setTracingDisabled(false);
    assert.equal((await telemetry.forceFlush()).status, 'success');
    console.log(
      JSON.stringify({
        mode,
        observations: received.length,
        checks: rejections.length,
      }),
    );
  } finally {
    telemetry.setTracingDisabled(true);
    await telemetry.shutdown();
  }
  await assert.rejects(
    telemetry.dispatchTraceEvent(original[0]!),
    /shutting down/,
  );
  telemetry.setTracingDisabled(false);
  await assert.rejects(
    telemetry.dispatchTraceEvent(original[0]!),
    /shutting down/,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
