import { Agent, AgentOutputType } from './agent';
import {
  defineInputGuardrail,
  defineOutputGuardrail,
  InputGuardrail,
  InputGuardrailDefinition,
  OutputGuardrail,
  OutputGuardrailDefinition,
  OutputGuardrailFunctionArgs,
  OutputGuardrailMetadata,
} from './guardrail';
import { Handoff, HandoffInputFilter } from './handoff';
import {
  Model,
  ModelProvider,
  ModelResponse,
  ModelSettings,
  ModelTracing,
  Prompt,
  SerializedHandoff,
  SerializedTool,
} from './model';
import { getDefaultModelProvider } from './providers';
import { RunContext } from './runContext';
import { AgentInputItem } from './types';
import { RunResult, StreamedRunResult } from './result';
import { RunHooks } from './lifecycle';
import logger from './logger';
import { serializeTool, serializeHandoff } from './utils/serialize';
import {
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OutputGuardrailTripwireTriggered,
  UserError,
} from './errors';
import {
  addStepToRunResult,
  resolveInterruptedTurn,
  resolveTurnAfterModelResponse,
  maybeResetToolChoice,
  ProcessedResponse,
  processModelResponse,
  streamStepItemsToRunResult,
  saveStreamInputToSession,
  saveStreamResultToSession,
  saveToSession,
  prepareInputItemsWithSession,
} from './runImplementation';
import { RunItem } from './items';
import { Tool } from './tool';
import {
  getOrCreateTrace,
  addErrorToCurrentSpan,
  resetCurrentSpan,
  setCurrentSpan,
  withNewSpanContext,
  withTrace,
} from './tracing/context';
import { createAgentSpan, withGuardrailSpan } from './tracing';
import { Usage } from './usage';
import { RunAgentUpdatedStreamEvent, RunRawModelStreamEvent } from './events';
import { RunState } from './runState';
import { StreamEventResponseCompleted } from './types/protocol';
import { convertAgentOutputTypeToSerializable } from './utils/tools';
import { gpt5ReasoningSettingsRequired, isGpt5Default } from './defaultModel';
import type { Session, SessionInputCallback } from './memory/session';
import { encodeUint8ArrayToBase64 } from './utils/base64';
import {
  isArrayBufferView,
  isNodeBuffer,
  isSerializedBufferSnapshot,
} from './utils/smartString';

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
type SharedRunOptions<TContext = undefined> = {
  context?: TContext | RunContext<TContext>;
  maxTurns?: number;
  signal?: AbortSignal;
  previousResponseId?: string;
  conversationId?: string;
  session?: Session;
  sessionInputCallback?: SessionInputCallback;
  callModelInputFilter?: CallModelInputFilter;
};

/**
 * Options for runs that stream incremental events as the model responds.
 */
export type StreamRunOptions<TContext = undefined> =
  SharedRunOptions<TContext> & {
    /**
     * Whether to stream the run. If true, the run will emit events as the model responds.
     */
    stream: true;
  };

/**
 * Options for runs that collect the full model response before returning.
 */
export type NonStreamRunOptions<TContext = undefined> =
  SharedRunOptions<TContext> & {
    /**
     * Run to completion without streaming incremental events; leave undefined or set to `false`.
     */
    stream?: false;
  };

/**
 * Options polymorphic over streaming or non-streaming execution modes.
 */
