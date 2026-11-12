import type { SandboxClientOptions } from '../client';
import type { SandboxSessionState } from '../session';
import type { RemoteSnapshotStore, SnapshotSpec } from '../snapshot';
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
const remoteSnapshotAuthorities = new WeakMap<
  object,
  {
    id?: string;
    store?: RemoteSnapshotStore;
    snapshotSpec?: LocalSandboxSnapshotSpec | null;
  }
>();
const stateIdentities = new WeakMap<object, object>();
const deserializedStates = new WeakSet<object>();

export function getRemoteSnapshotIdAuthority(
  state: object,
): string | undefined {
  return remoteSnapshotAuthorities.get(state)?.id;
}

export function setRemoteSnapshotIdAuthority(
  state: object,
  id: string | undefined,
  store?: RemoteSnapshotStore,
): void {
  remoteSnapshotAuthorities.set(state, {
    ...remoteSnapshotAuthorities.get(state),
    id,
    store:
      id === undefined
        ? undefined
        : (store ?? remoteSnapshotAuthorities.get(state)?.store),
  });
}

export function getRemoteSnapshotStoreAuthority(
  state: object,
): RemoteSnapshotStore | undefined {
  return remoteSnapshotAuthorities.get(state)?.store;
}

export function getRemoteSnapshotPolicyAuthority(
  state: object,
): LocalSandboxSnapshotSpec | null | undefined {
  return remoteSnapshotAuthorities.get(state)?.snapshotSpec;
}

export function setRemoteSnapshotPolicyAuthority(
  state: object,
  spec: LocalSandboxSnapshotSpec | null | undefined,
): void {
  remoteSnapshotAuthorities.set(state, {
    ...remoteSnapshotAuthorities.get(state),
    snapshotSpec: spec ? { ...spec } : null,
  });
}

export function copyRemoteSnapshotAuthority(
  source: object,
  target: object,
): void {
  if (isDeserializedSandboxState(source)) deserializedStates.add(target);
  const authority = remoteSnapshotAuthorities.get(source);
  if (authority)
    remoteSnapshotAuthorities.set(target, {
      ...authority,
      snapshotSpec: authority.snapshotSpec
        ? { ...authority.snapshotSpec }
        : authority.snapshotSpec,
    });
  else remoteSnapshotAuthorities.delete(target);
}

/** Runtime provenance only; parsing never grants workspace authority. */
export function markDeserializedSandboxState<T extends object>(state: T): T {
  deserializedStates.add(state);
  return state;
}

export function isDeserializedSandboxState(state: object): boolean {
  return (
    deserializedStates.has(state) ||
    deserializedStates.has(getSandboxStateIdentity(state))
  );
}

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
