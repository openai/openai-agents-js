import { Agent, AgentOutputType } from './agent';
import { RunAgentUpdatedStreamEvent, RunRawModelStreamEvent } from './events';
import { ModelBehaviorError, UserError } from './errors';
import {
  defineInputGuardrail,
  defineOutputGuardrail,
  InputGuardrail,
  OutputGuardrail,
} from './guardrail';
import type {
  InputGuardrailDefinition,
  InputGuardrailResult,
  OutputGuardrailDefinition,
  OutputGuardrailMetadata,
} from './guardrail';
import { Handoff, HandoffInputFilter } from './handoff';
import { RunHooks } from './lifecycle';
import logger from './logger';
import { Model, ModelProvider, ModelResponse, ModelSettings } from './model';
import { getDefaultModelProvider } from './providers';
import { RunContext } from './runContext';
import { RunResult, StreamedRunResult } from './result';
import { RunState } from './runState';
import { RunItem } from './items';
import { disposeResolvedComputers } from './tool';
import {
  getOrCreateTrace,
  resetCurrentSpan,
  setCurrentSpan,
  withNewSpanContext,
  withTrace,
} from './tracing/context';
import type { TracingConfig } from './tracing';
import { Usage } from './usage';
import { convertAgentOutputTypeToSerializable } from './utils/tools';
import { DEFAULT_MAX_TURNS } from './runner/constants';
import { StreamEventResponseCompleted } from './types/protocol';
import type { Session, SessionInputCallback } from './memory/session';
import type { AgentInputItem } from './types';
import {
  ServerConversationTracker,
  applyCallModelInputFilter,
} from './runner/conversation';
import {
  createGuardrailTracker,
  runOutputGuardrails,
} from './runner/guardrails';
import {
  adjustModelSettingsForNonGPT5RunnerModel,
  maybeResetToolChoice,
  selectModel,
} from './runner/modelSettings';
import { processModelResponse } from './runner/modelOutputs';
import {
  addStepToRunResult,
  streamStepItemsToRunResult,
  isAbortError,
} from './runner/streaming';
import {
  createSessionPersistenceTracker,
  prepareInputItemsWithSession,
  saveStreamInputToSession,
  saveStreamResultToSession,
  saveToSession,
} from './runner/sessionPersistence';
import { resolveTurnAfterModelResponse } from './runner/turnResolution';
import { prepareTurn } from './runner/turnPreparation';
import {
  applyTurnResult,
  handleInterruptedOutcome,
  resumeInterruptedTurn,
} from './runner/runLoop';
import { applyTraceOverrides, getTracing } from './runner/tracing';
import type {
  AgentArtifacts,
  CallModelInputFilter,
  PreparedModelCall,
} from './runner/types';
import { tryHandleRunError } from './runner/errorHandlers';
import type { RunErrorHandlers } from './runner/errorHandlers';

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

// Maintenance: keep helper utilities (e.g., GuardrailTracker) in runner/* modules so run.ts stays orchestration-only.

// --------------------------------------------------------------
//  Configuration
// --------------------------------------------------------------

/**
 * Configures settings for the entire agent run.
 */
export type RunConfig = {
  /**
   * The model to use for the entire agent run. If set, will override the model set on every
   * agent. The modelProvider passed in below must be able to resolve this model name.
   */
  model?: string | Model;

  /**
   * The model provider to use when looking up string model names. Defaults to OpenAI.
   */
  modelProvider: ModelProvider;

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
   * Customizes how session history is combined with the current turn's input.
   * When omitted, history items are appended before the new input.
   */
  sessionInputCallback?: SessionInputCallback;

  /**
   * Invoked immediately before calling the model, allowing callers to edit the
   * system instructions or input items that will be sent to the model.
   */
  callModelInputFilter?: CallModelInputFilter;
};

/**
 * Common run options shared between streaming and non-streaming execution pathways.
 */
type SharedRunOptions<
  TContext = undefined,
  TAgent extends Agent<any, any> = Agent<any, any>,
