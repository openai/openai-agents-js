import {
  HermesTextControl,
  type LoweredTurnExports,
} from './turn-control-binding';
import { decodeControlOutput } from './decode-utf8';
import type { JsonValue } from './binding';
import type {
  TraceEvent,
  TraceProcessorRegistration,
  SpanContext,
  FlushResult,
} from './telemetry';

const frameLimit = 8 * 1024 * 1024;
const queueLimit = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const scopeToken = Symbol('native Worker trace scope');

export interface WorkerTraceOptions {
  name?: string;
  kind?: string;
  traceId?: string;
  spanId?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
  disabled?: boolean;
  includeSensitiveData?: boolean;
}

export interface WorkerTelemetryOptions {
  control: WebAssembly.Module | HermesTextControl;
  processors?: readonly TraceProcessorRegistration[];
  exporters?: readonly TraceProcessorRegistration[];
}

interface NativeReply {
  version: number;
  span?: {
    handle: string;
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
    disabled: boolean;
    include_sensitive_data: boolean;
  } | null;
  events: TraceEvent[];
  sequence?: number;
  dropped_records?: number;
}

interface Route {
  id: string;
  bounded: boolean;
  processor: TraceProcessorRegistration;
  tail: Promise<void>;
}

interface RetainedScope {
  handle: string;
  context: SpanContext;
  parent?: RetainedScope;
  controller: AbortController;
  cleanup: (() => void)[];
  closed: boolean;
}

function copyJson(
  value: unknown,
  parents = new Set<object>(),
  depth = 0,
): JsonValue {
  if (depth > 64) throw new TypeError('Tracing metadata exceeds maximum depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || parents.has(value))
    throw new TypeError('Expected finite, acyclic tracing JSON');
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError('Expected plain tracing JSON');
  parents.add(value);
  try {
    if (array)
      return Array.from(value as unknown[], (item) =>
        copyJson(item, parents, depth + 1),
      );
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (encoder.encode(key).length > 256)
        throw new TypeError('Tracing key exceeds 256 UTF-8 bytes');
      result[key] = copyJson(item, parents, depth + 1);
    }
    return result;
  } finally {
    parents.delete(value);
  }
}

