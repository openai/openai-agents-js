import { Agent } from '../agent';
import { Handoff } from '../handoff';
import { ModelTracing } from '../model';
import { Tool } from '../tool';
import { setCurrentSpan } from '../tracing/context';
import { createAgentSpan } from '../tracing';
import { getGlobalTraceProvider } from '../tracing/provider';
import { Span } from '../tracing/spans';
import { Trace } from '../tracing/traces';

export type TraceOverrideConfig = {
  traceId?: string;
  workflowName?: string;
  groupId?: string;
  traceMetadata?: Record<string, any>;
  tracingApiKey?: string;
};

type EnsureAgentSpanParams<TContext> = {
  agent: Agent<TContext, any>;
  handoffs: Handoff<any, any>[];
  tools: Tool<TContext>[];
  currentSpan?: ReturnType<typeof createAgentSpan>;
};

/**
 * Normalizes tracing configuration into the format expected by model providers.
 * Returns `false` to disable tracing, `true` to include full payload data, or
 * `'enabled_without_data'` to omit sensitive content while still emitting spans.
 */
export function getTracing(
  tracingDisabled: boolean,
  traceIncludeSensitiveData: boolean,
): ModelTracing {
  if (tracingDisabled) {
    return false;
  }

  if (traceIncludeSensitiveData) {
    return true;
  }

  return 'enabled_without_data';
}

function rebaseSpanChain(span: Span<any>, trace: Trace): Span<any> {
  const previousSpan = span.previousSpan
    ? rebaseSpanChain(span.previousSpan, trace)
    : undefined;
  const parent = previousSpan ?? trace;

  const rebasedSpan = getGlobalTraceProvider().createSpan(
    {
      spanId: span.spanId,
      parentId: span.parentId ?? undefined,
      startedAt: span.startedAt ?? undefined,
      endedAt: span.endedAt ?? undefined,
      data: span.spanData as any,
      error: span.error ?? undefined,
      tracingApiKey: span.tracingApiKey,
    },
    parent,
  );
  rebasedSpan.previousSpan = previousSpan;
  return rebasedSpan;
}

export function applyTraceOverrides(
  trace: Trace,
  currentSpan: Span<any> | undefined,
  overrides: TraceOverrideConfig,
): { trace: Trace; currentSpan: Span<any> | undefined } {
  const traceIdOverride =
    overrides.traceId !== undefined && overrides.traceId !== trace.traceId;
  const tracingApiKeyOverride =
    overrides.tracingApiKey !== undefined &&
    overrides.tracingApiKey !== trace.tracingApiKey;

  if (overrides.traceId !== undefined) {
    trace.traceId = overrides.traceId;
  }
  if (overrides.workflowName !== undefined) {
    trace.name = overrides.workflowName;
  }
  if (overrides.groupId !== undefined) {
    trace.groupId = overrides.groupId ?? null;
  }
  if (overrides.traceMetadata !== undefined) {
    trace.metadata = overrides.traceMetadata;
  }
  if (overrides.tracingApiKey !== undefined) {
    trace.tracingApiKey = overrides.tracingApiKey;
  }

  if (currentSpan && (traceIdOverride || tracingApiKeyOverride)) {
    return { trace, currentSpan: rebaseSpanChain(currentSpan, trace) };
  }

  return { trace, currentSpan };
}

/**
 * Ensures an agent span exists and updates tool metadata if already present.
 * Returns the span so callers can pass it through run state.
 */
export function ensureAgentSpan<TContext>(
  params: EnsureAgentSpanParams<TContext>,
) {
  const { agent, handoffs, tools, currentSpan } = params;
  const existingSpan = currentSpan;
  if (existingSpan) {
    existingSpan.spanData.tools = tools.map((t) => t.name);
    return existingSpan;
  }

  const handoffNames = handoffs.map((h) => h.agentName);
  const span = createAgentSpan({
    data: {
      name: agent.name,
      handoffs: handoffNames,
      tools: tools.map((t) => t.name),
      output_type: agent.outputSchemaName,
    },
  });
  span.start();
  setCurrentSpan(span);
  return span;
}
