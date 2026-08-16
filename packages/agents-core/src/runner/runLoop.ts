import type { Agent, AgentOutputType } from '../agent';
import { UserError } from '../errors';
import type { RunState } from '../runState';
import type { RunConfig, Runner, ToolErrorFormatter } from '../run';
import { getFunctionToolStateKeyForCall } from '../toolIdentity';
import type { SingleStepResult } from './steps';
import type { ProcessedResponse } from './types';
import { getServerConversationOwner } from './conversation';
import {
  preflightToolInvocations,
  resolveInterruptedTurn,
  resolveTurnAfterModelResponse,
} from './turnResolution';

export function isAcceptedResponseCheckpoint(
  state: RunState<any, any>,
): boolean {
  const isCheckpoint =
    state._currentStep?.type === 'next_step_interruption' &&
    state._currentStep.data?.responseAccepted === true;
  if (isCheckpoint) {
    assertAcceptedResponseServerOwnership(state);
  }
  return isCheckpoint;
}

function assertAcceptedResponseServerOwnership(
  state: RunState<any, any>,
): void {
  if (
    getServerConversationOwner(state._conversationId, state._previousResponseId)
  ) {
    return;
  }
  throw new UserError(
    'Accepted model response state requires exactly one server-managed conversation owner',
    state,
  );
}

export function assertAcceptedResponseContinuationAuthority(
  state: RunState<any, any>,
  requestedConversationId?: string,
  requestedPreviousResponseId?: string,
): void {
  const currentStep = state._currentStep;
  const responseAccepted =
    (currentStep?.type === 'next_step_interruption' &&
      currentStep.data?.responseAccepted === true) ||
    (currentStep?.type === 'next_step_final_output' &&
      currentStep.responseAccepted === true);
  if (!responseAccepted) {
    return;
  }
  assertAcceptedResponseServerOwnership(state);
  if (
    (requestedConversationId !== undefined &&
      requestedConversationId !== state._conversationId) ||
    (requestedPreviousResponseId !== undefined &&
      requestedPreviousResponseId !== state._previousResponseId)
  ) {
    throw new UserError(
      'Accepted model response state cannot change its server-managed conversation owner',
      state,
    );
  }
}

export function markAcceptedResponseProcessingStarted(
  state: RunState<any, any>,
): void {
  const currentStep = state._currentStep;
  if (
    currentStep?.type === 'next_step_interruption' &&
    currentStep.data?.responseAccepted === true
  ) {
    assertAcceptedResponseServerOwnership(state);
    currentStep.data.localProcessingStarted = true;
  }
}

export function markAcceptedResponseFinalizationStarted(
  state: RunState<any, any>,
): void {
  const currentStep = state._currentStep;
  if (
    currentStep?.type !== 'next_step_final_output' ||
    currentStep.responseAccepted !== true
  ) {
    return;
  }
  assertAcceptedResponseServerOwnership(state);
  if (currentStep.localFinalizationStarted === true) {
    throw new UserError(
      'An accepted model response has unfinished local finalization and cannot be resumed safely; start a new run instead',
      state,
    );
  }
  currentStep.localFinalizationStarted = true;
}

function hasUncommittedLocalEffects(
  processedResponse: ProcessedResponse<any>,
  suppressedToolCalls: ReadonlySet<unknown>,
): boolean {
  return [
    ...processedResponse.functions.map((run) => run.toolCall),
    ...processedResponse.computerActions.map((run) => run.toolCall),
    ...processedResponse.shellActions.map((run) => run.toolCall),
    ...processedResponse.applyPatchActions.map((run) => run.toolCall),
    ...processedResponse.handoffs.map((run) => run.toolCall),
  ].some((toolCall) => !suppressedToolCalls.has(toolCall));
}

/**
 * Continues local processing for a response that was already accepted by the model provider.
 */
export async function resumeAcceptedModelResponse<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(options: {
  state: RunState<TContext, TAgent>;
  runner: Runner;
  toolErrorFormatter?: ToolErrorFormatter;
  agentToolParentRunConfig?: Partial<RunConfig>;
  signal?: AbortSignal;
  onStepItems?: (turnResult: SingleStepResult) => void;
  validateHandoffAgent?: (agent: Agent<any, any>) => void;
}): Promise<SingleStepResult> {
  const { state } = options;
  if (!state._lastTurnResponse || !state._lastProcessedResponse) {
    throw new UserError(
      'An accepted model response could not be processed; start a new run instead of retrying it',
      state,
    );
  }

  const suppressedToolCalls = preflightToolInvocations(
    state._currentAgent,
    state,
    state._lastProcessedResponse,
  );
  if (
    state._currentStep?.type === 'next_step_interruption' &&
    state._currentStep.data?.localProcessingStarted === true &&
    hasUncommittedLocalEffects(
      state._lastProcessedResponse,
      suppressedToolCalls,
    )
  ) {
    throw new UserError(
      'An accepted model response has unfinished local tool work and cannot be resumed safely; start a new run instead',
      state,
    );
  }
  markAcceptedResponseProcessingStarted(state);
  const turnResult = await resolveTurnAfterModelResponse(
    state._currentAgent,
    state._originalInput,
    state._generatedItems,
    state._lastTurnResponse,
    state._lastProcessedResponse,
    options.runner,
    state,
    options.toolErrorFormatter,
    options.agentToolParentRunConfig,
    undefined,
    options.signal,
    suppressedToolCalls,
    undefined,
    options.validateHandoffAgent,
  );
  applyTurnResult({
    state,
    turnResult,
    agent: state._currentAgent,
    toolsUsed: state._lastProcessedResponse.toolsUsed,
    resetTurnPersistence: false,
    onStepItems: options.onStepItems,
  });
  return turnResult;
}

