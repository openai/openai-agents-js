import type { Agent, AgentOutputType } from '../../agent';
import logger, { logModelAndToolActionWarning } from '../../logger';
import { UserError } from '../../errors';
import type { RunState } from '../../runState';
import type { AgentInputItem } from '../../types';
import type { Span, Trace } from '../../tracing';
import type { SandboxAgent } from '../agent';
import type { Memory } from '../capabilities/memory';
import { isMemoryCapability } from '../capabilities/memory';
import type {
  SandboxClient,
  SandboxClientCreateArgs,
  SandboxRunConfig,
} from '../client';
import { SandboxLifecycleError, SandboxMountError } from '../errors';
import {
  cloneManifest,
  isEnvValueReference,
  Manifest,
  replaceManifestMountCredentialExposurePolicy,
} from '../manifest';
import {
  captureLiveMountCredentialAuthorityIfAbsent,
  captureSandboxStateGeneration,
  assertSandboxStateGenerationUnchanged,
  assertSandboxSessionStateUsable,
  isSandboxSessionStateUnsafe,
  liveMountCredentialAuthorityMatches,
  liveMountEnvironmentAuthorityMatches,
  manifestHasInContainerMounts,
  manifestHasNonResumableMountAuthority,
  recordLiveMountCredentialAuthority,
  resolveAndValidateMountEnvironment,
  validateMountCredentialBoundaries,
  validateMountEnvironmentCredentialBoundaries,
} from '../mountSecurity';
import { type SandboxSessionLike, type SandboxSessionState } from '../session';
import { isDefaultRemoteMountCommandAllowlist } from '../shared/remoteMountCommandAllowlist';
import { serializeManifestEnvironment } from '../shared/environment';
import { stableJsonStringify } from '../shared/stableJson';
import type { SnapshotSpec } from '../snapshot';
import {
  getOrCreateSandboxMemoryGenerationManager,
  type SandboxMemoryAgentRunner,
} from '../memory/generation';
import {
  cloneSandboxCapabilities,
  prepareSandboxAgent,
  type SandboxRuntimeModel,
} from './agentPreparation';
import {
  acquireSandboxAgent,
  allocateAgentKeys,
  getObjectId,
  indexAgentsByKey,
  isSandboxAgent,
  releaseSandboxAgents,
} from './agentKeys';
import {
  forgetLivePreservedOwnedSessions,
  forgetLivePreservedOwnedSessionHandle,
  hasRejectedLivePreservedOwnedSessions,
  livePreservedOwnedSessionEntries,
  livePreservedOwnedSession,
  preservedOwnedSessionAgentKeysWithoutLiveReuse,
  rejectLivePreservedOwnedSessionHandle,
  rememberRejectedLivePreservedOwnedSessionHandle,
  rememberLivePreservedOwnedSessions,
  type LivePreservedOwnedSessionEntry,
} from './livePreservedSessions';
import { applyManifestToProvidedSession } from './providedSessionManifest';
import { serializeSandboxRuntimeState } from './sessionSerialization';
import {
  assertMountCredentialsRebound,
  assertHostPathGrantsRebound,
  rebindPersistedMountCredentials,
  rebindPersistedPathGrants,
} from '../sandboxes/shared/manifestPersistence';
import {
  cleanupSandboxSession,
  hasSessionCleanup,
  runSandboxSessionPreStop,
  runSandboxSessionPreStopHooks,
} from './sessionLifecycle';
import {
  assertTrustedManifestForDockerRunState,
  deserializeSandboxSessionStateEntry,
  getPreviousSerializedSessionsByAgent,
  getSerializedSandboxState,
  getSerializedSessionEntryForAgent,
  hasPreservedOwnedSessions,
  resolveTrustedManifestForResume,
  serializedSessionEntryRequiresFreshMountAuthority,
  type SerializedSandboxState,
} from './sessionState';
import { withSandboxSpan } from './spans';
import { manifestWithRunAsUser, sandboxRunAsName } from './runAsManifest';
import { SandboxWorkspaceScope } from '../workspacePaths';

type SandboxPreparedAgent<TContext> = {
  executionAgent: Agent<TContext, AgentOutputType>;
  turnInput: AgentInputItem[];
};

type OwnedSessionCloseTarget = 'all' | ReadonlySet<string>;

type SandboxCleanupPlan = {
  ownedSessionCloseTarget?: OwnedSessionCloseTarget;
  afterOwnedSessionClose?: {
    clearSandboxState?: boolean;
    forgetLivePreservedSessions?: boolean;
    removeClosedSessionsFromSandboxState?: boolean;
  };
  deferredError?: unknown;
};

type LivePreservedOwnedSessionReuseDecision = {
  entry: LivePreservedOwnedSessionEntry;
  reusable: boolean;
  mountAuthorityChanged?: boolean;
};

type SandboxAgentIdentityRegistry = {
  agentKeys: Map<number, string>;
  agentsByKey: Map<string, Agent<any, AgentOutputType>>;
};

const sandboxAgentIdentitiesByRunState = new WeakMap<
  object,
  SandboxAgentIdentityRegistry
>();

export class SandboxRuntimeManager<TContext> {
  private readonly sandboxConfig?: SandboxRunConfig;
  private readonly workspaceScope: SandboxWorkspaceScope;
  private readonly runState?: RunState<
    TContext,
    Agent<TContext, AgentOutputType>
  >;
  private readonly agentKeys: Map<number, string>;
  private readonly agentsByKey: Map<string, Agent<TContext, AgentOutputType>>;
  private readonly acquiredAgents = new Map<
    number,
    SandboxAgent<TContext, AgentOutputType>
  >();
  private readonly sessionsByAgent = new Map<
    number,
    SandboxSessionLike<SandboxSessionState>
  >();
  private readonly sessionsByAgentKey = new Map<
    string,
    SandboxSessionLike<SandboxSessionState>
  >();
  private readonly sessionAgentNamesByKey = new Map<string, string>();
  private readonly preparedAgents = new Map<
    number,
    Agent<TContext, AgentOutputType>
  >();
  private readonly preparedSessions = new Map<
    number,
    SandboxSessionLike<SandboxSessionState>
  >();
  private readonly preparedManifestSignatures = new Map<number, string>();
  private readonly ownedSessionAgentKeys = new Set<string>();
  private readonly sessionStartPromises = new WeakMap<
    SandboxSessionLike<SandboxSessionState>,
    Promise<void>
  >();
  private activeMemory?: {
    session: SandboxSessionLike<SandboxSessionState>;
    memory: Memory;
    runAs?: string;
  };
  private currentAgentId?: number;

  constructor(args: {
    startingAgent: Agent<TContext, AgentOutputType>;
    sandboxConfig?: SandboxRunConfig;
    runState?: RunState<TContext, Agent<TContext, AgentOutputType>>;
  }) {
    this.sandboxConfig = args.sandboxConfig;
    this.workspaceScope = new SandboxWorkspaceScope(args.sandboxConfig?.cwd);
    this.runState = args.runState;
    const existingIdentityRegistry = args.runState
      ? sandboxAgentIdentitiesByRunState.get(args.runState)
      : undefined;
    if (existingIdentityRegistry) {
      this.agentKeys = existingIdentityRegistry.agentKeys;
      this.agentsByKey = existingIdentityRegistry.agentsByKey;
    } else {
      this.agentKeys = allocateAgentKeys(args.startingAgent);
      this.agentsByKey = indexAgentsByKey(args.startingAgent, this.agentKeys);
      if (args.runState) {
        sandboxAgentIdentitiesByRunState.set(args.runState, {
          agentKeys: this.agentKeys,
          agentsByKey: this.agentsByKey,
        });
      }
    }
  }

