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
};

const livePreservedOwnedSessionsByRunState = new WeakMap<
  object,
  Map<string, LivePreservedOwnedSessionEntry>
>();

export function rememberLivePreservedOwnedSessions<TContext>(args: {
  state: RunState<TContext, Agent<TContext, AgentOutputType>>;
  serializedState: SerializedSandboxState;
  sessionsByAgentKey: ReadonlyMap<
    string,
    SandboxSessionLike<SandboxSessionState>
  >;
}): void {
  const liveSessions = new Map<string, LivePreservedOwnedSessionEntry>();
  for (const [agentKey, entry] of Object.entries(
    args.serializedState.sessionsByAgent ?? {},
  )) {
    if (!entry.preservedOwnedSession) {
      continue;
    }
    if (entry.reuseLiveSession === false) {
      continue;
    }
    const session = args.sessionsByAgentKey.get(agentKey);
    if (!session) {
      continue;
    }
    liveSessions.set(agentKey, {
      agentKey,
      backendId: entry.backendId,
      currentAgentName: entry.currentAgentName,
      session,
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
  livePreservedOwnedSessionsByRunState.delete(state);
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
  const liveEntry = liveSessions?.get(args.agentKey);
  if (!liveEntry || liveEntry.backendId !== args.client.backendId) {
    return undefined;
  }
  return liveEntry;
}
