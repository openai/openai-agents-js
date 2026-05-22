import type { Agent } from './agent';
import type { RunContext } from './runContext';
import type { MCPTool } from './mcp';
import type { UnknownContext } from './types';
import type { ToolOutputCustomDataExtractor } from './utils/customData';

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

/** Context information available to MCP tool custom data extractors. */
export interface MCPToolCustomDataContext<TContext = UnknownContext> {
  /** The current run context. */
  runContext: RunContext<TContext>;
  /** Name of the MCP server. */
  serverName: string;
  /** Original name of the tool on the MCP server. */
  toolName: string;
  /** Public function-tool name exposed through the Agents SDK. */
  toolDisplayName: string;
  /** Parsed tool arguments. */
  arguments: Record<string, unknown> | null;
  /** MCP tool result `_meta`, if present. */
  resultMeta?: Record<string, unknown>;
  /** MCP tool result `structuredContent`, if present. */
  structuredContent?: Record<string, unknown>;
  /** MCP tool result `isError`, if present. */
  isError?: boolean;
  /** The model-visible output produced from the MCP tool result. */
  toolOutput: unknown;
}

/** A function that produces SDK-only custom data for MCP tool output items. */
export type MCPToolCustomDataExtractor<TContext = UnknownContext> =
  ToolOutputCustomDataExtractor<MCPToolCustomDataContext<TContext>>;

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