  async prepareAgent(args: {
    currentAgent: Agent<TContext, AgentOutputType>;
    turnInput: AgentInputItem[];
    runConfigModel?: SandboxRuntimeModel;
    tracingParent?: Span<any> | Trace;
  }): Promise<SandboxPreparedAgent<TContext>> {
    const { currentAgent, turnInput, runConfigModel, tracingParent } = args;
    if (!isSandboxAgent(currentAgent)) {
      this.activeMemory = undefined;
      return {
        executionAgent: currentAgent,
        turnInput,
      };
    }

    if (!this.sandboxConfig) {
      throw new UserError(
        'SandboxAgent execution requires `RunConfig.sandbox`.',
      );
    }

    return await withSandboxSpan(
      'sandbox.prepare_agent',
      {
        agent_name: currentAgent.name,
      },
      async (prepareSpan) => {
        this.acquireAgent(currentAgent);
        const session = await this.ensureSession(currentAgent, prepareSpan);
        await this.ensureWorkspaceScopeAccessible(
          session,
          sandboxRunAsName(currentAgent.runAs),
        );
        // Bind a clone to the live session so capability tools and instructions can carry
        // per-session state without mutating the public SandboxAgent instance.
        const executionAgent = this.getPreparedAgent(
          currentAgent,
          session,
          runConfigModel,
          tracingParent,
        );
        const memory = executionAgent.capabilities.find(isMemoryCapability);
        if (memory) {
          this.activeMemory = {
            session,
            memory,
            runAs: sandboxRunAsName(currentAgent.runAs),
          };
        } else {
          this.activeMemory = undefined;
        }

        return {
          executionAgent,
          turnInput: executionAgent.capabilities.reduce(
            (input, capability) => capability.processContext(input),
            turnInput,
          ),
        };
      },
      tracingParent,
    );
  }

  async cleanup(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    options: {
      preserveOwnedSessions?: boolean;
      tracingParent?: Span<any> | Trace;
    } = {},
  ): Promise<void> {
    const preserveOwnedSessions = options.preserveOwnedSessions ?? false;
    const runCleanup = async (cleanupSpan?: Span<any> | Trace) => {
      let preserveCleanupHandles = false;
      try {
        const cleanupPlan = await this.planCleanup(
          state,
          { preserveOwnedSessions },
          cleanupSpan,
        );
        await this.executeCleanupPlan(state, cleanupPlan, {
          onCloseError: () => {
            preserveCleanupHandles = true;
          },
          tracingParent: cleanupSpan,
        });
      } finally {
        if (hasPreservedOwnedSessions(getSerializedSandboxState(state))) {
          sandboxAgentIdentitiesByRunState.set(state, {
            agentKeys: this.agentKeys,
            agentsByKey: this.agentsByKey,
          });
        } else {
          sandboxAgentIdentitiesByRunState.delete(state);
        }
        this.releaseAgents();
        this.sessionsByAgent.clear();
        if (!preserveCleanupHandles) {
          this.sessionsByAgentKey.clear();
          this.sessionAgentNamesByKey.clear();
          this.ownedSessionAgentKeys.clear();
        }
        this.preparedAgents.clear();
        this.preparedSessions.clear();
        this.preparedManifestSignatures.clear();
        this.activeMemory = undefined;
        this.currentAgentId = undefined;
      }
    };

    if (
      this.sessionsByAgentKey.size === 0 &&
      this.preparedAgents.size === 0 &&
      this.ownedSessionAgentKeys.size === 0
    ) {
      await runCleanup(options.tracingParent);
      return;
    }

    await withSandboxSpan(
      'sandbox.cleanup',
      {},
      runCleanup,
      options.tracingParent,
    );
  }

  private async planCleanup(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    options: {
      preserveOwnedSessions: boolean;
    },
    tracingParent?: Span<any> | Trace,
  ): Promise<SandboxCleanupPlan> {
    if (this.sessionsByAgentKey.size > 0) {
      return await this.planCleanupForActiveSessions(state, options);
    }
    return await this.planCleanupForSerializedStateOnly(
      state,
      options,
      tracingParent,
    );
  }

  private async planCleanupForActiveSessions(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    options: {
      preserveOwnedSessions: boolean;
    },
  ): Promise<SandboxCleanupPlan> {
    const cleanupPlan: SandboxCleanupPlan = options.preserveOwnedSessions
      ? {}
      : {
          ownedSessionCloseTarget: 'all',
          afterOwnedSessionClose: {
            forgetLivePreservedSessions: true,
          },
        };

    const { closeErrors: rejectedCloseErrors } =
      await this.closeLivePreservedOwnedSessions(state, {
        rejectedOnly: true,
      });
    if (rejectedCloseErrors.length > 0) {
      cleanupPlan.deferredError = lifecycleErrorForCloseErrors(
        'Failed to close one or more rejected live sandbox sessions.',
        rejectedCloseErrors,
      );
    }

    try {
      await this.runPreStopHooksBeforeRelease();
      const serializedState = await this.serializeState({
        includeOwnedSessions: options.preserveOwnedSessions,
      });
      state._sandbox = serializedState;

      if (options.preserveOwnedSessions && serializedState) {
        rememberLivePreservedOwnedSessions({
          state,
          serializedState,
          sessionsByAgentKey: this.sessionsByAgentKey,
        });
        const serializedOnlySessionAgentKeys =
          preservedOwnedSessionAgentKeysWithoutLiveReuse(serializedState);
        if (serializedOnlySessionAgentKeys.size > 0) {
          cleanupPlan.ownedSessionCloseTarget = serializedOnlySessionAgentKeys;
        }
      }

      if (
        options.preserveOwnedSessions &&
        !serializedState &&
        this.ownedSessionAgentKeys.size > 0
      ) {
        cleanupPlan.ownedSessionCloseTarget = 'all';
        cleanupPlan.afterOwnedSessionClose = {
          forgetLivePreservedSessions: true,
        };
      }
    } catch (error) {
      cleanupPlan.deferredError = cleanupPlan.deferredError
        ? new SandboxLifecycleError(
            'Failed to clean up rejected live sessions and serialize active sandbox sessions.',
            { errors: [cleanupPlan.deferredError, error] },
          )
        : error;
      if (this.ownedSessionAgentKeys.size > 0) {
        cleanupPlan.ownedSessionCloseTarget = 'all';
        cleanupPlan.afterOwnedSessionClose = {
          forgetLivePreservedSessions: true,
          removeClosedSessionsFromSandboxState: true,
        };
      }
    }

    return cleanupPlan;
  }

  private async planCleanupForSerializedStateOnly(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    options: {
      preserveOwnedSessions: boolean;
    },
    tracingParent?: Span<any> | Trace,
  ): Promise<SandboxCleanupPlan> {
    const cleanupPlan: SandboxCleanupPlan = options.preserveOwnedSessions
      ? {}
      : {
          ownedSessionCloseTarget: 'all',
          afterOwnedSessionClose: {
            forgetLivePreservedSessions: true,
          },
        };
    let sandboxState = getSerializedSandboxState(state);

    if (
      (hasPreservedOwnedSessions(sandboxState) ||
        hasRejectedLivePreservedOwnedSessions(state)) &&
      !options.preserveOwnedSessions
    ) {
      const { closedAgentKeys, closeErrors } =
        await this.closeLivePreservedOwnedSessions(state);
      if (closedAgentKeys.size > 0) {
        if (
          sandboxState &&
          !removeClosedPreservedOwnedSessions(sandboxState, closedAgentKeys)
        ) {
          state._sandbox = undefined;
          sandboxState = undefined;
        }
      }
      if (closeErrors.length === 1) {
        throw closeErrors[0];
      }
      if (closeErrors.length > 1) {
        throw new SandboxLifecycleError(
          'Failed to close one or more live preserved owned sandbox sessions.',
          { errors: closeErrors },
        );
      }

      if (hasPreservedOwnedSessions(sandboxState)) {
        if (this.sandboxConfig?.client) {
          try {
            await this.adoptPreservedOwnedSessions(tracingParent);
            if (this.ownedSessionAgentKeys.size > 0) {
              cleanupPlan.ownedSessionCloseTarget = 'all';
              cleanupPlan.afterOwnedSessionClose = {
                clearSandboxState: true,
                forgetLivePreservedSessions: true,
              };
            } else {
              cleanupPlan.ownedSessionCloseTarget = undefined;
              cleanupPlan.afterOwnedSessionClose = undefined;
            }
          } catch (error) {
            cleanupPlan.deferredError = error;
          }
        } else {
          state._sandbox = undefined;
          forgetLivePreservedOwnedSessions(state);
          cleanupPlan.ownedSessionCloseTarget = undefined;
          cleanupPlan.afterOwnedSessionClose = undefined;
        }
      } else if (closedAgentKeys.size > 0) {
        state._sandbox = undefined;
      }
    } else if (!hasPreservedOwnedSessions(sandboxState)) {
      state._sandbox = undefined;
      forgetLivePreservedOwnedSessions(state);
    }

    return cleanupPlan;
  }

