import type { SandboxSessionState } from '../session';

const runStateSessionStates = new WeakSet<object>();

export function markRunStateSessionState<TState extends SandboxSessionState>(
  state: TState,
): TState {
  runStateSessionStates.add(state);
  return state;
}

export function isRunStateSessionState(state: SandboxSessionState): boolean {
  return runStateSessionStates.has(state);
}
