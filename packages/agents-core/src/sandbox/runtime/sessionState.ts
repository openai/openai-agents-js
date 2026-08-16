import { UserError } from '../../errors';
import { SandboxMountError } from '../errors';
import type { RunState } from '../../runState';
import type { Agent, AgentOutputType } from '../../agent';
import type { SandboxClient, SandboxClientOptions } from '../client';
import {
  isEnvValueReference,
  isSerializedEnvValueReference,
  type Manifest,
  type ManifestEnvironment,
} from '../manifest';
import {
  SANDBOX_SESSION_STATE_VERSION,
  SUPPORTED_SANDBOX_SESSION_STATE_VERSIONS,
  type SandboxSessionState,
  type SandboxSessionStateEnvelope,
} from '../session';
import {
  assertMountCredentialsRebound,
  assertHostPathGrantsRebound,
  deserializeManifest,
  deserializeMountCredentialRedactionMetadata,
  deserializeHostPathGrantRedactionMetadata,
  rebindPersistedPathGrants,
  rebindPersistedMountCredentials,
  serializeHostPathGrantRedactionMetadata,
  serializeMountCredentialRedactionMetadata,
  serializeManifest,
  serializeManifestRecord,
} from '../sandboxes/shared/manifestPersistence';
import {
  manifestHasInContainerMounts,
  persistedManifestRecordHasNonResumableMountAuthority,
  NON_RESUMABLE_MOUNT_AUTHORITY_KEY,
  REDACTED_MOUNT_CREDENTIAL_PATHS_KEY,
  resolveAndValidateMountEnvironment,
  sanitizePersistedManifestRecord,
  sanitizeMountCredentialEnvironmentForPersistence,
  validateMountCredentialRedactionPaths,
  validateMountCredentialBoundaries,
  validateMountEnvironmentCredentialBoundaries,
} from '../mountSecurity';
import {
  markRunStateSessionState,
  type RunStateSessionTrustedConfig,
} from '../internal/sessionStateTrust';

export type SerializedSandboxSessionEntry = {
  backendId: string;
  currentAgentKey: string;
  currentAgentName: string;
  sessionState: SandboxSessionStateEnvelope;
  preservedOwnedSession?: boolean;
  reuseLiveSession?: boolean;
  requiresFreshCreation?: boolean;
};

export type SerializedSandboxState = {
  backendId: string;
  currentAgentKey: string;
  currentAgentName: string;
  sessionState: SandboxSessionStateEnvelope;
  sessionsByAgent: Record<string, SerializedSandboxSessionEntry>;
};

export function getSerializedSandboxState<TContext>(
  runState: RunState<TContext, Agent<TContext, AgentOutputType>> | undefined,
): SerializedSandboxState | undefined {
  return runState?._sandbox as SerializedSandboxState | undefined;
}

export function sanitizeSerializedSandboxState(
  state: SerializedSandboxState,
): SerializedSandboxState {
  const sessionsByAgent = Object.fromEntries(
    Object.entries(state.sessionsByAgent).map(([agentKey, entry]) => [
      agentKey,
      {
        ...entry,
        sessionState: sanitizeSerializedSessionEnvelope(entry.sessionState),
      },
    ]),
  );
  return {
    ...state,
    sessionState: sanitizeSerializedSessionEnvelope(state.sessionState),
    sessionsByAgent,
  };
}

function sanitizeSerializedSessionEnvelope(
  envelope: SandboxSessionStateEnvelope,
): SandboxSessionStateEnvelope {
  const hasNonResumableMountAuthority =
    persistedManifestRecordHasNonResumableMountAuthority(envelope.manifest);
  const existingMetadata = deserializeMountCredentialRedactionMetadata(
    envelope.providerState,
  );
  const existingPaths =
    (existingMetadata[REDACTED_MOUNT_CREDENTIAL_PATHS_KEY] as
      string[] | undefined) ?? [];
  const { record, credentialPaths } = sanitizePersistedManifestRecord(
    envelope.manifest,
  );
  const persistedManifest = deserializeManifest(record);
  const redactedPaths = [...new Set([...existingPaths, ...credentialPaths])];
  validateMountCredentialRedactionPaths(persistedManifest, redactedPaths);

  const serializedSanitizedManifest = serializeManifestRecord(
    sanitizeMountCredentialEnvironmentForPersistence({
      manifest: persistedManifest,
    }).manifest,
  );
  const persistentManifest = {
    ...record,
    entries: serializedSanitizedManifest.entries,
    environment: serializedSanitizedManifest.environment,
  };
  const providerState = providerStateWithoutSdkEnvelopeFields(
    envelope.providerState,
    envelope.backendId,
  );
  const persistedEnvironment = isStringRecord(providerState.environment)
    ? providerState.environment
    : undefined;
  delete providerState.environment;
  if (persistedEnvironment) {
    providerState.environment =
      sanitizeMountCredentialEnvironmentForPersistence({
        manifest: persistedManifest,
        environment: persistedEnvironment,
      }).environment;
  }
  if (redactedPaths.length > 0) {
    providerState[REDACTED_MOUNT_CREDENTIAL_PATHS_KEY] = redactedPaths;
  } else {
    delete providerState[REDACTED_MOUNT_CREDENTIAL_PATHS_KEY];
  }
  if (hasNonResumableMountAuthority) {
    providerState[NON_RESUMABLE_MOUNT_AUTHORITY_KEY] = true;
  }
  return {
    ...envelope,
    manifest: persistentManifest,
    providerState,
  };
}