  private async executeCleanupPlan(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    plan: SandboxCleanupPlan,
    options: {
      onCloseError: () => void;
      tracingParent?: Span<any> | Trace;
    },
  ): Promise<void> {
    if (plan.ownedSessionCloseTarget) {
      let closedSessionAgentKeys: ReadonlySet<string>;
      try {
        closedSessionAgentKeys = await this.closeOwnedSessions(
          plan.ownedSessionCloseTarget === 'all'
            ? undefined
            : plan.ownedSessionCloseTarget,
          {
            removeClosedSessionsFromSandboxState: Boolean(
              plan.afterOwnedSessionClose
                ?.removeClosedSessionsFromSandboxState ||
              plan.afterOwnedSessionClose?.clearSandboxState,
            ),
            tracingParent: options.tracingParent,
          },
        );
      } catch (error) {
        options.onCloseError();
        throw error;
      }

      if (plan.afterOwnedSessionClose?.forgetLivePreservedSessions) {
        forgetLivePreservedOwnedSessions(state);
      }
      if (plan.afterOwnedSessionClose?.removeClosedSessionsFromSandboxState) {
        const sandboxState = getSerializedSandboxState(state);
        if (
          sandboxState &&
          !removeClosedSerializedSessions(sandboxState, closedSessionAgentKeys)
        ) {
          state._sandbox = undefined;
        }
      }
      if (plan.afterOwnedSessionClose?.clearSandboxState) {
        state._sandbox = undefined;
      }
    }

    if (plan.deferredError) {
      throw plan.deferredError;
    }
  }

  private async closeLivePreservedOwnedSessions(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    options: { rejectedOnly?: boolean } = {},
  ): Promise<{
    closedAgentKeys: Set<string>;
    closeErrors: unknown[];
  }> {
    const sessionAgentKeys = new Map<
      SandboxSessionLike<SandboxSessionState>,
      string[]
    >();
    for (const entry of livePreservedOwnedSessionEntries(state)) {
      if (options.rejectedOnly && !entry.reuseRejected) {
        continue;
      }
      const agentKeys = sessionAgentKeys.get(entry.session) ?? [];
      agentKeys.push(entry.agentKey);
      sessionAgentKeys.set(entry.session, agentKeys);
    }
    const closedAgentKeys = new Set<string>();
    const closeErrors: unknown[] = [];
    for (const [session, agentKeys] of sessionAgentKeys) {
      rejectLivePreservedOwnedSessionHandle({ state, session });
      try {
        await cleanupSandboxSession(session);
        forgetLivePreservedOwnedSessionHandle({ state, session });
        for (const agentKey of agentKeys) {
          closedAgentKeys.add(agentKey);
        }
      } catch (error) {
        closeErrors.push(error);
      }
    }
    return { closedAgentKeys, closeErrors };
  }

  private async runPreStopHooksBeforeRelease(): Promise<void> {
    const shouldRunForOwnedSessions = Boolean(
      this.sandboxConfig?.client?.serializeSessionState,
    );
    const sessionsForPreStop = new Set<
      SandboxSessionLike<SandboxSessionState>
    >();
    const sessionsForHooks = new Set<SandboxSessionLike<SandboxSessionState>>();

    for (const [agentKey, session] of this.sessionsByAgentKey) {
      if (!this.ownedSessionAgentKeys.has(agentKey)) {
        sessionsForPreStop.add(session);
        continue;
      }

      // Owned sessions without serialization run hooks through the close lifecycle.
      if (shouldRunForOwnedSessions) {
        sessionsForHooks.add(session);
      }
    }

    for (const session of sessionsForPreStop) {
      await runSandboxSessionPreStop(session);
    }
    for (const session of sessionsForHooks) {
      if (!sessionsForPreStop.has(session)) {
        await runSandboxSessionPreStopHooks(session);
      }
    }
  }

  async enqueueMemoryGeneration(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    args: {
      exception?: unknown;
      groupId?: string;
      inputOverride?: string | AgentInputItem[];
      sdkSessionId?: () => Promise<string | undefined>;
      runAgent: SandboxMemoryAgentRunner;
      tracingParent?: Span<any> | Trace;
    },
  ): Promise<void> {
    if (!this.activeMemory || this.activeMemory.memory.generate === null) {
      return;
    }

    try {
      const manager = getOrCreateSandboxMemoryGenerationManager({
        session: this.activeMemory.session,
        memory: this.activeMemory.memory,
        runAs: this.activeMemory.runAs,
        runAgent: args.runAgent,
        tracingParent: args.tracingParent,
      });
      await manager.enqueueState(state, {
        exception: args.exception,
        inputOverride: args.inputOverride,
        rolloutIdentity: {
          conversationId: state._conversationId ?? undefined,
          sdkSessionId: await args.sdkSessionId?.(),
          groupId: args.groupId,
        },
      });
    } catch (error) {
      logModelAndToolActionWarning(
        logger,
        'Failed to enqueue sandbox memory generation:',
        error,
      );
    }
  }

  async adoptPreservedOwnedSessions(
    tracingParent?: Span<any> | Trace,
  ): Promise<boolean> {
    const sandboxState = getSerializedSandboxState(this.runState);
    if (!hasPreservedOwnedSessions(sandboxState)) {
      return false;
    }

    const client = this.sandboxConfig?.client;
    if (!client) {
      throw new UserError(
        'Sandbox client must be configured to restore preserved sandbox sessions.',
      );
    }
    if (sandboxState && sandboxState.backendId !== client.backendId) {
      throw new UserError(
        'RunState sandbox backend does not match the configured sandbox client.',
      );
    }

    const preservedEntries = Object.entries(
      getPreviousSerializedSessionsByAgent(sandboxState, client),
    ).filter(([, entry]) => entry.preservedOwnedSession);
    let resumedSession = false;

    for (const [agentKey] of preservedEntries) {
      if (this.sessionsByAgentKey.has(agentKey)) {
        continue;
      }
      const entry = getSerializedSessionEntryForAgent(
        getSerializedSandboxState(this.runState),
        agentKey,
      );
      if (!entry?.preservedOwnedSession) {
        continue;
      }
      const liveDecision = await this.inspectLivePreservedOwnedSessionReuse({
        client,
        agentKey,
        serializedEntry: entry,
        trustedManifest: this.resolveTrustedManifestForAgentKey(agentKey),
      });
      if (liveDecision?.reusable) {
        this.sessionsByAgentKey.set(agentKey, liveDecision.entry.session);
        this.sessionAgentNamesByKey.set(
          agentKey,
          liveDecision.entry.currentAgentName,
        );
        this.ownedSessionAgentKeys.add(agentKey);
        continue;
      }
      if (liveDecision?.mountAuthorityChanged) {
        await this.discardLiveSessionWithChangedMountAuthority(liveDecision);
        continue;
      }
      const trustedManifest = this.resolveTrustedManifestForAgentKey(agentKey);
      if (
        client.serializedSessionStateRequiresFreshCreation ||
        serializedSessionEntryRequiresFreshMountAuthority(entry) ||
        (trustedManifest &&
          (manifestHasInContainerMounts(trustedManifest) ||
            manifestHasNonResumableMountAuthority(trustedManifest)))
      ) {
        if (liveDecision) {
          await this.discardLiveSessionWithChangedMountAuthority(liveDecision);
        } else {
          this.invalidateSerializedSession(agentKey);
        }
        continue;
      }
      if (!client.resume) {
        throw new UserError(
          'Sandbox client must implement resume() to restore preserved sandbox sessions.',
        );
      }
      const serializedState = await deserializeSandboxSessionStateEntry(
        client,
        entry,
        this.resolveTrustedManifestForAgentKey(agentKey),
        {
          clientOptions: this.sandboxConfig?.options,
          snapshot: this.sandboxConfig?.snapshot,
        },
      );
      if (!serializedState) {
        continue;
      }
      const rejectedLiveEntry =
        await this.prepareRejectedLiveSessionReplacement(client, liveDecision);
      let session = await withSandboxSpan(
        'sandbox.resume_session',
        {
          agent_name: entry.currentAgentName,
          backend_id: client.backendId,
        },
        async () =>
          await client.resume!(serializedState, {
            archiveLimits: this.sandboxConfig?.archiveLimits,
            clientOptions: this.sandboxConfig?.options,
          }),
        tracingParent,
      );
      session = await this.replaceRejectedLiveSession(
        rejectedLiveEntry,
        session,
      );
      this.applyArchiveLimits(session);
      this.sessionsByAgentKey.set(agentKey, session);
      this.sessionAgentNamesByKey.set(agentKey, entry.currentAgentName);
      this.ownedSessionAgentKeys.add(agentKey);
      resumedSession = true;
    }
    return resumedSession;
  }

