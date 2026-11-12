import {
  HttpMCP,
  StdioMCP,
  isHostedRegistration,
  mcpToolNames,
  type McpTool,
} from './mcp';
import {
  createClientToolSearchTool,
  isClientToolSearchTool,
  toolIdentity,
  type Tool,
  type SessionTool,
} from './tools';
import { webSearch, type WebSearch } from './web-search';
import {
  captureHostedTool,
  getClientToolSearchExecutor,
  hostedToolSpecs,
  type HostedTool,
} from './hosted-tools';
import { NativeAgents } from './native-agents';
import { nativeGoalToolNames } from './goals';

export function splitToolDeclarations(tools: readonly Tool[]): {
  tools: SessionTool[];
  mcp: McpTool[];
  nativeAgents?: NativeAgents<any>;
  webSearch?: WebSearch;
  hostedTools: readonly HostedTool[];
  nativeGoals: boolean;
  checklist: boolean;
} {
  const functions: SessionTool[] = [];
  const mcp: McpTool[] = [];
  let nativeAgents: NativeAgents<any> | undefined;
  let search: WebSearch | undefined;
  const hostedTools: HostedTool[] = [];
  let nativeGoals = false;
  let checklist = false;
  for (const tool of tools) {
    if (tool instanceof StdioMCP || tool instanceof HttpMCP) mcp.push(tool);
    else if (tool instanceof NativeAgents) {
      if (nativeAgents) throw new TypeError('Declare NativeAgents only once');
      nativeAgents = tool;
    } else if ('kind' in tool && tool.kind === 'web_search') {
      if (search) throw new TypeError('Declare WebSearch only once');
      const { kind: _kind, ...options } = tool;
      search = webSearch(options);
    } else if (
      'kind' in tool &&
      (tool.kind === 'file_search' ||
        tool.kind === 'code_interpreter' ||
        tool.kind === 'image_generation' ||
        tool.kind === 'shell' ||
        tool.kind === 'tool_search')
    ) {
      if (hostedTools.some((prior) => prior.kind === tool.kind))
        throw new TypeError(`Declare ${tool.kind} only once`);
      const captured = captureHostedTool(tool);
      hostedTools.push(captured);
      if (captured.kind === 'tool_search' && captured.execution === 'client')
        functions.push(
          createClientToolSearchTool(
            hostedToolSpecs([captured])[0]!,
            getClientToolSearchExecutor(captured),
          ),
        );
    } else if ('kind' in tool && tool.kind === 'native_goals')
      nativeGoals = true;
    else if ('kind' in tool && tool.kind === 'checklist') {
      if (checklist) throw new TypeError('Declare Checklist only once');
      checklist = true;
    } else functions.push(tool);
  }
  if (
    mcp.some(
      (server) =>
        server instanceof HttpMCP && server.activation === 'operation',
    ) &&
    (nativeAgents || mcp.some(isHostedRegistration))
  )
    throw new TypeError(
      'Operation HTTP activation requires ordinary root/direct MCP',
    );
  if (
    search?.route === 'hosted' &&
    functions.some((tool) => {
      const identity = toolIdentity(tool);
      return (
        identity.namespace === 'functions' && identity.name === 'web_search'
      );
    })
  )
    throw new TypeError('Hosted WebSearch reserves the tool name web_search');
  if (
    nativeAgents &&
    functions.some((tool) => toolIdentity(tool).namespace === 'collaboration')
  )
    throw new TypeError(
      'NativeAgents reserves the collaboration namespace; use another namespace for custom functions',
    );
  if (
    checklist &&
    functions.some((tool) => {
      const identity = toolIdentity(tool);
      return (
        identity.namespace === 'functions' && identity.name === 'update_plan'
      );
    })
  )
    throw new TypeError('Checklist reserves the tool name update_plan');
  for (const hosted of hostedTools)
    if (
      functions.some((tool) => {
        if (isClientToolSearchTool(tool)) return false;
        const identity = toolIdentity(tool);
        return (
          identity.namespace === 'functions' && identity.name === hosted.kind
        );
      })
    )
      throw new TypeError(`Hosted tool reserves the tool name ${hosted.kind}`);
  if (
    nativeGoals &&
    functions.some((tool) => {
      const identity = toolIdentity(tool);
      return (
        identity.namespace === 'functions' &&
        (nativeGoalToolNames as readonly string[]).includes(identity.name)
      );
    })
  )
    throw new TypeError(
      'NativeGoals reserves create_goal, get_goal and update_goal',
    );
  mcpToolNames(mcp);
  return {
    tools: functions,
    mcp,
    nativeAgents,
    nativeGoals,
    checklist,
    webSearch: search,
    hostedTools: Object.freeze(hostedTools),
  };
}
