import {
  FunctionTool,
  HostedMCPTool,
  Tool,
  UserError,
} from '@openai/agents-core';
import { RealtimeToolDefinition } from './clientMessages';

export const BACKGROUND_RESULT_SYMBOL = Symbol('backgroundResult');

type BackgroundResult<T> = {
  [BACKGROUND_RESULT_SYMBOL]: true;
  content: T;
};

export function backgroundResult<T>(content: T): BackgroundResult<T> {
  return {
    [BACKGROUND_RESULT_SYMBOL]: true,
    content,
  };
}

export function isBackgroundResult<T>(
  result: unknown,
): result is BackgroundResult<T> {
  return (
    typeof result === 'object' &&
    result !== null &&
    BACKGROUND_RESULT_SYMBOL in result
  );
}

export type RealtimeTool = FunctionTool<any> | HostedMCPTool<any>;

export function isValidRealtimeTool(tool: Tool<any>): tool is RealtimeTool {
  return (
    tool.type === 'function' ||
    (tool.type === 'hosted_tool' && tool.name === 'hosted_mcp')
  );
}

export function toRealtimeToolDefinition(
  tool: RealtimeTool,
): RealtimeToolDefinition {
  if (tool.type === 'function') {
    return tool;
  }
  if (tool.type === 'hosted_tool' && tool.name === 'hosted_mcp') {
    const serverUrl =
      tool.providerData.server_url && tool.providerData.server_url.length > 0
        ? tool.providerData.server_url
        : undefined;
    return {
      type: 'mcp',
      server_label: tool.providerData.server_label,
      server_url: serverUrl,
      headers: tool.providerData.headers,
      allowed_tools: tool.providerData.allowed_tools,
      require_approval: tool.providerData.require_approval,
    };
  }

  throw new UserError(`Invalid tool type: ${tool}`);
}
