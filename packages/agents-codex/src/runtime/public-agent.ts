import { assertOutputState, sessionStateSchema } from './state';
import { openSession, runOwnedSession, type SessionSetup } from './agent';
import { nativeAgentConfig } from './agent-configuration';
import { collaborationTools } from './native-agents';
import { binding, type JsonObject } from './binding';
import { prepareOutput, type OutputSpec, type PreparedOutput } from './output';
import { webSearchName } from './web-search';
import { NativeError } from './native-error';

import { Environment } from './environment';
import {
  loadInstructionFiles,
  type InstructionFileReceipt,
} from './turn-receipt';
import {
  acquireEnvironment,
  releaseEnvironmentBeforeProvider,
  type EnvironmentAcquisition,
  type EnvironmentSource,
} from './environment-source';
import type { UserInput } from './input';
import { nativeInput } from './input';
import type { ManualToolReply, ManualToolRequest } from './manual';
import type { NativeQuestion, NativeQuestionReply } from './native-questions';
import {
  ChatGPTAppsMCP,
  isHostedRegistration,
  mcpConfig,
  mcpToolNames,
  splitToolDeclarations,
} from './mcp';
import {
  NativeProvider,
  type ModelSettings,
  type ProviderLease,
} from './provider';
import type { SessionState } from './state';
import { nativeGoalToolNames } from './goals';
import { localStoragePath, type LocalStorage } from './local-storage';
import { captureReconciledCalls, type ReconciledCall } from './local-recovery';
import { captureTools, toolIdentity, type Tool } from './tools';
import { validateMaxModelSteps, type OperationOptions } from './session';
import type {
  Session as CoreSession,
  SessionOptions as CoreSessionOptions,
  Completed,
  OneShotOptions,
} from './session';

export interface AgentOptions<Context = undefined, Output = string> {
  instructions: string;
  name?: string;
  model?: string;
  modelSettings?: ModelSettings;
  provider?: NativeProvider;
  outputType?: OutputSpec<Output>;
  tools?: readonly Tool<Context>[];
  programmaticToolCalling?: boolean;
}

export interface SessionOptions<Context = undefined> {
  context?: Context;
  state?: SessionState;
  /** Borrow this provider instead of the Agent provider. */
  provider?: NativeProvider;
  /** Override the Agent model for a new conversation; omit when restoring state. */
  model?: string;
  /** Merge defined keys over Agent settings; null serviceTier clears its override. */
  modelSettings?: ModelSettings;
  storage?: LocalStorage;
  resume?: string;
  /** Application-confirmed outcomes for unknown calls on this local resume. */
  reconciledCalls?: readonly ReconciledCall[];
  environment?: Environment<Context> | EnvironmentSource<Context>;
  /**
   * Load trusted UTF-8 instruction files in the supplied order at opening.
   * Use files and parent directories that untrusted actors cannot modify.
   */
  instructionFiles?: readonly string[];
  /** Cancel opening and join cleanup. Agent.run retains this signal until completion. */
  signal?: AbortSignal;
  /**
   * Read shared guidance from .claude/rules under the explicit Environment.cwd.
   * Requires a fresh opt-in when restoring; never selects an ambient project.
   */
  projectGuidance?: boolean;
  /** Replace opening declarations. Omission inherits Agent.tools; [] removes them. */
  tools?: readonly Tool<Context>[];
}

export interface RunOptions<Context = undefined> extends Omit<
  SessionOptions<Context>,
  'tools' | 'storage' | 'resume' | 'reconciledCalls'
> {
  /** Root model preparation limit for a new run. Resumed runs inherit their saved budget. */
  maxModelSteps?: OperationOptions<Context>['maxModelSteps'];
  returnState?: boolean;
  onNativeQuestion?: (
    request: NativeQuestion,
    signal: AbortSignal,
  ) => NativeQuestionReply | Promise<NativeQuestionReply>;
  onInteraction?: (
    action: ManualToolRequest,
    signal: AbortSignal,
  ) => ManualToolReply | Promise<ManualToolReply>;
}

