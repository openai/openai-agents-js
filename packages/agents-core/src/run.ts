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
import { getHandoff, Handoff, HandoffInputFilter } from './handoff';
import {
  Model,
  ModelProvider,
  ModelResponse,
  ModelSettings,
  ModelTracing,
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
  executeInterruptedToolsAndSideEffects,
  executeToolsAndSideEffects,
  maybeResetToolChoice,
  ProcessedResponse,
  processModelResponse,
} from './runImplementation';
import { RunItem } from './items';
import {
  getOrCreateTrace,
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

const DEFAULT_MAX_TURNS = 10;

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
};

type SharedRunOptions<TContext = undefined> = {
  context?: TContext | RunContext<TContext>;
  maxTurns?: number;
  signal?: AbortSignal;
  previousResponseId?: string;
};

export type StreamRunOptions<TContext = undefined> =
  SharedRunOptions<TContext> & {
    /**
     * Whether to stream the run. If true, the run will emit events as the model responds.
     */
    stream: true;
  };

export type NonStreamRunOptions<TContext = undefined> =
  SharedRunOptions<TContext> & {
    /**
     * Whether to stream the run. If true, the run will emit events as the model responds.
     */
    stream?: false;
  };

export type IndividualRunOptions<TContext = undefined> =
  | StreamRunOptions<TContext>
  | NonStreamRunOptions<TContext>;

/**
 * @internal
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

export function getTurnInput(
  originalInput: string | AgentInputItem[],
  generatedItems: RunItem[],
): AgentInputItem[] {
  const rawItems = generatedItems
    .filter((item) => item.type !== 'tool_approval_item') // don't include approval items to avoid double function calls
    .map((item) => item.rawItem);

  if (typeof originalInput === 'string') {
    originalInput = [{ type: 'message', role: 'user', content: originalInput }];
  }

  return [...originalInput, ...rawItems];
}

/**
 * A Runner is responsible for running an agent workflow.
 */
