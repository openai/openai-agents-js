import { FunctionTool, tool, Tool } from './tool';
import { UserError } from './errors';
import {
  MCPServerStdio as UnderlyingMCPServerStdio,
  MCPServerStreamableHttp as UnderlyingMCPServerStreamableHttp,
} from '@openai/agents-core/_shims';
import { getCurrentSpan, withMCPListToolsSpan } from './tracing';
import { logger as globalLogger, getLogger, Logger } from './logger';
import debug from 'debug';
import { z } from '@openai/zod/v3';
import {
  JsonObjectSchema,
  JsonObjectSchemaNonStrict,
  JsonObjectSchemaStrict,
  UnknownContext,
} from './types';

export const DEFAULT_STDIO_MCP_CLIENT_LOGGER_NAME =
  'openai-agents:stdio-mcp-client';

export const DEFAULT_STREAMABLE_HTTP_MCP_CLIENT_LOGGER_NAME =
  'openai-agents:streamable-http-mcp-client';

/**
 * Interface for MCP server implementations.
 * Provides methods for connecting, listing tools, calling tools, and cleanup.
 */
export interface MCPServer {
  cacheToolsList: boolean;
  connect(): Promise<void>;
  readonly name: string;
  close(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent>;
}

export abstract class BaseMCPServerStdio implements MCPServer {
  public cacheToolsList: boolean;
  protected _cachedTools: any[] | undefined = undefined;

  protected logger: Logger;
  constructor(options: MCPServerStdioOptions) {
    this.logger =
      options.logger ?? getLogger(DEFAULT_STDIO_MCP_CLIENT_LOGGER_NAME);
    this.cacheToolsList = options.cacheToolsList ?? false;
  }

  abstract get name(): string;
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listTools(): Promise<any[]>;
  abstract callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent>;

  /**
   * Logs a debug message when debug logging is enabled.
   * @param buildMessage A function that returns the message to log.
   */
  protected debugLog(buildMessage: () => string): void {
    if (debug.enabled(this.logger.namespace)) {
      // only when this is true, the function to build the string is called
      this.logger.debug(buildMessage());
    }
  }
}

export abstract class BaseMCPServerStreamableHttp implements MCPServer {
  public cacheToolsList: boolean;
  protected _cachedTools: any[] | undefined = undefined;

  protected logger: Logger;
  constructor(options: MCPServerStreamableHttpOptions) {
    this.logger =
      options.logger ??
      getLogger(DEFAULT_STREAMABLE_HTTP_MCP_CLIENT_LOGGER_NAME);
    this.cacheToolsList = options.cacheToolsList ?? false;
  }

  abstract get name(): string;
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listTools(): Promise<any[]>;
  abstract callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent>;

  /**
   * Logs a debug message when debug logging is enabled.
   * @param buildMessage A function that returns the message to log.
   */
  protected debugLog(buildMessage: () => string): void {
    if (debug.enabled(this.logger.namespace)) {
      // only when this is true, the function to build the string is called
      this.logger.debug(buildMessage());
    }
  }
}

/**
 * Minimum MCP tool data definition.
 * This type definition does not intend to cover all possible properties.
 * It supports the properties that are used in this SDK.
 */
export const MCPTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.any()),
    required: z.array(z.string()),
    additionalProperties: z.boolean(),
  }),
});
export type MCPTool = z.infer<typeof MCPTool>;

/**
 * Public interface of an MCP server that provides tools.
 * You can use this class to pass MCP server settings to your agent.
 */
export class MCPServerStdio extends BaseMCPServerStdio {
  private underlying: UnderlyingMCPServerStdio;
  constructor(options: MCPServerStdioOptions) {
    super(options);
    this.underlying = new UnderlyingMCPServerStdio(options);
  }
  get name(): string {
    return this.underlying.name;
  }
  connect(): Promise<void> {
    return this.underlying.connect();
  }
  close(): Promise<void> {
    return this.underlying.close();
  }
  async listTools(): Promise<MCPTool[]> {
    if (this.cacheToolsList && this._cachedTools) {
      return this._cachedTools;
    }
    const tools = await this.underlying.listTools();
    if (this.cacheToolsList) {
      this._cachedTools = tools;
    }
    return tools;
  }
  callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    return this.underlying.callTool(toolName, args);
  }
}