const ownedRun = Symbol('ownedRun');
const correctionOpening = Symbol('correctionOpening');
const deferredOpening = Symbol('deferredOpening');
const outputSelection = Symbol('outputSelection');
interface CapturedOpening {
  readonly agent: Agent<any, any>;
  readonly factory: Agent<any, any>['session'];
  readonly instructions: string;
  readonly instructionFiles: readonly InstructionFileReceipt[];
  readonly name?: string;
  readonly model?: string;
  readonly settings?: ModelSettings;
  readonly programmaticToolCalling: boolean;
  readonly declarations: ReturnType<typeof splitToolDeclarations>;
  readonly output: PreparedOutput;
  readonly outputType?: OutputSpec<unknown>;
  readonly provider: NativeProvider;
  readonly apiKey: string | undefined;
  readonly context: unknown;
}
type OwnedSessionOptions<Context> = SessionOptions<Context> & {
  [outputSelection]?: OutputSpec<unknown>;
  [ownedRun]?: OneShotOptions;
  [deferredOpening]?: {
    readonly opening: CapturedOpening;
    readonly restoredOutput: {
      readonly output: PreparedOutput;
      readonly outputOverride: boolean;
    };
    readonly opened: (session: CoreSession<any, any>) => void;
  };
  [correctionOpening]?: {
    readonly apiKey: string | undefined;
    readonly retainOpening: (
      owner: Pick<ProviderLease, 'failedOpeningCleanup'>,
    ) => void;
  };
};

type SessionArguments<Context> = undefined extends Context
  ? [options?: SessionOptions<Context>]
  : [options: SessionOptions<Context> & { context: Context }];
type RunArguments<Context> = undefined extends Context
  ? [options?: RunOptions<Context>]
  : [options: RunOptions<Context> & { context: Context }];

/** A fixed output choice backed by an Agent's current opening configuration. */
export interface AgentOutput<Context = undefined, Output = string> {
  readonly outputType: OutputSpec<Output>;
  session(
    ...args: SessionArguments<Context>
  ): Promise<Session<Output, Context>>;
  run(
    input: UserInput | null,
    ...args: RunArguments<Context>
  ): Promise<Completed<Output>>;
}

/** One owned native conversation. Use submit for new input and active-turn steering. */
export type Session<Output = string, Context = any> = Pick<
  CoreSession<Output, Context>,
  | 'id'
  | 'capabilities'
  | 'checkpointStatus'
  | 'submit'
  | 'submitWithOutput'
  | 'enqueue'
  | 'respond'
  | 'wait'
  | 'events'
  | 'interactions'
  | 'pendingInteractions'
  | 'items'
  | 'turns'
  | 'rateLimits'
  | 'goal'
  | 'subagents'
  | 'checklist'
  | 'update'
  | 'interrupt'
  | 'compact'
  | 'executeCommand'
  | 'saveState'
  | 'fork'
  | 'suspend'
  | 'close'
  | typeof Symbol.asyncDispose
>;

/** A declaration; opening a Session captures its current configuration. */
export class Agent<Context = undefined, Output = string> {
  instructions: string;
  name?: string;
  model?: string;
  modelSettings?: ModelSettings;
  provider: NativeProvider;
  outputType?: OutputSpec<Output>;
  tools: readonly Tool<Context>[];
  programmaticToolCalling: boolean;

  constructor(options: AgentOptions<Context, Output>) {
    if (typeof options.instructions !== 'string')
      throw new TypeError('Agent instructions are required');
    this.instructions = options.instructions;
    this.name = options.name;
    this.model = options.model;
    this.modelSettings = options.modelSettings && { ...options.modelSettings };
    this.provider = options.provider ?? new NativeProvider();
    this.outputType = options.outputType;
    this.tools = [...(options.tools ?? [])];
    this.programmaticToolCalling = options.programmaticToolCalling ?? false;
  }