export class Runner extends RunHooks<any, AgentOutputType<unknown>> {
  public readonly config: RunConfig;
  private readonly inputGuardrailDefs: InputGuardrailDefinition[];
  private readonly outputGuardrailDefs: OutputGuardrailDefinition<
    OutputGuardrailMetadata,
    AgentOutputType<unknown>
  >[];

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
    };
    this.inputGuardrailDefs = (config.inputGuardrails ?? []).map(
      defineInputGuardrail,
    );
    this.outputGuardrailDefs = (config.outputGuardrails ?? []).map(
      defineOutputGuardrail,
    );
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
  ): Promise<RunResult<TContext, TAgent>> {
    return withNewSpanContext(async () => {
      // if we have a saved state we use that one, otherwise we create a new one
      const state =
        input instanceof RunState
          ? input
          : new RunState(
              options.context instanceof RunContext
                ? options.context
                : new RunContext(options.context),
              input,
              startingAgent,
              options.maxTurns ?? DEFAULT_MAX_TURNS,
            );

      try {
        while (true) {
          let model = state._currentAgent.model ?? this.config.model;

          if (typeof model === 'string') {
            model = await this.config.modelProvider.getModel(model);
          }

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

            const turnResult =
              await executeInterruptedToolsAndSideEffects<TContext>(
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
            state._currentStep = turnResult.nextStep;

            if (turnResult.nextStep.type === 'next_step_interruption') {
              // we are still in an interruption, so we need to avoid an infinite loop
              return new RunResult<TContext, TAgent>(state);
            }

            continue;
          }

          if (state._currentStep.type === 'next_step_run_again') {
            const handoffs = state._currentAgent.handoffs.map(getHandoff);

            if (!state._currentAgentSpan) {
              const handoffNames = handoffs.map((h) => h.agentName);
              state._currentAgentSpan = createAgentSpan({
                data: {
                  name: state._currentAgent.name,
                  handoffs: handoffNames,
                  output_type: state._currentAgent.outputSchemaName,
                },
              });
              state._currentAgentSpan.start();
              setCurrentSpan(state._currentAgentSpan);
            }

            const tools = await state._currentAgent.getAllTools();
            const serializedTools = tools.map((t) => serializeTool(t));
            const serializedHandoffs = handoffs.map((h) => serializeHandoff(h));
            if (state._currentAgentSpan) {
              state._currentAgentSpan.spanData.tools = tools.map((t) => t.name);
            }

            state._currentTurn++;

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

            const turnInput = getTurnInput(
              state._originalInput,
              state._generatedItems,
            );

            if (state._noActiveAgentRun) {
              state._currentAgent.emit(
                'agent_start',
                state._context,
                state._currentAgent,
              );
              this.emit('agent_start', state._context, state._currentAgent);
            }

            let modelSettings = {
              ...this.config.modelSettings,
              ...state._currentAgent.modelSettings,
            };
            modelSettings = maybeResetToolChoice(
              state._currentAgent,
              state._toolUseTracker,
              modelSettings,
            );
            state._lastTurnResponse = await model.getResponse({
              systemInstructions: await state._currentAgent.getSystemPrompt(
                state._context,
              ),
              prompt: await state._currentAgent.getPrompt(state._context),
              input: turnInput,
              previousResponseId: options.previousResponseId,
              modelSettings,
              tools: serializedTools,
              outputType: convertAgentOutputTypeToSerializable(
                state._currentAgent.outputType,
              ),
              handoffs: serializedHandoffs,
              tracing: getTracing(
                this.config.tracingDisabled,
                this.config.traceIncludeSensitiveData,
              ),
              signal: options.signal,
            });
            state._modelResponses.push(state._lastTurnResponse);
            state._context.usage.add(state._lastTurnResponse.usage);
            state._noActiveAgentRun = false;

            const processedResponse = processModelResponse(
              state._lastTurnResponse,
              state._currentAgent,
              tools,
              handoffs,
            );

            state._lastProcessedResponse = processedResponse;
            const turnResult = await executeToolsAndSideEffects<TContext>(
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
   */
  async #runStreamLoop<
    TContext,
    TAgent extends Agent<TContext, AgentOutputType>,
  >(
    result: StreamedRunResult<TContext, TAgent>,
    options: StreamRunOptions<TContext>,
  ): Promise<void> {
    try {
      while (true) {
        const currentAgent = result.state._currentAgent;
        const handoffs = currentAgent.handoffs.map(getHandoff);
        const tools = await currentAgent.getAllTools();
        const serializedTools = tools.map((t) => serializeTool(t));
        const serializedHandoffs = handoffs.map((h) => serializeHandoff(h));

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

          const turnResult =
            await executeInterruptedToolsAndSideEffects<TContext>(
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
          result.state._currentStep = turnResult.nextStep;
          if (turnResult.nextStep.type === 'next_step_interruption') {
            // we are still in an interruption, so we need to avoid an infinite loop
            return;
          }
          continue;
        }

        if (result.state._currentStep.type === 'next_step_run_again') {
          if (!result.state._currentAgentSpan) {
            const handoffNames = handoffs.map((h) => h.agentName);
            result.state._currentAgentSpan = createAgentSpan({
              data: {
                name: currentAgent.name,
                handoffs: handoffNames,
                tools: tools.map((t) => t.name),
                output_type: currentAgent.outputSchemaName,
              },
            });
            result.state._currentAgentSpan.start();
            setCurrentSpan(result.state._currentAgentSpan);
          }

          result.state._currentTurn++;

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

          let model = currentAgent.model ?? this.config.model;

          if (typeof model === 'string') {
            model = await this.config.modelProvider.getModel(model);
          }

          if (result.state._currentTurn === 1) {
            await this.#runInputGuardrails(result.state);
          }

          let modelSettings = {
            ...this.config.modelSettings,
            ...currentAgent.modelSettings,
          };
          modelSettings = maybeResetToolChoice(
            currentAgent,
            result.state._toolUseTracker,
            modelSettings,
          );

          const turnInput = getTurnInput(result.input, result.newItems);

          if (result.state._noActiveAgentRun) {
            currentAgent.emit(
              'agent_start',
              result.state._context,
              currentAgent,
            );
            this.emit('agent_start', result.state._context, currentAgent);
          }

          let finalResponse: ModelResponse | undefined = undefined;

          for await (const event of model.getStreamedResponse({
            systemInstructions: await currentAgent.getSystemPrompt(
              result.state._context,
            ),
            prompt: await currentAgent.getPrompt(result.state._context),
            input: turnInput,
            previousResponseId: options.previousResponseId,
            modelSettings,
            tools: serializedTools,
            handoffs: serializedHandoffs,
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
              'Model did not procude a final response!',
              result.state,
            );
          }

          result.state._lastTurnResponse = finalResponse;
          result.state._modelResponses.push(result.state._lastTurnResponse);

          const processedResponse = processModelResponse(
            result.state._lastTurnResponse,
            currentAgent,
            tools,
            handoffs,
          );

          result.state._lastProcessedResponse = processedResponse;
          const turnResult = await executeToolsAndSideEffects<TContext>(
            currentAgent,
            result.state._originalInput,
            result.state._generatedItems,
            result.state._lastTurnResponse,
            result.state._lastProcessedResponse,
            this,
            result.state,
          );

          addStepToRunResult(result, turnResult);

          result.state._toolUseTracker.addToolUse(
            currentAgent,
            processedResponse.toolsUsed,
          );

          result.state._originalInput = turnResult.originalInput;
          result.state._generatedItems = turnResult.generatedItems;
          result.state._currentStep = turnResult.nextStep;
        }

        if (result.state._currentStep.type === 'next_step_final_output') {
          await this.#runOutputGuardrails(
            result.state,
            result.state._currentStep.output,
          );
          return;
        } else if (
          result.state._currentStep.type === 'next_step_interruption'
        ) {
          // we are done for now. Don't run any output guardrails
          return;
        } else if (result.state._currentStep.type === 'next_step_handoff') {
          result.state._currentAgent = result.state._currentStep
            ?.newAgent as TAgent;
          if (result.state._currentAgentSpan) {
            result.state._currentAgentSpan.end();
            resetCurrentSpan();
          }
          result.state._currentAgentSpan = undefined;
          result._addItem(new RunAgentUpdatedStreamEvent(currentAgent));
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
  ): Promise<StreamedRunResult<TContext, TAgent>> {
    options = options ?? ({} as StreamRunOptions<TContext>);
    return withNewSpanContext(async () => {
      // Initialize or reuse existing state
      const state: RunState<TContext, TAgent> =
        input instanceof RunState
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
      this.#runStreamLoop(result, options).then(
        () => {
          result._done();
        },
        (err) => {
          result._raiseError(err);
        },
      );

      return result;
    });
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
   * @param options - The options for the run.
   * @param options.stream - Whether to stream the run. If true, the run will emit events as the
   * model responds.
   * @param options.context - The context to run the agent with.
   * @param options.maxTurns - The maximum number of turns to run the agent.
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
  run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options: IndividualRunOptions<TContext> = {
      stream: false,
      context: undefined,
    } as IndividualRunOptions<TContext>,
  ): Promise<
    RunResult<TContext, TAgent> | StreamedRunResult<TContext, TAgent>
  > {
    if (input instanceof RunState && input._trace) {
      return withTrace(input._trace, async () => {
        if (input._currentAgentSpan) {
          setCurrentSpan(input._currentAgentSpan);
        }

        if (options?.stream) {
          return this.#runIndividualStream(agent, input, options);
        } else {
          return this.#runIndividualNonStream(agent, input, options);
        }
      });
    }

    return getOrCreateTrace(
      async () => {
        if (options?.stream) {
          return this.#runIndividualStream(agent, input, options);
        } else {
          return this.#runIndividualNonStream(agent, input, options);
        }
      },
      {
        traceId: this.config.traceId,
        name: this.config.workflowName,
        groupId: this.config.groupId,
        metadata: this.config.traceMetadata,
      },
    );
  }
}

let _defaultRunner: Runner | undefined = undefined;
function getDefaultRunner() {
  if (_defaultRunner) {
    return _defaultRunner;
  }
  _defaultRunner = new Runner();
  return _defaultRunner;
}

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
