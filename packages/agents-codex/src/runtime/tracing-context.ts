/** Native scope ownership shared by public telemetry and Session admission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isAsyncFunction } from 'node:util/types';
import { binding, copyJsonValue } from './binding';
import type { SpanContext, TraceOptions } from './telemetry';
type Native = Awaited<ReturnType<typeof binding>>;

/** Storage for JavaScript trace and span scopes. */
export interface TraceContextStorage {
  getStore(): TraceSpan | undefined;
  run<T>(span: TraceSpan | undefined, callback: () => T): T;
}

interface CallbackTraceStorage {
  readonly storage: TraceContextStorage | undefined;
  entered: number;
  nativeReleased: boolean;
}

/** Storage for the native producer's admitted child callbacks. */
export type CallbackTraceStorages = Map<string, CallbackTraceStorage>;

function forgetReleasedStorage(
  storages: CallbackTraceStorages,
  key: string,
  entry: CallbackTraceStorage,
): void {
  if (
    entry.nativeReleased &&
    entry.entered === 0 &&
    storages.get(key) === entry
  )
    storages.delete(key);
}

function notifyCallbackRelease(
  registry: WeakRef<CallbackTraceStorages>,
  key: string,
): () => void {
  return () => {
    const storages = registry.deref();
    const entry = storages?.get(key);
    if (storages && entry) {
      entry.nativeReleased = true;
      forgetReleasedStorage(storages, key, entry);
    }
  };
}

type HostTraceScope =
  | { storage: TraceContextStorage }
  | { storage?: undefined; span: TraceSpan | undefined };

const hostTraceScope = new AsyncLocalStorage<HostTraceScope>();
let configuredStorage: TraceContextStorage | undefined;

function currentTraceStorage(): TraceContextStorage | undefined {
  const scope = hostTraceScope.getStore();
  return scope ? scope.storage : configuredStorage;
}

const ambient: TraceContextStorage = {
  getStore() {
    const scope = hostTraceScope.getStore();
    if (!scope) return configuredStorage?.getStore();
    return scope.storage ? scope.storage.getStore() : scope.span;
  },
  run(span, callback) {
    const storage = currentTraceStorage();
    if (storage) {
      return hostTraceScope.run({ storage }, () => storage.run(span, callback));
    }
    return hostTraceScope.run({ span }, callback);
  },
};

function runWithStorage<T>(
  storage: TraceContextStorage | undefined,
  callback: () => T,
): T {
  return hostTraceScope.run({ storage, span: undefined }, callback);
}

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

