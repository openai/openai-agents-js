import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span as OtelSpan,
  type Tracer,
} from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import type {
  Span,
  SpanData,
  Trace,
  TracingProcessor,
} from '@openai/agents-core';

export type OpenTelemetryTracingProcessorOptions = {
  /** The tracer used to create spans. Defaults to `@openai/agents`. */
  tracer?: Tracer;
  /** Include model and tool input in span attributes. Disabled by default. */
  recordInputs?: boolean;
  /** Include model and tool output in span attributes. Disabled by default. */
  recordOutputs?: boolean;
  /** Include data attached to custom spans. Disabled by default. */
  recordCustomData?: boolean;
  /** Suppress automatic instrumentation beneath Agents SDK spans. Defaults to true. */
  suppressInstrumentation?: boolean;
};

function timestamp(value: string | null): number | undefined {
  return value ? new Date(value).getTime() : undefined;
}

function spanName(data: SpanData): string {
  switch (data.type) {
    case 'agent':
      return `invoke_agent ${data.name}`;
    case 'function':
      return `execute_tool ${data.name}`;
    case 'generation':
      return `chat ${data.model ?? 'model'}`;
    case 'response':
      return 'chat';
    case 'handoff':
      return 'handoff';
    case 'guardrail':
      return `guardrail ${data.name}`;
    case 'custom':
      return `custom ${data.name}`;
    case 'mcp_tools':
      return 'list_tools';
    case 'transcription':
      return `transcribe ${data.model ?? 'model'}`;
    case 'speech':
      return `synthesize_speech ${data.model ?? 'model'}`;
    case 'speech_group':
      return 'speech_group';
    default:
      return `openai.agents.${data.type}`;
  }
}

function attributesForSpan(
  span: Span<any>,
  {
    recordInputs,
    recordOutputs,
    recordCustomData,
  }: OpenTelemetryTracingProcessorOptions,
): Attributes {
  const data = span.spanData;
  const attributes: Attributes = {
    'openai.agents.trace.id': span.traceId,
    'openai.agents.span.id': span.spanId,
    'openai.agents.span.type': data.type,
    'gen_ai.operation.name': spanName(data).split(' ')[0],
  };

  if (data.type === 'agent') {
    attributes['gen_ai.agent.name'] = data.name;
    if (data.handoffs)
      attributes['openai.agents.agent.handoffs'] = data.handoffs;
    if (data.tools) attributes['openai.agents.agent.tools'] = data.tools;
    if (data.output_type)
      attributes['openai.agents.agent.output_type'] = data.output_type;
  } else if (data.type === 'function') {
    attributes['gen_ai.tool.name'] = data.name;
    if (recordInputs) attributes['gen_ai.tool.call.arguments'] = data.input;
    if (recordOutputs) attributes['gen_ai.tool.call.result'] = data.output;
  } else if (data.type === 'generation') {
    if (data.model) attributes['gen_ai.request.model'] = data.model;
    if (data.usage?.input_tokens !== undefined) {
      attributes['gen_ai.usage.input_tokens'] = data.usage.input_tokens;
    }
    if (data.usage?.output_tokens !== undefined) {
      attributes['gen_ai.usage.output_tokens'] = data.usage.output_tokens;
    }
    if (recordInputs && data.input)
      attributes['gen_ai.input.messages'] = JSON.stringify(data.input);
    if (recordOutputs && data.output)
      attributes['gen_ai.output.messages'] = JSON.stringify(data.output);
  } else if (data.type === 'response') {
    if (data.response_id) attributes['gen_ai.response.id'] = data.response_id;
    if (recordInputs && data._input !== undefined) {
      attributes['gen_ai.input.messages'] =
        typeof data._input === 'string'
          ? data._input
          : JSON.stringify(data._input);
    }
    if (recordOutputs && data._response !== undefined) {
      attributes['gen_ai.output.messages'] = JSON.stringify(data._response);
    }
  } else if (data.type === 'handoff') {
    if (data.from_agent) attributes['gen_ai.agent.name'] = data.from_agent;
    if (data.to_agent)
      attributes['openai.agents.handoff.to_agent'] = data.to_agent;
  } else if (data.type === 'guardrail') {
    attributes['openai.agents.guardrail.name'] = data.name;
    attributes['openai.agents.guardrail.triggered'] = data.triggered;
  } else if (data.type === 'custom') {
    attributes['openai.agents.custom.name'] = data.name;
    if (recordCustomData) {
      attributes['openai.agents.custom.data'] = JSON.stringify(data.data);
    }
  } else if (data.type === 'mcp_tools') {
    if (data.server) attributes['openai.agents.mcp.server'] = data.server;
    if (data.result) attributes['openai.agents.mcp.tools'] = data.result;
  } else if (data.type === 'transcription') {
    if (data.model) attributes['gen_ai.request.model'] = data.model;
    attributes['openai.agents.audio.input_format'] = data.input.format;
    if (recordInputs) {
      attributes['openai.agents.audio.input_data'] = data.input.data;
    }
    if (recordOutputs && data.output !== undefined) {
      attributes['openai.agents.transcription.output'] = data.output;
    }
  } else if (data.type === 'speech') {
    if (data.model) attributes['gen_ai.request.model'] = data.model;
    attributes['openai.agents.audio.output_format'] = data.output.format;
    if (recordInputs && data.input !== undefined) {
      attributes['openai.agents.speech.input'] = data.input;
    }
    if (recordOutputs) {
      attributes['openai.agents.audio.output_data'] = data.output.data;
    }
  } else if (data.type === 'speech_group') {
    if (recordInputs && data.input !== undefined) {
      attributes['openai.agents.speech.input'] = data.input;
    }
  }

  return attributes;
}

