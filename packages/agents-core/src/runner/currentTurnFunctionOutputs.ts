import {
  RunToolCallItem,
  RunToolApprovalItem,
  RunToolCallOutputItem,
} from '../items';
import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationKey,
} from './toolResultCorrelation';
import type { AgentInputItem } from '../types';
import type { FunctionCallItem } from '../types/protocol';

import type { RunState } from '../runState';
import { matchesFunctionToolName } from '../toolIdentity';
import {
  getToolInvocationFingerprint,
  getToolInvocationNameFromFingerprint,
  getHandoffToolInvocationName,
  getCanonicalToolCaller,
} from '../toolInvocation';

type ResponseItem = { type: string; rawItem: AgentInputItem };

function responseRequestKey(item: ResponseItem): string | undefined {
  const request = getToolResultCorrelationForCall(item.rawItem);
  return request && item.type + ':' + getToolResultCorrelationKey(request);
}

export type CurrentFunctionRouting = {
  newItems: readonly ResponseItem[];
  functions: readonly { toolCall: FunctionCallItem }[];
  functionToolsNotFound?: readonly { toolCall: FunctionCallItem }[];
};

/** Returns committed function outputs from this response in model call order. @internal */
export function getCurrentTurnFunctionOutputs(
  state: RunState<any, any>,
  routing: CurrentFunctionRouting | undefined = state._lastProcessedResponse,
) {
  const outputs = new Map<string, RunToolCallOutputItem>();
  const currentOutputs = new Set<RunToolCallOutputItem>();
  if (!routing) return outputs;
  // Use the requests issued by this model response as the boundary. The runner can append
  // messages as well as tool outputs and approval decisions after those requests.
  const requests = new Set(routing.newItems.map(responseRequestKey));
  let boundaryFound = false;
  for (let i = state._generatedItems.length - 1; i >= 0; i--) {
    const item = state._generatedItems[i];
    if (!('agent' in item) || item.agent !== state._currentAgent) continue;
    if (
      item instanceof RunToolCallOutputItem &&
      item.rawItem.type === 'function_call_result'
    ) {
      currentOutputs.add(item);
    } else {
      const key = responseRequestKey(item);
      if (key !== undefined && requests.has(key)) {
        boundaryFound = true;
        break;
      }
    }
  }
  if (!boundaryFound || !currentOutputs.size) return outputs;
  const routedCalls = new Map(
    routing.functions.map(({ toolCall }) => [toolCall.callId, toolCall]),
  );
  const missing = new Set(
    routing.functionToolsNotFound?.map(({ toolCall }) => toolCall.callId),
  );
  const completed = state._completedToolInvocationEvidence.get(
    state._currentAgent,
  );
  // Generated call items preserve the original request order even when approvals finish in reverse.
  // Revalidate that order independently of the selected result stored in a Session checkpoint.
  for (const callItem of state._generatedItems) {
    if (
      !(callItem instanceof RunToolCallItem) ||
      callItem.agent !== state._currentAgent ||
      callItem.rawItem.type !== 'function_call'
    )
      continue;
    const call = callItem.rawItem;
    const routed = routedCalls.get(call.callId);
    const evidence = completed?.get(call.callId);
    const item = evidence?.items[1];
    const toolKey =
      evidence && getToolInvocationNameFromFingerprint(evidence.fingerprint);
    if (
      !toolKey ||
      !(item instanceof RunToolCallOutputItem) ||
      !currentOutputs.has(item) ||
      getToolInvocationFingerprint(toolKey, call) !== evidence.fingerprint
    )
      continue;
    // Missing-tool errors are emitted by a separate executor. An omitted or changed routed
    // call cannot make a later result authoritative in a restored checkpoint.
    if (
      !routed &&
      missing.has(call.callId) &&
      !item.executionStatus &&
      !(evidence.items[0] instanceof RunToolApprovalItem)
    )
      continue;
    if (
      !routed ||
      getToolInvocationFingerprint(toolKey, routed) !== evidence.fingerprint
    )
      return new Map<string, RunToolCallOutputItem>();
    outputs.set(call.callId, item);
  }
  // Require the model response to corroborate the generated order across a saved checkpoint.
  const modelOrder = new Set(
    (state._lastTurnResponse?.output ?? []).flatMap((call) =>
      call.type === 'function_call' && outputs.has(call.callId)
        ? [call.callId]
        : [],
    ),
  );
  const generatedOrder = [...outputs.keys()];
  if (
    modelOrder.size !== generatedOrder.length ||
    [...modelOrder].some((id, index) => generatedOrder[index] !== id)
  )
    outputs.clear();
  return outputs;
}

function hasPendingHandoff(state: RunState<any, any>): boolean {
  const processed = state._lastProcessedResponse;
  if (!processed) return false;
  return processed.handoffs.some(
    ({ toolCall, handoff }) =>
      !state._preflightToolInvocation(
        state._currentAgent,
        toolCall.callId,
        getToolInvocationFingerprint(
          getHandoffToolInvocationName(handoff.toolName),
          toolCall,
        ),
      ),
  );
}

// As in turn finalization, a program-owned result is excluded and an incomplete direct
// result keeps the whole batch from ending the run.
function finalizableCurrentOutputs(state: RunState<any, any>) {
  const outputs = getCurrentTurnFunctionOutputs(state);
  for (const [id, item] of outputs) {
    if (getCanonicalToolCaller(item.rawItem).type === 'program')
      outputs.delete(id);
    else if (
      item.rawItem.type === 'function_call_result' &&
      item.rawItem.status === 'incomplete'
    ) {
      outputs.clear();
      break;
    }
  }
  return outputs;
}

export function interruptedCallbackOutputs(
  state: RunState<any, any>,
): Set<RunToolCallOutputItem> {
  if (
    state._currentStep?.type !== 'next_step_interruption' ||
    typeof state._currentAgent.toolUseBehavior !== 'function' ||
    hasPendingHandoff(state)
  )
    return new Set();
  return new Set(finalizableCurrentOutputs(state).values());
}

export function completedToolMayStopResume(
  state: RunState<any, any>,
  names: readonly string[],
): boolean {
  const processed = state._lastProcessedResponse;
  if (!processed) return false;
  if (hasPendingHandoff(state)) return false;
  const outputs = finalizableCurrentOutputs(state);
  return processed.functions.some(
    ({ toolCall, tool }) =>
      outputs.has(toolCall.callId) &&
      names.some((name) => matchesFunctionToolName(tool, name)),
  );
}
