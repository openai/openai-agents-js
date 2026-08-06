import type { RunToolApprovalItem } from './items';
import type { Agent } from './agent';
import type { RunContext } from './runContext';
import {
  getFunctionToolStateKey,
  getHostedMcpApprovalRequestIdentity,
  getHostedMcpApprovalStateKey,
} from './toolIdentity';
import type * as protocol from './types/protocol';

export type ApprovalCapableToolCall = RunToolApprovalItem['rawItem'];

export type LocalToolCall =
  | protocol.FunctionCallItem
  | protocol.ComputerUseCallItem
  | protocol.ShellCallItem
  | protocol.ApplyPatchCallItem;

export function getHostedMcpApprovalToolName(
  toolName: string,
  toolCall: ApprovalCapableToolCall,
): string {
  const identity = getHostedMcpApprovalRequestIdentity(toolCall);
  return identity
    ? (getHostedMcpApprovalStateKey(identity) ?? toolName)
    : toolName;
}

export function getToolInvocationCallId(
  toolCall: ApprovalCapableToolCall,
): string | undefined {
  const hostedMcpIdentity = getHostedMcpApprovalRequestIdentity(toolCall);
  if (hostedMcpIdentity?.requestId) {
    return hostedMcpIdentity.requestId;
  }
  if ('callId' in toolCall && typeof toolCall.callId === 'string') {
    return toolCall.callId;
  }
  if (typeof toolCall.id === 'string') {
    return toolCall.id;
  }
  const providerData = toolCall.providerData as
    { id?: unknown; itemId?: unknown } | undefined;
  if (typeof providerData?.id === 'string') {
    return providerData.id;
  }
  return typeof providerData?.itemId === 'string'
    ? providerData.itemId
    : undefined;
}

export function getToolInvocationFingerprint(
  toolName: string,
  toolCall: ApprovalCapableToolCall,
): string {
  return stableStringify({
    caller: getCanonicalToolCaller(toolCall),
    type: toolCall.type,
    toolName: canonicalizeToolName(toolName, toolCall),
    payload: getInvocationPayload(toolCall),
  });
}

export function getToolInvocationNameFromFingerprint(
  fingerprint: string,
): string | undefined {
  try {
    const value = JSON.parse(fingerprint) as { toolName?: unknown };
    return typeof value.toolName === 'string' ? value.toolName : undefined;
  } catch {
    return undefined;
  }
}

export function validateToolInvocationApproval(
  context: RunContext<any>,
  agent: Agent<any, any>,
  tool: { name: string },
  toolCall: ApprovalCapableToolCall,
): { callId: string; fingerprint: string } {
  const toolName = getCanonicalToolName(tool, toolCall);
  return context._validateToolInvocation(agent, toolName, toolCall);
}

export function validateToolInvocationName(
  context: RunContext<any>,
  agent: Agent<any, any>,
  toolName: string,
  toolCall: ApprovalCapableToolCall,
): { callId: string; fingerprint: string } {
  return context._validateToolInvocation(agent, toolName, toolCall);
}

export function getHandoffToolInvocationName(handoffName: string): string {
  return `handoff:${handoffName}`;
}

export function validateHandoffToolInvocation(
  context: RunContext<any>,
  agent: Agent<any, any>,
  handoffName: string,
  toolCall: protocol.FunctionCallItem,
): { callId: string; fingerprint: string } {
  return context._validateToolInvocation(
    agent,
    getHandoffToolInvocationName(handoffName),
    toolCall,
  );
}

export function getToolInvocationApproval(
  context: RunContext<any>,
  agent: Agent<any, any>,
  tool: { name: string },
  toolCall: ApprovalCapableToolCall,
): boolean | undefined {
  const toolName = getCanonicalToolName(tool, toolCall);
  const { callId } = context._validateToolInvocation(agent, toolName, toolCall);
  return context.isToolApproved({ toolName, callId, agent });
}

export function getToolInvocationRejectionMessage(
  context: RunContext<any>,
  agent: Agent<any, any>,
  tool: { name: string },
  toolCall: ApprovalCapableToolCall,
): string | undefined {
  const toolName = getCanonicalToolName(tool, toolCall);
  const { callId } = context._validateToolInvocation(agent, toolName, toolCall);
  return context._getFunctionRejectionMessage(toolName, callId, agent);
}