  /**
   * Select output for new runs and Sessions without changing this Agent.
   * Subclasses must opt in to output-independent, option-forwarding hooks.
   */
  withOutputType<Next>(
    outputType: OutputSpec<Next>,
  ): AgentOutput<Context, Next> {
    const selected =
      'mode' in outputType ? Object.freeze({ ...outputType }) : outputType;
    const optionsFor = (options: SessionOptions<Context> | undefined) => {
      if (!this.supportsOutputVariants())
        throw new TypeError(
          'Agent subclass must opt in through supportsOutputVariants() before using an output view',
        );
      return { ...options, [outputSelection]: selected };
    };
    return Object.freeze({
      outputType: selected,
      session: async (...args: SessionArguments<Context>) =>
        this.session(
          ...([optionsFor(args[0])] as SessionArguments<Context>),
        ) as unknown as Promise<Session<Next, Context>>,
      run: async (input: UserInput | null, ...args: RunArguments<Context>) =>
        this.run(
          input,
          ...([optionsFor(args[0])] as RunArguments<Context>),
        ) as unknown as Promise<Completed<Next>>,
    });
  }

  /**
   * Override only when hooks forward options and do not assume the default output
   * type. Output policies must inspect outputTypeFor(options), not this.outputType.
   */
  protected supportsOutputVariants(): boolean {
    return this.constructor === Agent;
  }

  /** Effective opening declaration, including captured deferred reopenings. */
  protected outputTypeFor(
    options: SessionOptions<Context> = {},
  ): OutputSpec<unknown> | undefined {
    const owned = options as OwnedSessionOptions<Context>;
    const opening = owned[deferredOpening]?.opening;
    return opening
      ? opening.outputType
      : (owned[outputSelection] ?? this.outputType);
  }

  /** Check default tool and output declarations without opening a Session. */
  async validate(): Promise<void> {
    const declarations = splitToolDeclarations(this.tools);
    const catalog = captureTools(declarations.tools);
    prepareOutput(this.outputType);
    const native = await binding();
    native._validate_python_tool_declarations(catalog.specsJson);
  }

