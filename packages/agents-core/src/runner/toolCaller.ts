import type { Agent } from '../agent';
import { ModelBehaviorError } from '../errors';
import type { ToolAllowedCaller } from '../tool';
import type * as protocol from '../types/protocol';
import { addErrorToCurrentSpan } from '../tracing/context';

export function ensureToolCallerAllowed(
  toolCall: protocol.ToolCallItem,
  allowedCallers: readonly ToolAllowedCaller[] | undefined,
  toolName: string,
  agent: Agent<any, any>,
): void {
  const caller: ToolAllowedCaller =
    'caller' in toolCall && toolCall.caller?.type === 'program'
      ? 'programmatic'
      : 'direct';
  const effectiveAllowedCallers = allowedCallers ?? ['direct'];
  if (effectiveAllowedCallers.includes(caller)) {
    return;
  }

  const message = `Model invoked tool ${toolName} with caller ${caller}, but the tool allows only ${JSON.stringify(effectiveAllowedCallers)}.`;
  addErrorToCurrentSpan({
    message,
    data: {
      agent_name: agent.name,
      tool_name: toolName,
      tool_call_id: 'callId' in toolCall ? toolCall.callId : undefined,
      tool_caller: caller,
    },
  });
  throw new ModelBehaviorError(message);
}