export function toSessionStateEnvelope(
  backendId: string,
  state: SandboxSessionState,
  providerState: Record<string, unknown>,
): SandboxSessionStateEnvelope {
  validateMountEnvironmentCredentialBoundaries(
    state.manifest,
    state.environment ?? {},
  );
  const persistentManifest = serializeManifest(
    sanitizeMountCredentialEnvironmentForPersistence(state).manifest,
  );
  return {
    version: SANDBOX_SESSION_STATE_VERSION,
    backendId,
    manifest: serializeManifestRecord(persistentManifest),
    ...(state.snapshot !== undefined ? { snapshot: state.snapshot } : {}),
    ...(state.snapshotFingerprint !== undefined
      ? { snapshotFingerprint: state.snapshotFingerprint }
      : {}),
    ...(state.snapshotFingerprintVersion !== undefined
      ? { snapshotFingerprintVersion: state.snapshotFingerprintVersion }
      : {}),
    workspaceReady: state.workspaceReady ?? true,
    ...(state.exposedPorts
      ? { exposedPorts: structuredClone(state.exposedPorts) }
      : {}),
    // Keep provider-owned fields separate from the SDK envelope so version and backend
    // checks can run before deserializing provider-specific state.
    providerState: {
      ...providerStateWithoutSdkEnvelopeFields(providerState, backendId),
      ...serializeHostPathGrantRedactionMetadata(state),
      ...serializeMountCredentialRedactionMetadata(state),
    },
  };
}

function providerStateWithoutSdkEnvelopeFields(
  providerState: Record<string, unknown>,
  backendId: string,
): Record<string, unknown> {
  const sanitized = { ...providerState };
  delete sanitized.manifest;
  if (backendId === 'docker') {
    delete sanitized.sessionIdentity;
  }
  delete sanitized.snapshot;
  delete sanitized.snapshotFingerprint;
  delete sanitized.snapshotFingerprintVersion;
  delete sanitized.workspaceReady;
  delete sanitized.exposedPorts;
  return sanitized;
}

export function assertSessionStateEnvelope(
  client: SandboxClient,
  envelope: SandboxSessionStateEnvelope,
): void {
  if (
    !SUPPORTED_SANDBOX_SESSION_STATE_VERSIONS.includes(
      envelope.version as (typeof SUPPORTED_SANDBOX_SESSION_STATE_VERSIONS)[number],
    )
  ) {
    throw new UserError(
      `Sandbox session state version ${envelope.version} is not supported. Please use version ${SANDBOX_SESSION_STATE_VERSION}.`,
    );
  }
  if (envelope.backendId !== client.backendId) {
    throw new UserError(
      'RunState sandbox session backend does not match the configured sandbox client.',
    );
  }
}