export type IndividualRunOptions<TContext = undefined> =
  | StreamRunOptions<TContext>
  | NonStreamRunOptions<TContext>;

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
  options?: NonStreamRunOptions<TContext>,
): Promise<RunResult<TContext, TAgent>>;
export async function run<TAgent extends Agent<any, any>, TContext = undefined>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: StreamRunOptions<TContext>,
): Promise<StreamedRunResult<TContext, TAgent>>;
export async function run<TAgent extends Agent<any, any>, TContext = undefined>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: StreamRunOptions<TContext> | NonStreamRunOptions<TContext>,
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
      sessionInputCallback: config.sessionInputCallback,
      callModelInputFilter: config.callModelInputFilter,
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
   * 1. If the maxTurns is exceeded, a MaxTurnsExceeded exception is raised.
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
    options?: NonStreamRunOptions<TContext>,
  ): Promise<RunResult<TContext, TAgent>>;
  run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: StreamRunOptions<TContext>,
  ): Promise<StreamedRunResult<TContext, TAgent>>;
  async run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options: IndividualRunOptions<TContext> = {
      stream: false,
      context: undefined,
    } as IndividualRunOptions<TContext>,
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
    const effectiveOptions = {
      ...resolvedOptions,
      sessionInputCallback,
      callModelInputFilter,
    };
    const serverManagesConversation =
      Boolean(effectiveOptions.conversationId) ||
      Boolean(effectiveOptions.previousResponseId);
    // When the server tracks conversation history we defer to it for previous turns so local session
    // persistence can focus solely on the new delta being generated in this process.
    const session = effectiveOptions.session;
    const resumingFromState = input instanceof RunState;
    let sessionInputOriginalSnapshot: AgentInputItem[] | undefined =
      session && resumingFromState ? [] : undefined;
    let sessionInputFilteredSnapshot: AgentInputItem[] | undefined = undefined;
    // Tracks remaining persistence slots per AgentInputItem key so resumed sessions only write each original occurrence once.
    let sessionInputPendingWriteCounts: Map<string, number> | undefined =
      session && resumingFromState ? new Map() : undefined;
    // Keeps track of which inputs should be written back to session memory. `sourceItems` reflects
    // the original objects (so we can respect resume counts) while `filteredItems`, when present,
    // contains the filtered/redacted clones that must be persisted for history.
    // The helper reconciles the filtered copies produced by callModelInputFilter with their original
    // counterparts so resume-from-state bookkeeping stays consistent and duplicate references only
    // consume a single persistence slot.
    const recordSessionItemsForPersistence = (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => {
      const pendingWriteCounts = sessionInputPendingWriteCounts;
      if (filteredItems !== undefined) {
        if (!pendingWriteCounts) {
          sessionInputFilteredSnapshot = filteredItems.map((item) =>
            structuredClone(item),
          );
          return;
        }
        const persistableItems: AgentInputItem[] = [];
        const sourceOccurrenceCounts = new WeakMap<AgentInputItem, number>();
        // Track how many times each original object appears so duplicate references only consume one persistence slot.
        for (const source of sourceItems) {
          if (!source || typeof source !== 'object') {
            continue;
          }
          const nextCount = (sourceOccurrenceCounts.get(source) ?? 0) + 1;
          sourceOccurrenceCounts.set(source, nextCount);
        }
        // Let filtered items without a one-to-one source match claim any remaining persistence count.
        const consumeAnyPendingWriteSlot = () => {
          for (const [key, remaining] of pendingWriteCounts) {
            if (remaining > 0) {
              pendingWriteCounts.set(key, remaining - 1);
              return true;
            }
          }
          return false;
        };
        for (let i = 0; i < filteredItems.length; i++) {
          const filteredItem = filteredItems[i];
          if (!filteredItem) {
            continue;
          }
          let allocated = false;
          const source = sourceItems[i];
          if (source && typeof source === 'object') {
            const pendingOccurrences =
              (sourceOccurrenceCounts.get(source) ?? 0) - 1;
            sourceOccurrenceCounts.set(source, pendingOccurrences);
            if (pendingOccurrences > 0) {
              continue;
            }
            const sourceKey = getAgentInputItemKey(source);
            const remaining = pendingWriteCounts.get(sourceKey) ?? 0;
            if (remaining > 0) {
              pendingWriteCounts.set(sourceKey, remaining - 1);
              persistableItems.push(structuredClone(filteredItem));
              allocated = true;
              continue;
            }
          }
          const filteredKey = getAgentInputItemKey(filteredItem);
          const filteredRemaining = pendingWriteCounts.get(filteredKey) ?? 0;
          if (filteredRemaining > 0) {
            pendingWriteCounts.set(filteredKey, filteredRemaining - 1);
            persistableItems.push(structuredClone(filteredItem));
            allocated = true;
            continue;
          }
          if (!source && consumeAnyPendingWriteSlot()) {
            persistableItems.push(structuredClone(filteredItem));
            allocated = true;
          }
          if (
            !allocated &&
            !source &&
            sessionInputFilteredSnapshot === undefined
          ) {
            // Preserve at least one copy so later persistence resolves even when no counters remain.
            persistableItems.push(structuredClone(filteredItem));
          }
        }
        if (
          persistableItems.length > 0 ||
          sessionInputFilteredSnapshot === undefined
        ) {
          sessionInputFilteredSnapshot = persistableItems;
        }
        return;
      }
      const filtered: AgentInputItem[] = [];
      if (!pendingWriteCounts) {
        for (const item of sourceItems) {
          if (!item) {
            continue;
          }
          filtered.push(structuredClone(item));
        }
      } else {
        for (const item of sourceItems) {
          if (!item) {
            continue;
          }
          const key = getAgentInputItemKey(item);
          const remaining = pendingWriteCounts.get(key) ?? 0;
          if (remaining <= 0) {
            continue;
          }
          pendingWriteCounts.set(key, remaining - 1);
          filtered.push(structuredClone(item));
        }
      }
      if (filtered.length > 0) {
        sessionInputFilteredSnapshot = filtered;
      } else if (sessionInputFilteredSnapshot === undefined) {
        sessionInputFilteredSnapshot = [];
      }
    };

    // Determine which items should be committed to session memory for this turn.
    // Filters take precedence because they reflect the exact payload delivered to the model.
    const resolveSessionItemsForPersistence = () => {
      if (sessionInputFilteredSnapshot !== undefined) {
        return sessionInputFilteredSnapshot;
      }
      if (hasCallModelInputFilter) {
        return undefined;
      }
      return sessionInputOriginalSnapshot;
    };

    let preparedInput: typeof input = input;
    if (!(preparedInput instanceof RunState)) {
      if (session && Array.isArray(preparedInput) && !sessionInputCallback) {
        throw new UserError(
          'RunConfig.sessionInputCallback must be provided when using session history with list inputs.',
        );
      }

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
      if (session) {
        const items = prepared.sessionItems ?? [];
        // Clone the items that will be persisted so later mutations (filters, hooks) cannot desync history.
        sessionInputOriginalSnapshot = items.map((item) =>
          structuredClone(item),
        );
        // Reset pending counts so each prepared item reserves exactly one write slot until filters resolve matches.
        sessionInputPendingWriteCounts = new Map();
        for (const item of items) {
          const key = getAgentInputItemKey(item);
          sessionInputPendingWriteCounts.set(
            key,
            (sessionInputPendingWriteCounts.get(key) ?? 0) + 1,
          );
        }
      }
    }

    // Streaming runs persist the input asynchronously, so track a one-shot helper
    // that can be awaited from multiple branches without double-writing.
    let ensureStreamInputPersisted: (() => Promise<void>) | undefined;
    // Sessions remain usable alongside server-managed conversations (e.g., OpenAIConversationsSession)
    // so callers can reuse callbacks, resume-from-state logic, and other helpers without duplicating
    // remote history, so persistence is gated on serverManagesConversation.
    if (session && !serverManagesConversation) {
      let persisted = false;
      ensureStreamInputPersisted = async () => {
        if (persisted) {
          return;
        }
        const itemsToPersist = resolveSessionItemsForPersistence();
        if (!itemsToPersist || itemsToPersist.length === 0) {
          return;
        }
        persisted = true;
        await saveStreamInputToSession(session, itemsToPersist);
      };
    }

    const executeRun = async () => {
      if (effectiveOptions.stream) {
        const streamResult = await this.#runIndividualStream(
          agent,
          preparedInput,
          effectiveOptions,
          ensureStreamInputPersisted,
          recordSessionItemsForPersistence,
        );
        return streamResult;
      }
      const runResult = await this.#runIndividualNonStream(
        agent,
        preparedInput,
        effectiveOptions,
        recordSessionItemsForPersistence,
      );
      // See note above: allow sessions to run for callbacks/state but skip writes when the server
      // is the source of truth for transcript history.
      if (session && !serverManagesConversation) {
        await saveToSession(
          session,
          resolveSessionItemsForPersistence(),
          runResult,
        );
      }
      return runResult;
    };

    if (preparedInput instanceof RunState && preparedInput._trace) {
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
  ): Promise<{ model: Model; explictlyModelSet: boolean }> {
    const explictlyModelSet =
      (agent.model !== undefined &&
        agent.model !== Agent.DEFAULT_MODEL_PLACEHOLDER) ||
      (this.config.model !== undefined &&
        this.config.model !== Agent.DEFAULT_MODEL_PLACEHOLDER);
    let resolvedModel = selectModel(agent.model, this.config.model);
    if (typeof resolvedModel === 'string') {
      resolvedModel = await this.config.modelProvider.getModel(resolvedModel);
    }
    return { model: resolvedModel, explictlyModelSet };
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
    options: NonStreamRunOptions<TContext>,
    // sessionInputUpdate lets the caller adjust queued session items after filters run so we
    // persist exactly what we send to the model (e.g., after redactions or truncation).
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
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

      const serverConversationTracker =
        options.conversationId || options.previousResponseId
          ? new ServerConversationTracker({
              conversationId: options.conversationId,
              previousResponseId: options.previousResponseId,
            })
          : undefined;

      if (serverConversationTracker && isResumedState) {
        serverConversationTracker.primeFromState({
          originalInput: state._originalInput,
          generatedItems: state._generatedItems,
          modelResponses: state._modelResponses,
        });
      }

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

            const turnResult = await resolveInterruptedTurn<TContext>(
              state._currentAgent,
              state._originalInput,
              state._generatedItems,
              state._lastTurnResponse,
              state._lastProcessedResponse as ProcessedResponse<unknown>,
              this,
              state,
            );

            state._toolUseTracker.addToolUse(
              state._currentAgent,
              state._lastProcessedResponse.toolsUsed,
            );

            state._originalInput = turnResult.originalInput;
            state._generatedItems = turnResult.generatedItems;
            if (turnResult.nextStep.type === 'next_step_run_again') {
              state._currentTurnPersistedItemCount = 0;
            }
            state._currentStep = turnResult.nextStep;

            if (turnResult.nextStep.type === 'next_step_interruption') {
              // we are still in an interruption, so we need to avoid an infinite loop
              return new RunResult<TContext, TAgent>(state);
            }

            continue;
          }

          if (state._currentStep.type === 'next_step_run_again') {
            const artifacts = await prepareAgentArtifacts(state);

            state._currentTurn++;
            state._currentTurnPersistedItemCount = 0;

            if (state._currentTurn > state._maxTurns) {
              state._currentAgentSpan?.setError({
                message: 'Max turns exceeded',
                data: { max_turns: state._maxTurns },
              });

              throw new MaxTurnsExceededError(
                `Max turns (${state._maxTurns}) exceeded`,
                state,
              );
            }

            logger.debug(
              `Running agent ${state._currentAgent.name} (turn ${state._currentTurn})`,
            );

            if (state._currentTurn === 1) {
              await this.#runInputGuardrails(state);
            }

            const turnInput = serverConversationTracker
              ? serverConversationTracker.prepareInput(
                  state._originalInput,
                  state._generatedItems,
                )
              : getTurnInput(state._originalInput, state._generatedItems);

            if (state._noActiveAgentRun) {
              state._currentAgent.emit(
                'agent_start',
                state._context,
                state._currentAgent,
              );
              this.emit('agent_start', state._context, state._currentAgent);
            }

            const preparedCall = await this.#prepareModelCall(
              state,
              options,
              artifacts,
              turnInput,
              serverConversationTracker,
              sessionInputUpdate,
            );

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
            state._modelResponses.push(state._lastTurnResponse);
            state._context.usage.add(state._lastTurnResponse.usage);
            state._noActiveAgentRun = false;

            // After each turn record the items echoed by the server so future requests only
            // include the incremental inputs that have not yet been acknowledged.
            serverConversationTracker?.trackServerItems(
              state._lastTurnResponse,
            );

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
              state._lastProcessedResponse,
              this,
              state,
            );

            state._toolUseTracker.addToolUse(
              state._currentAgent,
              state._lastProcessedResponse.toolsUsed,
            );

            state._originalInput = turnResult.originalInput;
            state._generatedItems = turnResult.generatedItems;
            if (turnResult.nextStep.type === 'next_step_run_again') {
              state._currentTurnPersistedItemCount = 0;
            }
            state._currentStep = turnResult.nextStep;
          }

          if (
            state._currentStep &&
            state._currentStep.type === 'next_step_final_output'
          ) {
            await this.#runOutputGuardrails(state, state._currentStep.output);
            this.emit(
              'agent_end',
              state._context,
              state._currentAgent,
              state._currentStep.output,
            );
            state._currentAgent.emit(
              'agent_end',
              state._context,
              state._currentStep.output,
            );
            return new RunResult<TContext, TAgent>(state);
          } else if (
            state._currentStep &&
            state._currentStep.type === 'next_step_handoff'
          ) {
            state._currentAgent = state._currentStep.newAgent as TAgent;
            if (state._currentAgentSpan) {
              state._currentAgentSpan.end();
              resetCurrentSpan();
              state._currentAgentSpan = undefined;
            }
            state._noActiveAgentRun = true;

            // we've processed the handoff, so we need to run the loop again
            state._currentStep = { type: 'next_step_run_again' };
          } else if (
            state._currentStep &&
            state._currentStep.type === 'next_step_interruption'
          ) {
            // interrupted. Don't run any guardrails
            return new RunResult<TContext, TAgent>(state);
          } else {
            logger.debug('Running next loop');
          }
        }
      } catch (err) {
        if (state._currentAgentSpan) {
          state._currentAgentSpan.setError({
            message: 'Error in agent run',
            data: { error: String(err) },
          });
        }
        throw err;
      } finally {
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
    options: StreamRunOptions<TContext>,
    isResumedState: boolean,
    ensureStreamInputPersisted?: () => Promise<void>,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
  ): Promise<void> {
    const serverManagesConversation =
      Boolean(options.conversationId) || Boolean(options.previousResponseId);
    const serverConversationTracker = serverManagesConversation
      ? new ServerConversationTracker({
          conversationId: options.conversationId,
          previousResponseId: options.previousResponseId,
        })
      : undefined;

    let handedInputToModel = false;
    let streamInputPersisted = false;
    const persistStreamInputIfNeeded = async () => {
      if (streamInputPersisted || !ensureStreamInputPersisted) {
        return;
      }
      // Both success and error paths call this helper, so guard against multiple writes.
      await ensureStreamInputPersisted();
      streamInputPersisted = true;
    };

    if (serverConversationTracker && isResumedState) {
      serverConversationTracker.primeFromState({
        originalInput: result.state._originalInput,
        generatedItems: result.state._generatedItems,
        modelResponses: result.state._modelResponses,
      });
    }

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

          const turnResult = await resolveInterruptedTurn<TContext>(
            result.state._currentAgent,
            result.state._originalInput,
            result.state._generatedItems,
            result.state._lastTurnResponse,
            result.state._lastProcessedResponse as ProcessedResponse<unknown>,
            this,
            result.state,
          );

          addStepToRunResult(result, turnResult);

          result.state._toolUseTracker.addToolUse(
            result.state._currentAgent,
            result.state._lastProcessedResponse.toolsUsed,
          );

          result.state._originalInput = turnResult.originalInput;
          result.state._generatedItems = turnResult.generatedItems;
          if (turnResult.nextStep.type === 'next_step_run_again') {
            result.state._currentTurnPersistedItemCount = 0;
          }
          result.state._currentStep = turnResult.nextStep;
          if (turnResult.nextStep.type === 'next_step_interruption') {
            // we are still in an interruption, so we need to avoid an infinite loop
            return;
          }
          continue;
        }

        if (result.state._currentStep.type === 'next_step_run_again') {
          const artifacts = await prepareAgentArtifacts(result.state);

          result.state._currentTurn++;
          result.state._currentTurnPersistedItemCount = 0;

          if (result.state._currentTurn > result.state._maxTurns) {
            result.state._currentAgentSpan?.setError({
              message: 'Max turns exceeded',
              data: { max_turns: result.state._maxTurns },
            });
            throw new MaxTurnsExceededError(
              `Max turns (${result.state._maxTurns}) exceeded`,
              result.state,
            );
          }

          logger.debug(
            `Running agent ${currentAgent.name} (turn ${result.state._currentTurn})`,
          );

          if (result.state._currentTurn === 1) {
            await this.#runInputGuardrails(result.state);
          }

          const turnInput = serverConversationTracker
            ? serverConversationTracker.prepareInput(
                result.input,
                result.newItems,
              )
            : getTurnInput(result.input, result.newItems);

          if (result.state._noActiveAgentRun) {
            currentAgent.emit(
              'agent_start',
              result.state._context,
              currentAgent,
            );
            this.emit('agent_start', result.state._context, currentAgent);
          }

          let finalResponse: ModelResponse | undefined = undefined;

          const preparedCall = await this.#prepareModelCall(
            result.state,
            options,
            artifacts,
            turnInput,
            serverConversationTracker,
            sessionInputUpdate,
          );

          handedInputToModel = true;
          await persistStreamInputIfNeeded();

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
            if (event.type === 'response_done') {
              const parsed = StreamEventResponseCompleted.parse(event);
              finalResponse = {
                usage: new Usage(parsed.response.usage),
                output: parsed.response.output,
                responseId: parsed.response.id,
              };
            }
            if (result.cancelled) {
              // When the user's code exits a loop to consume the stream, we need to break
              // this loop to prevent internal false errors and unnecessary processing
              return;
            }
            result._addItem(new RunRawModelStreamEvent(event));
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
          const preToolItems = new Set(processedResponse.newItems);
          if (preToolItems.size > 0) {
            streamStepItemsToRunResult(result, processedResponse.newItems);
          }

          const turnResult = await resolveTurnAfterModelResponse<TContext>(
            currentAgent,
            result.state._originalInput,
            result.state._generatedItems,
            result.state._lastTurnResponse,
            result.state._lastProcessedResponse,
            this,
            result.state,
          );

          addStepToRunResult(result, turnResult, {
            skipItems: preToolItems,
          });

          result.state._toolUseTracker.addToolUse(
            currentAgent,
            processedResponse.toolsUsed,
          );

          result.state._originalInput = turnResult.originalInput;
          result.state._generatedItems = turnResult.generatedItems;
          if (turnResult.nextStep.type === 'next_step_run_again') {
            result.state._currentTurnPersistedItemCount = 0;
          }
          result.state._currentStep = turnResult.nextStep;
        }

        if (result.state._currentStep.type === 'next_step_final_output') {
          await this.#runOutputGuardrails(
            result.state,
            result.state._currentStep.output,
          );
          await persistStreamInputIfNeeded();
          // Guardrails must succeed before persisting session memory to avoid storing blocked outputs.
          if (!serverManagesConversation) {
            await saveStreamResultToSession(options.session, result);
          }
          this.emit(
            'agent_end',
            result.state._context,
            currentAgent,
            result.state._currentStep.output,
          );
          currentAgent.emit(
            'agent_end',
            result.state._context,
            result.state._currentStep.output,
          );
          return;
        } else if (
          result.state._currentStep.type === 'next_step_interruption'
        ) {
          // we are done for now. Don't run any output guardrails
          await persistStreamInputIfNeeded();
          if (!serverManagesConversation) {
            await saveStreamResultToSession(options.session, result);
          }
          return;
        } else if (result.state._currentStep.type === 'next_step_handoff') {
          result.state._currentAgent = result.state._currentStep
            ?.newAgent as TAgent;
          if (result.state._currentAgentSpan) {
            result.state._currentAgentSpan.end();
            resetCurrentSpan();
          }
          result.state._currentAgentSpan = undefined;
          result._addItem(
            new RunAgentUpdatedStreamEvent(result.state._currentAgent),
          );
          result.state._noActiveAgentRun = true;

          // we've processed the handoff, so we need to run the loop again
          result.state._currentStep = {
            type: 'next_step_run_again',
          };
        } else {
          logger.debug('Running next loop');
        }
      }
    } catch (error) {
      if (handedInputToModel && !streamInputPersisted) {
        await persistStreamInputIfNeeded();
      }
      if (result.state._currentAgentSpan) {
        result.state._currentAgentSpan.setError({
          message: 'Error in agent run',
          data: { error: String(error) },
        });
      }
      throw error;
    } finally {
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
    options?: StreamRunOptions<TContext>,
    ensureStreamInputPersisted?: () => Promise<void>,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
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

      // Initialize the streamed result with existing state
      const result = new StreamedRunResult<TContext, TAgent>({
        signal: options.signal,
        state,
      });

      // Setup defaults
      result.maxTurns = options.maxTurns ?? state._maxTurns;

      // Continue the stream loop without blocking
      const streamLoopPromise = this.#runStreamLoop(
        result,
        options,
        isResumedState,
        ensureStreamInputPersisted,
        sessionInputUpdate,
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

  async #runInputGuardrails<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
  >(state: RunState<TContext, TAgent>) {
    const guardrails = this.inputGuardrailDefs.concat(
      state._currentAgent.inputGuardrails.map(defineInputGuardrail),
    );
    if (guardrails.length > 0) {
      const guardrailArgs = {
        agent: state._currentAgent,
        input: state._originalInput,
        context: state._context,
      };
      try {
        const results = await Promise.all(
          guardrails.map(async (guardrail) => {
            return withGuardrailSpan(
              async (span) => {
                const result = await guardrail.run(guardrailArgs);
                span.spanData.triggered = result.output.tripwireTriggered;
                return result;
              },
              { data: { name: guardrail.name } },
              state._currentAgentSpan,
            );
          }),
        );
        for (const result of results) {
          if (result.output.tripwireTriggered) {
            if (state._currentAgentSpan) {
              state._currentAgentSpan.setError({
                message: 'Guardrail tripwire triggered',
                data: { guardrail: result.guardrail.name },
              });
            }
            throw new InputGuardrailTripwireTriggered(
              `Input guardrail triggered: ${JSON.stringify(result.output.outputInfo)}`,
              result,
              state,
            );
          }
        }
      } catch (e) {
        if (e instanceof InputGuardrailTripwireTriggered) {
          throw e;
        }
        // roll back the current turn to enable reruns
        state._currentTurn--;
        throw new GuardrailExecutionError(
          `Input guardrail failed to complete: ${e}`,
          e as Error,
          state,
        );
      }
    }
  }

  async #runOutputGuardrails<
    TContext,
    TOutput extends AgentOutputType,
    TAgent extends Agent<TContext, TOutput>,
  >(state: RunState<TContext, TAgent>, output: string) {
    const guardrails = this.outputGuardrailDefs.concat(
      state._currentAgent.outputGuardrails.map(defineOutputGuardrail),
    );
    if (guardrails.length > 0) {
      const agentOutput = state._currentAgent.processFinalOutput(output);
      const guardrailArgs: OutputGuardrailFunctionArgs<unknown, TOutput> = {
        agent: state._currentAgent,
        agentOutput,
        context: state._context,
        details: { modelResponse: state._lastTurnResponse },
      };
      try {
        const results = await Promise.all(
          guardrails.map(async (guardrail) => {
            return withGuardrailSpan(
              async (span) => {
                const result = await guardrail.run(guardrailArgs);
                span.spanData.triggered = result.output.tripwireTriggered;
                return result;
              },
              { data: { name: guardrail.name } },
              state._currentAgentSpan,
            );
          }),
        );
        for (const result of results) {
          if (result.output.tripwireTriggered) {
            if (state._currentAgentSpan) {
              state._currentAgentSpan.setError({
                message: 'Guardrail tripwire triggered',
                data: { guardrail: result.guardrail.name },
              });
            }
            throw new OutputGuardrailTripwireTriggered(
              `Output guardrail triggered: ${JSON.stringify(result.output.outputInfo)}`,
              result,
              state,
            );
          }
        }
      } catch (e) {
        if (e instanceof OutputGuardrailTripwireTriggered) {
          throw e;
        }
        throw new GuardrailExecutionError(
          `Output guardrail failed to complete: ${e}`,
          e as Error,
          state,
        );
      }
    }
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
    options: SharedRunOptions<TContext>,
    artifacts: AgentArtifacts<TContext>,
    turnInput: AgentInputItem[],
    serverConversationTracker?: ServerConversationTracker,
    sessionInputUpdate?: (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => void,
  ): Promise<PreparedModelCall<TContext>> {
    const { model, explictlyModelSet } = await this.#resolveModelForAgent(
      state._currentAgent,
    );

    let modelSettings = {
      ...this.config.modelSettings,
      ...state._currentAgent.modelSettings,
    };
    modelSettings = adjustModelSettingsForNonGPT5RunnerModel(
      explictlyModelSet,
      state._currentAgent.modelSettings,
      model,
      modelSettings,
    );
    modelSettings = maybeResetToolChoice(
      state._currentAgent,
      state._toolUseTracker,
      modelSettings,
    );

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

    // Inform the tracker which exact original objects made it to the provider so future turns
    // only send the delta that has not yet been acknowledged by the server.
    serverConversationTracker?.markInputAsSent(sourceItems);
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
    };
  }
}

