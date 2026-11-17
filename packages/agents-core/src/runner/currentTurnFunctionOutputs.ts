import { RunToolCallOutputItem, type RunItem } from '../items';

import type { Agent } from '../agent';
import type { RunResult } from '../result';
import type { RunState } from '../runState';
import type { FunctionToolResult } from '../tool';
import type { ProcessedResponse, ToolRunFunction } from './types';
import { getServerConversationOwner } from './conversation';
import {
  getToolInvocationFingerprint,
  getToolInvocationNameFromFingerprint,
} from '../toolInvocation';

function retainedFunctionOutputs(
  state: RunState<any, any>,
  runs: ToolRunFunction<any>[],
) {
  const outputs = new Map<string, RunToolCallOutputItem>();
  const completed = state._completedToolInvocationEvidence.get(
    state._currentAgent,
  );
  let generated: Set<RunItem> | undefined;
  const pendingNamedStop =
    typeof state._currentAgent.toolUseBehavior === 'object' &&
    state._pendingInput.length > 0;
  for (const { toolCall } of runs) {
    const pair = completed?.get(toolCall.callId);
    const output = pair?.items[1];
    const receipt = pair?.retainedAfterFailure;
    if (!receipt || !(output instanceof RunToolCallOutputItem)) continue;
    const accepted = 'acceptedResponseTurn' in receipt;
    const ownerTurn = accepted
      ? receipt.acceptedResponseTurn
      : receipt.approvalTurn;
    if (
      ownerTurn !== state._currentTurn ||
      (accepted &&
        !getServerConversationOwner(
          state._conversationId,
          state._previousResponseId,
        )) ||
      (pendingNamedStop && !(accepted && receipt.beforePendingInput))
    )
      continue;
    generated ??= new Set(state._generatedItems);
    if (!generated.has(output)) continue;
    const key = getToolInvocationNameFromFingerprint(pair.fingerprint);
    if (key && getToolInvocationFingerprint(key, toolCall) === pair.fingerprint)
      outputs.set(toolCall.callId, output);
  }
  return outputs;
}

// Only a live custom selector can inspect child runs, while this response is still active.
const childRuns = new WeakMap<
  ProcessedResponse<any>,
  WeakMap<RunToolCallOutputItem, RunResult<any, Agent<any, any>>>
>();

export function rememberChildRunForSelector(
  state: RunState<any, any>,
  item: RunToolCallOutputItem,
  child: RunResult<any, Agent<any, any>>,
) {
  const response = state._lastProcessedResponse;
  if (!response || typeof state._currentAgent.toolUseBehavior !== 'function')
    return;
  const entries = childRuns.get(response) ?? new WeakMap();
  entries.set(item, child);
  childRuns.set(response, entries);
}

export function releaseChildRunsForSelector(state: RunState<any, any>) {
  if (state._lastProcessedResponse)
    childRuns.delete(state._lastProcessedResponse);
}

/** Supplies accepted results to the selector without re-emitting or re-appending them. */
export function getToolResultsForFinalization<TContext>(
  state: RunState<TContext, Agent<TContext, any>>,
  runs: ToolRunFunction<TContext>[],
  executed: ToolRunFunction<TContext>[],
  results: FunctionToolResult<TContext>[],
): FunctionToolResult<TContext>[] {
  const behavior = state._currentAgent.toolUseBehavior;
  if (executed.length === runs.length || behavior === 'run_llm_again')
    return results;
  const completed = retainedFunctionOutputs(state, runs);
  if (!completed.size) return results;
  const children =
    state._lastProcessedResponse && childRuns.get(state._lastProcessedResponse);
  const fresh = new Map(
    executed.map((run, index) => [run.toolCall.callId, results[index]]),
  );
  const ordered = new Map<string, FunctionToolResult<TContext>>();
  for (const { toolCall, tool } of runs) {
    const { callId } = toolCall;
    const result = fresh.get(callId);
    const prior = completed.get(callId);
    if (result) {
      ordered.set(callId, result);
    } else if (prior) {
      ordered.set(callId, {
        type: 'function_output',
        tool,
        output: prior.output,
        runItem: prior,
        agentRunResult: children?.get(prior),
      });
    }
  }
  return [
    ...ordered.values(),
    ...results.filter((result) => result.type === 'hosted_mcp_tool_approval'),
  ];
}
