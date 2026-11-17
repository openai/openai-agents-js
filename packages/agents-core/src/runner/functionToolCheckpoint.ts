import {
  checkpointFailedFunctionToolAppend,
  type ResumedSessionWritePreparation,
} from './sessionPersistence';
import {
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '../items';
import type { RunState } from '../runState';

/** Holds the current attempt's function results until the whole turn commits. */
export class FunctionToolCheckpoint {
  sessionPreparation?: ResumedSessionWritePreparation;
  private readonly calls = new Map<
    string,
    { item: RunToolCallOutputItem; isRedacted?: () => boolean } | undefined
  >();

  start(callId: string): void {
    this.calls.set(callId, undefined);
  }

  accept(
    callId: string,
    item: RunToolCallOutputItem,
    isRedacted?: () => boolean,
  ): void {
    this.calls.set(callId, { item, isRedacted });
  }

  suspend(callId: string): void {
    this.calls.delete(callId);
  }

  clear(): void {
    this.calls.clear();
    this.sessionPreparation = undefined;
  }

  preserveAfterFailure(state: RunState<any, any>, mayPublish: boolean): void {
    if (!this.calls.size) return;
    const processed = state._lastProcessedResponse;
    if (!processed) return;
    const originalLength = state._generatedItems.length;
    const agent = state._currentAgent;
    const sourceCalls = new Set<RunToolCallItem>();
    const requiredPrograms = new Set<string>();
    const outputs: RunToolCallOutputItem[] = [];
    // Walk the owning response in model order, irrespective of worker completion order.
    for (const item of processed.newItems) {
      if (
        !(item instanceof RunToolCallItem) ||
        item.agent !== agent ||
        item.rawItem.type !== 'function_call'
      )
        continue;
      const { callId, caller } = item.rawItem;
      const result = this.calls.get(callId);
      if (!result || !mayPublish || result.isRedacted?.()) continue;
      state._commitToolInvocations([item, result.item]);
      const evidence = state._completedToolInvocationEvidence
        .get(agent)
        ?.get(callId);
      if (!evidence || evidence.items[1] !== result.item) continue;
      // Approval and accepted-response retries can finalize this retained output.
      if (
        state._currentStep?.type === 'next_step_interruption' &&
        agent.toolUseBehavior !== 'run_llm_again'
      ) {
        evidence.retainedAfterFailure =
          state._currentStep.data.responseAccepted === true
            ? {
                acceptedResponseTurn: state._currentTurn,
                ...(state._pendingInput.length
                  ? { beforePendingInput: true as const }
                  : {}),
              }
            : { approvalTurn: state._currentTurn };
      }
      sourceCalls.add(item);
      if (caller?.type === 'program') requiredPrograms.add(caller.callerId);
      outputs.push(result.item);
      this.calls.delete(callId);
    }
    // Project the accepted calls and their prerequisites in model order.
    const historyCalls = new Set<string>();
    for (const item of state._generatedItems) {
      if (item instanceof RunToolCallItem && item.agent === agent) {
        historyCalls.add(item.rawItem.type + ':' + item.callId);
      }
    }
    let pendingReasoning: RunReasoningItem[] = [];
    let sawToolCall = false;
    for (const item of processed.newItems) {
      if (item instanceof RunReasoningItem && item.agent === agent) {
        // New reasoning after a call starts the next group of model tool calls.
        if (sawToolCall) pendingReasoning = [];
        sawToolCall = false;
        pendingReasoning.push(item);
        continue;
      }
      // Only adjacent local functions and their programs can share a reasoning preamble.
      if (
        !(item instanceof RunToolCallItem) ||
        item.agent !== agent ||
        (item.rawItem.type !== 'function_call' &&
          item.rawItem.type !== 'program')
      ) {
        pendingReasoning = [];
        continue;
      }
      sawToolCall = true;
      if (
        sourceCalls.has(item) ||
        (item.rawItem.type === 'program' &&
          requiredPrograms.has(item.rawItem.callId))
      ) {
        const key = item.rawItem.type + ':' + item.callId;
        if (!historyCalls.has(key)) {
          state._generatedItems.push(...pendingReasoning, item);
          historyCalls.add(key);
        }
        // Previously published calls already carry their reasoning, including after restore.
        pendingReasoning = [];
      }
    }
    state._generatedItems.push(...outputs);
    if (
      state._currentStep?.type === 'next_step_interruption' &&
      state._currentStep.data.responseAccepted === true
    ) {
      if (outputs.length) {
        const published = new Set(state._generatedItems.slice(originalLength));
        let insertionIndex = originalLength;
        const insertionIndexes: number[] = [];
        processed.newItems = processed.newItems.filter((item) => {
          if (published.has(item)) {
            insertionIndex++;
            return false;
          }
          insertionIndexes.push(insertionIndex);
          return true;
        });
        if (insertionIndexes.length)
          processed.newItemInsertionIndexes = insertionIndexes;
      }
    } else {
      for (const callId of this.calls.keys()) {
        state._markToolInvocationUnsafe(agent, callId);
      }
    }
    if (
      this.sessionPreparation &&
      state._generatedItems.length > originalLength
    ) {
      try {
        checkpointFailedFunctionToolAppend(this.sessionPreparation);
      } catch {
        // A nonportable session binding must stay fail-closed. Surface the original tool failure.
      }
    }
    this.clear();
  }
}