// --------------------------------------------------------------
//  Other types and functions
// --------------------------------------------------------------

/**
 * Mutable view of the instructions + input items that the model will receive.
 * Filters always see a copy so they can edit without side effects.
 */
export type ModelInputData = {
  input: AgentInputItem[];
  instructions?: string;
};

/**
 * Shape of the payload given to `callModelInputFilter`. Mirrored in the Python SDK so filters can
 * share the same implementation across languages.
 */
export type CallModelInputFilterArgs<TContext = unknown> = {
  modelData: ModelInputData;
  agent: Agent<TContext, AgentOutputType>;
  context: TContext | undefined;
};

/**
 * Hook invoked immediately before a model call is issued, allowing callers to adjust the
 * instructions or input array. Returning a new array enables redaction, truncation, or
 * augmentation of the payload that will be sent to the provider.
 */
export type CallModelInputFilter<TContext = unknown> = (
  args: CallModelInputFilterArgs<TContext>,
) => ModelInputData | Promise<ModelInputData>;

/**
 * Constructs the model input array for the current turn by combining the original turn input with
 * any new run items (excluding tool approval placeholders). This helps ensure that repeated calls
 * to the Responses API only send newly generated content.
 *
 * See: https://platform.openai.com/docs/guides/conversation-state?api-mode=responses.
 */
