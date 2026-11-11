/** Native scope ownership shared by public telemetry and Session admission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { binding, copyJsonValue } from './binding';
import type { SpanContext, TraceOptions } from './telemetry';
type Native = Awaited<ReturnType<typeof binding>>;

/** Storage for JavaScript trace and span scopes. */
export interface TraceContextStorage {
  getStore(): TraceSpan | undefined;
  run<T>(span: TraceSpan | undefined, callback: () => T): T;
}

type HostTraceScope =
  | { storage: TraceContextStorage }
  | { storage?: undefined; span: TraceSpan | undefined };

const hostTraceScope = new AsyncLocalStorage<HostTraceScope>();
let configuredStorage: TraceContextStorage | undefined;

function captureTraceStorage() {
  const scope = hostTraceScope.getStore();
  const storage = scope ? scope.storage : configuredStorage;
  return <T>(callback: () => T): T =>
    hostTraceScope.run({ storage, span: undefined }, callback);
}

const ambient: TraceContextStorage = {
  getStore() {
    const scope = hostTraceScope.getStore();
    if (!scope) return configuredStorage?.getStore();
    return scope.storage ? scope.storage.getStore() : scope.span;
  },
  run(span, callback) {
    const scope = hostTraceScope.getStore();
    const storage = scope ? scope.storage : configuredStorage;
    if (storage) {
      return hostTraceScope.run({ storage }, () => storage.run(span, callback));
    }
    return hostTraceScope.run({ span }, callback);
  },
};

/** Set storage for new trace scopes. Pass undefined to restore the built-in storage. */
export function setTraceContextStorage(storage?: TraceContextStorage): void {
  if (
    storage !== undefined &&
    (typeof storage?.getStore !== 'function' ||
      typeof storage?.run !== 'function')
  ) {
    throw new TypeError(
      'Trace context storage must implement getStore and run',
    );
  }
  configuredStorage = storage;
}

const processorSuppressed = new AsyncLocalStorage<boolean>();
let tracingDisabled = false;
let sensitiveDataLoggingEnabled = true;

/** Set capture policy for new scopes and operations; admitted work retains its policy. */
export function setTracingDisabled(disabled: boolean): void {
  if (typeof disabled !== 'boolean')
    throw new TypeError('disabled must be boolean');
  tracingDisabled = disabled;
}

/** Permit explicit content capture when enabled; never relax ancestor restrictions. */
export function setSensitiveDataLoggingEnabled(enabled: boolean): void {
  if (typeof enabled !== 'boolean')
    throw new TypeError('enabled must be boolean');
  sensitiveDataLoggingEnabled = enabled;
}

function admissionPolicy(): {
  disabled?: boolean;
  includeSensitiveData?: boolean;
} {
  return {
    ...(tracingDisabled || processorSuppressed.getStore()
      ? { disabled: true }
      : {}),
    ...(!sensitiveDataLoggingEnabled ? { includeSensitiveData: false } : {}),
  };
}

const workflows = new Map<string, WeakRef<TraceSpan>>();
const contextFinalizer = new FinalizationRegistry<{
  native: Native;
  token: string;
  workflow?: { key: string; reference: WeakRef<TraceSpan> };
}>(({ native, token, workflow }) => {
  native.release_trace_context(token);
  if (workflow && workflows.get(workflow.key) === workflow.reference)
    workflows.delete(workflow.key);
});

/** @internal Native carriers own ancestry; this only resolves a still-live JS workflow alias. */
export function workflowForTrace(
  traceId: string,
  workflowSpanId: string,
): TraceSpan | undefined {
  return workflows.get(`${traceId}:${workflowSpanId}`)?.deref();
}

/** @internal Suppress tracing in processor work, including its asynchronous descendants. */
export function suppressTracing<T>(callback: () => T): T {
  return processorSuppressed.run(true, callback);
}

/** @internal Processor callbacks and their asynchronous descendants share this context. */
export function inTraceProcessor(): boolean {
  return processorSuppressed.getStore() === true;
}

