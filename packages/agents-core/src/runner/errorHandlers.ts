import { Agent, AgentOutputType } from '../agent';
import {
  MaxTurnsExceededError,
  ModelBehaviorError,
  ModelRefusalError,
  ToolCallError,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  UserError,
} from '../errors';
import { assistant } from '../helpers/message';
import { RunItem, RunMessageOutputItem } from '../items';
import logger from '../logger';
import { ModelResponse } from '../model';
import { StreamedRunResult } from '../result';
import { RunContext } from '../runContext';
import { RunState } from '../runState';
import type {
  AgentInputItem,
  AgentOutputItem,
  ResolvedAgentOutput,
} from '../types';
import { getTurnInput } from './items';
import { streamStepItemsToRunResult } from './streaming';
import { createRedactedErrorDetailsError } from '../utils/finalOutputError';

/**
 * Error kinds supported by run error handlers.
 */
export type RunErrorKind = 'maxTurns' | 'modelRefusal' | 'invalidFinalOutput';

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
  error: MaxTurnsExceededError | ModelRefusalError | ModelBehaviorError;
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
  streamResult?: StreamedRunResult<TContext, TAgent>;
};

type ResolveRunErrorHandlerArgs<TContext, TAgent extends Agent<any, any>> = {
  error: unknown;
  errorKind?: RunErrorKind;
  errorHandlers?: RunErrorHandlers<TContext, TAgent>;
  context: RunContext<TContext>;
  runData: RunErrorData<TContext, TAgent>;
};

export async function preserveInvalidFinalOutputRedaction<T>(
  callback: (redactFromStart: boolean) => T | Promise<T>,
  inheritedRedaction = false,
): Promise<T> {
  const redactFromStart = inheritedRedaction || logger.dontLogModelData;

  try {
    return await callback(redactFromStart);
  } catch (error) {
    if (redactFromStart || logger.dontLogModelData) {
      throw createRedactedErrorDetailsError();
    }
    throw error;
  }
}

/**
 * Attaches the active run state to nested tool guardrail tripwire errors without replacing them.
 */
export const attachRunStateToError = <TContext, TAgent extends Agent<any, any>>(
  error: unknown,
  state: RunState<TContext, TAgent>,
): void => {
  if (!(error instanceof ToolCallError)) {
    return;
  }

  if (
    error.error instanceof ToolInputGuardrailTripwireTriggered ||
    error.error instanceof ToolOutputGuardrailTripwireTriggered
  ) {
    error.error.state ??= state;
  }
};

const buildRunData = <TContext, TAgent extends Agent<any, any>>(
  state: RunState<TContext, TAgent>,
): RunErrorData<TContext, TAgent> => ({
  input: state._originalInput,
  newItems: state._generatedItems,
  history: getTurnInput(
    state._originalInput,
    state._generatedItems,
    state._reasoningItemIdPolicy,
  ),
  output: getTurnInput([], state._generatedItems, state._reasoningItemIdPolicy),
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

function validateRunErrorFinalOutput<TAgent extends Agent<any, any>>(
  agent: TAgent,
  outputText: string,
  redactInvalidOutputDetails = false,
  redactFromStart = false,
): void {
  try {
    agent.processFinalOutput(outputText);
  } catch (error) {
    if (
      redactInvalidOutputDetails &&
      (redactFromStart || logger.dontLogModelData)
    ) {
      throw createRedactedErrorDetailsError();
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Invalid run error handler finalOutput: ${message}`);
  }
}

export const formatRunErrorFinalOutput = formatFinalOutput;
export const createRunErrorFinalOutputItem = createFinalOutputItem;
export const validateRunErrorHandlerFinalOutput = validateRunErrorFinalOutput;

export const resolveRunErrorHandler = async <
  TContext,
  TAgent extends Agent<any, any>,
>({
  error,
  errorKind,
  errorHandlers,
  context,
  runData,
}: ResolveRunErrorHandlerArgs<TContext, TAgent>): Promise<
  RunErrorHandlerResult<TAgent> | undefined
> => {
  const kind =
    errorKind ??
    (error instanceof MaxTurnsExceededError
      ? 'maxTurns'
      : error instanceof ModelRefusalError
        ? 'modelRefusal'
        : undefined);

  if (!kind) {
    return undefined;
  }

  const typedError =
    kind === 'maxTurns' && error instanceof MaxTurnsExceededError
      ? error
      : kind === 'modelRefusal' && error instanceof ModelRefusalError
        ? error
        : kind === 'invalidFinalOutput' && error instanceof ModelBehaviorError
          ? error
          : undefined;

  if (!typedError) {
    return undefined;
  }

  const handler = errorHandlers?.[kind] ?? errorHandlers?.default;
  if (!handler) {
    return undefined;
  }

  const handlerResult = await handler({
    error: typedError,
    context,
    runData,
  });
  return handlerResult || undefined;
};

export const prepareRunErrorFinalOutput = async <
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>({
  error,
  state,
  errorHandlers,
  streamResult,
}: TryHandleRunErrorArgs<TContext, TAgent>): Promise<boolean> => {
  const handlerResult = await resolveRunErrorHandler({
    error,
    errorHandlers,
    context: state._context,
    runData: buildRunData(state),
  });
  if (!handlerResult) {
    return false;
  }
  const includeInHistory = handlerResult.includeInHistory !== false;
  const outputText = formatFinalOutput(
    state._currentAgent,
    handlerResult.finalOutput,
  );
  validateRunErrorFinalOutput(state._currentAgent, outputText);
  streamResult?._hideFinalOutput();
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
  return true;
};
