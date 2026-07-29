import type {
  Manifest,
  SandboxSessionState,
} from '@openai/agents-core/sandbox';
import {
  assertHostPathGrantsRebound,
  deserializeHostPathGrantRedactionMetadata,
  serializeHostPathGrantRedactionMetadata,
} from '@openai/agents-core/sandbox/internal';
import {
  deserializePersistedEnvironmentForRuntime,
  serializeRuntimeEnvironmentForPersistence,
} from './environment';
import { deserializeManifest, serializeManifestRecord } from './manifest';

export type RemoteSandboxSessionStateValues = SandboxSessionState & {
  environment: Record<string, string>;
};

export function serializeRemoteSandboxSessionState<
  TState extends RemoteSandboxSessionStateValues,
>(state: TState): Record<string, unknown> {
  return {
    ...state,
    ...serializeHostPathGrantRedactionMetadata(state),
    environment: serializeRemoteRuntimeEnvironmentForPersistence(
      state.manifest,
      state.environment,
    ),
    manifest: serializeManifestRecord(state.manifest),
  };
}

export function deserializeRemoteSandboxSessionStateValues(
  state: Record<string, unknown>,
  configuredEnvironment?: Record<string, string>,
): RemoteSandboxSessionStateValues {
  const manifest = deserializeManifest(
    state.manifest as Record<string, unknown> | undefined,
  );
  return {
    manifest,
    environment: deserializeRemotePersistedEnvironmentForRuntime(
      manifest,
      state.environment as Record<string, string> | undefined,
      configuredEnvironment,
    ),
    ...deserializeHostPathGrantRedactionMetadata(state),
  };
}

export function assertRemoteSandboxSessionStateCanResume(
  state: SandboxSessionState,
): void {
  assertHostPathGrantsRebound(state);
}

function serializeRemoteRuntimeEnvironmentForPersistence(
  manifest: Manifest,
  environment: Record<string, string>,
): Record<string, string> {
  const runtimeEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        !(key in manifest.environment) && typeof value === 'string',
    ),
  );

  return {
    ...runtimeEnvironment,
    ...serializeRuntimeEnvironmentForPersistence(manifest, environment),
  };
}

function deserializeRemotePersistedEnvironmentForRuntime(
  manifest: Manifest,
  environment: Record<string, string> | undefined,
  configuredEnvironment: Record<string, string> = {},
): Record<string, string> {
  const runtimeEnvironment = Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([key, value]) =>
        !(key in manifest.environment) && typeof value === 'string',
    ),
  );

  return {
    ...runtimeEnvironment,
    ...deserializePersistedEnvironmentForRuntime(
      manifest,
      environment,
      configuredEnvironment,
    ),
  };
}