export function getBoundToolInvocationRejectionMessage(
  context: RunContext<any>,
  agent: Agent<any, any>,
  toolName: string,
  toolCall: ApprovalCapableToolCall,
): string | undefined {
  return context._getToolInvocationRejectionMessage(agent, toolName, toolCall);
}

function getCanonicalToolName(
  tool: { name: string },
  toolCall: ApprovalCapableToolCall,
): string {
  return toolCall.type === 'function_call'
    ? (getFunctionToolStateKey(tool) ?? tool.name)
    : tool.name;
}

function canonicalizeToolName(
  toolName: string,
  toolCall: ApprovalCapableToolCall,
): string {
  if (toolCall.type === 'hosted_tool_call') {
    return getHostedMcpApprovalToolName(toolName, toolCall);
  }
  if (
    toolCall.type === 'computer_call' &&
    (toolName === 'computer' || toolName === 'computer_use_preview')
  ) {
    return 'computer';
  }
  return toolName;
}

export function getCanonicalToolCaller(toolCall: unknown): protocol.ToolCaller {
  if (toolCall && typeof toolCall === 'object' && 'caller' in toolCall) {
    const caller = (toolCall as { caller?: protocol.ToolCaller }).caller;
    if (caller?.type === 'program') {
      return { type: 'program', callerId: caller.callerId };
    }
  }
  return { type: 'direct' };
}

function getInvocationPayload(toolCall: ApprovalCapableToolCall): unknown {
  switch (toolCall.type) {
    case 'function_call':
      return normalizeJsonString(toolCall.arguments);
    case 'hosted_tool_call': {
      const providerData = toolCall.providerData as
        | {
            arguments?: unknown;
            server_label?: unknown;
            serverLabel?: unknown;
          }
        | undefined;
      const args = toolCall.arguments ?? providerData?.arguments;
      const serverLabel =
        typeof providerData?.server_label === 'string'
          ? providerData.server_label
          : typeof providerData?.serverLabel === 'string'
            ? providerData.serverLabel
            : undefined;
      return {
        serverLabel,
        arguments: typeof args === 'string' ? normalizeJsonString(args) : args,
      };
    }
    case 'computer_call':
      return toolCall.actions ?? toolCall.action;
    case 'shell_call':
      return toolCall.action;
    case 'apply_patch_call':
      return toolCall.operation;
  }
}

function normalizeJsonString(value: string): unknown {
  try {
    return { format: 'json', value: JSON.parse(encodeJsonNumbers(value)) };
  } catch {
    return { format: 'raw', value };
  }
}

const JSON_TOKEN_PREFIX = '\u0000openai-agents-json:';

function encodeJsonNumbers(value: string): string {
  let encoded = '';
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === '"') {
      let end = index + 1;
      while (end < value.length) {
        if (value[end] === '\\') {
          end += 2;
          continue;
        }
        if (value[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      const token = value.slice(index, end);
      const decoded = JSON.parse(token) as string;
      encoded += decoded.startsWith(JSON_TOKEN_PREFIX)
        ? JSON.stringify(`${JSON_TOKEN_PREFIX}string:${decoded}`)
        : token;
      index = end;
      continue;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      const match = value
        .slice(index)
        .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) {
        throw new Error('Invalid JSON number.');
      }
      encoded += JSON.stringify(
        `${JSON_TOKEN_PREFIX}number:${canonicalizeJsonNumber(match[0])}`,
      );
      index += match[0].length;
      continue;
    }
    encoded += character;
    index += 1;
  }
  return encoded;
}

function canonicalizeJsonNumber(value: string): string {
  const lower = value.toLowerCase();
  const [mantissa, exponentText = '0'] = lower.split('e');
  const negative = mantissa.startsWith('-');
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa;
  const [integer, fraction = ''] = unsignedMantissa.split('.');
  let digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (digits.length === 0) {
    return negative ? '-0' : '0';
  }
  let exponent = BigInt(exponentText) - BigInt(fraction.length);
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1n;
  }
  return `${negative ? '-' : ''}${digits}e${exponent}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (
      !currentValue ||
      typeof currentValue !== 'object' ||
      Array.isArray(currentValue)
    ) {
      return currentValue;
    }
    return Object.fromEntries(
      Object.entries(currentValue as Record<string, unknown>).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      ),
    );
  });
}
