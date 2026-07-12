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
import { sanitizeJsonCompatibleValue } from '@openai/agents-core/utils/internal';

export type OpenTelemetryTracingProcessorOptions = {
  /** The tracer used to create spans. Defaults to `@openai/agents`. */
  tracer?: Tracer;
  /** Include model and tool input in span attributes. Disabled by default. */
  recordInputs?: boolean;
  /** Include model and tool output in span attributes. Disabled by default. */
  recordOutputs?: boolean;
  /** Include data attached to custom spans. Disabled by default. */
  recordCustomData?: boolean;
  /**
   * Choose which Agents SDK spans suppress nested automatic instrumentation.
   * Defaults to response and generation spans. Pass false to disable suppression,
   * true to suppress every span, or a callback for a custom policy.
   */
  suppressInstrumentation?: boolean | ((spanData: SpanData) => boolean);
  /** Flush the configured OTel provider when Agents tracing is flushed. */
  forceFlush?: () => Promise<void>;
  /** Shut down the configured OTel provider when Agents tracing shuts down. */
  shutdown?: (timeout?: number) => Promise<void>;
};

function timestamp(value: string | null): number | undefined {
  return value ? new Date(value).getTime() : undefined;
}

function serializedAttribute(key: string, value: unknown): Attributes {
  try {
    const sanitized = sanitizeJsonCompatibleValue(value);
    return sanitized === undefined ? {} : { [key]: JSON.stringify(sanitized) };
  } catch {
    return {};
  }
}

type SpanDescriptor = {
  name: string;
  operationName: string;
  attributes: Attributes;
};

function describeSpan(
  data: SpanData,
  {
    recordInputs,
    recordOutputs,
    recordCustomData,
  }: OpenTelemetryTracingProcessorOptions,
): SpanDescriptor {
  switch (data.type) {
    case 'agent':
      return {
        name: `invoke_agent ${data.name}`,
        operationName: 'invoke_agent',
        attributes: {
          'gen_ai.agent.name': data.name,
          ...(data.handoffs && {
            'openai.agents.agent.handoffs': data.handoffs,
          }),
          ...(data.tools && { 'openai.agents.agent.tools': data.tools }),
          ...(data.output_type && {
            'openai.agents.agent.output_type': data.output_type,
          }),
        },
      };
    case 'function':
      return {
        name: `execute_tool ${data.name}`,
        operationName: 'execute_tool',
        attributes: {
          'gen_ai.tool.name': data.name,
          ...(recordInputs && {
            'gen_ai.tool.call.arguments': data.input,
          }),
          ...(recordOutputs && {
            'gen_ai.tool.call.result': data.output,
          }),
        },
      };
    case 'generation':
      return {
        name: `chat ${data.model ?? 'model'}`,
        operationName: 'chat',
        attributes: {
          ...(data.model && { 'gen_ai.request.model': data.model }),
          ...(data.usage?.input_tokens !== undefined && {
            'gen_ai.usage.input_tokens': data.usage.input_tokens,
          }),
          ...(data.usage?.output_tokens !== undefined && {
            'gen_ai.usage.output_tokens': data.usage.output_tokens,
          }),
          ...(recordInputs && data.input
            ? serializedAttribute('gen_ai.input.messages', data.input)
            : {}),
          ...(recordOutputs && data.output
            ? serializedAttribute('gen_ai.output.messages', data.output)
            : {}),
        },
      };
    case 'response':
      return {
        name: 'chat',
        operationName: 'chat',
        attributes: {
          ...(data.response_id && { 'gen_ai.response.id': data.response_id }),
          ...(recordInputs && data._input !== undefined
            ? typeof data._input === 'string'
              ? { 'gen_ai.input.messages': data._input }
              : serializedAttribute('gen_ai.input.messages', data._input)
            : {}),
          ...(recordOutputs && data._response !== undefined
            ? serializedAttribute('gen_ai.output.messages', data._response)
            : {}),
        },
      };
    case 'handoff':
      return {
        name: 'handoff',
        operationName: 'handoff',
        attributes: {
          ...(data.from_agent && { 'gen_ai.agent.name': data.from_agent }),
          ...(data.to_agent && {
            'openai.agents.handoff.to_agent': data.to_agent,
          }),
        },
      };
    case 'guardrail':
      return {
        name: `guardrail ${data.name}`,
        operationName: 'guardrail',
        attributes: {
          'openai.agents.guardrail.name': data.name,
          'openai.agents.guardrail.triggered': data.triggered,
        },
      };
    case 'custom':
      return {
        name: `custom ${data.name}`,
        operationName: 'custom',
        attributes: {
          'openai.agents.custom.name': data.name,
          ...(recordCustomData
            ? serializedAttribute('openai.agents.custom.data', data.data)
            : {}),
        },
      };
    case 'mcp_tools':
      return {
        name: 'list_tools',
        operationName: 'list_tools',
        attributes: {
          ...(data.server && { 'openai.agents.mcp.server': data.server }),
          ...(data.result && { 'openai.agents.mcp.tools': data.result }),
        },
      };
    case 'transcription':
      return {
        name: `transcribe ${data.model ?? 'model'}`,
        operationName: 'transcribe',
        attributes: {
          ...(data.model && { 'gen_ai.request.model': data.model }),
          'openai.agents.audio.input_format': data.input.format,
          ...(recordInputs && {
            'openai.agents.audio.input_data': data.input.data,
          }),
          ...(recordOutputs &&
            data.output !== undefined && {
              'openai.agents.transcription.output': data.output,
            }),
        },
      };
    case 'speech':
      return {
        name: `synthesize_speech ${data.model ?? 'model'}`,
        operationName: 'synthesize_speech',
        attributes: {
          ...(data.model && { 'gen_ai.request.model': data.model }),
          'openai.agents.audio.output_format': data.output.format,
          ...(recordInputs &&
            data.input !== undefined && {
              'openai.agents.speech.input': data.input,
            }),
          ...(recordOutputs && {
            'openai.agents.audio.output_data': data.output.data,
          }),
        },
      };
    case 'speech_group':
      return {
        name: 'speech_group',
        operationName: 'speech_group',
        attributes: {
          ...(recordInputs &&
            data.input !== undefined && {
              'openai.agents.speech.input': data.input,
            }),
        },
      };
  }
}

