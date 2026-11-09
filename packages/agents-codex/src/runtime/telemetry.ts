export {
  OpenAITraceExporter,
  ConsoleTraceProcessor,
} from './openai-trace-exporter';
import {
  inTraceProcessor,
  suppressTracing,
  withoutTracing,
} from './tracing-context';
/** Optional native telemetry. Configure before scopes or Sessions; close Sessions before shutdown. */
import { isAbsolute, resolve } from 'node:path';
import { binding } from './binding';
import type { TraceSpan } from './tracing-context';
export {
  TraceSpan,
  startTrace,
  startSpan,
  withTrace,
  withSpan,
  getCurrentTrace,
  getCurrentSpan,
  setTracingDisabled,
  setSensitiveDataLoggingEnabled,
} from './tracing-context';
type Native = Awaited<ReturnType<typeof binding>>;

/** Native HTTP or gRPC TLS paths. Supply client certificate and key together. */
export interface OtelTlsConfig {
  readonly caCertificate?: string;
  readonly clientCertificate?: string;
  readonly clientPrivateKey?: string;
}

/** An explicit native OTLP destination. Omitted signals stay disabled. */
export type Exporter =
  | {
      readonly kind: 'otlp-http';
      readonly endpoint: string;
      readonly protocol?: 'binary' | 'json';
      readonly headers?: Readonly<Record<string, string>>;
      readonly tls?: OtelTlsConfig;
    }
  | {
      readonly kind: 'otlp-grpc';
      readonly endpoint: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly tls?: OtelTlsConfig;
    };

let configuredHere = false;

export interface TelemetryOptions {
  /** Nonempty initial routes opt in to native tracing without a built-in exporter. */
  readonly traceProcessors?: readonly TraceProcessor[];
  readonly traces?: Exporter | null;
  readonly logs?: Exporter | null;
  readonly metrics?: Exporter | null;
  /** Exporter resource environment label. Defaults to 'dev'. */
  readonly environment?: string;
  readonly spanAttributes?: Readonly<Record<string, string>>;
  readonly logUserPrompt?: boolean;
  readonly logAgentResponses?: boolean;
  /** UTF-8 output prefix bound; full tool arguments can still appear. Defaults to zero. */
  readonly toolResultMaxBytes?: number;
}

