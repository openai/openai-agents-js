import { Agent, AgentOutputType } from '../agent';
import { MaxTurnsExceededError } from '../errors';
import { RunHandoffOutputItem, RunInputItem, RunItem } from '../items';
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
import type { Span, Trace } from '../tracing';
import { getToolCallOutputItem } from './toolExecution';
import type { ProcessedResponse } from './types';

type GuardrailHandlers = {
  onParallelPromise?: (promise: Promise<InputGuardrailResult[]>) => void;
  onParallelError?: (error: unknown) => void;
};

type PreparedTurn = {
  turnInput: AgentInputItem[];
  pendingInputItems: RunInputItem[];
  pendingInputSourceItems: AgentInputItem[];
};

// Keep run-local input normalizations stable so identity-preserving filters can reuse them
// across turns without changing the serialized RunState boundary.
type PreparedInputIdentityCache = {
  normalizedStringInput?: {
    source: string;
    items: AgentInputItem[];
  };
  pendingInputItems: WeakMap<object, RunInputItem[]>;
};

const preparedInputIdentityByRunState = new WeakMap<
  RunState<any, any>,
  PreparedInputIdentityCache
>();

function getPreparedInputIdentityCache<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(state: RunState<TContext, TAgent>): PreparedInputIdentityCache {
  const cached = preparedInputIdentityByRunState.get(state);
  if (cached) {
    return cached;
  }
  const created = { pendingInputItems: new WeakMap<object, RunInputItem[]>() };
  preparedInputIdentityByRunState.set(state, created);
  return created;
}

function getPreparedOriginalInput<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(
  state: RunState<TContext, TAgent>,
  input: string | AgentInputItem[],
): AgentInputItem[] {
  if (typeof input !== 'string') {
    return input;
  }
  const cache = getPreparedInputIdentityCache(state);
  if (cache.normalizedStringInput?.source === input) {
    return cache.normalizedStringInput.items;
  }
  const normalized = prepareModelInputItems(input, []);
  cache.normalizedStringInput = { source: input, items: normalized };
  return normalized;
}

function getPreparedPendingInputItem<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(
  state: RunState<TContext, TAgent>,
  item: AgentInputItem,
  occurrenceIndex: number,
): RunInputItem {
  if (!item || typeof item !== 'object') {
    return new RunInputItem(structuredClone(item), state._currentAgent);
  }
  const cache = getPreparedInputIdentityCache(state);
  const cached = cache.pendingInputItems.get(item as object)?.[occurrenceIndex];
  if (cached) {
    cached.agent = state._currentAgent;
    return cached;
  }
  const prepared = new RunInputItem(structuredClone(item), state._currentAgent);
  const preparedOccurrences = cache.pendingInputItems.get(item as object) ?? [];
  preparedOccurrences[occurrenceIndex] = prepared;
  cache.pendingInputItems.set(item as object, preparedOccurrences);
  if (prepared.rawItem && typeof prepared.rawItem === 'object') {
    cache.pendingInputItems.set(prepared.rawItem as object, [prepared]);
  }
  return prepared;
}

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
  onAgentSpanReady?: (turn: number, agentName: string) => void;
  agentSpanParent?: Span<any> | Trace;
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
    onAgentSpanReady,
    agentSpanParent,
  } = options;

  const { isResumingFromInterruption } = beginTurn(state, {
    isResumedState,
    preserveTurnPersistenceOnResume,
    continuingInterruptedTurn,
  });

  if (state._maxTurns !== null && state._currentTurn > state._maxTurns) {
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
      parent: agentSpanParent,
    }),
  );
  onAgentSpanReady?.(state._currentTurn, state._currentAgent.name);

  const pendingInputSourceItems = [...state._pendingInput];
  await runInputGuardrailsForTurn(
    state,
    inputGuardrailDefs,
    isResumingFromInterruption,
    guardrailHandlers,
  );

  const pendingInputOccurrences = new WeakMap<object, number>();
  const pendingInputItems = pendingInputSourceItems.map((item) => {
    const occurrenceIndex =
      item && typeof item === 'object'
        ? (pendingInputOccurrences.get(item as object) ?? 0)
        : 0;
    if (item && typeof item === 'object') {
      pendingInputOccurrences.set(item as object, occurrenceIndex + 1);
    }
    return getPreparedPendingInputItem(state, item, occurrenceIndex);
  });
  const generatedItemsForTurn = generatedItems.concat(pendingInputItems);
  const preparedOriginalInput = getPreparedOriginalInput(state, input);

  const turnInput = serverConversationTracker
    ? serverConversationTracker.prepareInput(
        preparedOriginalInput,
        generatedItemsForTurn,
        getManagedConversationSupplementalItems(state),
        pendingInputItems,
      )
    : prepareModelInputItems(
        preparedOriginalInput,
        generatedItemsForTurn,
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
    pendingInputItems,
    pendingInputSourceItems,
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
): Promise<void> {
  const guardrailInput =
    state._pendingInput.length > 0 ? state.pendingInput : undefined;
  if (
    guardrailInput === undefined &&
    (state._currentTurn !== 1 || isResumingFromInterruption)
  ) {
    return;
  }

  const guardrailDefs = buildInputGuardrailDefinitions(state, runnerGuardrails);
  const guardrails = splitInputGuardrails(guardrailDefs);
  if (guardrails.blocking.length > 0) {
    await runInputGuardrails(state, guardrails.blocking, {
      input: guardrailInput,
    });
  }
  if (guardrails.parallel.length > 0) {
    const parallelGuardrailPromise = runInputGuardrails(
      state,
      guardrails.parallel,
      {
        input: guardrailInput,
        onErrorObserved: handlers.onParallelError,
      },
    ).catch(() => []);
    handlers.onParallelPromise?.(parallelGuardrailPromise);
  }
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
