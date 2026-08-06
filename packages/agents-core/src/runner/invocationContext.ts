import type { Span } from '../tracing/spans';

const runnerInvocationSpanParents = new WeakMap<object, Span<any>>();
const runStateTurnSpanParents = new WeakMap<object, Span<any>>();

export function setRunnerInvocationSpanParent(
  runner: object,
  parent: Span<any> | undefined,
): void {
  if (parent) {
    runnerInvocationSpanParents.set(runner, parent);
  } else {
    runnerInvocationSpanParents.delete(runner);
  }
}

export function getRunnerInvocationSpanParent(
  runner: object,
): Span<any> | undefined {
  return runnerInvocationSpanParents.get(runner);
}

export function setRunStateTurnSpanParent(
  state: object,
  parent: Span<any> | undefined,
): void {
  if (parent) {
    runStateTurnSpanParents.set(state, parent);
  } else {
    runStateTurnSpanParents.delete(state);
  }
}

export function getRunStateTurnSpanParent(
  state: object,
): Span<any> | undefined {
  return runStateTurnSpanParents.get(state);
}
