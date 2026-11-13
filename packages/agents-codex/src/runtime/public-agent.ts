import {
  captureProviderHistory,
  type ProviderHistory,
} from './provider-history';
import { createAgentTool, type AgentAsToolOptions } from './agent-tool';
import { Handoff, DecisionHandoff, decisionHandoffTool } from './handoffs';
import {
  ResponsesCompaction,
  responsesCompaction,
  type ResponsesCompactionOptions,
} from './responses-compaction';
import {
  ManagedWorkspaceCheckpoint,
  managedWorkspaceRestore,
  validateManagedWorkspaceOpening,
} from './managed-workspace';
import {
  captureRealtimeConfig,
  hasRealtimeAgentConfiguration,
  isRealtimeHandoff,
  realtimeHandoffTool,
  type RealtimeAgentConfig,
  type RealtimeHandoff,
} from './realtime-agent-config';
import {
  captureGuardrails,
  type InputGuardrail,
  type OutputGuardrail,
} from './guardrails';
import {
  captureHostedPromptSource,
  hostedPromptControls,
  type HostedPromptSource,
} from './hosted-prompts';
import type {
  BeforeCompact,
  BeforeComplete,
  ToolBatchCompletion,
  ContextTransform,
} from './model-callbacks';
import {
  bindDecide,
  captureDecisionProvider,
  type DecisionProvider,
  type BoundDecide,
} from './decisions';
import {
  captureProfileRuntimes,
  profileRoster,
  parseProfileReceipt,
  checkPortableProfileReceipt,
  type CapturedAgentProfile,
  type CapturedAgentGraph,
} from './agent-profiles';
import {
  privateOwnedGrant,
  consumePrivateOwnedGrant,
  revokePrivateOwnedGrant,
} from './private-engine-reuse';
import type { SessionPersistenceOptions } from './persistence-options';
import { captureTracing } from './tracing-context';
import type { TraceOptions } from './telemetry';
import {
  captureTraceContext,
  type TraceContext,
  type TraceContextHeaders,
} from './trace-context';
import {
  assertOutputState,
  sessionStateSchema,
  isManualSessionState,
  isOutputAwareState,
  isBudgetedManualSessionState,
  readCheckpointSelections,
} from './state';
import { openSession, runOwnedSession, type SessionSetup } from './agent';
import { tryOpenPlainRun, type PreparedPlainRun } from './plain-run';
import { persistentSessionConfig } from './config';
import { nativeAgentConfig } from './agent-configuration';
import { collaborationToolNames } from './native-agents';
import { isDeepStrictEqual } from 'node:util';
import {
  encode,
  binding,
  checkEncodedCapacity,
  type JsonObject,
  type JsonValue,
} from './binding';
import { MAX_AUDIO_INPUT_BYTES } from './media';
import {
  assertOutputRepairSupported,
  prepareOutput,
  type OutputSpec,
  type PreparedOutput,
} from './output';
import { webSearchConfig, webSearchName } from './web-search';
import { hostedToolSpecs, hostedToolType } from './hosted-tools';
import { NativeError } from './native-error';
import { RunBudgetTracker, type RunBudget } from './run-budget';
import { validateMaxFunctionConcurrency } from './function-admission';
import type { ToolErrorFormatter } from './tools';

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
import {
  captureInitialMessages,
  type InitialMessage,
} from './initial-messages';
import { nativeInput } from './input';
import type { InteractionHandler } from './native-questions';
import {
  ChatGPTAppsMCP,
  HttpMCP,
  StdioMCP,
  isHostedRegistration,
  mcpConfig,
  mcpToolNames,
  mcpToolSelections,
} from './mcp';
import { splitToolDeclarations } from './tool-declarations';
import {
  NativeProvider,
  captureModelSettings,
  requestTransportWire,
  type ModelSettings,
  type ProviderLease,
} from './provider';
import { captureOpeningModelSettings } from './opening-model-settings';
import type { SessionState } from './state';
import { nativeGoalToolNames } from './goals';
import { localStoragePath, type LocalStorage } from './local-storage';
import { captureThreadStore, type SessionStore } from './custom-thread-store';
import {
  validateCustomStorageCompatibility,
  validatePrepareRequestCompatibility,
} from './opening-compatibility';
import { captureReconciledCalls } from './local-recovery';
import {
  captureTools,
  toolDeclarationIdentity,
  isDirectFunctionTool,
  toolIdentity,
  isClientToolSearchTool,
  type Tool,
  type SessionTool,
} from './tools';
import {
  validateMaxModelSteps,
  validateModelOverride,
  captureToolNotFoundBehavior,
  captureInputStoragePolicy,
  type OperationOptions,
  type SubmitOptions,
} from './session';
import type {
  Session as CoreSession,
  SessionOptions as CoreSessionOptions,
  Completed,
  OneShotOptions,
} from './session';

export type AgentOptions<Context = undefined, Output = string> = {
  realtime?: RealtimeAgentConfig<Context>;
  name?: string;
  model?: string;
  /** Default decision provider, independent of the generative model. */
  decisions?: DecisionProvider;
  modelSettings?: ModelSettings;
  /** Await completion policy before accepting a root or native child result.
   * Feedback continues the same turn. Stop affects only its issuing owner.
   * Cancellation and close join entered callbacks. Do not mutate this Session.
   */
  beforeComplete?: BeforeComplete<Context>;
  /** Reduce settled direct function results before another model request.
   * Finish proposals use the source Agent's output and completion policies.
   * Accepted handoffs and CodeMode calls remain outside this hook.
   */
  toolBatchCompletion?: ToolBatchCompletion<Context>;
  inputGuardrails?: readonly InputGuardrail<Context>[];
  outputGuardrails?: readonly OutputGuardrail<Context>[];
  beforeCompact?: BeforeCompact<Context>;
  /** Replace detached model input for turns, children, compaction and output repair.
   * Transport retries reuse its result; canonical history and tool authority stay intact.
   */
  transformContext?: ContextTransform<Context>;
  provider?: NativeProvider;
  tools?: readonly Tool<Context>[];
  /** Named native targets; synchronous resolvers allow immutable cyclic graphs.
   * Restore verifies graph/schema provenance and binds fresh caller-supplied tools.
   * An operation ceiling retains its original source Agent; cross-Agent object
   * identity is evaluated against those fresh declarations, not saved runtime grants.
   */
  handoffs?: readonly (
    | Agent<Context, Output>
    | Handoff<Context, Output>
    | DecisionHandoff<Context, Output>
    | RealtimeHandoff<Context>
    | (() => Agent<Context, Output>)
  )[];
  programmaticToolCalling?: boolean;
  compaction?:
    ResponsesCompaction<Context> | ResponsesCompactionOptions<Context>;
} & (
  | { instructions: string; hostedPrompt?: HostedPromptSource<Context> }
  | { instructions?: undefined; hostedPrompt: HostedPromptSource<Context> }
) &
  (string extends Output
    ? { outputType?: OutputSpec<Output> }
    : { outputType: OutputSpec<Output> });

export interface SessionBaseOptions<Context = undefined> {
  /** Select current provider-owned HTTP history; restore requires its exact accepted anchor. */
  providerHistory?: ProviderHistory;
  /** Restore has been requiring the original trusted limits and effective missing-usage policy. */
  resumeBudget?: RunBudget;
  /** Format original function argument/body failures; omission preserves propagation.
   * Per-tool handlers take precedence; errorFunction:null suppresses this fallback.
   * Callback failure or undefined uses safe default text. Not persisted in state. */
  toolErrorFormatter?: ToolErrorFormatter<Context>;
  /** Retain all emitted observations in memory for this Session lifetime.
   * Memory grows with emitted payloads until Session references are released.
   * Defaults to a bounded suffix with gap events. Not stored in checkpoints. */
  observationRetention?: 'bounded' | 'all';
  /** Record completed assistant messages and provider reasoning summaries. */
  includeModelOutputItems?: boolean;
  /** Record content-free acceptance notifications for logical root results. */
  includeOutputAccepted?: boolean;
  /** Capture content-free native transport attempts for fresh explicit submissions. */
  includeRequestAttempts?: boolean;
  /**
   * Capture Responses provider JSON in the Session's observation buffer.
   * Use includeExecutionDetails on an observation reader to receive it.
   */
  includeRawProviderEvents?: boolean;
  /**
   * Seed settled user messages and assistant text without starting a model turn.
   * Requires a fresh opening without state or resume, including for []. Core
   * prepares media using the current route. Publication waits for native flush;
   * memory storage adds no crash guarantee. Failed startup can leave accepted
   * persistent history: recover it instead of automatically resubmitting seeds.
   */
  initialMessages?: readonly InitialMessage[];
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
  inputGuardrails?: readonly InputGuardrail<Context>[];
  outputGuardrails?: readonly OutputGuardrail<Context>[];
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
  /**
   * Use Codex AGENTS.md instructions as model context. Discovery reads the
   * host Codex home (`CODEX_HOME` or `~/.codex`) and the readable project
   * hierarchy of a selected Environment, using that executor's filesystem.
   * Codex prefers `AGENTS.override.md` at each location and applies user
   * guidance followed by project guidance from the root to the working
   * directory. Explicit `instructionFiles` provide developer instructions.
   * Enable only for trusted executors, directories, grants, and symlink
   * targets. Defaults to false on each public opening, including restore.
   */
  discoverAgentsMd?: boolean;
  /** Cancel opening and join cleanup. Agent.run retains this signal until completion. */
  signal?: AbortSignal;
  /**
   * Read shared project guidance under the explicit Environment.cwd.
   * Requires a fresh opt-in when restoring; never selects an ambient project.
   */
  projectGuidance?: boolean;
  /**
   * Authenticate the entire saved checkpoint for the current application principal
   * before reusing remembered tool approvals. Omit this to request fresh approval.
   */
  verifyRememberedApprovals?: (
    state: SessionState,
  ) => boolean | Promise<boolean>;
  /** Replace opening declarations. Omission inherits Agent.tools; [] removes them. */
  tools?: readonly Tool<Context>[];
}

