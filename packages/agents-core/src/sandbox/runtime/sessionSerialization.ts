import type { SandboxClient, SandboxClientOptions } from '../client';
import type { Manifest } from '../manifest';
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
  clientPreparedManifestAuthoritiesMatch,
  getPreviousSerializedSessionsByAgent,
  toSessionStateEnvelope,
  type SerializedSandboxSessionEntry,
  type SerializedSandboxState,
} from './sessionState';
import { withExclusiveProvidedSessionManifestMutation } from './providedSessionManifest';

type SessionSerializationPlan = {
  currentAgentKey: string;
  currentAgentName: string;
  session: SandboxSessionLike<SandboxSessionState>;
  isOwnedSession: boolean;
  needsTrustedManifest: boolean;
  trustedManifest: Manifest | undefined;
  reuseLiveSession: boolean;
  skipSerialization: boolean;
};

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
  retainedPreservedOwnedSessionAgentKeys?: ReadonlySet<string>;
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
    retainedPreservedOwnedSessionAgentKeys,
  } = args;
  const serializeSessionState = client?.serializeSessionState;
  if (!client || !serializeSessionState) {
    return undefined;
  }

  const sessionsByAgent = getPreviousSerializedSessionsByAgent(
    sandboxState,
    client,
  );
  dropLegacySessionEntries(sessionsByAgent);
  if (!includeOwnedSessions) {
    dropPreservedOwnedSessionEntries(
      sessionsByAgent,
      retainedPreservedOwnedSessionAgentKeys,
    );
  }
  const plansBySession = new Map<
    SandboxSessionLike<SandboxSessionState>,
    SessionSerializationPlan[]
  >();
  for (const [currentAgentKey, session] of sessionsByAgentKey) {
    const isOwnedSession = ownedSessionAgentKeys.has(currentAgentKey);
    const needsTrustedManifest =
      client.environmentPreparation === 'client' ||
      (isOwnedSession &&
        !!includeOwnedSessions &&
        client.canReusePreservedOwnedSession !== undefined);
    const plan: SessionSerializationPlan = {
      currentAgentKey,
      currentAgentName:
        sessionAgentNamesByKey.get(currentAgentKey) ?? currentAgentKey,
      session,
      isOwnedSession,
      needsTrustedManifest,
      trustedManifest: undefined,
      reuseLiveSession: true,
      skipSerialization: false,
    };
    const plans = plansBySession.get(plan.session) ?? [];
    plans.push(plan);
    plansBySession.set(plan.session, plans);
    delete sessionsByAgent[currentAgentKey];
  }

  for (const plans of plansBySession.values()) {
    const session = plans[0]!.session;
    await withExclusiveProvidedSessionManifestMutation(
      session.state,
      async () =>
        await withExclusiveSandboxStateInspection(session.state, async () => {
          assertSandboxSessionStateUsable(session.state);
          for (const plan of plans) {
            if (
              plan.isOwnedSession &&
              !includeOwnedSessions &&
              client.canPersistOwnedSessionState &&
              !(await client.canPersistOwnedSessionState(session.state))
            ) {
              plan.skipSerialization = true;
              continue;
            }
            if (plan.needsTrustedManifest) {
              plan.trustedManifest = trustedManifestForAgentKey?.(
                plan.currentAgentKey,
              );
            }
            if (
              plan.isOwnedSession &&
              includeOwnedSessions &&
              client.canReusePreservedOwnedSession
            ) {
              plan.reuseLiveSession =
                await client.canReusePreservedOwnedSession(session.state, {
                  clientOptions,
                  trustedManifest: plan.trustedManifest,
                });
            }
          }

          const ownedPlans = plans.filter(
            (plan) =>
              plan.isOwnedSession &&
              includeOwnedSessions &&
              !plan.skipSerialization,
          );
          const firstTrustedManifest = ownedPlans[0]?.trustedManifest;
          const authorityDiffers =
            client.environmentPreparation === 'client' &&
            firstTrustedManifest !== undefined &&
            ownedPlans.some(
              (plan) =>
                plan.trustedManifest !== undefined &&
                !clientPreparedManifestAuthoritiesMatch(
                  session.state.manifest,
                  firstTrustedManifest,
                  plan.trustedManifest,
                ),
            );
          if (
            authorityDiffers ||
            ownedPlans.some((plan) => !plan.reuseLiveSession)
          ) {
            for (const plan of ownedPlans) {
              plan.reuseLiveSession = false;
            }
          }

          for (const plan of plans) {
            if (plan.skipSerialization) {
              continue;
            }
            const requiresFreshCreation =
              plan.isOwnedSession &&
              includeOwnedSessions &&
              !plan.reuseLiveSession &&
              client.preservedOwnedSessionReuseRejectionRequiresFreshCreation ===
                true;
            const providerState = await serializeSessionState.call(
              client,
              session.state,
              {
                preserveOwnedSession:
                  plan.isOwnedSession && !!includeOwnedSessions,
                reuseLiveSession: plan.reuseLiveSession,
                willCloseAfterSerialize:
                  plan.isOwnedSession &&
                  (!includeOwnedSessions || !plan.reuseLiveSession),
              },
            );
            // Start from previous entries so handoff agents that were not
            // touched this turn keep their sandbox sessions in the RunState.
            sessionsByAgent[plan.currentAgentKey] = {
              backendId: client.backendId,
              currentAgentKey: plan.currentAgentKey,
              currentAgentName: plan.currentAgentName,
              sessionState: toSessionStateEnvelope(
                client.backendId,
                session.state,
                providerState,
                {
                  environmentPreparation: client.environmentPreparation,
                  ...(client.environmentPreparation === 'client'
                    ? { trustedManifest: plan.trustedManifest }
                    : {}),
                },
              ),
              ...(plan.isOwnedSession && includeOwnedSessions
                ? {
                    preservedOwnedSession: true,
                    ...(plan.reuseLiveSession
                      ? {}
                      : { reuseLiveSession: false }),
                    ...(requiresFreshCreation
                      ? { requiresFreshCreation: true }
                      : {}),
                  }
                : {}),
            };
          }
        }),
    );
  }

  for (const agentKey of retainedPreservedOwnedSessionAgentKeys ?? []) {
    const entry = sessionsByAgent[agentKey];
    if (!entry) {
      continue;
    }
    entry.preservedOwnedSession = true;
    entry.reuseLiveSession = false;
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
  retainedAgentKeys: ReadonlySet<string> | undefined,
): void {
  for (const [agentKey, entry] of Object.entries(sessionsByAgent)) {
    if (entry.preservedOwnedSession && !retainedAgentKeys?.has(agentKey)) {
      delete sessionsByAgent[agentKey];
    }
  }
}
