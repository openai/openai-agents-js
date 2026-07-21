import {
  context,
  diag,
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

function serializedValue(value: unknown): string | undefined {
  try {
    const sanitized = sanitizeJsonCompatibleValue(value);
    return sanitized === undefined ? undefined : JSON.stringify(sanitized);
  } catch {
    return undefined;
  }
}

function compactAttributes(
  values: Record<string, Attributes[string] | undefined>,
): Attributes {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Attributes;
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
    case 'task':
      return {
        name: `task ${data.name}`,
        operationName: 'task',
        attributes: compactAttributes({
          'openai.agents.task.name': data.name,
          'openai.agents.task.requests': data.usage?.requests,
          'gen_ai.usage.input_tokens': data.usage?.input_tokens,
          'gen_ai.usage.output_tokens': data.usage?.output_tokens,
          'openai.agents.usage.cached_input_tokens':
            data.usage?.cached_input_tokens,
          'openai.agents.usage.cache_write_input_tokens':
            data.usage?.cache_write_input_tokens,
          'openai.agents.usage.total_tokens': data.usage?.total_tokens,
        }),
      };
    case 'turn':
      return {
        name: `turn ${data.turn}`,
        operationName: 'turn',
        attributes: compactAttributes({
          'openai.agents.turn.number': data.turn,
          'gen_ai.agent.name': data.agent_name,
          'gen_ai.usage.input_tokens': data.usage?.input_tokens,
          'gen_ai.usage.output_tokens': data.usage?.output_tokens,
          'openai.agents.usage.cached_input_tokens':
            data.usage?.cached_input_tokens,
          'openai.agents.usage.cache_write_input_tokens':
            data.usage?.cache_write_input_tokens,
        }),
      };
    case 'agent':
      return {
        name: `invoke_agent ${data.name}`,
        operationName: 'invoke_agent',
        attributes: compactAttributes({
          'gen_ai.agent.name': data.name,
          'openai.agents.agent.handoffs': data.handoffs,
          'openai.agents.agent.tools': data.tools,
          'openai.agents.agent.output_type': data.output_type || undefined,
        }),
      };
    case 'function':
      return {
        name: `execute_tool ${data.name}`,
        operationName: 'execute_tool',
        attributes: compactAttributes({
          'gen_ai.tool.name': data.name,
          'gen_ai.tool.call.arguments': recordInputs ? data.input : undefined,
          'gen_ai.tool.call.result': recordOutputs ? data.output : undefined,
        }),
      };
    case 'generation':
      return {
        name: `chat ${data.model ?? 'model'}`,
        operationName: 'chat',
        attributes: compactAttributes({
          'gen_ai.request.model': data.model || undefined,
          'gen_ai.usage.input_tokens': data.usage?.input_tokens,
          'gen_ai.usage.output_tokens': data.usage?.output_tokens,
          'gen_ai.input.messages':
            recordInputs && data.input
              ? serializedValue(data.input)
              : undefined,
          'gen_ai.output.messages':
            recordOutputs && data.output
              ? serializedValue(data.output)
              : undefined,
        }),
      };
    case 'response':
      return {
        name: 'chat',
        operationName: 'chat',
        attributes: compactAttributes({
          'gen_ai.response.id': data.response_id || undefined,
          'gen_ai.input.messages':
            recordInputs && data._input !== undefined
              ? typeof data._input === 'string'
                ? data._input
                : serializedValue(data._input)
              : undefined,
          'gen_ai.output.messages':
            recordOutputs && data._response !== undefined
              ? serializedValue(data._response)
              : undefined,
        }),
      };
    case 'handoff':
      return {
        name: 'handoff',
        operationName: 'handoff',
        attributes: compactAttributes({
          'gen_ai.agent.name': data.from_agent || undefined,
          'openai.agents.handoff.to_agent': data.to_agent || undefined,
        }),
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
        attributes: compactAttributes({
          'openai.agents.custom.name': data.name,
          'openai.agents.custom.data': recordCustomData
            ? serializedValue(data.data)
            : undefined,
        }),
      };
    case 'mcp_tools':
      return {
        name: 'list_tools',
        operationName: 'list_tools',
        attributes: compactAttributes({
          'openai.agents.mcp.server': data.server || undefined,
          'openai.agents.mcp.tools': data.result,
        }),
      };
    case 'transcription':
      return {
        name: `transcribe ${data.model ?? 'model'}`,
        operationName: 'transcribe',
        attributes: compactAttributes({
          'gen_ai.request.model': data.model || undefined,
          'openai.agents.audio.input_format': data.input.format,
          'openai.agents.audio.input_data': recordInputs
            ? data.input.data
            : undefined,
          'openai.agents.transcription.output': recordOutputs
            ? data.output
            : undefined,
        }),
      };
    case 'speech':
      return {
        name: `synthesize_speech ${data.model ?? 'model'}`,
        operationName: 'synthesize_speech',
        attributes: compactAttributes({
          'gen_ai.request.model': data.model || undefined,
          'openai.agents.audio.output_format': data.output.format,
          'openai.agents.speech.input': recordInputs ? data.input : undefined,
          'openai.agents.audio.output_data': recordOutputs
            ? data.output.data
            : undefined,
        }),
      };
    case 'speech_group':
      return {
        name: 'speech_group',
        operationName: 'speech_group',
        attributes: compactAttributes({
          'openai.agents.speech.input': recordInputs ? data.input : undefined,
        }),
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
  if (typeof policy === 'function') {
    try {
      return policy(spanData);
    } catch (error) {
      diag.error('OpenTelemetry suppression policy failed', error);
      return false;
    }
  }
  if (typeof policy === 'boolean') return policy;
  return spanData.type === 'response' || spanData.type === 'generation';
}

type OpenTelemetrySpanState = {
  agentSpan: Span<any>;
  otelSpan: OtelSpan;
  suppressInstrumentation: boolean;
};

type OpenTelemetryTraceState = {
  root: OtelSpan;
  spans: Map<string, OpenTelemetrySpanState>;
};

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
  readonly #traces = new Map<string, OpenTelemetryTraceState>();

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
    this.#traces.set(agentTrace.traceId, {
      root: this.#tracer.startSpan(agentTrace.name, {
        kind: SpanKind.INTERNAL,
        attributes,
      }),
      spans: new Map(),
    });
  }

  async onTraceEnd(agentTrace: Trace): Promise<void> {
    const traceState = this.#traces.get(agentTrace.traceId);
    if (!traceState) return;
    for (const spanState of [...traceState.spans.values()]) {
      this.#finishSpan(traceState, spanState.agentSpan);
    }
    traceState.root.end();
    this.#traces.delete(agentTrace.traceId);
  }

  async onSpanStart(agentSpan: Span<any>): Promise<void> {
    this.#ensureSpan(agentSpan);
  }

  #ensureSpan(agentSpan: Span<any>): OpenTelemetrySpanState | undefined {
    const traceState = this.#traces.get(agentSpan.traceId);
    if (!traceState) return undefined;
    const existing = traceState.spans.get(agentSpan.spanId);
    if (existing) return existing;

    const descriptor = describeSpan(agentSpan.spanData, this.#options);
    const parent = agentSpan.parentId
      ? (traceState.spans.get(agentSpan.parentId)?.otelSpan ?? traceState.root)
      : traceState.root;
    const spanState: OpenTelemetrySpanState = {
      agentSpan,
      otelSpan: this.#tracer.startSpan(
        descriptor.name,
        {
          kind: SpanKind.INTERNAL,
          attributes: attributesForSpan(agentSpan, descriptor),
          startTime: timestamp(agentSpan.startedAt),
        },
        trace.setSpan(ROOT_CONTEXT, parent),
      ),
      suppressInstrumentation: shouldSuppressInstrumentation(
        agentSpan.spanData,
        this.#options.suppressInstrumentation,
      ),
    };
    traceState.spans.set(agentSpan.spanId, spanState);
    return spanState;
  }

  async onSpanEnd(agentSpan: Span<any>): Promise<void> {
    const traceState = this.#traces.get(agentSpan.traceId);
    if (traceState) this.#finishSpan(traceState, agentSpan);
  }

  #finishSpan(traceState: OpenTelemetryTraceState, agentSpan: Span<any>): void {
    const spanState = traceState.spans.get(agentSpan.spanId);
    if (!spanState) return;
    const descriptor = describeSpan(agentSpan.spanData, this.#options);
    spanState.otelSpan.updateName(descriptor.name);
    spanState.otelSpan.setAttributes(attributesForSpan(agentSpan, descriptor));
    if (agentSpan.error) {
      spanState.otelSpan.recordException(agentSpan.error.message);
      spanState.otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: agentSpan.error.message,
      });
    }
    spanState.otelSpan.end(timestamp(agentSpan.endedAt));
    traceState.spans.delete(agentSpan.spanId);
  }

  async withSpan<T>(agentSpan: Span<any>, fn: () => Promise<T>): Promise<T> {
    let activeContext: Context;
    try {
      const spanState = this.#ensureSpan(agentSpan);
      if (!spanState) return fn();
      activeContext = trace.setSpan(context.active(), spanState.otelSpan);
      if (spanState.suppressInstrumentation) {
        activeContext = suppressTracing(activeContext);
      }
    } catch (error) {
      diag.error('OpenTelemetry span context setup failed', error);
      return fn();
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