function invalid(field: string): never {
  throw new TypeError(`Invalid telemetry ${field}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  const entries = Object.entries(object(value, field));
  if (entries.some(([, item]) => typeof item !== 'string')) invalid(field);
  return Object.fromEntries(entries) as Record<string, string>;
}

function exporter(value: unknown, signal: string): unknown {
  if (value === undefined || value === null) return 'none';
  const input = object(value, signal);
  if (input.kind !== 'otlp-http' && input.kind !== 'otlp-grpc')
    invalid(`${signal} kind`);
  if (typeof input.endpoint !== 'string' || input.endpoint.length === 0)
    invalid(`${signal} endpoint`);
  const wire: Record<string, unknown> = {
    endpoint: input.endpoint,
    headers: stringMap(input.headers, `${signal} headers`),
  };
  if (input.kind === 'otlp-http') {
    if (
      input.protocol !== undefined &&
      input.protocol !== 'binary' &&
      input.protocol !== 'json'
    )
      invalid(`${signal} protocol`);
    wire.protocol = input.protocol ?? 'binary';
  }
  if (input.tls !== undefined) {
    const tls = object(input.tls, `${signal} tls`);
    const paths: Record<string, string> = {};
    for (const [name, key] of [
      ['caCertificate', 'ca-certificate'],
      ['clientCertificate', 'client-certificate'],
      ['clientPrivateKey', 'client-private-key'],
    ] as const) {
      const path = tls[name];
      if (path === undefined) continue;
      if (typeof path !== 'string') invalid(`${signal} tls ${name}`);
      // Do not ask for cwd when the application already supplied an absolute path.
      paths[key] = isAbsolute(path) ? path : resolve(path);
    }
    wire.tls = paths;
  }
  return { [input.kind]: wire };
}

/**
 * Configure native exporters once per process before the first session attempt.
 * Text switches affect named native records, not all sensitive content. A failure
 * after native claims the subscriber requires a new process.
 */
export async function configure(options: TelemetryOptions = {}): Promise<void> {
  const input = object(options, 'options');
  const initial =
    input.traceProcessors === undefined ? [] : input.traceProcessors;
  // Validate before claiming the configure-once native provider.
  if (
    !Array.isArray(initial) ||
    initial.length > 64 ||
    initial.some(
      (processor) =>
        processor === null ||
        typeof processor !== 'object' ||
        typeof processor.onEvent !== 'function',
    )
  )
    invalid('traceProcessors');
  const initialProcessors: readonly TraceProcessor[] = [...initial];
  for (const field of ['logUserPrompt', 'logAgentResponses'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean')
      invalid(field);
  }
  if (input.environment !== undefined && typeof input.environment !== 'string')
    invalid('environment');
  const max = input.toolResultMaxBytes ?? 0;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0)
    invalid('toolResultMaxBytes');
  // Capture a fresh wire value before the first await. Never use the general
  // schema error formatter with endpoint, header, or private-key values.
  const encoded = JSON.stringify({
    'otel.exporter': exporter(input.logs, 'logs'),
    'otel.trace_exporter': exporter(input.traces, 'traces'),
    'otel.trace_processors': initialProcessors.length > 0,
    'otel.metrics_exporter': exporter(input.metrics, 'metrics'),
    'analytics.enabled': input.metrics !== undefined && input.metrics !== null,
    'otel.environment': input.environment ?? 'dev',
    'otel.span_attributes': stringMap(input.spanAttributes, 'spanAttributes'),
    'otel.log_user_prompt': input.logUserPrompt ?? false,
    'otel.log_agent_responses': input.logAgentResponses ?? false,
    'otel.tool_result': { max_bytes: max },
  });
  await (await binding()).configure_telemetry(encoded);
  // Only one SDK instance/isolate can pass native's process-wide configure gate.
  configuredHere = true;
  if (initialProcessors.length) await route(initialProcessors, false);
}

function validateTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 60_000
  )
    throw new TypeError(
      'Telemetry timeoutMs must be an integer from 1 through 60000',
    );
  return value;
}

/** Request a native exporter flush outside processor async contexts after all sessions close, then retire this process owner. */
export async function shutdown(
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (inTraceProcessor())
    throw new Error(
      'Telemetry shutdown cannot run in a trace processor async context',
    );
  const timeout = validateTimeout(options.timeoutMs);
  try {
    await (await binding()).shutdown_telemetry(timeout);
  } finally {
    processors.clear();
    activeProcessorIds.clear();
    retiredProcessorIds.clear();
    wakePump?.();
  }
}

/** Options for native workflow, custom-span and operation scopes. */
export interface TraceOptions {
  readonly name?: string;
  /** Explicit linkage overrides the ambient span; null selects a new root. */
  readonly parent?: TraceSpan | null;
  /** Clear linkage while retaining ambient and Session content restrictions. */
  readonly detached?: boolean;
  readonly traceId?: string;
  readonly groupId?: string;
  readonly metadata?: Readonly<Record<string, import('./binding').JsonValue>>;
  /** Disabled ancestry suppresses every descendant trace record. */
  readonly disabled?: boolean;
  /** Workflow defaults to metadata only. A false ancestor cannot be relaxed. */
  readonly includeSensitiveData?: boolean;
  readonly exportCredential?: TraceExportCredentials;
}
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly disabled: boolean;
  readonly includeSensitiveData: boolean;
}
export interface FlushResult {
  readonly status: 'success' | 'partial' | 'timeout' | 'failure';
  readonly droppedRecords: number;
  readonly failedDeliveries: number;
  readonly barrier: number;
}
export interface TraceEvent {
  readonly sequence: number;
  readonly processor_ids: readonly string[];
  readonly lifecycle: 'start' | 'end';
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly name: string;
  readonly kind: string;
  /** Exact Unix nanoseconds, encoded as decimal text. */
  readonly start_time_unix_nanos: string;
  readonly end_time_unix_nanos: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly outcome: 'ok' | 'error' | 'unset';
  readonly dropped_attributes_count: number;
  readonly [key: string]: unknown;
}
/**
 * Receives immutable native snapshots serially on the host event loop. Exceptions
 * count as failed deliveries. Flush can time out awaiting a callback; the SDK
 * cannot preempt synchronous application code. Up to 64 active and retiring
 * processor registrations may coexist. Register them through the SDK instance
 * that successfully configured telemetry; other workers may still emit spans.
 */
export interface TraceProcessor {
  onEvent(event: TraceEvent): void | Promise<void>;
  /** Optional native-drain batch callback; acknowledgement waits for completion. */
  onEvents?(events: readonly TraceEvent[]): void | Promise<void>;
}

/** Private credential storage; headers never enter span records or saved state. */
export class TraceExportCredentials {
  #reference?: string;
  #native?: Native;
  #closed = false;
  readonly #headers: string;
  constructor(options: { headers: Readonly<Record<string, string>> }) {
    this.#headers = JSON.stringify(
      stringMap(options.headers, 'credential headers'),
    );
  }
  /** @internal */ register(native: Native): string {
    if (this.#closed) throw new Error('Trace credentials are closed');
    this.#native = native;
    return (this.#reference ??= native.register_trace_credentials(
      this.#headers,
    ));
  }
  /** Release caller ownership; admitted spans and exports retain their credentials. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reference)
      this.#native!.release_trace_credentials(this.#reference);
  }
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
const processors = new Map<string, TraceProcessor>();
const activeProcessorIds = new Set<string>();
const retiredProcessorIds = new Map<string, number>();
let acknowledgedSequence = 0;
function retireProcessors(): void {
  for (const [id, cutoff] of retiredProcessorIds) {
    if (cutoff <= acknowledgedSequence) {
      processors.delete(id);
      retiredProcessorIds.delete(id);
    }
  }
}
let nextProcessor = 0;
let pump: Promise<void> | undefined;
let wakePump: (() => void) | undefined;
async function route(
  values: readonly TraceProcessor[],
  replace: boolean,
): Promise<void> {
  if (!configuredHere)
    throw new Error(
      'Register trace processors through the SDK instance that configured telemetry',
    );
  const snapshot = [...values];
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
          const batch = JSON.parse(await native.drain_trace_events(128));
          let failures = 0;
          const routes = new Map<string, TraceEvent[]>();
          for (const event of batch.events as TraceEvent[]) {
            const snapshot = freezeSnapshot(event);
            for (const id of event.processor_ids) {
              const events = routes.get(id) ?? [];
              events.push(snapshot);
              routes.set(id, events);
            }
          }
          for (const [id, events] of routes) {
            const processor = processors.get(id);
            if (typeof processor?.onEvents === 'function') {
              try {
                await suppressTracing(() =>
                  processor.onEvents!(Object.freeze(events)),
                );
              } catch {
                failures += events.length;
              }
            } else {
              for (const event of events) {
                try {
                  await suppressTracing(() => processor?.onEvent(event));
                } catch {
                  failures++;
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
          if (!batch.events.length)
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
/** Add a native lifecycle route while preserving the configured default exporter. */
export async function addTraceProcessor(
  processor: TraceProcessor,
): Promise<void> {
  await route([processor], false);
}
/** Replace all future trace routes, including the native default exporter. */
export async function setTraceProcessors(
  values: readonly TraceProcessor[],
): Promise<void> {
  await route(values, true);
}
/** Flush completed records through one native barrier outside processor async contexts, without closing Sessions. */
export async function forceFlush(
  options: { timeoutMs?: number } = {},
): Promise<FlushResult> {
  if (inTraceProcessor())
    throw new Error(
      'Telemetry forceFlush cannot run in a trace processor async context',
    );
  const timeout = validateTimeout(options.timeoutMs) ?? 10_000;
  const retired = [...retiredProcessorIds.keys()];
  wakePump?.();
  const result = JSON.parse(
    await (await binding()).force_flush_telemetry(timeout),
  );
  if (result.status === 'success' || result.status === 'partial') {
    for (const id of retired) {
      processors.delete(id);
      retiredProcessorIds.delete(id);
    }
    wakePump?.();
  }
  return {
    status: result.status,
    droppedRecords: result.dropped_records,
    failedDeliveries: result.failed_deliveries,
    barrier: result.barrier,
  };
}