function attributesForSpan(
  span: Span<any>,
  descriptor: SpanDescriptor,
): Attributes {
  return {
    'openai.agents.trace.id': span.traceId,
    'openai.agents.span.id': span.spanId,
    'openai.agents.span.type': span.spanData.type,
    'gen_ai.operation.name': descriptor.operationName,
    ...descriptor.attributes,
  };
}

function shouldSuppressInstrumentation(
  spanData: SpanData,
  policy: OpenTelemetryTracingProcessorOptions['suppressInstrumentation'],
): boolean {
  if (typeof policy === 'function') return policy(spanData);
  if (typeof policy === 'boolean') return policy;
  return spanData.type === 'response' || spanData.type === 'generation';
}

/**
 * Mirrors Agents SDK traces to OpenTelemetry. Add it with `addTraceProcessor()`.
 *
 * The processor intentionally suppresses automatic instrumentation inside model spans
 * by default. This avoids duplicate HTTP/fetch spans while retaining instrumentation
 * inside tools; set `suppressInstrumentation: false` to retain every nested span.
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
    const descriptor = describeSpan(agentSpan.spanData, this.#options);
    const parent = agentSpan.parentId
      ? this.#spans.get(agentSpan.parentId)
      : this.#traces.get(agentSpan.traceId);
    const parentContext = parent
      ? trace.setSpan(ROOT_CONTEXT, parent)
      : context.active();
    this.#spans.set(
      agentSpan.spanId,
      this.#tracer.startSpan(
        descriptor.name,
        {
          kind: SpanKind.INTERNAL,
          attributes: attributesForSpan(agentSpan, descriptor),
          startTime: timestamp(agentSpan.startedAt),
        },
        parentContext,
      ),
    );
  }

  async onSpanEnd(agentSpan: Span<any>): Promise<void> {
    const otelSpan = this.#spans.get(agentSpan.spanId);
    if (!otelSpan) return;
    const descriptor = describeSpan(agentSpan.spanData, this.#options);
    otelSpan.updateName(descriptor.name);
    otelSpan.setAttributes(attributesForSpan(agentSpan, descriptor));
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
    if (
      shouldSuppressInstrumentation(
        agentSpan.spanData,
        this.#options.suppressInstrumentation,
      )
    ) {
      activeContext = suppressTracing(activeContext);
    }
    return context.with(activeContext, fn);
  }

  async shutdown(timeout?: number): Promise<void> {
    await this.#options.shutdown?.(timeout);
  }

  async forceFlush(): Promise<void> {
    await this.#options.forceFlush?.();
  }
}
