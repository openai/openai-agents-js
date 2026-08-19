import { Agent, AgentOutputType } from './agent';
import { RunAgentUpdatedStreamEvent, RunRawModelStreamEvent } from './events';
import {
  AgentsError,
  ModelBehaviorError,
  ModelTimeoutError,
  UserError,
} from './errors';
import {
  defineInputGuardrail,
  defineOutputGuardrail,
  InputGuardrail,
  OutputGuardrail,
} from './guardrail';
import type {
  InputGuardrailDefinition,
  OutputGuardrailDefinition,
  OutputGuardrailMetadata,
} from './guardrail';
import { Handoff, HandoffInputFilter } from './handoff';
import { RunHooks } from './lifecycle';
import logger, { logModelAndToolActionDebug } from './logger';
import {
  Model,
  ModelProvider,
  ModelResponse,
  ModelSettings,
  type ModelRequest,
} from './model';
import { getDefaultModelProvider } from './providers';
import { RunContext } from './runContext';
import { RunResult, StreamedRunResult } from './result';
import { RunState } from './runState';
import { RunItem } from './items';
import {
  getCurrentTrace,
  getCurrentTraceContext,
  resetCurrentSpan,
  setCurrentSpan,
  withNewSpanContext,
  withTrace,
  withTraceContext,
} from './tracing/context';
import type { TracingConfig } from './tracing';
import { includeTaskAndTurnSpans, mergeTracingConfig } from './tracing/config';
import { Usage } from './usage';
import { convertAgentOutputTypeToSerializable } from './utils/tools';
import { snapshotRawUsage } from './utils/rawUsage';
import { DEFAULT_MAX_TURNS } from './runner/constants';
import { StreamEventResponseCompleted } from './types/protocol';
import type { Session, SessionInputCallback } from './memory/session';
import type { SandboxRunConfig } from './sandbox/client';
import { SandboxRuntimeManager } from './sandbox/runtime';
import type { SandboxRuntimeModel } from './sandbox/runtime/agentPreparation';
import type { AgentInputItem } from './types';
import {
  ServerConversationTracker,
  applyCallModelInputFilter,
  getServerConversationOwner,
} from './runner/conversation';
import {
  createGuardrailTracker,
  finalizeOutputGuardrails,
} from './runner/guardrails';
import {
  adjustModelSettingsForNonGPT5RunnerModel,
  mergeModelSettings,
  maybeResetToolChoice,
  selectModel,
} from './runner/modelSettings';
import {
  getResponseWithRetry,
  getStreamedResponseWithRetry,
  validateModelTimeoutMs,
} from './runner/modelRetry';
import { processModelResponseAsync } from './runner/modelOutputs';
import {
  addStepToRunResult,
  streamStepItemsToRunResult,
  isAbortError,
} from './runner/streaming';
import {
  createSessionPersistenceTracker,
  captureSessionHistoryTransactionInputItems,
  markSessionHistoryTransactionInputPersisted,
  prepareSessionHistoryTransactionsForRun,
  releaseProvisionalSessionHistoryTransactionBinding,
  releaseUnusedSessionHistoryTransactionBinding,
  prepareInputItemsWithSession,
  saveStreamInputToSession,
  saveStreamResultToSession,
  saveToSession,
  type SessionPersistenceOptions,
} from './runner/sessionPersistence';
import {
  filterSuppressedToolCallItems,
  preflightModelResponseToolInvocations,
  preflightToolInvocations,
  resolveTurnAfterModelResponse,
} from './runner/turnResolution';
import {
  assertResumedSessionOutputGuardrailSafety,
  captureCurrentResponseToolOutputGuardrailResultStart,
  hasBlockedOutputExecutionEffect,
  hasTerminalToolOutputSource,
  OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
  sanitizeBlockedTerminalToolOutput,
  shouldDeferInterruptedSessionItems,
} from './runner/blockedOutputPersistence';
import { prepareTurn } from './runner/turnPreparation';
import type { NextStep } from './runner/steps';
import {
  commitPendingInput,
  hasUnpersistedRunInput,
  mapPendingInputAfterContextProcessing,
  selectPendingInputForAdmission,
} from './runner/pendingInput';
import { prepareAgentArtifacts } from './runner/modelPreparation';
import {
  applyTurnResult,
  assertAcceptedResponseContinuationAuthority,
  handleInterruptedOutcome,
  isAcceptedResponseCheckpoint,
  markAcceptedResponseProcessingStarted,
  markAcceptedResponseFinalizationStarted,
  resumeAcceptedModelResponse,
  resumeInterruptedTurn,
} from './runner/runLoop';
import {
  applyTraceOverrides,
  ensureActiveAgentSpanForInterruptedResume,
  ensureTurnSpan,
  finishRunnerSpan,
  getRunnerSpanErrorDetails,
  getTracing,
  setRunnerSpanError,
  startRunnerInvocationSpans,
  startTurnSpan,
  recordRunnerSpanUsage,
  type RunnerSpanLifecycle,
} from './runner/tracing';
import {
  getRunnerParentUsageRecorder,
  setRunStateUsageRecorder,
} from './runner/usageTracking';
import {
  getRunnerInvocationSpanParent,
  getRunStateTurnSpanParent,
  setRunStateTurnSpanParent,
} from './runner/invocationContext';
import type { Span, TaskSpanData } from './tracing/spans';
import { NoopTrace, type Trace } from './tracing/traces';
import { NOOP_TRACE_OR_SPAN_ID } from './tracing/utils';
import {
  assertValidCompactionItems,
  CompactionItemValidationError,
  type ReasoningItemIdPolicy,
} from './runner/items';
import type {
  AgentArtifacts,
  CallModelInputFilter,
  PreparedModelCall,
} from './runner/types';
import {
  attachRunStateToError,
  invalidateAcceptedResponseReplayEvidence,
  prepareRunErrorFinalOutput,
} from './runner/errorHandlers';
import type {
  PreparedRunErrorFinalOutput,
  RunErrorHandlers,
} from './runner/errorHandlers';
import {
  finalizeSandboxRuntime,
  isSandboxRuntimeAgent,
  prepareSandboxInterruptedTurnResume,
  type SandboxMemoryPersistenceContext,
} from './runner/sandbox';
import {
  buildAbortReconciliationInput,
  createStreamAbortReconciliationState,
  getAbortReconciliationPreviousResponseId,
  markAbortReconciliationComplete,
  recordStreamEventForAbortReconciliation,
  shouldReconcileStreamAbort,
} from './runner/streamReconciliation';
import {
  getImplicitModelSettingsForResolvedModel,
  validateToolExecutionConfig,
  validateToolNameCollisionPolicy,
  type ToolExecutionConfig,
  type ToolNameCollisionPolicy,
} from './runner/runConfig';
export type {
  ToolExecutionConfig,
  ToolNameCollisionPolicy,
} from './runner/runConfig';

function hasPersistedToolOutput(state: RunState<any, any>): boolean {
  return state._generatedItems
    .slice(0, state._currentTurnPersistedItemCount)
    .some((item) => item.type === 'tool_call_output_item');
}

function hasRetainableBlockedOutputEffect(state: RunState<any, any>): boolean {
  return hasBlockedOutputExecutionEffect(
    state._generatedItems,
    state._currentTurnPersistedItemCount,
  );
}

function commitDeferredRunErrorItemAfterPartialPersistence(
  state: RunState<any, any>,
  preparedErrorOutput?: PreparedRunErrorFinalOutput,
): boolean {
  if (
    preparedErrorOutput?.deferredItem &&
    state._currentTurnPersistedItemCount > state._generatedItems.length
  ) {
    state._generatedItems.push(preparedErrorOutput.deferredItem);
    return true;
  }
  return false;
}

export type {
  CallModelInputFilter,
  CallModelInputFilterArgs,
  ModelInputData,
} from './runner/types';
export type {
  RunErrorData,
  RunErrorHandler,
  RunErrorHandlerInput,
  RunErrorHandlerResult,
  RunErrorHandlers,
  RunErrorKind,
} from './runner/errorHandlers';
export { getTracing } from './runner/tracing';
export { selectModel } from './runner/modelSettings';
export { getTurnInput } from './runner/items';
export type { ReasoningItemIdPolicy } from './runner/items';

// Maintenance: keep helper utilities (e.g., GuardrailTracker) in runner/* modules so run.ts stays orchestration-only.

// --------------------------------------------------------------
//  Configuration
// --------------------------------------------------------------

export type ToolErrorKind = 'approval_rejected' | 'tool_not_found';

export type ToolErrorFormatterArgs<
  TContext = unknown,
  TKind extends ToolErrorKind = ToolErrorKind,
> = {
  /**
   * The category of tool error being formatted.
   */
  kind: TKind;
  /**
   * The tool runtime that produced the error.
   */
  toolType: 'function' | 'computer' | 'shell' | 'apply_patch';
  /**
   * The name of the tool that produced the error.
   */
  toolName: string;
  /**
   * The unique tool call identifier.
   */
  callId: string;
  /**
   * The SDK's default message for this error kind.
   */
  defaultMessage: string;
  /**
   * The active run context for the current execution.
   */
  runContext: RunContext<TContext>;
};

export type ToolErrorFormatter<TContext = unknown> = (
  args: ToolErrorFormatterArgs<TContext>,
) => Promise<string | undefined> | string | undefined;

/**
 * SDK-side execution settings for local tool calls.
 */
export type ToolNotFoundBehavior = 'raise_error' | 'return_error_to_model';

/**
 * Configures settings for the entire agent run.
 */
export type RunConfig = {
  /**
   * The model to use for the entire agent run. If set, will override the model set on every
   * agent. String model names are resolved with the configured modelProvider, or the default
   * model provider if no explicit provider is configured.
   */
  model?: string | Model;

  /**
   * The model provider to use when looking up string model names. Defaults to OpenAI.
   */
  modelProvider?: ModelProvider;

  /**
   * Configure global model settings. Any non-null values will override the agent-specific model
   * settings.
   */
  modelSettings?: ModelSettings;

  /**
   * A global input filter to apply to all handoffs. If `Handoff.inputFilter` is set, then that
   * will take precedence. The input filter allows you to edit the inputs that are sent to the new
   * agent. See the documentation in `Handoff.inputFilter` for more details.
   */
  handoffInputFilter?: HandoffInputFilter;

  /**
   * A list of input guardrails to run on the initial run input.
   */
  inputGuardrails?: InputGuardrail[];

  /**
   * A list of output guardrails to run on the final output of the run.
   */
  outputGuardrails?: OutputGuardrail<AgentOutputType<unknown>>[];

  /**
   * Whether tracing is disabled for the agent run. If disabled, we will not trace the agent run.
   */
  tracingDisabled: boolean;

  /**
   * Whether we include potentially sensitive data (for example: inputs/outputs of tool calls or
   * LLM generations) in traces. If false, we'll still create spans for these events, but the
   * sensitive data will not be included.
   */
  traceIncludeSensitiveData: boolean;

  /**
   * The name of the run, used for tracing. Should be a logical name for the run, like
   * "Code generation workflow" or "Customer support agent".
   */
  workflowName?: string;

  /**
   * A custom trace ID to use for tracing. If not provided, we will generate a new trace ID.
   */
  traceId?: string;

  /**
   * A grouping identifier to use for tracing, to link multiple traces from the same conversation
   * or process. For example, you might use a chat thread ID.
   */
  groupId?: string;

  /**
   * An optional dictionary of additional metadata to include with the trace.
   */
  traceMetadata?: Record<string, string>;

  /**
   * Tracing configuration for this run. Use this to override the API key used when exporting traces.
   */
  tracing?: TracingConfig;

  /**
   * Sandbox runtime configuration used when execution reaches a sandbox agent.
   */
  sandbox?: SandboxRunConfig;

  /**
   * SDK-side execution settings for local tool calls.
   */
  toolExecution?: ToolExecutionConfig;

  /**
   * Controls unresolved function tool calls emitted by the model.
   *
   * - `raise_error` preserves the default behavior and raises a `ModelBehaviorError`.
   * - `return_error_to_model` returns a model-visible tool error and lets the run continue.
   */
  toolNotFoundBehavior?: ToolNotFoundBehavior;

  /**
   * Controls collisions between enabled function tool and handoff names.
   *
   * - `warn` logs an actionable warning and exposes only the current dispatch winner.
   * - `error` raises `UserError` before the model is called.
   *
   * Defaults to `warn`. Existing strict validation for namespaced and deferred tools is unchanged.
   */
  toolNameCollisionPolicy?: ToolNameCollisionPolicy;

  /**
   * Customizes how session history is combined with the current turn's input.
   * When omitted, history items are appended before the new input.
   */
  sessionInputCallback?: SessionInputCallback;

  /**
   * Invoked immediately before calling the model, allowing callers to edit the
   * system instructions or input items that will be sent to the model.
   */
  callModelInputFilter?: CallModelInputFilter;

  /**
   * Formats tool error messages that are returned to the model.
   * Returning `undefined` falls back to the SDK default message.
   */
  toolErrorFormatter?: ToolErrorFormatter;

  /**
   * Controls how run items are converted into model input for subsequent turns.
   */
  reasoningItemIdPolicy?: ReasoningItemIdPolicy;
};

/**
 * Common run options shared between streaming and non-streaming execution pathways.
 */
type SharedRunOptions<
  TContext = undefined,
  TAgent extends Agent<any, any> = Agent<any, any>,
> = {
  context?: TContext | RunContext<TContext>;
  maxTurns?: number | null;
  signal?: AbortSignal;
  previousResponseId?: string;
  conversationId?: string;
  session?: Session;
  sessionInputCallback?: SessionInputCallback;
  callModelInputFilter?: CallModelInputFilter;
  toolErrorFormatter?: ToolErrorFormatter;
  reasoningItemIdPolicy?: ReasoningItemIdPolicy;
  tracing?: TracingConfig;
  sandbox?: SandboxRunConfig;
  toolExecution?: ToolExecutionConfig;
  toolNotFoundBehavior?: ToolNotFoundBehavior;
  toolNameCollisionPolicy?: ToolNameCollisionPolicy;
  /**
   * Error handlers keyed by error kind.
   */
  errorHandlers?: RunErrorHandlers<TContext, TAgent>;
};