export async function deserializeSandboxSessionStateEntry(
  client: SandboxClient,
  serializedEntry: SerializedSandboxSessionEntry | undefined,
  trustedManifest?: Manifest,
  trustedConfig: RunStateSessionTrustedConfig = {},
): Promise<SandboxSessionState | undefined> {
  if (!serializedEntry) {
    return undefined;
  }
  if (serializedEntry.backendId !== client.backendId) {
    throw new UserError(
      'RunState sandbox backend does not match the configured sandbox client.',
    );
  }
  const resolvedTrustedManifest = resolveTrustedManifestForResume(
    client,
    trustedManifest,
    trustedConfig.clientOptions,
  );
  assertTrustedManifestForDockerRunState(client, resolvedTrustedManifest);
  if (!client.deserializeSessionState) {
    throw new UserError(
      'Sandbox client must implement deserializeSessionState() to resume RunState sandbox state.',
    );
  }
  const envelope = serializedEntry.sessionState;
  assertSessionStateEnvelope(client, envelope);
  assertTrustedEnvironmentForPersistedReferences(
    envelope,
    resolvedTrustedManifest,
  );
  if (manifestHasInContainerMounts(deserializeManifest(envelope.manifest))) {
    throw new SandboxMountError(
      'Sandbox session state with in-container mounts cannot be resumed safely. Create a fresh sandbox so mount helpers are recreated from current trusted configuration.',
      undefined,
      'mount_config_invalid',
    );
  }
  const prevalidatedPersistedState = rebindPersistedMountCredentials(
    {
      manifest: deserializeManifest(envelope.manifest),
      ...deserializeMountCredentialRedactionMetadata(envelope.providerState),
    },
    resolvedTrustedManifest,
  );
  assertMountCredentialsRebound(prevalidatedPersistedState);
  client.validateSessionStateForResume?.(
    {
      source: 'runState',
      state: providerStateWithSdkEnvelopeFields(
        envelope,
        prevalidatedPersistedState.manifest,
        resolvedTrustedManifest,
      ),
    },
    { clientOptions: trustedConfig.clientOptions },
  );
  const materializedTrustedManifest = resolvedTrustedManifest
    ? await resolveAndValidateMountEnvironment(resolvedTrustedManifest)
    : undefined;
  const state = await client.deserializeSessionState(
    providerStateWithSdkEnvelopeFields(
      envelope,
      prevalidatedPersistedState.manifest,
      materializedTrustedManifest,
    ),
  );
  if (client.backendId === 'docker') {
    delete state.sessionIdentity;
  }
  const credentialReboundState = rebindPersistedMountCredentials(
    {
      ...state,
      ...deserializeHostPathGrantRedactionMetadata(envelope.providerState),
      ...deserializeMountCredentialRedactionMetadata(envelope.providerState),
    },
    materializedTrustedManifest,
  );
  const reboundState = rebindPersistedPathGrants(
    credentialReboundState,
    materializedTrustedManifest,
    {
      replaceWithTrustedManifest:
        client.backendId === 'docker' &&
        materializedTrustedManifest !== undefined,
    },
  );
  assertMountCredentialsRebound(reboundState);
  validateMountCredentialBoundaries(reboundState.manifest);
  assertHostPathGrantsRebound(reboundState);
  return markRunStateSessionState(reboundState, trustedConfig);
}

export function resolveTrustedManifestForResume(
  client: SandboxClient,
  trustedManifest: Manifest | undefined,
  clientOptions?: SandboxClientOptions,
): Manifest | undefined {
  if (!trustedManifest) {
    return undefined;
  }
  const resolved = client.resolveTrustedManifestForResume
    ? client.resolveTrustedManifestForResume(trustedManifest, clientOptions)
    : trustedManifest;
  validateMountCredentialBoundaries(resolved);
  return resolved;
}

export function assertTrustedManifestForDockerRunState(
  client: SandboxClient,
  trustedManifest: Manifest | undefined,
): void {
  if (client.backendId === 'docker' && trustedManifest === undefined) {
    throw new UserError(
      'Docker RunState resume requires a current trusted manifest for the sandbox agent.',
    );
  }
}

