import type { SandboxClientOptions } from '../client';
import type { SandboxSessionState } from '../session';
import type { SnapshotSpec } from '../snapshot';
import type { LocalSandboxSnapshotSpec } from '../sandboxes/types';

export type LocalSandboxStateAuthority = {
  workspaceRootPath: string;
  workspaceRootOwned: boolean;
  localSnapshotPath?: string;
  snapshotSpec: LocalSandboxSnapshotSpec | null;
  /** Generation at the trusted rebind; never renewed by another copy. */
  generation?: number;
};

// Parsing saved state, including RunState, never establishes local authority.
const localStateAuthorities = new WeakMap<object, LocalSandboxStateAuthority>();
const stateIdentities = new WeakMap<object, object>();

export function getSandboxStateIdentity(state: object): object {
  return stateIdentities.get(state) ?? state;
}

export function getLocalSandboxStateAuthority(
  state: object,
): LocalSandboxStateAuthority | undefined {
  return localStateAuthorities.get(state);
}

export function setLocalSandboxStateAuthority(
  state: object,
  authority: LocalSandboxStateAuthority,
): void {
  localStateAuthorities.set(state, authority);
}

/** Called only after the rebind owner validates source lifecycle state. */
export function copyLocalSandboxStateAuthority(
  source: object,
  target: object,
  generation: number,
): void {
  const authority = localStateAuthorities.get(source);
  if (!authority) return;
  // Flatten aliases so repeated rebinding never builds a source chain.
  stateIdentities.set(target, getSandboxStateIdentity(source));
  localStateAuthorities.set(target, { ...authority, generation });
}

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

export function isRunStateSessionState(state: SandboxSessionState): boolean {
  return runStateSessionTrust.has(state);
}

export function getRunStateSessionTrustedConfig(
  state: SandboxSessionState,
): RunStateSessionTrustedConfig | undefined {
  return runStateSessionTrust.get(state);
}