  private acquireAgent(agent: SandboxAgent<TContext, AgentOutputType>): void {
    const agentId = getObjectId(agent);
    if (this.acquiredAgents.has(agentId)) {
      return;
    }
    acquireSandboxAgent(agent);
    this.acquiredAgents.set(agentId, agent);
  }

  private async ensureSession(
    agent: SandboxAgent<TContext, AgentOutputType>,
    tracingParent?: Span<any> | Trace,
  ): Promise<SandboxSessionLike<SandboxSessionState>> {
    const agentId = getObjectId(agent);
    const agentKey = this.agentKey(agent);
    const existing = this.sessionsByAgent.get(agentId);
    if (existing) {
      assertSandboxSessionStateUsable(existing.state);
      this.currentAgentId = agentId;
      return existing;
    }
    const existingByKey = this.sessionsByAgentKey.get(agentKey);
    if (existingByKey) {
      assertSandboxSessionStateUsable(existingByKey.state);
      this.applyArchiveLimits(existingByKey);
      await this.ensureSessionStarted(existingByKey, agent, 'resume', {
        oncePerSession: true,
        tracingParent,
      });
      this.currentAgentId = agentId;
      this.sessionsByAgent.set(agentId, existingByKey);
      this.sessionAgentNamesByKey.set(agentKey, agent.name);
      return existingByKey;
    }

    if (this.sandboxConfig?.session) {
      const session = this.sandboxConfig.session;
      assertSandboxSessionStateUsable(session.state);
      this.applyArchiveLimits(session);
      const configuredManifest = this.resolveConfiguredManifest(agent, {
        providedSession: session,
      });
      // Provided sessions are already running, so only a safe additive manifest delta can
      // be applied instead of reprovisioning root, env, users, groups, or mounts.
      await applyManifestToProvidedSession(
        session,
        configuredManifest.manifest,
        sandboxRunAsName(agent.runAs),
      );
      await this.ensureSessionStarted(session, agent, 'provided', {
        oncePerSession: true,
        tracingParent,
      });
      this.registerSessionForAgent(agent, session);
      return session;
    }

    const configuredManifest = this.resolveConfiguredManifest(agent);
    validateMountCredentialBoundaries(configuredManifest.manifest);

    const client = this.requireClient();
    const resumed = await this.resumeSessionForAgent(
      client,
      agent,
      configuredManifest.manifest,
      tracingParent,
    );
    if (resumed) {
      this.applyArchiveLimits(resumed);
      await this.ensureSessionStarted(resumed, agent, 'resume', {
        tracingParent,
      });
      this.registerSessionForAgent(agent, resumed, { owned: true });
      return resumed;
    }

    if (!client.create) {
      throw new UserError(
        'Sandbox execution requires a sandbox client with create() support.',
      );
    }
    const createManifest = await resolveAndValidateMountEnvironment(
      configuredManifest.manifest,
    );
    const createSession = client.create.bind(client);
    const createArgs: SandboxClientCreateArgs = {
      snapshot: this.resolveSnapshotSpec(client),
      options: this.sandboxConfig?.options,
      concurrencyLimits: this.sandboxConfig?.concurrencyLimits,
      archiveLimits: this.sandboxConfig?.archiveLimits,
    };
    if (configuredManifest.passToCreate) {
      createArgs.manifest = createManifest;
    }

    const session = await withSandboxSpan(
      'sandbox.create_session',
      {
        agent_name: agent.name,
        backend_id: client.backendId,
      },
      async () => await createSession(createArgs),
      tracingParent,
    );
    if (configuredManifest.passToCreate) {
      session.state.environment = {
        ...(session.state.environment ?? {}),
        ...(await createManifest.resolveEnvironment()),
      };
      const manifestWithTrustedPolicies = manifestWithTrustedRuntimePolicies(
        session.state.manifest,
        configuredManifest.manifest,
      );
      recordLiveMountCredentialAuthority(
        manifestWithTrustedPolicies,
        session.state.manifest,
      );
      session.state.manifest = manifestWithTrustedPolicies;
    }
    this.applyArchiveLimits(session);
    await this.ensureSessionStarted(session, agent, 'create', {
      tracingParent,
    });
    this.registerSessionForAgent(agent, session, { owned: true });
    return session;
  }

  private applyArchiveLimits(
    session: SandboxSessionLike<SandboxSessionState>,
  ): void {
    if (this.sandboxConfig?.archiveLimits === undefined) {
      return;
    }
    session.setArchiveLimits?.(this.sandboxConfig.archiveLimits);
  }

  private registerSessionForAgent(
    agent: SandboxAgent<TContext, AgentOutputType>,
    session: SandboxSessionLike<SandboxSessionState>,
    options: {
      owned?: boolean;
    } = {},
  ): void {
    const agentId = getObjectId(agent);
    const agentKey = this.agentKey(agent);
    this.currentAgentId = agentId;
    this.sessionsByAgent.set(agentId, session);
    this.sessionsByAgentKey.set(agentKey, session);
    this.sessionAgentNamesByKey.set(agentKey, agent.name);
    if (options.owned) {
      this.ownedSessionAgentKeys.add(agentKey);
      captureLiveMountCredentialAuthorityIfAbsent(
        session.state.manifest,
        session.state.environment,
      );
    }
  }

  private async ensureSessionStarted(
    session: SandboxSessionLike<SandboxSessionState>,
    agent: SandboxAgent<TContext, AgentOutputType>,
    reason: string,
    options: {
      oncePerSession?: boolean;
      tracingParent?: Span<any> | Trace;
    } = {},
  ): Promise<void> {
    if (!session.start) {
      return;
    }
    if (options.oncePerSession) {
      // Provided and resumed sessions may be shared by multiple agents in one run; keep
      // their provider-specific start hook idempotent.
      const started = this.sessionStartPromises.get(session);
      if (started) {
        await started;
        return;
      }
    }
    if (session.running && (await session.running())) {
      if (options.oncePerSession) {
        this.sessionStartPromises.set(session, Promise.resolve());
      }
      return;
    }

    const startPromise = withSandboxSpan(
      'sandbox.start',
      {
        agent_name: agent.name,
      },
      async () => {
        await session.start!({ reason });
      },
      options.tracingParent,
    );
    if (options.oncePerSession) {
      this.sessionStartPromises.set(session, startPromise);
    }
    try {
      await startPromise;
    } catch (error) {
      if (options.oncePerSession) {
        this.sessionStartPromises.delete(session);
      }
      throw error;
    }
  }

