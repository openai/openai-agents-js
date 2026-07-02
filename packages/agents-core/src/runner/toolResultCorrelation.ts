import {
  getToolSearchExecution,
  getToolSearchMatchKey,
  getToolSearchProviderCallId,
} from '../tooling';
import type { AgentInputItem } from '../types';

const SIMPLE_TOOL_RESULT_TYPE_BY_CALL_TYPE = {
  function_call: 'function_call_result',
  computer_call: 'computer_call_result',
  shell_call: 'shell_call_output',
  apply_patch_call: 'apply_patch_call_output',
} as const;

type SimpleToolResultType =
  (typeof SIMPLE_TOOL_RESULT_TYPE_BY_CALL_TYPE)[keyof typeof SIMPLE_TOOL_RESULT_TYPE_BY_CALL_TYPE];

const SIMPLE_TOOL_RESULT_TYPES: ReadonlySet<string> = new Set(
  Object.values(SIMPLE_TOOL_RESULT_TYPE_BY_CALL_TYPE),
);

const TOOL_SEARCH_OUTPUT = 'tool_search_output';
const HOSTED_MCP_APPROVAL_REQUEST = 'mcp_approval_request';
const HOSTED_MCP_APPROVAL_RESPONSE = 'mcp_approval_response';

type ToolResultType =
  | SimpleToolResultType
  | typeof TOOL_SEARCH_OUTPUT
  | typeof HOSTED_MCP_APPROVAL_RESPONSE;

export type ToolResultCorrelation = Readonly<{
  resultType: ToolResultType;
  id: string;
}>;

export type ToolResultCorrelationsForResponse = Readonly<{
  calls: ToolResultCorrelation[];
  results: ToolResultCorrelation[];
}>;

function createCorrelation(
  resultType: ToolResultType,
  id: unknown,
): ToolResultCorrelation | undefined {
  return typeof id === 'string' ? { resultType, id } : undefined;
}

export function getSimpleToolResultTypeForCall(
  type: unknown,
): SimpleToolResultType | undefined {
  return typeof type === 'string'
    ? SIMPLE_TOOL_RESULT_TYPE_BY_CALL_TYPE[
        type as keyof typeof SIMPLE_TOOL_RESULT_TYPE_BY_CALL_TYPE
      ]
    : undefined;
}

export function isSimpleToolResultType(
  type: unknown,
): type is SimpleToolResultType {
  return typeof type === 'string' && SIMPLE_TOOL_RESULT_TYPES.has(type);
}

export function getToolResultCorrelationForCall(
  item: AgentInputItem,
): ToolResultCorrelation | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const type = (item as { type?: unknown }).type;
  if (type === 'tool_search_call') {
    if (getToolSearchExecution(item) === 'server') {
      return undefined;
    }
    return createCorrelation(TOOL_SEARCH_OUTPUT, getToolSearchMatchKey(item));
  }

  const callId = (item as { callId?: unknown }).callId;
  const resultType = getSimpleToolResultTypeForCall(type);
  if (resultType) {
    return createCorrelation(resultType, callId);
  }

  if (type !== 'hosted_tool_call') {
    return undefined;
  }

  const hostedItem = item as {
    id?: unknown;
    name?: unknown;
    providerData?: unknown;
  };
  const providerData = hostedItem.providerData;
  if (!providerData || typeof providerData !== 'object') {
    return undefined;
  }
  const approvalRequest = providerData as { id?: unknown; type?: unknown };
  if (
    hostedItem.name !== HOSTED_MCP_APPROVAL_REQUEST &&
    approvalRequest.type !== HOSTED_MCP_APPROVAL_REQUEST
  ) {
    return undefined;
  }

  return createCorrelation(
    HOSTED_MCP_APPROVAL_RESPONSE,
    approvalRequest.id ?? hostedItem.id,
  );
}

export function getToolResultCorrelationForResult(
  item: AgentInputItem,
): ToolResultCorrelation | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const type = (item as { type?: unknown }).type;
  if (type === TOOL_SEARCH_OUTPUT) {
    if (getToolSearchExecution(item) === 'server') {
      return undefined;
    }
    return createCorrelation(
      TOOL_SEARCH_OUTPUT,
      getToolSearchProviderCallId(item),
    );
  }

  const callId = (item as { callId?: unknown }).callId;
  if (isSimpleToolResultType(type)) {
    return createCorrelation(type, callId);
  }

  if (type !== 'hosted_tool_call') {
    return undefined;
  }

  const hostedItem = item as { name?: unknown; providerData?: unknown };
  if (hostedItem.name !== HOSTED_MCP_APPROVAL_RESPONSE) {
    return undefined;
  }
  const providerData = hostedItem.providerData;
  if (!providerData || typeof providerData !== 'object') {
    return undefined;
  }

  return createCorrelation(
    HOSTED_MCP_APPROVAL_RESPONSE,
    (providerData as { approval_request_id?: unknown }).approval_request_id,
  );
}

export function getToolResultCorrelationKey(
  correlation: ToolResultCorrelation,
): string {
  return JSON.stringify([correlation.resultType, correlation.id]);
}

function removePendingCorrelation(
  pending: ToolResultCorrelation[],
  correlation: ToolResultCorrelation,
): void {
  const key = getToolResultCorrelationKey(correlation);
  const index = pending.findIndex(
    (candidate) => getToolResultCorrelationKey(candidate) === key,
  );
  if (index >= 0) {
    pending.splice(index, 1);
  }
}

export function getToolResultCorrelationsForResponse(
  items: readonly AgentInputItem[],
): ToolResultCorrelationsForResponse {
  const calls: ToolResultCorrelation[] = [];
  const results: ToolResultCorrelation[] = [];
  const pendingToolSearchCalls: ToolResultCorrelation[] = [];

  for (const item of items) {
    const call = getToolResultCorrelationForCall(item);
    if (call) {
      calls.push(call);
      if ((item as { type?: unknown }).type === 'tool_search_call') {
        pendingToolSearchCalls.push(call);
      }
    }

    if ((item as { type?: unknown }).type === TOOL_SEARCH_OUTPUT) {
      const providerCallId = getToolSearchProviderCallId(item);
      const result = providerCallId
        ? createCorrelation(TOOL_SEARCH_OUTPUT, providerCallId)
        : getToolSearchExecution(item) === 'server'
          ? undefined
          : pendingToolSearchCalls.shift();
      if (result) {
        results.push(result);
        if (providerCallId) {
          removePendingCorrelation(pendingToolSearchCalls, result);
        }
      }
      continue;
    }

    const result = getToolResultCorrelationForResult(item);
    if (result) {
      results.push(result);
    }
  }

  return { calls, results };
}
