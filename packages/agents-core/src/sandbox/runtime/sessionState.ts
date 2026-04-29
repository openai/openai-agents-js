import { UserError } from '../../errors';
import type { RunState } from '../../runState';
import type { Agent, AgentOutputType } from '../../agent';
import type { SandboxClient } from '../client';
import {
  SANDBOX_SESSION_STATE_VERSION,
  type SandboxSessionState,
  type SandboxSessionStateEnvelope,
} from '../session';
import {
  serializeManifest,
  serializeManifestRecord,
} from '../sandboxes/shared/manifestPersistence';

export type SerializedSandboxSessionEntry = {
  backendId: string;
  currentAgentKey: string;
  currentAgentName: string;
  sessionState: SandboxSessionStateEnvelope;
  preservedOwnedSession?: boolean;
  reuseLiveSession?: boolean;
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

export function toSessionStateEnvelope(
  backendId: string,
  state: SandboxSessionState,
  providerState: Record<string, unknown>,
): SandboxSessionStateEnvelope {
  const persistentManifest = serializeManifest(state.manifest);
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
    providerState,
  };
}

export function assertSessionStateEnvelope(
  client: SandboxClient,
  envelope: SandboxSessionStateEnvelope,
): void {
  if (envelope.version !== SANDBOX_SESSION_STATE_VERSION) {
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
): Promise<SandboxSessionState | undefined> {
  if (!serializedEntry) {
    return undefined;
  }
  if (serializedEntry.backendId !== client.backendId) {
    throw new UserError(
      'RunState sandbox backend does not match the configured sandbox client.',
    );
  }
  if (!client.deserializeSessionState) {
    throw new UserError(
      'Sandbox client must implement deserializeSessionState() to resume RunState sandbox state.',
    );
  }
  const envelope = serializedEntry.sessionState;
  assertSessionStateEnvelope(client, envelope);
  return await client.deserializeSessionState(
    providerStateWithSdkEnvelopeFields(envelope),
  );
}

function providerStateWithSdkEnvelopeFields(
  envelope: SandboxSessionStateEnvelope,
): Record<string, unknown> {
  return {
    ...envelope.providerState,
    manifest: envelope.manifest,
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
