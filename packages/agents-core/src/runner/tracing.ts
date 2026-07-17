import { Agent } from '../agent';
import { Handoff } from '../handoff';
import { ModelTracing } from '../model';
import { Tool } from '../tool';
import { resetCurrentSpan, setCurrentSpan } from '../tracing/context';
import { createAgentSpan, createTaskSpan, createTurnSpan } from '../tracing';
import { getGlobalTraceProvider } from '../tracing/provider';
import {
  Span,
  type TaskSpanData,
  type TaskUsageData,
  type TurnSpanData,
  type TurnUsageData,
} from '../tracing/spans';
import { Trace } from '../tracing/traces';
import type { Usage } from '../usage';

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

type UsageSnapshot = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
};

export type RunnerSpanLifecycle<TSpanData extends TaskSpanData | TurnSpanData> =
  {
    span: Span<TSpanData>;
    usageStart: UsageSnapshot;
  };

function sumUsageDetail(usage: Usage, key: string): number {
  return usage.inputTokensDetails.reduce(
    (total, details) => total + (details[key] ?? 0),
    0,
  );
}

function snapshotUsage(usage: Usage): UsageSnapshot {
  return {
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: sumUsageDetail(usage, 'cached_tokens'),
    cacheWriteInputTokens: sumUsageDetail(usage, 'cache_write_tokens'),
  };
}

function usageDelta(start: UsageSnapshot, end: Usage): UsageSnapshot {
  const current = snapshotUsage(end);
  return {
    requests: current.requests - start.requests,
    inputTokens: current.inputTokens - start.inputTokens,
    outputTokens: current.outputTokens - start.outputTokens,
    totalTokens: current.totalTokens - start.totalTokens,
    cachedInputTokens: current.cachedInputTokens - start.cachedInputTokens,
    cacheWriteInputTokens:
      current.cacheWriteInputTokens - start.cacheWriteInputTokens,
  };
}

function hasUsage(usage: UsageSnapshot): boolean {
  return Object.values(usage).some((value) => value !== 0);
}

function toTurnUsageData(usage: UsageSnapshot): TurnUsageData {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
  };
}

export function startTaskSpan(
  name: string,
  usage: Usage,
): RunnerSpanLifecycle<TaskSpanData> {
  const span = createTaskSpan({ data: { name } });
  span.start();
  setCurrentSpan(span);
  return { span, usageStart: snapshotUsage(usage) };
}

export function startTurnSpan(
  turn: number,
  agentName: string,
  usage: Usage,
): RunnerSpanLifecycle<TurnSpanData> {
  const span = createTurnSpan({ data: { turn, agent_name: agentName } });
  span.start();
  setCurrentSpan(span);
  return { span, usageStart: snapshotUsage(usage) };
}

export function finishRunnerSpan(
  lifecycle: RunnerSpanLifecycle<TaskSpanData | TurnSpanData> | undefined,
  usage: Usage,
): void {
  if (!lifecycle) {
    return;
  }
  const delta = usageDelta(lifecycle.usageStart, usage);
  if (hasUsage(delta)) {
    if (lifecycle.span.spanData.type === 'task') {
      const taskUsage: TaskUsageData = {
        ...toTurnUsageData(delta),
        requests: delta.requests,
        total_tokens: delta.totalTokens,
      };
      lifecycle.span.spanData.usage = taskUsage;
    } else {
      lifecycle.span.spanData.usage = toTurnUsageData(delta);
    }
  }
  lifecycle.span.end();
  resetCurrentSpan();
}

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
  const traceMetadataOverride =
    overrides.traceMetadata !== undefined &&
    overrides.traceMetadata !== trace.metadata;

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

  if (
    currentSpan &&
    (traceIdOverride || tracingApiKeyOverride || traceMetadataOverride)
  ) {
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
    existingSpan.spanData.handoffs = handoffs.map((h) => h.agentName);
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
