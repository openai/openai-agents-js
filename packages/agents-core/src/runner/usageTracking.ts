import { Usage } from '../usage';

export type UsageRecorder = (usage: Usage) => void;

const TOOL_USAGE_RECORDER_SYMBOL = Symbol.for(
  'openai.agents.core.toolUsageRecorder',
);
const runnerParentUsageRecorders = new WeakMap<object, UsageRecorder>();
const runStateUsageRecorders = new WeakMap<object, UsageRecorder>();
const modelFailureUsageRecorders = new WeakMap<object, UsageRecorder>();

const modelFailureUsageByError = new WeakMap<object, Usage>();

function cloneUsage(usage: Usage): Usage {
  return new Usage({
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: usage.inputTokensDetails.map((details) => ({
      ...details,
    })),
    outputTokensDetails: usage.outputTokensDetails.map((details) => ({
      ...details,
    })),
    requestUsageEntries: usage.requestUsageEntries?.map((entry) => ({
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      inputTokensDetails: { ...entry.inputTokensDetails },
      outputTokensDetails: { ...entry.outputTokensDetails },
      endpoint: entry.endpoint,
    })),
  });
}

export function setRunnerParentUsageRecorder(
  runner: object,
  recorder: UsageRecorder | undefined,
): void {
  if (recorder) {
    runnerParentUsageRecorders.set(runner, recorder);
  } else {
    runnerParentUsageRecorders.delete(runner);
  }
}

export function getRunnerParentUsageRecorder(
  runner: object,
): UsageRecorder | undefined {
  return runnerParentUsageRecorders.get(runner);
}

export function setRunStateUsageRecorder(
  state: object,
  recorder: UsageRecorder,
): void {
  runStateUsageRecorders.set(state, recorder);
}

export function getRunStateUsageRecorder(
  state: object,
): UsageRecorder | undefined {
  return runStateUsageRecorders.get(state);
}

export function setToolUsageRecorder(
  details: object,
  recorder: UsageRecorder | undefined,
): void {
  if (!recorder) {
    return;
  }
  Object.defineProperty(details, TOOL_USAGE_RECORDER_SYMBOL, {
    value: recorder,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

export function getToolUsageRecorder(
  details: unknown,
): UsageRecorder | undefined {
  if (!details || typeof details !== 'object') {
    return undefined;
  }
  return (details as Record<PropertyKey, unknown>)[
    TOOL_USAGE_RECORDER_SYMBOL
  ] as UsageRecorder | undefined;
}

export function recordToolUsage(details: unknown, usage: Usage): void {
  getToolUsageRecorder(details)?.(usage);
}

export function createModelFailureUsageScope<T extends { _internal?: object }>(
  request: T,
  recorder: UsageRecorder,
): { request: T; close: () => void } {
  const internal = { ...request._internal };
  modelFailureUsageRecorders.set(internal, recorder);
  return {
    request: { ...request, _internal: internal },
    close: () => modelFailureUsageRecorders.delete(internal),
  };
}

export function reportModelFailureUsage(
  request: object,
  error: unknown,
  usage: Usage,
): void {
  const internal = (request as { _internal?: object })._internal;
  const recorder = internal && modelFailureUsageRecorders.get(internal);
  if (recorder) {
    recorder(cloneUsage(usage));
  } else {
    attachModelFailureUsage(error, usage);
  }
}

export function attachModelFailureUsage(error: unknown, usage: Usage): void {
  if (!error || typeof error !== 'object') {
    return;
  }

  const existing = modelFailureUsageByError.get(error);
  const combinedUsage = cloneUsage(usage);
  if (existing) {
    combinedUsage.add(existing);
  }
  modelFailureUsageByError.set(error, combinedUsage);
}

export function consumeModelFailureUsage(error: unknown): Usage | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const usage = modelFailureUsageByError.get(error);
  if (!usage) {
    return undefined;
  }
  modelFailureUsageByError.delete(error);
  return cloneUsage(usage);
}