export function getTurnInput(
  originalInput: string | AgentInputItem[],
  generatedItems: RunItem[],
): AgentInputItem[] {
  const rawItems = generatedItems
    .filter((item) => item.type !== 'tool_approval_item') // don't include approval items to avoid double function calls
    .map((item) => item.rawItem);
  return [...toAgentInputList(originalInput), ...rawItems];
}

// --------------------------------------------------------------
//  Internal helpers
// --------------------------------------------------------------

const DEFAULT_MAX_TURNS = 10;

let _defaultRunner: Runner | undefined = undefined;

function getDefaultRunner() {
  if (_defaultRunner) {
    return _defaultRunner;
  }
  _defaultRunner = new Runner();
  return _defaultRunner;
}

/**
 * Resolves the effective model for the next turn by giving precedence to the agent-specific
 * configuration when present, otherwise falling back to the runner-level default.
 */
export function selectModel(
  agentModel: string | Model,
  runConfigModel: string | Model | undefined,
): string | Model {
  // When initializing an agent without model name, the model property is set to an empty string. So,
  // * agentModel === Agent.DEFAULT_MODEL_PLACEHOLDER & runConfigModel exists, runConfigModel will be used
  // * agentModel is set, the agentModel will be used over runConfigModel
  if (
    (typeof agentModel === 'string' &&
      agentModel !== Agent.DEFAULT_MODEL_PLACEHOLDER) ||
    agentModel // any truthy value
  ) {
    return agentModel;
  }
  return runConfigModel ?? agentModel ?? Agent.DEFAULT_MODEL_PLACEHOLDER;
}