/** Native-owned span. Close ends recording; its parent context lasts while this object is reachable. */
export class TraceSpan {
  readonly context: SpanContext;
  private ended = false;
  private released = false;
  readonly #contextToken: string;
  constructor(
    private readonly native: Native,
    /** @internal Opaque process-local handle; never persist. */
    readonly handle: string,
    readonly kind: string,
    context: SpanContext,
    /** @internal */ readonly workflow?: TraceSpan,
  ) {
    this.context = Object.freeze(context);
    let token: string | undefined;
    try {
      token = native.retain_trace_context(handle);
      const workflow =
        kind === 'workflow'
          ? {
              key: `${context.traceId}:${context.spanId}`,
              reference: new WeakRef(this),
            }
          : undefined;
      if (workflow) workflows.set(workflow.key, workflow.reference);
      contextFinalizer.register(this, { native, token, workflow });
      this.#contextToken = token;
    } catch (error) {
      if (token !== undefined) native.release_trace_context(token);
      native.release_trace_span(handle);
      throw error;
    }
  }
  /** @internal */ retain(): string {
    return this.native.retain_trace_context(this.#contextToken);
  }
  /** A detached snapshot of the inherited native root metadata, including after end. */
  get traceMetadata(): Readonly<
    Record<string, import('./binding').JsonValue>
  > | null {
    const { root_metadata: metadata } = JSON.parse(
      this.native.trace_span_context(this.#contextToken),
    ) as { root_metadata?: string | null };
    if (metadata === undefined)
      throw new Error('Native trace metadata unavailable');
    if (metadata === null) return null;
    if (typeof metadata !== 'string')
      throw new Error('Invalid native trace metadata');
    return JSON.parse(metadata);
  }
  /** @internal Release only a caller-owned lease, not this object's alias. */
  releaseContext(token: string): void {
    this.native.release_trace_context(token);
  }
  end(
    outcome: {
      status?: 'ok' | 'error' | 'cancelled';
      category?: string;
      /** Optional payload; native privacy restrictions and size limits apply. */
      data?: Readonly<Record<string, import('./binding').JsonValue>>;
    } = {},
  ): void {
    if (this.ended) return;
    this.native.end_trace_span(
      this.handle,
      JSON.stringify({
        status: outcome.status ?? 'ok',
        category: outcome.category ?? null,
        data: outcome.data ?? {},
      }),
    );
    this.ended = true;
  }
  /** @internal Final output parsing remains synchronous. */
  validate<T>(callback: () => T): T {
    const wire = JSON.parse(
      this.native.start_trace_span(
        JSON.stringify({
          name: 'host.output_validation',
          kind: 'validation',
          parent: this.#contextToken,
        }),
      ),
    );
    const span = spanFromWire(this.native, wire, 'validation', this);
    try {
      return ambient.run(span, callback);
    } catch (error) {
      span.end({ status: 'error', category: 'validation_error' });
      throw error;
    } finally {
      span.close();
    }
  }
  close(): void {
    if (this.released) return;
    this.end();
    this.native.release_trace_span(this.handle);
    this.released = true;
  }
}
/** @internal Native readers use explicit submission owners, never opening-task ambient state. */
export function withoutTracing<T>(callback: () => T): T {
  return ambient.run(undefined, callback);
}
export function getCurrentSpan(): TraceSpan | undefined {
  return ambient.getStore();
}
export function getCurrentTrace(): TraceSpan | undefined {
  const span = ambient.getStore();
  return span?.kind === 'workflow' ? span : span?.workflow;
}

/** @internal Deferred validation belongs to the scope that issued the request. */
export function captureTraceValidation():
  Pick<TraceSpan, 'validate'> | undefined {
  const span = ambient.getStore();
  if (!span) return undefined;
  const runWithStorage = captureTraceStorage();
  return {
    validate: (callback) => runWithStorage(() => span.validate(callback)),
  };
}

/** @internal Capture parent ownership before any asynchronous boundary. */
export function captureTracing(
  options?: TraceOptions,
  opening?: TraceCapture,
): TraceCapture | undefined {
  if (
    options === undefined &&
    ambient.getStore() === undefined &&
    opening === undefined &&
    Object.keys(admissionPolicy()).length === 0
  )
    return undefined;
  return new TraceCapture(start(options ?? {}, 'operation', opening));
}
/** @internal One captured native operation; settlement releases every host lease. */
export class TraceCapture {
  private span?: TraceSpan;
  private contextToken?: string;
  private finished = false;
  /** @internal Restore the admitted backend without replacing native callback ancestry. */
  readonly runWithStorage = captureTraceStorage();
  constructor(readonly ready: Promise<TraceSpan>) {
    void ready.then(
      (span) => {
        this.span = span;
      },
      () => {},
    );
  }
  /** @internal Workflow metadata only; native callback carriers own ancestry. */
  get workflow(): TraceSpan | undefined {
    return this.span?.kind === 'workflow' ? this.span : this.span?.workflow;
  }
  /** @internal Retain synchronously when ready; otherwise reserve before closing. */
  retain(): Promise<{ token: string; span: TraceSpan }> {
    if (this.span)
      return Promise.resolve({ token: this.span.retain(), span: this.span });
    return this.ready.then((span) => ({ token: span.retain(), span }));
  }
  async context(): Promise<string> {
    const span = await this.ready;
    return (this.contextToken ??= span.retain());
  }
  async run<T>(
    name: string,
    kind: 'callback' | 'validation',
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const parent = await this.ready;
    return this.runWithStorage(() =>
      ambient.run(parent, () => scoped({ name }, kind, callback)),
    );
  }
  validate<T>(callback: () => T): T {
    return this.span ? this.span.validate(callback) : callback();
  }
  finish(
    error?: unknown,
    cancelled = false,
    category = 'operation_error',
  ): void {
    if (this.finished) return;
    this.finished = true;
    void this.ready
      .then((span) => {
        span.end({
          status: cancelled
            ? 'cancelled'
            : error === undefined
              ? 'ok'
              : 'error',
          category: cancelled
            ? 'cancelled'
            : error === undefined
              ? undefined
              : category,
        });
        if (this.contextToken) span.releaseContext(this.contextToken);
        span.close();
      })
      .catch(() => {});
  }
}

interface WireSpanContext {
  handle: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  workflow_span_id: string | null;
  disabled: boolean;
  include_sensitive_data: boolean;
}
function spanFromWire(
  native: Native,
  context: WireSpanContext,
  kind: string,
  parent?: TraceSpan,
): TraceSpan {
  const workflow = parent?.kind === 'workflow' ? parent : parent?.workflow;
  return new TraceSpan(
    native,
    context.handle,
    kind,
    {
      traceId: context.trace_id,
      spanId: context.span_id,
      parentSpanId: context.parent_span_id,
      disabled: context.disabled,
      includeSensitiveData: context.include_sensitive_data,
    },
    workflow?.context.traceId === context.trace_id &&
      workflow.context.spanId === context.workflow_span_id
      ? workflow
      : undefined,
  );
}
async function start(
  options: TraceOptions,
  kind: string,
  opening?: TraceCapture,
): Promise<TraceSpan> {
  const current = ambient.getStore();
  const parent =
    options.parent === undefined ? current : (options.parent ?? undefined);
  const metadata = copyJsonValue(options.metadata ?? {});
  const parentToken = parent?.retain();
  const restrictionToken = current?.retain();
  const snapshot = { ...options, metadata, ...admissionPolicy() };
  const openingLease = opening?.retain();
  let inherited: Awaited<ReturnType<TraceCapture['retain']>> | undefined;
  try {
    inherited = await openingLease;
    const native = await binding();
    const context = JSON.parse(
      native.start_trace_span(
        JSON.stringify({
          name:
            snapshot.name ??
            (kind === 'workflow'
              ? 'workflow'
              : kind === 'operation'
                ? 'agent.operation'
                : 'custom'),
          kind,
          parent:
            parentToken ??
            (snapshot.parent === undefined &&
            current === undefined &&
            !snapshot.detached
              ? inherited?.token
              : undefined) ??
            null,
          restrictions_parents: inherited ? [inherited.token] : [],
          restrictions_parent: restrictionToken ?? null,
          detached: snapshot.detached ?? false,
          trace_id: snapshot.traceId ?? null,
          group_id: snapshot.groupId ?? null,
          metadata,
          disabled: snapshot.disabled ?? false,
          ...(snapshot.includeSensitiveData === undefined
            ? kind === 'workflow'
              ? { include_sensitive_data: false }
              : {}
            : { include_sensitive_data: snapshot.includeSensitiveData }),
          credential_ref: snapshot.exportCredential?.register(native) ?? null,
        }),
      ),
    );
    return spanFromWire(native, context, kind, parent ?? inherited?.span);
  } finally {
    if (parentToken) parent!.releaseContext(parentToken);
    if (restrictionToken) current!.releaseContext(restrictionToken);
    if (inherited) inherited.span.releaseContext(inherited.token);
  }
}
export function startTrace(options: TraceOptions = {}): Promise<TraceSpan> {
  return start(options, 'workflow');
}
export function startSpan(options: TraceOptions = {}): Promise<TraceSpan> {
  return start(options, 'custom');
}
async function scoped<T>(
  options: TraceOptions,
  kind: string,
  callback: (span: TraceSpan) => T | Promise<T>,
): Promise<T> {
  const span = await start(options, kind);
  try {
    return await ambient.run(span, () => callback(span));
  } catch (error) {
    span.end({ status: 'error', category: `${kind}_error` });
    throw error;
  } finally {
    span.close();
  }
}
export function withTrace<T>(
  options: TraceOptions,
  callback: (span: TraceSpan) => T | Promise<T>,
): Promise<T> {
  return scoped(options, 'workflow', callback);
}
export function withSpan<T>(
  options: TraceOptions,
  callback: (span: TraceSpan) => T | Promise<T>,
): Promise<T> {
  return scoped(options, 'custom', callback);
}

/** @internal Native callback owners lend this context through joined cleanup. */
export async function withNativeCallbackContext<T>(
  context: string | undefined,
  callback: () => T | Promise<T>,
  signal?: AbortSignal,
  workflowForTrace?: (
    traceId: string,
    workflowSpanId: string,
  ) => TraceSpan | undefined,
): Promise<T> {
  if (context === undefined) return callback();
  const native = await binding();
  const wire = JSON.parse(
    native.start_trace_span(
      JSON.stringify({
        name: 'host.callback',
        kind: 'callback',
        parent: context,
      }),
    ),
  );
  const parent = workflowForTrace
    ? wire.workflow_span_id
      ? workflowForTrace(wire.trace_id, wire.workflow_span_id)
      : undefined
    : ambient.getStore();
  const span = spanFromWire(native, wire, 'callback', parent);
  try {
    const result = await ambient.run(span, () => callback());
    if (signal?.aborted)
      span.end({ status: 'cancelled', category: 'cancelled' });
    return result;
  } catch (error) {
    span.end({
      status: signal?.aborted ? 'cancelled' : 'error',
      category: signal?.aborted ? 'cancelled' : 'callback_error',
    });
    throw error;
  } finally {
    span.close();
  }
}
