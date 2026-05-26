import type { ModelRequest, ModelResponse } from '../model';
import type {
  FunctionCallItem,
  FunctionCallResultItem,
  StreamEvent,
} from '../types/protocol';
import { Usage } from '../usage';

type PendingStreamedFunctionCall = Pick<
  FunctionCallItem,
  'callId' | 'name' | 'namespace'
>;

export type StreamAbortReconciliationState = {
  responseId?: string;
  pendingFunctionCalls: Map<string, PendingStreamedFunctionCall>;
};

export function createStreamAbortReconciliationState(): StreamAbortReconciliationState {
  return {
    pendingFunctionCalls: new Map(),
  };
}

export function recordStreamEventForAbortReconciliation(
  state: StreamAbortReconciliationState,
  event: StreamEvent,
): void {
  if (event.type === 'response_done') {
    state.pendingFunctionCalls.clear();
    state.responseId = event.response.id;
    return;
  }

  if (event.type !== 'model' || !isRecord(event.event)) {
    return;
  }

  const rawEvent = event.event;
  if (
    rawEvent.type === 'response.created' &&
    isRecord(rawEvent.response) &&
    typeof rawEvent.response.id === 'string'
  ) {
    state.responseId = rawEvent.response.id;
    return;
  }

  if (
    rawEvent.type !== 'response.output_item.done' ||
    !isRecord(rawEvent.item)
  ) {
    return;
  }

  const item = rawEvent.item;
  if (item.type === 'function_call' && typeof item.call_id === 'string') {
    state.pendingFunctionCalls.set(item.call_id, {
      callId: item.call_id,
      name: typeof item.name === 'string' ? item.name : item.call_id,
      ...(typeof item.namespace === 'string'
        ? { namespace: item.namespace }
        : {}),
    });
    return;
  }

  if (
    item.type === 'function_call_output' &&
    typeof item.call_id === 'string'
  ) {
    state.pendingFunctionCalls.delete(item.call_id);
  }
}

export function buildAbortReconciliationInput(
  state: StreamAbortReconciliationState,
): FunctionCallResultItem[] {
  return Array.from(state.pendingFunctionCalls.values(), (toolCall) => ({
    type: 'function_call_result',
    name: toolCall.name,
    ...(typeof toolCall.namespace === 'string'
      ? { namespace: toolCall.namespace }
      : {}),
    callId: toolCall.callId,
    status: 'incomplete',
    output: { type: 'text', text: 'aborted' },
  }));
}

export function getAbortReconciliationPreviousResponseId(
  state: StreamAbortReconciliationState,
  request: Pick<ModelRequest, 'conversationId' | 'previousResponseId'>,
): string | undefined {
  if (request.conversationId) {
    return request.previousResponseId;
  }
  return state.responseId ?? request.previousResponseId;
}

export function shouldReconcileStreamAbort(
  state: StreamAbortReconciliationState,
): boolean {
  return state.pendingFunctionCalls.size > 0;
}

export function markAbortReconciliationComplete(
  state: StreamAbortReconciliationState,
  response: ModelResponse | undefined,
): void {
  state.pendingFunctionCalls.clear();
  if (response?.responseId) {
    state.responseId = response.responseId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract the running cumulative usage carried on intermediate Responses API
 * stream events. The OpenAI Responses API emits `response.created` and
 * `response.in_progress` events whose `response.usage` is populated with the
 * running totals seen so far. When a streaming run is aborted before the
 * terminal `response.completed` event arrives, the SDK never gets a
 * `response_done`, so callers see `result.state.usage` stuck at zero (see
 * #995). Snapshotting these intermediate usages lets the run loop surface a
 * best-effort token count on abort.
 *
 * Returns `undefined` if the event does not carry usage data or all values
 * are zero (the very first `response.created` typically arrives with a
 * usage shell of zeros before any prompt tokens are accounted for).
 */
export function extractRunningUsageFromStreamEvent(
  event: StreamEvent,
): Usage | undefined {
  if (event.type !== 'model' || !isRecord(event.event)) {
    return undefined;
  }
  const rawEvent = event.event;
  const type = rawEvent.type;
  // Only intermediate events. Terminal events are already handled by the
  // `response_done` branch in the stream loop.
  if (type !== 'response.created' && type !== 'response.in_progress') {
    return undefined;
  }
  const response = rawEvent.response;
  if (!isRecord(response)) {
    return undefined;
  }
  const usage = response.usage;
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }
  const totalTokens =
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : inputTokens + outputTokens;
  return new Usage({
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens,
    inputTokensDetails: isRecord(usage.input_tokens_details)
      ? (usage.input_tokens_details as Record<string, number>)
      : undefined,
    outputTokensDetails: isRecord(usage.output_tokens_details)
      ? (usage.output_tokens_details as Record<string, number>)
      : undefined,
  });
}
