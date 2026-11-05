import { inspect } from 'node:util';

/** W3C propagation headers. This carrier does not create or own a span. */
export interface TraceContextHeaders {
  readonly traceparent: string;
  readonly tracestate?: string | null;
}

/**
 * Immutable explicit native trace parent, independent of any tracing provider.
 * Traceparent accepts at most 512 ASCII characters, nonzero lowercase IDs, and
 * version 00 flags 00 or 01. Future versions retain their opaque suffix.
 * Tracestate accepts 32 entries with keys and values up to 256 characters;
 * tenant system IDs accept at most 13 characters to match native OpenTelemetry.
 * This native profile does not accept every standards-valid W3C carrier.
 * Carrier values are hidden in inspection. Never include private data or credentials.
 */
export class TraceContext {
  readonly #traceparent: string;
  readonly #tracestate: string | undefined;

  constructor(headers: TraceContextHeaders) {
    if (
      headers === null ||
      typeof headers !== 'object' ||
      Object.keys(headers).some(
        (key) => key !== 'traceparent' && key !== 'tracestate',
      )
    )
      throw new TypeError(
        'A trace carrier requires traceparent and optional tracestate only',
      );
    const parent = headers.traceparent;
    const match =
      typeof parent === 'string'
        ? /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/.exec(
            parent,
          )
        : null;
    if (
      !match ||
      parent.length > 512 ||
      match[1] === 'ff' ||
      match[2] === '0'.repeat(32) ||
      match[3] === '0'.repeat(16) ||
      (match[1] === '00' &&
        (parent.length !== 55 || !['00', '01'].includes(match[4]!))) ||
      (parent.length > 55 && parent[55] !== '-') ||
      /[^\x21-\x7e]/.test(parent)
    )
      throw new TypeError('Invalid or unsupported native traceparent');
    let state = headers.tracestate ?? undefined;
    if (state !== undefined) {
      if (
        typeof state !== 'string' ||
        state.split(',').length > 32 ||
        /[^\x20-\x7e\t]/.test(state)
      )
        throw new TypeError('Invalid or unsupported native tracestate');
      const members = new Map<string, string>();
      for (let member of state.split(',')) {
        member = member.replace(/^[ \t]+|[ \t]+$/g, '');
        if (!member) continue;
        const separator = member.indexOf('=');
        const key = member.slice(0, separator);
        const value = member.slice(separator + 1);
        if (
          separator < 0 ||
          !/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,12})$/.test(
            key,
          ) ||
          members.has(key) ||
          value.length < 1 ||
          value.length > 256 ||
          /[^\x20-\x7e]|[,=]/.test(value) ||
          value.endsWith(' ')
        )
          throw new TypeError('Invalid or unsupported native tracestate');
        members.set(key, value);
      }
      state =
        [...members].map(([key, value]) => `${key}=${value}`).join(',') ||
        undefined;
    }
    this.#traceparent = parent;
    this.#tracestate = state;
    Object.freeze(this);
  }

  get traceparent(): string {
    return this.#traceparent;
  }
  get tracestate(): string | undefined {
    return this.#tracestate;
  }

  /** Return a detached carrier for an outbound W3C header boundary. */
  toHeaders(): Readonly<{ traceparent: string; tracestate?: string }> {
    return Object.freeze({
      traceparent: this.#traceparent,
      ...(this.#tracestate === undefined
        ? {}
        : { tracestate: this.#tracestate }),
    });
  }

  [inspect.custom](): string {
    return 'TraceContext(<redacted>)';
  }
}

/** @internal Validate and snapshot caller headers before acquiring runtime resources. */
export function captureTraceContext(
  value?: TraceContext | TraceContextHeaders | null,
): TraceContext | undefined {
  return value == null
    ? undefined
    : value instanceof TraceContext
      ? value
      : new TraceContext(value);
}

/** @internal Native optional metadata must never turn a tool callback into a failure. */
export function nativeTraceContext(
  value: TraceContextHeaders | null | undefined,
): TraceContext | undefined {
  try {
    return captureTraceContext(value);
  } catch {
    return undefined;
  }
}
