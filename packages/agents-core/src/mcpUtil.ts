import type { Agent } from './agent';
import type { RunContext } from './runContext';
import type { MCPTool } from './mcp';
import type { UnknownContext } from './types';

/** Context information available to tool filter functions. */
export interface ToolFilterContext<TContext = UnknownContext> {
  /** The current run context. */
  runContext: RunContext<TContext>;
  /** The agent requesting the tools. */
  agent: Agent<TContext, any>;
  /** Name of the MCP server providing the tools. */
  serverName: string;
}

/** A function that determines whether a tool should be available. */
export type ToolFilterCallable<TContext = UnknownContext> = (
  context: ToolFilterContext<TContext>,
  tool: MCPTool,
) => boolean | Promise<boolean>;

/** Static tool filter configuration using allow and block lists. */
export interface ToolFilterStatic {
  /** Optional list of tool names to allow. */
  allowedToolNames?: string[];
  /** Optional list of tool names to block. */
  blockedToolNames?: string[];
}

/** Convenience helper to create a static tool filter. */
export function createStaticToolFilter(
  allowedToolNames?: string[],
  blockedToolNames?: string[],
): ToolFilterStatic | undefined {
  if (!allowedToolNames && !blockedToolNames) {
    return undefined;
  }
  const filter: ToolFilterStatic = {};
  if (allowedToolNames) {
    filter.allowedToolNames = allowedToolNames;
  }
  if (blockedToolNames) {
    filter.blockedToolNames = blockedToolNames;
  }
  return filter;
}