/** Generate an ID for grouping workflow traces. */
export function generateGroupId(): string {
  return `group_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** Synchronous ID policy for newly admitted SDK scopes, excluding engine spans. */
export interface TracingIdGenerator {
  /** Return a nonzero 32-digit hexadecimal ID. */
  readonly generateTraceId?: () => string;
  /** Return a nonzero 16-digit hexadecimal ID. */
  readonly generateSpanId?: () => string;
}

let tracingIdGenerator: TracingIdGenerator = Object.freeze({});

/** Replace future SDK scope policy; omission restores native generation. */
export function setTracingIdGenerator(
  generator: TracingIdGenerator = {},
): void {
  if (!generator || typeof generator !== 'object' || Array.isArray(generator))
    throw new TypeError('Tracing ID generator must be an object');
  const { generateTraceId, generateSpanId } = generator;
  for (const callback of [generateTraceId, generateSpanId])
    if (
      callback !== undefined &&
      (typeof callback !== 'function' || isAsyncFunction(callback))
    )
      throw new TypeError(
        'Tracing ID generators must be synchronous functions',
      );
  tracingIdGenerator = Object.freeze({
    generateTraceId: generateTraceId?.bind(generator),
    generateSpanId: generateSpanId?.bind(generator),
  });
}

/** @internal Plain runs have no host admission pump; use the Session path. */
export function hasCustomTracingIds(): boolean {
  return (
    tracingIdGenerator.generateTraceId !== undefined ||
    tracingIdGenerator.generateSpanId !== undefined
  );
}

/** @internal Allocate only a child ID, without creating an extra callback span. */
export async function providerResponseSpanAdmission(
  context: string,
  signal: AbortSignal,
): Promise<{ span_id: string | null } | null> {
  const generator = tracingIdGenerator;
  signal.throwIfAborted();
  const policy = admissionPolicy();
  const current = ambient.getStore();
  if (policy.disabled || current?.context.disabled) return null;
  if (generator.generateSpanId === undefined) return { span_id: null };
  const native = await binding();
  signal.throwIfAborted();
  const restriction = current?.retain();
  let handle: string | undefined;
  try {
    handle = native.borrow_trace_context(
      context,
      restriction ?? null,
      policy.disabled ?? false,
      policy.includeSensitiveData ?? true,
    );
    const wire: WireSpanContext = JSON.parse(native.trace_span_context(handle));
    if (wire.disabled || processorSuppressed.getStore()) return null;
    const borrowed = spanFromWire(native, wire, 'context', current);
    return ambient.run(borrowed, () => {
      signal.throwIfAborted();
      const ids = generatedScopeIds(generator, {}, true, false);
      signal.throwIfAborted();
      return { span_id: ids.span_id ?? null };
    });
  } finally {
    if (handle) native.release_trace_context(handle);
    if (restriction) current!.releaseContext(restriction);
  }
}

function generatedId(callback: () => string, digits: number): string {
  const value = callback();
  if (typeof value !== 'string')
    throw new TypeError('Tracing ID generators must return strings');
  if (
    value.length !== digits ||
    !/^[0-9a-f]+$/i.test(value) ||
    /^0+$/.test(value)
  )
    throw new TypeError('Tracing ID generator returned an invalid identifier');
  return value;
}

function generatedScopeIds(
  generator: TracingIdGenerator,
  options: Pick<TraceOptions, 'traceId' | 'spanId'>,
  hasParent: boolean,
  disabled: boolean,
): { trace_id?: string; span_id?: string } {
  const ids = options.spanId === undefined ? {} : { span_id: options.spanId };
  if (disabled || processorSuppressed.getStore()) return ids;
  return processorSuppressed.run(true, () => ({
    ...ids,
    ...(options.traceId === undefined && !hasParent && generator.generateTraceId
      ? { trace_id: generatedId(generator.generateTraceId, 32) }
      : {}),
    ...(options.spanId === undefined && generator.generateSpanId
      ? { span_id: generatedId(generator.generateSpanId, 16) }
      : {}),
  }));
}

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

/** @internal Observation delivery under the current SDK disable switches. */
export function traceDispatchDisabled(): boolean {
  return tracingDisabled || ambient.getStore()?.context.disabled === true;
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
    this.ended = kind === 'context';
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
          ...generatedScopeIds(
            tracingIdGenerator,
            {},
            true,
            this.context.disabled,
          ),
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
  const storage = currentTraceStorage();
  return {
    validate: (callback) =>
      runWithStorage(storage, () => span.validate(callback)),
  };
}

/** @internal Capture parent ownership before any asynchronous boundary. */
export function captureTracing(
  options?: TraceOptions,
  opening?: TraceCapture,
  continuationTraceId?: string,
): TraceCapture | undefined {
  const hasCallerScope =
    options !== undefined || ambient.getStore() !== undefined;
  const hasCurrentScope =
    hasCallerScope || (opening !== undefined && !opening.policyOnly);
  if (
    !hasCurrentScope &&
    opening === undefined &&
    continuationTraceId === undefined &&
    Object.keys(admissionPolicy()).length === 0
  )
    return undefined;
  const storage = currentTraceStorage();
  const traceOptions =
    !hasCurrentScope && continuationTraceId !== undefined
      ? {
          traceId: continuationTraceId,
          includeSensitiveData: false,
          detached: opening !== undefined,
        }
      : (options ?? {});
  const policyOnly =
    !hasCallerScope &&
    opening === undefined &&
    continuationTraceId === undefined;
  return new TraceCapture(
    start(traceOptions, 'operation', opening),
    storage,
    policyOnly,
  );
}
/** @internal One captured native operation; settlement releases every host lease. */
export class TraceCapture {
  private span?: TraceSpan;
  private contextToken?: string;
  private finished = false;
  constructor(
    readonly ready: Promise<TraceSpan>,
    private readonly storage: TraceContextStorage | undefined,
    readonly policyOnly: boolean,
  ) {
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
  /** @internal Historical correlation for a settled checkpoint. */
  get correlationId(): string | undefined {
    const context = this.span?.context;
    return context?.disabled === false ? context.traceId : undefined;
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
  /** @internal Create the private dispatch lease immediately before native admission. */
  dispatchContext(
    span: TraceSpan,
    child?: { native: Native; storages: CallbackTraceStorages },
  ): string {
    if (!child) return (this.contextToken ??= span.retain());
    const key = randomUUID();
    const token = child.native._retain_callback_dispatch_context(
      span.handle,
      key,
      notifyCallbackRelease(new WeakRef(child.storages), key),
    );
    try {
      child.storages.set(key, {
        storage: this.storage,
        entered: 0,
        nativeReleased: false,
      });
      return (this.contextToken = token);
    } catch (error) {
      span.releaseContext(token);
      throw error;
    }
  }
  /** @internal Restore the admitted backend without replacing native callback ancestry. */
  runWithStorage<T>(callback: () => T): T {
    return runWithStorage(this.storage, callback);
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
        try {
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
        } finally {
          if (this.contextToken) span.releaseContext(this.contextToken);
          span.close();
        }
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
  callback_storage_key?: string;
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
  const generator = tracingIdGenerator;
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
          ...generatedScopeIds(
            generator,
            snapshot,
            !snapshot.detached &&
              (parent !== undefined ||
                (snapshot.parent === undefined && inherited !== undefined)),
            snapshot.disabled === true ||
              current?.context.disabled === true ||
              parent?.context.disabled === true ||
              inherited?.span.context.disabled === true,
          ),
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

/** Retained local ancestry without trace lifecycle events or portable owner lookup. */
export async function withTraceContext<T>(
  source: TraceSpan,
  callback: () => T | Promise<T>,
): Promise<T> {
  const current = ambient.getStore();
  const parent = source.retain();
  let restriction: string | undefined;
  const policy = admissionPolicy();
  try {
    restriction = current?.retain();
    const native = await binding();
    const handle = native.borrow_trace_context(
      parent,
      restriction ?? null,
      policy.disabled ?? false,
      policy.includeSensitiveData ?? true,
    );
    try {
      const context = JSON.parse(
        native.trace_span_context(handle),
      ) as WireSpanContext;
      const span = new TraceSpan(
        native,
        handle,
        'context',
        {
          traceId: context.trace_id,
          spanId: context.span_id,
          parentSpanId: context.parent_span_id,
          disabled: context.disabled,
          includeSensitiveData: context.include_sensitive_data,
        },
        source.kind === 'workflow' ? source : source.workflow,
      );
      return await ambient.run(span, callback);
    } finally {
      native.release_trace_context(handle);
    }
  } finally {
    if (restriction) current!.releaseContext(restriction);
    source.releaseContext(parent);
  }
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
  callback: (retainStorage?: () => () => void) => T | Promise<T>,
  signal?: AbortSignal,
  workflowForTrace?: (
    traceId: string,
    workflowSpanId: string,
  ) => TraceSpan | undefined,
  callbackStorages?: CallbackTraceStorages,
): Promise<T> {
  if (context === undefined) return callback();
  const generator = tracingIdGenerator;
  const native = await binding();
  const wire: WireSpanContext = JSON.parse(
    native.start_trace_span(
      JSON.stringify({
        name: 'host.callback',
        kind: 'callback',
        parent: context,
        ...generatedScopeIds(
          generator,
          {},
          true,
          JSON.parse(native.trace_span_context(context)).disabled,
        ),
      }),
    ),
  );
  const key = wire.callback_storage_key;
  const entry = key === undefined ? undefined : callbackStorages?.get(key);
  if (callbackStorages && key !== undefined && !entry) {
    native.release_trace_span(wire.handle);
    throw new Error('Native child callback trace ownership unavailable');
  }
  const retainStorage = entry
    ? () => {
        entry.entered++;
        return () => {
          entry.entered--;
          forgetReleasedStorage(callbackStorages!, key!, entry);
        };
      }
    : undefined;
  const releaseStorage = retainStorage?.();
  try {
    const parent = workflowForTrace
      ? wire.workflow_span_id
        ? workflowForTrace(wire.trace_id, wire.workflow_span_id)
        : undefined
      : ambient.getStore();
    const span = spanFromWire(native, wire, 'callback', parent);
    const invoke = () => ambient.run(span, () => callback(retainStorage));
    try {
      const result = await (entry
        ? runWithStorage(entry.storage, invoke)
        : invoke());
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
  } finally {
    releaseStorage?.();
  }
}