/**
 * Normalizes tracing configuration into the format expected by model providers.
 * Returns `false` to disable tracing, `true` to include full payload data, or
 * `'enabled_without_data'` to omit sensitive content while still emitting spans.
 */
export function getTracing(
  tracingDisabled: boolean,
  traceIncludeSensitiveData: boolean,
): ModelTracing {
  if (tracingDisabled) {
    return false;
  }

  if (traceIncludeSensitiveData) {
    return true;
  }

  return 'enabled_without_data';
}

/**
 * Result of applying a `callModelInputFilter`.
 * - `modelInput` is the payload that goes to the model.
 * - `sourceItems` maps each filtered item back to the original turn item (or `undefined` when none).
 *   This lets the conversation tracker know which originals reached the model.
 * - `persistedItems` are the filtered clones we should commit to session memory so the stored
 *   history reflects any redactions or truncation introduced by the filter.
 * - `filterApplied` signals whether a filter ran so callers can distinguish empty filtered results
 *   from the filter being skipped entirely.
 */
type FilterApplicationResult = {
  modelInput: ModelInputData;
  sourceItems: (AgentInputItem | undefined)[];
  persistedItems: AgentInputItem[];
  filterApplied: boolean;
};

/**
 * @internal
 */
async function applyCallModelInputFilter<TContext>(
  agent: Agent<TContext, AgentOutputType>,
  callModelInputFilter: CallModelInputFilter<any> | undefined,
  context: RunContext<TContext>,
  inputItems: AgentInputItem[],
  systemInstructions: string | undefined,
): Promise<FilterApplicationResult> {
  const cloneInputItems = (
    items: AgentInputItem[],
    map?: WeakMap<object, AgentInputItem>,
  ) =>
    items.map((item) => {
      const cloned = structuredClone(item) as AgentInputItem;
      if (map && cloned && typeof cloned === 'object') {
        map.set(cloned as object, item);
      }
      return cloned;
    });

  // Record the relationship between the cloned array passed to filters and the original inputs.
  const cloneMap = new WeakMap<object, AgentInputItem>();
  const originalPool = buildAgentInputPool(inputItems);
  const fallbackOriginals: AgentInputItem[] = [];
  // Track any original object inputs so filtered replacements can still mark them as delivered.
  for (const item of inputItems) {
    if (item && typeof item === 'object') {
      fallbackOriginals.push(item);
    }
  }
  const removeFromFallback = (candidate: AgentInputItem | undefined) => {
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    const index = fallbackOriginals.findIndex(
      (original) => original === candidate,
    );
    if (index !== -1) {
      fallbackOriginals.splice(index, 1);
    }
  };
  const takeFallbackOriginal = (): AgentInputItem | undefined => {
    const next = fallbackOriginals.shift();
    if (next) {
      removeAgentInputFromPool(originalPool, next);
    }
    return next;
  };

  // Always create a deep copy so downstream mutations inside filters cannot affect
  // the cached turn state.
  const clonedBaseInput = cloneInputItems(inputItems, cloneMap);
  const base: ModelInputData = {
    input: clonedBaseInput,
    instructions: systemInstructions,
  };
  if (!callModelInputFilter) {
    return {
      modelInput: base,
      sourceItems: [...inputItems],
      persistedItems: [],
      filterApplied: false,
    };
  }

  try {
    const result = await callModelInputFilter({
      modelData: base,
      agent,
      context: context.context,
    } as CallModelInputFilterArgs<any>);

    if (!result || !Array.isArray(result.input)) {
      throw new UserError(
        'callModelInputFilter must return a ModelInputData object with an input array.',
      );
    }

    // Preserve a pointer to the original object backing each filtered clone so downstream
    // trackers can keep their bookkeeping consistent even after redaction.
    const sourceItems = result.input.map((item) => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }
      const original = cloneMap.get(item as object);
      if (original) {
        removeFromFallback(original);
        removeAgentInputFromPool(originalPool, original);
        return original;
      }
      const key = getAgentInputItemKey(item as AgentInputItem);
      const matchedByContent = takeAgentInputFromPool(originalPool, key);
      if (matchedByContent) {
        removeFromFallback(matchedByContent);
        return matchedByContent;
      }
      const fallback = takeFallbackOriginal();
      if (fallback) {
        return fallback;
      }
      return undefined;
    });

    const clonedFilteredInput = cloneInputItems(result.input);
    return {
      modelInput: {
        input: clonedFilteredInput,
        instructions:
          typeof result.instructions === 'undefined'
            ? systemInstructions
            : result.instructions,
      },
      sourceItems,
      persistedItems: clonedFilteredInput.map((item) => structuredClone(item)),
      filterApplied: true,
    };
  } catch (error) {
    addErrorToCurrentSpan({
      message: 'Error in callModelInputFilter',
      data: { error: String(error) },
    });
    throw error;
  }
}

