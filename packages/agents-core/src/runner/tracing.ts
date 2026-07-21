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
  parent?: Span<any> | Trace;
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
    ownedUsage: UsageSnapshot;
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
    cachedInputTokens:
      sumUsageDetail(usage, 'cached_tokens') +
      sumUsageDetail(usage, 'cached_input_tokens'),
    cacheWriteInputTokens: sumUsageDetail(usage, 'cache_write_tokens'),
  };
}

function emptyUsageSnapshot(): UsageSnapshot {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}

function addUsageSnapshot(target: UsageSnapshot, increment: Usage): void {
  const added = snapshotUsage(increment);
  target.requests += added.requests;
  target.inputTokens += added.inputTokens;
  target.outputTokens += added.outputTokens;
  target.totalTokens += added.totalTokens;
  target.cachedInputTokens += added.cachedInputTokens;
  target.cacheWriteInputTokens += added.cacheWriteInputTokens;
}

function trackRunnerSpanUsage<TSpanData extends TaskSpanData | TurnSpanData>(
  span: Span<TSpanData>,
): RunnerSpanLifecycle<TSpanData> {
  return { span, ownedUsage: emptyUsageSnapshot() };
}

export function recordRunnerSpanUsage(
  lifecycle: RunnerSpanLifecycle<TaskSpanData | TurnSpanData> | undefined,
  increment: Usage,
): void {
  if (lifecycle) {
    addUsageSnapshot(lifecycle.ownedUsage, increment);
  }
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
  parent?: Span<any> | Trace,
): RunnerSpanLifecycle<TaskSpanData> {
  const span = createTaskSpan({ data: { name } }, parent);
  span.start();
  setCurrentSpan(span);
  return trackRunnerSpanUsage(span);
}

function startAgentSpanForInterruptedResume<TContext>(
  agent: Agent<TContext, any>,
  restoredSpan?: ReturnType<typeof createAgentSpan>,
  parent?: Span<any> | Trace,
): ReturnType<typeof createAgentSpan> {
  const span = createAgentSpan(
    {
      data: {
        name: agent.name,
        handoffs: [...(restoredSpan?.spanData.handoffs ?? [])],
        tools: [...(restoredSpan?.spanData.tools ?? [])],
        output_type:
          restoredSpan?.spanData.output_type ?? agent.outputSchemaName,
      },
    },
    parent,
  );
  span.start();
  setCurrentSpan(span);
  return span;
}

export function ensureActiveAgentSpanForInterruptedResume<TContext>(options: {
  agent: Agent<TContext, any>;
  restoredAgentSpan?: ReturnType<typeof createAgentSpan>;
  parent?: Span<any> | Trace;
}): ReturnType<typeof createAgentSpan> {
  if (options.restoredAgentSpan?.endedAt === null) {
    setCurrentSpan(options.restoredAgentSpan);
    return options.restoredAgentSpan;
  }
  return startAgentSpanForInterruptedResume(
    options.agent,
    options.restoredAgentSpan,
    options.parent,
  );
}

export function startRunnerInvocationSpans<TContext>(options: {
  name: string;
  agent: Agent<TContext, any>;
  restoredAgentSpan?: ReturnType<typeof createAgentSpan>;
  resumeInterruptedTurn: boolean;
  parent?: Span<any> | Trace;
}): {
  taskSpan: RunnerSpanLifecycle<TaskSpanData>;
  agentSpan?: ReturnType<typeof createAgentSpan>;
} {
  options.restoredAgentSpan?.end();
  const taskSpan = startTaskSpan(options.name, options.parent);
  const agentSpan = options.resumeInterruptedTurn
    ? startAgentSpanForInterruptedResume(
        options.agent,
        options.restoredAgentSpan,
        taskSpan.span,
      )
    : undefined;
  return { taskSpan, agentSpan };
}

export function startTurnSpan(
  turn: number,
  agentName: string,
  parent?: Span<any> | Trace,
): RunnerSpanLifecycle<TurnSpanData> {
  const span = createTurnSpan(
    { data: { turn, agent_name: agentName } },
    parent,
  );
  span.start();
  setCurrentSpan(span);
  return trackRunnerSpanUsage(span);
}

export function ensureTurnSpan(
  current: RunnerSpanLifecycle<TurnSpanData> | undefined,
  turn: number,
  agentName: string,
  parent?: Span<any> | Trace,
): RunnerSpanLifecycle<TurnSpanData> {
  return current ?? startTurnSpan(turn, agentName, parent);
}

export function finishRunnerSpan(
  lifecycle: RunnerSpanLifecycle<TaskSpanData | TurnSpanData> | undefined,
): void {
  if (!lifecycle) {
    return;
  }
  if (hasUsage(lifecycle.ownedUsage)) {
    if (lifecycle.span.spanData.type === 'task') {
      const taskUsage: TaskUsageData = {
        ...toTurnUsageData(lifecycle.ownedUsage),
        requests: lifecycle.ownedUsage.requests,
        total_tokens: lifecycle.ownedUsage.totalTokens,
      };
      lifecycle.span.spanData.usage = taskUsage;
    } else {
      lifecycle.span.spanData.usage = toTurnUsageData(lifecycle.ownedUsage);
    }
  }
  lifecycle.span.end();
  resetCurrentSpan();
}

export function setRunnerSpanError(
  lifecycle: RunnerSpanLifecycle<TaskSpanData | TurnSpanData> | undefined,
  error: unknown,
): void {
  lifecycle?.span.setError({
    message: 'Error in agent run',
    data: { error: String(error) },
  });
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
  const { agent, handoffs, tools, currentSpan, parent } = params;
  const existingSpan = currentSpan;
  if (existingSpan) {
    existingSpan.spanData.handoffs = handoffs.map((h) => h.agentName);
    existingSpan.spanData.tools = tools.map((t) => t.name);
    return existingSpan;
  }

  const handoffNames = handoffs.map((h) => h.agentName);
  const span = createAgentSpan(
    {
      data: {
        name: agent.name,
        handoffs: handoffNames,
        tools: tools.map((t) => t.name),
        output_type: agent.outputSchemaName,
      },
    },
    parent,
  );
  span.start();
  setCurrentSpan(span);
  return span;
}