export class MCPServerStreamableHttp extends BaseMCPServerStreamableHttp {
  private underlying: UnderlyingMCPServerStreamableHttp;
  constructor(options: MCPServerStreamableHttpOptions) {
    super(options);
    this.underlying = new UnderlyingMCPServerStreamableHttp(options);
  }
  get name(): string {
    return this.underlying.name;
  }
  connect(): Promise<void> {
    return this.underlying.connect();
  }
  close(): Promise<void> {
    return this.underlying.close();
  }
  async listTools(): Promise<MCPTool[]> {
    if (this.cacheToolsList && this._cachedTools) {
      return this._cachedTools;
    }
    const tools = await this.underlying.listTools();
    if (this.cacheToolsList) {
      this._cachedTools = tools;
    }
    return tools;
  }
  callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    return this.underlying.callTool(toolName, args);
  }
}

/**
 * Fetches and flattens all tools from multiple MCP servers.
 * Logs and skips any servers that fail to respond.
 */
export async function getAllMcpFunctionTools<TContext = UnknownContext>(
  mcpServers: MCPServer[],
  convertSchemasToStrict = false,
): Promise<Tool<TContext>[]> {
  const allTools: Tool<TContext>[] = [];
  const toolNames = new Set<string>();
  for (const server of mcpServers) {
    const serverTools = await getFunctionToolsFromServer(
      server,
      convertSchemasToStrict,
    );
    const serverToolNames = new Set(serverTools.map((t) => t.name));
    const intersection = [...serverToolNames].filter((n) => toolNames.has(n));
    if (intersection.length > 0) {
      throw new UserError(
        `Duplicate tool names found across MCP servers: ${intersection.join(', ')}`,
      );
    }
    for (const t of serverTools) {
      toolNames.add(t.name);
      allTools.push(t);
    }
  }
  return allTools;
}

const _cachedTools: Record<string, FunctionTool<any, any, unknown>[]> = {};
/**
 * Remove cached tools for the given server so the next lookup fetches fresh data.
 *
 * @param serverName - Name of the MCP server whose cache should be cleared.
 */
export function invalidateServerToolsCache(serverName: string) {
  delete _cachedTools[serverName];
}
/**
 * Fetches all function tools from a single MCP server.
 */
async function getFunctionToolsFromServer<TContext = UnknownContext>(
  server: MCPServer,
  convertSchemasToStrict: boolean,
): Promise<FunctionTool<TContext, any, unknown>[]> {
  if (server.cacheToolsList && _cachedTools[server.name]) {
    return _cachedTools[server.name];
  }
  return withMCPListToolsSpan(
    async (span) => {
      const mcpTools = await server.listTools();
      span.spanData.result = mcpTools.map((t) => t.name);
      const tools: FunctionTool<TContext, any, string>[] = mcpTools.map((t) =>
        mcpToFunctionTool(t, server, convertSchemasToStrict),
      );
      if (server.cacheToolsList) {
        _cachedTools[server.name] = tools;
      }
      return tools;
    },
    { data: { server: server.name } },
  );
}

/**
 * Returns all MCP tools from the provided servers, using the function tool conversion.
 */
export async function getAllMcpTools<TContext = UnknownContext>(
  mcpServers: MCPServer[],
  convertSchemasToStrict = false,
): Promise<Tool<TContext>[]> {
  return getAllMcpFunctionTools(mcpServers, convertSchemasToStrict);
}

/**
 * Converts an MCP tool definition to a function tool for the Agents SDK.
 */