> = {
  context?: TContext | RunContext<TContext>;
  maxTurns?: number;
  signal?: AbortSignal;
  previousResponseId?: string;
  conversationId?: string;
  session?: Session;
  sessionInputCallback?: SessionInputCallback;
  callModelInputFilter?: CallModelInputFilter;
  tracing?: TracingConfig;
  /**
   * Error handlers keyed by error kind. Currently only maxTurns errors are supported.
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
    | StreamRunOptions<TContext, TAgent>
    | NonStreamRunOptions<TContext, TAgent>,
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
  public readonly config: RunConfig;
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
      modelProvider: config.modelProvider ?? getDefaultModelProvider(),
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
      sessionInputCallback: config.sessionInputCallback,
      callModelInputFilter: config.callModelInputFilter,
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
    const resolvedOptions = options ?? { stream: false, context: undefined };
    // Per-run options take precedence over runner defaults for session memory behavior.
    const sessionInputCallback =
      resolvedOptions.sessionInputCallback ?? this.config.sessionInputCallback;
    // Likewise allow callers to override callModelInputFilter on individual runs.
    const callModelInputFilter =
      resolvedOptions.callModelInputFilter ?? this.config.callModelInputFilter;
    const hasCallModelInputFilter = Boolean(callModelInputFilter);
    const tracingConfig = resolvedOptions.tracing ?? this.config.tracing;
    const traceOverrides = {
      ...this.traceOverrides,
      ...(resolvedOptions.tracing?.apiKey !== undefined
        ? { tracingApiKey: resolvedOptions.tracing.apiKey }
        : {}),
    };
    const effectiveOptions = {
      ...resolvedOptions,
      sessionInputCallback,
      callModelInputFilter,
    };
    const resumingFromState = input instanceof RunState;
    const preserveTurnPersistenceOnResume =
      resumingFromState &&
      (input as RunState<TContext, TAgent>)._currentTurnInProgress === true;
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
    const sessionPersistence = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter,
      persistInput: saveStreamInputToSession,
      resumingFromState,
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
        },
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
      sessionPersistence?.setPreparedItems(prepared.sessionItems);
    }

    // Streaming runs persist the input asynchronously, so track a one-shot helper
    // that can be awaited from multiple branches without double-writing.
    const ensureStreamInputPersisted =
      sessionPersistence?.buildPersistInputOnce(serverManagesConversation);

    const executeRun = async () => {
      if (effectiveOptions.stream) {
        const streamResult = await this.#runIndividualStream(
          agent,
          preparedInput,
          effectiveOptions,
          ensureStreamInputPersisted,
          sessionPersistence?.recordTurnItems,
          preserveTurnPersistenceOnResume,
        );
        return streamResult;
      }
      const runResult = await this.#runIndividualNonStream(
        agent,
        preparedInput,
        effectiveOptions,
        sessionPersistence?.recordTurnItems,
        preserveTurnPersistenceOnResume,
      );
      // See note above: allow sessions to run for callbacks/state but skip writes when the server
      // is the source of truth for transcript history.
      if (sessionPersistence && !serverManagesConversation) {
        await saveToSession(
          session,
          sessionPersistence.getItemsForPersistence(),
          runResult,
        );
      }
      return runResult;
    };

    if (preparedInput instanceof RunState && preparedInput._trace) {
      const applied = applyTraceOverrides(
        preparedInput._trace,
        preparedInput._currentAgentSpan,
        traceOverrides,
      );
      preparedInput._trace = applied.trace;
      preparedInput._currentAgentSpan = applied.currentSpan;
      return withTrace(preparedInput._trace, async () => {
        if (preparedInput._currentAgentSpan) {
          setCurrentSpan(preparedInput._currentAgentSpan);
        }
        return executeRun();
      });
    }
    return getOrCreateTrace(async () => executeRun(), {
      traceId: this.config.traceId,
      name: this.config.workflowName,
      groupId: this.config.groupId,
      metadata: this.config.traceMetadata,
      // Per-run tracing config overrides exporter defaults such as environment API key.
      tracingApiKey: tracingConfig?.apiKey,
    });
  }

  // --------------------------------------------------------------
  //  Internals
  // --------------------------------------------------------------

  private readonly inputGuardrailDefs: InputGuardrailDefinition[];

  private readonly outputGuardrailDefs: OutputGuardrailDefinition<
    OutputGuardrailMetadata,
    AgentOutputType<unknown>
  >[];

  /**
   * @internal
   * Resolves the effective model once so both run loops obey the same precedence rules.
   */
  async #resolveModelForAgent<TContext>(
    agent: Agent<TContext, AgentOutputType>,
  ): Promise<{
    model: Model;
    explictlyModelSet: boolean;
    resolvedModelName?: string;
  }> {
    const explictlyModelSet =
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
    return { model: resolvedModel, explictlyModelSet, resolvedModelName };
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
    // sessionInputUpdate lets the caller adjust queued session items after filters run so we
    // persist exactly what we send to the model (e.g., after redactions or truncation).
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
    preserveTurnPersistenceOnResume?: boolean,
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
            options.maxTurns ?? DEFAULT_MAX_TURNS,
          );

      const resolvedConversationId =
        options.conversationId ??
        (isResumedState ? state._conversationId : undefined);
      const resolvedPreviousResponseId =
        options.previousResponseId ??
        (isResumedState ? state._previousResponseId : undefined);

      if (!isResumedState) {
        state.setConversationContext(
          resolvedConversationId,
          resolvedPreviousResponseId,
        );
      }

      const serverConversationTracker =
        resolvedConversationId || resolvedPreviousResponseId
          ? new ServerConversationTracker({
              conversationId: resolvedConversationId,
              previousResponseId: resolvedPreviousResponseId,
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

      // Tracks when we resume an approval interruption so the next run-again step stays in the same turn.
      let continuingInterruptedTurn = false;

      try {
        while (true) {
          // if we don't have a current step, we treat this as a new run
          state._currentStep = state._currentStep ?? {
            type: 'next_step_run_again',
          };

          if (state._currentStep.type === 'next_step_interruption') {
            logger.debug('Continuing from interruption');
            if (!state._lastTurnResponse || !state._lastProcessedResponse) {
              throw new UserError(
                'No model response found in previous state',
                state,
              );
            }

            const interruptedOutcome = await resumeInterruptedTurn({
              state,
              runner: this,
            });

            // Don't reset counter here - resolveInterruptedTurn already adjusted it via rewind logic
            // The counter will be reset when _currentTurn is incremented (starting a new turn)

            const { shouldReturn, shouldContinue } = handleInterruptedOutcome({
              state,
              outcome: interruptedOutcome,
              setContinuingInterruptedTurn: (value) => {
                continuingInterruptedTurn = value;
              },
            });
            if (shouldReturn) {
              // we are still in an interruption, so we need to avoid an infinite loop
              return new RunResult<TContext, TAgent>(state);
            }
            if (shouldContinue) {
              continue;
            }
          }

          if (state._currentStep.type === 'next_step_run_again') {
            const wasContinuingInterruptedTurn = continuingInterruptedTurn;
            continuingInterruptedTurn = false;
            const guardrailTracker = createGuardrailTracker();
            const previousTurn = state._currentTurn;
            const previousPersistedCount = state._currentTurnPersistedItemCount;
            const previousGeneratedCount = state._generatedItems.length;
            const { artifacts, turnInput, parallelGuardrailPromise } =
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
                  onParallelStart: guardrailTracker.markPending,
                  onParallelError: guardrailTracker.setError,
                },
                emitAgentStart: (context, agent, inputItems) => {
                  this.emit('agent_start', context, agent, inputItems);
                },
              });
            if (
              preserveTurnPersistenceOnResume &&
              state._currentTurn > previousTurn &&
              previousPersistedCount <= previousGeneratedCount
            ) {
              // Preserve persisted offsets from a resumed run to avoid re-saving prior items.
              state._currentTurnPersistedItemCount = previousPersistedCount;
            }

            guardrailTracker.setPromise(parallelGuardrailPromise);
            const preparedCall = await this.#prepareModelCall(
              state,
              options,
              artifacts,
              turnInput,
              serverConversationTracker,
              sessionInputUpdate,
            );

            guardrailTracker.throwIfError();

            state._lastTurnResponse = await preparedCall.model.getResponse({
              systemInstructions: preparedCall.modelInput.instructions,
              prompt: preparedCall.prompt,
              // Explicit agent/run config models should take precedence over prompt defaults.
              ...(preparedCall.explictlyModelSet
                ? { overridePromptModel: true }
                : {}),
              input: preparedCall.modelInput.input,
              previousResponseId: preparedCall.previousResponseId,
              conversationId: preparedCall.conversationId,
              modelSettings: preparedCall.modelSettings,
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
            });
            if (serverConversationTracker) {
              serverConversationTracker.markInputAsSent(
                preparedCall.sourceItems,
                {
                  filterApplied: preparedCall.filterApplied,
                  allTurnItems: preparedCall.turnInput,
                },
              );
            }
            state._modelResponses.push(state._lastTurnResponse);
            state._context.usage.add(state._lastTurnResponse.usage);
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

            const processedResponse = processModelResponse(
              state._lastTurnResponse,
              state._currentAgent,
              preparedCall.tools,
              preparedCall.handoffs,
            );

            state._lastProcessedResponse = processedResponse;
            const turnResult = await resolveTurnAfterModelResponse<TContext>(
              state._currentAgent,
              state._originalInput,
              state._generatedItems,
              state._lastTurnResponse,
              state._lastProcessedResponse!,
              this,
              state,
            );

            applyTurnResult({
              state,
              turnResult,
              agent: state._currentAgent,
              toolsUsed: state._lastProcessedResponse?.toolsUsed ?? [],
              resetTurnPersistence: !isResumedState,
            });

            await guardrailTracker.awaitCompletion();
          }

          const currentStep = state._currentStep;
          if (!currentStep) {
            logger.debug('Running next loop');
            continue;
          }

          switch (currentStep.type) {
            case 'next_step_final_output':
              await runOutputGuardrails(
                state,
                this.outputGuardrailDefs,
                currentStep.output,
              );
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
              return new RunResult<TContext, TAgent>(state);
            case 'next_step_handoff':
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
              return new RunResult<TContext, TAgent>(state);
            case 'next_step_run_again':
              state._currentTurnInProgress = false;
              logger.debug('Running next loop');
              break;
            default:
              logger.debug('Running next loop');
          }
        }
      } catch (err) {
        state._currentTurnInProgress = false;
        const handledResult = await tryHandleRunError({
          error: err,
          state,
          errorHandlers: options.errorHandlers,
          outputGuardrailDefs: this.outputGuardrailDefs,
          emitAgentEnd: (context, agent, outputText) => {
            this.emit('agent_end', context, agent, outputText);
            agent.emit('agent_end', context, outputText);
          },
        });
        if (handledResult) {
          return handledResult;
        }
        if (state._currentAgentSpan) {
          state._currentAgentSpan.setError({
            message: 'Error in agent run',
            data: { error: String(err) },
          });
        }
        throw err;
      } finally {
        if (state._currentStep?.type !== 'next_step_interruption') {
          try {
            await disposeResolvedComputers({ runContext: state._context });
          } catch (error) {
            logger.warn(`Failed to dispose computers after run: ${error}`);
          }
        }
        if (state._currentAgentSpan) {
          if (state._currentStep?.type !== 'next_step_interruption') {
            // don't end the span if the run was interrupted
            state._currentAgentSpan.end();
          }
          resetCurrentSpan();
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
    options: StreamRunOptions<TContext, TAgent>,
    isResumedState: boolean,
    ensureStreamInputPersisted?: () => Promise<void>,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
    preserveTurnPersistenceOnResume?: boolean,
  ): Promise<void> {
    const resolvedConversationId =
      options.conversationId ?? result.state._conversationId;
    const resolvedPreviousResponseId =
      options.previousResponseId ?? result.state._previousResponseId;
    const serverManagesConversation =
      Boolean(resolvedConversationId) || Boolean(resolvedPreviousResponseId);
    const serverConversationTracker = serverManagesConversation
      ? new ServerConversationTracker({
          conversationId: resolvedConversationId,
          previousResponseId: resolvedPreviousResponseId,
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
    };
    let parallelGuardrailPromise: Promise<InputGuardrailResult[]> | undefined;
    const awaitGuardrailsAndPersistInput = async () => {
      await guardrailTracker.awaitCompletion();
      if (guardrailTracker.failed) {
        throw guardrailTracker.error;
      }
      if (
        sentInputToModel &&
        !streamInputPersisted &&
        !guardrailTracker.failed
      ) {
        await persistStreamInputIfNeeded();
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

    // Tracks when we resume an approval interruption so the next run-again step stays in the same turn.
    let continuingInterruptedTurn = false;

    try {
      while (true) {
        const currentAgent = result.state._currentAgent;

        result.state._currentStep = result.state._currentStep ?? {
          type: 'next_step_run_again',
        };

        if (result.state._currentStep.type === 'next_step_interruption') {
          logger.debug('Continuing from interruption');
          if (
            !result.state._lastTurnResponse ||
            !result.state._lastProcessedResponse
          ) {
            throw new UserError(
              'No model response found in previous state',
              result.state,
            );
          }

          const interruptedOutcome = await resumeInterruptedTurn({
            state: result.state,
            runner: this,
            onStepItems: (turnResult) => {
              addStepToRunResult(result, turnResult);
            },
          });

          // Don't reset counter here - resolveInterruptedTurn already adjusted it via rewind logic
          // The counter will be reset when _currentTurn is incremented (starting a new turn)

          const { shouldReturn, shouldContinue } = handleInterruptedOutcome({
            state: result.state,
            outcome: interruptedOutcome,
            setContinuingInterruptedTurn: (value) => {
              continuingInterruptedTurn = value;
            },
          });
          if (shouldReturn) {
            // we are still in an interruption, so we need to avoid an infinite loop
            return;
          }
          if (shouldContinue) {
            continue;
          }
        }

        if (result.state._currentStep.type === 'next_step_run_again') {
          parallelGuardrailPromise = undefined;
          guardrailTracker = createGuardrailTracker();
          const wasContinuingInterruptedTurn = continuingInterruptedTurn;
          continuingInterruptedTurn = false;
          const previousTurn = result.state._currentTurn;
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
              onParallelStart: () => {
                guardrailTracker.markPending();
              },
              onParallelError: (err) => {
                guardrailTracker.setError(err);
              },
            },
            emitAgentStart: (context, agent, inputItems) => {
              this.emit('agent_start', context, agent, inputItems);
            },
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
          const { artifacts, turnInput } = preparedTurn;
          parallelGuardrailPromise = preparedTurn.parallelGuardrailPromise;
          guardrailTracker.setPromise(parallelGuardrailPromise);
          // If guardrails are still running, defer input persistence until they finish.
          const delayStreamInputPersistence = guardrailTracker.pending;

          const preparedCall = await this.#prepareModelCall(
            result.state,
            options,
            artifacts,
            turnInput,
            serverConversationTracker,
            sessionInputUpdate,
          );

          guardrailTracker.throwIfError();

          let finalResponse: ModelResponse | undefined = undefined;
          let inputMarked = false;
          const markInputOnce = () => {
            if (inputMarked || !serverConversationTracker) {
              return;
            }
            // We only mark inputs as sent after receiving the first stream event,
            // which is the earliest reliable confirmation that the server accepted
            // the request. If the stream fails before any events, leave inputs
            // unmarked so a retry can resend safely.
            // Record the exact input that was sent so the server tracker can advance safely.
            serverConversationTracker.markInputAsSent(
              preparedCall.sourceItems,
              {
                filterApplied: preparedCall.filterApplied,
                allTurnItems: preparedCall.turnInput,
              },
            );
            inputMarked = true;
          };

          sentInputToModel = true;
          if (!delayStreamInputPersistence) {
            await persistStreamInputIfNeeded();
          }

          try {
            for await (const event of preparedCall.model.getStreamedResponse({
              systemInstructions: preparedCall.modelInput.instructions,
              prompt: preparedCall.prompt,
              // Streaming requests should also honor explicitly chosen models.
              ...(preparedCall.explictlyModelSet
                ? { overridePromptModel: true }
                : {}),
              input: preparedCall.modelInput.input,
              previousResponseId: preparedCall.previousResponseId,
              conversationId: preparedCall.conversationId,
              modelSettings: preparedCall.modelSettings,
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
            })) {
              guardrailTracker.throwIfError();
              markInputOnce();
              if (event.type === 'response_done') {
                const parsed = StreamEventResponseCompleted.parse(event);
                finalResponse = {
                  usage: new Usage(parsed.response.usage),
                  output: parsed.response.output,
                  responseId: parsed.response.id,
                };
                result.state._context.usage.add(finalResponse.usage);
              }
              if (result.cancelled) {
                // When the user's code exits a loop to consume the stream, we need to break
                // this loop to prevent internal false errors and unnecessary processing
                await awaitGuardrailsAndPersistInput();
                return;
              }
              result._addItem(new RunRawModelStreamEvent(event));
            }
          } catch (error) {
            if (isAbortError(error)) {
              if (sentInputToModel) {
                markInputOnce();
              }
              await awaitGuardrailsAndPersistInput();
              return;
            }
            throw error;
          }

          if (finalResponse) {
            markInputOnce();
          }

          await awaitGuardrailsAndPersistInput();

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

          const processedResponse = processModelResponse(
            result.state._lastTurnResponse,
            currentAgent,
            preparedCall.tools,
            preparedCall.handoffs,
          );

          result.state._lastProcessedResponse = processedResponse;

          // Record the items emitted directly from the model response so we do not
          // stream them again after tools and other side effects finish.
          const preToolItems = new Set<RunItem>(processedResponse.newItems);
          if (preToolItems.size > 0) {
            streamStepItemsToRunResult(result, processedResponse.newItems);
          }

          const turnResult = await resolveTurnAfterModelResponse<TContext>(
            currentAgent,
            result.state._originalInput,
            result.state._generatedItems,
            result.state._lastTurnResponse,
            result.state._lastProcessedResponse!,
            this,
            result.state,
          );

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
        }

        const currentStep = result.state._currentStep;
        switch (currentStep.type) {
          case 'next_step_final_output':
            await runOutputGuardrails(
              result.state,
              this.outputGuardrailDefs,
              currentStep.output,
            );
            result.state._currentTurnInProgress = false;
            await persistStreamInputIfNeeded();
            // Guardrails must succeed before persisting session memory to avoid storing blocked outputs.
            if (!serverManagesConversation) {
              await saveStreamResultToSession(options.session, result);
            }
            this.emit(
              'agent_end',
              result.state._context,
              currentAgent,
              currentStep.output,
            );
            currentAgent.emit(
              'agent_end',
              result.state._context,
              currentStep.output,
            );
            return;
          case 'next_step_interruption':
            // We are done for now. Don't run any output guardrails.
            await persistStreamInputIfNeeded();
            if (!serverManagesConversation) {
              await saveStreamResultToSession(options.session, result);
            }
            return;
          case 'next_step_handoff':
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
    } catch (error) {
      result.state._currentTurnInProgress = false;
      if (guardrailTracker.pending) {
        await guardrailTracker.awaitCompletion({ suppressErrors: true });
      }
      if (
        sentInputToModel &&
        !streamInputPersisted &&
        !guardrailTracker.failed
      ) {
        await persistStreamInputIfNeeded();
      }
      const handledResult = await tryHandleRunError({
        error,
        state: result.state,
        errorHandlers: options.errorHandlers,
        outputGuardrailDefs: this.outputGuardrailDefs,
        emitAgentEnd: (context, agent, outputText) => {
          this.emit('agent_end', context, agent, outputText);
          agent.emit('agent_end', context, outputText);
        },
        streamResult: result,
      });
      if (handledResult) {
        await persistStreamInputIfNeeded();
        if (!serverManagesConversation) {
          await saveStreamResultToSession(options.session, result);
        }
        return;
      }
      if (result.state._currentAgentSpan) {
        result.state._currentAgentSpan.setError({
          message: 'Error in agent run',
          data: { error: String(error) },
        });
      }
      throw error;
    } finally {
      if (guardrailTracker.pending) {
        await guardrailTracker.awaitCompletion({ suppressErrors: true });
      }
      if (
        sentInputToModel &&
        !streamInputPersisted &&
        !guardrailTracker.failed
      ) {
        await persistStreamInputIfNeeded();
      }
      if (result.state._currentStep?.type !== 'next_step_interruption') {
        try {
          await disposeResolvedComputers({ runContext: result.state._context });
        } catch (error) {
          logger.warn(`Failed to dispose computers after run: ${error}`);
        }
      }
      if (result.state._currentAgentSpan) {
        if (result.state._currentStep?.type !== 'next_step_interruption') {
          result.state._currentAgentSpan.end();
        }
        resetCurrentSpan();
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
    options?: StreamRunOptions<TContext, TAgent>,
    ensureStreamInputPersisted?: () => Promise<void>,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
    preserveTurnPersistenceOnResume?: boolean,
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
            options.maxTurns ?? DEFAULT_MAX_TURNS,
          );
      const resolvedConversationId =
        options.conversationId ??
        (isResumedState ? state._conversationId : undefined);
      const resolvedPreviousResponseId =
        options.previousResponseId ??
        (isResumedState ? state._previousResponseId : undefined);
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
      result.maxTurns = streamOptions.maxTurns ?? state._maxTurns;

      // Continue the stream loop without blocking
      const streamLoopPromise = this.#runStreamLoop(
        result,
        streamOptions,
        isResumedState,
        ensureStreamInputPersisted,
        sessionInputUpdate,
        preserveTurnPersistenceOnResume,
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
   * Applies call-level filters and merges session updates so the model request mirrors exactly
   * what we persisted for history.
   */
  async #prepareModelCall<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
  >(
    state: RunState<TContext, TAgent>,
    options: SharedRunOptions<TContext, TAgent>,
    artifacts: AgentArtifacts<TContext>,
    turnInput: AgentInputItem[],
    serverConversationTracker?: ServerConversationTracker,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
  ): Promise<PreparedModelCall<TContext>> {
    const { model, explictlyModelSet, resolvedModelName } =
      await this.#resolveModelForAgent(state._currentAgent);

    let modelSettings = {
      ...this.config.modelSettings,
      ...state._currentAgent.modelSettings,
    };
    modelSettings = adjustModelSettingsForNonGPT5RunnerModel(
      explictlyModelSet,
      state._currentAgent.modelSettings,
      model,
      modelSettings,
      resolvedModelName,
    );
    modelSettings = maybeResetToolChoice(
      state._currentAgent,
      state._toolUseTracker,
      modelSettings,
    );
    state._lastModelSettings = modelSettings;

    const systemInstructions = await state._currentAgent.getSystemPrompt(
      state._context,
    );
    const prompt = await state._currentAgent.getPrompt(state._context);

    const { modelInput, sourceItems, persistedItems, filterApplied } =
      await applyCallModelInputFilter(
        state._currentAgent,
        options.callModelInputFilter,
        state._context,
        turnInput,
        systemInstructions,
      );

    // Provide filtered clones whenever filters run so session history mirrors the model payload.
    // Returning an empty array is intentional: it tells the session layer to persist "nothing"
    // instead of falling back to the unfiltered originals when the filter redacts everything.
    sessionInputUpdate?.(
      sourceItems,
      filterApplied ? persistedItems : undefined,
    );

    const previousResponseId =
      serverConversationTracker?.previousResponseId ??
      options.previousResponseId;
    const conversationId =
      serverConversationTracker?.conversationId ?? options.conversationId;

    return {
      ...artifacts,
      model,
      explictlyModelSet,
      modelSettings,
      modelInput,
      prompt,
      previousResponseId,
      conversationId,
      sourceItems,
      filterApplied,
      turnInput,
    };
  }
}

// internal helpers and constants

let defaultRunner: Runner | undefined;

const getDefaultRunner = (): Runner => {
  if (!defaultRunner) {
    defaultRunner = new Runner();
  }
  return defaultRunner;
};
