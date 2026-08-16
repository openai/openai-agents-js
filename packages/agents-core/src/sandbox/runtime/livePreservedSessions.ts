import type { Agent, AgentOutputType } from '../../agent';
import type { RunState } from '../../runState';
import type { SandboxClient } from '../client';
import type { SandboxSessionLike, SandboxSessionState } from '../session';
import type {
  SerializedSandboxSessionEntry,
  SerializedSandboxState,
} from './sessionState';

export type LivePreservedOwnedSessionEntry = {
  agentKey: string;
  backendId: string;
  currentAgentName: string;
  session: SandboxSessionLike<SandboxSessionState>;
  reuseRejected?: boolean;
};

const livePreservedOwnedSessionsByRunState = new WeakMap<
  object,
  Set<LivePreservedOwnedSessionEntry>
>();

export function rememberLivePreservedOwnedSessions<TContext>(args: {
  state: RunState<TContext, Agent<TContext, AgentOutputType>>;
  serializedState: SerializedSandboxState;
  sessionsByAgentKey: ReadonlyMap<
    string,
    SandboxSessionLike<SandboxSessionState>
  >;
}): void {
  const rejectedEntries = livePreservedOwnedSessionEntries(args.state).filter(
    (entry) => entry.reuseRejected,
  );
  const rejectedSessions = new Set(
    rejectedEntries.map((entry) => entry.session),
  );
  const liveSessions = new Set<LivePreservedOwnedSessionEntry>(rejectedEntries);
  for (const [agentKey, entry] of Object.entries(
    args.serializedState.sessionsByAgent ?? {},
  )) {
    if (!entry.preservedOwnedSession) {
      continue;
    }
    const reuseRejected =
      entry.reuseLiveSession === false && entry.requiresFreshCreation === true;
    if (entry.reuseLiveSession === false && !reuseRejected) {
      continue;
    }
    const session = args.sessionsByAgentKey.get(agentKey);
    if (!session) {
      continue;
    }
    const existing = [...liveSessions].find(
      (liveEntry) =>
        liveEntry.agentKey === agentKey && liveEntry.session === session,
    );
    if (existing) {
      existing.reuseRejected ||= rejectedSessions.has(session);
      continue;
    }
    liveSessions.add({
      agentKey,
      backendId: entry.backendId,
      currentAgentName: entry.currentAgentName,
      session,
      ...(reuseRejected || rejectedSessions.has(session)
        ? { reuseRejected: true }
        : {}),
    });
  }

  if (liveSessions.size > 0) {
    livePreservedOwnedSessionsByRunState.set(args.state, liveSessions);
  } else {
    livePreservedOwnedSessionsByRunState.delete(args.state);
  }
}

export function forgetLivePreservedOwnedSessions<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
): void {
  const liveSessions = livePreservedOwnedSessionsByRunState.get(state);
  if (!liveSessions) {
    return;
  }
  for (const entry of liveSessions) {
    if (!entry.reuseRejected) {
      liveSessions.delete(entry);
    }
  }
  if (liveSessions.size === 0) {
    livePreservedOwnedSessionsByRunState.delete(state);
  }
}

export function hasRejectedLivePreservedOwnedSessions<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
): boolean {
  return livePreservedOwnedSessionEntries(state).some(
    (entry) => entry.reuseRejected,
  );
}

export function forgetLivePreservedOwnedSessionHandle<TContext>(args: {
  state: RunState<TContext, Agent<TContext, AgentOutputType>> | undefined;
  session: SandboxSessionLike<SandboxSessionState>;
}): void {
  if (!args.state) {
    return;
  }
  const liveSessions = livePreservedOwnedSessionsByRunState.get(args.state);
  if (!liveSessions) {
    return;
  }
  for (const entry of liveSessions) {
    if (entry.session === args.session) {
      liveSessions.delete(entry);
    }
  }
  if (liveSessions.size === 0) {
    livePreservedOwnedSessionsByRunState.delete(args.state);
  }
}

export function rememberRejectedLivePreservedOwnedSessionHandle<
  TContext,
>(args: {
  state: RunState<TContext, Agent<TContext, AgentOutputType>> | undefined;
  source: LivePreservedOwnedSessionEntry;
  session: SandboxSessionLike<SandboxSessionState>;
}): void {
  if (!args.state) {
    return;
  }
  const liveSessions =
    livePreservedOwnedSessionsByRunState.get(args.state) ?? new Set();
  const existing = [...liveSessions].find(
    (entry) => entry.session === args.session,
  );
  if (existing) {
    existing.reuseRejected = true;
  } else {
    liveSessions.add({
      agentKey: args.source.agentKey,
      backendId: args.source.backendId,
      currentAgentName: args.source.currentAgentName,
      session: args.session,
      reuseRejected: true,
    });
  }
  livePreservedOwnedSessionsByRunState.set(args.state, liveSessions);
}

export function rejectLivePreservedOwnedSessionHandle<TContext>(args: {
  state: RunState<TContext, Agent<TContext, AgentOutputType>> | undefined;
  session: SandboxSessionLike<SandboxSessionState>;
}): void {
  if (!args.state) {
    return;
  }
  const liveSessions = livePreservedOwnedSessionsByRunState.get(args.state);
  if (!liveSessions) {
    return;
  }
  for (const entry of liveSessions.values()) {
    if (entry.session === args.session) {
      entry.reuseRejected = true;
    }
  }
}

export function livePreservedOwnedSessionEntries<TContext>(
  state: RunState<TContext, Agent<TContext, AgentOutputType>>,
): LivePreservedOwnedSessionEntry[] {
  return [...(livePreservedOwnedSessionsByRunState.get(state)?.values() ?? [])];
}

export function preservedOwnedSessionAgentKeysWithoutLiveReuse(
  serializedState: SerializedSandboxState,
): Set<string> {
  return new Set(
    Object.entries(serializedState.sessionsByAgent ?? {})
      .filter(
        ([, entry]) =>
          entry.preservedOwnedSession && entry.reuseLiveSession === false,
      )
      .map(([agentKey]) => agentKey),
  );
}

export function livePreservedOwnedSession<TContext>(args: {
  runState: RunState<TContext, Agent<TContext, AgentOutputType>> | undefined;
  client: SandboxClient;
  agentKey: string;
  serializedEntry: SerializedSandboxSessionEntry | undefined;
}): LivePreservedOwnedSessionEntry | undefined {
  if (!args.serializedEntry?.preservedOwnedSession || !args.runState) {
    return undefined;
  }
  const liveSessions = livePreservedOwnedSessionsByRunState.get(args.runState);
  const matchingEntries = [...(liveSessions ?? [])].filter(
    (entry) =>
      entry.agentKey === args.agentKey &&
      entry.backendId === args.client.backendId,
  );
  const rejectedSessions = new Set(
    [...(liveSessions ?? [])]
      .filter((entry) => entry.reuseRejected)
      .map((entry) => entry.session),
  );
  const liveEntry =
    matchingEntries.find((entry) => rejectedSessions.has(entry.session)) ??
    matchingEntries[0];
  if (!liveEntry) {
    return undefined;
  }
  return rejectedSessions.has(liveEntry.session)
    ? { ...liveEntry, reuseRejected: true }
    : liveEntry;
}
