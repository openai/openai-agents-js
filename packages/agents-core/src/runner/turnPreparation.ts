import { Agent, AgentOutputType } from '../agent';
import { MaxTurnsExceededError } from '../errors';
import { RunHandoffOutputItem, RunItem } from '../items';
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
import { prepareModelInputItems } from './items';
import { ensureAgentSpan } from './tracing';
import { getToolCallOutputItem } from './toolExecution';
import type { ProcessedResponse } from './types';

type GuardrailHandlers = {
  onParallelStart?: () => void;
  onParallelError?: (error: unknown) => void;
};

type PreparedTurn = {
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
>(options: PrepareTurnOptions<TContext, TAgent>): Promise<PreparedTurn> {
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
  state.setCurrentAgentSpan(
    ensureAgentSpan({
      agent: state._currentAgent,
      handoffs: [],
      tools: [],
      currentSpan: state._currentAgentSpan,
    }),
  );

  const { parallelGuardrailPromise } = await runInputGuardrailsForTurn(
    state,
    inputGuardrailDefs,
    isResumingFromInterruption,
    guardrailHandlers,
  );

  const turnInput = serverConversationTracker
    ? serverConversationTracker.prepareInput(
        input,
        generatedItems,
        getManagedConversationSupplementalItems(state),
      )
    : prepareModelInputItems(
        input,
        generatedItems,
        state._reasoningItemIdPolicy,
      );

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
    turnInput,
    parallelGuardrailPromise,
  };
}

const IGNORED_HANDOFF_OUTPUT_MESSAGE =
  'Multiple handoffs detected, ignoring this one.';

const managedConversationSupplementalItemsCache = new WeakMap<
  ProcessedResponse<any>,
  AgentInputItem[]
>();

export function getManagedConversationSupplementalItems<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(state: RunState<TContext, TAgent>): AgentInputItem[] {
  const processedResponse = state._lastProcessedResponse;
  const handoffs = processedResponse?.handoffs;
  if (!handoffs || handoffs.length <= 1) {
    return [];
  }

  const acceptedCallId = handoffs[0]?.toolCall.callId;
  // Respect handoff input filters that removed the accepted handoff output from the next turn.
  const acceptedHandoffOutputStillPresent =
    typeof acceptedCallId === 'string' &&
    state._generatedItems.some(
      (item) =>
        item instanceof RunHandoffOutputItem &&
        item.rawItem.callId === acceptedCallId,
    );
  if (!acceptedHandoffOutputStillPresent) {
    return [];
  }

  const cached =
    managedConversationSupplementalItemsCache.get(processedResponse);
  if (cached) {
    return cached;
  }

  // Server-managed transcripts still contain ignored handoff calls from the last response.
  // Add synthetic results only to the continuation request so the provider transcript stays balanced.
  const items = handoffs
    .slice(1)
    .map(({ toolCall }) =>
      getToolCallOutputItem(toolCall, IGNORED_HANDOFF_OUTPUT_MESSAGE),
    );
  managedConversationSupplementalItemsCache.set(processedResponse, items);
  return items;
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