/**
 * Options for runs that stream incremental events as the model responds.
 */
export type StreamRunOptions<
  TContext = undefined,
  TAgent extends Agent<any, any> = Agent<any, any>,
> = SharedRunOptions<TContext, TAgent> & {
  /**
   * Whether to stream the run. If true, the run will emit events as the model responds.
   */
  stream: true;
};

/**
 * Options for runs that collect the full model response before returning.
 */
export type NonStreamRunOptions<
  TContext = undefined,
  TAgent extends Agent<any, any> = Agent<any, any>,
> = SharedRunOptions<TContext, TAgent> & {
  /**
   * Run to completion without streaming incremental events; leave undefined or set to `false`.
   */
  stream?: false;
};

/**
 * Options polymorphic over streaming or non-streaming execution modes.
 */
export type IndividualRunOptions<
  TContext = undefined,
  TAgent extends Agent<any, any> = Agent<any, any>,
> = StreamRunOptions<TContext, TAgent> | NonStreamRunOptions<TContext, TAgent>;

type RunnerConfig = RunConfig & {
  modelProvider: ModelProvider;
};

class LazyDefaultModelProvider implements ModelProvider {
  #modelProvider: ModelProvider | undefined;

  getModel(modelName?: string): Promise<Model> | Model {
    const modelProvider = this.#modelProvider ?? getDefaultModelProvider();
    this.#modelProvider = modelProvider;
    return modelProvider.getModel(modelName);
  }
}

function isNoopTrace(trace: Trace | null | undefined): boolean {
  return trace instanceof NoopTrace || trace?.traceId === NOOP_TRACE_OR_SPAN_ID;
}

type TurnPreparationSnapshot = {
  currentTurn: number;
  currentTurnInProgress: boolean;
};

function rollbackUnstartedTurn(
  state: RunState<any, any>,
  snapshot: TurnPreparationSnapshot | undefined,
): boolean {
  if (!snapshot) {
    return false;
  }
  state._currentTurn = snapshot.currentTurn;
  state._currentTurnInProgress = snapshot.currentTurnInProgress;
  return true;
}

function assertPendingInputServerOwnership(
  state: RunState<any, any>,
  conversationId: string | undefined,
  previousResponseId: string | undefined,
): void {
  const serverManagesConversation = Boolean(
    conversationId || previousResponseId,
  );
  if (
    state._pendingInput.length === 0 ||
    !serverManagesConversation ||
    getServerConversationOwner(conversationId, previousResponseId)
  ) {
    return;
  }
  throw new UserError(
    'Pending RunState input requires exactly one server-managed conversation owner',
    state,
  );
}

// --------------------------------------------------------------
//  Runner
// --------------------------------------------------------------

/**
 * Executes an agent workflow with the shared default `Runner` instance.
 *
 * @param agent - The entry agent to invoke.
 * @param input - A string utterance, structured input items, or a resumed `RunState`.
 * @param options - Controls streaming mode, context, session handling, and turn limits.
 * @returns A `RunResult` when `stream` is false, otherwise a `StreamedRunResult`.
 */
export async function run<TAgent extends Agent<any, any>, TContext = undefined>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: NonStreamRunOptions<TContext, TAgent>,
): Promise<RunResult<TContext, TAgent>>;
export async function run<TAgent extends Agent<any, any>, TContext = undefined>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: StreamRunOptions<TContext, TAgent>,
): Promise<StreamedRunResult<TContext, TAgent>>;
export async function run<TAgent extends Agent<any, any>, TContext = undefined>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?:
    StreamRunOptions<TContext, TAgent> | NonStreamRunOptions<TContext, TAgent>,
): Promise<RunResult<TContext, TAgent> | StreamedRunResult<TContext, TAgent>> {
  const runner = getDefaultRunner();
  if (options?.stream) {
    return await runner.run(agent, input, options);
  } else {
    return await runner.run(agent, input, options);
  }
}

/**
 * Orchestrates agent execution, including guardrails, tool calls, session persistence, and
 * tracing. Reuse a `Runner` instance when you want consistent configuration across multiple runs.
 */
export class Runner extends RunHooks<any, AgentOutputType<unknown>> {
  public readonly config: RunnerConfig;
  private readonly traceOverrides: {
    traceId?: string;
    workflowName?: string;
    groupId?: string;
    traceMetadata?: Record<string, string>;
    tracingApiKey?: string;
  };

  /**
   * Creates a runner with optional defaults that apply to every subsequent run invocation.
   *
   * @param config - Overrides for models, guardrails, tracing, or session behavior.
   */
  constructor(config: Partial<RunConfig> = {}) {
    super();
    this.config = {
      modelProvider: config.modelProvider ?? new LazyDefaultModelProvider(),
      model: config.model,
      modelSettings: config.modelSettings,
      handoffInputFilter: config.handoffInputFilter,
      inputGuardrails: config.inputGuardrails,
      outputGuardrails: config.outputGuardrails,
      tracingDisabled: config.tracingDisabled ?? false,
      traceIncludeSensitiveData: config.traceIncludeSensitiveData ?? true,
      workflowName: config.workflowName ?? 'Agent workflow',
      traceId: config.traceId,
      groupId: config.groupId,
      traceMetadata: config.traceMetadata,
      tracing: config.tracing,
      sandbox: config.sandbox,
      toolExecution: validateToolExecutionConfig(config.toolExecution),
      toolNotFoundBehavior: config.toolNotFoundBehavior ?? 'raise_error',
      toolNameCollisionPolicy: validateToolNameCollisionPolicy(
        config.toolNameCollisionPolicy,
      ),
      sessionInputCallback: config.sessionInputCallback,
      callModelInputFilter: config.callModelInputFilter,
      toolErrorFormatter: config.toolErrorFormatter,
      reasoningItemIdPolicy: config.reasoningItemIdPolicy,
    };
    this.traceOverrides = {
      ...(config.traceId !== undefined ? { traceId: config.traceId } : {}),
      ...(config.workflowName !== undefined
        ? { workflowName: config.workflowName }
        : {}),
      ...(config.groupId !== undefined ? { groupId: config.groupId } : {}),
      ...(config.traceMetadata !== undefined
        ? { traceMetadata: config.traceMetadata }
        : {}),
      ...(config.tracing?.apiKey !== undefined
        ? { tracingApiKey: config.tracing.apiKey }
        : {}),
    };
    this.inputGuardrailDefs = (config.inputGuardrails ?? []).map(
      defineInputGuardrail,
    );
    this.outputGuardrailDefs = (config.outputGuardrails ?? []).map(
      defineOutputGuardrail,
    );
  }