// Tracks which items have already been sent to or received from the Responses API when the caller
// supplies `conversationId`/`previousResponseId`. This ensures we only send the delta each turn.
class ServerConversationTracker {
  // Conversation ID:
  // - https://platform.openai.com/docs/guides/conversation-state?api-mode=responses#using-the-conversations-api
  // - https://platform.openai.com/docs/api-reference/conversations/create
  public conversationId?: string;

  // Previous Response ID:
  // https://platform.openai.com/docs/guides/conversation-state?api-mode=responses#passing-context-from-the-previous-response
  public previousResponseId?: string;

  // Using this flag because WeakSet does not provide a way to check its size
  private sentInitialInput = false;
  // The items already sent to the model; using WeakSet for memory efficiency
  private sentItems = new WeakSet<object>();
  // The items received from the server; using WeakSet for memory efficiency
  private serverItems = new WeakSet<object>();
  // Track initial input items that have not yet been sent so they can be retried on later turns.
  private remainingInitialInput: AgentInputItem[] | null = null;

  constructor({
    conversationId,
    previousResponseId,
  }: {
    conversationId?: string;
    previousResponseId?: string;
  }) {
    this.conversationId = conversationId ?? undefined;
    this.previousResponseId = previousResponseId ?? undefined;
  }

  /**
   * Pre-populates tracker caches from an existing RunState when resuming server-managed runs.
   */
  primeFromState({
    originalInput,
    generatedItems,
    modelResponses,
  }: {
    originalInput: string | AgentInputItem[];
    generatedItems: RunItem[];
    modelResponses: ModelResponse[];
  }) {
    if (this.sentInitialInput) {
      return;
    }

    for (const item of toAgentInputList(originalInput)) {
      if (item && typeof item === 'object') {
        this.sentItems.add(item);
      }
    }

    this.sentInitialInput = true;
    this.remainingInitialInput = null;

    const latestResponse = modelResponses[modelResponses.length - 1];
    for (const response of modelResponses) {
      for (const item of response.output) {
        if (item && typeof item === 'object') {
          this.serverItems.add(item);
        }
      }
    }

    if (!this.conversationId && latestResponse?.responseId) {
      this.previousResponseId = latestResponse.responseId;
    }

    for (const item of generatedItems) {
      const rawItem = item.rawItem;
      if (!rawItem || typeof rawItem !== 'object') {
        continue;
      }
      if (this.serverItems.has(rawItem)) {
        this.sentItems.add(rawItem);
      }
    }
  }

