import type { SandboxClient, SandboxClientOptions } from '../client';
import { assertProcessEnvValuesUnsupported, type Manifest } from '../manifest';
import {
  assertSandboxSessionStateUsable,
  withExclusiveSandboxStateInspection,
} from '../mountSecurity';
import {
  SANDBOX_SESSION_STATE_VERSION,
  type SandboxSessionLike,
  type SandboxSessionState,
} from '../session';
import {
  getPreviousSerializedSessionsByAgent,
  resolveTrustedManifestForResume,
  toSessionStateEnvelope,
  type SerializedSandboxSessionEntry,
  type SerializedSandboxState,
} from './sessionState';
import { withExclusiveProvidedSessionManifestMutation } from './providedSessionManifest';

export async function serializeSandboxRuntimeState(args: {
  client: SandboxClient | undefined;
  sandboxState: SerializedSandboxState | undefined;
  sessionsByAgentKey: ReadonlyMap<
    string,
    SandboxSessionLike<SandboxSessionState>
  >;
  sessionAgentNamesByKey: ReadonlyMap<string, string>;
  ownedSessionAgentKeys: ReadonlySet<string>;
  trustedManifestForAgentKey?: (agentKey: string) => Manifest | undefined;
  clientOptions?: SandboxClientOptions;
  includeOwnedSessions?: boolean;
  preferredCurrentAgentKey?: string;
}): Promise<SerializedSandboxState | undefined> {
  const {
    client,
    sandboxState,
    sessionsByAgentKey,
    sessionAgentNamesByKey,
    ownedSessionAgentKeys,
    trustedManifestForAgentKey,
    clientOptions,
    includeOwnedSessions,
    preferredCurrentAgentKey,
  } = args;
  const serializeSessionState = client?.serializeSessionState;
  if (!client || !serializeSessionState || sessionsByAgentKey.size === 0) {
    return undefined;
  }

  const sessionsByAgent = getPreviousSerializedSessionsByAgent(
    sandboxState,
    client,
  );
  dropLegacySessionEntries(sessionsByAgent);
  if (!includeOwnedSessions) {
    dropPreservedOwnedSessionEntries(sessionsByAgent);
  }
  for (const [currentAgentKey, session] of sessionsByAgentKey.entries()) {
    const currentAgentName =
      sessionAgentNamesByKey.get(currentAgentKey) ?? currentAgentKey;
    delete sessionsByAgent[currentAgentKey];
    const isOwnedSession = ownedSessionAgentKeys.has(currentAgentKey);
    const serializedEntry = await withExclusiveProvidedSessionManifestMutation(
      session.state,
      async () =>
        await withExclusiveSandboxStateInspection(session.state, async () => {
          assertSandboxSessionStateUsable(session.state);
          const trustedManifest = trustedManifestForAgentKey?.(currentAgentKey);
          if (client.backendId !== 'docker') {
            assertProcessEnvValuesUnsupported(
              session.state.manifest,
              client.backendId,
            );
            if (trustedManifest) {
              assertProcessEnvValuesUnsupported(
                trustedManifest,
                client.backendId,
              );
            }
          }
          if (
            isOwnedSession &&
            !includeOwnedSessions &&
            client.canPersistOwnedSessionState &&
            !(await client.canPersistOwnedSessionState(session.state))
          ) {
            return undefined;
          }
          const reuseLiveSession =
            isOwnedSession &&
            includeOwnedSessions &&
            client.canReusePreservedOwnedSession
              ? await client.canReusePreservedOwnedSession(session.state, {
                  clientOptions,
                  trustedManifest: resolveTrustedManifestForResume(
                    client,
                    trustedManifest,
                    clientOptions,
                  ),
                })
              : true;
          const requiresFreshCreation =
            isOwnedSession &&
            includeOwnedSessions &&
            !reuseLiveSession &&
            client.preservedOwnedSessionReuseRejectionRequiresFreshCreation ===
              true;
          const providerState = await serializeSessionState.call(
            client,
            session.state,
            {
              preserveOwnedSession: isOwnedSession && !!includeOwnedSessions,
              reuseLiveSession,
              willCloseAfterSerialize:
                isOwnedSession && (!includeOwnedSessions || !reuseLiveSession),
            },
          );
          return {
            backendId: client.backendId,
            currentAgentKey,
            currentAgentName,
            sessionState: toSessionStateEnvelope(
              client.backendId,
              session.state,
              providerState,
            ),
            ...(isOwnedSession && includeOwnedSessions
              ? {
                  preservedOwnedSession: true,
                  ...(reuseLiveSession ? {} : { reuseLiveSession: false }),
                  ...(requiresFreshCreation
                    ? { requiresFreshCreation: true }
                    : {}),
                }
              : {}),
          };
        }),
    );
    if (!serializedEntry) {
      continue;
    }
    // Start from previous entries so handoff agents that were not touched this turn
    // keep their sandbox sessions in the RunState.
    sessionsByAgent[currentAgentKey] = serializedEntry;
  }

  normalizeSharedOwnedSessionFreshCreation({
    sessionsByAgent,
    sessionsByAgentKey,
    ownedSessionAgentKeys,
  });

  const currentAgentKey =
    preferredCurrentAgentKey && sessionsByAgent[preferredCurrentAgentKey]
      ? preferredCurrentAgentKey
      : Object.keys(sessionsByAgent)[0];
  if (!currentAgentKey) {
    return undefined;
  }

  const currentEntry = sessionsByAgent[currentAgentKey];
  if (!currentEntry) {
    return undefined;
  }
  return {
    backendId: currentEntry.backendId,
    currentAgentKey,
    currentAgentName: currentEntry.currentAgentName,
    sessionState: currentEntry.sessionState,
    sessionsByAgent,
  };
}

