import type { Usage } from '../usage';

export type UsageRecorder = (usage: Usage) => void;

const TOOL_USAGE_RECORDER_SYMBOL = Symbol.for(
  'openai.agents.core.toolUsageRecorder',
);
const runnerParentUsageRecorders = new WeakMap<object, UsageRecorder>();
const runStateUsageRecorders = new WeakMap<object, UsageRecorder>();

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