function identifier(bytes: number): string {
  if (!globalThis.crypto?.getRandomValues)
    throw new Error(
      'Worker tracing requires cryptographic random values or explicit IDs',
    );
  const result = new Uint8Array(bytes);
  do {
    globalThis.crypto.getRandomValues(result);
  } while (result.every((byte) => byte === 0));
  return Array.from(result, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function now(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

/** Explicit scopes never inherit an ambient parent across promises or requests. */
export class WorkerTraceSpan {
  readonly #owner: WorkerTelemetry;
  readonly #scope: RetainedScope;

  /** @internal Only the issuing native telemetry controller creates a scope. */
  constructor(token: symbol, owner: WorkerTelemetry, scope: RetainedScope) {
    if (token !== scopeToken)
      throw new TypeError('Invalid native Worker trace scope');
    this.#owner = owner;
    this.#scope = scope;
  }

  get spanContext(): SpanContext {
    return { ...this.#scope.context };
  }
  get signal(): AbortSignal {
    return this.#scope.controller.signal;
  }
  get closed(): boolean {
    return this.#scope.closed;
  }

  startSpan(
    options: Omit<WorkerTraceOptions, 'traceId'> = {},
  ): WorkerTraceSpan {
    return this.#owner.start(options, this.#scope, scopeToken);
  }

  withSpan<T>(
    options: Omit<WorkerTraceOptions, 'traceId'>,
    callback: (scope: WorkerTraceSpan, signal: AbortSignal) => T | Promise<T>,
    execution: { signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.#owner.run(
      this.startSpan(options),
      callback,
      execution.signal,
      scopeToken,
    );
  }

  end(error = false): void {
    this.#owner.finish(this.#scope, false, error, scopeToken);
  }
  cancel(): void {
    this.#owner.finish(this.#scope, true, true, scopeToken);
  }

  /** @internal */
  bindSignal(signal: AbortSignal | undefined, token: symbol): () => void {
    if (token !== scopeToken)
      throw new TypeError('Invalid native Worker trace scope');
    if (!signal) return () => {};
    const cancel = () => this.cancel();
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    const cleanup = () => signal.removeEventListener('abort', cancel);
    this.#scope.cleanup.push(cleanup);
    return cleanup;
  }
}

/** A separate native controller owns every instance. Processors never receive live scopes. */
export class WorkerTelemetry {
  readonly #exports: LoweredTurnExports;
  readonly #routes: Route[] = [];
  readonly #scopes = new Set<RetainedScope>();
  readonly #pending = new Set<Promise<void>>();
  #closed = false;
  #queuedBytes = 0;
  #queuedRecords = 0;
  #dropped = 0;
  #nativeDropped = 0;
  #failed = 0;
  #sequence = 0;

  constructor(options: WorkerTelemetryOptions) {
    if (options.control instanceof HermesTextControl)
      this.#exports = options.control.instantiate();
    else {
      if (WebAssembly.Module.imports(options.control).length)
        throw new TypeError('Native tracing cannot import host capabilities');
      this.#exports = new WebAssembly.Instance(options.control)
        .exports as unknown as LoweredTurnExports;
    }
    const exports = this.#exports;
    if (
      !exports.memory?.buffer ||
      typeof exports.input_buffer !== 'function' ||
      typeof exports.apply !== 'function' ||
      typeof exports.output_pointer !== 'function' ||
      typeof exports.output_length !== 'function'
    )
      throw new TypeError('Invalid native trace controller');
    this.#apply({ op: 'capabilities' });
    for (const processor of options.processors ?? [])
      this.addTraceProcessor(processor);
    for (const exporter of options.exporters ?? [])
      this.addTraceExporter(exporter);
  }

  addTraceProcessor(processor: TraceProcessorRegistration): void {
    this.#register(processor, false);
  }
  /** Exporters receive the native 128 KiB projection; custom processors retain admitted metadata. */
  addTraceExporter(exporter: TraceProcessorRegistration): void {
    this.#register(exporter, true);
  }

  #register(processor: TraceProcessorRegistration, bounded: boolean): void {
    if (this.#closed) throw new Error('Native Worker tracing has shut down');
    if (this.#routes.length >= 64)
      throw new RangeError('Too many trace processors');
    if (
      !processor ||
      (typeof processor.onEvent !== 'function' &&
        typeof processor.onEvents !== 'function')
    )
      throw new TypeError('Expected a trace processor');
    this.#routes.push({
      id: `worker_processor_${this.#routes.length + 1}`,
      bounded,
      processor,
      tail: Promise.resolve(),
    });
  }

  #apply(request: unknown): NativeReply {
    const bytes = encoder.encode(JSON.stringify({ type: 'trace', request }));
    if (bytes.length > frameLimit)
      throw new RangeError('Native trace command exceeds capacity');
    const exports = this.#exports;
    const pointer = exports.input_buffer(bytes.length);
    if (!pointer) throw new RangeError('Native trace command exceeds capacity');
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
    exports.apply();
    const length = exports.output_length();
    if (length > frameLimit)
      throw new RangeError('Native trace reply exceeds capacity');
    const reply = JSON.parse(
      decodeControlOutput(
        new Uint8Array(exports.memory.buffer, exports.output_pointer(), length),
      ),
    );
    if (reply.error) throw new Error(reply.error);
    if (
      reply.effect?.type !== 'trace' ||
      reply.effect.result?.version !== 1 ||
      !Array.isArray(reply.effect.result.events)
    )
      throw new Error('Native controller does not support Worker tracing');
    const result = reply.effect.result as NativeReply;
    this.#sequence = result.sequence ?? this.#sequence;
    this.#nativeDropped = result.dropped_records ?? this.#nativeDropped;
    for (const event of result.events) this.#enqueue(event);
    return result;
  }

  #enqueue(event: TraceEvent): void {
    const serialized = JSON.stringify(event);
    const bytes = encoder.encode(serialized).length;
    for (const id of event.processor_ids) {
      const route = this.#routes.find((candidate) => candidate.id === id);
      if (!route) {
        this.#dropped++;
        continue;
      }
      if (
        this.#queuedRecords >= 1024 ||
        this.#queuedBytes + bytes > queueLimit
      ) {
        this.#dropped++;
        continue;
      }
      this.#queuedRecords++;
      this.#queuedBytes += bytes;
      const delivery = route.tail.then(async () => {
        try {
          const detached = JSON.parse(serialized) as TraceEvent;
          if (typeof route.processor.onEvent === 'function')
            await route.processor.onEvent(detached);
          else await route.processor.onEvents!([detached]);
        } catch {
          this.#failed++;
        } finally {
          this.#queuedRecords--;
          this.#queuedBytes -= bytes;
        }
      });
      route.tail = delivery;
      this.#pending.add(delivery);
      void delivery.then(() => this.#pending.delete(delivery));
    }
  }

  startTrace(options: WorkerTraceOptions = {}): WorkerTraceSpan {
    return this.start(options, undefined, scopeToken);
  }

  /** @internal */
  start(
    options: WorkerTraceOptions,
    parent: RetainedScope | undefined,
    token: symbol,
  ): WorkerTraceSpan {
    if (
      token !== scopeToken ||
      this.#closed ||
      parent?.closed ||
      (parent && !this.#scopes.has(parent))
    )
      throw new Error('Native Worker trace scope has closed');
    const metadata = copyJson(options.metadata ?? {});
    if (
      metadata === null ||
      Array.isArray(metadata) ||
      typeof metadata !== 'object'
    )
      throw new TypeError('Tracing metadata must be an object');
    const result = this.#apply({
      op: 'start',
      name: options.name ?? 'trace',
      kind: options.kind ?? 'custom',
      trace_id:
        parent?.context.traceId ??
        options.traceId?.toLowerCase() ??
        identifier(16),
      span_id: options.spanId?.toLowerCase() ?? identifier(8),
      parent: parent?.handle ?? null,
      metadata,
      disabled: options.disabled ?? false,
      include_sensitive_data: options.includeSensitiveData ?? false,
      time: now(),
      custom_routes: this.#routes
        .filter((route) => !route.bounded)
        .map((route) => route.id),
      bounded_routes: this.#routes
        .filter((route) => route.bounded)
        .map((route) => route.id),
    });
    const native = result.span;
    if (!native) throw new Error('Native trace scope was not created');
    const scope: RetainedScope = {
      handle: native.handle,
      context: {
        traceId: native.trace_id,
        spanId: native.span_id,
        parentSpanId: native.parent_span_id,
        disabled: native.disabled,
        includeSensitiveData: native.include_sensitive_data,
      },
      parent,
      controller: new AbortController(),
      cleanup: [],
      closed: false,
    };
    this.#scopes.add(scope);
    const span = new WorkerTraceSpan(scopeToken, this, scope);
    if (parent) span.bindSignal(parent.controller.signal, scopeToken);
    return span;
  }

  withTrace<T>(
    options: WorkerTraceOptions,
    callback: (scope: WorkerTraceSpan, signal: AbortSignal) => T | Promise<T>,
    execution: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (execution.signal?.aborted)
      return Promise.reject(
        execution.signal.reason ?? new Error('Trace cancelled'),
      );
    return this.run(
      this.startTrace(options),
      callback,
      execution.signal,
      scopeToken,
    );
  }

  /** @internal */
  async run<T>(
    scope: WorkerTraceSpan,
    callback: (scope: WorkerTraceSpan, signal: AbortSignal) => T | Promise<T>,
    signal: AbortSignal | undefined,
    token: symbol,
  ): Promise<T> {
    if (token !== scopeToken)
      throw new TypeError('Invalid native Worker trace scope');
    const cleanup = scope.bindSignal(signal, scopeToken);
    try {
      if (scope.signal.aborted)
        throw scope.signal.reason ?? new Error('Trace cancelled');
      const result = await callback(scope, scope.signal);
      if (scope.signal.aborted)
        throw scope.signal.reason ?? new Error('Trace cancelled');
      scope.end();
      return result;
    } catch (error) {
      scope.end(true);
      throw error;
    } finally {
      cleanup();
    }
  }

  /** @internal */
  finish(
    scope: RetainedScope,
    cancelled: boolean,
    error: boolean,
    token: symbol,
  ): void {
    if (token !== scopeToken || !this.#scopes.has(scope)) {
      if (token === scopeToken && scope.closed) return;
      throw new TypeError('Invalid native Worker trace scope');
    }
    this.#apply({
      op: cancelled ? 'cancel' : 'end',
      handle: scope.handle,
      time: now(),
      ...(!cancelled ? { error } : {}),
    });
    for (const candidate of this.#scopes) {
      let ancestor: RetainedScope | undefined = candidate;
      while (ancestor && ancestor !== scope) ancestor = ancestor.parent;
      if (!ancestor) continue;
      candidate.closed = true;
      this.#scopes.delete(candidate);
      for (const cleanup of candidate.cleanup) cleanup();
      candidate.cleanup.length = 0;
      if (cancelled || candidate !== scope)
        candidate.controller.abort(new Error('Native trace scope closed'));
    }
  }

  async forceFlush(options: { timeoutMs?: number } = {}): Promise<FlushResult> {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new RangeError('Invalid tracing flush timeout');
    const barrier = this.#sequence;
    const pending = Array.from(this.#pending);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.all(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const droppedRecords = this.#dropped + this.#nativeDropped;
    return {
      status: !drained
        ? 'timeout'
        : this.#failed
          ? 'failure'
          : droppedRecords
            ? 'partial'
            : 'success',
      droppedRecords,
      failedDeliveries: this.#failed,
      barrier,
    };
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<FlushResult> {
    if (!this.#closed) {
      this.#apply({ op: 'shutdown', time: now() });
      this.#closed = true;
      for (const scope of this.#scopes) {
        scope.closed = true;
        for (const cleanup of scope.cleanup) cleanup();
        scope.controller.abort(
          new Error('Native Worker tracing has shut down'),
        );
      }
      this.#scopes.clear();
    }
    return this.forceFlush(options);
  }
}

export function createWorkerTelemetry(
  options: WorkerTelemetryOptions,
): WorkerTelemetry {
  return new WorkerTelemetry(options);
}
