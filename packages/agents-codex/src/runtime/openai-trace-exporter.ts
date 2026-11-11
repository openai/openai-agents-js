import { setTimeout as waitForRetry } from 'node:timers/promises';
import { traceCredentialRoute, traceDeliverySignal } from './trace-delivery';
import type { TraceEvent, TraceProcessor } from './telemetry';

function timestamp(nanos: string): string {
  const value = BigInt(nanos);
  const seconds = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0');
  return new Date(Number(seconds * 1000n))
    .toISOString()
    .replace('.000Z', `.${fraction}Z`);
}
function spanId(value: string | null): string | null {
  return value === null ? null : `span_${value.padStart(24, '0')}`;
}

function retryAfterMs(headers: Headers): number {
  for (const [name, scale] of [
    ['retry-after-ms', 1],
    ['retry-after', 1000],
  ] as const) {
    const value = headers.get(name);
    if (value === null || value.length > 128 || value.trim() === '') continue;
    let delay = Number(value) * scale;
    if (!Number.isFinite(delay) && name === 'retry-after') {
      delay = Math.max(0, Date.parse(value) - Date.now());
    }
    if (Number.isFinite(delay) && delay >= 0) return delay;
  }
  return 0;
}

type TraceDescriptor = Record<string, unknown>;
interface TraceState {
  descriptor: TraceDescriptor;
  activeSpans: number;
  rootEnded: boolean;
  deliveredTo?: { revision: number; identity: string };
}
function descriptor(
  event: Pick<TraceEvent, 'trace_id' | 'name' | 'attributes'>,
): TraceDescriptor {
  const metadata = Object.fromEntries(
    Object.entries(event.attributes)
      .filter(([key]) => key.startsWith('sdk.metadata.'))
      .map(([key, value]) => [key.slice('sdk.metadata.'.length), value]),
  );
  return {
    object: 'trace',
    id: `trace_${event.trace_id}`,
    workflow_name: event.name,
    group_id: event.attributes['sdk.group_id'] ?? null,
    metadata: { ...metadata, runtime: 'native' },
  };
}

/**
 * Serialize real native lifecycle records for the OpenAI traces-ingest API.
 * Register in configure({ traceProcessors: [...] }); native flush barriers wait
 * for delivery. Native spans appear as custom spans with their native attributes,
 * parent IDs and exact timestamps. One HTTP request per effective credential within each native-drain batch;
 * acknowledgement waits for delivery. No Classic runtime or separate queue is used.
 * Up to1024 root descriptors are retained; active roots/descendants prevent
 * eviction. Completed traces retire first; full active capacity rejects new roots.
 * Retained native contexts have been supplying original closed-root descriptors
 * after ordinary eviction.
 * Unknown child records never fabricate a root descriptor. Metadata preserves
 * native flattened values; runtime is reserved for the native marker.
 * After native record loss, descriptors are invalidated after a captured native
 * sequence watermark drains. Fresh root starts and native descriptors born after
 * that watermark re-establish identity; old child/end records fail closed. Flush continues reporting loss. Lossless active
 * roots retain their original eviction guarantee.
 */
export class OpenAITraceExporter implements TraceProcessor {
  readonly #endpoint: URL;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #traces = new Map<string, TraceState>();
  #credentialRevision = 0;
  #recoverySequence: number | undefined;

