import type { Agent, AgentOutputType } from '../agent';
import type { RunState } from '../runState';
import type { RunConfig, Runner, ToolErrorFormatter } from '../run';
import type { SingleStepResult } from './steps';
import type { ProcessedResponse } from './types';
import { resolveInterruptedTurn } from './turnResolution';

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
  onStepItems?.(turnResult);
  state._toolUseTracker.addToolUse(agent, toolsUsed);
  state._originalInput = turnResult.originalInput;
  state._generatedItems = turnResult.generatedItems;
  if (
    resetTurnPersistence &&
    turnResult.nextStep.type === 'next_step_run_again'
  ) {
    state.resetTurnPersistence();
  }
  state._currentStep = turnResult.nextStep;
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
}): Promise<InterruptedTurnOutcome> {
  const {
    state,
    runner,
    toolErrorFormatter,
    agentToolParentRunConfig,
    signal,
    onStepItems,
  } = options;
  const approvedToolCallIds = new Set<string>();
  for (const item of state.getInterruptions()) {
    const rawItem = item.rawItem;
    if (rawItem.type === 'hosted_tool_call') {
      continue;
    }
    const toolName =
      item.toolName ??
      ('name' in rawItem && typeof rawItem.name === 'string'
        ? rawItem.name
        : undefined);
    const callId =
      'callId' in rawItem && typeof rawItem.callId === 'string'
        ? rawItem.callId
        : 'id' in rawItem && typeof rawItem.id === 'string'
          ? rawItem.id
          : undefined;
    if (
      toolName !== undefined &&
      callId !== undefined &&
      state._context.isToolApproved({ toolName, callId }) === true
    ) {
      approvedToolCallIds.add(callId);
    }
  }
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
  );
  const approvedToolResumed = turnResult.newStepItems.some((item) => {
    const rawItem = item.rawItem;
    if (!rawItem || !('callId' in rawItem)) {
      return false;
    }
    return (
      (rawItem.type === 'function_call_result' ||
        rawItem.type === 'computer_call_result' ||
        rawItem.type === 'shell_call_output' ||
        rawItem.type === 'apply_patch_call_output') &&
      approvedToolCallIds.has(rawItem.callId)
    );
  });

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