function providerStateWithSdkEnvelopeFields(
  envelope: SandboxSessionStateEnvelope,
  persistedManifest: Manifest,
  trustedManifest?: Manifest,
): Record<string, unknown> {
  const providerState = providerStateWithoutSdkEnvelopeFields(
    envelope.providerState,
    envelope.backendId,
  );
  const persistedEnvironment = isStringRecord(providerState.environment)
    ? providerState.environment
    : undefined;
  const sanitizedEnvironment = persistedEnvironment
    ? sanitizeMountCredentialEnvironmentForPersistence({
        manifest: trustedManifest ?? persistedManifest,
        environment: persistedEnvironment,
      }).environment
    : undefined;
  return {
    ...providerState,
    ...(sanitizedEnvironment ? { environment: sanitizedEnvironment } : {}),
    manifest: trustedManifest
      ? {
          ...serializeManifestRecord(persistedManifest),
          environment: cloneManifestEnvironment(trustedManifest.environment),
        }
      : serializeManifestRecord(persistedManifest),
    ...(envelope.snapshot !== undefined ? { snapshot: envelope.snapshot } : {}),
    ...(envelope.snapshotFingerprint !== undefined
      ? { snapshotFingerprint: envelope.snapshotFingerprint }
      : {}),
    ...(envelope.snapshotFingerprintVersion !== undefined
      ? {
          snapshotFingerprintVersion: envelope.snapshotFingerprintVersion,
        }
      : {}),
    workspaceReady: envelope.workspaceReady,
    ...(envelope.exposedPorts
      ? { exposedPorts: structuredClone(envelope.exposedPorts) }
      : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function assertTrustedEnvironmentForPersistedReferences(
  envelope: SandboxSessionStateEnvelope,
  trustedManifest: Manifest | undefined,
): void {
  const persistedEnvironment = envelope.manifest.environment;
  if (
    !persistedEnvironment ||
    typeof persistedEnvironment !== 'object' ||
    Array.isArray(persistedEnvironment)
  ) {
    return;
  }

  const referenceKeys = Object.entries(persistedEnvironment)
    .filter(([, value]) => isSerializedEnvValueReference(value))
    .map(([key]) => key);
  if (referenceKeys.length === 0) {
    return;
  }
  if (!trustedManifest) {
    throw new UserError(
      'RunState sandbox session state with environment value references requires a current trusted manifest for the sandbox agent.',
    );
  }

  const missingReferenceKeys = referenceKeys.filter(
    (key) =>
      !trustedManifest.environment[key] ||
      !isEnvValueReference(trustedManifest.environment[key]),
  );
  if (missingReferenceKeys.length > 0) {
    throw new UserError(
      `RunState sandbox session state contains environment value references that are not present in the current trusted manifest: ${missingReferenceKeys.join(', ')}.`,
    );
  }
}

function cloneManifestEnvironment(
  environment: Record<string, { init(): ManifestEnvironment[string] }>,
): ManifestEnvironment {
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, value.init()]),
  );
}

export function getSerializedSessionEntryForAgent(
  sandboxState: SerializedSandboxState | undefined,
  currentAgentKey: string,
): SerializedSandboxSessionEntry | undefined {
  if (!sandboxState) {
    return undefined;
  }

  return (
    sandboxState.sessionsByAgent?.[currentAgentKey] ??
    (sandboxState.currentAgentKey === currentAgentKey
      ? {
          backendId: sandboxState.backendId,
          currentAgentKey: sandboxState.currentAgentKey,
          currentAgentName: sandboxState.currentAgentName,
          sessionState: sandboxState.sessionState,
        }
      : undefined)
  );
}

export function serializedSessionEntryHasInContainerMounts(
  entry: SerializedSandboxSessionEntry | undefined,
): boolean {
  return entry
    ? manifestHasInContainerMounts(
        deserializeManifest(entry.sessionState.manifest),
      )
    : false;
}

export function serializedSessionEntryRequiresFreshMountAuthority(
  entry: SerializedSandboxSessionEntry | undefined,
): boolean {
  return (
    serializedSessionEntryHasInContainerMounts(entry) ||
    entry?.sessionState.providerState[NON_RESUMABLE_MOUNT_AUTHORITY_KEY] ===
      true
  );
}

export function getPreviousSerializedSessionsByAgent(
  sandboxState: SerializedSandboxState | undefined,
  client: SandboxClient,
): Record<string, SerializedSandboxSessionEntry> {
  if (!sandboxState || sandboxState.backendId !== client.backendId) {
    return {};
  }

  const entries: Record<string, SerializedSandboxSessionEntry> = {
    ...(sandboxState.sessionsByAgent ?? {}),
  };
  if (sandboxState.currentAgentKey && !entries[sandboxState.currentAgentKey]) {
    entries[sandboxState.currentAgentKey] = {
      backendId: sandboxState.backendId,
      currentAgentKey: sandboxState.currentAgentKey,
      currentAgentName: sandboxState.currentAgentName,
      sessionState: sandboxState.sessionState,
    };
  }

  return Object.fromEntries(
    Object.entries(entries).filter(
      ([, entry]) => entry.backendId === client.backendId,
    ),
  );
}

export function hasPreservedOwnedSessions(
  sandboxState: SerializedSandboxState | undefined,
): boolean {
  return Object.values(sandboxState?.sessionsByAgent ?? {}).some(
    (entry) => entry.preservedOwnedSession,
  );
}
