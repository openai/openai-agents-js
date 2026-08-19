import type {
  Manifest,
  SandboxSessionState,
} from '@openai/agents-core/sandbox';
import {
  assertProcessEnvValuesUnsupported,
  assertMountCredentialsRebound,
  assertSandboxStateGenerationUnchanged,
  assertSandboxSessionStateUsable,
  captureSandboxStateGeneration,
  assertHostPathGrantsRebound,
  deserializeHostPathGrantRedactionMetadata,
  deserializeMountCredentialRedactionMetadata,
  serializeHostPathGrantRedactionMetadata,
  serializeMountCredentialRedactionMetadata,
  validateMountCredentialBoundaries,
  validateMountEnvironmentCredentialBoundaries,
  isSandboxSessionStateUnsafe,
  markSandboxSessionStateUnsafe,
  sanitizeMountCredentialEnvironmentForPersistence,
} from '@openai/agents-core/sandbox/internal';
import {
  deserializePersistedEnvironmentForRuntime,
  rehydratePersistedEnvironmentForRuntime,
  serializeRuntimeEnvironmentForPersistence,
} from './environment';
import { deserializeManifest, serializeManifestRecord } from './manifest';
import { sanitizeRcloneMountEnvironmentForPersistence } from './inContainerMounts';

export type RemoteSandboxSessionStateValues = SandboxSessionState & {
  environment: Record<string, string>;
};

export function markRemoteSandboxSessionStateUnsafe(
  state: RemoteSandboxSessionStateValues,
): void {
  markSandboxSessionStateUnsafe(state);
}

export function isRemoteSandboxSessionStateUnsafe(
  state: RemoteSandboxSessionStateValues,
): boolean {
  return isSandboxSessionStateUnsafe(state);
}

export function assertRemoteSandboxSessionStateUsable(
  state: RemoteSandboxSessionStateValues,
): void {
  assertSandboxSessionStateUsable(state);
}

export function serializeRemoteSandboxSessionState<
  TState extends RemoteSandboxSessionStateValues,
>(state: TState, mutationState: object = state): Record<string, unknown> {
  assertProcessEnvValuesUnsupported(state.manifest, 'remote sandbox providers');
  const stateGeneration = captureSandboxStateGeneration(mutationState);
  assertRemoteSandboxSessionStateUsable(state);
  validateMountEnvironmentCredentialBoundaries(
    state.manifest,
    state.environment,
  );
  const persistent = sanitizeRcloneMountEnvironmentForPersistence(state);
  const serialized = {
    ...persistent,
    ...serializeHostPathGrantRedactionMetadata(state),
    ...serializeMountCredentialRedactionMetadata(state),
    environment: serializeRemoteRuntimeEnvironmentForPersistence(
      persistent.manifest,
      persistent.environment,
    ),
    manifest: serializeManifestRecord(persistent.manifest),
  };
  assertSandboxStateGenerationUnchanged(mutationState, stateGeneration);
  return serialized;
}

export function deserializeRemoteSandboxSessionStateValues(
  state: Record<string, unknown>,
  configuredEnvironment?: Record<string, string>,
): RemoteSandboxSessionStateValues {
  const manifest = deserializeManifest(
    state.manifest as Record<string, unknown> | undefined,
  );
  assertProcessEnvValuesUnsupported(manifest, 'remote sandbox providers');
  return {
    manifest,
    environment: deserializeRemotePersistedEnvironmentForRuntime(
      manifest,
      state.environment as Record<string, string> | undefined,
      configuredEnvironment,
    ),
    ...deserializeHostPathGrantRedactionMetadata(state),
    ...deserializeMountCredentialRedactionMetadata(state),
  };
}

export async function rehydrateRemoteSandboxSessionStateValues(
  state: Record<string, unknown>,
  configuredEnvironment?: Record<string, string>,
  prepareManifest: (manifest: Manifest) => Manifest = (manifest) => manifest,
): Promise<RemoteSandboxSessionStateValues> {
  const persistedManifest = deserializeManifest(
    state.manifest as Record<string, unknown> | undefined,
  );
  assertProcessEnvValuesUnsupported(
    persistedManifest,
    'remote sandbox providers',
  );
  const manifest = prepareManifest(persistedManifest);
  assertProcessEnvValuesUnsupported(manifest, 'remote sandbox providers');
  return {
    manifest,
    environment: await rehydrateRemotePersistedEnvironmentForRuntime(
      manifest,
      state.environment as Record<string, string> | undefined,
      configuredEnvironment,
    ),
    ...deserializeHostPathGrantRedactionMetadata(state),
    ...deserializeMountCredentialRedactionMetadata(state),
  };
}

export function assertRemoteSandboxSessionStateCanResume(
  state: SandboxSessionState,
): void {
  assertMountCredentialsRebound(state);
  validateMountCredentialBoundaries(state.manifest);
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
  const sanitizedEnvironment = sanitizeMountCredentialEnvironmentForPersistence(
    {
      manifest,
      environment,
    },
  ).environment;
  const runtimeEnvironment = Object.fromEntries(
    Object.entries(sanitizedEnvironment).filter(
      ([key, value]) =>
        !(key in manifest.environment) && typeof value === 'string',
    ),
  );

  return {
    ...runtimeEnvironment,
    ...deserializePersistedEnvironmentForRuntime(
      manifest,
      sanitizedEnvironment,
      configuredEnvironment,
    ),
  };
}

async function rehydrateRemotePersistedEnvironmentForRuntime(
  manifest: Manifest,
  environment: Record<string, string> | undefined,
  configuredEnvironment: Record<string, string> = {},
): Promise<Record<string, string>> {
  const sanitizedEnvironment = sanitizeMountCredentialEnvironmentForPersistence(
    {
      manifest,
      environment,
    },
  ).environment;
  const runtimeEnvironment = Object.fromEntries(
    Object.entries(sanitizedEnvironment).filter(
      ([key, value]) =>
        !(key in manifest.environment) && typeof value === 'string',
    ),
  );

  return {
    ...runtimeEnvironment,
    ...(await rehydratePersistedEnvironmentForRuntime(
      manifest,
      sanitizedEnvironment,
      configuredEnvironment,
    )),
  };
}
