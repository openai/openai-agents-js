import { Agent, AgentOutputType } from '../agent';
import { MaxTurnsExceededError } from '../errors';
import { assistant } from '../helpers/message';
import { RunItem, RunMessageOutputItem } from '../items';
import { ModelResponse } from '../model';
import { RunResult, StreamedRunResult } from '../result';
import { RunContext } from '../runContext';
import { RunState } from '../runState';
import type {
  AgentInputItem,
  AgentOutputItem,
  ResolvedAgentOutput,
} from '../types';
import type {
  OutputGuardrailDefinition,
  OutputGuardrailMetadata,
} from '../guardrail';
import { runOutputGuardrails } from './guardrails';
import { getTurnInput } from './items';
import { streamStepItemsToRunResult } from './streaming';

/**
 * Error kinds supported by run error handlers.
 */
export type RunErrorKind = 'maxTurns';

/**
 * Snapshot of run data passed to error handlers.
 */
export type RunErrorData<TContext, TAgent extends Agent<any, any>> = {
  input: string | AgentInputItem[];
  newItems: RunItem[];
  history: AgentInputItem[];
  output: AgentOutputItem[];
  rawResponses: ModelResponse[];
  lastAgent?: TAgent;
  state?: RunState<TContext, TAgent>;
};

export type RunErrorHandlerInput<TContext, TAgent extends Agent<any, any>> = {
  error: MaxTurnsExceededError;
  context: RunContext<TContext>;
  runData: RunErrorData<TContext, TAgent>;
};

export type RunErrorHandlerResult<TAgent extends Agent<any, any>> = {
  /**
   * The final output to return for the run.
   */
  finalOutput: ResolvedAgentOutput<TAgent['outputType']>;
  /**
   * Whether to append the synthesized output to history for subsequent runs.
   */
  includeInHistory?: boolean;
};

export type RunErrorHandler<TContext, TAgent extends Agent<any, any>> = (
  input: RunErrorHandlerInput<TContext, TAgent>,
) =>
  | RunErrorHandlerResult<TAgent>
  | void
  | Promise<RunErrorHandlerResult<TAgent> | void>;

export type RunErrorHandlers<
  TContext,
  TAgent extends Agent<any, any>,
> = Partial<Record<RunErrorKind, RunErrorHandler<TContext, TAgent>>> & {
  /**
   * Fallback handler for supported error kinds.
   */
  default?: RunErrorHandler<TContext, TAgent>;
};

type TryHandleRunErrorArgs<TContext, TAgent extends Agent<any, any>> = {
  error: unknown;
  state: RunState<TContext, TAgent>;
  errorHandlers?: RunErrorHandlers<TContext, TAgent>;
  outputGuardrailDefs: OutputGuardrailDefinition<
    OutputGuardrailMetadata,
    AgentOutputType<unknown>
  >[];
  emitAgentEnd: (
    context: RunContext<TContext>,
    agent: TAgent,
    outputText: string,
  ) => void;
  streamResult?: StreamedRunResult<TContext, TAgent>;
};

const buildRunData = <TContext, TAgent extends Agent<any, any>>(
  state: RunState<TContext, TAgent>,
): RunErrorData<TContext, TAgent> => ({
  input: state._originalInput,
  newItems: state._generatedItems,
  history: getTurnInput(state._originalInput, state._generatedItems),
  output: getTurnInput([], state._generatedItems),
  rawResponses: state._modelResponses,
  lastAgent: state._currentAgent,
  state,
});

const formatFinalOutput = <TAgent extends Agent<any, any>>(
  agent: TAgent,
  finalOutput: ResolvedAgentOutput<TAgent['outputType']>,
): string => {
  if (agent.outputType === 'text') {
    return String(finalOutput);
  }
  return JSON.stringify(finalOutput);
};

const createFinalOutputItem = <TAgent extends Agent<any, any>>(
  agent: TAgent,
  outputText: string,
): RunMessageOutputItem =>
  new RunMessageOutputItem(assistant(outputText), agent);

export const tryHandleRunError = async <
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>({
  error,
  state,
  errorHandlers,
  outputGuardrailDefs,
  emitAgentEnd,
  streamResult,
}: TryHandleRunErrorArgs<TContext, TAgent>): Promise<
  RunResult<TContext, TAgent> | undefined
> => {
  if (!(error instanceof MaxTurnsExceededError)) {
    return undefined;
  }
  const handler = errorHandlers?.maxTurns ?? errorHandlers?.default;
  if (!handler) {
    return undefined;
  }
  const handlerResult = await handler({
    error,
    context: state._context,
    runData: buildRunData(state),
  });
  if (!handlerResult) {
    return undefined;
  }
  const includeInHistory = handlerResult.includeInHistory !== false;
  const outputText = formatFinalOutput(
    state._currentAgent,
    handlerResult.finalOutput,
  );
  state._lastTurnResponse = undefined;
  state._lastProcessedResponse = undefined;
  const item = createFinalOutputItem(state._currentAgent, outputText);
  if (includeInHistory) {
    state._generatedItems.push(item);
  }
  if (streamResult) {
    streamStepItemsToRunResult(streamResult, [item]);
  }
  state._currentStep = {
    type: 'next_step_final_output',
    output: outputText,
  };
  state._finalOutputSource = 'error_handler';
  await runOutputGuardrails(state, outputGuardrailDefs, outputText);
  state._currentTurnInProgress = false;
  emitAgentEnd(state._context, state._currentAgent, outputText);
  return new RunResult<TContext, TAgent>(state);
};
