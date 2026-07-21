import { randomUUID } from '@openai/agents-core/_shims';

import type { ModelRequest, ModelResponse } from '../model';
import type {
  ApplyPatchCallResultItem,
  FunctionCallItem,
  FunctionCallResultItem,
  ProgramCallResultItem,
  ShellCallResultItem,
  StreamEvent,
  ToolCaller,
} from '../types/protocol';

type PendingStreamedFunctionCall = Pick<
  FunctionCallItem,
  'callId' | 'name' | 'namespace' | 'caller'
>;

type PendingStreamedToolCall = {
  callId: string;
  caller?: ToolCaller;
};

export type StreamAbortReconciliationState = {
  responseId?: string;
  pendingFunctionCalls: Map<string, PendingStreamedFunctionCall>;
  pendingShellCalls: Map<string, PendingStreamedToolCall>;
  pendingApplyPatchCalls: Map<string, PendingStreamedToolCall>;
  pendingProgramCalls: Map<string, string>;
};

export function createStreamAbortReconciliationState(): StreamAbortReconciliationState {
  return {
    pendingFunctionCalls: new Map(),
    pendingShellCalls: new Map(),
    pendingApplyPatchCalls: new Map(),
    pendingProgramCalls: new Map(),
  };
}

export function recordStreamEventForAbortReconciliation(
  state: StreamAbortReconciliationState,
  event: StreamEvent,
): void {
  if (event.type === 'response_done') {
    state.pendingFunctionCalls.clear();
    state.pendingShellCalls.clear();
    state.pendingApplyPatchCalls.clear();
    state.pendingProgramCalls.clear();
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
    rawEvent.type === 'response.output_item.added' &&
    isRecord(rawEvent.item) &&
    rawEvent.item.type === 'program_output' &&
    typeof rawEvent.item.call_id === 'string' &&
    typeof rawEvent.item.id === 'string'
  ) {
    state.pendingProgramCalls.set(rawEvent.item.call_id, rawEvent.item.id);
    return;
  }

  if (
    rawEvent.type !== 'response.output_item.done' ||
    !isRecord(rawEvent.item)
  ) {
    return;
  }

  const item = rawEvent.item;
  const caller = getToolCaller(item);
  if (item.type === 'program' && typeof item.call_id === 'string') {
    if (!state.pendingProgramCalls.has(item.call_id)) {
      state.pendingProgramCalls.set(item.call_id, generateProgramOutputId());
    }
    return;
  }

  if (item.type === 'program_output' && typeof item.call_id === 'string') {
    state.pendingProgramCalls.delete(item.call_id);
    return;
  }

  if (item.type === 'function_call' && typeof item.call_id === 'string') {
    state.pendingFunctionCalls.set(item.call_id, {
      callId: item.call_id,
      name: typeof item.name === 'string' ? item.name : item.call_id,
      ...(typeof item.namespace === 'string'
        ? { namespace: item.namespace }
        : {}),
      ...(caller ? { caller } : {}),
    });
    return;
  }

  if (
    item.type === 'shell_call' &&
    typeof item.call_id === 'string' &&
    isClientOwnedShellCall(item)
  ) {
    state.pendingShellCalls.set(item.call_id, {
      callId: item.call_id,
      ...(caller ? { caller } : {}),
    });
    return;
  }

  if (item.type === 'apply_patch_call' && typeof item.call_id === 'string') {
    state.pendingApplyPatchCalls.set(item.call_id, {
      callId: item.call_id,
      ...(caller ? { caller } : {}),
    });
    return;
  }

  if (
    item.type === 'function_call_output' &&
    typeof item.call_id === 'string'
  ) {
    state.pendingFunctionCalls.delete(item.call_id);
    return;
  }

  if (item.type === 'shell_call_output' && typeof item.call_id === 'string') {
    state.pendingShellCalls.delete(item.call_id);
    return;
  }

  if (
    item.type === 'apply_patch_call_output' &&
    typeof item.call_id === 'string'
  ) {
    state.pendingApplyPatchCalls.delete(item.call_id);
  }
}

export function buildAbortReconciliationInput(
  state: StreamAbortReconciliationState,
): (
  | FunctionCallResultItem
  | ShellCallResultItem
  | ApplyPatchCallResultItem
  | ProgramCallResultItem
)[] {
  const functionOutputs = Array.from(
    state.pendingFunctionCalls.values(),
    (toolCall): FunctionCallResultItem => ({
      type: 'function_call_result',
      name: toolCall.name,
      ...(typeof toolCall.namespace === 'string'
        ? { namespace: toolCall.namespace }
        : {}),
      callId: toolCall.callId,
      status: 'incomplete',
      output: { type: 'text', text: 'aborted' },
      ...(toolCall.caller ? { caller: toolCall.caller } : {}),
    }),
  );
  const shellOutputs = Array.from(
    state.pendingShellCalls.values(),
    (toolCall): ShellCallResultItem => ({
      type: 'shell_call_output',
      callId: toolCall.callId,
      status: 'incomplete',
      output: [
        {
          stdout: '',
          stderr: 'aborted',
          outcome: { type: 'timeout' },
        },
      ],
      ...(toolCall.caller ? { caller: toolCall.caller } : {}),
    }),
  );
  const applyPatchOutputs = Array.from(
    state.pendingApplyPatchCalls.values(),
    (toolCall): ApplyPatchCallResultItem => ({
      type: 'apply_patch_call_output',
      callId: toolCall.callId,
      status: 'failed',
      output: 'aborted',
      ...(toolCall.caller ? { caller: toolCall.caller } : {}),
    }),
  );
  const programOutputs = Array.from(
    state.pendingProgramCalls,
    ([callId, id]): ProgramCallResultItem => ({
      type: 'program_output',
      id,
      callId,
      status: 'incomplete',
      output: 'aborted',
    }),
  );

  return [
    ...functionOutputs,
    ...shellOutputs,
    ...applyPatchOutputs,
    ...programOutputs,
  ];
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
  return (
    state.pendingFunctionCalls.size > 0 ||
    state.pendingProgramCalls.size > 0 ||
    state.pendingShellCalls.size > 0 ||
    state.pendingApplyPatchCalls.size > 0
  );
}

export function markAbortReconciliationComplete(
  state: StreamAbortReconciliationState,
  response: ModelResponse | undefined,
): void {
  state.pendingFunctionCalls.clear();
  state.pendingShellCalls.clear();
  state.pendingApplyPatchCalls.clear();
  state.pendingProgramCalls.clear();
  if (response?.responseId) {
    state.responseId = response.responseId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getToolCaller(item: Record<string, unknown>): ToolCaller | undefined {
  if (!isRecord(item.caller)) {
    return undefined;
  }
  if (item.caller.type === 'direct') {
    return { type: 'direct' };
  }
  if (
    item.caller.type === 'program' &&
    typeof item.caller.caller_id === 'string'
  ) {
    return {
      type: 'program',
      callerId: item.caller.caller_id,
    };
  }
  return undefined;
}

function isClientOwnedShellCall(item: Record<string, unknown>): boolean {
  return !isRecord(item.environment) || item.environment.type === 'local';
}

function generateProgramOutputId(): string {
  return `prog_out_${randomUUID().replace(/-/g, '')}`;
}
