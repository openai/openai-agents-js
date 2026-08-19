import type { SandboxClientOptions } from '../client';
import type { SandboxSessionState } from '../session';
import type { SnapshotSpec } from '../snapshot';

export type RunStateSessionTrustedConfig = {
  clientOptions?: SandboxClientOptions;
  snapshot?: SnapshotSpec;
};

const runStateSessionTrust = new WeakMap<
  object,
  RunStateSessionTrustedConfig
>();

export function markRunStateSessionState<TState extends SandboxSessionState>(
  state: TState,
  trustedConfig: RunStateSessionTrustedConfig = {},
): TState {
  runStateSessionTrust.set(state, trustedConfig);
  return state;
}

export function markRunStateDeserializationInput<
  TState extends Record<string, unknown>,
>(state: TState, trustedConfig: RunStateSessionTrustedConfig = {}): TState {
  runStateSessionTrust.set(state, trustedConfig);
  return state;
}

export function isRunStateSessionState(state: object): boolean {
  return runStateSessionTrust.has(state);
}

export function getRunStateSessionTrustedConfig(
  state: object,
): RunStateSessionTrustedConfig | undefined {
  return runStateSessionTrust.get(state);
}
