import {
  FunctionTool,
  Handoff,
  HostedMCPTool,
  Tool,
  UserError,
} from '@openai/agents-core';
import { normalizeHostedMcpRequireApproval } from '@openai/agents-core/utils';
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

export function validateRealtimeToolNames(
  tools: readonly FunctionTool<any>[],
  handoffs: readonly Handoff<any, any>[],
): void {
  const sourcesByName = new Map<string, string[]>();

  for (const tool of tools) {
    const sources = sourcesByName.get(tool.name) ?? [];
    sources.push('function tool');
    sourcesByName.set(tool.name, sources);
  }

  for (const handoff of handoffs) {
    const sources = sourcesByName.get(handoff.toolName) ?? [];
    sources.push('handoff');
    sourcesByName.set(handoff.toolName, sources);
  }

  const duplicateDescriptions = [...sourcesByName.entries()]
    .filter(([, sources]) => sources.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, sources]) => `'${name}' (${formatRealtimeToolSources(sources)})`,
    );

  if (duplicateDescriptions.length === 0) {
    return;
  }

  const label = duplicateDescriptions.length === 1 ? 'name' : 'names';
  throw new UserError(
    `Duplicate Realtime tool ${label} found: ${duplicateDescriptions.join(', ')}. ` +
      'Realtime function tool and handoff names must be unique. Rename one of them before starting the session.',
  );
}

function formatRealtimeToolSources(sources: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  const descriptions = [...counts.entries()].map(([source, count]) =>
    count === 1 ? source : `${count} ${source}s`,
  );
  if (descriptions.length === 1) {
    return descriptions[0]!;
  }
  if (descriptions.length === 2) {
    return `${descriptions[0]} and ${descriptions[1]}`;
  }
  return `${descriptions.slice(0, -1).join(', ')}, and ${descriptions.at(-1)}`;
}

export function toRealtimeToolDefinition(
  tool: RealtimeTool,
): RealtimeToolDefinition {
  if (tool.type === 'function') {
    if (tool.allowedCallers?.includes('programmatic')) {
      throw new UserError(
        `Realtime does not support function tool '${tool.name}' with allowedCallers including 'programmatic'. Programmatic Tool Calling is only supported with the Responses API.`,
      );
    }
    if (typeof tool.outputSchema !== 'undefined') {
      throw new UserError(
        `Realtime does not support function tool '${tool.name}' with outputSchema. Function tool outputSchema is only supported with the Responses API.`,
      );
    }
    return tool;
  }
  if (tool.type === 'hosted_tool' && tool.name === 'hosted_mcp') {
    if (tool.providerData.allowed_callers?.includes('programmatic')) {
      throw new UserError(
        `Realtime does not support hosted MCP tool '${tool.providerData.server_label}' with allowedCallers including 'programmatic'. Programmatic Tool Calling is only supported with the Responses API.`,
      );
    }
    const serverUrl =
      tool.providerData.server_url && tool.providerData.server_url.length > 0
        ? tool.providerData.server_url
        : undefined;
    const requireApproval =
      typeof tool.providerData.require_approval === 'undefined'
        ? undefined
        : normalizeHostedMcpRequireApproval(tool.providerData.require_approval);
    return {
      type: 'mcp',
      server_label: tool.providerData.server_label,
      server_url: serverUrl,
      headers: tool.providerData.headers,
      allowed_tools: tool.providerData.allowed_tools,
      ...(typeof requireApproval === 'undefined'
        ? {}
        : { require_approval: requireApproval }),
    };
  }

  throw new UserError(`Invalid tool type: ${tool}`);
}
