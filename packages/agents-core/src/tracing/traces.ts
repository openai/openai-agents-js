import { defaultProcessor, TracingProcessor } from './processor';
import { generateTraceId } from './utils';

export type TraceOptions = {
  traceId?: string;
  name?: string;
  groupId?: string;
  metadata?: Record<string, any>;
  started?: boolean;
  tracingApiKey?: string;
};

export class Trace {
  public type = 'trace' as const;
  public traceId: string;
  public name: string;
  public groupId: string | null = null;
  public metadata?: Record<string, any>;
  public tracingApiKey?: string;

  #processor: TracingProcessor;
  #started: boolean;

  constructor(options: TraceOptions, processor?: TracingProcessor) {
    this.traceId = options.traceId ?? generateTraceId();
    this.name = options.name ?? 'Agent workflow';
    this.groupId = options.groupId ?? null;
    this.metadata = options.metadata ?? {};
    this.tracingApiKey = options.tracingApiKey;
    this.#processor = processor ?? defaultProcessor();
    this.#started = options.started ?? false;
  }

  async start() {
    if (this.#started) {
      return;
    }

    this.#started = true;
    await this.#processor.onTraceStart(this);
  }

  async end() {
    if (!this.#started) {
      return;
    }

    this.#started = false;
    await this.#processor.onTraceEnd(this);
  }

  clone(): Trace {
    return new Trace({
      traceId: this.traceId,
      name: this.name,
      groupId: this.groupId ?? undefined,
      metadata: this.metadata,
      started: this.#started,
      tracingApiKey: this.tracingApiKey,
    });
  }

  /**
   * Serializes the trace for export or persistence.
   * Set `includeTracingApiKey` to true only when you intentionally need to persist the
   * exporter credentials (for example, when handing off a run to another process that
   * cannot access the original environment). Defaults to false to avoid leaking secrets.
   */
  toJSON(options?: { includeTracingApiKey?: boolean }): object | null {
    const base = {
      object: this.type,
      id: this.traceId,
      workflow_name: this.name,
      group_id: this.groupId,
      metadata: this.metadata,
    } as Record<string, any>;

    if (options?.includeTracingApiKey && this.tracingApiKey) {
      base.tracing_api_key = this.tracingApiKey;
    }

    return base;
  }
}

export class NoopTrace extends Trace {
  constructor() {
    super({});
  }

  async start(): Promise<void> {
    return;
  }

  async end(): Promise<void> {
    return;
  }

  toJSON(): object | null {
    return null;
  }
}