  /**
   * Run a workflow starting at the given agent. The agent will run in a loop until a final
   * output is generated. The loop runs like so:
   * 1. The agent is invoked with the given input.
   * 2. If there is a final output (i.e. the agent produces something of type
   *    `agent.outputType`, the loop terminates.
   * 3. If there's a handoff, we run the loop again, with the new agent.
   * 4. Else, we run tool calls (if any), and re-run the loop.
   *
   * In two cases, the agent may raise an exception:
   * 1. If the maxTurns is exceeded, a MaxTurnsExceeded exception is raised unless handled.
   * 2. If a guardrail tripwire is triggered, a GuardrailTripwireTriggered exception is raised.
   *
   * Note that only the first agent's input guardrails are run.
   *
   * @param agent - The starting agent to run.
   * @param input - The initial input to the agent. You can pass a string or an array of
   * `AgentInputItem`.
   * @param options - Options for the run, including streaming behavior, execution context, and the
   * maximum number of turns.
   * @returns The result of the run.
   */
  run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: NonStreamRunOptions<TContext, TAgent>,
  ): Promise<RunResult<TContext, TAgent>>;
  run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: StreamRunOptions<TContext, TAgent>,
  ): Promise<StreamedRunResult<TContext, TAgent>>;
  async run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options: IndividualRunOptions<TContext, TAgent> = {
      stream: false,
      context: undefined,
    } as IndividualRunOptions<TContext, TAgent>,
  ): Promise<
    RunResult<TContext, TAgent> | StreamedRunResult<TContext, TAgent>
  > {
    this.#validateModelTimeoutForAgent(
      input instanceof RunState ? input._currentAgent : agent,
    );
    if (input instanceof RunState) {
      if (isNoopTrace(input._trace)) {
        input._trace = null;
      }
      if (input._currentAgentSpan?.spanId === NOOP_TRACE_OR_SPAN_ID) {
        input.setCurrentAgentSpan(undefined);
      }
    }
    const taskSpanName = this.#getTaskSpanName(
      input instanceof RunState ? input._trace?.name : undefined,
    );
    const capturedInvocationTraceContext = getCurrentTraceContext();
    const invocationTraceContext = isNoopTrace(
      capturedInvocationTraceContext?.trace,
    )
      ? undefined
      : capturedInvocationTraceContext;
    const configuredInvocationSpanParent = getRunnerInvocationSpanParent(this);
    const invocationSpanParent: Span<any> | Trace | undefined =
      configuredInvocationSpanParent ??
      (input instanceof RunState && input._trace
        ? input._trace
        : (invocationTraceContext?.span ?? invocationTraceContext?.trace));
    const resolvedOptions = options ?? { stream: false, context: undefined };
    // Per-run options take precedence over runner defaults for session memory behavior.
    const sessionInputCallback =
      resolvedOptions.sessionInputCallback ?? this.config.sessionInputCallback;
    // Likewise allow callers to override callModelInputFilter on individual runs.
    const callModelInputFilter =
      resolvedOptions.callModelInputFilter ?? this.config.callModelInputFilter;
    // Per-run callback can override runner-level tool error formatting defaults.
    const toolErrorFormatter =
      resolvedOptions.toolErrorFormatter ?? this.config.toolErrorFormatter;
    const reasoningItemIdPolicy =
      resolvedOptions.reasoningItemIdPolicy ??
      (input instanceof RunState ? input._reasoningItemIdPolicy : undefined) ??
      this.config.reasoningItemIdPolicy;
    const toolExecution = validateToolExecutionConfig(
      resolvedOptions.toolExecution ?? this.config.toolExecution,
    );
    const toolNotFoundBehavior =
      resolvedOptions.toolNotFoundBehavior ?? this.config.toolNotFoundBehavior;
    const toolNameCollisionPolicy = validateToolNameCollisionPolicy(
      resolvedOptions.toolNameCollisionPolicy === undefined
        ? this.config.toolNameCollisionPolicy
        : resolvedOptions.toolNameCollisionPolicy,
    );
    const hasCallModelInputFilter = Boolean(callModelInputFilter);
    const tracingConfig = mergeTracingConfig(
      this.config.tracing,
      resolvedOptions.tracing,
    );
    const runContext =
      input instanceof RunState
        ? input._context
        : resolvedOptions.context instanceof RunContext
          ? resolvedOptions.context
          : new RunContext(resolvedOptions.context);
    const traceOverrides = {
      ...this.traceOverrides,
      ...(resolvedOptions.tracing?.apiKey !== undefined
        ? { tracingApiKey: resolvedOptions.tracing.apiKey }
        : {}),
    };
    const effectiveOptions = {
      ...resolvedOptions,
      context: runContext,
      sessionInputCallback,
      callModelInputFilter,
      toolErrorFormatter,
      reasoningItemIdPolicy,
      toolExecution,
      toolNotFoundBehavior,
      toolNameCollisionPolicy,
      tracing: tracingConfig,
    };
    const useTaskAndTurnSpans =
      !this.config.tracingDisabled && includeTaskAndTurnSpans(tracingConfig);
    const resumingFromState = input instanceof RunState;
    // A resumed turn may be inactive but already have persisted items.
    const preserveTurnPersistenceOnResume =
      resumingFromState &&
      ((input as RunState<TContext, TAgent>)._currentTurnInProgress === true ||
        (input as RunState<TContext, TAgent>)._currentTurnPersistedItemCount >
          0);
    const resumedConversationId = resumingFromState
      ? (input as RunState<TContext, TAgent>)._conversationId
      : undefined;
    const resumedPreviousResponseId = resumingFromState
      ? (input as RunState<TContext, TAgent>)._previousResponseId
      : undefined;
    const serverManagesConversation =
      Boolean(effectiveOptions.conversationId ?? resumedConversationId) ||
      Boolean(effectiveOptions.previousResponseId ?? resumedPreviousResponseId);
    // When the server tracks conversation history we defer to it for previous turns so local session
    // persistence can focus solely on the new delta being generated in this process.
    const session = effectiveOptions.session;
    let provisionalSessionHistoryTransactionSessionId: string | undefined;
    let provisionalSessionHistoryTransactionInputItems:
      AgentInputItem[] | undefined;
    if (resumingFromState) {
      const resumedState = input as RunState<TContext, TAgent>;
      assertAcceptedResponseContinuationAuthority(
        resumedState,
        effectiveOptions.conversationId,
        effectiveOptions.previousResponseId,
      );
      const hadSessionBinding =
        resumedState._currentTurnSessionHistoryTransactionSessionId !==
        undefined;
      const portableInputItems =
        resumedState._currentTurnSessionHistoryTransactionInputItems;
      assertResumedSessionOutputGuardrailSafety(
        resumedState,
        session,
        this.#agentHasOutputGuardrail(resumedState._currentAgent),
      );
      resumedState.setReasoningItemIdPolicy(reasoningItemIdPolicy);
      await prepareSessionHistoryTransactionsForRun(session, resumedState, {
        serverManagesConversation,
      });
      if (!hadSessionBinding) {
        provisionalSessionHistoryTransactionSessionId =
          resumedState._currentTurnSessionHistoryTransactionSessionId;
        provisionalSessionHistoryTransactionInputItems = portableInputItems;
      }
    }
    const sessionPersistence = createSessionPersistenceTracker({
      session,
      runContext,
      hasCallModelInputFilter,
      persistInput: saveStreamInputToSession,
      resumingFromState,
      resumedSessionInputItems: resumingFromState
        ? (input as RunState<TContext, TAgent>)
            ._currentTurnSessionHistoryTransactionInputItems
        : undefined,
    });

    let preparedInput: typeof input = input;
    if (!(preparedInput instanceof RunState)) {
      const prepared = await prepareInputItemsWithSession(
        preparedInput,
        session,
        sessionInputCallback,
        {
          // When the server tracks conversation state we only send the new turn inputs;
          // previous messages are recovered via conversationId/previousResponseId.
          includeHistoryInPreparedInput: !serverManagesConversation,
          preserveDroppedNewItems: serverManagesConversation,
          reasoningItemIdPolicy,
        },
        runContext,
      );
      if (serverManagesConversation && session) {
        // When the server manages memory we only persist the new turn inputs locally so the
        // conversation service stays the single source of truth for prior exchanges.
        const sessionItems = prepared.sessionItems;
        if (sessionItems && sessionItems.length > 0) {
          preparedInput = sessionItems;
        } else {
          preparedInput = prepared.preparedInput;
        }
      } else {
        preparedInput = prepared.preparedInput;
      }
      sessionPersistence?.setPreparedItems(
        prepared.sessionItems,
        prepared.preparedInput,
      );
    }
    // Streaming runs persist the input asynchronously, so track a one-shot helper
    // that can be awaited from multiple branches without double-writing.
    const ensureStreamInputPersisted =
      sessionPersistence?.buildPersistInputOnce(serverManagesConversation);

    const executeRun = async (
      effectiveInvocationSpanParent = invocationSpanParent,
    ) => {
      if (effectiveOptions.stream) {
        const streamResult = await this.#runIndividualStream(
          agent,
          preparedInput,
          taskSpanName,
          effectiveOptions,
          ensureStreamInputPersisted,
          sessionPersistence?.setPreparedTurnItems,
          sessionPersistence?.recordTurnItems,
          sessionPersistence?.getItemsForPersistence,
          preserveTurnPersistenceOnResume,
          provisionalSessionHistoryTransactionSessionId,
          provisionalSessionHistoryTransactionInputItems,
          {
            sdkSessionId: async () => await session?.getSessionId(),
            inputOverride: () =>
              session
                ? sessionPersistence?.getItemsForPersistence()
                : undefined,
          },
          effectiveInvocationSpanParent,
        );
        return streamResult;
      }
      const runResult = await this.#runIndividualNonStream(
        agent,
        preparedInput,
        effectiveOptions,
        taskSpanName,
        sessionPersistence?.setPreparedTurnItems,
        sessionPersistence?.recordTurnItems,
        sessionPersistence?.getItemsForPersistence,
        preserveTurnPersistenceOnResume,
        provisionalSessionHistoryTransactionSessionId,
        provisionalSessionHistoryTransactionInputItems,
        {
          sdkSessionId: async () => await session?.getSessionId(),
          inputOverride: () =>
            session ? sessionPersistence?.getItemsForPersistence() : undefined,
        },
        effectiveInvocationSpanParent,
        session && sessionPersistence && !serverManagesConversation
          ? async (result, persistenceOptions) => {
              await saveToSession(
                session,
                sessionPersistence.getItemsForPersistence(),
                result,
                persistenceOptions,
              );
            }
          : undefined,
      );
      return runResult;
    };

    if (this.config.tracingDisabled) {
      const disabledTrace = new NoopTrace();
      if (preparedInput instanceof RunState) {
        preparedInput._currentAgentSpan?.end();
        preparedInput._trace = null;
        preparedInput.setCurrentAgentSpan(undefined);
      }
      return withTrace(disabledTrace, async () => {
        try {
          const result = await executeRun(disabledTrace);
          const clearDisabledTraceState = () => {
            result.state._trace = null;
            result.state.setCurrentAgentSpan(undefined);
          };
          if (result instanceof StreamedRunResult) {
            void result.completed.then(
              clearDisabledTraceState,
              clearDisabledTraceState,
            );
          } else {
            clearDisabledTraceState();
          }
          return result;
        } catch (error) {
          if (error instanceof AgentsError && error.state) {
            error.state._trace = null;
            error.state.setCurrentAgentSpan(undefined);
          }
          throw error;
        }
      });
    }

    if (preparedInput instanceof RunState && preparedInput._trace) {
      const applied = applyTraceOverrides(
        preparedInput._trace,
        preparedInput._currentAgentSpan,
        traceOverrides,
      );
      preparedInput._trace = applied.trace;
      preparedInput._currentAgentSpan = applied.currentSpan;
      return withTrace(preparedInput._trace, async () => {
        if (preparedInput._currentAgentSpan && !useTaskAndTurnSpans) {
          setCurrentSpan(preparedInput._currentAgentSpan);
        }
        return executeRun();
      });
    }
    const executeInInvocationTrace = async (
      effectiveInvocationSpanParent = invocationSpanParent,
    ) => {
      if (preparedInput instanceof RunState && !preparedInput._trace) {
        preparedInput._trace = getCurrentTrace();
      }
      return executeRun(effectiveInvocationSpanParent);
    };
    if (invocationTraceContext) {
      return withTraceContext(invocationTraceContext, executeInInvocationTrace);
    }
    return withTrace(
      this.config.workflowName ?? 'Agent workflow',
      async (trace) => executeInInvocationTrace(trace),
      {
        traceId: this.config.traceId,
        groupId: this.config.groupId,
        metadata: this.config.traceMetadata,
        // Per-run tracing config overrides exporter defaults such as environment API key.
        tracingApiKey: tracingConfig?.apiKey,
      },
    );
  }

  // --------------------------------------------------------------
  //  Internals
  // --------------------------------------------------------------

  #getTaskSpanName(restoredWorkflowName?: string): string {
    return (
      this.traceOverrides.workflowName ??
      restoredWorkflowName ??
      this.config.workflowName ??
      'Agent workflow'
    );
  }

  private readonly inputGuardrailDefs: InputGuardrailDefinition[];

  private readonly outputGuardrailDefs: OutputGuardrailDefinition<
    OutputGuardrailMetadata,
    AgentOutputType<unknown>
  >[];

  #agentHasOutputGuardrail(agent: Agent<any, any>): boolean {
    return Boolean(
      this.outputGuardrailDefs.length > 0 || agent.outputGuardrails.length > 0,
    );
  }

  #shouldDeferInterruptedSessionItems(state: RunState<any, any>): boolean {
    return shouldDeferInterruptedSessionItems(
      state,
      this.#agentHasOutputGuardrail(state._currentAgent),
    );
  }

  /**
   * @internal
   * Resolves the effective model once so both run loops obey the same precedence rules.
   */
  async #resolveModelForAgent<TContext>(
    agent: Agent<TContext, AgentOutputType>,
  ): Promise<{
    model: Model;
    explicitlyModelSet: boolean;
    resolvedModelName?: string;
  }> {
    const explicitlyModelSet =
      (agent.model !== undefined &&
        agent.model !== Agent.DEFAULT_MODEL_PLACEHOLDER) ||
      (this.config.model !== undefined &&
        this.config.model !== Agent.DEFAULT_MODEL_PLACEHOLDER);
    const selectedModel = selectModel(agent.model, this.config.model);
    const resolvedModelName =
      typeof selectedModel === 'string' ? selectedModel : undefined;
    const resolvedModel =
      typeof selectedModel === 'string'
        ? await this.config.modelProvider.getModel(selectedModel)
        : selectedModel;
    return { model: resolvedModel, explicitlyModelSet, resolvedModelName };
  }

  async #resolveSandboxRuntimeModelForAgent<TContext>(
    agent: Agent<TContext, AgentOutputType>,
  ): Promise<SandboxRuntimeModel | undefined> {
    if (!isSandboxRuntimeAgent(agent)) {
      return this.config.model;
    }

    const resolved = await this.#resolveModelForAgent(agent);
    if (
      resolved.resolvedModelName &&
      resolved.resolvedModelName.trim().length > 0
    ) {
      return {
        model: resolved.resolvedModelName,
        modelInstance: resolved.model,
      };
    }

    return resolved.model;
  }

  #getAgentToolParentRunConfig<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
  >(options: SharedRunOptions<TContext, TAgent>): Partial<RunConfig> {
    const hasSandboxOverride = typeof options.sandbox !== 'undefined';
    const hasToolExecutionOverride =
      typeof options.toolExecution !== 'undefined';
    const hasToolNotFoundBehaviorOverride =
      typeof options.toolNotFoundBehavior !== 'undefined';
    const hasToolNameCollisionPolicyOverride =
      typeof options.toolNameCollisionPolicy !== 'undefined';
    const hasTracingOverride = typeof options.tracing !== 'undefined';
    if (
      !hasSandboxOverride &&
      !hasToolExecutionOverride &&
      !hasToolNotFoundBehaviorOverride &&
      !hasToolNameCollisionPolicyOverride &&
      !hasTracingOverride
    ) {
      return this.config;
    }
    return {
      ...this.config,
      ...(hasSandboxOverride ? { sandbox: options.sandbox } : {}),
      ...(hasToolExecutionOverride
        ? { toolExecution: options.toolExecution }
        : {}),
      ...(hasToolNotFoundBehaviorOverride
        ? { toolNotFoundBehavior: options.toolNotFoundBehavior }
        : {}),
      ...(hasToolNameCollisionPolicyOverride
        ? { toolNameCollisionPolicy: options.toolNameCollisionPolicy }
        : {}),
      ...(hasTracingOverride ? { tracing: options.tracing } : {}),
    };
  }

  /**
   * @internal
   */
  async #runIndividualNonStream<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
    _THandoffs extends (Agent<any, any> | Handoff<any>)[] = any[],
  >(
    startingAgent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options: NonStreamRunOptions<TContext, TAgent>,
    taskSpanName: string,
    sessionTurnInputUpdate?: (
      preparedInput: AgentInputItem[],
      processedInput: AgentInputItem[],
    ) => void,
    // sessionInputUpdate lets the caller adjust queued session items after filters run so we
    // persist exactly what we send to the model (e.g., after redactions or truncation).
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
    getSessionInputForPersistence?: () => AgentInputItem[] | undefined,
    preserveTurnPersistenceOnResume?: boolean,
    provisionalSessionHistoryTransactionSessionId?: string,
    provisionalSessionHistoryTransactionInputItems?: AgentInputItem[],
    sandboxMemoryRunContext?: SandboxMemoryPersistenceContext,
    invocationSpanParent?: Span<any> | Trace,
    persistResult?: (
      result: RunResult<TContext, TAgent>,
      options?: SessionPersistenceOptions,
    ) => Promise<void>,
  ): Promise<RunResult<TContext, TAgent>> {
    return withNewSpanContext(async () => {
      // if we have a saved state we use that one, otherwise we create a new one
      const isResumedState = input instanceof RunState;
      const state = isResumedState
        ? input
        : new RunState(
            options.context instanceof RunContext
              ? options.context
              : new RunContext(options.context),
            input,
            startingAgent,
            options.maxTurns === undefined
              ? DEFAULT_MAX_TURNS
              : options.maxTurns,
          );
      this.#validateModelTimeoutForAgent(state._currentAgent);
      if (isResumedState) {
        state._agentToolInvocation = undefined;
        if (options.maxTurns !== undefined) {
          state._maxTurns = options.maxTurns;
        }
      }
      const sandboxRuntime = new SandboxRuntimeManager<TContext>({
        startingAgent,
        sandboxConfig: options.sandbox ?? this.config.sandbox,
        runState: isResumedState
          ? (state as RunState<TContext, Agent<TContext, AgentOutputType>>)
          : undefined,
      });
      const agentToolParentRunConfig =
        this.#getAgentToolParentRunConfig(options);
      const resolvedReasoningItemIdPolicy =
        options.reasoningItemIdPolicy ??
        (isResumedState ? state._reasoningItemIdPolicy : undefined) ??
        this.config.reasoningItemIdPolicy;
      state.setReasoningItemIdPolicy(resolvedReasoningItemIdPolicy);

      const resolvedConversationId =
        options.conversationId ??
        (isResumedState ? state._conversationId : undefined);
      const resolvedPreviousResponseId =
        options.previousResponseId ??
        (isResumedState ? state._previousResponseId : undefined);
      const serverManagesConversation = Boolean(
        resolvedConversationId || resolvedPreviousResponseId,
      );
      assertPendingInputServerOwnership(
        state,
        resolvedConversationId,
        resolvedPreviousResponseId,
      );

      if (!isResumedState) {
        await prepareSessionHistoryTransactionsForRun(options.session, state, {
          serverManagesConversation,
        });
      }

      if (!isResumedState) {
        state.setConversationContext(
          resolvedConversationId,
          resolvedPreviousResponseId,
        );
      }

      const serverConversationTracker = serverManagesConversation
        ? new ServerConversationTracker({
            conversationId: resolvedConversationId,
            previousResponseId: resolvedPreviousResponseId,
            reasoningItemIdPolicy: resolvedReasoningItemIdPolicy,
          })
        : undefined;

      if (serverConversationTracker && isResumedState) {
        serverConversationTracker.primeFromState({
          originalInput: state._originalInput,
          generatedItems: state._generatedItems,
          modelResponses: state._modelResponses,
        });
        state.setConversationContext(
          serverConversationTracker.conversationId,
          serverConversationTracker.previousResponseId,
        );
      }
      const toolErrorFormatter =
        options.toolErrorFormatter ?? this.config.toolErrorFormatter;

      const useTaskAndTurnSpans =
        !this.config.tracingDisabled &&
        includeTaskAndTurnSpans(options.tracing);
      const resumingInterruptedTurn =
        isResumedState && state._currentStep?.type === 'next_step_interruption';
      const invocationSpans = useTaskAndTurnSpans
        ? startRunnerInvocationSpans({
            name: taskSpanName,
            agent: state._currentAgent,
            restoredAgentSpan: isResumedState
              ? state._currentAgentSpan
              : undefined,
            resumeInterruptedTurn: resumingInterruptedTurn,
            parent: invocationSpanParent,
          })
        : undefined;
      const taskSpan = invocationSpans?.taskSpan;
      const optOutResumeAgentSpan =
        resumingInterruptedTurn && !useTaskAndTurnSpans
          ? ensureActiveAgentSpanForInterruptedResume({
              agent: state._currentAgent,
              restoredAgentSpan: isResumedState
                ? state._currentAgentSpan
                : undefined,
              parent: invocationSpanParent ?? getCurrentTrace() ?? undefined,
            })
          : undefined;
      if (useTaskAndTurnSpans && isResumedState) {
        state.setCurrentAgentSpan(invocationSpans?.agentSpan);
      } else if (optOutResumeAgentSpan) {
        state.setCurrentAgentSpan(optOutResumeAgentSpan);
      }

      // Tracks when we resume an approval interruption so the next run-again step stays in the same turn.
      let continuingInterruptedTurn = false;
      let runError: unknown;
      const attemptedRunErrorHandlers = new WeakSet<object>();
      let currentTurnSpan: ReturnType<typeof startTurnSpan> | undefined;
      let turnPendingModelRequest: TurnPreparationSnapshot | undefined;
      let guardrailTracker = createGuardrailTracker();
      const parentUsageRecorder = getRunnerParentUsageRecorder(this);
      const recordUsage = (usage: Usage) => {
        recordRunnerSpanUsage(taskSpan, usage);
        recordRunnerSpanUsage(currentTurnSpan, usage);
        parentUsageRecorder?.(usage);
      };
      setRunStateUsageRecorder(state, recordUsage);
      let completedResult: RunResult<TContext, TAgent> | undefined;
      let persistenceCheckpoint: RunResult<TContext, TAgent> | undefined;
      let approvedToolCheckpointCompacted = false;
      let approvedToolCheckpointRequiresLocalInputCompaction =
        isResumedState && hasPersistedToolOutput(state);
      let approvedToolCheckpointModelResponseCount =
        state._modelResponses.length;
      let completedResultPersisted = false;
      const completeResult = (result: RunResult<TContext, TAgent>) => {
        completedResult = result;
        return result;
      };
      const persistNonStreamingResult = async (
        result: RunResult<TContext, TAgent>,
        overrideOptions?: SessionPersistenceOptions,
      ) => {
        if (this.#shouldDeferInterruptedSessionItems(result.state)) {
          return;
        }
        const hasUnpersistedItems =
          result.newItems.length > state._currentTurnPersistedItemCount ||
          (overrideOptions?.additionalRunItems?.length ?? 0) > 0;
        const modelResponseAdvanced =
          result.rawResponses.length > approvedToolCheckpointModelResponseCount;
        const compactionOptions =
          approvedToolCheckpointRequiresLocalInputCompaction
            ? approvedToolCheckpointCompacted &&
              !hasUnpersistedItems &&
              !modelResponseAdvanced
              ? { runCompaction: false }
              : { compactionMode: 'input' as const }
            : undefined;
        const persistenceOptions = {
          ...compactionOptions,
          ...overrideOptions,
        };
        await persistResult?.(result, persistenceOptions);
      };
      const recordNonStreamingError = (error: unknown) => {
        if (state._currentAgentSpan) {
          state._currentAgentSpan.setError({
            message: 'Error in agent run',
            data: {
              error: getRunnerSpanErrorDetails(
                error,
                this.config.traceIncludeSensitiveData,
              ),
            },
          });
        }
        setRunnerSpanError(
          currentTurnSpan,
          error,
          this.config.traceIncludeSensitiveData,
        );
        setRunnerSpanError(
          taskSpan,
          error,
          this.config.traceIncludeSensitiveData,
        );
        runError = error;
      };
      const finalizeCurrentOutput = async (
        preparedErrorOutput?: PreparedRunErrorFinalOutput,
      ): Promise<RunResult<TContext, TAgent>> => {
        const currentStep = state._currentStep;
        if (currentStep?.type !== 'next_step_final_output') {
          throw new ModelBehaviorError(
            'Expected a final output step while finalizing the run.',
            state,
          );
        }
        markAcceptedResponseFinalizationStarted(state);
        await finalizeOutputGuardrails({
          state,
          runnerOutputGuardrails: this.outputGuardrailDefs,
          output: currentStep.output,
          redactedOutput: OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
          guardedTerminalToolOutput: hasTerminalToolOutputSource(state),
          signal: options.signal,
          sanitizeRejectedOutput: sanitizeBlockedTerminalToolOutput,
          persistBlockedOutput: persistResult
            ? async () =>
                persistResult(new RunResult<TContext, TAgent>(state), {
                  outputBlocked: true,
                })
            : undefined,
          persistUnblockedFailure: async () => {
            await persistNonStreamingResult(
              new RunResult<TContext, TAgent>(state),
            );
            completedResultPersisted = true;
          },
          releaseBlockedOutputPersistence:
            releaseUnusedSessionHistoryTransactionBinding,
        });
        if (
          state._serializedCurrentStep === currentStep &&
          hasRetainableBlockedOutputEffect(state)
        ) {
          releaseProvisionalSessionHistoryTransactionBinding(
            state,
            provisionalSessionHistoryTransactionSessionId,
            provisionalSessionHistoryTransactionInputItems,
          );
          throw new UserError(
            'Accepted final output cannot be resumed directly from serialized terminal state. Start a new run from persisted session history.',
          );
        }
        finishRunnerSpan(currentTurnSpan);
        setRunStateTurnSpanParent(state, undefined);
        currentTurnSpan = undefined;
        const result = new RunResult<TContext, TAgent>(state);
        try {
          await persistNonStreamingResult(
            result,
            preparedErrorOutput?.deferredItem
              ? { additionalRunItems: [preparedErrorOutput.deferredItem] }
              : undefined,
          );
        } catch (error) {
          commitDeferredRunErrorItemAfterPartialPersistence(
            state,
            preparedErrorOutput,
          );
          throw error;
        }
        if (preparedErrorOutput?.deferredItem) {
          state._generatedItems.push(preparedErrorOutput.deferredItem);
        }
        completedResultPersisted = true;
        state._currentTurnInProgress = false;
        this.emit(
          'agent_end',
          state._context,
          state._currentAgent,
          currentStep.output,
        );
        state._currentAgent.emit(
          'agent_end',
          state._context,
          currentStep.output,
        );
        return completeResult(result);
      };

      try {
        while (true) {
          // if we don't have a current step, we treat this as a new run
          state._currentStep = state._currentStep ?? {
            type: 'next_step_run_again',
          };

          if (isAcceptedResponseCheckpoint(state)) {
            captureCurrentResponseToolOutputGuardrailResultStart(state, false);
            await resumeAcceptedModelResponse({
              state,
              runner: this,
              toolErrorFormatter,
              agentToolParentRunConfig,
              signal: options.signal,
              validateHandoffAgent: (handoffAgent) => {
                this.#validateModelTimeoutForAgent(handoffAgent);
              },
            });
          }

          if (state._currentStep.type === 'next_step_interruption') {
            await prepareSandboxInterruptedTurnResume({
              startingAgent,
              state,
              sandboxRuntime,
              runConfigModel: await this.#resolveSandboxRuntimeModelForAgent(
                state._currentAgent,
              ),
              toolNameCollisionPolicy: options.toolNameCollisionPolicy,
              tracingParent:
                getRunStateTurnSpanParent(state) ?? state._currentAgentSpan,
            });

            if (useTaskAndTurnSpans) {
              currentTurnSpan = ensureTurnSpan(
                currentTurnSpan,
                state._currentTurn,
                state._currentAgent.name,
                state._currentAgentSpan,
              );
              setRunStateTurnSpanParent(state, currentTurnSpan.span);
            }

            captureCurrentResponseToolOutputGuardrailResultStart(state, false);
            const interruptedOutcome = await resumeInterruptedTurn({
              state,
              runner: this,
              toolErrorFormatter,
              agentToolParentRunConfig,
              signal: options.signal,
              validateHandoffAgent: (handoffAgent) => {
                this.#validateModelTimeoutForAgent(handoffAgent);
              },
            });
            const approvedToolCheckpointDeferred =
              interruptedOutcome.approvedToolResumed &&
              interruptedOutcome.nextStep.type === 'next_step_final_output' &&
              this.#agentHasOutputGuardrail(state._currentAgent);
            if (interruptedOutcome.approvedToolResumed) {
              const approvedToolResult = new RunResult<TContext, TAgent>(state);
              approvedToolCheckpointRequiresLocalInputCompaction = true;
              if (
                persistResult &&
                interruptedOutcome.nextStep.type !== 'next_step_final_output' &&
                !this.#shouldDeferInterruptedSessionItems(state)
              ) {
                await persistResult(approvedToolResult, {
                  compactionMode: 'input',
                });
                approvedToolCheckpointCompacted = true;
                approvedToolCheckpointModelResponseCount =
                  approvedToolResult.rawResponses.length;
              }
            }
            if (options.signal?.aborted && !approvedToolCheckpointDeferred) {
              persistenceCheckpoint = new RunResult<TContext, TAgent>(state);
            }
            options.signal?.throwIfAborted();

            // Don't reset counter here - resolveInterruptedTurn already adjusted it via rewind logic
            // The counter will be reset when _currentTurn is incremented (starting a new turn)

            const { shouldReturn, shouldContinue } = handleInterruptedOutcome({
              state,
              outcome: interruptedOutcome,
              setContinuingInterruptedTurn: (value) => {
                continuingInterruptedTurn = value;
              },
            });
            if (!shouldContinue) {
              finishRunnerSpan(currentTurnSpan);
              setRunStateTurnSpanParent(state, undefined);
              currentTurnSpan = undefined;
            }
            if (shouldReturn) {
              // we are still in an interruption, so we need to avoid an infinite loop
              return completeResult(new RunResult<TContext, TAgent>(state));
            }
            if (shouldContinue) {
              continue;
            }
          }

          if (state._currentStep.type === 'next_step_run_again') {
            this.#validateModelTimeoutForAgent(state._currentAgent);
            if (
              approvedToolCheckpointCompacted &&
              state._currentTurnSessionHistoryTransactionSessionId === undefined
            ) {
              await prepareSessionHistoryTransactionsForRun(
                options.session,
                state,
                { serverManagesConversation: false },
              );
            }
            const wasContinuingInterruptedTurn = continuingInterruptedTurn;
            continuingInterruptedTurn = false;
            guardrailTracker = createGuardrailTracker();
            const previousTurn = state._currentTurn;
            turnPendingModelRequest = {
              currentTurn: previousTurn,
              currentTurnInProgress: state._currentTurnInProgress,
            };
            const previousPersistedCount = state._currentTurnPersistedItemCount;
            const previousGeneratedCount = state._generatedItems.length;
            const { turnInput, pendingInputItems, pendingInputSourceItems } =
              await prepareTurn({
                state,
                input: state._originalInput,
                generatedItems: state._generatedItems,
                isResumedState,
                preserveTurnPersistenceOnResume,
                continuingInterruptedTurn: wasContinuingInterruptedTurn,
                serverConversationTracker,
                inputGuardrailDefs: this.inputGuardrailDefs,
                guardrailHandlers: {
                  onParallelPromise: guardrailTracker.setPromise,
                  onParallelError: guardrailTracker.setError,
                },
                emitAgentStart: (context, agent, inputItems) => {
                  this.emit('agent_start', context, agent, inputItems);
                },
                onAgentSpanReady: useTaskAndTurnSpans
                  ? (turn, agentName) => {
                      currentTurnSpan = ensureTurnSpan(
                        currentTurnSpan,
                        turn,
                        agentName,
                        state._currentAgentSpan,
                      );
                      setRunStateTurnSpanParent(state, currentTurnSpan.span);
                    }
                  : undefined,
                agentSpanParent: taskSpan?.span ?? invocationSpanParent,
              });
            if (
              preserveTurnPersistenceOnResume &&
              state._currentTurn > previousTurn &&
              previousPersistedCount <= previousGeneratedCount
            ) {
              // Preserve persisted offsets from a resumed run to avoid re-saving prior items.
              state._currentTurnPersistedItemCount = previousPersistedCount;
            }

            const sessionPreparedTurnInput = [...turnInput];
            const preparedSandboxAgent = await sandboxRuntime.prepareAgent({
              currentAgent: state._currentAgent,
              turnInput,
              runConfigModel: await this.#resolveSandboxRuntimeModelForAgent(
                state._currentAgent,
              ),
              tracingParent: currentTurnSpan?.span ?? state._currentAgentSpan,
            });
            sessionTurnInputUpdate?.(
              sessionPreparedTurnInput,
              preparedSandboxAgent.turnInput,
            );
            const processedPendingInputItems =
              mapPendingInputAfterContextProcessing(
                pendingInputItems,
                sessionPreparedTurnInput,
                preparedSandboxAgent.turnInput,
              );
            const artifacts = await prepareAgentArtifacts(
              state,
              preparedSandboxAgent.executionAgent,
              options.toolNameCollisionPolicy,
            );
            const preparedCall = await this.#prepareModelCall(
              state,
              preparedSandboxAgent.executionAgent,
              options,
              artifacts,
              preparedSandboxAgent.turnInput,
              serverConversationTracker,
              sessionInputUpdate,
            );
            captureSessionHistoryTransactionInputItems(
              options.session,
              state,
              getSessionInputForPersistence?.(),
            );

            await guardrailTracker.throwIfError();

            const requiresPendingInputAdmissionCheckpoint =
              pendingInputItems.length > 0 ||
              (!serverConversationTracker && hasUnpersistedRunInput(state));
            if (requiresPendingInputAdmissionCheckpoint) {
              options.signal?.throwIfAborted();
            }
            const admittedPendingInput = selectPendingInputForAdmission(
              processedPendingInputItems,
              preparedCall,
            );
            let localPendingInputCommitted = false;
            const commitLocalPendingInput = async () => {
              if (serverConversationTracker || localPendingInputCommitted) {
                return;
              }
              localPendingInputCommitted = true;
              commitPendingInput(
                state,
                pendingInputItems,
                admittedPendingInput,
                pendingInputSourceItems,
              );
              if (hasUnpersistedRunInput(state)) {
                await saveToSession(
                  options.session,
                  undefined,
                  new RunResult<TContext, TAgent>(state),
                  { runCompaction: false },
                );
              }
              if (requiresPendingInputAdmissionCheckpoint) {
                options.signal?.throwIfAborted();
              }
            };
            const deferLocalPendingInputAdmission =
              !serverConversationTracker &&
              pendingInputItems.length > 0 &&
              guardrailTracker.pending;
            if (!deferLocalPendingInputAdmission) {
              await commitLocalPendingInput();
            }

            const modelRequest: ModelRequest = {
              systemInstructions: preparedCall.modelInput.instructions,
              prompt: preparedCall.prompt,
              // Explicit agent/run config models should take precedence over prompt defaults.
              ...(preparedCall.explicitlyModelSet
                ? { overridePromptModel: true }
                : {}),
              input: preparedCall.modelInput.input,
              previousResponseId: preparedCall.previousResponseId,
              conversationId: preparedCall.conversationId,
              modelSettings: preparedCall.modelSettings,
              _internal: preparedCall.modelRequestInternal,
              tools: preparedCall.serializedTools,
              toolsExplicitlyProvided: preparedCall.toolsExplicitlyProvided,
              outputType: convertAgentOutputTypeToSerializable(
                state._currentAgent.outputType,
              ),
              handoffs: preparedCall.serializedHandoffs,
              tracing: getTracing(
                this.config.tracingDisabled,
                this.config.traceIncludeSensitiveData,
              ),
              signal: options.signal,
            };
            turnPendingModelRequest = undefined;
            let serverInputMarked = false;
            const markServerInputAccepted = (responseAvailable = true) => {
              if (serverInputMarked || !serverConversationTracker) {
                return;
              }
              serverConversationTracker.markInputAsSent(
                preparedCall.filterApplied
                  ? preparedCall.sourceItems
                  : preparedCall.turnInput,
                {
                  filterApplied: preparedCall.filterApplied,
                  allTurnItems: preparedCall.turnInput,
                },
              );
              commitPendingInput(
                state,
                pendingInputItems,
                admittedPendingInput,
                pendingInputSourceItems,
              );
              if (pendingInputItems.length > 0) {
                if (admittedPendingInput.length > 0) {
                  serverConversationTracker.markInputAsSent(
                    admittedPendingInput.map((item) => item.rawItem),
                  );
                }
              }
              if (pendingInputItems.length > 0 || !responseAvailable) {
                if (!responseAvailable) {
                  state._lastTurnResponse = undefined;
                }
                state._lastProcessedResponse = undefined;
                state._currentStep = {
                  type: 'next_step_interruption',
                  data: { interruptions: [], responseAccepted: true },
                };
              }
              serverInputMarked = true;
            };
            const pendingModelResponse = getResponseWithRetry(
              preparedCall.model,
              modelRequest,
              serverConversationTracker
                ? {
                    onPossiblyAcceptedRequestFailure: () =>
                      markServerInputAccepted(false),
                  }
                : undefined,
            );
            if (deferLocalPendingInputAdmission) {
              const modelResponseOutcome = pendingModelResponse.then(
                (response) => ({ status: 'fulfilled' as const, response }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
              );
              try {
                await guardrailTracker.awaitCompletion();
                await commitLocalPendingInput();
              } catch (error) {
                // The request already started in parallel, so drain it before
                // surfacing a guardrail or persistence failure.
                await modelResponseOutcome;
                throw error;
              }
              const outcome = await modelResponseOutcome;
              if (outcome.status === 'rejected') {
                throw outcome.error;
              }
              state._lastTurnResponse = outcome.response;
            } else {
              state._lastTurnResponse = await pendingModelResponse;
            }
            if (serverConversationTracker) {
              markServerInputAccepted();
            }
            state._modelResponses.push(state._lastTurnResponse);
            state._context.usage.add(state._lastTurnResponse.usage);
            recordUsage(state._lastTurnResponse.usage);
            state._noActiveAgentRun = false;

            // After each turn record the items echoed by the server so future requests only
            // include the incremental inputs that have not yet been acknowledged.
            serverConversationTracker?.trackServerItems(
              state._lastTurnResponse,
            );
            if (serverConversationTracker) {
              state.setConversationContext(
                serverConversationTracker.conversationId,
                serverConversationTracker.previousResponseId,
              );
            }

            const processedResponse = await processModelResponseAsync(
              state._lastTurnResponse,
              state._currentAgent,
              preparedCall.tools,
              preparedCall.handoffs,
              state,
              [...preparedCall.turnInput, ...state._generatedItems],
              options.toolNotFoundBehavior,
              {
                allowPromptSuppliedTools: preparedCall.allowPromptSuppliedTools,
                beforeClientToolSearch: () =>
                  preflightModelResponseToolInvocations(
                    state._currentAgent,
                    state,
                    state._lastTurnResponse!,
                    preparedCall.tools,
                    preparedCall.handoffs,
                  ),
              },
            );

            state._lastProcessedResponse = processedResponse;
            const suppressedToolCalls = preflightToolInvocations(
              state._currentAgent,
              state,
              processedResponse,
            );

            await guardrailTracker.awaitCompletion();

            markAcceptedResponseProcessingStarted(state);

            captureCurrentResponseToolOutputGuardrailResultStart(state, true);
            const turnResult = await resolveTurnAfterModelResponse(
              state._currentAgent,
              state._originalInput,
              state._generatedItems,
              state._lastTurnResponse!,
              state._lastProcessedResponse!,
              this,
              state,
              toolErrorFormatter,
              agentToolParentRunConfig,
              options.errorHandlers,
              options.signal,
              suppressedToolCalls,
              attemptedRunErrorHandlers,
              (handoffAgent) =>
                this.#validateModelTimeoutForAgent(handoffAgent),
            );

            if (turnResult.nextStep.type === 'next_step_handoff') {
              this.#validateModelTimeoutForAgent(turnResult.nextStep.newAgent);
            }
            applyTurnResult({
              state,
              turnResult,
              agent: state._currentAgent,
              toolsUsed: state._lastProcessedResponse?.toolsUsed ?? [],
              resetTurnPersistence: !isResumedState,
            });
            if (options.signal?.aborted) {
              persistenceCheckpoint = new RunResult<TContext, TAgent>(state);
            }
            options.signal?.throwIfAborted();
            if (turnResult.nextStep.type !== 'next_step_final_output') {
              finishRunnerSpan(currentTurnSpan);
              setRunStateTurnSpanParent(state, undefined);
              currentTurnSpan = undefined;
            }
          }

          const currentStep = state._currentStep as NextStep | undefined;
          if (!currentStep) {
            logger.debug('Running next loop');
            continue;
          }

          switch (currentStep.type) {
            case 'next_step_final_output':
              if (options.signal?.aborted) {
                releaseProvisionalSessionHistoryTransactionBinding(
                  state,
                  provisionalSessionHistoryTransactionSessionId,
                  provisionalSessionHistoryTransactionInputItems,
                );
              }
              options.signal?.throwIfAborted();
              return await finalizeCurrentOutput();
            case 'next_step_handoff':
              this.#validateModelTimeoutForAgent(currentStep.newAgent);
              state.setCurrentAgent(currentStep.newAgent as TAgent);
              if (state._currentAgentSpan) {
                state._currentAgentSpan.end();
                resetCurrentSpan();
                state.setCurrentAgentSpan(undefined);
              }
              state._noActiveAgentRun = true;
              state._currentTurnInProgress = false;

              // We've processed the handoff, so we need to run the loop again.
              state._currentStep = { type: 'next_step_run_again' };
              break;
            case 'next_step_interruption':
              // Interrupted. Don't run any guardrails.
              return completeResult(new RunResult<TContext, TAgent>(state));
            case 'next_step_run_again':
              state._currentTurnInProgress = false;
              logger.debug('Running next loop');
              break;
            default:
              logger.debug('Running next loop');
          }
        }
      } catch (caughtError) {
        if (guardrailTracker.pending) {
          await guardrailTracker.awaitCompletion({ suppressErrors: true });
        }
        const err = guardrailTracker.failed
          ? guardrailTracker.error
          : caughtError;
        if (guardrailTracker.failed) {
          invalidateAcceptedResponseReplayEvidence(state);
        }
        const restoredPendingTurn = rollbackUnstartedTurn(
          state,
          turnPendingModelRequest,
        );
        turnPendingModelRequest = undefined;
        if (!restoredPendingTurn) {
          state._currentTurnInProgress = false;
        }
        attachRunStateToError(err, state);
        releaseUnusedSessionHistoryTransactionBinding(state);
        const errorHandled = await prepareRunErrorFinalOutput({
          error: err,
          state,
          errorHandlers: options.errorHandlers,
          responseAccepted: isAcceptedResponseCheckpoint(state),
          attemptedErrors: attemptedRunErrorHandlers,
        });
        if (errorHandled) {
          try {
            return await finalizeCurrentOutput(errorHandled);
          } catch (finalizationError) {
            recordNonStreamingError(finalizationError);
            throw finalizationError;
          }
        }
        recordNonStreamingError(err);
        throw err;
      } finally {
        finishRunnerSpan(currentTurnSpan);
        setRunStateTurnSpanParent(state, undefined);
        const preserveSandboxSessions =
          state._currentStep?.type === 'next_step_interruption';
        try {
          try {
            await finalizeSandboxRuntime({
              state: state as RunState<
                TContext,
                Agent<TContext, AgentOutputType>
              >,
              sandboxRuntime,
              preserveSessionsForInterruption: preserveSandboxSessions,
              finishAgentSpanForInterruption:
                Boolean(taskSpan) || runError !== undefined,
              runError,
              groupId: this.config.groupId,
              memoryContext: sandboxMemoryRunContext,
              runAgent: async (agent, input, runOptions) =>
                await this.run(agent, input, runOptions),
              tracingParent:
                taskSpan?.span ??
                state._currentAgentSpan ??
                invocationSpanParent,
            });
          } catch (error) {
            setRunnerSpanError(
              taskSpan,
              error,
              this.config.traceIncludeSensitiveData,
            );
            await Promise.reject(error);
          }
          const resultToPersist = completedResult ?? persistenceCheckpoint;
          if (resultToPersist && !completedResultPersisted) {
            try {
              await persistNonStreamingResult(resultToPersist);
            } catch (error) {
              setRunnerSpanError(
                taskSpan,
                error,
                this.config.traceIncludeSensitiveData,
              );
              await Promise.reject(error);
            }
          }
        } finally {
          finishRunnerSpan(taskSpan);
        }
      }
    });
  }

  /**
   * @internal
   */
  async #runStreamLoop<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
  >(
    result: StreamedRunResult<TContext, TAgent>,
    startingAgent: TAgent,
    sandboxRuntime: SandboxRuntimeManager<TContext>,
    options: StreamRunOptions<TContext, TAgent>,
    isResumedState: boolean,
    ensureStreamInputPersisted?: () => Promise<void>,
    sessionTurnInputUpdate?: (
      preparedInput: AgentInputItem[],
      processedInput: AgentInputItem[],
    ) => void,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
    getStreamInputForPersistence?: () => AgentInputItem[] | undefined,
    preserveTurnPersistenceOnResume?: boolean,
    provisionalSessionHistoryTransactionSessionId?: string,
    provisionalSessionHistoryTransactionInputItems?: AgentInputItem[],
    sandboxMemoryRunContext?: SandboxMemoryPersistenceContext,
    taskSpan?: RunnerSpanLifecycle<TaskSpanData>,
    invocationSpanParent?: Span<any> | Trace,
  ): Promise<void> {
    const resolvedReasoningItemIdPolicy =
      options.reasoningItemIdPolicy ??
      (isResumedState ? result.state._reasoningItemIdPolicy : undefined) ??
      this.config.reasoningItemIdPolicy;
    result.state.setReasoningItemIdPolicy(resolvedReasoningItemIdPolicy);
    const resolvedConversationId =
      options.conversationId ?? result.state._conversationId;
    const resolvedPreviousResponseId =
      options.previousResponseId ?? result.state._previousResponseId;
    const serverManagesConversation =
      Boolean(resolvedConversationId) || Boolean(resolvedPreviousResponseId);
    assertPendingInputServerOwnership(
      result.state,
      resolvedConversationId,
      resolvedPreviousResponseId,
    );
    const serverConversationTracker = serverManagesConversation
      ? new ServerConversationTracker({
          conversationId: resolvedConversationId,
          previousResponseId: resolvedPreviousResponseId,
          reasoningItemIdPolicy: resolvedReasoningItemIdPolicy,
        })
      : undefined;
    if (serverConversationTracker) {
      result.state.setConversationContext(
        serverConversationTracker.conversationId,
        serverConversationTracker.previousResponseId,
      );
    }

    let sentInputToModel = false;
    let streamInputPersisted = false;
    let guardrailTracker = createGuardrailTracker();
    const persistStreamInputIfNeeded = async () => {
      if (streamInputPersisted || !ensureStreamInputPersisted) {
        return;
      }
      // Both success and error paths call this helper, so guard against multiple writes.
      await ensureStreamInputPersisted();
      streamInputPersisted = true;
      markSessionHistoryTransactionInputPersisted(result.state);
    };
    const awaitInputGuardrails = async () => {
      await guardrailTracker.awaitCompletion();
      if (guardrailTracker.failed) {
        throw guardrailTracker.error;
      }
    };

    if (serverConversationTracker && isResumedState) {
      serverConversationTracker.primeFromState({
        originalInput: result.state._originalInput,
        generatedItems: result.state._generatedItems,
        modelResponses: result.state._modelResponses,
      });
      result.state.setConversationContext(
        serverConversationTracker.conversationId,
        serverConversationTracker.previousResponseId,
      );
    }
    const toolErrorFormatter =
      options.toolErrorFormatter ?? this.config.toolErrorFormatter;
    const agentToolParentRunConfig = this.#getAgentToolParentRunConfig(options);
    const useTaskAndTurnSpans =
      !this.config.tracingDisabled && includeTaskAndTurnSpans(options.tracing);
    // Tracks when we resume an approval interruption so the next run-again step stays in the same turn.
    let continuingInterruptedTurn = false;
    let runError: unknown;
    const attemptedRunErrorHandlers = new WeakSet<object>();
    let suppressStreamInputPersistence = false;
    let approvedToolCheckpointCompacted = false;
    let approvedToolCheckpointRequiresLocalInputCompaction =
      isResumedState && hasPersistedToolOutput(result.state);
    let approvedToolCheckpointModelResponseCount = result.rawResponses.length;
    let currentTurnSpan: ReturnType<typeof startTurnSpan> | undefined;
    let turnPendingModelRequest: TurnPreparationSnapshot | undefined;
    let commitDeferredLocalPendingInput: (() => Promise<void>) | undefined;
    const parentUsageRecorder = getRunnerParentUsageRecorder(this);
    const recordUsage = (usage: Usage) => {
      recordRunnerSpanUsage(taskSpan, usage);
      recordRunnerSpanUsage(currentTurnSpan, usage);
      parentUsageRecorder?.(usage);
    };
    setRunStateUsageRecorder(result.state, recordUsage);
    const saveStreamResultWithCompactionOwnership = async (
      overrideOptions?: SessionPersistenceOptions,
    ) => {
      if (this.#shouldDeferInterruptedSessionItems(result.state)) {
        return;
      }
      const hasUnpersistedItems =
        result.newItems.length > result.state._currentTurnPersistedItemCount ||
        (overrideOptions?.additionalRunItems?.length ?? 0) > 0;
      const modelResponseAdvanced =
        result.rawResponses.length > approvedToolCheckpointModelResponseCount;
      const compactionOptions =
        approvedToolCheckpointRequiresLocalInputCompaction
          ? approvedToolCheckpointCompacted &&
            !hasUnpersistedItems &&
            !modelResponseAdvanced
            ? { runCompaction: false }
            : { compactionMode: 'input' as const }
          : undefined;
      const persistenceOptions = {
        ...compactionOptions,
        ...overrideOptions,
      };
      const sessionInputItems = streamInputPersisted
        ? undefined
        : getStreamInputForPersistence?.();
      // A remote session may commit addItems before rejecting, and compaction happens after the
      // append. Once the combined save starts, retrying the input is therefore unsafe.
      streamInputPersisted = true;
      await saveStreamResultToSession(
        options.session,
        result,
        persistenceOptions,
        sessionInputItems,
      );
    };
    const recordStreamingError = (error: unknown) => {
      if (result.state._currentAgentSpan) {
        result.state._currentAgentSpan.setError({
          message: 'Error in agent run',
          data: {
            error: getRunnerSpanErrorDetails(
              error,
              this.config.traceIncludeSensitiveData,
            ),
          },
        });
      }
      setRunnerSpanError(
        currentTurnSpan,
        error,
        this.config.traceIncludeSensitiveData,
      );
      setRunnerSpanError(
        taskSpan,
        error,
        this.config.traceIncludeSensitiveData,
      );
      runError = error;
    };
    const finalizeStreamOutput = async (
      preparedErrorOutput?: PreparedRunErrorFinalOutput,
    ): Promise<void> => {
      const currentStep = result.state._currentStep;
      if (currentStep?.type !== 'next_step_final_output') {
        throw new ModelBehaviorError(
          'Expected a final output step while finalizing the run.',
          result.state,
        );
      }
      markAcceptedResponseFinalizationStarted(result.state);
      result._hideFinalOutput();
      await finalizeOutputGuardrails({
        state: result.state,
        runnerOutputGuardrails: this.outputGuardrailDefs,
        output: currentStep.output,
        redactedOutput: OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
        guardedTerminalToolOutput: hasTerminalToolOutputSource(result.state),
        signal: options.signal,
        sanitizeRejectedOutput: sanitizeBlockedTerminalToolOutput,
        persistBlockedOutput: !serverManagesConversation
          ? async () =>
              saveStreamResultWithCompactionOwnership({
                outputBlocked: true,
              })
          : undefined,
        persistUnblockedFailure: !serverManagesConversation
          ? async () => saveStreamResultWithCompactionOwnership()
          : undefined,
        releaseBlockedOutputPersistence:
          releaseUnusedSessionHistoryTransactionBinding,
      });
      if (
        result.state._serializedCurrentStep === currentStep &&
        hasRetainableBlockedOutputEffect(result.state)
      ) {
        releaseProvisionalSessionHistoryTransactionBinding(
          result.state,
          provisionalSessionHistoryTransactionSessionId,
          provisionalSessionHistoryTransactionInputItems,
        );
        throw new UserError(
          'Accepted final output cannot be resumed directly from serialized terminal state. Start a new run from persisted session history.',
        );
      }
      finishRunnerSpan(currentTurnSpan);
      setRunStateTurnSpanParent(result.state, undefined);
      currentTurnSpan = undefined;
      result.state._currentTurnInProgress = false;
      // Guardrails must succeed before persisting session memory to avoid storing blocked outputs.
      if (!serverManagesConversation) {
        try {
          await saveStreamResultWithCompactionOwnership(
            preparedErrorOutput?.deferredItem
              ? { additionalRunItems: [preparedErrorOutput.deferredItem] }
              : undefined,
          );
        } catch (error) {
          const itemCommitted =
            commitDeferredRunErrorItemAfterPartialPersistence(
              result.state,
              preparedErrorOutput,
            );
          if (itemCommitted && preparedErrorOutput?.deferredItem) {
            streamStepItemsToRunResult(result, [
              preparedErrorOutput.deferredItem,
            ]);
            recordStreamingError(error);
            result._raiseError(error, { preserveQueuedItems: true });
            return;
          }
          throw error;
        }
      }
      if (preparedErrorOutput?.deferredItem) {
        result.state._generatedItems.push(preparedErrorOutput.deferredItem);
      }
      if (preparedErrorOutput?.deferredItem) {
        streamStepItemsToRunResult(result, [preparedErrorOutput.deferredItem]);
        result._preserveQueuedItemsOnError();
      }
      result._revealFinalOutput();
      this.emit(
        'agent_end',
        result.state._context,
        result.state._currentAgent,
        currentStep.output,
      );
      result.state._currentAgent.emit(
        'agent_end',
        result.state._context,
        currentStep.output,
      );
    };

    try {
      while (true) {
        // Let the current action batch settle, but never start new work after
        // cancellation once a turn has already begun. Preserve the existing
        // first-request behavior for an initially aborted stream.
        if (
          result.cancelled &&
          (result.state._currentTurn > 0 ||
            result.state._currentStep?.type === 'next_step_final_output')
        ) {
          if (result.state._currentStep?.type === 'next_step_final_output') {
            releaseProvisionalSessionHistoryTransactionBinding(
              result.state,
              provisionalSessionHistoryTransactionSessionId,
              provisionalSessionHistoryTransactionInputItems,
            );
          }
          return;
        }

        const currentAgent = result.state._currentAgent;

        result.state._currentStep = result.state._currentStep ?? {
          type: 'next_step_run_again',
        };

        if (isAcceptedResponseCheckpoint(result.state)) {
          captureCurrentResponseToolOutputGuardrailResultStart(
            result.state,
            false,
          );
          await resumeAcceptedModelResponse({
            state: result.state,
            runner: this,
            toolErrorFormatter,
            agentToolParentRunConfig,
            signal: options.signal,
            validateHandoffAgent: (handoffAgent) => {
              this.#validateModelTimeoutForAgent(handoffAgent);
            },
            onStepItems: (turnResult) => {
              addStepToRunResult(result, turnResult);
            },
          });
        }

        if (result.state._currentStep.type === 'next_step_interruption') {
          await prepareSandboxInterruptedTurnResume({
            startingAgent,
            state: result.state,
            sandboxRuntime,
            runConfigModel: await this.#resolveSandboxRuntimeModelForAgent(
              result.state._currentAgent,
            ),
            toolNameCollisionPolicy: options.toolNameCollisionPolicy,
            tracingParent:
              getRunStateTurnSpanParent(result.state) ??
              result.state._currentAgentSpan,
          });

          if (useTaskAndTurnSpans) {
            currentTurnSpan = ensureTurnSpan(
              currentTurnSpan,
              result.state._currentTurn,
              result.state._currentAgent.name,
              result.state._currentAgentSpan,
            );
            setRunStateTurnSpanParent(result.state, currentTurnSpan.span);
          }

          captureCurrentResponseToolOutputGuardrailResultStart(
            result.state,
            false,
          );
          const interruptedOutcome = await resumeInterruptedTurn({
            state: result.state,
            runner: this,
            toolErrorFormatter,
            agentToolParentRunConfig,
            signal: options.signal,
            validateHandoffAgent: (handoffAgent) => {
              this.#validateModelTimeoutForAgent(handoffAgent);
            },
            onStepItems: (turnResult) => {
              addStepToRunResult(result, turnResult);
            },
          });
          if (interruptedOutcome.approvedToolResumed) {
            approvedToolCheckpointRequiresLocalInputCompaction = true;
            if (
              interruptedOutcome.nextStep.type !== 'next_step_final_output' &&
              !serverManagesConversation &&
              options.session &&
              !this.#shouldDeferInterruptedSessionItems(result.state)
            ) {
              await saveStreamResultToSession(options.session, result, {
                compactionMode: 'input',
              });
              approvedToolCheckpointCompacted = true;
              approvedToolCheckpointModelResponseCount =
                result.rawResponses.length;
            }
          }

          // Don't reset counter here - resolveInterruptedTurn already adjusted it via rewind logic
          // The counter will be reset when _currentTurn is incremented (starting a new turn)

          const { shouldReturn, shouldContinue } = handleInterruptedOutcome({
            state: result.state,
            outcome: interruptedOutcome,
            setContinuingInterruptedTurn: (value) => {
              continuingInterruptedTurn = value;
            },
          });
          if (!shouldContinue) {
            finishRunnerSpan(currentTurnSpan);
            setRunStateTurnSpanParent(result.state, undefined);
            currentTurnSpan = undefined;
          }
          if (shouldReturn) {
            // we are still in an interruption, so we need to avoid an infinite loop
            return;
          }
          if (shouldContinue) {
            continue;
          }
        }

        if (result.state._currentStep.type === 'next_step_run_again') {
          this.#validateModelTimeoutForAgent(result.state._currentAgent);
          commitDeferredLocalPendingInput = undefined;
          if (
            approvedToolCheckpointCompacted &&
            result.state._currentTurnSessionHistoryTransactionSessionId ===
              undefined
          ) {
            await prepareSessionHistoryTransactionsForRun(
              options.session,
              result.state,
              { serverManagesConversation: false },
            );
          }
          guardrailTracker = createGuardrailTracker();
          const wasContinuingInterruptedTurn = continuingInterruptedTurn;
          continuingInterruptedTurn = false;
          const previousTurn = result.state._currentTurn;
          turnPendingModelRequest = {
            currentTurn: previousTurn,
            currentTurnInProgress: result.state._currentTurnInProgress,
          };
          const previousPersistedCount =
            result.state._currentTurnPersistedItemCount;
          const previousGeneratedCount = result.state._generatedItems.length;
          const preparedTurn = await prepareTurn({
            state: result.state,
            input: result.input,
            generatedItems: result.newItems,
            isResumedState,
            preserveTurnPersistenceOnResume,
            continuingInterruptedTurn: wasContinuingInterruptedTurn,
            serverConversationTracker,
            inputGuardrailDefs: this.inputGuardrailDefs,
            guardrailHandlers: {
              onParallelPromise: guardrailTracker.setPromise,
              onParallelError: (err) => {
                guardrailTracker.setError(err);
              },
            },
            emitAgentStart: (context, agent, inputItems) => {
              this.emit('agent_start', context, agent, inputItems);
            },
            onAgentSpanReady: useTaskAndTurnSpans
              ? (turn, agentName) => {
                  currentTurnSpan = ensureTurnSpan(
                    currentTurnSpan,
                    turn,
                    agentName,
                    result.state._currentAgentSpan,
                  );
                  setRunStateTurnSpanParent(result.state, currentTurnSpan.span);
                }
              : undefined,
            agentSpanParent: taskSpan?.span ?? invocationSpanParent,
          });
          if (
            preserveTurnPersistenceOnResume &&
            result.state._currentTurn > previousTurn &&
            previousPersistedCount <= previousGeneratedCount
          ) {
            // Preserve persisted offsets from a resumed run to avoid re-saving prior items.
            result.state._currentTurnPersistedItemCount =
              previousPersistedCount;
          }
          const { turnInput, pendingInputItems, pendingInputSourceItems } =
            preparedTurn;
          // If guardrails are still running, defer input persistence until they finish.
          const sessionPreparedTurnInput = [...turnInput];
          const preparedSandboxAgent = await sandboxRuntime.prepareAgent({
            currentAgent: result.state._currentAgent,
            turnInput,
            runConfigModel: await this.#resolveSandboxRuntimeModelForAgent(
              result.state._currentAgent,
            ),
            tracingParent:
              currentTurnSpan?.span ?? result.state._currentAgentSpan,
          });
          sessionTurnInputUpdate?.(
            sessionPreparedTurnInput,
            preparedSandboxAgent.turnInput,
          );
          const processedPendingInputItems =
            mapPendingInputAfterContextProcessing(
              pendingInputItems,
              sessionPreparedTurnInput,
              preparedSandboxAgent.turnInput,
            );
          const artifacts = await prepareAgentArtifacts(
            result.state,
            preparedSandboxAgent.executionAgent,
            options.toolNameCollisionPolicy,
          );

          const preparedCall = await this.#prepareModelCall(
            result.state,
            preparedSandboxAgent.executionAgent,
            options,
            artifacts,
            preparedSandboxAgent.turnInput,
            serverConversationTracker,
            sessionInputUpdate,
          );
          captureSessionHistoryTransactionInputItems(
            options.session,
            result.state,
            getStreamInputForPersistence?.(),
          );

          await guardrailTracker.throwIfError();

          // Once a logical turn is established, do not start another model
          // request if cancellation arrives during asynchronous preparation.
          if ((sentInputToModel || isResumedState) && result.cancelled) {
            rollbackUnstartedTurn(result.state, turnPendingModelRequest);
            turnPendingModelRequest = undefined;
            return;
          }

          const admittedPendingInput = selectPendingInputForAdmission(
            processedPendingInputItems,
            preparedCall,
          );
          let localPendingInputCommitted = false;
          const commitLocalPendingInput = async () => {
            if (serverConversationTracker || localPendingInputCommitted) {
              return;
            }
            localPendingInputCommitted = true;
            commitPendingInput(
              result.state,
              pendingInputItems,
              admittedPendingInput,
              pendingInputSourceItems,
            );
            if (hasUnpersistedRunInput(result.state)) {
              await saveStreamResultToSession(options.session, result, {
                runCompaction: false,
              });
            }
          };
          const deferLocalPendingInputAdmission =
            !serverConversationTracker &&
            pendingInputItems.length > 0 &&
            guardrailTracker.pending;
          if (deferLocalPendingInputAdmission) {
            commitDeferredLocalPendingInput = async () => {
              commitDeferredLocalPendingInput = undefined;
              await commitLocalPendingInput();
            };
          } else {
            await commitLocalPendingInput();
            if ((sentInputToModel || isResumedState) && result.cancelled) {
              rollbackUnstartedTurn(result.state, turnPendingModelRequest);
              turnPendingModelRequest = undefined;
              return;
            }
          }

          let finalResponse: ModelResponse | undefined = undefined;
          const abortReconciliationState =
            createStreamAbortReconciliationState();
          let inputMarked = false;
          let responseAcceptedCheckpointed = false;
          let receivedStreamEvent = false;
          let timedOutModelCallFailed = false;
          const markServerInputAccepted = (responseAvailable = true) => {
            if (!serverConversationTracker) {
              return;
            }
            if (!inputMarked) {
              // Mark inputs after the first stream event, an explicit abort after
              // request start, or provider advice that the failed request may have
              // been accepted.
              // Record the exact input that was sent so the server tracker can advance safely.
              serverConversationTracker.markInputAsSent(
                preparedCall.filterApplied
                  ? preparedCall.sourceItems
                  : preparedCall.turnInput,
                {
                  filterApplied: preparedCall.filterApplied,
                  allTurnItems: preparedCall.turnInput,
                },
              );
              commitPendingInput(
                result.state,
                pendingInputItems,
                admittedPendingInput,
                pendingInputSourceItems,
              );
              if (pendingInputItems.length > 0) {
                if (admittedPendingInput.length > 0) {
                  serverConversationTracker.markInputAsSent(
                    admittedPendingInput.map((item) => item.rawItem),
                  );
                }
              }
              inputMarked = true;
            }
            if (
              !responseAcceptedCheckpointed &&
              (pendingInputItems.length > 0 || !responseAvailable)
            ) {
              if (!responseAvailable) {
                result.state._lastTurnResponse = undefined;
              }
              result.state._lastProcessedResponse = undefined;
              result.state._currentStep = {
                type: 'next_step_interruption',
                data: { interruptions: [], responseAccepted: true },
              };
              responseAcceptedCheckpointed = true;
            }
          };
          const reconcileStreamAbortIfNeeded = async () => {
            if (
              !serverConversationTracker ||
              !shouldReconcileStreamAbort(abortReconciliationState)
            ) {
              return;
            }

            const reconciliationInput = buildAbortReconciliationInput(
              abortReconciliationState,
            );
            try {
              const reconciliationResponse = await getResponseWithRetry(
                preparedCall.model,
                {
                  systemInstructions: preparedCall.modelInput.instructions,
                  prompt: preparedCall.prompt,
                  ...(preparedCall.explicitlyModelSet
                    ? { overridePromptModel: true }
                    : {}),
                  input: reconciliationInput,
                  previousResponseId: getAbortReconciliationPreviousResponseId(
                    abortReconciliationState,
                    preparedCall,
                  ),
                  conversationId: preparedCall.conversationId,
                  modelSettings: preparedCall.modelSettings,
                  _internal: preparedCall.modelRequestInternal,
                  tools: preparedCall.serializedTools,
                  toolsExplicitlyProvided: preparedCall.toolsExplicitlyProvided,
                  handoffs: preparedCall.serializedHandoffs,
                  outputType: convertAgentOutputTypeToSerializable(
                    currentAgent.outputType,
                  ),
                  tracing: getTracing(
                    this.config.tracingDisabled,
                    this.config.traceIncludeSensitiveData,
                  ),
                },
              );
              markAbortReconciliationComplete(
                abortReconciliationState,
                reconciliationResponse,
              );
              result.state._context.usage.add(reconciliationResponse.usage);
              recordUsage(reconciliationResponse.usage);
              serverConversationTracker.trackServerItems(
                reconciliationResponse,
              );
              result.state.setConversationContext(
                serverConversationTracker.conversationId,
                serverConversationTracker.previousResponseId,
              );
            } catch (error) {
              logModelAndToolActionDebug(
                logger,
                'Failed to reconcile streamed tool calls after abort.',
                error,
              );
            }
          };

          const modelRequest: ModelRequest = {
            systemInstructions: preparedCall.modelInput.instructions,
            prompt: preparedCall.prompt,
            // Streaming requests should also honor explicitly chosen models.
            ...(preparedCall.explicitlyModelSet
              ? { overridePromptModel: true }
              : {}),
            input: preparedCall.modelInput.input,
            previousResponseId: preparedCall.previousResponseId,
            conversationId: preparedCall.conversationId,
            modelSettings: preparedCall.modelSettings,
            _internal: preparedCall.modelRequestInternal,
            tools: preparedCall.serializedTools,
            toolsExplicitlyProvided: preparedCall.toolsExplicitlyProvided,
            handoffs: preparedCall.serializedHandoffs,
            outputType: convertAgentOutputTypeToSerializable(
              currentAgent.outputType,
            ),
            tracing: getTracing(
              this.config.tracingDisabled,
              this.config.traceIncludeSensitiveData,
            ),
            signal: options.signal,
          };

          // Publish the turn only after the complete request is constructed,
          // immediately before the model request starts.
          turnPendingModelRequest = undefined;
          result.currentTurn = result.state._currentTurn;
          sentInputToModel = true;
          try {
            for await (const event of getStreamedResponseWithRetry(
              preparedCall.model,
              modelRequest,
              {
                onModelTimeout: () => {
                  timedOutModelCallFailed = true;
                },
                ...(serverConversationTracker
                  ? {
                      onPossiblyAcceptedRequestFailure: () =>
                        markServerInputAccepted(false),
                    }
                  : {}),
              },
            )) {
              receivedStreamEvent = true;
              markServerInputAccepted(pendingInputItems.length === 0);
              await guardrailTracker.throwIfError();
              recordStreamEventForAbortReconciliation(
                abortReconciliationState,
                event,
              );
              if (event.type === 'response_done') {
                assertValidCompactionItems(event.response.output);
                let rawUsage: Record<string, unknown> | undefined;
                if (modelRequest.modelSettings.preserveRawUsage === true) {
                  try {
                    rawUsage = snapshotRawUsage(event.response.rawUsage);
                  } catch {
                    rawUsage = undefined;
                  }
                }
                const parsed = StreamEventResponseCompleted.parse({
                  type: event.type,
                  ...(event.providerData
                    ? { providerData: event.providerData }
                    : {}),
                  response: {
                    id: event.response.id,
                    requestId: event.response.requestId,
                    usage: event.response.usage,
                    output: event.response.output,
                    ...(event.response.providerData
                      ? { providerData: event.response.providerData }
                      : {}),
                    ...(rawUsage !== undefined ? { rawUsage } : {}),
                  },
                });
                finalResponse = {
                  usage: new Usage(parsed.response.usage),
                  output: parsed.response.output,
                  responseId: parsed.response.id,
                  requestId: parsed.response.requestId,
                  ...(rawUsage !== undefined ? { rawUsage } : {}),
                };
                result.state._lastTurnResponse = finalResponse;
                result.state._context.usage.add(finalResponse.usage);
                recordUsage(finalResponse.usage);
              }
              if (result.cancelled) {
                // When the user's code exits a loop to consume the stream, we need to break
                // this loop to prevent internal false errors and unnecessary processing
                await awaitInputGuardrails();
                await commitDeferredLocalPendingInput?.();
                await reconcileStreamAbortIfNeeded();
                return;
              }
              result._addItem(new RunRawModelStreamEvent(event));
            }
          } catch (error) {
            if (isAbortError(error)) {
              if (sentInputToModel) {
                markServerInputAccepted();
              }
              await awaitInputGuardrails();
              await commitDeferredLocalPendingInput?.();
              await reconcileStreamAbortIfNeeded();
              return;
            }
            if (error instanceof ModelTimeoutError || timedOutModelCallFailed) {
              if (receivedStreamEvent) {
                markServerInputAccepted(false);
              }
              await awaitInputGuardrails();
              await commitDeferredLocalPendingInput?.();
              await reconcileStreamAbortIfNeeded();
            }
            throw error;
          }

          if (finalResponse) {
            markServerInputAccepted();
          }

          await awaitInputGuardrails();
          await commitDeferredLocalPendingInput?.();

          if (result.cancelled) {
            return;
          }

          result.state._noActiveAgentRun = false;

          if (!finalResponse) {
            throw new ModelBehaviorError(
              'Model did not produce a final response!',
              result.state,
            );
          }

          result.state._lastTurnResponse = finalResponse;
          // Keep the tracker in sync with the streamed response so reconnections remain accurate.
          serverConversationTracker?.trackServerItems(finalResponse);
          if (serverConversationTracker) {
            result.state.setConversationContext(
              serverConversationTracker.conversationId,
              serverConversationTracker.previousResponseId,
            );
          }
          result.state._modelResponses.push(result.state._lastTurnResponse);
          const processedResponse = await processModelResponseAsync(
            result.state._lastTurnResponse,
            currentAgent,
            preparedCall.tools,
            preparedCall.handoffs,
            result.state,
            [...preparedCall.turnInput, ...result.state._generatedItems],
            options.toolNotFoundBehavior,
            {
              allowPromptSuppliedTools: preparedCall.allowPromptSuppliedTools,
              beforeClientToolSearch: () =>
                preflightModelResponseToolInvocations(
                  currentAgent,
                  result.state,
                  result.state._lastTurnResponse!,
                  preparedCall.tools,
                  preparedCall.handoffs,
                ),
            },
          );

          result.state._lastProcessedResponse = processedResponse;
          const suppressedToolCalls = preflightToolInvocations(
            currentAgent,
            result.state,
            processedResponse,
          );
          const streamableItems = filterSuppressedToolCallItems(
            processedResponse.newItems,
            suppressedToolCalls,
          );

          // Record the items emitted directly from the model response so we do not
          // stream them again after tools and other side effects finish.
          const preToolItems = new Set<RunItem>(streamableItems);
          if (preToolItems.size > 0) {
            streamStepItemsToRunResult(result, streamableItems);
          }

          markAcceptedResponseProcessingStarted(result.state);

          captureCurrentResponseToolOutputGuardrailResultStart(
            result.state,
            true,
          );
          const turnResult = await resolveTurnAfterModelResponse(
            currentAgent,
            result.state._originalInput,
            result.state._generatedItems,
            result.state._lastTurnResponse!,
            result.state._lastProcessedResponse!,
            this,
            result.state,
            toolErrorFormatter,
            agentToolParentRunConfig,
            options.errorHandlers,
            options.signal,
            suppressedToolCalls,
            attemptedRunErrorHandlers,
            (handoffAgent) => this.#validateModelTimeoutForAgent(handoffAgent),
          );

          if (turnResult.nextStep.type === 'next_step_handoff') {
            this.#validateModelTimeoutForAgent(turnResult.nextStep.newAgent);
          }
          applyTurnResult({
            state: result.state,
            turnResult,
            agent: currentAgent,
            toolsUsed: processedResponse.toolsUsed,
            resetTurnPersistence: !isResumedState,
            onStepItems: (step) => {
              addStepToRunResult(result, step, { skipItems: preToolItems });
            },
          });
          if (turnResult.nextStep.type !== 'next_step_final_output') {
            finishRunnerSpan(currentTurnSpan);
            setRunStateTurnSpanParent(result.state, undefined);
            currentTurnSpan = undefined;
          }
        }

        const currentStep = result.state._currentStep;
        switch (currentStep.type) {
          case 'next_step_final_output':
            await finalizeStreamOutput();
            return;
          case 'next_step_interruption':
            // We are done for now. Don't run any output guardrails.
            if (!serverManagesConversation) {
              await saveStreamResultWithCompactionOwnership();
            }
            return;
          case 'next_step_handoff':
            this.#validateModelTimeoutForAgent(currentStep.newAgent);
            result.state.setCurrentAgent(currentStep.newAgent as TAgent);
            if (result.state._currentAgentSpan) {
              result.state._currentAgentSpan.end();
              resetCurrentSpan();
            }
            result.state.setCurrentAgentSpan(undefined);
            result._addItem(
              new RunAgentUpdatedStreamEvent(result.state._currentAgent),
            );
            result.state._noActiveAgentRun = true;
            result.state._currentTurnInProgress = false;

            // We've processed the handoff, so we need to run the loop again.
            result.state._currentStep = {
              type: 'next_step_run_again',
            };
            break;
          case 'next_step_run_again':
            result.state._currentTurnInProgress = false;
            logger.debug('Running next loop');
            break;
          default:
            logger.debug('Running next loop');
        }
      }
    } catch (caughtError) {
      if (guardrailTracker.pending) {
        await guardrailTracker.awaitCompletion({ suppressErrors: true });
      }
      if (!guardrailTracker.failed) {
        await commitDeferredLocalPendingInput?.();
      }
      const error = guardrailTracker.failed
        ? guardrailTracker.error
        : caughtError;
      const restoredPendingTurn = rollbackUnstartedTurn(
        result.state,
        turnPendingModelRequest,
      );
      turnPendingModelRequest = undefined;
      if (!restoredPendingTurn) {
        result.state._currentTurnInProgress = false;
      }
      attachRunStateToError(error, result.state);
      releaseUnusedSessionHistoryTransactionBinding(result.state);
      suppressStreamInputPersistence =
        error instanceof CompactionItemValidationError;
      const errorHandled = await prepareRunErrorFinalOutput({
        error,
        state: result.state,
        errorHandlers: options.errorHandlers,
        streamResult: result,
        responseAccepted: isAcceptedResponseCheckpoint(result.state),
        attemptedErrors: attemptedRunErrorHandlers,
      });
      if (errorHandled) {
        try {
          await finalizeStreamOutput(errorHandled);
          return;
        } catch (finalizationError) {
          recordStreamingError(finalizationError);
          throw finalizationError;
        }
      }
      recordStreamingError(error);
      throw error;
    } finally {
      finishRunnerSpan(currentTurnSpan);
      setRunStateTurnSpanParent(result.state, undefined);
      if (guardrailTracker.pending) {
        await guardrailTracker.awaitCompletion({ suppressErrors: true });
      }
      if (
        sentInputToModel &&
        !streamInputPersisted &&
        !guardrailTracker.failed &&
        !suppressStreamInputPersistence
      ) {
        await persistStreamInputIfNeeded();
      }
      const preserveSandboxSessions =
        result.state._currentStep?.type === 'next_step_interruption' ||
        (result.cancelled &&
          result.state._currentStep?.type !== 'next_step_final_output' &&
          runError === undefined);
      try {
        try {
          await finalizeSandboxRuntime({
            state: result.state as RunState<
              TContext,
              Agent<TContext, AgentOutputType>
            >,
            sandboxRuntime,
            preserveSessionsForInterruption: preserveSandboxSessions,
            finishAgentSpanForInterruption:
              Boolean(taskSpan) || runError !== undefined,
            runError,
            groupId: this.config.groupId,
            memoryContext: sandboxMemoryRunContext,
            runAgent: async (agent, input, runOptions) =>
              await this.run(agent, input, runOptions),
            tracingParent:
              taskSpan?.span ??
              result.state._currentAgentSpan ??
              invocationSpanParent,
          });
        } catch (error) {
          setRunnerSpanError(
            taskSpan,
            error,
            this.config.traceIncludeSensitiveData,
          );
          await Promise.reject(error);
        }
      } finally {
        finishRunnerSpan(taskSpan);
      }
    }
  }

  /**
   * @internal
   */
  async #runIndividualStream<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
  >(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    taskSpanName: string,
    options?: StreamRunOptions<TContext, TAgent>,
    ensureStreamInputPersisted?: () => Promise<void>,
    sessionTurnInputUpdate?: (
      preparedInput: AgentInputItem[],
      processedInput: AgentInputItem[],
    ) => void,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
    getStreamInputForPersistence?: () => AgentInputItem[] | undefined,
    preserveTurnPersistenceOnResume?: boolean,
    provisionalSessionHistoryTransactionSessionId?: string,
    provisionalSessionHistoryTransactionInputItems?: AgentInputItem[],
    sandboxMemoryRunContext?: SandboxMemoryPersistenceContext,
    invocationSpanParent?: Span<any> | Trace,
  ): Promise<StreamedRunResult<TContext, TAgent>> {
    options = options ?? ({} as StreamRunOptions<TContext>);
    return withNewSpanContext(async () => {
      // Initialize or reuse existing state
      const isResumedState = input instanceof RunState;
      const state: RunState<TContext, TAgent> = isResumedState
        ? input
        : new RunState(
            options.context instanceof RunContext
              ? options.context
              : new RunContext(options.context),
            input as string | AgentInputItem[],
            agent,
            options.maxTurns === undefined
              ? DEFAULT_MAX_TURNS
              : options.maxTurns,
          );
      this.#validateModelTimeoutForAgent(state._currentAgent);
      if (isResumedState) {
        state._agentToolInvocation = undefined;
        if (options.maxTurns !== undefined) {
          state._maxTurns = options.maxTurns;
        }
      }
      const resolvedReasoningItemIdPolicy =
        options.reasoningItemIdPolicy ??
        (isResumedState ? state._reasoningItemIdPolicy : undefined) ??
        this.config.reasoningItemIdPolicy;
      state.setReasoningItemIdPolicy(resolvedReasoningItemIdPolicy);
      const resolvedConversationId =
        options.conversationId ??
        (isResumedState ? state._conversationId : undefined);
      const resolvedPreviousResponseId =
        options.previousResponseId ??
        (isResumedState ? state._previousResponseId : undefined);
      if (!isResumedState) {
        await prepareSessionHistoryTransactionsForRun(options.session, state, {
          serverManagesConversation: Boolean(
            resolvedConversationId || resolvedPreviousResponseId,
          ),
        });
      }
      const useTaskAndTurnSpans =
        !this.config.tracingDisabled &&
        includeTaskAndTurnSpans(options.tracing);
      const resumingInterruptedTurn =
        isResumedState && state._currentStep?.type === 'next_step_interruption';
      const invocationSpans = useTaskAndTurnSpans
        ? startRunnerInvocationSpans({
            name: taskSpanName,
            agent: state._currentAgent,
            restoredAgentSpan: isResumedState
              ? state._currentAgentSpan
              : undefined,
            resumeInterruptedTurn: resumingInterruptedTurn,
            parent: invocationSpanParent,
          })
        : undefined;
      const taskSpan = invocationSpans?.taskSpan;
      const optOutResumeAgentSpan =
        resumingInterruptedTurn && !useTaskAndTurnSpans
          ? ensureActiveAgentSpanForInterruptedResume({
              agent: state._currentAgent,
              restoredAgentSpan: isResumedState
                ? state._currentAgentSpan
                : undefined,
              parent: invocationSpanParent ?? getCurrentTrace() ?? undefined,
            })
          : undefined;
      if (useTaskAndTurnSpans && isResumedState) {
        state.setCurrentAgentSpan(invocationSpans?.agentSpan);
      } else if (optOutResumeAgentSpan) {
        state.setCurrentAgentSpan(optOutResumeAgentSpan);
      }
      const sandboxRuntime = new SandboxRuntimeManager<TContext>({
        startingAgent: agent,
        sandboxConfig: options.sandbox ?? this.config.sandbox,
        runState: isResumedState
          ? (state as RunState<TContext, Agent<TContext, AgentOutputType>>)
          : undefined,
      });
      if (!isResumedState) {
        state.setConversationContext(
          resolvedConversationId,
          resolvedPreviousResponseId,
        );
      }

      // Initialize the streamed result with existing state
      const result = new StreamedRunResult<TContext, TAgent>({
        signal: options.signal,
        state,
      });
      const streamOptions: StreamRunOptions<TContext, TAgent> = {
        ...options,
        signal: result._getAbortSignal(),
      };

      // Setup defaults
      result.maxTurns = state._maxTurns;

      // Continue the stream loop without blocking
      const streamLoopPromise = this.#runStreamLoop(
        result,
        agent,
        sandboxRuntime,
        streamOptions,
        isResumedState,
        ensureStreamInputPersisted,
        sessionTurnInputUpdate,
        sessionInputUpdate,
        getStreamInputForPersistence,
        preserveTurnPersistenceOnResume,
        provisionalSessionHistoryTransactionSessionId,
        provisionalSessionHistoryTransactionInputItems,
        sandboxMemoryRunContext,
        taskSpan,
        invocationSpanParent,
      ).then(
        () => {
          result._done();
        },
        (err) => {
          result._raiseError(err);
        },
      );

      // Attach the stream loop promise so trace end waits for the loop to complete
      result._setStreamLoopPromise(streamLoopPromise);

      return result;
    });
  }

  /**
   * @internal
   * Validates timeout settings before turn preparation can run hooks, persist
   * input, or initialize sandbox resources.
   */
  #validateModelTimeoutForAgent<TContext>(
    executionAgent: Agent<TContext, AgentOutputType>,
  ): void {
    const agentModelSettings = executionAgent.hasExplicitModelSettings()
      ? executionAgent.modelSettings
      : undefined;
    validateModelTimeoutMs(
      mergeModelSettings(this.config.modelSettings, agentModelSettings),
    );
  }

  /**
   * @internal
   * Applies call-level filters and merges session updates so the model request mirrors exactly
   * what we persisted for history.
   */
  async #prepareModelCall<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
  >(
    state: RunState<TContext, TAgent>,
    executionAgent: Agent<TContext, AgentOutputType>,
    options: SharedRunOptions<TContext, TAgent>,
    artifacts: AgentArtifacts<TContext>,
    turnInput: AgentInputItem[],
    serverConversationTracker?: ServerConversationTracker,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
  ): Promise<PreparedModelCall<TContext>> {
    const { model, explicitlyModelSet, resolvedModelName } =
      await this.#resolveModelForAgent(executionAgent);

    const hasExplicitAgentModelSettings =
      executionAgent.hasExplicitModelSettings();
    const agentModelSettings = hasExplicitAgentModelSettings
      ? executionAgent.modelSettings
      : undefined;
    const implicitModelSettings = hasExplicitAgentModelSettings
      ? undefined
      : getImplicitModelSettingsForResolvedModel(
          explicitlyModelSet,
          resolvedModelName,
        );
    const modelRequestInternal = {
      reasoningEffortImplicit:
        implicitModelSettings?.reasoning?.effort !== undefined &&
        !hasExplicitTopLevelReasoningEffort(this.config.modelSettings) &&
        !hasExplicitTopLevelReasoningEffort(agentModelSettings),
      tracingParent:
        getRunStateTurnSpanParent(state) ?? state._currentAgentSpan,
      toolNameCollisionPolicy: options.toolNameCollisionPolicy ?? 'warn',
    };

    let modelSettings = mergeModelSettings(
      implicitModelSettings,
      this.config.modelSettings,
    );
    modelSettings = mergeModelSettings(modelSettings, agentModelSettings);
    modelSettings = adjustModelSettingsForNonGPT5RunnerModel(
      explicitlyModelSet,
      agentModelSettings ?? implicitModelSettings ?? {},
      model,
      modelSettings,
      resolvedModelName,
    );
    modelSettings = maybeResetToolChoice(
      state._currentAgent,
      state._toolUseTracker,
      modelSettings,
    );
    validateModelTimeoutMs(modelSettings);
    state._lastModelSettings = modelSettings;

    const systemInstructions = await executionAgent.getSystemPrompt(
      state._context,
    );
    const prompt = await executionAgent.getPrompt(state._context);
    const allowPromptSuppliedTools =
      Boolean(prompt) &&
      !(
        artifacts.toolsExplicitlyProvided &&
        artifacts.serializedTools.length === 0 &&
        artifacts.serializedHandoffs.length === 0
      );

    const {
      modelInput,
      sourceItems,
      persistedItems,
      sourceMatchKinds,
      filterApplied,
      preserveInputIdentity,
    } = await applyCallModelInputFilter(
      state._currentAgent,
      options.callModelInputFilter,
      state._context,
      turnInput,
      systemInstructions,
    );

    // Persist normalized clones so session history mirrors the exact model payload. An empty array
    // is intentional when a filter removes everything.
    sessionInputUpdate?.(sourceItems, persistedItems);

    const previousResponseId =
      serverConversationTracker?.previousResponseId ??
      options.previousResponseId;
    const conversationId =
      serverConversationTracker?.conversationId ?? options.conversationId;

    return {
      ...artifacts,
      model,
      explicitlyModelSet,
      modelRequestInternal,
      modelSettings,
      modelInput,
      prompt,
      allowPromptSuppliedTools,
      previousResponseId,
      conversationId,
      sourceItems,
      persistedItems,
      sourceMatchKinds,
      filterApplied,
      preserveInputIdentity,
      turnInput,
    };
  }
}

// internal helpers and constants

let defaultRunner: Runner | undefined;

function hasExplicitTopLevelReasoningEffort(settings?: ModelSettings): boolean {
  return settings?.reasoning?.effort !== undefined;
}

const getDefaultRunner = (): Runner => {
  if (!defaultRunner) {
    defaultRunner = new Runner();
  }
  return defaultRunner;
};