  /**
   * Records the raw items returned by the server so future delta calculations skip them.
   * Also captures the latest response identifier to chain follow-up calls when possible.
   */
  trackServerItems(modelResponse: ModelResponse | undefined) {
    if (!modelResponse) {
      return;
    }
    for (const item of modelResponse.output) {
      if (item && typeof item === 'object') {
        this.serverItems.add(item);
      }
    }
    if (!this.conversationId && modelResponse.responseId) {
      this.previousResponseId = modelResponse.responseId;
    }
  }

  /**
   * Returns the minimum set of items that still need to be delivered to the server for the
   * current turn. This includes the original turn inputs (until acknowledged) plus any
   * newly generated items that have not yet been echoed back by the API.
   */
  prepareInput(
    originalInput: string | AgentInputItem[],
    generatedItems: RunItem[],
  ): AgentInputItem[] {
    const inputItems: AgentInputItem[] = [];

    if (!this.sentInitialInput) {
      const initialItems = toAgentInputList(originalInput);
      // Preserve the full initial payload so a filter can drop items without losing their originals.
      inputItems.push(...initialItems);
      this.remainingInitialInput = initialItems.filter(
        (item): item is AgentInputItem =>
          Boolean(item) && typeof item === 'object',
      );
      this.sentInitialInput = true;
    } else if (
      this.remainingInitialInput &&
      this.remainingInitialInput.length > 0
    ) {
      // Re-queue prior initial items until the tracker confirms they were delivered to the API.
      inputItems.push(...this.remainingInitialInput);
    }

    for (const item of generatedItems) {
      if (item.type === 'tool_approval_item') {
        continue;
      }
      const rawItem = item.rawItem;
      if (!rawItem || typeof rawItem !== 'object') {
        continue;
      }
      if (this.sentItems.has(rawItem) || this.serverItems.has(rawItem)) {
        continue;
      }
      inputItems.push(rawItem as AgentInputItem);
    }

    return inputItems;
  }

  /**
   * Marks the provided originals as delivered so future turns do not resend them and any
   * pending initial inputs can be dropped once the server acknowledges receipt.
   */
  markInputAsSent(items: (AgentInputItem | undefined)[]) {
    if (!items.length) {
      return;
    }

    const delivered = new Set<AgentInputItem>();
    for (const item of items) {
      if (!item || typeof item !== 'object' || delivered.has(item)) {
        continue;
      }
      // Some inputs may be repeated in the filtered list; only mark unique originals once.
      delivered.add(item);
      this.sentItems.add(item);
    }

    if (
      !this.remainingInitialInput ||
      this.remainingInitialInput.length === 0
    ) {
      return;
    }

    this.remainingInitialInput = this.remainingInitialInput.filter(
      (item) => !delivered.has(item),
    );
    if (this.remainingInitialInput.length === 0) {
      this.remainingInitialInput = null;
    }
  }
}

/**
 * When the default model is a GPT-5 variant, agents may carry GPT-5-specific providerData
 * (e.g., reasoning effort, text verbosity). If a run resolves to a non-GPT-5 model and the
 * agent relied on the default model (i.e., no explicit model set), these GPT-5-only settings
 * are incompatible and should be stripped to avoid runtime errors.
 */
