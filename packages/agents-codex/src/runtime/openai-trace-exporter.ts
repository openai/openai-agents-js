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

/**
 * Serialize real native lifecycle records for the OpenAI traces-ingest API.
 * Register in configure({ traceProcessors: [...] }); native flush barriers wait
 * for delivery. Native spans appear as custom spans with their native attributes,
 * parent IDs and exact timestamps. No Classic runtime or separate queue is used.
 */
export class OpenAITraceExporter implements TraceProcessor {
  readonly #endpoint: URL;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #traces = new Set<string>();

  constructor(options: {
    apiKey: string;
    endpoint?: string;
    organization?: string;
    project?: string;
    /** One delivery budget, including retries; native processor delivery has a one-second bound. */
    timeoutMs?: number;
    maxRetries?: number;
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
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 900)
      throw new RangeError('timeoutMs must be an integer from 1 through 900');
    if (!Number.isInteger(retries) || retries < 0 || retries > 3)
      throw new RangeError('maxRetries must be an integer from 0 through 3');
    this.#endpoint = endpoint;
    this.#timeoutMs = timeout;
    this.#maxRetries = retries;
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
  }
  async onEvent(event: TraceEvent): Promise<void> {
    const traceId = `trace_${event.trace_id}`;
    const records: Record<string, unknown>[] = [];
    if (!this.#traces.has(traceId))
      records.push({
        object: 'trace',
        id: traceId,
        workflow_name: event.name,
        group_id: event.attributes['sdk.group_id'] ?? null,
        metadata: { runtime: 'native' },
      });
    if (event.lifecycle === 'end')
      records.push({
        object: 'trace.span',
        id: spanId(event.span_id),
        trace_id: traceId,
        parent_id: spanId(event.parent_span_id),
        started_at: timestamp(event.start_time_unix_nanos),
        ended_at: timestamp(event.end_time_unix_nanos!),
        span_data: { type: 'custom', name: event.name, data: event.attributes },
        error:
          event.outcome === 'error'
            ? {
                message: 'Native span failed',
                data: { outcome: event.outcome },
              }
            : null,
      });
    if (!records.length) return;
    const body = JSON.stringify({ data: records });
    const headers = { ...this.#headers };
    const signal = AbortSignal.timeout(this.#timeoutMs);
    for (
      let attempt = 0;
      attempt <= this.#maxRetries && !signal.aborted;
      attempt++
    ) {
      let retry = false;
      try {
        const response = await fetch(this.#endpoint, {
          method: 'POST',
          headers,
          body,
          signal,
          redirect: 'manual',
        });
        await response.body?.cancel();
        if (response.ok) {
          this.#traces.delete(traceId);
          this.#traces.add(traceId);
          if (this.#traces.size > 1024)
            this.#traces.delete(this.#traces.values().next().value!);
          return;
        }
        retry = response.status >= 500;
      } catch {
        retry = true;
      }
      if (!retry) break;
    }
    // Do not expose endpoints, credentials, request bodies or response bodies.
    throw new Error('Native OpenAI trace export failed');
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