  private getPreparedAgent(
    agent: SandboxAgent<TContext, AgentOutputType>,
    session: SandboxSessionLike<SandboxSessionState>,
    runConfigModel?: SandboxRuntimeModel,
    tracingParent?: Span<any> | Trace,
  ): SandboxAgent<TContext, AgentOutputType> {
    const agentId = getObjectId(agent);
    const manifestSignature = getManifestSignature(session.state.manifest);
    const cached = this.preparedAgents.get(agentId);
    if (
      cached &&
      this.preparedSessions.get(agentId) === session &&
      this.preparedManifestSignatures.get(agentId) === manifestSignature
    ) {
      const cachedSandboxAgent = cached as SandboxAgent<
        TContext,
        AgentOutputType
      >;
      for (const capability of cachedSandboxAgent.capabilities) {
        capability.bindTracingParent(tracingParent);
      }
      return cachedSandboxAgent;
    }

    // Capability instructions include a rendered filesystem view, so a manifest change
    // invalidates the prepared-agent cache even when the live session object is unchanged.
    const prepared = prepareSandboxAgent({
      agent,
      session,
      capabilities: cloneSandboxCapabilities(agent.capabilities),
      runConfigModel,
      processManifest: false,
      tracingParent,
      workspaceScope: this.workspaceScope,
    });
    this.preparedAgents.set(agentId, prepared);
    this.preparedSessions.set(agentId, session);
    this.preparedManifestSignatures.set(agentId, manifestSignature);
    return prepared;
  }

  private async ensureWorkspaceScopeAccessible(
    session: SandboxSessionLike<SandboxSessionState>,
    runAs?: string,
  ): Promise<void> {
    const cwd = this.workspaceScope.cwd;
    if (cwd === undefined) {
      return;
    }
    if (!session.directoryExists) {
      throw new UserError(
        'Sandbox sessions used with sandbox.cwd must provide directoryExists().',
      );
    }

    const accessible = await session.directoryExists(cwd, runAs);
    if (!accessible) {
      throw new UserError(
        `Sandbox working directory "${cwd}" does not exist or is not accessible.`,
      );
    }
  }

  private async resumeSessionForAgent(
    client: SandboxClient,
    agent: SandboxAgent<TContext, AgentOutputType>,
    trustedManifest: Manifest,
    tracingParent?: Span<any> | Trace,
  ): Promise<SandboxSessionLike<SandboxSessionState> | undefined> {
    const agentKey = this.agentKey(agent);
    const serializedEntry = getSerializedSessionEntryForAgent(
      getSerializedSandboxState(this.runState),
      agentKey,
    );
    const explicitSessionState = this.sandboxConfig?.sessionState
      ? await this.prepareExplicitSessionStateForResume(client, trustedManifest)
      : undefined;
    if (explicitSessionState && !client.resume) {
      throw new UserError(
        'Sandbox client must implement resume() to restore sandbox session state.',
      );
    }
    const liveDecision = await this.inspectLivePreservedOwnedSessionReuse({
      client,
      agentKey,
      serializedEntry,
      trustedManifest,
    });
    if (!explicitSessionState && liveDecision?.reusable) {
      return liveDecision.entry.session;
    }
    if (!explicitSessionState && liveDecision?.mountAuthorityChanged) {
      await this.discardLiveSessionWithChangedMountAuthority(liveDecision);
      return undefined;
    }
    if (
      !explicitSessionState &&
      (client.serializedSessionStateRequiresFreshCreation ||
        manifestHasInContainerMounts(trustedManifest) ||
        manifestHasNonResumableMountAuthority(trustedManifest) ||
        serializedSessionEntryRequiresFreshMountAuthority(serializedEntry))
    ) {
      if (liveDecision) {
        await this.discardLiveSessionWithChangedMountAuthority(liveDecision);
      } else {
        this.invalidateSerializedSession(agentKey);
      }
      return undefined;
    }
    if (!client.resume) {
      if (this.sandboxConfig?.sessionState || serializedEntry) {
        throw new UserError(
          'Sandbox client must implement resume() to restore sandbox session state.',
        );
      }
      return undefined;
    }
    if (explicitSessionState) {
      const rejectedLiveEntry =
        await this.prepareRejectedLiveSessionReplacement(
          client,
          liveDecision ? { ...liveDecision, reusable: false } : undefined,
        );
      const session = await withSandboxSpan(
        'sandbox.resume_session',
        {
          agent_name: agent.name,
          backend_id: client.backendId,
        },
        async () =>
          await client.resume!(explicitSessionState, {
            archiveLimits: this.sandboxConfig?.archiveLimits,
            clientOptions: this.sandboxConfig?.options,
          }),
        tracingParent,
      );
      return await this.replaceRejectedLiveSession(rejectedLiveEntry, session);
    }

    const serializedState = await deserializeSandboxSessionStateEntry(
      client,
      serializedEntry,
      trustedManifest,
      {
        clientOptions: this.sandboxConfig?.options,
        snapshot: this.sandboxConfig?.snapshot,
      },
    );
    if (!serializedState) {
      return undefined;
    }

    const rejectedLiveEntry = await this.prepareRejectedLiveSessionReplacement(
      client,
      liveDecision,
    );
    const session = await withSandboxSpan(
      'sandbox.resume_session',
      {
        agent_name: agent.name,
        backend_id: client.backendId,
      },
      async () =>
        await client.resume!(serializedState, {
          archiveLimits: this.sandboxConfig?.archiveLimits,
          clientOptions: this.sandboxConfig?.options,
        }),
      tracingParent,
    );
    return await this.replaceRejectedLiveSession(rejectedLiveEntry, session);
  }

  private async prepareExplicitSessionStateForResume(
    client: SandboxClient,
    trustedManifest: Manifest,
  ): Promise<SandboxSessionState> {
    const persistedState = this.sandboxConfig!.sessionState!;
    if (
      client.serializedSessionStateRequiresFreshCreation ||
      manifestHasInContainerMounts(trustedManifest) ||
      manifestHasNonResumableMountAuthority(trustedManifest) ||
      manifestHasInContainerMounts(persistedState.manifest) ||
      manifestHasNonResumableMountAuthority(persistedState.manifest)
    ) {
      throw new UserError(
        client.serializedSessionStateRequiresFreshCreation
          ? 'This sandbox provider cannot safely resume persisted session state. Create a fresh sandbox from current trusted configuration.'
          : 'Sandbox session state with in-container mounts cannot be resumed safely. Create a fresh sandbox from the current trusted manifest.',
      );
    }
    const resolvedTrustedManifest = resolveTrustedManifestForResume(
      client,
      trustedManifest,
      this.sandboxConfig?.options,
    )!;
    if (
      client.backendId === 'docker' &&
      Object.keys(persistedState.manifest.environment).some(
        (key) => !(key in trustedManifest.environment),
      )
    ) {
      throw new UserError(
        'Docker sandbox session state cannot be resumed because the current trusted manifest removes an environment variable. Start a fresh session from a snapshot instead.',
      );
    }
    const topologyReboundState = rebindPersistedMountCredentials(
      persistedState,
      resolvedTrustedManifest,
    );
    assertMountCredentialsRebound(topologyReboundState);
    if (
      !liveMountCredentialAuthorityMatches(
        persistedState.manifest,
        resolvedTrustedManifest,
      )
    ) {
      throw new SandboxMountError(
        'Sandbox session state mount authority does not match the current trusted manifest. Create a fresh sandbox from current trusted configuration.',
        undefined,
        'mount_config_invalid',
      );
    }
    const materializedTrustedManifest =
      await resolveAndValidateMountEnvironment(resolvedTrustedManifest);
    const credentialReboundState = rebindPersistedMountCredentials(
      topologyReboundState,
      materializedTrustedManifest,
    );
    const sessionState = rebindPersistedPathGrants(
      credentialReboundState,
      materializedTrustedManifest,
      {
        replaceWithTrustedManifest: client.backendId === 'docker',
      },
    );
    if (client.backendId === 'docker') {
      sessionState.environment = {
        ...(sessionState.environment ?? {}),
        ...(await materializedTrustedManifest.resolveEnvironment()),
      };
    }
    assertMountCredentialsRebound(sessionState);
    validateMountCredentialBoundaries(sessionState.manifest);
    validateMountEnvironmentCredentialBoundaries(
      sessionState.manifest,
      sessionState.environment ?? {},
    );
    assertHostPathGrantsRebound(sessionState);
    return sessionState;
  }