export function mcpToFunctionTool(
  mcpTool: MCPTool,
  server: MCPServer,
  convertSchemasToStrict: boolean,
) {
  async function invoke(input: any, _context: UnknownContext) {
    let args = {};
    if (typeof input === 'string' && input) {
      args = JSON.parse(input);
    } else if (typeof input === 'object' && input != null) {
      args = input;
    }
    const currentSpan = getCurrentSpan();
    if (currentSpan) {
      currentSpan.spanData['mcp_data'] = { server: server.name };
    }
    const content = await server.callTool(mcpTool.name, args);
    return content.length === 1 ? content[0] : content;
  }

  const schema: JsonObjectSchema<any> = {
    type: mcpTool.inputSchema?.type ?? 'object',
    properties: mcpTool.inputSchema?.properties ?? {},
    required: mcpTool.inputSchema?.required ?? [],
    additionalProperties: mcpTool.inputSchema?.additionalProperties ?? false,
  };

  if (convertSchemasToStrict || schema.additionalProperties === true) {
    try {
      const strictSchema = ensureStrictJsonSchema(schema);
      return tool({
        name: mcpTool.name,
        description: mcpTool.description || '',
        parameters: strictSchema,
        strict: true,
        execute: invoke,
      });
    } catch (e) {
      globalLogger.warn(`Error converting MCP schema to strict mode: ${e}`);
    }
  }

  const nonStrictSchema: JsonObjectSchemaNonStrict<any> = {
    ...schema,
    additionalProperties: true,
  };
  return tool({
    name: mcpTool.name,
    description: mcpTool.description || '',
    parameters: nonStrictSchema,
    strict: false,
    execute: invoke,
  });
}

/**
 * Ensures the given JSON schema is strict (no additional properties, required fields set).
 */
function ensureStrictJsonSchema(
  schema: JsonObjectSchemaNonStrict<any> | JsonObjectSchemaStrict<any>,
): JsonObjectSchemaStrict<any> {
  const out: JsonObjectSchemaStrict<any> = {
    ...schema,
    additionalProperties: false,
  };
  if (!out.required) out.required = [];
  return out;
}

/**
 * Abstract base class for MCP servers that use a ClientSession for communication.
 * Handles session management, tool listing, tool calling, and cleanup.
 */

// Params for stdio-based MCP server
export interface BaseMCPServerStdioOptions {
  env?: Record<string, string>;
  cwd?: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  encoding?: string;
  encodingErrorHandler?: 'strict' | 'ignore' | 'replace';
  logger?: Logger;
}
export interface DefaultMCPServerStdioOptions
  extends BaseMCPServerStdioOptions {
  command: string;
  args?: string[];
}
export interface FullCommandMCPServerStdioOptions
  extends BaseMCPServerStdioOptions {
  fullCommand: string;
}
export type MCPServerStdioOptions =
  | DefaultMCPServerStdioOptions
  | FullCommandMCPServerStdioOptions;

export interface MCPServerStreamableHttpOptions {
  url: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  logger?: Logger;

  // ----------------------------------------------------
  // OAuth
  // import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
  authProvider?: any;
  // RequestInit
  requestInit?: any;
  // import { StreamableHTTPReconnectionOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
  reconnectionOptions?: any;
  sessionId?: string;
  // ----------------------------------------------------
}

/**
 * Represents a JSON-RPC request message.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Represents a JSON-RPC notification message (no response expected).
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Represents a JSON-RPC response message.
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: any;
}

export interface CallToolResponse extends JsonRpcResponse {
  result: {
    content: { type: string; text: string }[];
  };
}
export type CallToolResult = CallToolResponse['result'];
export type CallToolResultContent = CallToolResult['content'];

export interface InitializeResponse extends JsonRpcResponse {
  result: {
    protocolVersion: string;
    capabilities: {
      tools: Record<string, unknown>;
    };
    serverInfo: {
      name: string;
      version: string;
    };
  };
}
export type InitializeResult = InitializeResponse['result'];