/**
 * Mirrors Agents SDK traces to OpenTelemetry. Add it with `addTraceProcessor()`.
 *
 * The processor intentionally suppresses automatic HTTP/fetch instrumentation inside
 * Agents SDK spans by default. This keeps the trace focused on agent, model, handoff,
 * and tool operations; set `suppressInstrumentation: false` to retain those spans.
 */
export class OpenTelemetryTracingProcessor implements TracingProcessor {
  readonly #tracer: Tracer;
  readonly #options: OpenTelemetryTracingProcessorOptions;
  readonly #traces = new Map<string, OtelSpan>();
  readonly #spans = new Map<string, OtelSpan>();

  constructor(options: OpenTelemetryTracingProcessorOptions = {}) {
    this.#tracer = options.tracer ?? trace.getTracer('@openai/agents');
    this.#options = options;
  }

  async onTraceStart(agentTrace: Trace): Promise<void> {
    const attributes: Attributes = {
      'openai.agents.trace.id': agentTrace.traceId,
      'openai.agents.trace.name': agentTrace.name,
    };
    if (agentTrace.groupId)
      attributes['openai.agents.group.id'] = agentTrace.groupId;
    this.#traces.set(
      agentTrace.traceId,
      this.#tracer.startSpan(agentTrace.name, {
        kind: SpanKind.INTERNAL,
        attributes,
      }),
    );
  }

  async onTraceEnd(agentTrace: Trace): Promise<void> {
    this.#traces.get(agentTrace.traceId)?.end();
    this.#traces.delete(agentTrace.traceId);
  }

  async onSpanStart(agentSpan: Span<any>): Promise<void> {
    const parent = agentSpan.parentId
      ? this.#spans.get(agentSpan.parentId)
      : this.#traces.get(agentSpan.traceId);
    const parentContext = parent
      ? trace.setSpan(ROOT_CONTEXT, parent)
      : context.active();
    this.#spans.set(
      agentSpan.spanId,
      this.#tracer.startSpan(
        spanName(agentSpan.spanData),
        {
          kind: SpanKind.INTERNAL,
          attributes: attributesForSpan(agentSpan, this.#options),
          startTime: timestamp(agentSpan.startedAt),
        },
        parentContext,
      ),
    );
  }

  async onSpanEnd(agentSpan: Span<any>): Promise<void> {
    const otelSpan = this.#spans.get(agentSpan.spanId);
    if (!otelSpan) return;
    otelSpan.setAttributes(attributesForSpan(agentSpan, this.#options));
    if (agentSpan.error) {
      otelSpan.recordException(agentSpan.error.message);
      otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: agentSpan.error.message,
      });
    }
    otelSpan.end(timestamp(agentSpan.endedAt));
    this.#spans.delete(agentSpan.spanId);
  }

  async withSpan<T>(agentSpan: Span<any>, fn: () => Promise<T>): Promise<T> {
    const otelSpan = this.#spans.get(agentSpan.spanId);
    if (!otelSpan) return fn();
    let activeContext: Context = trace.setSpan(context.active(), otelSpan);
    if (this.#options.suppressInstrumentation !== false) {
      activeContext = suppressTracing(activeContext);
    }
    return context.with(activeContext, fn);
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}