  private async inspectLivePreservedOwnedSessionReuse(args: {
    client: SandboxClient;
    agentKey: string;
    serializedEntry: ReturnType<typeof getSerializedSessionEntryForAgent>;
    trustedManifest?: Manifest;
  }): Promise<LivePreservedOwnedSessionReuseDecision | undefined> {
    const liveEntry = livePreservedOwnedSession({
      runState: this.runState,
      client: args.client,
      agentKey: args.agentKey,
      serializedEntry: args.serializedEntry,
    });
    if (!liveEntry) {
      return undefined;
    }

    assertTrustedManifestForDockerRunState(args.client, args.trustedManifest);

    if (liveEntry.reuseRejected) {
      return { entry: liveEntry, reusable: false };
    }

    if (isSandboxSessionStateUnsafe(liveEntry.session.state)) {
      rejectLivePreservedOwnedSessionHandle({
        state: this.runState,
        session: liveEntry.session,
      });
      return {
        entry: liveEntry,
        reusable: false,
        mountAuthorityChanged: true,
      };
    }
    const stateGeneration = captureSandboxStateGeneration(
      liveEntry.session.state,
    );

    const trustedManifest = resolveTrustedManifestForResume(
      args.client,
      args.trustedManifest,
      this.sandboxConfig?.options,
    );
    if (
      !trustedManifest ||
      manifestHasNonResumableMountAuthority(trustedManifest) ||
      !liveMountCredentialAuthorityMatches(
        liveEntry.session.state.manifest,
        trustedManifest,
      )
    ) {
      rejectLivePreservedOwnedSessionHandle({
        state: this.runState,
        session: liveEntry.session,
      });
      return {
        entry: liveEntry,
        reusable: false,
        mountAuthorityChanged: true,
      };
    }

    const canReuse = args.client.canReusePreservedOwnedSession;
    if (
      args.client.backendId === 'docker' &&
      Object.keys(liveEntry.session.state.manifest.environment).some(
        (key) => !(key in trustedManifest.environment),
      )
    ) {
      rejectLivePreservedOwnedSessionHandle({
        state: this.runState,
        session: liveEntry.session,
      });
      return { entry: liveEntry, reusable: false };
    }

    const candidateState = rebindPersistedPathGrants(
      liveEntry.session.state,
      trustedManifest,
      {
        replaceWithTrustedManifest: args.client.backendId === 'docker',
      },
    );
    replaceManifestMountCredentialExposurePolicy(
      candidateState.manifest,
      trustedManifest,
    );
    recordLiveMountCredentialAuthority(
      candidateState.manifest,
      liveEntry.session.state.manifest,
    );
    validateMountCredentialBoundaries(trustedManifest);
    if (args.client.backendId === 'docker') {
      candidateState.environment = {
        ...(liveEntry.session.state.environment ?? {}),
        ...(await trustedManifest.resolveEnvironment()),
      };
    }
    if (!canReuse) {
      const trustedEnvironment = await trustedManifest.resolveEnvironment();
      if (
        !liveMountEnvironmentAuthorityMatches(
          liveEntry.session.state.manifest,
          trustedManifest,
          trustedEnvironment,
        )
      ) {
        assertSandboxStateGenerationUnchanged(
          liveEntry.session.state,
          stateGeneration,
        );
        rejectLivePreservedOwnedSessionHandle({
          state: this.runState,
          session: liveEntry.session,
        });
        return {
          entry: liveEntry,
          reusable: false,
          mountAuthorityChanged: true,
        };
      }
      await refreshLiveEnvironmentReferences(
        candidateState,
        trustedManifest,
        trustedEnvironment,
      );
      assertSandboxStateGenerationUnchanged(
        liveEntry.session.state,
        stateGeneration,
      );
      liveEntry.session.state.manifest = candidateState.manifest;
      liveEntry.session.state.environment = candidateState.environment;
      return { entry: liveEntry, reusable: true };
    }
    if (
      !(await canReuse.call(args.client, candidateState, {
        clientOptions: this.sandboxConfig?.options,
        revalidateManifestEntries: true,
        trustedManifest,
      }))
    ) {
      assertSandboxStateGenerationUnchanged(
        liveEntry.session.state,
        stateGeneration,
      );
      rejectLivePreservedOwnedSessionHandle({
        state: this.runState,
        session: liveEntry.session,
      });
      return { entry: liveEntry, reusable: false };
    }

    if (args.client.backendId !== 'docker') {
      await refreshLiveEnvironmentReferences(candidateState, trustedManifest);
    }

    assertSandboxStateGenerationUnchanged(
      liveEntry.session.state,
      stateGeneration,
    );

    // Rebind only after the backend has verified that its live authority still
    // matches the current trusted manifest.
    const reboundManifest =
      args.client.backendId === 'docker'
        ? manifestWithTrustedRuntimePolicies(
            rebindPersistedPathGrants(
              liveEntry.session.state,
              trustedManifest,
              {
                replaceWithTrustedGrantSet: true,
              },
            ).manifest,
            trustedManifest,
          )
        : candidateState.manifest;
    recordLiveMountCredentialAuthority(
      reboundManifest,
      candidateState.manifest,
    );
    liveEntry.session.state.manifest = reboundManifest;
    liveEntry.session.state.environment = candidateState.environment;
    return { entry: liveEntry, reusable: true };
  }

  private async discardLiveSessionWithChangedMountAuthority(
    decision: LivePreservedOwnedSessionReuseDecision,
  ): Promise<void> {
    const session = decision.entry.session;
    const agentKeys = new Set([decision.entry.agentKey]);
    for (const entry of livePreservedOwnedSessionEntries(this.runState!)) {
      if (entry.session === session) {
        agentKeys.add(entry.agentKey);
      }
    }
    for (const [agentKey, mappedSession] of this.sessionsByAgentKey) {
      if (mappedSession === session) {
        agentKeys.add(agentKey);
      }
    }

    this.invalidateSerializedSessions(agentKeys);
    for (const agentKey of agentKeys) {
      this.sessionsByAgentKey.delete(agentKey);
      this.sessionAgentNamesByKey.delete(agentKey);
      this.ownedSessionAgentKeys.delete(agentKey);
    }
    for (const [agentId, mappedSession] of this.sessionsByAgent) {
      if (mappedSession !== session) {
        continue;
      }
      this.sessionsByAgent.delete(agentId);
      if (this.currentAgentId === agentId) {
        this.currentAgentId = undefined;
      }
    }
    for (const [agentId, preparedSession] of this.preparedSessions) {
      if (preparedSession !== session) {
        continue;
      }
      this.preparedSessions.delete(agentId);
      this.preparedAgents.delete(agentId);
      this.preparedManifestSignatures.delete(agentId);
    }
    if (this.activeMemory?.session === session) {
      this.activeMemory = undefined;
    }

    await cleanupSandboxSession(decision.entry.session);
    forgetLivePreservedOwnedSessionHandle({
      state: this.runState,
      session,
    });
  }