type NativeSessionOptions<Context> = SessionBaseOptions<Context> &
  SessionPersistenceOptions;
export type SessionOptions<Context = undefined> = SessionBaseOptions<Context> &
  (
    | {
        state?: SessionState | ManagedWorkspaceCheckpoint;
        storage?: never;
        resume?: never;
        reconciledCalls?: never;
      }
    | Exclude<SessionPersistenceOptions, { storage?: never }>
  );

export interface RunOptions<Context = undefined> extends Omit<
  SessionBaseOptions<Context>,
  | 'tools'
  | 'includeModelOutputItems'
  | 'includeOutputAccepted'
  | 'includeRequestAttempts'
  | 'includeRawProviderEvents'
> {
  /** Force the model across this run, handoffs and native children. */
  modelOverride?: string;
  /** Sparse forced settings for this run, its handoffs and native children. */
  modelSettingsOverride?: ModelSettings;
  /** Unknown direct function calls default to recoverable model errors. */
  toolNotFoundBehavior?: OperationOptions<Context>['toolNotFoundBehavior'];
  state?: SessionState;
  /** Root model preparation limit for a new run. Resumed runs inherit their saved budget. */
  maxModelSteps?: OperationOptions<Context>['maxModelSteps'];
  /** Observed budget for a new root, or the original request-only ceiling for manual restore. See {@link RunBudget}. */
  budget?: RunBudget;
  /**
   * Edit requests for a new run with input. A resumed turn cannot add an editor.
   * Manual tools require onInteraction because an edited run cannot save an active checkpoint.
   */
  prepareRequest?: import('./session').OperationOptions<Context>['prepareRequest'];
  /** Select tools for each model step of a new run. */
  beforeStep?: import('./session').OperationOptions<Context>['beforeStep'];
  /** Replace or omit new user input before native submission and storage. */
  inputStoragePolicy?: SubmitOptions<Context>['inputStoragePolicy'];
  returnState?: boolean;
  /** Capture conversation records for replay through another Session's transactHistory.
   * History above 4,096 original records or 8 MiB causes a size error after completion. */
  returnHistory?: boolean;
  /** Return original usage from accepted Responses requests completed during this
   * invocation, in response order. History and checkpoints omit these objects.
   * Capture above 4,096 responses or 8 MiB raises NativeError after completion. */
  returnRawUsage?: boolean;
  /** Retain the assistant and tool items produced by this run. */
  returnItems?: boolean;
  /**
   * Opted-in failures have been retaining RunDiagnosticError.details.
   * Portable manual recovery has been retaining captured caller input;
   * unavailable origins have been reporting null input and incomplete details.
   */
  captureErrorDetails?: boolean;
}

// Track inheritance without retaining a replaced mutable Agent.provider.
const implicitProviders = new WeakMap<NativeProvider, WeakSet<object>>();
const implicitTools = Symbol('implicitTools');
const implicitInstructions = Symbol('implicitInstructions');

