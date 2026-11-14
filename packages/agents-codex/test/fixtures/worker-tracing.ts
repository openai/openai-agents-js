import {
  createWorkerTelemetry,
  type WorkerTelemetryOptions,
} from '../../src/runtime/workerd';
import type { TraceEvent } from '../../src/runtime/telemetry';

const check = (value: unknown, label: string) => {
  if (!value) throw new Error(label);
};
const pause = () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
};

/** Run unchanged on actual installed Wasm and lowered/Hermes controller instances. */
export async function workerTracingFixture(
  control: () => WorkerTelemetryOptions['control'],
) {
  const full: TraceEvent[] = [],
    bounded: TraceEvent[] = [];
  const tracer = createWorkerTelemetry({
    control: control(),
    processors: [
      {
        onEvent(event) {
          full.push(event);
        },
      },
    ],
    exporters: [
      {
        onEvent(event) {
          bounded.push(event);
        },
      },
    ],
  });
  const data = {
    large: 'x'.repeat(160 * 1024),
    small: { unicode: '海豚 🐬', values: [null, false, 0, ['nested']] },
  };
  let rootId = '';
  const result = await tracer.withTrace(
    { name: 'native-large', metadata: data },
    async (root) => {
      rootId = root.spanContext.spanId;
      data.large = 'mutated after admission';
      return root.withSpan(
        { name: 'native-child', metadata: { child: true } },
        () => 'body-result',
      );
    },
  );
  check(result === 'body-result', 'Application result');
  check(
    (await tracer.forceFlush()).status === 'success',
    'Full/export queues drained',
  );
  check(full.length === 4 && bounded.length === 4, 'Native lifecycle counts');
  for (const event of full.filter((event) => event.name === 'native-large')) {
    check(
      event.attributes['sdk.metadata.large'] === 'x'.repeat(160 * 1024),
      'Full metadata remains detached',
    );
    check(
      event.attributes['sdk.metadata.small'] ===
        JSON.stringify({
          unicode: '海豚 🐬',
          values: [null, false, 0, ['nested']],
        }),
      'Nested native JSON',
    );
  }
  for (const event of bounded) {
    check(
      new TextEncoder().encode(JSON.stringify(event)).length <= 128 * 1024,
      'Native exporter byte bound',
    );
    if (event.name === 'native-large') {
      check(
        !Object.hasOwn(event.attributes, 'sdk.metadata.large'),
        'Oversized exporter attribute omitted',
      );
      check(event.dropped_attributes_count === 1, 'Exporter omission counted');
      check(
        Object.hasOwn(event.attributes, 'sdk.metadata.small'),
        'Small exporter attribute retained',
      );
    }
  }
  check(
    full
      .filter((event) => event.name === 'native-child')
      .every((event) => event.parent_span_id === rootId),
    'Native child parentage',
  );
  const count = full.length;
  const disabled = tracer.startTrace({
    name: 'disabled',
    disabled: true,
    metadata: { secret: 'hidden' },
  });
  const disabledChild = disabled.startSpan({
    name: 'disabled-child',
    disabled: false,
  });
  check(
    disabledChild.spanContext.disabled,
    'Disabled policy remains inherited',
  );
  disabledChild.end();
  disabled.end();
  await tracer.forceFlush();
  check(
    full.length === count && bounded.length === count,
    'Disabled traces produce no processor/exporter events',
  );
  const cyclic: any = {};
  cyclic.self = cyclic;
  for (const metadata of [cyclic, { ['x'.repeat(257)]: 'invalid' }]) {
    let rejected = false;
    try {
      tracer.startTrace({ metadata });
    } catch {
      rejected = true;
    }
    check(rejected, 'Invalid metadata refused');
  }
  await tracer.forceFlush();
  check(full.length === count, 'Invalid metadata produced no events');
  await tracer.shutdown();

  const concurrent: TraceEvent[] = [];
  const parallel = createWorkerTelemetry({
    control: control(),
    processors: [
      {
        onEvent(event) {
          concurrent.push(event);
        },
      },
    ],
  });
  const first = pause();
  const a = parallel.withTrace({ name: 'A' }, async (root) => {
    await first.wait;
    return root.withSpan({ name: 'A-child' }, () => root.spanContext.spanId);
  });
  const b = await parallel.withTrace({ name: 'B' }, (root) =>
    root.withSpan({ name: 'B-child' }, () => root.spanContext.spanId),
  );
  first.release();
  const aId = await a;
  await parallel.forceFlush();
  check(
    concurrent
      .filter((event) => event.name === 'A' || event.name === 'B')
      .every((event) => event.parent_span_id === null),
    'No ambient root inheritance',
  );
  check(
    concurrent
      .filter((event) => event.name === 'A-child')
      .every((event) => event.parent_span_id === aId),
    'Concurrent A ownership',
  );
  check(
    concurrent
      .filter((event) => event.name === 'B-child')
      .every((event) => event.parent_span_id === b),
    'Concurrent B ownership',
  );
  await parallel.shutdown();

  const cancelled: TraceEvent[] = [];
  const cancellable = createWorkerTelemetry({
    control: control(),
    processors: [
      {
        onEvent(event) {
          cancelled.push(event);
        },
      },
    ],
  });
  const root = cancellable.startTrace({ name: 'cancel-root' });
  const child = root.startSpan({ name: 'cancel-child' });
  root.cancel();
  root.cancel();
  child.end();
  check(
    root.closed && child.closed && root.signal.aborted && child.signal.aborted,
    'Native cancellation closes retained scopes',
  );
  let lateRejected = false;
  try {
    child.startSpan({ name: 'late' });
  } catch {
    lateRejected = true;
  }
  check(lateRejected, 'Closed parent refuses late descendants');
  await cancellable.forceFlush();
  const ends = cancelled.filter((event) => event.lifecycle === 'end');
  check(
    ends.length === 2 &&
      ends[0].name === 'cancel-child' &&
      ends[1].name === 'cancel-root',
    'Child-first native close exactly once',
  );
  check(
    ends.every((event) => event.outcome === 'error'),
    'Native cancellation outcome',
  );
  const stop = new AbortController(),
    body = pause();
  let issued:
    import('../../src/runtime/worker-telemetry').WorkerTraceSpan | undefined;
  const pendingBody = cancellable.withTrace(
    { name: 'external-cancel' },
    async (scope) => {
      issued = scope;
      await body.wait;
      return 'late-success';
    },
    { signal: stop.signal },
  );
  stop.abort();
  body.release();
  let bodyRejected = false;
  try {
    await pendingBody;
  } catch {
    bodyRejected = true;
  }
  check(
    bodyRejected && issued?.closed && issued.signal.aborted,
    'External cancellation rejects late successful body',
  );
  await cancellable.shutdown();

  const firstDelivery = pause(),
    secondDelivery = pause();
  const barriers = createWorkerTelemetry({
    control: control(),
    processors: [
      {
        async onEvent(event) {
          if (event.sequence === 1) await firstDelivery.wait;
          if (event.sequence === 2) await secondDelivery.wait;
        },
      },
    ],
  });
  barriers.startTrace({ name: 'before-barrier' });
  const flushing = barriers.forceFlush({ timeoutMs: 2000 });
  barriers.startTrace({ name: 'after-barrier' });
  firstDelivery.release();
  const flushed = await flushing;
  check(
    flushed.status === 'success' && flushed.barrier === 1,
    'Flush never acknowledges a newer unawaited sequence',
  );
  secondDelivery.release();
  await barriers.shutdown();

  const held = pause();
  const queues = createWorkerTelemetry({
    control: control(),
    processors: [
      {
        async onEvent() {
          await held.wait;
        },
      },
    ],
  });
  for (let index = 0; index < 40; index++) {
    const scope = queues.startTrace({
      name: 'queue-' + index,
      metadata: { large: 'q'.repeat(160 * 1024) },
    });
    scope.end();
  }
  const stalled = await queues.forceFlush({ timeoutMs: 0 });
  check(
    stalled.status === 'timeout' && stalled.droppedRecords > 0,
    'Awaited deliveries retain bounded byte charges',
  );
  held.release();
  const recovered = await queues.shutdown();
  check(
    recovered.status === 'partial' && recovered.droppedRecords > 0,
    'Queue drop accounting survives drain',
  );

  const failures = createWorkerTelemetry({
    control: control(),
    processors: [
      {
        onEvent() {
          throw new Error('private processor failure');
        },
      },
    ],
  });
  check(
    (await failures.withTrace({}, () => 'unaffected')) === 'unaffected',
    'Processor failure preserves application outcome',
  );
  const failed = await failures.shutdown();
  check(
    failed.status === 'failure' && failed.failedDeliveries === 2,
    'Processor failures remain observable',
  );
  return {
    fullEvents: full.length,
    boundedEvents: bounded.length,
    concurrentEvents: concurrent.length,
    cancellationEnds: ends.length,
    barrier: flushed.barrier,
    droppedRecords: recovered.droppedRecords,
    failedDeliveries: failed.failedDeliveries,
  };
}