  private invalidateSerializedSession(agentKey: string): void {
    this.invalidateSerializedSessions(new Set([agentKey]));
  }

  private invalidateSerializedSessions(agentKeys: ReadonlySet<string>): void {
    const sandboxState = getSerializedSandboxState(this.runState);
    if (
      sandboxState &&
      !removeClosedSerializedSessions(sandboxState, agentKeys)
    ) {
      this.runState!._sandbox = undefined;
    }
  }

  private async prepareRejectedLiveSessionReplacement(
    client: SandboxClient,
    decision: LivePreservedOwnedSessionReuseDecision | undefined,
  ): Promise<LivePreservedOwnedSessionEntry | undefined> {
    if (!decision || decision.reusable) {
      return undefined;
    }
    if (client.backendId === 'docker') {
      return decision.entry;
    }
    await cleanupSandboxSession(decision.entry.session);
    forgetLivePreservedOwnedSessionHandle({
      state: this.runState,
      session: decision.entry.session,
    });
    return undefined;
  }

  private async replaceRejectedLiveSession(
    rejectedEntry: LivePreservedOwnedSessionEntry | undefined,
    replacement: SandboxSessionLike<SandboxSessionState>,
  ): Promise<SandboxSessionLike<SandboxSessionState>> {
    if (!rejectedEntry) {
      return replacement;
    }

    rememberRejectedLivePreservedOwnedSessionHandle({
      state: this.runState,
      source: rejectedEntry,
      session: replacement,
    });
    try {
      await cleanupSandboxSession(rejectedEntry.session);
    } catch (rejectedCleanupError) {
      try {
        await cleanupSandboxSession(replacement);
        forgetLivePreservedOwnedSessionHandle({
          state: this.runState,
          session: replacement,
        });
      } catch (replacementCleanupError) {
        throw new SandboxLifecycleError(
          'Failed to close the rejected live sandbox session and its replacement.',
          {
            errors: [rejectedCleanupError, replacementCleanupError],
          },
        );
      }
      throw rejectedCleanupError;
    }
    forgetLivePreservedOwnedSessionHandle({
      state: this.runState,
      session: rejectedEntry.session,
    });
    forgetLivePreservedOwnedSessionHandle({
      state: this.runState,
      session: replacement,
    });
    return replacement;
  }

  private async serializeState(
    args: {
      includeOwnedSessions?: boolean;
    } = {},
  ): Promise<SerializedSandboxState | undefined> {
    const currentAgent = this.currentAgentId
      ? this.acquiredAgents.get(this.currentAgentId)
      : undefined;
    const sandboxState = getSerializedSandboxState(this.runState);
    const preferredCurrentAgentKey = currentAgent
      ? this.agentKey(currentAgent)
      : sandboxState?.currentAgentKey;
    return await serializeSandboxRuntimeState({
      client: this.sandboxConfig?.client,
      sandboxState,
      sessionsByAgentKey: this.sessionsByAgentKey,
      sessionAgentNamesByKey: this.sessionAgentNamesByKey,
      ownedSessionAgentKeys: this.ownedSessionAgentKeys,
      trustedManifestForAgentKey: (agentKey) =>
        resolveTrustedManifestForResume(
          this.sandboxConfig!.client!,
          this.resolveTrustedManifestForAgentKey(agentKey),
          this.sandboxConfig?.options,
        ),
      clientOptions: this.sandboxConfig?.options,
      includeOwnedSessions: args.includeOwnedSessions,
      preferredCurrentAgentKey,
    });
  }

  private requireClient(): SandboxClient {
    if (!this.sandboxConfig?.client) {
      throw new UserError(
        'Sandbox execution requires `RunConfig.sandbox.client` unless a live session is provided.',
      );
    }
    return this.sandboxConfig.client;
  }

  private resolveSnapshotSpec(client: SandboxClient): SnapshotSpec | undefined {
    if (this.sandboxConfig?.snapshot) {
      return this.sandboxConfig.snapshot;
    }
    if (!client.supportsDefaultOptions) {
      return undefined;
    }
    return { type: 'local' };
  }

  private agentKey(agent: SandboxAgent<TContext, AgentOutputType>): string {
    const agentId = getObjectId(agent);
    const existing = this.agentKeys.get(agentId);
    if (existing) {
      this.agentsByKey.set(existing, agent);
      return existing;
    }

    const agentKey = this.allocateRuntimeAgentKey(agent.name);
    this.agentKeys.set(agentId, agentKey);
    this.agentsByKey.set(agentKey, agent);
    return agentKey;
  }

  private allocateRuntimeAgentKey(agentName: string): string {
    const usedKeys = new Set(this.agentKeys.values());
    if (!usedKeys.has(agentName)) {
      return agentName;
    }

    let suffix = 2;
    while (usedKeys.has(`${agentName}_${suffix}`)) {
      suffix += 1;
    }
    return `${agentName}_${suffix}`;
  }

  private resolveConfiguredManifest(
    agent: SandboxAgent<TContext, AgentOutputType>,
    options: {
      providedSession?: SandboxSessionLike<SandboxSessionState>;
    } = {},
  ): { manifest: Manifest; passToCreate: boolean } {
    const baseManifest =
      this.sandboxConfig?.manifest ??
      agent.defaultManifest ??
      options.providedSession?.state.manifest;
    const initialManifest = baseManifest
      ? cloneManifest(baseManifest)
      : new Manifest();
    const manifestWithIdentity = options.providedSession
      ? initialManifest
      : manifestWithRunAsUser(initialManifest, agent.runAs);
    const configuredManifest = cloneSandboxCapabilities(
      agent.capabilities,
    ).reduce(
      (manifest, capability) => capability.processManifest(manifest),
      manifestWithIdentity,
    );
    // Passing a truly default manifest to providers can override their natural root
    // defaults, so create() receives a manifest only when configuration changed it.
    return {
      manifest: configuredManifest,
      passToCreate:
        baseManifest !== undefined || !isDefaultManifest(configuredManifest),
    };
  }

  private resolveTrustedManifestForAgentKey(
    agentKey: string,
  ): Manifest | undefined {
    const agent = this.agentsByKey.get(agentKey);
    if (!agent || !isSandboxAgent(agent)) {
      return undefined;
    }
    return this.resolveConfiguredManifest(agent).manifest;
  }

