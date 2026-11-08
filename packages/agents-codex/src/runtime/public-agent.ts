import type { SessionPersistenceOptions } from './persistence-options';
import { captureTracing } from './tracing-context';
import type { TraceOptions } from './telemetry';
import {
  captureTraceContext,
  type TraceContext,
  type TraceContextHeaders,
} from './trace-context';
import { assertOutputState, sessionStateSchema } from './state';
import { openSession, runOwnedSession, type SessionSetup } from './agent';
import { issueOwnedOpeningAuthority } from './owned-opening-authority';
import { markPlainTerminalOpening } from './terminal-carrier-policy';
import { persistentSessionConfig } from './config';
import { nativeAgentConfig } from './agent-configuration';
import { collaborationTools } from './native-agents';
import { binding, type JsonObject } from './binding';
import { prepareOutput, type OutputSpec, type PreparedOutput } from './output';
import { webSearchName } from './web-search';
import { hostedToolSpecs } from './hosted-tools';
import { NativeError } from './native-error';
import { RunBudgetTracker, type RunBudget } from './run-budget';
import { validateMaxFunctionConcurrency } from './function-admission';

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
import type { InteractionHandler } from './native-questions';
import {
  ChatGPTAppsMCP,
  HttpMCP,
  StdioMCP,
  isHostedRegistration,
  mcpConfig,
  mcpToolNames,
  splitToolDeclarations,
} from './mcp';
import {
  NativeProvider,
  isCanonicalProviderForOwnedOpening,
  type ModelSettings,
  type ProviderLease,
} from './provider';
import type { SessionState } from './state';
import { nativeGoalToolNames } from './goals';
import { localStoragePath, type LocalStorage } from './local-storage';
import { captureThreadStore, type SessionStore } from './custom-thread-store';
import { captureReconciledCalls } from './local-recovery';
import { captureTools, toolIdentity, type Tool } from './tools';
import { validateMaxModelSteps, type OperationOptions } from './session';
import type {
  Session as CoreSession,
  SessionOptions as CoreSessionOptions,
  Completed,
  OneShotOptions,
} from './session';

export type AgentOptions<Context = undefined, Output = string> = {
  instructions: string;
  name?: string;
  model?: string;
  modelSettings?: ModelSettings;
  provider?: NativeProvider;
  tools?: readonly Tool<Context>[];
  programmaticToolCalling?: boolean;
} & (string extends Output
  ? { outputType?: OutputSpec<Output> }
  : { outputType: OutputSpec<Output> });

export interface SessionBaseOptions<Context = undefined> {
  /**
   * Limit automatic managed functions, including borrowed MCP callbacks, per root
   * or child turn through cleanup and reply settlement. Omission leaves admission
   * unbounded. Native MCP, manual tools and builtins do not consume these slots.
   */
  maxFunctionConcurrency?: number;
  /** Answer live requests for this Session lifetime. Omission leaves replies to application readers. */
  onInteraction?: InteractionHandler;
  tracing?: TraceOptions;
  /**
   * Explicit native parent; never read from ambient tracing or persisted state.
   * Combined SDK scoped tracing must identify the same native parent; an active
   * SDK scope can therefore conflict with an explicit external parent.
   */
  parentTrace?: TraceContext | TraceContextHeaders | null;
  context?: Context;
  /** Borrow this provider instead of the Agent provider. */
  provider?: NativeProvider;
  /** Override the Agent model for a new conversation; omit when restoring state. */
  model?: string;
  /** Merge defined keys over Agent settings; null serviceTier clears its override. */
  modelSettings?: ModelSettings;
  environment?: Environment<Context> | EnvironmentSource<Context>;
  /**
   * Load trusted UTF-8 instruction files in the supplied order at opening.
   * Use files and parent directories that untrusted actors cannot modify.
   */
  instructionFiles?: readonly string[];
  /** Cancel opening and join cleanup. Agent.run retains this signal until completion. */
  signal?: AbortSignal;
  /**
   * Read shared project guidance under the explicit Environment.cwd.
   * Requires a fresh opt-in when restoring; never selects an ambient project.
   */
  projectGuidance?: boolean;
  /** Replace opening declarations. Omission inherits Agent.tools; [] removes them. */
  tools?: readonly Tool<Context>[];
}

export type SessionOptions<Context = undefined> = SessionBaseOptions<Context> &
  SessionPersistenceOptions;

export interface RunOptions<Context = undefined> extends Omit<
  SessionBaseOptions<Context>,
  'tools'