function adjustModelSettingsForNonGPT5RunnerModel(
  explictlyModelSet: boolean,
  agentModelSettings: ModelSettings,
  runnerModel: string | Model,
  modelSettings: ModelSettings,
): ModelSettings {
  if (
    // gpt-5 is enabled for the default model for agents
    isGpt5Default() &&
    // explicitly set model for the agent
    explictlyModelSet &&
    // this runner uses a non-gpt-5 model
    (typeof runnerModel !== 'string' ||
      !gpt5ReasoningSettingsRequired(runnerModel)) &&
    (agentModelSettings.providerData?.reasoning ||
      agentModelSettings.providerData?.text?.verbosity ||
      (agentModelSettings.providerData as any)?.reasoning_effort)
  ) {
    const copiedModelSettings = { ...modelSettings };
    // the incompatible parameters should be removed to avoid runtime errors
    delete copiedModelSettings.providerData?.reasoning;
    delete (copiedModelSettings.providerData as any)?.text?.verbosity;
    delete (copiedModelSettings.providerData as any)?.reasoning_effort;
    if (copiedModelSettings.reasoning) {
      delete copiedModelSettings.reasoning.effort;
      delete copiedModelSettings.reasoning.summary;
    }
    if (copiedModelSettings.text) {
      delete copiedModelSettings.text.verbosity;
    }
    return copiedModelSettings;
  }
  return modelSettings;
}

// Package turn metadata so both run loops share identical serialization.
// Each field mirrors the information we ship to the model for the current agent turn.
type AgentArtifacts<TContext = unknown> = {
  handoffs: Handoff<any, any>[];
  tools: Tool<TContext>[];
  serializedHandoffs: SerializedHandoff[];
  serializedTools: SerializedTool[];
};

/**
 * @internal
 * Collects tools/handoffs early so we can annotate spans before model execution begins.
 */
async function prepareAgentArtifacts<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(state: RunState<TContext, TAgent>): Promise<AgentArtifacts<TContext>> {
  const handoffs = await state._currentAgent.getEnabledHandoffs(state._context);
  const tools = await state._currentAgent.getAllTools(state._context);

  if (!state._currentAgentSpan) {
    const handoffNames = handoffs.map((h) => h.agentName);
    state._currentAgentSpan = createAgentSpan({
      data: {
        name: state._currentAgent.name,
        handoffs: handoffNames,
        tools: tools.map((t) => t.name),
        output_type: state._currentAgent.outputSchemaName,
      },
    });
    state._currentAgentSpan.start();
    setCurrentSpan(state._currentAgentSpan);
  } else {
    state._currentAgentSpan.spanData.tools = tools.map((t) => t.name);
  }

  return {
    handoffs,
    tools,
    serializedHandoffs: handoffs.map((handoff) => serializeHandoff(handoff)),
    serializedTools: tools.map((tool) => serializeTool(tool)),
  };
}

// Captures everything required to call the model once so we avoid recomputing precedence or filters.
// The values here are the "final say" for a turn; every loop simply consumes the structure rather
// than attempting to rebuild model settings, filters, or metadata on its own.
type PreparedModelCall<TContext = unknown> = AgentArtifacts<TContext> & {
  model: Model;
  explictlyModelSet: boolean;
  modelSettings: ModelSettings;
  modelInput: ModelInputData;
  prompt?: Prompt;
  previousResponseId?: string;
  conversationId?: string;
};

type AgentInputItemPool = Map<string, AgentInputItem[]>;

function getAgentInputItemKey(item: AgentInputItem): string {
  // Deep serialization keeps binary inputs comparable after filters clone them.
  return JSON.stringify(item, agentInputSerializationReplacer);
}

function buildAgentInputPool(items: AgentInputItem[]): AgentInputItemPool {
  // Track every original object so filters can safely return cloned copies.
  const pool: AgentInputItemPool = new Map();
  for (const item of items) {
    const key = getAgentInputItemKey(item);
    const existing = pool.get(key);
    if (existing) {
      existing.push(item);
    } else {
      pool.set(key, [item]);
    }
  }
  return pool;
}

function takeAgentInputFromPool(
  pool: AgentInputItemPool,
  key: string,
): AgentInputItem | undefined {
  // Prefer reusing the earliest untouched original to keep ordering stable.
  const candidates = pool.get(key);
  if (!candidates || candidates.length === 0) {
    return undefined;
  }
  const [first] = candidates;
  candidates.shift();
  if (candidates.length === 0) {
    pool.delete(key);
  }
  return first;
}

function removeAgentInputFromPool(
  pool: AgentInputItemPool,
  item: AgentInputItem,
) {
  // Remove exactly the matched instance so duplicate payloads remain available.
  const key = getAgentInputItemKey(item);
  const candidates = pool.get(key);
  if (!candidates || candidates.length === 0) {
    return;
  }
  const index = candidates.findIndex((candidate) => candidate === item);
  if (index === -1) {
    return;
  }
  candidates.splice(index, 1);
  if (candidates.length === 0) {
    pool.delete(key);
  }
}

function agentInputSerializationReplacer(
  _key: string,
  value: unknown,
): unknown {
  // Mirror runImplementation serialization so buffer snapshots round-trip.
  if (value instanceof ArrayBuffer) {
    return {
      __type: 'ArrayBuffer',
      data: encodeUint8ArrayToBase64(new Uint8Array(value)),
    };
  }

  if (isArrayBufferView(value)) {
    const view = value as ArrayBufferView;
    return {
      __type: view.constructor.name,
      data: encodeUint8ArrayToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }

  if (isNodeBuffer(value)) {
    const view = value as Uint8Array;
    return {
      __type: 'Buffer',
      data: encodeUint8ArrayToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }

  if (isSerializedBufferSnapshot(value)) {
    return {
      __type: 'Buffer',
      data: encodeUint8ArrayToBase64(Uint8Array.from(value.data)),
    };
  }

  return value;
}

// Normalizes user-provided input into the structure the model expects. Strings become user messages,
// arrays are kept as-is so downstream loops can treat both scenarios uniformly.
function toAgentInputList(
  originalInput: string | AgentInputItem[],
): AgentInputItem[] {
  // Allow callers to pass plain strings while preserving original item order.
  if (typeof originalInput === 'string') {
    return [{ type: 'message', role: 'user', content: originalInput }];
  }

  return [...originalInput];
}
