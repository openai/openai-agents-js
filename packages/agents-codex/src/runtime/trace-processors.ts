/** Private host processor registry and serial native delivery. */
import { binding } from './binding';
import { invokeTraceDelivery } from './trace-delivery';
import { suppressTracing, withoutTracing } from './tracing-context';
import type {
  TraceEvent,
  TraceProcessor,
  TraceProcessorRegistration,
} from './telemetry';

let processorBatchSize = 128;

export function isTraceProcessor(
  value: unknown,
): value is TraceProcessorRegistration {
  return (
    value !== null &&
    typeof value === 'object' &&
    (typeof (value as TraceProcessor).onEvent === 'function' ||
      typeof (value as TraceProcessor).onEvents === 'function')
  );
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
const processors = new Map<string, TraceProcessorRegistration>();
const activeProcessorIds = new Set<string>();
const retiredProcessorIds = new Map<string, number>();
let acknowledgedSequence = 0;
let droppedRecords = 0;
// Each drain below the oldest cutoff consumes records from the bounded native
// queue that existed when that cutoff was captured.
const lossWatermarks: number[] = [];
let recoveryEpoch = 0;
const processorEpochs = new WeakMap<TraceProcessorRegistration, number>();
function* traceRecoveryGroups(
  events: TraceEvent[],
  throughSequence: number,
): Generator<TraceEvent[]> {
  let start = 0;
  while (lossWatermarks.length && lossWatermarks[0] <= throughSequence) {
    const cutoff = lossWatermarks[0];
    let end = start;
    while (end < events.length && events[end].sequence <= cutoff) end++;
    if (end > start) yield events.slice(start, end);
    lossWatermarks.shift();
    recoveryEpoch = cutoff;
    start = end;
  }
  if (start < events.length) yield start === 0 ? events : events.slice(start);
}

function retireProcessors(): void {
  for (const [id, cutoff] of retiredProcessorIds) {
    if (cutoff <= acknowledgedSequence) {
      processors.delete(id);
      retiredProcessorIds.delete(id);
    }
  }
}
let nextProcessor = 0;
let processorDeliveryStop = new AbortController();
let pump: Promise<void> | undefined;
let wakePump: (() => void) | undefined;
export async function route(
  values: readonly TraceProcessorRegistration[],
  replace: boolean,
): Promise<void> {
  const snapshot = [...values];
  if (!snapshot.every(isTraceProcessor))
    throw new TypeError('Invalid telemetry traceProcessors');
  const native = await binding();
  // Removed routes remain owned until their last queued snapshot is acknowledged.
  if (processors.size + snapshot.length > 64)
    throw new RangeError(
      'Native tracing supports at most 64 active and retiring processors; flush before adding more',
    );
  const ids = snapshot.map((processor) => {
    const id = `host-${++nextProcessor}`;
    processors.set(id, processor);
    return id;
  });
  let cutoff: number;
  try {
    cutoff = native.set_trace_routes(
      JSON.stringify({ processor_ids: ids, replace }),
    );
  } catch (error) {
    for (const id of ids) processors.delete(id);
    throw error;
  }
  if (replace) {
    for (const id of activeProcessorIds) retiredProcessorIds.set(id, cutoff);
    activeProcessorIds.clear();
  }
  for (const id of ids) activeProcessorIds.add(id);
  retireProcessors();
  if (!pump) {
    pump = withoutTracing(() =>
      (async () => {
        while (processors.size) {
          const batch = JSON.parse(
            await native.drain_trace_events(processorBatchSize),
          );
          const retireCredentials = () => {
            for (const route of Object.values(
              batch.credential_routes ?? {},
            ) as { headers: Record<string, string> }[]) {
              for (const key of Object.keys(route.headers))
                delete route.headers[key];
            }
            delete batch.credential_routes;
          };
          processorDeliveryStop.signal.addEventListener(
            'abort',
            retireCredentials,
            { once: true },
          );
          try {
            let failures = 0;
            if (batch.dropped_records > droppedRecords) {
              // No-op route merge captures the sequence, including a drop-only tail.
              const cutoff = native.set_trace_routes(
                '{"processor_ids":[],"replace":false}',
              );
              if (cutoff > (lossWatermarks.at(-1) ?? recoveryEpoch)) {
                lossWatermarks.push(cutoff);
              }
              droppedRecords = batch.dropped_records;
            }
            for (const group of traceRecoveryGroups(
              batch.events,
              batch.through_sequence,
            )) {
              const routes = new Map<string, TraceEvent[]>();
              const snapshots: TraceEvent[] = [];
              for (const event of group) {
                const descriptor =
                  batch.root_descriptors?.[String(event.sequence)];
                const snapshot = freezeSnapshot({
                  ...event,
                  recovery_sequence: recoveryEpoch,
                  ...(descriptor === undefined
                    ? {}
                    : { root_descriptor: descriptor }),
                });
                snapshots.push(snapshot);
                for (const id of event.processor_ids) {
                  const events = routes.get(id) ?? [];
                  events.push(snapshot);
                  routes.set(id, events);
                }
              }
              for (const event of snapshots) {
                for (const id of event.processor_ids) {
                  const events = routes.get(id);
                  if (!events) continue;
                  const processor = processors.get(id);
                  if (
                    processor &&
                    (processorEpochs.get(processor) ?? 0) < recoveryEpoch
                  ) {
                    const recover = (
                      processor as TraceProcessorRegistration & {
                        _onNativeTraceLoss?: () => void | Promise<void>;
                      }
                    )._onNativeTraceLoss;
                    try {
                      if (recover)
                        await suppressTracing(() => recover.call(processor));
                      processorEpochs.set(processor, recoveryEpoch);
                    } catch {
                      failures++;
                      continue;
                    }
                  }
                  if (typeof processor?.onEvents === 'function') {
                    // Deliver each batch at its first event's position. Ordinary
                    // processors retain event-by-event registration order.
                    routes.delete(id);
                    try {
                      await invokeTraceDelivery(
                        events,
                        batch.credential_routes,
                        id,
                        () =>
                          suppressTracing(() =>
                            processor.onEvents!(Object.freeze(events)),
                          ),
                        processorDeliveryStop.signal,
                      );
                    } catch {
                      failures += events.length;
                    }
                  } else {
                    try {
                      await invokeTraceDelivery(
                        [event],
                        batch.credential_routes,
                        id,
                        () =>
                          suppressTracing(() => processor?.onEvent?.(event)),
                        processorDeliveryStop.signal,
                      );
                    } catch {
                      failures++;
                    }
                  }
                }
              }
            }
            if (batch.through_sequence > acknowledgedSequence) {
              native.ack_trace_events(batch.through_sequence, failures);
              acknowledgedSequence = Math.max(
                acknowledgedSequence,
                batch.through_sequence,
              );
              retireProcessors();
            }
          } finally {
            retireCredentials();
            processorDeliveryStop.signal.removeEventListener(
              'abort',
              retireCredentials,
            );
          }
          if (!batch.events.length && processors.size)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 10);
              timer.unref();
              wakePump = () => {
                clearTimeout(timer);
                resolve();
              };
            });
        }
      })().finally(() => {
        pump = undefined;
      }),
    );
    // Native drain failures do not fail the agent execution path.
    void pump.catch(() => {});
  }
}

/** Join terminal delivery before telemetry attempts native restart. */
export function join(): Promise<void> | undefined {
  return pump?.catch(() => {});
}

/** Called only after native configure succeeds; IDs and acknowledgement survive. */
export function configured(batchSize: number, restart: boolean): void {
  if (restart) {
    processorDeliveryStop = new AbortController();
    droppedRecords = 0;
    lossWatermarks.length = 0;
    recoveryEpoch = 0;
  }
  processorBatchSize = batchSize;
}

export function stop(): void {
  processorDeliveryStop.abort();
  processors.clear();
  activeProcessorIds.clear();
  retiredProcessorIds.clear();
  wake();
}

export function stopped(): boolean {
  return processorDeliveryStop.signal.aborted;
}

export function wake(): void {
  wakePump?.();
}

export function retiring(): readonly string[] {
  return [...retiredProcessorIds.keys()];
}

/** Retire only the routes captured before a successful or partial flush. */
export function retire(ids: readonly string[]): void {
  for (const id of ids) {
    processors.delete(id);
    retiredProcessorIds.delete(id);
  }
  wake();
}