> {
  state?: SessionState;
  /** Root model preparation limit for a new run. Resumed runs inherit their saved budget. */
  maxModelSteps?: OperationOptions<Context>['maxModelSteps'];
  /** Observed budget for a new direct native run with input. See {@link RunBudget}. */
  budget?: RunBudget;
  /**
   * Edit requests for a new run with input. A resumed turn cannot add an editor.
   * Manual tools require onInteraction because an edited run cannot save an active checkpoint.
   */
  prepareRequest?: import('./session').OperationOptions<Context>['prepareRequest'];
  returnState?: boolean;
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
  readonly onInteraction?: InteractionHandler;
  readonly maxFunctionConcurrency?: number;
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

/**
 * One owned native conversation. submit starts independent root work and rejects
 * while busy. Use enqueue to queue work, or the captured Turn to steer active work.
 */
export type Session<Output = string, Context = any> = Pick<
  CoreSession<Output, Context>,
  | 'id'
  | 'restoredTurn'
  | 'capabilities'
  | 'checkpointStatus'
  | 'submit'
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
  | 'setPausedGoal'
  | 'listMcpResources'
  | 'listMcpResourceTemplates'
  | 'readMcpResource'
  | 'listMcpPrompts'
  | 'getMcpPrompt'
  | 'subagents'
  | 'checklist'
  | 'update'
  | 'interrupt'
  | 'modelContext'
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
  static readonly #ownedRequests = new WeakSet<object>();
  static readonly #plainTerminalRequests = new WeakSet<object>();
  static readonly #apply = Reflect.apply;
  static readonly #canonicalOpening = Object.freeze({
    prototype: this.prototype,
    session: this.prototype.session,
    prepare: this.prototype.prepare,
    outputTypeFor: this.prototype.outputTypeFor,
    functionPrototype: Function.prototype,
    apply: Function.prototype.apply,
  });

  #hasCanonicalOwnedFactory(factory: unknown): boolean {
    const canonical = Agent.#canonicalOpening;
    if (
      Object.getPrototypeOf(this) !== canonical.prototype ||
      factory !== canonical.session ||
      Object.getPrototypeOf(canonical.session) !==
        canonical.functionPrototype ||
      Object.getOwnPropertyDescriptor(canonical.session, 'apply') !==
        undefined ||
      Object.getOwnPropertyDescriptor(canonical.functionPrototype, 'apply')
        ?.value !== canonical.apply
    )
      return false;
    for (const name of ['session', 'prepare', 'outputTypeFor'] as const) {
      if (
        Object.getOwnPropertyDescriptor(this, name) !== undefined ||
        Object.getOwnPropertyDescriptor(canonical.prototype, name)?.value !==
          canonical[name]
      )
        return false;
    }
    return true;
  }

  instructions: string;
  name?: string;
  model?: string;
  modelSettings?: ModelSettings;
  provider: NativeProvider;
  outputType: AgentOptions<Context, Output>['outputType'];
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
    const requestedOwnedFactory =
      args[0] !== undefined && Agent.#ownedRequests.delete(args[0]);
    const requestedPlainTerminal =
      args[0] !== undefined && Agent.#plainTerminalRequests.delete(args[0]);
    const options = {
      ...(args[0] ?? {}),
      parentTrace: captureTraceContext(args[0]?.parentTrace),
    };
    options.signal?.throwIfAborted();
    if (
      options.onInteraction !== undefined &&
      typeof options.onInteraction !== 'function'
    )
      throw new TypeError('onInteraction must be callable');
    let tracingCapture = captureTracing(options.tracing);
    let acquiredEnvironment: EnvironmentAcquisition | undefined;
    let providerOwnsCleanup = false;
    try {
      const prepare = this.prepare;
      const prepared = await Agent.#apply(prepare, this, [
        options,
        (owner) => {
          acquiredEnvironment = owner;
        },
        () => {
          providerOwnsCleanup = true;
        },
      ]);
      const { setup, session, lease, environmentOwner } = prepared;
      const ownedFactoryAuthority =
        requestedOwnedFactory &&
        #hasCanonicalOwnedFactory in this &&
        prepare === Agent.#canonicalOpening.prepare &&
        this.#hasCanonicalOwnedFactory(Agent.#canonicalOpening.session) &&
        prepared.canonicalOutputSelector === true
          ? issueOwnedOpeningAuthority()
          : undefined;
      if (ownedFactoryAuthority && requestedPlainTerminal)
        markPlainTerminalOpening(ownedFactoryAuthority);
      let openingError: unknown;
      try {
        session.tracingCapture = tracingCapture;
        const originalClose = session.onClose;
        session.onClose = async () => {
          try {
            await originalClose?.();
          } finally {
            const capture = tracingCapture;
            tracingCapture = undefined;
            if (openingError !== undefined) capture?.finish(openingError);
          }
        };
        await tracingCapture?.ready;
        environmentOwner.signal.throwIfAborted();
        const opened = await openSession(
          setup,
          session,
          lease,
          (options as OwnedSessionOptions<Context>)[ownedRun],
          undefined,
          ownedFactoryAuthority,
        );
        environmentOwner.opened();
        (options as OwnedSessionOptions<Context>)[deferredOpening]?.opened(
          opened,
        );
        lease.openingSucceeded();
        return opened as CoreSession<Output, Context>;
      } catch (error) {
        openingError = error ?? null;
        return await lease.failOpening(error);
      }
    } catch (error) {
      tracingCapture?.finish(error ?? null);
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

  /**
   * Run once and close the owned Session. When RunCleanupError is thrown,
   * its cleanup.close() retries only that Session's cleanup.
   */
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
    const budget = RunBudgetTracker.capture(options.budget);
    if (input === null && maxModelSteps !== undefined)
      throw new TypeError(
        'Cannot replace the model step budget when resuming a run',
      );
    if (input === null && budget !== undefined)
      throw new TypeError('Cannot add a run budget when resuming a run');
    if (input === null && options.prepareRequest !== undefined)
      throw new TypeError('Cannot add prepareRequest when resuming a run');
    const preparedInput = input === null ? null : nativeInput(input);
    const factory = this.session;
    const sessionOptions: OwnedSessionOptions<Context> = {
      maxFunctionConcurrency: validateMaxFunctionConcurrency(
        options.maxFunctionConcurrency,
      ),
      context: options.context,
      onInteraction: options.onInteraction,
      tracing: options.tracing,
      parentTrace: captureTraceContext(options.parentTrace),
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
        prepareRequest: options.prepareRequest,
      },
    };
    if (
      preparedInput !== null &&
      #hasCanonicalOwnedFactory in this &&
      this.#hasCanonicalOwnedFactory(factory)
    ) {
      Agent.#ownedRequests.add(sessionOptions);
      // options is the existing private spread copy; never re-read the caller's getter.
      const state = Object.getOwnPropertyDescriptor(options, 'returnState');
      if (
        typeof input === 'string' &&
        maxModelSteps === undefined &&
        budget === undefined &&
        (state
          ? 'value' in state &&
            (state.value === false || state.value === undefined)
          : !('returnState' in options))
      )
        Agent.#plainTerminalRequests.add(sessionOptions);
    }
    const session = await factory.apply(this, [
      sessionOptions,
    ] as SessionArguments<Context>);
    return runOwnedSession(session as CoreSession<Output>, preparedInput, {
      maxModelSteps,
      budget,
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
    const maxFunctionConcurrency = opening
      ? opening.maxFunctionConcurrency
      : validateMaxFunctionConcurrency(options.maxFunctionConcurrency);
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
          ![
            'reasoningEffort',
            'reasoningSummary',
            'serviceTier',
            'toolChoice',
          ].includes(key)
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

    const customStore =
      descriptor !== undefined && 'acquire' in descriptor
        ? captureThreadStore(descriptor as SessionStore)
        : undefined;
    const storage =
      descriptor === undefined
        ? undefined
        : customStore
          ? undefined
          : localStoragePath(descriptor as LocalStorage);
    const persistent = descriptor !== undefined;
    if (
      customStore &&
      (environmentInput !== undefined ||
        declarations.webSearch ||
        declarations.hostedTools.length > 0 ||
        declarations.checklist ||
        declarations.nativeGoals ||
        declarations.nativeAgents ||
        catalog.tools.some((tool) => tool.kind === 'manual'))
    )
      throw new TypeError(
        'Custom canonical storage does not support environments, native search, checklists, goals, child agents, or manual tools',
      );
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
    const selectOutput = this.outputTypeFor;
    const declaredOutput = Agent.#apply(selectOutput, this, [options]);
    const outputType =
      declaredOutput &&
      'mode' in declaredOutput &&
      !Object.isFrozen(declaredOutput)
        ? Object.freeze({ ...declaredOutput })
        : declaredOutput;
    const output = opening ? opening.output : prepareOutput(outputType);
    if (
      (options as OwnedSessionOptions<Context>)[ownedRun]?.prepareRequest !==
      undefined
    ) {
      const prepareRequest = (options as OwnedSessionOptions<Context>)[
        ownedRun
      ]!.prepareRequest;
      if (typeof prepareRequest !== 'function')
        throw new TypeError('prepareRequest must be callable');
      if (output.repair)
        throw new TypeError(
          'prepareRequest does not support output correction attempts; use native output or prompted maxRetries: 0',
        );
      if (
        (provider.supportsWebsockets ?? provider.baseUrl === undefined) !==
        false
      )
        throw new TypeError(
          'prepareRequest requires NativeProvider({ supportsWebsockets: false })',
        );
      if (
        programmaticToolCalling ||
        environmentInput ||
        declarations.nativeAgents ||
        declarations.nativeGoals ||
        declarations.checklist ||
        declarations.webSearch ||
        declarations.hostedTools.length > 0 ||
        declarations.tools.some((tool) => tool.deferLoading) ||
        declarations.mcp.some(
          (tool) => tool.deferLoading || isHostedRegistration(tool),
        )
      )
        throw new TypeError(
          'prepareRequest supports only direct root eager function and ordinary MCP tools',
        );
    }
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
    if (suppliedState != null && (persistent || resume !== undefined))
      throw new TypeError(
        'Portable state cannot be combined with persistent storage or resume',
      );
    if (stateResult && !stateResult.success) throw stateResult.error;
    const state = stateResult?.data;
    if (
      resume !== undefined &&
      (!persistent || typeof resume !== 'string' || !resume)
    )
      throw new TypeError(
        'resume requires the original storage backend and a nonempty native Session ID',
      );
    if (persistent && (declarations.mcp.length || programmaticToolCalling))
      throw new TypeError(
        'Persistent storage supports current managed tools without MCP or Code Mode',
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
    if (persistent && output.repair)
      throw new TypeError('Persistent storage does not support output repair');
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
      ...declarations.hostedTools.map((tool) => ({
        name: tool.kind,
        namespace: 'functions',
      })),
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
      ...(persistent ? persistentSessionConfig : {}),
      'tools.update_plan.enabled': declarations.checklist,
      mcp_servers: mcpConfig(
        declarations.mcp.filter(
          (server) =>
            (server.tools.length > 0 ||
              (server instanceof StdioMCP && server.lifetime === 'turn')) &&
            (!(server instanceof HttpMCP) || server.activation !== 'operation'),
        ),
        environment,
        programmaticToolCalling,
        declarations.mcp,
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
    if (search?.allowedDomains !== undefined)
      config['tools.web_search.allowed_domains'] = [...search.allowedDomains];
    if (search?.blockedDomains !== undefined)
      config['tools.web_search.blocked_domains'] = [...search.blockedDomains];
    if (search?.location !== undefined)
      config['tools.web_search.location'] = { ...search.location };
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
    const canonicalProviderAtAcquire =
      isCanonicalProviderForOwnedOpening(provider);
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
          ...(!persistent
            ? {}
            : {
                ...(storage === undefined
                  ? {}
                  : { native_thread_store: storage }),
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
          _hosted_tools: hostedToolSpecs(declarations.hostedTools),
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
        maxFunctionConcurrency,
        ownedDrainProvider:
          canonicalProviderAtAcquire &&
          isCanonicalProviderForOwnedOpening(provider),
        parentTrace: captureTraceContext(options.parentTrace),
        state,
        localStorage: persistent,
        customStore,
        localResume: resume !== undefined,
        environment,
        context,
        onInteraction: options.onInteraction,
        applicationAgent: this,
        output,
        restoredOutput: selection?.restoredOutput,
        nativeAgents,
        webSearch: search,
        hostedTools: declarations.hostedTools,
        nativeGoals: declarations.nativeGoals,
        mcpTools: declarations.mcp.length ? declarations.mcp : undefined,
        initialModelSettings: settings,
        checklist: declarations.checklist,
        websocketsAllowed: lease.websocketsAllowed,
        onClose: lease.release,
        environmentOwner,
        openCorrection: async (
          model,
          modelSettings,
          retainOpening,
          parentTrace,
        ) => {
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
            parentTrace,
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
          onInteraction: options.onInteraction,
          maxFunctionConcurrency,
        });
      // Without a captured key, native reopening would reread ambient auth.
      if (captured.apiKey !== undefined) {
        session.deferredReopen = async (
          state,
          active,
          outputOverride,
          parentTrace,
        ) => {
          let owned: CoreSession<any, any> | undefined;
          try {
            const restoredOptions: OwnedSessionOptions<any> = {
              parentTrace,
              context: captured.context,
              onInteraction: captured.onInteraction,
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
      return {
        setup,
        session,
        lease,
        environmentOwner,
        canonicalOutputSelector:
          #hasCanonicalOwnedFactory in this &&
          selectOutput === Agent.#canonicalOpening.outputTypeFor &&
          this.#hasCanonicalOwnedFactory(Agent.#canonicalOpening.session),
      };
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
