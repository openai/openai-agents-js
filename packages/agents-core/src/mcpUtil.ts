import type { Agent } from './agent';
import type { RunContext } from './runContext';
import type { MCPTool } from './mcp';
import type { UnknownContext } from './types';

/** Context information available to tool filter functions. */
export interface MCPToolFilterContext<TContext = UnknownContext> {
  /** The current run context. */
  runContext: RunContext<TContext>;
  /** The agent requesting the tools. */
  agent: Agent<TContext, any>;
  /** Name of the MCP server providing the tools. */
  serverName: string;
}

/** Context information available to MCP tool meta resolver functions. */
export interface MCPToolMetaContext<TContext = UnknownContext> {
  /** The current run context. */
  runContext: RunContext<TContext>;
  /** Name of the MCP server. */
  serverName: string;
  /** Name of the tool being invoked. */
  toolName: string;
  /** Parsed tool arguments. */
  arguments: Record<string, unknown> | null;
}

/** A function that produces MCP request metadata (`_meta`) for tool calls. */
export type MCPToolMetaResolver<TContext = UnknownContext> = (
  context: MCPToolMetaContext<TContext>,
) =>
  | Promise<Record<string, unknown> | null | undefined>
  | Record<string, unknown>
  | null
  | undefined;

/** A function that determines whether a tool should be available. */
export type MCPToolFilterCallable<TContext = UnknownContext> = (
  context: MCPToolFilterContext<TContext>,
  tool: MCPTool,
) => Promise<boolean>;

/** Static tool filter configuration using allow and block lists. */
export interface MCPToolFilterStatic {
  /** Optional list of tool names to allow. */
  allowedToolNames?: string[];
  /** Optional list of tool names to block. */
  blockedToolNames?: string[];
}

/** Convenience helper to create a static tool filter. */
export function createMCPToolStaticFilter(options?: {
  allowed?: string[];
  blocked?: string[];
}): MCPToolFilterStatic | undefined {
  if (!options?.allowed && !options?.blocked) {
    return undefined;
  }
  const filter: MCPToolFilterStatic = {};
  if (options?.allowed) {
    filter.allowedToolNames = options.allowed;
  }
  if (options?.blocked) {
    filter.blockedToolNames = options.blocked;
  }
  return filter;
}
