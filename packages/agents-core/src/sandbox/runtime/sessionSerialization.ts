import type { SandboxClient } from '../client';
import type { SandboxSessionLike, SandboxSessionState } from '../session';
import {
  getPreviousSerializedSessionsByAgent,
  toSessionStateEnvelope,
  type SerializedSandboxSessionEntry,
  type SerializedSandboxState,
} from './sessionState';

export async function serializeSandboxRuntimeState(args: {
  client: SandboxClient | undefined;
  sandboxState: SerializedSandboxState | undefined;
  sessionsByAgentKey: ReadonlyMap<
    string,
    SandboxSessionLike<SandboxSessionState>
  >;
  sessionAgentNamesByKey: ReadonlyMap<string, string>;
  ownedSessionAgentKeys: ReadonlySet<string>;
  includeOwnedSessions?: boolean;
  preferredCurrentAgentKey?: string;
}): Promise<SerializedSandboxState | undefined> {
  const {
    client,
    sandboxState,
    sessionsByAgentKey,
    sessionAgentNamesByKey,
    ownedSessionAgentKeys,
    includeOwnedSessions,
    preferredCurrentAgentKey,
  } = args;
  if (!client?.serializeSessionState || sessionsByAgentKey.size === 0) {
    return undefined;
  }

  const sessionsByAgent = getPreviousSerializedSessionsByAgent(
    sandboxState,
    client,
  );
  if (!includeOwnedSessions) {
    dropPreservedOwnedSessionEntries(sessionsByAgent);
  }
  for (const [currentAgentKey, session] of sessionsByAgentKey.entries()) {
    const currentAgentName =
      sessionAgentNamesByKey.get(currentAgentKey) ?? currentAgentKey;
    delete sessionsByAgent[currentAgentKey];
    const isOwnedSession = ownedSessionAgentKeys.has(currentAgentKey);
    if (
      isOwnedSession &&
      !includeOwnedSessions &&
      client.canPersistOwnedSessionState &&
      !(await client.canPersistOwnedSessionState(session.state))
    ) {
      continue;
    }
    const reuseLiveSession =
      isOwnedSession &&
      includeOwnedSessions &&
      client.canReusePreservedOwnedSession
        ? await client.canReusePreservedOwnedSession(session.state)
        : true;
    // Start from previous entries so handoff agents that were not touched this turn
    // keep their sandbox sessions in the RunState.
    const providerState = await client.serializeSessionState(session.state, {
      preserveOwnedSession: isOwnedSession && !!includeOwnedSessions,
      reuseLiveSession,
      willCloseAfterSerialize: isOwnedSession && !includeOwnedSessions,
    });
    sessionsByAgent[currentAgentKey] = {
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
          }
        : {}),
    };
  }

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

function dropPreservedOwnedSessionEntries(
  sessionsByAgent: Record<string, SerializedSandboxSessionEntry>,
): void {
  for (const [agentKey, entry] of Object.entries(sessionsByAgent)) {
    if (entry.preservedOwnedSession) {
      delete sessionsByAgent[agentKey];
    }
  }
}
