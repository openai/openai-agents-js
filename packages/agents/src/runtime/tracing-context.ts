/** Native scope ownership shared by public telemetry and Session admission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { binding, copyJsonValue } from './binding';
import type { SpanContext, TraceOptions } from './telemetry';
type Native = Awaited<ReturnType<typeof binding>>;

const ambient = new AsyncLocalStorage<TraceSpan | undefined>();

/** Native-owned span. Close explicit handles when their work finishes. */
export class TraceSpan {
  readonly context: SpanContext;
  private ended = false;
  private released = false;
  constructor(
    private readonly native: Native,
    /** @internal Opaque process-local handle; never persist. */
    readonly handle: string,
    readonly kind: string,
    context: SpanContext,
    /** @internal */ readonly workflow?: TraceSpan,
  ) {
    this.context = Object.freeze(context);
  }
  /** @internal */ retain(): string {
    return this.native.retain_trace_context(this.handle);
  }
  /** @internal */ releaseContext(token: string): void {
    this.native.release_trace_context(token);
  }
  end(
    outcome: { status?: 'ok' | 'error' | 'cancelled'; category?: string } = {},
  ): void {
    if (this.ended) return;
    this.native.end_trace_span(
      this.handle,
      JSON.stringify({
        status: outcome.status ?? 'ok',
        category: outcome.category ?? null,
        data: {},
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
          parent: this.handle,
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

/** @internal Capture parent ownership before any asynchronous boundary. */
export function captureTracing(
  options?: TraceOptions,
  opening?: TraceCapture,
): TraceCapture | undefined {
  if (
    options === undefined &&
    ambient.getStore() === undefined &&
    opening === undefined
  )
    return undefined;
  return new TraceCapture(start(options ?? {}, 'operation', opening));
}
/** @internal One captured native operation; settlement releases every host lease. */
export class TraceCapture {
  private span?: TraceSpan;
  private contextToken?: string;
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
    return ambient.run(parent, () => scoped({ name }, kind, callback));
  }
  validate<T>(callback: () => T): T {
    return this.span ? this.span.validate(callback) : callback();
  }
  finish(
    error?: unknown,
    cancelled = false,
    category = 'operation_error',
  ): void {
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
  disabled: boolean;
  include_sensitive_data: boolean;
}
function spanFromWire(
  native: Native,
  context: WireSpanContext,
  kind: string,
  parent?: TraceSpan,
): TraceSpan {
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
    parent?.context.traceId === context.trace_id
      ? parent.kind === 'workflow'
        ? parent
        : parent.workflow
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
  const snapshot = { ...options, metadata };
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
  workflowForTrace?: (traceId: string) => TraceSpan | undefined,
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
    ? workflowForTrace(wire.trace_id)
    : ambient.getStore();
  const span = spanFromWire(native, wire, 'callback', parent);
  try {
    return await ambient.run(span, () => callback());
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