export type InterruptedTurnOutcome = {
  nextStep: SingleStepResult['nextStep'];
  action: 'return_interruption' | 'rerun_turn' | 'advance_step';
  approvedToolResumed: boolean;
};

export type InterruptedTurnControl = {
  shouldReturn: boolean;
  shouldContinue: boolean;
};

type ApplyTurnResultOptions<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
> = {
  state: RunState<TContext, TAgent>;
  turnResult: SingleStepResult;
  agent: Agent<TContext, AgentOutputType>;
  toolsUsed: string[];
  resetTurnPersistence: boolean;
  onStepItems?: (turnResult: SingleStepResult) => void;
};

export function applyTurnResult<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(options: ApplyTurnResultOptions<TContext, TAgent>): void {
  const {
    state,
    turnResult,
    agent,
    toolsUsed,
    resetTurnPersistence,
    onStepItems,
  } = options;
  const responseAccepted = isAcceptedResponseCheckpoint(state);
  onStepItems?.(turnResult);
  state._commitToolInvocations(turnResult.toolInvocationCommitItems);
  state._toolUseTracker.addToolUse(agent, toolsUsed);
  state._originalInput = turnResult.originalInput;
  state._replaceGeneratedItems(turnResult.generatedItems);
  if (
    resetTurnPersistence &&
    turnResult.nextStep.type === 'next_step_run_again'
  ) {
    state.resetTurnPersistence();
  }
  state._currentStep =
    responseAccepted && turnResult.nextStep.type === 'next_step_final_output'
      ? { ...turnResult.nextStep, responseAccepted: true }
      : turnResult.nextStep;
  state._finalOutputSource =
    turnResult.nextStep.type === 'next_step_final_output'
      ? (turnResult.finalOutputSource ?? 'turn_resolution')
      : undefined;
}

export async function resumeInterruptedTurn<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(options: {
  state: RunState<TContext, TAgent>;
  runner: Runner;
  toolErrorFormatter?: ToolErrorFormatter;
  agentToolParentRunConfig?: Partial<RunConfig>;
  signal?: AbortSignal;
  onStepItems?: (turnResult: SingleStepResult) => void;
  validateHandoffAgent?: (agent: Agent<any, any>) => void;
}): Promise<InterruptedTurnOutcome> {
  const {
    state,
    runner,
    toolErrorFormatter,
    agentToolParentRunConfig,
    signal,
    onStepItems,
    validateHandoffAgent,
  } = options;
  const approvedToolWillResume = state.getInterruptions().some((item) => {
    const rawItem = item.rawItem;
    if (rawItem.type === 'hosted_tool_call') {
      return false;
    }
    const toolName =
      rawItem.type === 'function_call'
        ? (item.functionToolStateKey ??
          getFunctionToolStateKeyForCall(rawItem, item.name))
        : item.name;
    const callId =
      'callId' in rawItem && typeof rawItem.callId === 'string'
        ? rawItem.callId
        : 'id' in rawItem && typeof rawItem.id === 'string'
          ? rawItem.id
          : undefined;
    return (
      toolName !== undefined &&
      callId !== undefined &&
      state._context._resolveToolInvocationApproval(
        item.agent,
        toolName,
        rawItem,
      ) === true
    );
  });
  const turnResult = await resolveInterruptedTurn<TContext>(
    state._currentAgent,
    state._originalInput,
    state._generatedItems,
    state._lastTurnResponse!,
    state._lastProcessedResponse as ProcessedResponse<unknown>,
    runner,
    state,
    toolErrorFormatter,
    agentToolParentRunConfig,
    signal,
    validateHandoffAgent,
  );
  const approvedToolResumed =
    approvedToolWillResume &&
    turnResult.generatedItems.length > state._currentTurnPersistedItemCount;

  applyTurnResult({
    state,
    turnResult,
    agent: state._currentAgent,
    toolsUsed: state._lastProcessedResponse?.toolsUsed ?? [],
    resetTurnPersistence: false,
    onStepItems,
  });

  // Map next-step outcomes to interruption flow control for the outer run loop.
  // return_interruption: still waiting on approvals. rerun_turn: same turn rerun without increment.
  // advance_step: proceed without rerunning the same turn.
  if (turnResult.nextStep.type === 'next_step_interruption') {
    return {
      nextStep: turnResult.nextStep,
      action: 'return_interruption',
      approvedToolResumed,
    };
  }
  if (turnResult.nextStep.type === 'next_step_run_again') {
    return {
      nextStep: turnResult.nextStep,
      action: 'rerun_turn',
      approvedToolResumed,
    };
  }
  return {
    nextStep: turnResult.nextStep,
    action: 'advance_step',
    approvedToolResumed,
  };
}

export function handleInterruptedOutcome<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
>(options: {
  state: RunState<TContext, TAgent>;
  outcome: InterruptedTurnOutcome;
  setContinuingInterruptedTurn: (value: boolean) => void;
}): InterruptedTurnControl {
  const { state, outcome, setContinuingInterruptedTurn } = options;

  switch (outcome.action) {
    case 'return_interruption':
      state._currentStep = outcome.nextStep;
      return { shouldReturn: true, shouldContinue: false };
    case 'rerun_turn':
      // Clear the step so the outer loop treats this as a new run-again without incrementing the turn.
      setContinuingInterruptedTurn(true);
      state._currentStep = undefined;
      return { shouldReturn: false, shouldContinue: true };
    case 'advance_step':
      setContinuingInterruptedTurn(false);
      state._currentStep = outcome.nextStep;
      return { shouldReturn: false, shouldContinue: false };
    default: {
      const _exhaustive: never = outcome.action;
      throw new Error(`Unhandled interruption outcome: ${_exhaustive}`);
    }
  }
}