function normalizeSharedOwnedSessionFreshCreation(args: {
  sessionsByAgent: Record<string, SerializedSandboxSessionEntry>;
  sessionsByAgentKey: ReadonlyMap<
    string,
    SandboxSessionLike<SandboxSessionState>
  >;
  ownedSessionAgentKeys: ReadonlySet<string>;
}): void {
  const agentKeysBySession = new Map<
    SandboxSessionLike<SandboxSessionState>,
    string[]
  >();
  for (const [agentKey, session] of args.sessionsByAgentKey) {
    if (
      !args.ownedSessionAgentKeys.has(agentKey) ||
      !args.sessionsByAgent[agentKey]?.preservedOwnedSession
    ) {
      continue;
    }
    const agentKeys = agentKeysBySession.get(session);
    if (agentKeys) {
      agentKeys.push(agentKey);
    } else {
      agentKeysBySession.set(session, [agentKey]);
    }
  }

  for (const agentKeys of agentKeysBySession.values()) {
    if (
      !agentKeys.some(
        (agentKey) =>
          args.sessionsByAgent[agentKey]?.requiresFreshCreation === true,
      )
    ) {
      continue;
    }
    for (const agentKey of agentKeys) {
      const entry = args.sessionsByAgent[agentKey];
      if (!entry) {
        continue;
      }
      entry.reuseLiveSession = false;
      entry.requiresFreshCreation = true;
    }
  }
}

function dropLegacySessionEntries(
  sessionsByAgent: Record<string, SerializedSandboxSessionEntry>,
): void {
  for (const [agentKey, entry] of Object.entries(sessionsByAgent)) {
    if (entry.sessionState.version !== SANDBOX_SESSION_STATE_VERSION) {
      delete sessionsByAgent[agentKey];
    }
  }
}

function dropPreservedOwnedSessionEntries(
  sessionsByAgent: Record<string, SerializedSandboxSessionEntry>,
): void {
  for (const [agentKey, entry] of Object.entries(sessionsByAgent)) {
    if (entry.preservedOwnedSession) {
      delete sessionsByAgent[agentKey];
    }
  }
}
