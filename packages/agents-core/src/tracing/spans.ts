import logger from '../logger';
import { TracingProcessor } from './processor';
import { generateSpanId, removePrivateFields, timeIso } from './utils';

type SpanDataBase = {
  type: string;
};

export type AgentSpanData = SpanDataBase & {
  type: 'agent';
  name: string;
  handoffs?: string[];
  tools?: string[];
  output_type?: string;
};

export type FunctionSpanData = SpanDataBase & {
  type: 'function';
  name: string;
  input: string;
  output: string;
  mcp_data?: string;
};

export type GenerationSpanData = SpanDataBase & {
  type: 'generation';
  input?: Array<Record<string, any>>;
  output?: Array<Record<string, any>>;
  model?: string;
  model_config?: Record<string, any>;
  usage?: Record<string, any>;
};

export type ResponseSpanData = SpanDataBase & {
  type: 'response';
  response_id?: string;
  /**
   * Not used by the OpenAI tracing provider but helpful for other tracing providers.
   */
  _input?: string | Record<string, any>[];
  _response?: Record<string, any>;
};

export type HandoffSpanData = SpanDataBase & {
  type: 'handoff';
  from_agent?: string;
  to_agent?: string;
};

export type CustomSpanData = SpanDataBase & {
  type: 'custom';
  name: string;
  data: Record<string, any>;
};

export type GuardrailSpanData = SpanDataBase & {
  type: 'guardrail';
  name: string;
  triggered: boolean;
};

export type TranscriptionSpanData = SpanDataBase & {
  type: 'transcription';
  input: {
    data: string;
    format: 'pcm' | (string & {});
  };
  output?: string;
  model?: string;
  model_config?: Record<string, any>;
};

export type SpeechSpanData = SpanDataBase & {
  type: 'speech';
  input?: string;
  output: {
    data: string;
    format: 'pcm' | (string & {});
  };
  model?: string;
  model_config?: Record<string, any>;
};

export type SpeechGroupSpanData = SpanDataBase & {
  type: 'speech_group';
  input?: string;
};

export type MCPListToolsSpanData = SpanDataBase & {
  type: 'mcp_tools';
  server?: string;
  result?: string[];
};

export type SpanData =
  | AgentSpanData
  | FunctionSpanData
  | GenerationSpanData
  | ResponseSpanData
  | HandoffSpanData
  | CustomSpanData
  | GuardrailSpanData
  | TranscriptionSpanData
  | SpeechSpanData
  | SpeechGroupSpanData
  | MCPListToolsSpanData;

export type SpanOptions<TData extends SpanData> = {
  traceId: string;
  spanId?: string;
  parentId?: string;
  data: TData;
  startedAt?: string;
  endedAt?: string;
  error?: SpanError;
  tracingApiKey?: string;
};

export type SpanError = {
  message: string;
  data?: Record<string, any>;
};

export class Span<TData extends SpanData> {
  public type = 'trace.span' as const;

  #data: TData;
  #traceId: string;
  #spanId: string;
  #parentId: string | null;
  #processor: TracingProcessor;
  #startedAt: string | null;
  #endedAt: string | null;
  #error: SpanError | null;
  #tracingApiKey: string | undefined;

  #previousSpan: Span<any> | undefined;

  constructor(options: SpanOptions<TData>, processor: TracingProcessor) {
    this.#traceId = options.traceId;
    this.#spanId = options.spanId ?? generateSpanId();
    this.#data = options.data;
    this.#processor = processor;
    this.#parentId = options.parentId ?? null;
    this.#error = options.error ?? null;
    this.#startedAt = options.startedAt ?? null;
    this.#endedAt = options.endedAt ?? null;
    this.#tracingApiKey = options.tracingApiKey;
  }

  get traceId() {
    return this.#traceId;
  }

  get spanData() {
    return this.#data;
  }

  get spanId() {
    return this.#spanId;
  }

  get parentId() {
    return this.#parentId;
  }

  get previousSpan() {
    return this.#previousSpan;
  }

  set previousSpan(span: Span<any> | undefined) {
    this.#previousSpan = span;
  }

  start() {
    if (this.#startedAt) {
      logger.warn('Span already started');
      return;
    }

    this.#startedAt = timeIso();
    this.#processor.onSpanStart(this);
  }

  end() {
    if (this.#endedAt) {
      logger.debug('Span already finished', this.spanData);
      return;
    }

    this.#endedAt = timeIso();
    this.#processor.onSpanEnd(this);
  }

  setError(error: SpanError) {
    this.#error = error;
  }

  get error() {
    return this.#error;
  }

  get startedAt() {
    return this.#startedAt;
  }

  get endedAt() {
    return this.#endedAt;
  }

  get tracingApiKey() {
    return this.#tracingApiKey;
  }

  clone(): Span<TData> {
    const span = new Span(
      {
        traceId: this.traceId,
        spanId: this.spanId,
        parentId: this.parentId ?? undefined,
        data: this.spanData,
        startedAt: this.#startedAt ?? undefined,
        endedAt: this.#endedAt ?? undefined,
        error: this.#error ?? undefined,
        tracingApiKey: this.#tracingApiKey,
      },
      this.#processor,
    );
    span.previousSpan = this.previousSpan?.clone();
    return span;
  }

  toJSON(): object | null {
    return {
      object: this.type,
      id: this.spanId,
      trace_id: this.traceId,
      parent_id: this.parentId,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      span_data: removePrivateFields(this.spanData),
      error: this.error,
    };
  }
}

export class NoopSpan<TSpanData extends SpanData> extends Span<TSpanData> {
  constructor(data: TSpanData, processor: TracingProcessor) {
    super({ traceId: 'no-op', spanId: 'no-op', data }, processor);
  }

  start() {
    return;
  }

  end() {
    return;
  }

  setError() {
    return;
  }

  toJSON() {
    return null;
  }
}
