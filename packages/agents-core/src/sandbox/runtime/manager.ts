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
import { SandboxLifecycleError } from '../errors';
import { cloneManifest, Manifest } from '../manifest';
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
  livePreservedOwnedSessionEntries,
  livePreservedOwnedSession,
  preservedOwnedSessionAgentKeysWithoutLiveReuse,
  rejectLivePreservedOwnedSessionHandle,
  rememberLivePreservedOwnedSessions,
  type LivePreservedOwnedSessionEntry,
} from './livePreservedSessions';
import { applyManifestToProvidedSession } from './providedSessionManifest';
import { serializeSandboxRuntimeState } from './sessionSerialization';
import {
  assertHostPathGrantsRebound,
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
  type SerializedSandboxState,
} from './sessionState';
import { withSandboxSpan } from './spans';
import { manifestWithRunAsUser, sandboxRunAsName } from './runAsManifest';

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
      cleanupPlan.deferredError = error;
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
      hasPreservedOwnedSessions(sandboxState) &&
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
          { tracingParent: options.tracingParent },
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
  ): Promise<{
    closedAgentKeys: Set<string>;
    closeErrors: unknown[];
  }> {
    const sessionAgentKeys = new Map<
      SandboxSessionLike<SandboxSessionState>,
      string[]
    >();
    for (const entry of livePreservedOwnedSessionEntries(state)) {
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

    for (const [agentKey, entry] of preservedEntries) {
      if (this.sessionsByAgentKey.has(agentKey)) {
        continue;
      }
      const liveEntry = await this.reusableLivePreservedOwnedSession({
        client,
        agentKey,
        serializedEntry: entry,
        trustedManifest: this.resolveTrustedManifestForAgentKey(agentKey),
      });
      if (liveEntry) {
        this.sessionsByAgentKey.set(agentKey, liveEntry.session);
        this.sessionAgentNamesByKey.set(agentKey, liveEntry.currentAgentName);
        this.ownedSessionAgentKeys.add(agentKey);
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
      const session = await withSandboxSpan(
        'sandbox.resume_session',
        {
          agent_name: entry.currentAgentName,
          backend_id: client.backendId,
        },
        async () =>
          await client.resume!(serializedState, {
            archiveLimits: this.sandboxConfig?.archiveLimits,
          }),
        tracingParent,
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
      this.currentAgentId = agentId;
      return existing;
    }
    const existingByKey = this.sessionsByAgentKey.get(agentKey);
    if (existingByKey) {
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
    const createSession = client.create.bind(client);
    const createArgs: SandboxClientCreateArgs = {
      snapshot: this.resolveSnapshotSpec(client),
      options: this.sandboxConfig?.options,
      concurrencyLimits: this.sandboxConfig?.concurrencyLimits,
      archiveLimits: this.sandboxConfig?.archiveLimits,
    };
    if (configuredManifest.passToCreate) {
      createArgs.manifest = configuredManifest.manifest;
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
    });
    this.preparedAgents.set(agentId, prepared);
    this.preparedSessions.set(agentId, session);
    this.preparedManifestSignatures.set(agentId, manifestSignature);
    return prepared;
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
    if (!client.resume) {
      if (this.sandboxConfig?.sessionState || serializedEntry) {
        throw new UserError(
          'Sandbox client must implement resume() to restore sandbox session state.',
        );
      }
      return undefined;
    }
    const liveEntry = await this.reusableLivePreservedOwnedSession({
      client,
      agentKey,
      serializedEntry,
      trustedManifest,
    });
    if (liveEntry) {
      return liveEntry.session;
    }

    if (this.sandboxConfig?.sessionState) {
      const sessionState = rebindPersistedPathGrants(
        this.sandboxConfig.sessionState,
        trustedManifest,
        {
          replaceWithTrustedManifest: client.backendId === 'docker',
        },
      );
      assertHostPathGrantsRebound(sessionState);
      return await withSandboxSpan(
        'sandbox.resume_session',
        {
          agent_name: agent.name,
          backend_id: client.backendId,
        },
        async () =>
          await client.resume!(sessionState, {
            archiveLimits: this.sandboxConfig?.archiveLimits,
          }),
        tracingParent,
      );
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

    return await withSandboxSpan(
      'sandbox.resume_session',
      {
        agent_name: agent.name,
        backend_id: client.backendId,
      },
      async () =>
        await client.resume!(serializedState, {
          archiveLimits: this.sandboxConfig?.archiveLimits,
        }),
      tracingParent,
    );
  }

  private async reusableLivePreservedOwnedSession(args: {
    client: SandboxClient;
    agentKey: string;
    serializedEntry: ReturnType<typeof getSerializedSessionEntryForAgent>;
    trustedManifest?: Manifest;
  }): Promise<LivePreservedOwnedSessionEntry | undefined> {
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
      await cleanupSandboxSession(liveEntry.session);
      forgetLivePreservedOwnedSessionHandle({
        state: this.runState,
        session: liveEntry.session,
      });
      return undefined;
    }

    const canReuse = args.client.canReusePreservedOwnedSession;
    if (!canReuse) {
      return liveEntry;
    }

    const candidateState = args.trustedManifest
      ? rebindPersistedPathGrants(
          liveEntry.session.state,
          args.trustedManifest,
          {
            replaceWithTrustedManifest: args.client.backendId === 'docker',
          },
        )
      : liveEntry.session.state;
    if (args.client.backendId === 'docker' && args.trustedManifest) {
      candidateState.environment = {
        ...(liveEntry.session.state.environment ?? {}),
        ...(await args.trustedManifest.resolveEnvironment()),
      };
    }
    if (!(await canReuse.call(args.client, candidateState))) {
      rejectLivePreservedOwnedSessionHandle({
        state: this.runState,
        session: liveEntry.session,
      });
      await cleanupSandboxSession(liveEntry.session);
      forgetLivePreservedOwnedSessionHandle({
        state: this.runState,
        session: liveEntry.session,
      });
      return undefined;
    }

    // Rebind only after the backend has verified that its live authority still
    // matches the current trusted manifest.
    liveEntry.session.state.manifest =
      args.client.backendId === 'docker' && args.trustedManifest
        ? rebindPersistedPathGrants(
            liveEntry.session.state,
            args.trustedManifest,
            {
              replaceWithTrustedGrantSet: true,
            },
          ).manifest
        : candidateState.manifest;
    if (args.client.backendId === 'docker') {
      liveEntry.session.state.environment = candidateState.environment;
    }
    return liveEntry;
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

    await withSandboxSpan(
      'sandbox.cleanup_sessions',
      {
        session_count: sessionsToClose.size,
      },
      async (cleanupSessionsSpan) => {
        await Promise.all(
          [...sessionsToClose].map(async ([session, { agentName }]) => {
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
              },
              cleanupSessionsSpan,
            );
          }),
        );
      },
      options.tracingParent,
    );
    return new Set(
      [...sessionsToClose.values()].flatMap(({ agentKeys }) => agentKeys),
    );
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

function removeClosedPreservedOwnedSessions(
  sandboxState: SerializedSandboxState,
  agentKeys: ReadonlySet<string>,
): boolean {
  return removeClosedSerializedSessions(sandboxState, agentKeys, {
    requirePreservedSession: true,
  });
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
