import { Agent, AgentOutputType } from '../agent';
import { MaxTurnsExceededError } from '../errors';
import { RunItem } from '../items';
import logger from '../logger';
import { RunState } from '../runState';
import type { AgentInputItem } from '../types';
import type {
  InputGuardrailDefinition,
  InputGuardrailResult,
} from '../guardrail';
import { ServerConversationTracker } from './conversation';
import {
  buildInputGuardrailDefinitions,
  runInputGuardrails,
  splitInputGuardrails,
} from './guardrails';
import { getTurnInput } from './items';
import { prepareAgentArtifacts } from './modelPreparation';
import type { AgentArtifacts } from './types';

type GuardrailHandlers = {
  onParallelStart?: () => void;
  onParallelError?: (error: unknown) => void;
};

type PreparedTurn<TContext> = {
  artifacts: AgentArtifacts<TContext>;
  turnInput: AgentInputItem[];
  parallelGuardrailPromise?: Promise<InputGuardrailResult[]>;
};

type PrepareTurnOptions<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
> = {
  state: RunState<TContext, TAgent>;
  input: string | AgentInputItem[];
  generatedItems: RunItem[];
  isResumedState: boolean;
  preserveTurnPersistenceOnResume?: boolean;
  continuingInterruptedTurn: boolean;
  serverConversationTracker?: ServerConversationTracker;
  inputGuardrailDefs: InputGuardrailDefinition[];
  guardrailHandlers?: GuardrailHandlers;
  emitAgentStart?: (
    context: RunState<TContext, TAgent>['_context'],
    agent: TAgent,
    turnInput: AgentInputItem[],
  ) => void;
};

export async function prepareTurn<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(
  options: PrepareTurnOptions<TContext, TAgent>,
): Promise<PreparedTurn<TContext>> {
  const {
    state,
    input,
    generatedItems,
    isResumedState,
    preserveTurnPersistenceOnResume,
    continuingInterruptedTurn,
    serverConversationTracker,
    inputGuardrailDefs,
    guardrailHandlers,
    emitAgentStart,
  } = options;
  const artifacts = await prepareAgentArtifacts(state);

  const { isResumingFromInterruption } = beginTurn(state, {
    isResumedState,
    preserveTurnPersistenceOnResume,
    continuingInterruptedTurn,
  });

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

  const { parallelGuardrailPromise } = await runInputGuardrailsForTurn(
    state,
    inputGuardrailDefs,
    isResumingFromInterruption,
    guardrailHandlers,
  );

  const turnInput = serverConversationTracker
    ? serverConversationTracker.prepareInput(input, generatedItems)
    : getTurnInput(input, generatedItems);

  if (state._noActiveAgentRun) {
    state._currentAgent.emit(
      'agent_start',
      state._context,
      state._currentAgent,
      turnInput,
    );
    emitAgentStart?.(state._context, state._currentAgent, turnInput);
  }

  return {
    artifacts,
    turnInput,
    parallelGuardrailPromise,
  };
}

async function runInputGuardrailsForTurn<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(
  state: RunState<TContext, TAgent>,
  runnerGuardrails: InputGuardrailDefinition[],
  isResumingFromInterruption: boolean,
  handlers: GuardrailHandlers = {},
): Promise<{ parallelGuardrailPromise?: Promise<InputGuardrailResult[]> }> {
  if (state._currentTurn !== 1 || isResumingFromInterruption) {
    return {};
  }

  const guardrailDefs = buildInputGuardrailDefinitions(state, runnerGuardrails);
  const guardrails = splitInputGuardrails(guardrailDefs);
  if (guardrails.blocking.length > 0) {
    await runInputGuardrails(state, guardrails.blocking);
  }
  if (guardrails.parallel.length > 0) {
    handlers.onParallelStart?.();
    const promise = runInputGuardrails(state, guardrails.parallel);
    const parallelGuardrailPromise = promise.catch((err) => {
      handlers.onParallelError?.(err);
      return [];
    });
    return { parallelGuardrailPromise };
  }

  return {};
}

function beginTurn<TContext, TAgent extends Agent<TContext, AgentOutputType>>(
  state: RunState<TContext, TAgent>,
  options: {
    isResumedState: boolean;
    preserveTurnPersistenceOnResume?: boolean;
    continuingInterruptedTurn: boolean;
  },
): { isResumingFromInterruption: boolean } {
  const isResumingFromInterruption =
    options.isResumedState && options.continuingInterruptedTurn;
  const resumingTurnInProgress =
    options.isResumedState && state._currentTurnInProgress === true;

  // Do not advance the turn when resuming from an interruption; the next model call is
  // still part of the same logical turn.
  if (!isResumingFromInterruption && !resumingTurnInProgress) {
    state._currentTurn++;
    if (!options.isResumedState || !options.preserveTurnPersistenceOnResume) {
      state.resetTurnPersistence();
    } else if (
      state._currentTurnPersistedItemCount > state._generatedItems.length
    ) {
      // Reset if a stale count would skip items in subsequent turns.
      state.resetTurnPersistence();
    }
  }
  state._currentTurnInProgress = true;

  return { isResumingFromInterruption };
}