  private async closeOwnedSessions(
    agentKeys?: Iterable<string>,
    options: {
      removeClosedSessionsFromSandboxState?: boolean;
      tracingParent?: Span<any> | Trace;
    } = {},
  ): Promise<ReadonlySet<string>> {
    const keysToClose = [...(agentKeys ?? this.ownedSessionAgentKeys)].filter(
      (agentKey) => this.ownedSessionAgentKeys.has(agentKey),
    );
    const sessionsToClose = new Map<
      SandboxSessionLike<SandboxSessionState>,
      {
        agentKeys: string[];
        agentName: string | undefined;
      }
    >();
    for (const agentKey of keysToClose) {
      const session = this.sessionsByAgentKey.get(agentKey);
      if (!session || !hasSessionCleanup(session)) {
        continue;
      }
      const existing = sessionsToClose.get(session);
      if (existing) {
        existing.agentKeys.push(agentKey);
      } else {
        sessionsToClose.set(session, {
          agentKeys: [agentKey],
          agentName: this.sessionAgentNamesByKey.get(agentKey),
        });
      }
    }
    if (sessionsToClose.size === 0) {
      return new Set();
    }

    const closedAgentKeys = new Set<string>();
    const closeErrors: unknown[] = [];
    await withSandboxSpan(
      'sandbox.cleanup_sessions',
      {
        session_count: sessionsToClose.size,
      },
      async (cleanupSessionsSpan) => {
        const sessions = [...sessionsToClose];
        const results = await Promise.allSettled(
          sessions.map(async ([session, { agentName }]) => {
            await withSandboxSpan(
              'sandbox.shutdown',
              {
                agent_name: agentName,
              },
              async () => {
                rejectLivePreservedOwnedSessionHandle({
                  state: this.runState,
                  session,
                });
                await cleanupSandboxSession(session);
                forgetLivePreservedOwnedSessionHandle({
                  state: this.runState,
                  session,
                });
              },
              cleanupSessionsSpan,
            );
          }),
        );
        for (const [index, result] of results.entries()) {
          const [session, { agentKeys }] = sessions[index]!;
          if (result.status === 'rejected') {
            closeErrors.push(result.reason);
            continue;
          }
          const closedKeys = new Set(agentKeys);
          if (options.removeClosedSessionsFromSandboxState) {
            this.invalidateSerializedSessions(closedKeys);
          }
          for (const agentKey of closedKeys) {
            this.sessionsByAgentKey.delete(agentKey);
            this.sessionAgentNamesByKey.delete(agentKey);
            this.ownedSessionAgentKeys.delete(agentKey);
            closedAgentKeys.add(agentKey);
          }
          for (const [agentId, mappedSession] of this.sessionsByAgent) {
            if (mappedSession === session) {
              this.sessionsByAgent.delete(agentId);
              if (this.currentAgentId === agentId) {
                this.currentAgentId = undefined;
              }
            }
          }
          for (const [agentId, preparedSession] of this.preparedSessions) {
            if (preparedSession === session) {
              this.preparedSessions.delete(agentId);
              this.preparedAgents.delete(agentId);
              this.preparedManifestSignatures.delete(agentId);
            }
          }
          if (this.activeMemory?.session === session) {
            this.activeMemory = undefined;
          }
        }
      },
      options.tracingParent,
    );
    if (closeErrors.length === 1) {
      throw closeErrors[0];
    }
    if (closeErrors.length > 1) {
      throw new SandboxLifecycleError(
        'Failed to close one or more owned sandbox sessions.',
        { errors: closeErrors },
      );
    }
    return closedAgentKeys;
  }

  private releaseAgents(): void {
    releaseSandboxAgents(this.acquiredAgents.values());
    this.acquiredAgents.clear();
  }
}

function getManifestSignature(manifest: Manifest): string {
  return stableJsonStringify({
    version: manifest.version,
    root: manifest.root,
    entries: manifest.entries,
    environment: serializeManifestEnvironment(manifest),
    users: manifest.users,
    groups: manifest.groups,
    extraPathGrants: manifest.extraPathGrants,
    remoteMountCommandAllowlist: manifest.remoteMountCommandAllowlist,
  });
}

function isDefaultManifest(manifest: Manifest): boolean {
  const defaultManifest = new Manifest();
  return (
    manifest.version === defaultManifest.version &&
    manifest.root === defaultManifest.root &&
    Object.keys(manifest.entries).length === 0 &&
    Object.keys(manifest.environment).length === 0 &&
    manifest.users.length === 0 &&
    manifest.groups.length === 0 &&
    manifest.extraPathGrants.length === 0 &&
    isDefaultRemoteMountCommandAllowlist(manifest.remoteMountCommandAllowlist)
  );
}

function manifestWithTrustedRuntimePolicies(
  manifest: Manifest,
  trustedManifest: Manifest,
): Manifest {
  const merged = new Manifest({
    version: manifest.version,
    root: manifest.root,
    entries: structuredClone(manifest.entries),
    environment: Object.fromEntries(
      Object.entries(trustedManifest.environment).map(([key, value]) => [
        key,
        value.init(),
      ]),
    ),
    users: structuredClone(manifest.users),
    groups: structuredClone(manifest.groups),
    extraPathGrants: structuredClone(manifest.extraPathGrants),
    remoteMountCommandAllowlist: [
      ...trustedManifest.remoteMountCommandAllowlist,
    ],
  });
  replaceManifestMountCredentialExposurePolicy(merged, trustedManifest);
  return merged;
}

async function refreshLiveEnvironmentReferences(
  state: SandboxSessionState,
  trustedManifest: Manifest | undefined,
  resolvedTrustedEnvironment?: Record<string, string>,
): Promise<void> {
  if (!trustedManifest) {
    return;
  }
  const referenceKeys = new Set([
    ...Object.entries(state.manifest.environment)
      .filter(([, value]) => isEnvValueReference(value))
      .map(([key]) => key),
    ...Object.entries(trustedManifest.environment)
      .filter(([, value]) => isEnvValueReference(value))
      .map(([key]) => key),
  ]);
  if (referenceKeys.size === 0) {
    return;
  }
  const resolvedEnvironment = Object.fromEntries(
    (
      await Promise.all(
        [...referenceKeys].map(async (key) => {
          const value = trustedManifest.environment[key];
          return value
            ? ([
                key,
                resolvedTrustedEnvironment?.[key] ?? (await value.resolve()),
              ] as const)
            : undefined;
        }),
      )
    ).filter((entry) => entry !== undefined),
  );
  const environment = { ...(state.environment ?? {}) };
  const manifestEnvironment = Object.fromEntries(
    Object.entries(state.manifest.environment)
      .filter(([key]) => !referenceKeys.has(key))
      .map(([key, value]) => [key, value.init()]),
  );
  for (const key of referenceKeys) {
    delete environment[key];
    const value = trustedManifest.environment[key];
    if (value) {
      manifestEnvironment[key] = value.init();
    }
  }
  const manifest = new Manifest({
    version: state.manifest.version,
    root: state.manifest.root,
    entries: structuredClone(state.manifest.entries),
    environment: manifestEnvironment,
    users: structuredClone(state.manifest.users),
    groups: structuredClone(state.manifest.groups),
    extraPathGrants: structuredClone(state.manifest.extraPathGrants),
    remoteMountCommandAllowlist: [
      ...state.manifest.remoteMountCommandAllowlist,
    ],
  });
  replaceManifestMountCredentialExposurePolicy(manifest, state.manifest);
  recordLiveMountCredentialAuthority(manifest, state.manifest);
  state.environment = {
    ...environment,
    ...resolvedEnvironment,
  };
  state.manifest = manifest;
}

function removeClosedPreservedOwnedSessions(
  sandboxState: SerializedSandboxState,
  agentKeys: ReadonlySet<string>,
): boolean {
  return removeClosedSerializedSessions(sandboxState, agentKeys, {
    requirePreservedSession: true,
  });
}

function lifecycleErrorForCloseErrors(
  message: string,
  errors: unknown[],
): unknown {
  return errors.length === 1
    ? errors[0]
    : new SandboxLifecycleError(message, { errors });
}

function removeClosedSerializedSessions(
  sandboxState: SerializedSandboxState,
  agentKeys: ReadonlySet<string>,
  options: {
    requirePreservedSession?: boolean;
  } = {},
): boolean {
  for (const agentKey of agentKeys) {
    delete sandboxState.sessionsByAgent[agentKey];
  }

  const remainingEntries = Object.values(sandboxState.sessionsByAgent);
  if (
    options.requirePreservedSession &&
    !remainingEntries.some((entry) => entry.preservedOwnedSession)
  ) {
    return false;
  }

  const currentEntry =
    sandboxState.sessionsByAgent[sandboxState.currentAgentKey];
  if (currentEntry) {
    sandboxState.currentAgentName = currentEntry.currentAgentName;
    sandboxState.sessionState = currentEntry.sessionState;
    return true;
  }

  const nextEntry = options.requirePreservedSession
    ? remainingEntries.find((entry) => entry.preservedOwnedSession)
    : remainingEntries[0];
  if (!nextEntry) {
    return false;
  }
  sandboxState.currentAgentKey = nextEntry.currentAgentKey;
  sandboxState.currentAgentName = nextEntry.currentAgentName;
  sandboxState.sessionState = nextEntry.sessionState;
  return true;
}