  constructor(options: {
    apiKey: string;
    endpoint?: string;
    organization?: string;
    project?: string;
    /** One delivery budget, including retries and backoff. */
    timeoutMs?: number;
    maxRetries?: number;
    /** Initial exponential backoff; zero preserves immediate retries. */
    retryDelayMs?: number;
    /** Maximum backoff or server-requested delay. Defaults to 30000. */
    maxRetryDelayMs?: number;
  }) {
    let endpoint: URL;
    try {
      endpoint = new URL(
        options.endpoint ?? 'https://api.openai.com/v1/traces/ingest',
      );
    } catch {
      throw new TypeError('Invalid trace export endpoint');
    }
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw new TypeError(
        'Trace endpoint must be an HTTP(S) URL without credentials or fragments',
      );
    const timeout = options.timeoutMs ?? 750;
    const retries = options.maxRetries ?? 0;
    const retryDelay = options.retryDelayMs ?? 0;
    const maxRetryDelay = options.maxRetryDelayMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000)
      throw new RangeError('timeoutMs must be an integer from 1 through 60000');
    if (!Number.isSafeInteger(retries) || retries < 0)
      throw new RangeError('maxRetries must be a non-negative safe integer');
    for (const [name, delay] of [
      ['retryDelayMs', retryDelay],
      ['maxRetryDelayMs', maxRetryDelay],
    ] as const) {
      if (!Number.isInteger(delay) || delay < 0 || delay > 60_000)
        throw new RangeError(`${name} must be an integer from 0 through 60000`);
    }
    if (maxRetryDelay < retryDelay)
      throw new RangeError('maxRetryDelayMs must be at least retryDelayMs');
    this.#endpoint = endpoint;
    this.#timeoutMs = timeout;
    this.#maxRetries = retries;
    this.#retryDelayMs = retryDelay;
    this.#maxRetryDelayMs = maxRetryDelay;
    this.#headers = {
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'traces=v1',
    };
    this.setApiKey(options.apiKey);
    for (const [name, value] of [
      ['OpenAI-Organization', options.organization],
      ['OpenAI-Project', options.project],
    ]) {
      if (value !== undefined) {
        this.validateHeader(value);
        this.#headers[name!] = value;
      }
    }
  }
  private validateHeader(value: string): void {
    if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value))
      throw new TypeError(
        'Trace export headers must be nonempty printable ASCII strings',
      );
  }
  /** Replace credentials for subsequent deliveries; credentials never enter records. */
  setApiKey(apiKey: string): void {
    this.validateHeader(apiKey);
    this.#headers.Authorization = `Bearer ${apiKey}`;
    this.#credentialRevision++;
  }
  /** @internal Called serially by the native pump after its loss watermark. */
  _onNativeTraceLoss(sequence = 0): void {
    this.#traces.clear();
    this.#recoverySequence = Math.max(this.#recoverySequence ?? 0, sequence);
  }
  async onEvent(event: TraceEvent): Promise<void> {
    await this.onEvents([event]);
  }
  /** Deliver one native-owned batch before its records can be acknowledged. */
  async onEvents(events: readonly TraceEvent[]): Promise<void> {
    const revision = this.#credentialRevision;
    const fallbackHeaders = { ...this.#headers };
    // Resolve the complete original batch before mutating descriptor/liveness state.
    const eventRoutes = new Map(
      events.map((event) => [event, traceCredentialRoute(event)]),
    );
    const states = new Map<string, TraceState>();
    const admitted: TraceEvent[] = [];
    let admissionError: string | undefined;
    for (const event of events) {
      const recovery = event.recovery_sequence;
      if (
        typeof recovery === 'number' &&
        recovery > (this.#recoverySequence ?? 0)
      ) {
        this._onNativeTraceLoss(recovery);
      }
      if (event.sequence <= (this.#recoverySequence ?? -1)) {
        admissionError ??= 'Native trace root descriptor is unavailable';
        continue;
      }
      const traceId = `trace_${event.trace_id}`;
      const root = event.parent_span_id === null;
      let state = this.#traces.get(traceId);
      if (!state) {
        let retained = event.root_descriptor as
          | (Pick<TraceEvent, 'name' | 'attributes'> & {
              start_sequence?: number;
            })
          | undefined;
        if (
          this.#recoverySequence !== undefined &&
          (retained?.start_sequence ?? 0) <= this.#recoverySequence
        )
          retained = undefined;
        if (
          (!root && retained === undefined) ||
          (this.#recoverySequence !== undefined &&
            root &&
            event.lifecycle !== 'start')
        ) {
          admissionError ??= 'Native trace root descriptor is unavailable';
          continue;
        }
        if (this.#traces.size >= 1024) {
          const completed = [...this.#traces].find(
            ([, entry]) => entry.rootEnded && entry.activeSpans === 0,
          );
          if (!completed) {
            admissionError ??=
              'Native active trace descriptor capacity reached';
            continue;
          }
          this.#traces.delete(completed[0]);
        }
        state = {
          descriptor: descriptor(
            root ? event : { ...retained!, trace_id: event.trace_id },
          ),
          activeSpans: 0,
          rootEnded: !root,
        };
      }
      if (event.lifecycle === 'start') state.activeSpans++;
      else {
        state.activeSpans = Math.max(0, state.activeSpans - 1);
        if (root) state.rootEnded = true;
      }
      this.#traces.delete(traceId);
      this.#traces.set(traceId, state);
      states.set(traceId, state);
      admitted.push(event);
    }
    // Failed native batches are acknowledged too. Deliver admitted records
    // before reporting rejected ones, so one unavailable root cannot lose others.
    const groups = new Map<
      string,
      {
        identity: string;
        headers: Record<string, string>;
        events: TraceEvent[];
      }
    >();
    for (const event of admitted) {
      const route = eventRoutes.get(event);
      const identity = route?.identity ?? '';
      let group = groups.get(identity);
      if (!group) {
        group = {
          identity,
          headers: route
            ? {
                ...Object.fromEntries(
                  Object.entries(fallbackHeaders).map(([key, value]) => [
                    key.toLowerCase(),
                    value,
                  ]),
                ),
                ...route.headers,
              }
            : fallbackHeaders,
          events: [],
        };
        groups.set(identity, group);
      }
      group.events.push(event);
    }
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const stopped = traceDeliverySignal();
    const signal = stopped ? AbortSignal.any([deadline, stopped]) : deadline;
    let deliveryFailed = false;
    for (const group of groups.values()) {
      const traceIds = new Set(
        group.events.map((event) => `trace_${event.trace_id}`),
      );
      const pending = [...states]
        .filter(
          ([traceId, state]) =>
            traceIds.has(traceId) &&
            (state.deliveredTo?.revision !== revision ||
              state.deliveredTo.identity !== group.identity),
        )
        .map(([traceId, state]) => ({
          traceId,
          state,
          descriptor: state.descriptor,
        }));
      const records: Record<string, unknown>[] = pending.map(
        (item) => item.descriptor,
      );
      for (const event of group.events) {
        if (event.lifecycle === 'end')
          records.push({
            object: 'trace.span',
            id: spanId(event.span_id),
            trace_id: `trace_${event.trace_id}`,
            parent_id: spanId(event.parent_span_id),
            started_at: timestamp(event.start_time_unix_nanos),
            ended_at: timestamp(event.end_time_unix_nanos!),
            span_data: {
              type: 'custom',
              name: event.name,
              data: event.attributes,
            },
            error:
              event.outcome === 'error'
                ? {
                    message: 'Native span failed',
                    data: { outcome: event.outcome },
                  }
                : null,
          });
      }
      if (!records.length) continue;
      const body = JSON.stringify({ data: records });
      let delivered = false;
      let delay = this.#retryDelayMs;
      for (
        let attempt = 0;
        attempt <= this.#maxRetries && !signal.aborted;
        attempt++
      ) {
        let retry = false;
        let serverDelay = 0;
        let requested = false;
        let received = false;
        try {
          // Detached work cannot start another request after callback retirement.
          for (const event of group.events) traceCredentialRoute(event);
          requested = true;
          const response = await fetch(this.#endpoint, {
            method: 'POST',
            headers: group.headers,
            body,
            signal,
            redirect: 'manual',
          });
          received = true;
          retry =
            ([408, 409, 429].includes(response.status) ||
              response.status >= 500) &&
            response.headers.get('x-should-retry')?.trim().toLowerCase() !==
              'false';
          if (retry) serverDelay = retryAfterMs(response.headers);
          await response.body?.cancel();
          if (response.ok) {
            if (this.#credentialRevision === revision) {
              for (const item of pending) {
                if (
                  this.#traces.get(item.traceId) === item.state &&
                  item.state.descriptor === item.descriptor
                )
                  item.state.deliveredTo = {
                    revision,
                    identity: group.identity,
                  };
              }
            }
            delivered = true;
            break;
          }
        } catch {
          // Body cleanup cannot replace a received response's retry decision.
          retry = !signal.aborted && (received ? retry : requested);
        }
        if (!retry || attempt === this.#maxRetries) break;
        const wait = Math.min(
          this.#maxRetryDelayMs,
          Math.max(delay + Math.random() * delay * 0.1, serverDelay),
        );
        try {
          // Yield even for immediate failures so the existing deadline can fire.
          await waitForRetry(wait, undefined, { signal });
        } catch {
          break;
        }
        delay = Math.min(delay * 2, this.#maxRetryDelayMs);
      }
      deliveryFailed ||= !delivered;
    }
    if (deliveryFailed) {
      throw new Error(
        `Native OpenAI trace export failed${admissionError ? `; ${admissionError}` : ''}`,
      );
    }
    if (admissionError) throw new Error(admissionError);
  }
}

/** Write native lifecycle diagnostics as JSON lines. Native capture policy controls content. */
export class ConsoleTraceProcessor implements TraceProcessor {
  constructor(
    private readonly output: (line: string) => void = (line) =>
      console.log(line),
  ) {}
  onEvent(event: TraceEvent): void {
    this.output(JSON.stringify(event));
  }
}
