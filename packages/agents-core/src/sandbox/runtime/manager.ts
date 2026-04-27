import type { Agent, AgentOutputType } from '../../agent';
import logger from '../../logger';
import { UserError } from '../../errors';
import type { RunState } from '../../runState';
import type { AgentInputItem } from '../../types';
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
  isSandboxAgent,
  releaseSandboxAgents,
} from './agentKeys';
import {
  forgetLivePreservedOwnedSessions,
  livePreservedOwnedSessionEntries,
  livePreservedOwnedSession,
  preservedOwnedSessionAgentKeysWithoutLiveReuse,
  rememberLivePreservedOwnedSessions,
} from './livePreservedSessions';
import { applyManifestToProvidedSession } from './providedSessionManifest';
import { serializeSandboxRuntimeState } from './sessionSerialization';
import {
  cleanupSandboxSession,
  hasSessionCleanup,
  runSandboxSessionPreStop,
  runSandboxSessionPreStopHooks,
} from './sessionLifecycle';
import {
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
  };
  deferredError?: unknown;
};

export class SandboxRuntimeManager<TContext> {
  private readonly sandboxConfig?: SandboxRunConfig;
  private readonly runState?: RunState<
    TContext,
    Agent<TContext, AgentOutputType>
  >;
  private readonly agentKeys: Map<number, string>;
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
    this.agentKeys = allocateAgentKeys(args.startingAgent);
  }

  async prepareAgent(args: {
    currentAgent: Agent<TContext, AgentOutputType>;
    turnInput: AgentInputItem[];
    runConfigModel?: SandboxRuntimeModel;
  }): Promise<SandboxPreparedAgent<TContext>> {
    const { currentAgent, turnInput, runConfigModel } = args;
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
      async () => {
        this.acquireAgent(currentAgent);
        const session = await this.ensureSession(currentAgent);
        // Bind a clone to the live session so capability tools and instructions can carry
        // per-session state without mutating the public SandboxAgent instance.
        const executionAgent = this.getPreparedAgent(
          currentAgent,
          session,
          runConfigModel,
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
    );
  }

  async cleanup(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    options: {
      preserveOwnedSessions?: boolean;
    } = {},
  ): Promise<void> {
    const preserveOwnedSessions = options.preserveOwnedSessions ?? false;
    const runCleanup = async () => {
      let preserveCleanupHandles = false;
      try {
        const cleanupPlan = await this.planCleanup(state, {
          preserveOwnedSessions,
        });
        await this.executeCleanupPlan(state, cleanupPlan, {
          onCloseError: () => {
            preserveCleanupHandles = true;
          },
        });
      } finally {
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
      await runCleanup();
      return;
    }

    await withSandboxSpan('sandbox.cleanup', {}, runCleanup);
  }

  private async planCleanup(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    options: {
      preserveOwnedSessions: boolean;
    },
  ): Promise<SandboxCleanupPlan> {
    if (this.sessionsByAgentKey.size > 0) {
      return await this.planCleanupForActiveSessions(state, options);
    }
    return await this.planCleanupForSerializedStateOnly(state, options);
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
      const closedLiveSessionAgentKeys =
        await this.closeLivePreservedOwnedSessions(state);
      if (closedLiveSessionAgentKeys.size > 0) {
        forgetLivePreservedOwnedSessions(state);
        if (
          sandboxState &&
          !removeClosedPreservedOwnedSessions(
            sandboxState,
            closedLiveSessionAgentKeys,
          )
        ) {
          state._sandbox = undefined;
          sandboxState = undefined;
        }
      }

      if (hasPreservedOwnedSessions(sandboxState)) {
        if (this.sandboxConfig?.client) {
          try {
            await this.adoptPreservedOwnedSessions();
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
        }
      } else if (closedLiveSessionAgentKeys.size > 0) {
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
    },
  ): Promise<void> {
    if (plan.ownedSessionCloseTarget) {
      try {
        await this.closeOwnedSessions(
          plan.ownedSessionCloseTarget === 'all'
            ? undefined
            : plan.ownedSessionCloseTarget,
        );
      } catch (error) {
        options.onCloseError();
        throw error;
      }

      if (plan.afterOwnedSessionClose?.forgetLivePreservedSessions) {
        forgetLivePreservedOwnedSessions(state);
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
  ): Promise<Set<string>> {
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
      try {
        await cleanupSandboxSession(session);
        for (const agentKey of agentKeys) {
          closedAgentKeys.add(agentKey);
        }
      } catch (error) {
        closeErrors.push(error);
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
    return closedAgentKeys;
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
      logger.warn(`Failed to enqueue sandbox memory generation: ${error}`);
    }
  }

  async adoptPreservedOwnedSessions(): Promise<boolean> {
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
      const liveEntry = livePreservedOwnedSession({
        runState: this.runState,
        client,
        agentKey,
        serializedEntry: entry,
      });
      if (liveEntry) {
        // Same RunState can resume immediately without round-tripping through provider
        // reconnect APIs when the backend says its live handle is reusable.
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
        async () => await client.resume!(serializedState),
      );
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
      await this.ensureSessionStarted(existingByKey, agent, 'resume', {
        oncePerSession: true,
      });
      this.currentAgentId = agentId;
      this.sessionsByAgent.set(agentId, existingByKey);
      this.sessionAgentNamesByKey.set(agentKey, agent.name);
      return existingByKey;
    }

    if (this.sandboxConfig?.session) {
      const session = this.sandboxConfig.session;
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
      });
      this.registerSessionForAgent(agent, session);
      return session;
    }

    const configuredManifest = this.resolveConfiguredManifest(agent);

    const client = this.requireClient();
    const resumed = await this.resumeSessionForAgent(client, agent);
    if (resumed) {
      await this.ensureSessionStarted(resumed, agent, 'resume');
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
    );
    await this.ensureSessionStarted(session, agent, 'create');
    this.registerSessionForAgent(agent, session, { owned: true });
    return session;
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
  ): SandboxAgent<TContext, AgentOutputType> {
    const agentId = getObjectId(agent);
    const manifestSignature = getManifestSignature(session.state.manifest);
    const cached = this.preparedAgents.get(agentId);
    if (
      cached &&
      this.preparedSessions.get(agentId) === session &&
      this.preparedManifestSignatures.get(agentId) === manifestSignature
    ) {
      return cached as SandboxAgent<TContext, AgentOutputType>;
    }

    // Capability instructions include a rendered filesystem view, so a manifest change
    // invalidates the prepared-agent cache even when the live session object is unchanged.
    const prepared = prepareSandboxAgent({
      agent,
      session,
      capabilities: cloneSandboxCapabilities(agent.capabilities),
      runConfigModel,
      processManifest: false,
    });
    this.preparedAgents.set(agentId, prepared);
    this.preparedSessions.set(agentId, session);
    this.preparedManifestSignatures.set(agentId, manifestSignature);
    return prepared;
  }

  private async resumeSessionForAgent(
    client: SandboxClient,
    agent: SandboxAgent<TContext, AgentOutputType>,
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
    const liveEntry = livePreservedOwnedSession({
      runState: this.runState,
      client,
      agentKey,
      serializedEntry,
    });
    if (liveEntry) {
      return liveEntry.session;
    }

    if (this.sandboxConfig?.sessionState) {
      return await withSandboxSpan(
        'sandbox.resume_session',
        {
          agent_name: agent.name,
          backend_id: client.backendId,
        },
        async () => await client.resume!(this.sandboxConfig!.sessionState!),
      );
    }

    const serializedState = await deserializeSandboxSessionStateEntry(
      client,
      serializedEntry,
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
      async () => await client.resume!(serializedState),
    );
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
      return existing;
    }

    const agentKey = this.allocateRuntimeAgentKey(agent.name);
    this.agentKeys.set(agentId, agentKey);
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

  private async closeOwnedSessions(
    agentKeys?: Iterable<string>,
  ): Promise<void> {
    const keysToClose = [...(agentKeys ?? this.ownedSessionAgentKeys)].filter(
      (agentKey) => this.ownedSessionAgentKeys.has(agentKey),
    );
    const sessionsToClose = new Map<
      SandboxSessionLike<SandboxSessionState>,
      string | undefined
    >();
    for (const agentKey of keysToClose) {
      const session = this.sessionsByAgentKey.get(agentKey);
      if (!session || !hasSessionCleanup(session)) {
        continue;
      }
      if (!sessionsToClose.has(session)) {
        sessionsToClose.set(session, this.sessionAgentNamesByKey.get(agentKey));
      }
    }
    if (sessionsToClose.size === 0) {
      return;
    }

    await withSandboxSpan(
      'sandbox.cleanup_sessions',
      {
        session_count: sessionsToClose.size,
      },
      async () => {
        await Promise.all(
          [...sessionsToClose].map(async ([session, agentName]) => {
            await withSandboxSpan(
              'sandbox.shutdown',
              {
                agent_name: agentName,
              },
              async () => {
                await cleanupSandboxSession(session);
              },
            );
          }),
        );
      },
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
  for (const agentKey of agentKeys) {
    delete sandboxState.sessionsByAgent[agentKey];
  }

  if (!hasPreservedOwnedSessions(sandboxState)) {
    return false;
  }

  const currentEntry =
    sandboxState.sessionsByAgent[sandboxState.currentAgentKey];
  if (currentEntry) {
    sandboxState.currentAgentName = currentEntry.currentAgentName;
    sandboxState.sessionState = currentEntry.sessionState;
    return true;
  }

  const nextEntry = Object.values(sandboxState.sessionsByAgent).find(
    (entry) => entry.preservedOwnedSession,
  );
  if (!nextEntry) {
    return false;
  }
  sandboxState.currentAgentKey = nextEntry.currentAgentKey;
  sandboxState.currentAgentName = nextEntry.currentAgentName;
  sandboxState.sessionState = nextEntry.sessionState;
  return true;
}