function capturedInstructions(agent: Agent<any, any>): string | undefined {
  const getter = agent[implicitInstructions];
  return getter !== undefined &&
    Object.getOwnPropertyDescriptor(agent, 'instructions')?.get === getter
    ? undefined
    : agent.instructions;
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
  readonly discoverAgentsMd?: boolean;
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
  readonly toolErrorFormatter?: ToolErrorFormatter<any>;
  readonly profiles?: readonly CapturedAgentProfile<any, any>[];
  readonly decisions?: DecisionProvider;
  readonly maxFunctionConcurrency?: number;
  readonly observationRetention?: 'bounded' | 'all';
  readonly includeModelOutputItems?: boolean;
  readonly includeOutputAccepted?: boolean;
  readonly includeRequestAttempts?: boolean;
  readonly includeRawProviderEvents?: boolean;
  readonly contextTransformPurpose: 'turn' | 'output_repair';
  readonly beforeComplete?: BeforeComplete<any>;
  readonly toolBatchCompletion?: ToolBatchCompletion<any>;
  readonly agentInputGuardrails: readonly InputGuardrail<any>[];
  readonly agentOutputGuardrails: readonly OutputGuardrail<any>[];
  readonly inputGuardrails: readonly InputGuardrail<any>[];
  readonly outputGuardrails: readonly OutputGuardrail<any>[];
  readonly beforeCompact?: BeforeCompact<any>;
  readonly compaction?: ResponsesCompaction<any>;
  readonly transformContext?: ContextTransform<any>;
  readonly hostedPrompt?: HostedPromptSource<any>;
  readonly hostedPromptControls?: JsonObject;
}
type OwnedSessionOptions<Context> = NativeSessionOptions<Context> & {
  [managedWorkspaceRestore]?: true;
  [outputSelection]?: OutputSpec<unknown>;
  [ownedRun]?: OneShotOptions & {
    decisions?: DecisionProvider;
    beforeComplete?: BeforeComplete<Context>;
    toolBatchCompletion?: ToolBatchCompletion<Context>;
  };
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
  | 'forkStored'
  | 'storedSessions'
  | 'setStoredName'
  | 'storedTurns'
  | 'storedItems'
  | 'searchHistory'
  | 'revertStored'
  | 'deleteStored'
  | 'rateLimits'
  | 'planUsage'
  | 'buildRealtimeSipConfig'
  | 'realtime'
  | 'realtimeUsage'
  | 'getActiveAgent'
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
  | 'historySnapshot'
  | 'flushMemory'
  | 'transactHistory'
  | 'popHistory'
  | 'modelContext'
  | 'compact'
  | 'executeCommand'
  | 'saveState'
  | 'suspendWorkspace'
  | 'fork'
  | 'suspend'
  | 'close'
  | typeof Symbol.asyncDispose
>;

/** A declaration; opening a Session captures its current configuration. */
export class Agent<Context = undefined, Output = string> {
  static readonly #canonicalSession = this.prototype.session;
  static readonly #canonicalPrepare = this.prototype.prepare;
  static readonly #canonicalApply = Function.prototype.apply;
  instructions: string;
  declare [implicitInstructions]?: () => string;
  hostedPrompt?: HostedPromptSource<Context>;
  [implicitTools]?: readonly Tool<Context>[];
  realtime?: RealtimeAgentConfig<Context>;
  name?: string;
  model?: string;
  decisions?: DecisionProvider;
  readonly decide: BoundDecide = ((
    question: string,
    options: Parameters<BoundDecide>[1],
  ) =>
    bindDecide({
      provider: captureDecisionProvider(this.decisions),
      assertActive() {},
    })(question, options)) as BoundDecide;
  modelSettings?: ModelSettings;
  beforeComplete?: BeforeComplete<Context>;
  toolBatchCompletion?: ToolBatchCompletion<Context>;
  inputGuardrails: readonly InputGuardrail<Context>[];
  outputGuardrails: readonly OutputGuardrail<Context>[];
  beforeCompact?: BeforeCompact<Context>;
  transformContext?: ContextTransform<Context>;
  provider: NativeProvider;
  outputType: AgentOptions<Context, Output>['outputType'];
  tools: readonly Tool<Context>[];
  handoffs: readonly (
    | Agent<Context, Output>
    | Handoff<Context, Output>
    | DecisionHandoff<Context, Output>
    | RealtimeHandoff<Context>
    | (() => Agent<Context, Output>)
  )[];
  programmaticToolCalling: boolean;
  compaction?: ResponsesCompaction<Context>;

  constructor(options: AgentOptions<Context, Output>) {
    const promptSource = captureHostedPromptSource(options.hostedPrompt);
    const declaredInstructions = options.instructions;
    if (
      typeof declaredInstructions !== 'string' &&
      !(declaredInstructions === undefined && promptSource !== undefined)
    )
      throw new TypeError(
        'Agent instructions are required unless hostedPrompt supplies them',
      );
    this.instructions = declaredInstructions ?? '';
    if (declaredInstructions === undefined) {
      // Keep the public string property while capturing hosted omission. A later
      // assignment, including an empty string, supplies explicit instructions.
      let instructions = '';
      const get = () => instructions;
      Object.defineProperty(this, implicitInstructions, {
        value: get,
        writable: true,
      });
      Object.defineProperty(this, 'instructions', {
        enumerable: true,
        configurable: true,
        get,
        set: (value: string) => {
          // Frozen profile declarations retain ordinary read-only field behavior.
          this[implicitInstructions] = undefined;
          instructions = value;
        },
      });
    }
    this.hostedPrompt = promptSource;
    this.realtime = captureRealtimeConfig(options.realtime);
    this.name = options.name;
    this.model = options.model;
    this.decisions = captureDecisionProvider(options.decisions);
    this.modelSettings =
      options.modelSettings === undefined
        ? undefined
        : captureModelSettings(options.modelSettings);
    for (const name of [
      'beforeComplete',
      'toolBatchCompletion',
      'beforeCompact',
      'transformContext',
    ] as const)
      if (options[name] !== undefined && typeof options[name] !== 'function')
        throw new TypeError(`${name} must be callable`);
    this.beforeComplete = options.beforeComplete;
    this.toolBatchCompletion = options.toolBatchCompletion;
    this.inputGuardrails = captureGuardrails(options.inputGuardrails);
    this.outputGuardrails = captureGuardrails(options.outputGuardrails);
    this.beforeCompact = options.beforeCompact;
    this.compaction =
      options.compaction === undefined
        ? undefined
        : options.compaction instanceof ResponsesCompaction
          ? options.compaction
          : responsesCompaction(options.compaction);
    if (this.compaction !== undefined && this.beforeCompact !== undefined)
      throw new TypeError(
        'compaction and beforeCompact are mutually exclusive',
      );
    this.transformContext = options.transformContext;
    this.provider = options.provider ?? new NativeProvider();
    if (options.provider === undefined)
      implicitProviders.set(this.provider, new WeakSet([this]));
    this.outputType = options.outputType;
    this.tools = [...(options.tools ?? [])];
    this[implicitTools] = options.tools === undefined ? this.tools : undefined;
    this.handoffs = Object.freeze([...(options.handoffs ?? [])]);
    if (
      this.handoffs.some(
        (target) =>
          !(target instanceof Agent) &&
          !(target instanceof Handoff) &&
          !(target instanceof DecisionHandoff) &&
          !isRealtimeHandoff(target) &&
          typeof target !== 'function',
      )
    )
      throw new TypeError(
        'handoffs must contain native Agents or synchronous target resolvers',
      );
    this.programmaticToolCalling = options.programmaticToolCalling ?? false;
  }

  /**
   * A configured child has been retaining its own provider, tools and guards.
   * Pending child approvals have been requiring live replies.
   */
  asTool(
    options: AgentAsToolOptions<Output>,
  ): import('./tools').FunctionTool<Context> {
    return createAgentTool(this, options);
  }

  /**
   * Select output for new runs and Sessions without changing this Agent.
   * Subclasses must opt in to output-independent, option-forwarding hooks.
   */
  withOutputType<Next>(
    outputType: OutputSpec<Next>,
  ): AgentOutput<Context, Next> {
    if (this.handoffs.length)
      throw new TypeError(
        'withOutputType requires an Agent without outgoing handoffs; create a graph with compatible output types',
      );
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
    const catalogs = captureAgentProfiles(this, this, false).map((profile) =>
      captureTools(splitToolDeclarations(profile.declaration.tools).tools),
    );
    const native = await binding();
    for (const catalog of catalogs)
      native._validate_python_tool_declarations(catalog.specsJson);
  }

  async session(
    ...args: SessionArguments<Context>
  ): Promise<Session<Output, Context>> {
    return (await this.#open(args[0])).session;
  }

  #open(
    suppliedOptions?: SessionOptions<Context>,
  ): Promise<{ session: CoreSession<Output, Context> }>;
  #open(
    suppliedOptions: SessionOptions<Context>,
    plainInput: string,
  ): Promise<
    { session: CoreSession<Output, Context> } | { plainRun: PreparedPlainRun }
  >;
  async #open(
    suppliedOptions?: SessionOptions<Context>,
    plainInput?: string,
  ): Promise<
    { session: CoreSession<Output, Context> } | { plainRun: PreparedPlainRun }
  > {
    const managedOpening =
      suppliedOptions?.state instanceof ManagedWorkspaceCheckpoint
        ? validateManagedWorkspaceOpening(
            suppliedOptions.state,
            suppliedOptions.environment,
          )
        : undefined;
    const options = {
      ...(suppliedOptions ?? {}),
      ...(managedOpening
        ? { state: managedOpening.state, [managedWorkspaceRestore]: true }
        : {}),
      providerHistory: captureProviderHistory(suppliedOptions?.providerHistory),
      parentTrace: captureTraceContext(suppliedOptions?.parentTrace),
    } as OwnedSessionOptions<Context>;
    if (
      options.observationRetention !== undefined &&
      options.observationRetention !== 'bounded' &&
      options.observationRetention !== 'all'
    )
      throw new TypeError('observationRetention must be "bounded" or "all"');
    if (
      options.includeRawProviderEvents !== undefined &&
      typeof options.includeRawProviderEvents !== 'boolean'
    )
      throw new TypeError('includeRawProviderEvents must be a boolean');
    options.initialMessages = captureInitialMessages(
      options.initialMessages,
      options.state,
      options.resume,
    );
    options.signal?.throwIfAborted();
    if (
      options.onInteraction !== undefined &&
      typeof options.onInteraction !== 'function'
    )
      throw new TypeError('onInteraction must be callable');
    if (
      options.verifyRememberedApprovals !== undefined &&
      typeof options.verifyRememberedApprovals !== 'function'
    )
      throw new TypeError('verifyRememberedApprovals must be callable');
    let tracingCapture = captureTracing(options.tracing);
    let acquiredEnvironment: EnvironmentAcquisition | undefined;
    let providerOwnsCleanup = false;
    try {
      const prepare = this.prepare;
      if (
        prepare !== Agent.#canonicalPrepare ||
        tracingCapture !== undefined ||
        options.parentTrace
      )
        revokePrivateOwnedGrant(
          (options as OwnedSessionOptions<Context>)[ownedRun]
            ?.privateEngineGrant,
        );
      const { setup, session, lease, environmentOwner, privateRun, catalog } =
        await Reflect.apply(prepare, this, [
          options,
          (owner: EnvironmentAcquisition) => {
            acquiredEnvironment = owner;
          },
          () => {
            providerOwnsCleanup = true;
          },
        ]);
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
        if (
          plainInput !== undefined &&
          privateRun &&
          prepare === Agent.#canonicalPrepare
        ) {
          const plainRun = await tryOpenPlainRun(
            setup,
            session,
            lease,
            plainInput,
            options.signal,
          );
          if (plainRun) {
            environmentOwner.opened();
            lease.openingSucceeded();
            return { plainRun };
          }
        }
        const opened = await openSession(
          setup,
          session,
          lease,
          (options as OwnedSessionOptions<Context>)[ownedRun],
          prepare === Agent.#canonicalPrepare ? catalog : undefined,
        );
        environmentOwner.opened();
        (options as OwnedSessionOptions<Context>)[deferredOpening]?.opened(
          opened,
        );
        lease.openingSucceeded();
        return { session: opened as CoreSession<Output, Context> };
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
   * One-shot execution and owned cleanup.
   * Cleanup retry after RunCleanupError: cleanup.close(), without another run.
   */
  async run(
    input: UserInput | null,
    ...args: RunArguments<Context>
  ): Promise<Completed<Output>> {
    const options = {
      ...(args[0] ?? {}),
      providerHistory: captureProviderHistory(args[0]?.providerHistory),
    };
    const modelOverride = validateModelOverride(options.modelOverride);
    const raiseOnUnknownTool = captureToolNotFoundBehavior(
      options.toolNotFoundBehavior,
    );
    const modelSettingsOverride =
      options.modelSettingsOverride === undefined
        ? undefined
        : captureModelSettings(options.modelSettingsOverride);
    if (
      isManualSessionState(options.state) &&
      modelSettingsOverride !== undefined
    )
      throw new TypeError(
        'modelSettingsOverride cannot replace restored run settings',
      );
    if (isManualSessionState(options.state) && raiseOnUnknownTool !== undefined)
      throw new TypeError(
        'toolNotFoundBehavior cannot replace a restored operation choice',
      );
    if (isManualSessionState(options.state) && modelOverride !== undefined)
      throw new TypeError('modelOverride cannot replace a restored run model');
    const audioBudget = { remaining: MAX_AUDIO_INPUT_BYTES };
    const initialMessages = captureInitialMessages(
      options.initialMessages,
      options.state,
      undefined,
      audioBudget,
    );

    if ('tools' in options)
      throw new TypeError(
        'Run tool selection is not supported; use Agent.session({ tools })',
      );
    for (const key of ['storage', 'resume', 'reconciledCalls'])
      if (key in options)
        throw new TypeError(`Agent.run does not support session-only ${key}`);
    // Validate input before acquiring a provider or touching the filesystem.
    const captureErrorDetails = options.captureErrorDetails === true;
    const maxModelSteps = validateMaxModelSteps(options.maxModelSteps);
    const budget = RunBudgetTracker.capture(options.budget);
    const beforeStep = options.beforeStep;
    if (beforeStep !== undefined && typeof beforeStep !== 'function')
      throw new TypeError('beforeStep must be callable');
    if (beforeStep !== undefined && input == null)
      throw new TypeError('A resumed turn cannot add beforeStep');
    if (input === null && maxModelSteps !== undefined)
      throw new TypeError(
        'Cannot replace the model step budget when resuming a run',
      );
    if (
      input === null &&
      budget !== undefined &&
      !isBudgetedManualSessionState(options.state)
    )
      throw new TypeError('Cannot add a run budget when resuming a run');
    if (input === null && options.prepareRequest !== undefined)
      throw new TypeError('Cannot add prepareRequest when resuming a run');
    if (input === null && options.inputStoragePolicy !== undefined)
      throw new TypeError('Cannot add inputStoragePolicy when resuming a run');
    const initialAudioRemaining = audioBudget.remaining;
    const captureRunInput = (value: UserInput) => {
      const budget = { remaining: initialAudioRemaining };
      const parts = nativeInput(value, budget);
      if (budget.remaining !== MAX_AUDIO_INPUT_BYTES)
        checkEncodedCapacity(
          { input: parts, initial_messages: initialMessages ?? [] },
          MAX_AUDIO_INPUT_BYTES,
        );
      return parts;
    };
    const inputStoragePolicy =
      input === null
        ? undefined
        : captureInputStoragePolicy(input, options.inputStoragePolicy);
    if (inputStoragePolicy) inputStoragePolicy.capture = captureRunInput;
    const preparedInput = input === null ? null : captureRunInput(input);
    const factory = this.session;
    const factoryApply = factory.apply;
    const guardrailInput =
      input !== null &&
      inputStoragePolicy === undefined &&
      (this.inputGuardrails.length > 0 ||
        (options.inputGuardrails?.length ?? 0) > 0 ||
        (options.state !== undefined && this.handoffs.length > 0) ||
        factory !== Agent.#canonicalSession ||
        factoryApply !== Agent.#canonicalApply ||
        this.prepare !== Agent.#canonicalPrepare)
        ? structuredClone(input)
        : undefined;
    const errorInput = captureErrorDetails
      ? inputStoragePolicy
        ? null
        : structuredClone(input)
      : undefined;
    const sessionOptions: OwnedSessionOptions<Context> = {
      providerHistory: options.providerHistory,
      ...(initialMessages === undefined ? {} : { initialMessages }),
      ...(captureErrorDetails ? { includeRawProviderEvents: true } : {}),
      maxFunctionConcurrency: validateMaxFunctionConcurrency(
        options.maxFunctionConcurrency,
      ),
      observationRetention: options.observationRetention,
      context: options.context,
      onInteraction: options.onInteraction,
      verifyRememberedApprovals: options.verifyRememberedApprovals,
      toolErrorFormatter: options.toolErrorFormatter,
      tracing: options.tracing,
      parentTrace: captureTraceContext(options.parentTrace),
      state: options.state,
      resumeBudget:
        input === null
          ? (options.budget ?? options.resumeBudget)
          : options.resumeBudget,
      environment: options.environment,
      instructionFiles: options.instructionFiles,
      discoverAgentsMd: options.discoverAgentsMd,
      projectGuidance: options.projectGuidance,
      inputGuardrails: options.inputGuardrails,
      outputGuardrails: options.outputGuardrails,
      signal: options.signal,
      provider: options.provider,
      model: options.model,
      modelSettings: options.modelSettings,
      [outputSelection]: (options as OwnedSessionOptions<Context>)[
        outputSelection
      ],
      [ownedRun]: {
        returnItems: options.returnItems || captureErrorDetails,
        decisions: captureDecisionProvider(this.decisions),
        beforeComplete: this.beforeComplete,
        toolBatchCompletion: this.toolBatchCompletion,
        input: preparedInput,
        prepareRequest: options.prepareRequest,
        beforeStep,
        returnRawUsage: options.returnRawUsage,
      },
    };
    if (
      factoryApply === Agent.#canonicalApply &&
      factory === Agent.#canonicalSession &&
      this.constructor === Agent &&
      typeof input === 'string' &&
      maxModelSteps === undefined &&
      budget === undefined &&
      options.returnState !== true &&
      options.returnHistory !== true &&
      options.returnRawUsage !== true &&
      options.returnItems !== true &&
      !captureErrorDetails &&
      options.prepareRequest === undefined &&
      inputStoragePolicy === undefined &&
      modelOverride === undefined &&
      modelSettingsOverride === undefined &&
      options.providerHistory === undefined &&
      raiseOnUnknownTool === undefined &&
      options.onInteraction === undefined &&
      options.context === undefined &&
      (options as OwnedSessionOptions<Context>)[outputSelection] === undefined
    )
      sessionOptions[ownedRun]!.privateEngineGrant = privateOwnedGrant();
    let session: CoreSession<Output>;
    if (
      sessionOptions[ownedRun]?.privateEngineGrant !== undefined &&
      beforeStep === undefined &&
      typeof input === 'string'
    ) {
      const opened = await this.#open(sessionOptions, input);
      if ('plainRun' in opened)
        return opened.plainRun.run() as Promise<Completed<Output>>;
      session = opened.session;
    } else {
      session = (await Reflect.apply(factoryApply, factory, [
        this,
        [sessionOptions] as SessionArguments<Context>,
      ])) as CoreSession<Output>;
    }
    return runOwnedSession(session, preparedInput, {
      modelOverride,
      modelSettingsOverride,
      toolNotFoundBehavior: options.toolNotFoundBehavior,
      guardrailInput,
      errorInput,
      inputStoragePolicy,
      maxModelSteps,
      budget,
      returnState: options.returnState,
      returnHistory: options.returnHistory,
      returnRawUsage: options.returnRawUsage,
      returnItems: options.returnItems,
      signal: options.signal,
    });
  }

  private async prepare(
    options: NativeSessionOptions<Context>,
    acquiredEnvironment: (owner: EnvironmentAcquisition) => void,
    cleanupAcquired: () => void,
  ) {
    const privateOwned = consumePrivateOwnedGrant(
      (options as OwnedSessionOptions<Context>)[ownedRun]?.privateEngineGrant,
    );
    const projectGuidance = options.projectGuidance;
    if (projectGuidance !== undefined && typeof projectGuidance !== 'boolean')
      throw new TypeError('projectGuidance must be a boolean');
    const selection = (options as OwnedSessionOptions<Context>)[
      deferredOpening
    ];
    const opening = selection?.opening;
    const discoverAgentsMd =
      opening?.discoverAgentsMd ?? options.discoverAgentsMd;
    if (discoverAgentsMd !== undefined && typeof discoverAgentsMd !== 'boolean')
      throw new TypeError('discoverAgentsMd must be a boolean');
    const toolErrorFormatter = opening
      ? opening.toolErrorFormatter
      : options.toolErrorFormatter;
    if (
      toolErrorFormatter !== undefined &&
      typeof toolErrorFormatter !== 'function'
    )
      throw new TypeError('toolErrorFormatter must be a function');
    const owned = (options as OwnedSessionOptions<Context>)[ownedRun];
    const decisions = captureDecisionProvider(
      opening ? opening.decisions : owned ? owned.decisions : this.decisions,
    );
    const beforeComplete = opening
      ? opening.beforeComplete
      : owned
        ? owned.beforeComplete
        : this.beforeComplete;
    const toolBatchCompletion = opening
      ? opening.toolBatchCompletion
      : owned
        ? owned.toolBatchCompletion
        : this.toolBatchCompletion;
    const inputGuardrails =
      opening?.inputGuardrails ?? captureGuardrails(options.inputGuardrails);
    const outputGuardrails =
      opening?.outputGuardrails ?? captureGuardrails(options.outputGuardrails);
    const agentInputGuardrails =
      opening?.agentInputGuardrails ?? captureGuardrails(this.inputGuardrails);
    const agentOutputGuardrails =
      opening?.agentOutputGuardrails ??
      captureGuardrails(this.outputGuardrails);
    const beforeCompact = opening ? opening.beforeCompact : this.beforeCompact;
    const suppliedCompaction = opening ? opening.compaction : this.compaction;
    const compaction =
      suppliedCompaction === undefined
        ? undefined
        : suppliedCompaction instanceof ResponsesCompaction
          ? suppliedCompaction
          : responsesCompaction(suppliedCompaction);
    if (compaction !== undefined && beforeCompact !== undefined)
      throw new TypeError(
        'compaction and beforeCompact are mutually exclusive',
      );
    const transformContext = opening
      ? opening.transformContext
      : this.transformContext;
    const contextTransformPurpose =
      opening?.contextTransformPurpose ??
      ((options as OwnedSessionOptions<Context>)[correctionOpening]
        ? 'output_repair'
        : 'turn');
    for (const [name, callback] of [
      ['beforeComplete', beforeComplete],
      ['toolBatchCompletion', toolBatchCompletion],
      ['beforeCompact', beforeCompact],
      ['transformContext', transformContext],
    ] as const)
      if (callback !== undefined && typeof callback !== 'function')
        throw new TypeError(`${name} must be a function`);
    const observationRetention = opening
      ? opening.observationRetention
      : options.observationRetention;
    const includeModelOutputItems = opening
      ? opening.includeModelOutputItems
      : options.includeModelOutputItems;
    const includeOutputAccepted = opening
      ? opening.includeOutputAccepted
      : options.includeOutputAccepted;
    const includeRequestAttempts = opening
      ? opening.includeRequestAttempts
      : options.includeRequestAttempts;
    const includeRawProviderEvents =
      options.includeRawProviderEvents ?? opening?.includeRawProviderEvents;
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
    const { name, programmaticToolCalling } = opening ?? this;
    const declaredInstructions = opening
      ? opening.instructions
      : capturedInstructions(this);
    const baseInstructions = declaredInstructions ?? '';
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
    if (
      options.providerHistory !== undefined &&
      provider.modelBackend !== undefined
    )
      throw new TypeError(
        'Provider history requires a supported owning Responses transport',
      );
    const historyHttpOnly =
      options.providerHistory !== undefined &&
      provider.supportsWebsockets === undefined;
    const model = opening ? opening.model : (openingModel ?? this.model);
    const settings = opening
      ? opening.settings
      : captureOpeningModelSettings(this.modelSettings, openingSettings);
    const hostedPrompt = opening
      ? opening.hostedPrompt
      : captureHostedPromptSource(this.hostedPrompt);
    if (declaredInstructions === undefined && hostedPrompt === undefined)
      throw new TypeError(
        'Agent instructions are required unless hostedPrompt supplies them',
      );
    const promptControls = opening
      ? opening.hostedPromptControls
      : hostedPromptControls(hostedPrompt, {
          model,
          instructions:
            declaredInstructions === undefined &&
            !options.instructionFiles?.length
              ? undefined
              : baseInstructions,
          toolsProvided:
            options.tools !== undefined ||
            this[implicitTools] !== this.tools ||
            this.tools.length > 0 ||
            this.handoffs.length > 0,
          extraBody: settings?.extraBody,
        });
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
    validateCustomStorageCompatibility(
      customStore,
      declarations,
      catalog,
      environmentInput !== undefined,
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
    const budgetState = stateResult?.success ? stateResult.data : undefined;
    const restoredRunBudget = isBudgetedManualSessionState(budgetState)
      ? RunBudgetTracker.restoreCheckpoint(
          budgetState.run_budget,
          options.resumeBudget,
        )
      : undefined;
    if (
      !isBudgetedManualSessionState(budgetState) &&
      options.resumeBudget !== undefined
    )
      throw new TypeError(
        'Cannot add a run budget when resuming an unbudgeted checkpoint',
      );
    const declaredOutput = this.outputTypeFor(options);
    const outputType =
      declaredOutput &&
      'mode' in declaredOutput &&
      !Object.isFrozen(declaredOutput)
        ? Object.freeze({ ...declaredOutput })
        : declaredOutput;
    const output = opening ? opening.output : prepareOutput(outputType);
    if (provider._usesChatGPTPlan && settings?.store === true)
      throw new TypeError('Sign in with ChatGPT requires store=false');
    if (
      provider._usesChatGPTPlan &&
      (owned?.prepareRequest !== undefined ||
        selection !== undefined ||
        isManualSessionState(stateResult?.data) ||
        this.handoffs.length !== 0 ||
        programmaticToolCalling ||
        projectGuidance ||
        environmentInput !== undefined ||
        declarations.nativeAgents ||
        declarations.nativeGoals ||
        declarations.checklist ||
        search ||
        declarations.hostedTools.length !== 0 ||
        declarations.mcp.length !== 0 ||
        declarations.tools.some((tool) => !isDirectFunctionTool(tool)) ||
        output.repair)
    )
      throw new TypeError(
        'Sign in with ChatGPT supports a single Agent with direct local function tools and settled state',
      );
    const profiles = opening
      ? opening.profiles
      : this.handoffs.length || this.realtime !== undefined
        ? captureAgentProfiles(
            this,
            new Agent({
              instructions: baseInstructions,
              name,
              model,
              modelSettings: settings,
              provider,
              outputType: outputType as OutputSpec<Output> | undefined,
              tools: options.tools ?? this.tools,
              handoffs: this.handoffs,
              realtime: this.realtime,
              decisions,
              beforeComplete,
              toolBatchCompletion,
              inputGuardrails: agentInputGuardrails,
              outputGuardrails: agentOutputGuardrails,
              programmaticToolCalling,
              beforeCompact,
              compaction,
              transformContext,
              hostedPrompt,
            } as AgentOptions<Context, Output>),
            true,
            undefined,
            promptControls,
          )
        : undefined;

    if (
      (options as OwnedSessionOptions<Context>)[ownedRun]?.prepareRequest !==
      undefined
    ) {
      const prepareRequest = (options as OwnedSessionOptions<Context>)[
        ownedRun
      ]!.prepareRequest;
      validatePrepareRequestCompatibility(
        prepareRequest,
        !!output.repair,
        !historyHttpOnly &&
          provider.responseMode !== 'buffered' &&
          (provider.supportsWebsockets ?? provider.baseUrl === undefined) !==
            false,
        !!(
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
        ),
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
      state &&
      (state.executor_read_only ?? false) !== (environment?.readOnly ?? false)
    )
      throw new TypeError(
        'Checkpoint and Environment must agree on read-only execution',
      );
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
    if (nativeAgents && provider.modelBackend)
      throw new TypeError(
        'modelBackend does not yet support native child agents',
      );
    if (nativeAgents && provider.responseMode === 'buffered')
      throw new TypeError(
        'Native child agents are not supported in buffered mode',
      );
    if (nativeAgents && environment?.readOnly)
      throw new TypeError('Read-only execution does not support NativeAgents');
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
    const graph = profiles
      ? captureProfileRuntimes(
          profiles,
          catalog,
          instructions,
          outputGuardrails.length > 0,
          inputGuardrails.length + agentInputGuardrails.length > 0,
          settings,
        )
      : undefined;
    const graphNative = graph ? await binding() : undefined;
    const restoredSource =
      graph && state
        ? checkPortableProfileReceipt(
            parseProfileReceipt(
              graphNative!._agent_profiles_restore_source(
                JSON.stringify(graph.roster),
                graph.rootId,
                JSON.stringify(state.history),
              ),
            ),
            graph,
          )
        : undefined;
    const operationSource =
      graph &&
      isManualSessionState(state) &&
      readCheckpointSelections(state).operation_tools?.length
        ? checkPortableProfileReceipt(
            parseProfileReceipt(
              graphNative!._agent_profiles_operation_source(
                JSON.stringify(graph.roster),
                graph.rootId,
                JSON.stringify(state.history),
                state.manual_continuation.turn_id,
              ),
            ),
            graph,
          )
        : undefined;
    const activeOutput =
      selection?.restoredOutput.output ??
      (restoredSource
        ? graph!.profiles.get(restoredSource.profile_id)!.output
        : output);
    if (persistent && output.repair)
      throw new TypeError('Persistent storage does not support output repair');
    assertOutputState(state, activeOutput.identity);
    if (
      (activeOutput.prompt || activeOutput.schema != null) &&
      isManualSessionState(state) &&
      !isOutputAwareState(state)
    )
      throw new TypeError(
        'Cannot restore a legacy pending manual checkpoint with structured or prompted output',
      );
    const deferredSchemas =
      declarations.tools.some((tool) => tool.deferLoading) ||
      declarations.mcp.some((server) => server.deferLoading) ||
      [...(graph?.profiles.values() ?? [])].some(
        (profile) =>
          profile.catalog.tools.some((tool) => tool.deferLoading) ||
          profile.mcp.some((server) => server.deferLoading),
      );
    const selected = [
      ...(projectGuidance
        ? ['read_text_file', 'view_image'].map((name) => ({
            name,
            namespace: 'functions',
          }))
        : []),
      ...(search ? [webSearchName(search)] : []),
      ...declarations.hostedTools.map((tool) => ({
        name: hostedToolType(tool),
        namespace: 'functions',
      })),
      ...declarations.tools
        .filter((tool) => !isClientToolSearchTool(tool))
        .map(toolIdentity),
      ...(deferredSchemas &&
      !declarations.hostedTools.some((tool) => tool.kind === 'tool_search')
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
        ? collaborationToolNames(nativeAgents).map((name) => ({
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
    if (graph)
      for (const profile of graph.profiles.values()) {
        for (const identity of [
          ...profile.catalog.tools.map(toolIdentity),
          ...mcpToolNames(profile.mcp),
          ...Object.keys(profile.profile.handoffs).map((name) => ({
            namespace: 'functions',
            name,
          })),
        ])
          if (
            !selected.some(
              (current) =>
                current.name === identity.name &&
                current.namespace === identity.namespace,
            )
          )
            selected.push(identity);
      }
    assertUniqueToolIdentities(selected);
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
      ...webSearchConfig(search),
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

    const native = graphNative ?? (await binding());
    if (options.providerHistory?.type === 'previous_response' && graph) {
      const pending = [graph.rootId];
      const visited = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const profile = graph.profiles.get(id)!.profile;
        if (profile.declaration.modelSettings?.store !== true)
          throw new TypeError(
            'Every reachable handoff profile requires current store=true',
          );
        pending.push(...Object.values(profile.handoffs));
      }
    }
    const completedGraph = graph
      ? Object.freeze({
          ...graph,
          ...(restoredSource ? { restoredSource } : {}),
          ...(operationSource ? { operationSource } : {}),
          roster: profileRoster(graph, environment),
          fingerprint: native._agent_profiles_fingerprint(
            JSON.stringify(graph.roster),
            graph.rootId,
          ),
        })
      : undefined;
    for (const profile of graph?.profiles.values() ?? [])
      native._validate_python_tool_declarations(profile.catalog.specsJson);
    native._validate_python_tool_declarations(catalog.specsJson);
    environmentOwner.signal.throwIfAborted();
    const privateRun =
      privateOwned &&
      options.initialMessages === undefined &&
      !graph &&
      !selection &&
      !persistent &&
      state == null &&
      !environment &&
      !projectGuidance &&
      !discoverAgentsMd &&
      files.length === 0 &&
      !programmaticToolCalling &&
      selected.length === 0 &&
      declarations.tools.length === 0 &&
      declarations.mcp.length === 0 &&
      declarations.hostedTools.length === 0 &&
      !declarations.nativeGoals &&
      !declarations.checklist &&
      !nativeAgents &&
      !search &&
      correction === undefined &&
      outputType === undefined;
    const lease = provider._acquire(correction ?? opening, privateRun);
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
      if (lease.codexLogin)
        assertOutputRepairSupported(
          output,
          activeOutput,
          ...Array.from(
            graph?.profiles.values() ?? [],
            (profile) => profile.output,
          ),
        );
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
      const plan = await lease.capturePlan?.(environmentOwner.signal);
      const home = await lease.open();
      environmentOwner.signal.throwIfAborted();
      if (nativeAgents)
        Object.assign(
          config,
          await nativeAgentConfig(nativeAgents, instructions, home.codex_home),
        );
      if (projectGuidance) config['features.view_image'] = true;
      const startupTransport = requestTransportWire(settings);
      const setup: SessionSetup = {
        name: name ?? '',
        instructions,
        model,
        tools: declarations.tools,
        apiKey: lease.apiKey,
        applicationAppsJson,
        plan,
        config: {
          ...config,
          ...lease.config,
          ...(plan
            ? {
                'features.remote_compaction_v2': false,
                'features.unbounded_connection_retries': false,
              }
            : {}),
          'model_providers.native_agent': {
            ...(lease.config['model_providers.native_agent'] as JsonObject),
            supports_standalone_web_search: search?.route === 'standalone',
            ...(historyHttpOnly ? { supports_websockets: false } : {}),
          },
        },
        runtime: {
          ...home,
          ...(discoverAgentsMd ? { _sdk_discover_agents_md: true } : {}),
          ...(lease.codexLogin === undefined
            ? {}
            : { _sdk_codex_login: lease.codexLogin }),
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
          ...(projectGuidance ? { _sdk_project_guidance_config: true } : {}),
          base_instructions:
            "You are an AI agent. Follow the application instructions and use the tools provided to complete the user's request accurately.",
          ...(environment ? { sandbox_mode: 'read-only' as const } : {}),
        },
        threadOptions: {
          ...(options.providerHistory === undefined
            ? {}
            : { _provider_history: options.providerHistory }),
          ...(startupTransport === undefined
            ? {}
            : { _sdk_request_transport: startupTransport }),
          ...(completedGraph
            ? {
                _agent_profiles: {
                  root_id: completedGraph.rootId,
                  roster: [...completedGraph.roster],
                  fingerprint: completedGraph.fingerprint,
                },
              }
            : {}),
          _context_callbacks: {
            model_producer: provider.modelBackend !== undefined,
            before_compact:
              beforeCompact !== undefined ||
              compaction !== undefined ||
              (completedGraph?.roster.some(
                (profile) => profile.before_compact === true,
              ) ??
                false),
            post_turn_compact:
              compaction !== undefined ||
              (completedGraph?.roster.some(
                (profile) => profile.post_turn_compact === true,
              ) ??
                false),
            tool_batch_completion:
              toolBatchCompletion !== undefined ||
              (completedGraph?.roster.some(
                (profile) => profile.tool_batch_completion === true,
              ) ??
                false),
            before_complete:
              beforeComplete !== undefined ||
              agentOutputGuardrails.length > 0 ||
              outputGuardrails.length > 0 ||
              agentInputGuardrails.length > 0 ||
              inputGuardrails.length > 0 ||
              (completedGraph?.roster.some(
                (profile) => profile.before_complete === true,
              ) ??
                false),
            transform_context:
              hostedPrompt !== undefined ||
              transformContext !== undefined ||
              (completedGraph?.roster.some(
                (profile) => profile.transform_context === true,
              ) ??
                false),
          },
          _hosted_tools: hostedToolSpecs(
            declarations.hostedTools.filter(
              (tool) =>
                tool.kind !== 'tool_search' || tool.execution !== 'client',
            ),
          ),
          ...(provider.responseMode === 'buffered'
            ? { _buffered_responses: true }
            : {}),
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
                ...(nativeAgents.managedTools.length
                  ? {
                      _native_agent_tools: nativeAgents.managedTools.map(
                        ({ name, role, description }) => ({
                          name,
                          role,
                          description,
                        }),
                      ),
                    }
                  : {}),
                _native_agent_max_depth: nativeAgents.maxDepth,
                _native_agent_before_step:
                  nativeAgents.beforeStep !== undefined ||
                  [
                    ...inputGuardrails,
                    ...agentInputGuardrails,
                    ...(profiles?.flatMap(
                      (profile) => profile.declaration.inputGuardrails,
                    ) ?? []),
                  ].some((guard) => guard.childCallback !== undefined),
              }
            : {}),
          tool_policy: {
            allowed_tools: selected,
            allowed_mcp_tools: mcpToolSelections([
              ...declarations.mcp,
              ...(graph
                ? [...graph.profiles.values()].flatMap((profile) => profile.mcp)
                : []),
            ]),
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
        modelBackend: provider.modelBackend,
        chatGPTPlan: plan !== undefined,
        realtimeApiKey: lease.realtimeApiKey,
        observationRetention,
        includeModelOutputItems,
        includeOutputAccepted,
        includeRequestAttempts,
        includeRawProviderEvents,
        initialMessages: options.initialMessages,
        maxFunctionConcurrency,
        decisions,
        parentTrace: captureTraceContext(options.parentTrace),
        state,
        restoredRunBudget,
        localStorage: persistent,
        customStore,
        localResume: resume !== undefined,
        environment,
        context,
        onInteraction: options.onInteraction,
        verifyRememberedApprovals: options.verifyRememberedApprovals,
        toolErrorFormatter,
        applicationAgent: this,
        realtimeDeclaration:
          profiles?.[0].declaration ??
          (Object.freeze(
            new Agent<Context, Output>({
              ...this,
              instructions: baseInstructions,
              tools: options.tools ?? this.tools,
              provider,
            } as AgentOptions<Context, Output>),
          ) as Agent<any, any>),
        beforeComplete,
        toolBatchCompletion,
        inputGuardrails,
        outputGuardrails,
        agentInputGuardrails,
        agentOutputGuardrails,
        beforeCompact,
        compaction,
        transformContext,
        contextTransformPurpose,
        agentGraph: completedGraph,
        output,
        restoredOutput: selection?.restoredOutput,
        nativeAgents,
        webSearch: search,
        hostedTools: declarations.hostedTools,
        nativeGoals: declarations.nativeGoals,
        mcpTools: declarations.mcp.length ? declarations.mcp : undefined,
        initialModelSettings: settings,
        providerHistory: options.providerHistory,
        hostedPrompt,
        hostedPromptControls: promptControls,
        checklist: declarations.checklist,
        websocketsAllowed: lease.websocketsAllowed && !historyHttpOnly,
        onClose: lease.release,
        managedWorkspace: environmentOwner.managedWorkspace,
        [managedWorkspaceRestore]: (options as OwnedSessionOptions<Context>)[
          managedWorkspaceRestore
        ],
        environmentOwner,
        openCorrection: lease.codexLogin
          ? undefined
          : async (
              model,
              modelSettings,
              retainOpening,
              parentTrace,
              repairTransformContext,
            ) => {
              // Native fallback may read a later environment key; repair needs this snapshot.
              if (apiKey === undefined)
                throw new NativeError(
                  'Output repair requires a captured API key',
                );
              const correction = new Agent({
                instructions:
                  'Correct the supplied JSON to match its schema. Return only JSON.',
                provider,
                model,
                modelSettings,
                tools: [],
                transformContext:
                  repairTransformContext === undefined
                    ? undefined
                    : (request) =>
                        repairTransformContext({
                          ...request,
                          context: context as Context,
                        }),
              });
              const correctionOptions: OwnedSessionOptions<undefined> = {
                parentTrace,
                includeModelOutputItems,
                includeOutputAccepted,
                includeRawProviderEvents,
                [correctionOpening]: {
                  apiKey: lease.realtimeApiKey,
                  retainOpening,
                },
              };
              return (await correction.session(
                correctionOptions,
              )) as CoreSession<string>;
            },
      };
      const captured: CapturedOpening = opening
        ? Object.freeze({ ...opening, decisions, includeRawProviderEvents })
        : Object.freeze({
            agent: this,
            profiles,
            decisions,
            beforeComplete,
            toolBatchCompletion,
            inputGuardrails,
            outputGuardrails,
            agentInputGuardrails,
            agentOutputGuardrails,
            factory,
            instructions,
            instructionFiles: files,
            discoverAgentsMd,
            name,
            model,
            settings,
            programmaticToolCalling,
            declarations,
            output,
            outputType,
            provider,
            apiKey: lease.realtimeApiKey,
            context,
            onInteraction: options.onInteraction,
            toolErrorFormatter,
            maxFunctionConcurrency,
            observationRetention,
            includeModelOutputItems,
            includeOutputAccepted,
            includeRequestAttempts,
            includeRawProviderEvents,
            contextTransformPurpose,
            beforeCompact,
            compaction,
            transformContext,
            hostedPrompt,
            hostedPromptControls: promptControls,
          });
      // HTTP reopening needs captured auth; custom producers use text admission.
      if (lease.apiKey !== undefined) {
        session.deferredReopen = async (
          state,
          active,
          outputOverride,
          parentTrace,
          resumeBudget,
        ) => {
          let owned: CoreSession<any, any> | undefined;
          try {
            const sealed = encode(state);
            const restoredOptions: OwnedSessionOptions<any> = {
              parentTrace,
              context: captured.context,
              onInteraction: captured.onInteraction,
              toolErrorFormatter: captured.toolErrorFormatter,
              state,
              verifyRememberedApprovals: (checkpoint) =>
                encode(checkpoint) === sealed,
              resumeBudget,
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
      return { setup, session, lease, environmentOwner, privateRun, catalog };
    } catch (error) {
      return lease.failOpening(error);
    }
  }
}

function assertUniqueToolIdentities(
  identities: readonly { namespace: string; name: string }[],
): void {
  const selectedPairs = new Set<string>();
  for (const identity of identities) {
    const key = JSON.stringify([identity.namespace, identity.name]);
    if (selectedPairs.has(key))
      throw new TypeError(
        `Duplicate selected tool ${identity.namespace}.${identity.name}`,
      );
    selectedPairs.add(key);
  }
}

/** @internal Resolve a graph synchronously, before any provider/native acquisition. */
export function captureAgentProfiles<Context, Output>(
  root: Agent<Context, Output>,
  rootDeclaration: Agent<Context, Output> = root,
  captureProvider = true,
  idPrefix = 'agent_',
  rootPromptControls?: JsonObject,
  realtimeGraph = hasRealtimeAgentConfiguration(rootDeclaration),
): readonly CapturedAgentProfile<Context, Output>[] {
  const wireIdentity = (agent: Agent<Context, Output>) => {
    const spec = agent.outputType;
    // Validate actual retries, then compare only the shared wire encoding.
    const prepared = prepareOutput(spec);
    return spec && 'mode' in spec && spec.mode === 'prompted'
      ? prepareOutput({ ...spec, maxRetries: 0 }).identity.fingerprint
      : prepared.identity.fingerprint;
  };
  const output = wireIdentity(rootDeclaration);
  const runtimeGrants = (agent: Agent<Context, Output>) => {
    const {
      tools: _tools,
      mcp: _mcp,
      ...grants
    } = splitToolDeclarations(agent.tools);
    return {
      ...grants,
      programmaticToolCalling: agent.programmaticToolCalling,
    };
  };
  const grants = runtimeGrants(rootDeclaration);
  const agents = [root];
  const indices = new Map<Agent<Context, Output>, number>([[root, 0]]);
  const resolved = new Map<
    () => Agent<Context, Output>,
    Agent<Context, Output>
  >();
  const profiles: CapturedAgentProfile<Context, Output>[] = [];
  for (const agent of agents) {
    const source = agent === root ? rootDeclaration : agent;
    const handoffBindings = new Set(
      source.handoffs
        .filter((reference) => reference instanceof Handoff)
        .map((reference) => toolDeclarationIdentity(reference.callback)),
    );
    const sourceTools = source.tools.filter(
      (tool) =>
        !handoffBindings.has(toolDeclarationIdentity(tool as SessionTool)),
    );
    const declarations = splitToolDeclarations(sourceTools);
    const plain = declarations.tools;
    const capturedTools = captureTools(plain).tools;
    assertUniqueToolIdentities([
      ...capturedTools.map(toolIdentity),
      ...mcpToolNames(declarations.mcp),
    ]);
    const replacements = new Map(
      plain.map((tool, index) => [tool, capturedTools[index]]),
    );
    const outputType =
      source.outputType && 'mode' in source.outputType
        ? Object.freeze({ ...source.outputType })
        : source.outputType;
    const declaration = new Agent<Context, Output>({
      instructions: capturedInstructions(source),
      realtime: source.realtime,
      name: source.name,
      model: source.model,
      decisions: source.decisions,
      modelSettings: source.modelSettings,
      provider: captureProvider ? rootDeclaration.provider : undefined,
      outputType,
      tools:
        source[implicitTools] === source.tools && source.tools.length === 0
          ? undefined
          : sourceTools.map(
              (tool) => replacements.get(tool as SessionTool) ?? tool,
            ),
      handoffs: source.handoffs,
      programmaticToolCalling: source.programmaticToolCalling,
      beforeComplete: source.beforeComplete,
      toolBatchCompletion: source.toolBatchCompletion,
      inputGuardrails: source.inputGuardrails,
      outputGuardrails: source.outputGuardrails,
      beforeCompact: source.beforeCompact,
      compaction: source.compaction,
      transformContext: source.transformContext,
      hostedPrompt: source.hostedPrompt,
    } as AgentOptions<Context, Output>);
    if (wireIdentity(declaration) !== output)
      throw new TypeError(
        'Handoff profiles must share output mode, schema and wrapping',
      );
    if (
      captureProvider &&
      agent !== root &&
      !implicitProviders.get(agent.provider)?.has(agent) &&
      agent.provider !== rootDeclaration.provider
    )
      throw new TypeError(
        'Handoff targets must inherit or share the Session provider',
      );
    if (!isDeepStrictEqual(runtimeGrants(declaration), grants))
      throw new TypeError(
        'Handoff profiles must share native child-role configuration and non-function runtime grants',
      );
    const targets: Record<string, string> = Object.create(null);
    const handoffCallbacks: Record<string, number> = Object.create(null);
    const decisionHandoffs: Record<
      string,
      Readonly<{ slot: number; targets: readonly string[] }>
    > = Object.create(null);
    const handoffOptions: Record<
      string,
      RealtimeHandoff<Context>
    > = Object.create(null);
    const callbackTools: import('./tools').FunctionTool<Context>[] = [];
    for (const reference of declaration.handoffs) {
      if (reference instanceof DecisionHandoff) {
        if (realtimeGraph || hasRealtimeAgentConfiguration(declaration))
          throw new TypeError(
            'DecisionHandoff supports text Agents; use realtimeHandoff for Realtime routing',
          );
        const name = reference.name;
        if (
          Object.hasOwn(targets, name) ||
          Object.hasOwn(decisionHandoffs, name) ||
          capturedTools.some(
            (entry) =>
              toolIdentity(entry).namespace === 'functions' &&
              entry.name === name,
          )
        )
          throw new TypeError('Duplicate or conflicting DecisionHandoff name');
        const roster: Record<string, string> = Object.create(null);
        for (const [choice, candidate] of Object.entries(reference.targets)) {
          if (!(candidate instanceof Agent))
            throw new TypeError(
              'DecisionHandoff targets must be native Agents',
            );
          let targetIndex = indices.get(candidate);
          if (targetIndex === undefined) {
            targetIndex = agents.length;
            indices.set(candidate, targetIndex);
            agents.push(candidate);
          }
          roster[choice] = `${idPrefix}${targetIndex}`;
        }
        decisionHandoffs[name] = Object.freeze({
          slot: capturedTools.length + callbackTools.length,
          targets: Object.freeze([...new Set(Object.values(roster))]),
        });
        callbackTools.push(
          decisionHandoffTool(reference, Object.freeze(roster)),
        );
        continue;
      }
      let target: Agent<Context, Output>;
      if (reference instanceof Handoff) target = reference.target;
      else if (isRealtimeHandoff(reference)) target = reference.agent;
      else if (reference instanceof Agent) target = reference;
      else {
        if (typeof reference !== 'function')
          throw new TypeError(
            'handoffs must contain native Agents or synchronous target resolvers',
          );
        const cached = resolved.get(reference);
        if (cached) target = cached;
        else {
          const value: unknown = reference();
          if (!(value instanceof Agent)) {
            // Reject async declarations without leaving an unobserved rejection.
            if (value instanceof Promise) void value.catch(() => {});
            throw new TypeError(
              'A synchronous handoff target resolver must return a native Agent',
            );
          }
          target = value;
          resolved.set(reference, target);
        }
      }
      if (
        !(reference instanceof Handoff) &&
        (!isRealtimeHandoff(reference) || reference.name === undefined) &&
        !target.name?.trim()
      )
        throw new TypeError('A handoff target requires a nonempty Agent.name');
      const name =
        reference instanceof Handoff
          ? reference.callback.name
          : isRealtimeHandoff(reference) && reference.name !== undefined
            ? reference.name
            : `transfer_to_${target.name}`
                .replace(/[^a-zA-Z0-9_-]/g, '_')
                .toLowerCase()
                .slice(0, 64);
      if (Object.hasOwn(decisionHandoffs, name))
        throw new TypeError('Duplicate or conflicting DecisionHandoff name');
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
        throw new TypeError('Invalid Realtime handoff name');
      let index = indices.get(target);
      if (index === undefined) {
        index = agents.length;
        indices.set(target, index);
        agents.push(target);
      }
      const id = `${idPrefix}${index}`;
      if (reference instanceof Handoff && targets[name] === id) {
        const slot = handoffCallbacks[name];
        if (
          slot !== undefined &&
          callbackTools[slot - capturedTools.length] === reference.callback
        )
          continue;
      }
      if (
        targets[name] !== undefined &&
        (targets[name] !== id ||
          reference instanceof Handoff ||
          isRealtimeHandoff(reference))
      )
        throw new TypeError(
          `Duplicate handoff name in Agent ${agent.name ?? 'root'}: ${name}`,
        );
      if (
        capturedTools.some((tool) => {
          const identity = toolIdentity(tool);
          return identity.namespace === 'functions' && identity.name === name;
        })
      )
        throw new TypeError(
          `Handoff name conflicts with declared tool: ${name}`,
        );
      targets[name] = id;
      if (reference instanceof Handoff || isRealtimeHandoff(reference)) {
        if (isRealtimeHandoff(reference)) handoffOptions[name] = reference;
        handoffCallbacks[name] = capturedTools.length + callbackTools.length;
        callbackTools.push(
          reference instanceof Handoff
            ? reference.callback
            : realtimeHandoffTool(reference, agent, name),
        );
      }
    }
    const omittedTools =
      declaration[implicitTools] === declaration.tools ||
      (agent === root && rootPromptControls?.omit_tools === true);
    declaration.tools = [...declaration.tools, ...callbackTools];
    declaration[implicitTools] =
      omittedTools && declaration.tools.length === 0
        ? declaration.tools
        : undefined;
    Object.freeze(declaration.modelSettings);
    Object.freeze(declaration.tools);
    Object.freeze(declaration);
    profiles.push(
      Object.freeze({
        id: `${idPrefix}${indices.get(agent)!}`,
        agent,
        declaration,
        handoffs: Object.freeze(targets),
        handoffCallbacks: Object.freeze(handoffCallbacks),
        decisionHandoffs: Object.freeze(decisionHandoffs),
        handoffOptions: Object.freeze(handoffOptions),
        callbackTools: Object.freeze(callbackTools),
        hostedPromptControls:
          agent === root && rootPromptControls !== undefined
            ? rootPromptControls
            : hostedPromptControls(declaration.hostedPrompt, {
                model: declaration.model,
                instructions: capturedInstructions(source),
                toolsProvided:
                  source[implicitTools] !== source.tools ||
                  source.tools.length > 0 ||
                  source.handoffs.length > 0,
                extraBody: declaration.modelSettings?.extraBody,
              }),
      }),
    );
  }
  return Object.freeze(profiles);
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

/** Capture fresh voice declarations while preserving the opening native contract. */
export function captureRealtimeAgentGraph(
  opening: Agent<any, any>,
  candidate: Agent<any, any>,
  idPrefix: string,
): CapturedAgentGraph {
  if (!(candidate instanceof Agent))
    throw new TypeError('updateAgent requires a native Agent');
  if (
    candidate.provider !== opening.provider &&
    !implicitProviders.get(candidate.provider)?.has(candidate)
  )
    throw new TypeError('A Realtime Agent must use the Session provider');
  if (
    prepareOutput(candidate.outputType).identity.fingerprint !==
    prepareOutput(opening.outputType).identity.fingerprint
  )
    throw new TypeError(
      'A Realtime Agent must preserve the Session output contract',
    );
  const fixed = (agent: Agent<any, any>) => {
    const {
      tools: _tools,
      mcp: _mcp,
      ...grants
    } = splitToolDeclarations(agent.tools);
    return {
      ...grants,
      programmaticToolCalling: agent.programmaticToolCalling,
    };
  };
  if (!isDeepStrictEqual(fixed(opening), fixed(candidate)))
    throw new TypeError(
      'A Realtime Agent cannot change fixed native runtime tools',
    );
  if (capturedInstructions(candidate) === undefined)
    throw new TypeError('Realtime Agents require explicit instructions');
  const declaration = new Agent({
    ...candidate,
    instructions: candidate.instructions,
    provider: opening.provider,
  });
  const profiles = captureAgentProfiles(
    candidate,
    declaration,
    true,
    idPrefix,
    undefined,
    true,
  );
  return captureProfileRuntimes(
    profiles,
    captureTools(splitToolDeclarations(declaration.tools).tools),
    declaration.instructions ?? '',
  );
}

/** @internal Existing one-shot opening for the Conversations history owner. */
export function openOwnedHistorySession<Context, Output>(
  agent: Agent<Context, Output>,
  input: JsonValue[],
  ...args: SessionArguments<Context>
): Promise<CoreSession<Output, Context>> {
  const options = {
    ...args[0],
    [ownedRun]: {
      input,
      decisions: captureDecisionProvider(agent.decisions),
      beforeComplete: agent.beforeComplete,
      toolBatchCompletion: agent.toolBatchCompletion,
    },
  } as OwnedSessionOptions<Context>;
  return agent.session(...([options] as SessionArguments<Context>)) as Promise<
    CoreSession<Output, Context>
  >;
}