  async session(
    ...args: SessionArguments<Context>
  ): Promise<Session<Output, Context>> {
    const options = { ...(args[0] ?? {}) };
    options.signal?.throwIfAborted();
    let acquiredEnvironment: EnvironmentAcquisition | undefined;
    let providerOwnsCleanup = false;
    try {
      const { setup, session, lease, environmentOwner } = await this.prepare(
        options,
        (owner) => {
          acquiredEnvironment = owner;
        },
        () => {
          providerOwnsCleanup = true;
        },
      );
      try {
        environmentOwner.signal.throwIfAborted();
        const opened = await openSession(
          setup,
          session,
          lease,
          (options as OwnedSessionOptions<Context>)[ownedRun],
        );
        environmentOwner.opened();
        (options as OwnedSessionOptions<Context>)[deferredOpening]?.opened(
          opened,
        );
        lease.openingSucceeded();
        return opened as CoreSession<Output, Context>;
      } catch (error) {
        return lease.failOpening(error);
      }
    } catch (error) {
      if (acquiredEnvironment && !providerOwnsCleanup) {
        try {
          await acquiredEnvironment.dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Session opening and environment cleanup failed',
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  async run(
    input: UserInput | null,
    ...args: RunArguments<Context>
  ): Promise<Completed<Output>> {
    const options = { ...(args[0] ?? {}) };
    if ('tools' in options)
      throw new TypeError(
        'Run tool selection is not supported; use Agent.session({ tools })',
      );
    for (const key of ['storage', 'resume', 'reconciledCalls'])
      if (key in options)
        throw new TypeError(`Agent.run does not support session-only ${key}`);
    // Validate input before acquiring a provider or touching the filesystem.
    const maxModelSteps = validateMaxModelSteps(options.maxModelSteps);
    if (input === null && maxModelSteps !== undefined)
      throw new TypeError(
        'Cannot replace the model step budget when resuming a run',
      );
    const preparedInput = input === null ? null : nativeInput(input);
    const factory = this.session;
    const sessionOptions: OwnedSessionOptions<Context> = {
      context: options.context,
      state: options.state,
      environment: options.environment,
      instructionFiles: options.instructionFiles,
      projectGuidance: options.projectGuidance,
      signal: options.signal,
      provider: options.provider,
      model: options.model,
      modelSettings: options.modelSettings,
      [outputSelection]: (options as OwnedSessionOptions<Context>)[
        outputSelection
      ],
      [ownedRun]: {
        input: preparedInput,
        onNativeQuestion: options.onNativeQuestion,
        onRequiredAction: options.onInteraction
          ? (action, signal) =>
              options.onInteraction!(action as ManualToolRequest, signal)
          : undefined,
      },
    };
    const session = await factory.apply(this, [
      sessionOptions,
    ] as SessionArguments<Context>);
    return runOwnedSession(session as CoreSession<Output>, preparedInput, {
      maxModelSteps,
      returnState: options.returnState,
      signal: options.signal,
    });
  }

  private async prepare(
    options: SessionOptions<Context>,
    acquiredEnvironment: (owner: EnvironmentAcquisition) => void,
    cleanupAcquired: () => void,
  ) {
    const projectGuidance = options.projectGuidance;
    if (projectGuidance !== undefined && typeof projectGuidance !== 'boolean')
      throw new TypeError('projectGuidance must be a boolean');
    const selection = (options as OwnedSessionOptions<Context>)[
      deferredOpening
    ];
    const opening = selection?.opening;
    if (opening && opening.agent !== this)
      throw new TypeError('Deferred opening belongs to a different Agent');
    if (
      selection &&
      (options.environment !== undefined ||
        options.storage !== undefined ||
        options.resume !== undefined)
    )
      throw new TypeError('Deferred opening requires a portable Session');
    const {
      instructions: baseInstructions,
      name,
      programmaticToolCalling,
    } = opening ?? this;
    const factory = opening ? opening.factory : this.session;
    const {
      provider: openingProvider,
      model: openingModel,
      modelSettings: openingSettings,
      state: suppliedState,
    } = options;
    if (
      !opening &&
      suppliedState != null &&
      (openingModel !== undefined || openingSettings !== undefined)
    )
      throw new TypeError(
        'Opening model and modelSettings cannot be used with state; update the restored Session when idle',
      );
    if (
      !opening &&
      openingProvider !== undefined &&
      !(openingProvider instanceof NativeProvider)
    )
      throw new TypeError('Opening provider must be a NativeProvider');
    if (
      !opening &&
      openingModel !== undefined &&
      typeof openingModel !== 'string'
    )
      throw new TypeError('Opening model must be a string');
    const provider = opening
      ? opening.provider
      : (openingProvider ?? this.provider);
    const model = opening ? opening.model : (openingModel ?? this.model);
    let settings = opening
      ? opening.settings
      : this.modelSettings && { ...this.modelSettings };
    if (!opening && openingSettings !== undefined) {
      if (
        openingSettings === null ||
        typeof openingSettings !== 'object' ||
        Array.isArray(openingSettings)
      )
        throw new TypeError('Opening modelSettings must be an object');
      settings ??= {};
      for (const key of Object.getOwnPropertyNames(openingSettings)) {
        if (
          !['reasoningEffort', 'reasoningSummary', 'serviceTier'].includes(key)
        )
          throw new TypeError(`Unsupported opening model setting: ${key}`);
        const value = openingSettings[key as keyof ModelSettings];
        if (value === undefined) continue;
        if (
          typeof value !== 'string' &&
          !(key === 'serviceTier' && value === null)
        )
          throw new TypeError(`Invalid opening model setting: ${key}`);
        Object.assign(settings, { [key]: value });
      }
    }
    const declarations = opening
      ? {
          ...opening.declarations,
          tools: [...opening.declarations.tools],
          mcp: [...opening.declarations.mcp],
        }
      : splitToolDeclarations(
          options.tools === undefined ? this.tools : options.tools,
        );
    const search = declarations.webSearch;
    const catalog = captureTools(declarations.tools);
    declarations.tools = [...catalog.tools];
    const {
      environment: environmentInput,
      context: suppliedContext,
      resume,
      storage: descriptor,
    } = options;
    const context = opening ? opening.context : suppliedContext;

    const storage =
      descriptor === undefined ? undefined : localStoragePath(descriptor);
    const reconciledCalls = captureReconciledCalls(options.reconciledCalls);
    if (
      reconciledCalls !== undefined &&
      (storage === undefined || typeof resume !== 'string' || !resume)
    )
      throw new TypeError('reconciledCalls requires local storage and resume');
    // Capture mutable declarations before file reads or environment acquisition.
    const stateResult =
      suppliedState == null
        ? undefined
        : sessionStateSchema.safeParse(suppliedState);
    const declaredOutput = this.outputTypeFor(options);
    const outputType =
      declaredOutput &&
      'mode' in declaredOutput &&
      !Object.isFrozen(declaredOutput)
        ? Object.freeze({ ...declaredOutput })
        : declaredOutput;
    const output = opening ? opening.output : prepareOutput(outputType);
    const { instructions, files } =
      !opening && options.instructionFiles !== undefined
        ? await loadInstructionFiles(
            baseInstructions,
            options.instructionFiles,
            options.signal,
          )
        : {
            instructions: baseInstructions,
            files: opening?.instructionFiles ?? [],
          };
    const environmentOwner = await acquireEnvironment(
      environmentInput,
      options.signal,
    );
    acquiredEnvironment(environmentOwner);
    const environment = environmentOwner.environment;
    if (projectGuidance && !(environment instanceof Environment))
      throw new TypeError('Project guidance requires an explicit Environment');
    if (declarations.nativeGoals && storage === undefined)
      throw new TypeError('NativeGoals requires explicit local storage');
    if (
      declarations.nativeGoals &&
      declarations.tools.some((tool) => {
        const identity = toolIdentity(tool);
        return (
          identity.namespace === 'functions' &&
          (nativeGoalToolNames as readonly string[]).includes(identity.name)
        );
      })
    )
      throw new TypeError(
        'NativeGoals reserves create_goal, get_goal and update_goal',
      );
    if (
      suppliedState != null &&
      (storage !== undefined || resume !== undefined)
    )
      throw new TypeError(
        'Portable state cannot be combined with local storage or resume',
      );
    if (stateResult && !stateResult.success) throw stateResult.error;
    const state = stateResult?.data;
    if (
      resume !== undefined &&
      (storage === undefined || typeof resume !== 'string' || !resume)
    )
      throw new TypeError(
        'resume requires local storage and a nonempty native Session ID',
      );
    if (
      storage !== undefined &&
      (declarations.mcp.length || programmaticToolCalling)
    )
      throw new TypeError(
        'Local storage supports current managed tools without MCP or Code Mode',
      );
    const nativeAgents = declarations.nativeAgents;
    if (
      nativeAgents &&
      (!environment ||
        !['exec_command', 'write_stdin', 'apply_patch'].every((tool) =>
          new Set<string>(environment.tools).has(tool),
        ))
    )
      throw new TypeError(
        'NativeAgents requires an Environment with all three execution tools',
      );
    if (nativeAgents && !model && state == null)
      throw new TypeError('NativeAgents requires an explicit compatible model');
    if (
      Array.isArray(state?.descendants) &&
      state.descendants.length > 0 &&
      !nativeAgents
    )
      throw new TypeError(
        'Restoring child state requires current NativeAgents',
      );
    if (
      programmaticToolCalling &&
      declarations.tools.some((tool) => {
        const identity = toolIdentity(tool);
        return (
          identity.namespace === 'functions' &&
          ['exec', 'wait'].includes(identity.name)
        );
      })
    )
      throw new TypeError('programmaticToolCalling reserves exec and wait');
    const activeOutput = selection?.restoredOutput.output ?? output;
    if (storage !== undefined && output.repair)
      throw new TypeError('Local storage does not support output repair');
    assertOutputState(state, activeOutput.identity);
    if (
      (activeOutput.prompt || activeOutput.schema != null) &&
      state?.format_version === 3
    )
      throw new TypeError(
        'Cannot restore a legacy pending manual checkpoint with structured or prompted output',
      );
    const deferredSchemas =
      declarations.tools.some((tool) => tool.deferLoading) ||
      declarations.mcp.some((server) => server.deferLoading);
    const selected = [
      ...(projectGuidance
        ? ['read_text_file', 'view_image'].map((name) => ({
            name,
            namespace: 'functions',
          }))
        : []),
      ...(search ? [webSearchName(search)] : []),
      ...declarations.tools.map(toolIdentity),
      ...(deferredSchemas
        ? [{ name: 'tool_search', namespace: 'functions' }]
        : []),
      ...(declarations.nativeGoals
        ? nativeGoalToolNames.map((name) => ({ name, namespace: 'functions' }))
        : []),
      ...mcpToolNames(declarations.mcp),
      ...(declarations.checklist
        ? [{ name: 'update_plan', namespace: 'functions' }]
        : []),
      ...(nativeAgents
        ? collaborationTools.map((name) => ({
            name,
            namespace: 'collaboration',
          }))
        : []),
      ...(environment?.tools ?? []).map((name) => ({
        name,
        namespace: 'functions',
      })),
      ...(programmaticToolCalling
        ? ['exec', 'wait'].map((name) => ({ name, namespace: 'functions' }))
        : []),
    ];
    const selectedPairs = new Set<string>();
    for (const identity of selected) {
      const key = JSON.stringify([identity.namespace, identity.name]);
      if (selectedPairs.has(key))
        throw new TypeError(
          `Duplicate selected tool ${identity.namespace}.${identity.name}`,
        );
      selectedPairs.add(key);
    }
    const config: JsonObject = {
      include_permissions_instructions: !!environment,
      include_environment_context: !!environment,
      'agents.enabled': false,
      'features.goals': declarations.nativeGoals,
      ...(storage === undefined
        ? {}
        : {
            'features.apps': false,
            'features.plugins': false,
            'features.tool_registry.error_on_tool_collisions': true,
          }),
      'tools.update_plan.enabled': declarations.checklist,
      mcp_servers: mcpConfig(
        declarations.mcp,
        environment,
        programmaticToolCalling,
      ),
      'features.non_prefixed_mcp_tool_names': false,
      'features.code_mode': {
        enabled: programmaticToolCalling,
        direct_only_tool_namespaces: programmaticToolCalling
          ? ['collaboration']
          : [
              ...new Set([
                'functions',
                ...(nativeAgents || deferredSchemas ? ['collaboration'] : []),
                ...(search?.route === 'standalone' ? ['web'] : []),
                ...declarations.tools.map(
                  (tool) => toolIdentity(tool).namespace,
                ),
                ...mcpToolNames(
                  declarations.mcp.filter((server) => !server.deferLoading),
                ).map((tool) => tool.namespace),
              ]),
            ],
      },
      'features.code_mode_interrupt': programmaticToolCalling,
      ...(programmaticToolCalling
        ? {
            'features.code_mode_host': {
              enabled: true,
              disable_in_process_fallback: true,
            },
          }
        : {}),
      web_search: search?.mode ?? 'disabled',
      'features.standalone_web_search': search?.route === 'standalone',
    };
    if (settings) {
      if (settings.reasoningEffort !== undefined)
        config.model_reasoning_effort = settings.reasoningEffort;
      if (settings.reasoningSummary !== undefined)
        config.model_reasoning_summary = settings.reasoningSummary;
      if (settings.serviceTier != null)
        config.service_tier = settings.serviceTier;
    }
    if (
      process.env.CODEX_SANDBOX === 'seatbelt' &&
      ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].some(
        (name) => process.env[name] || process.env[name.toLowerCase()],
      )
    )
      throw new Error(
        'The native runtime cannot honor HTTP proxy settings in seatbelt mode. Unset the proxy variables or run outside the sandbox.',
      );
    const correction = (options as OwnedSessionOptions<Context>)[
      correctionOpening
    ];

    const native = await binding();
    native._validate_python_tool_declarations(catalog.specsJson);
    environmentOwner.signal.throwIfAborted();
    const lease = provider._acquire(correction ?? opening);
    const previousOpeningCleanup: (() => Promise<void>) | undefined =
      lease.retainOpeningCleanup(() =>
        releaseEnvironmentBeforeProvider(
          environmentOwner,
          previousOpeningCleanup ?? lease.release,
        ),
      );
    cleanupAcquired();
    const apiKey = lease.apiKey;

    try {
      correction?.retainOpening(lease);
      const registration = declarations.mcp.find(isHostedRegistration);
      const personalApps = registration instanceof ChatGPTAppsMCP;
      if (personalApps && !lease.chatGPT)
        throw new TypeError(
          'ChatGPTAppsMCP requires explicit provider.chatGPT credentials',
        );
      // This live argument stays outside persisted configuration and checkpoints.
      const applicationAppsJson = registration
        ? JSON.stringify({
            kind: personalApps ? 'chatgpt' : 'verification',
            server: mcpConfig(
              [registration],
              environment,
              programmaticToolCalling,
            )[registration.name],
            ...(personalApps
              ? {
                  auth: {
                    access_token: lease.chatGPT!.accessToken,
                    account_id: lease.chatGPT!.accountId,
                  },
                }
              : {}),
          })
        : undefined;
      const home = await lease.open();
      environmentOwner.signal.throwIfAborted();
      if (nativeAgents)
        Object.assign(
          config,
          await nativeAgentConfig(nativeAgents, instructions, home.codex_home),
        );
      if (projectGuidance) config['features.view_image'] = true;
      const setup: SessionSetup = {
        name: name ?? '',
        instructions,
        model,
        tools: declarations.tools,
        apiKey: lease.apiKey,
        applicationAppsJson,
        config: {
          ...config,
          ...lease.config,
          'model_providers.native_agent': {
            ...(lease.config['model_providers.native_agent'] as JsonObject),
            supports_standalone_web_search: search?.route === 'standalone',
          },
        },
        runtime: {
          ...home,
          ...(storage === undefined
            ? {}
            : {
                native_thread_store: storage,
                ...(declarations.nativeGoals
                  ? { native_goal_store: storage }
                  : {}),
                ephemeral: false,
                ...(resume === undefined
                  ? {}
                  : { _sdk_resume_thread_id: resume }),
              }),
          ...(state &&
          (state.root_goal != null ||
            state.descendants?.some((child) => child.goal != null))
            ? { native_goal_store: home.codex_home }
            : {}),
          ...(nativeAgents
            ? { _native_agents: true, approval_policy: 'never' }
            : {}),
          strict_config: true,
          loader: { ignore_user_config: true, ignore_project_config: true },
          base_instructions:
            "You are an AI agent. Follow the application instructions and use the tools provided to complete the user's request accurately.",
          ...(environment ? { sandbox_mode: 'read-only' as const } : {}),
        },
        threadOptions: {
          ...(projectGuidance ? { _canonical_rules: true } : {}),
          ...(files.length ? { _sdk_instruction_files: [...files] } : {}),
          ...(resume === undefined ? {} : { _sdk_resume_thread_id: resume }),
          ...(reconciledCalls?.length
            ? { _sdk_reconciled_calls: reconciledCalls }
            : {}),
          ...(nativeAgents
            ? {
                _native_agent_roles: nativeAgents.additionalRoles.map(
                  (role) => role.name,
                ),
                _native_agent_max_depth: nativeAgents.maxDepth,
                _native_agent_before_step:
                  nativeAgents.beforeStep !== undefined,
              }
            : {}),
          tool_policy: {
            allowed_tools: selected,
            ...(environment
              ? {
                  require_managed_sandbox: true,
                  require_unified_exec: true,
                  expose_additional_permissions: false,
                }
              : {}),
          },
        },
      };
      const session: CoreSessionOptions = {
        state,
        localStorage: storage !== undefined,
        localResume: resume !== undefined,
        environment,
        context,
        applicationAgent: this,
        output,
        restoredOutput: selection?.restoredOutput,
        nativeAgents,
        webSearch: search,
        nativeGoals: declarations.nativeGoals,
        mcpTools: declarations.mcp.length ? declarations.mcp : undefined,
        initialModelSettings: settings,
        checklist: declarations.checklist,
        websocketsAllowed: lease.websocketsAllowed,
        onClose: lease.release,
        environmentOwner,
        openCorrection: async (model, modelSettings, retainOpening) => {
          // Native fallback may read a later environment key; repair needs this snapshot.
          if (apiKey === undefined)
            throw new NativeError('Output repair requires a captured API key');
          const correction = new Agent({
            instructions:
              'Correct the supplied JSON to match its schema. Return only JSON.',
            provider,
            model,
            modelSettings,
            tools: [],
          });
          const correctionOptions: OwnedSessionOptions<undefined> = {
            [correctionOpening]: { apiKey, retainOpening },
          };
          return (await correction.session(
            correctionOptions,
          )) as CoreSession<string>;
        },
      };
      const captured: CapturedOpening =
        opening ??
        Object.freeze({
          agent: this,
          factory,
          instructions,
          instructionFiles: files,
          name,
          model,
          settings,
          programmaticToolCalling,
          declarations,
          output,
          outputType,
          provider,
          apiKey: lease.apiKey,
          context,
        });
      // Without a captured key, native reopening would reread ambient auth.
      if (captured.apiKey !== undefined) {
        session.deferredReopen = async (state, active, outputOverride) => {
          let owned: CoreSession<any, any> | undefined;
          try {
            const restoredOptions: OwnedSessionOptions<any> = {
              context: captured.context,
              state,
              [deferredOpening]: {
                opening: captured,
                restoredOutput: { output: active, outputOverride },
                opened(value: CoreSession<any, any>) {
                  if (owned)
                    throw new TypeError(
                      'Deferred factory opened more than one Session',
                    );
                  owned = value;
                },
              },
            };
            const restored = await captured.factory.apply(captured.agent, [
              restoredOptions,
            ] as SessionArguments<any>);
            if (!owned || restored !== owned)
              throw new TypeError(
                'Deferred factory must return its captured Session',
              );
            return owned;
          } catch (error) {
            if (owned) {
              try {
                await owned.close();
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  'Deferred opening failed and cleanup is incomplete',
                  { cause: error },
                );
              }
            }
            throw error;
          }
        };
      }
      return { setup, session, lease, environmentOwner };
    } catch (error) {
      return lease.failOpening(error);
    }
  }
}

export class Runner {
  static run<Context, Output>(
    agent: Agent<Context, Output>,
    input: UserInput | null,
    ...args: RunArguments<Context>
  ) {
    return agent.run(input, ...args);
  }
}
