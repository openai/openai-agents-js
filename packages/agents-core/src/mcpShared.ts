import debug from 'debug';
import { z } from 'zod';
import { getLogger, type Logger } from './logger';
import type {
  CallToolResult,
  CallToolResultContent,
  CallToolResultMetadata,
  MCPListResourcesParams,
  MCPListResourcesResult,
  MCPListResourceTemplatesResult,
  MCPReadResourceResult,
  MCPServer,
  MCPServerSSEOptions,
  MCPServerStdioOptions,
  MCPServerStreamableHttpOptions,
  MCPToolErrorFunction,
} from './mcp';
import type {
  MCPToolCustomDataExtractor,
  MCPToolFilterCallable,
  MCPToolFilterStatic,
  MCPToolMetaResolver,
} from './mcpUtil';

export const DEFAULT_STDIO_MCP_CLIENT_LOGGER_NAME =
  'openai-agents:stdio-mcp-client';

export const DEFAULT_STREAMABLE_HTTP_MCP_CLIENT_LOGGER_NAME =
  'openai-agents:streamable-http-mcp-client';

export const DEFAULT_SSE_MCP_CLIENT_LOGGER_NAME =
  'openai-agents:sse-mcp-client';

export abstract class BaseMCPServerStdio implements MCPServer {
  public cacheToolsList: boolean;
  protected _cachedTools: any[] | undefined = undefined;
  public toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  public toolMetaResolver?: MCPToolMetaResolver;
  public customDataExtractor?: MCPToolCustomDataExtractor;
  public useStructuredContent?: boolean;
  public errorFunction?: MCPToolErrorFunction | null;

  protected logger: Logger;
  constructor(options: MCPServerStdioOptions) {
    this.logger =
      options.logger ?? getLogger(DEFAULT_STDIO_MCP_CLIENT_LOGGER_NAME);
    this.cacheToolsList = options.cacheToolsList ?? false;
    this.toolFilter = options.toolFilter;
    this.toolMetaResolver = options.toolMetaResolver;
    this.customDataExtractor = options.customDataExtractor;
    this.useStructuredContent = options.useStructuredContent;
    this.errorFunction = options.errorFunction;
  }

  abstract get name(): string;
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listTools(): Promise<any[]>;
  abstract callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
  ): Promise<CallToolResultContent>;
  abstract callToolResult(
    _toolName: string,
    _args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
  ): Promise<CallToolResult>;
  abstract listResources(
    _params?: MCPListResourcesParams,
  ): Promise<MCPListResourcesResult>;
  abstract listResourceTemplates(
    _params?: MCPListResourcesParams,
  ): Promise<MCPListResourceTemplatesResult>;
  abstract readResource(_uri: string): Promise<MCPReadResourceResult>;
  abstract invalidateToolsCache(): Promise<void>;

  /**
   * Logs a debug message when debug logging is enabled.
   * @param buildMessage A function that returns the message to log.
   */
  protected debugLog(buildMessage: () => string): void {
    if (!this.logger.dontLogToolData && debug.enabled(this.logger.namespace)) {
      // Only build the message when debug logging is enabled.
      this.logger.debug(buildMessage());
    }
  }
}

export abstract class BaseMCPServerStreamableHttp implements MCPServer {
  public cacheToolsList: boolean;
  protected _cachedTools: any[] | undefined = undefined;
  public toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  public toolMetaResolver?: MCPToolMetaResolver;
  public customDataExtractor?: MCPToolCustomDataExtractor;
  public useStructuredContent?: boolean;
  public errorFunction?: MCPToolErrorFunction | null;

  protected logger: Logger;
  constructor(options: MCPServerStreamableHttpOptions) {
    this.logger =
      options.logger ??
      getLogger(DEFAULT_STREAMABLE_HTTP_MCP_CLIENT_LOGGER_NAME);
    this.cacheToolsList = options.cacheToolsList ?? false;
    this.toolFilter = options.toolFilter;
    this.toolMetaResolver = options.toolMetaResolver;
    this.customDataExtractor = options.customDataExtractor;
    this.useStructuredContent = options.useStructuredContent;
    this.errorFunction = options.errorFunction;
  }

  abstract get name(): string;
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listTools(): Promise<any[]>;
  abstract callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
  ): Promise<CallToolResultContent>;
  abstract callToolResult(
    _toolName: string,
    _args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
  ): Promise<CallToolResult>;
  abstract listResources(
    _params?: MCPListResourcesParams,
  ): Promise<MCPListResourcesResult>;
  abstract listResourceTemplates(
    _params?: MCPListResourcesParams,
  ): Promise<MCPListResourceTemplatesResult>;
  abstract readResource(_uri: string): Promise<MCPReadResourceResult>;
  abstract get sessionId(): string | undefined;
  abstract invalidateToolsCache(): Promise<void>;

  /**
   * Logs a debug message when debug logging is enabled.
   * @param buildMessage A function that returns the message to log.
   */
  protected debugLog(buildMessage: () => string): void {
    if (!this.logger.dontLogToolData && debug.enabled(this.logger.namespace)) {
      // Only build the message when debug logging is enabled.
      this.logger.debug(buildMessage());
    }
  }
}

export abstract class BaseMCPServerSSE implements MCPServer {
  public cacheToolsList: boolean;
  protected _cachedTools: any[] | undefined = undefined;
  public toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  public toolMetaResolver?: MCPToolMetaResolver;
  public customDataExtractor?: MCPToolCustomDataExtractor;
  public useStructuredContent?: boolean;
  public errorFunction?: MCPToolErrorFunction | null;

  protected logger: Logger;
  constructor(options: MCPServerSSEOptions) {
    this.logger =
      options.logger ?? getLogger(DEFAULT_SSE_MCP_CLIENT_LOGGER_NAME);
    this.cacheToolsList = options.cacheToolsList ?? false;
    this.toolFilter = options.toolFilter;
    this.toolMetaResolver = options.toolMetaResolver;
    this.customDataExtractor = options.customDataExtractor;
    this.useStructuredContent = options.useStructuredContent;
    this.errorFunction = options.errorFunction;
  }

  abstract get name(): string;
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listTools(): Promise<any[]>;
  abstract callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
  ): Promise<CallToolResultContent>;
  abstract callToolResult(
    _toolName: string,
    _args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
  ): Promise<CallToolResult>;
  abstract listResources(
    _params?: MCPListResourcesParams,
  ): Promise<MCPListResourcesResult>;
  abstract listResourceTemplates(
    _params?: MCPListResourcesParams,
  ): Promise<MCPListResourceTemplatesResult>;
  abstract readResource(_uri: string): Promise<MCPReadResourceResult>;
  abstract invalidateToolsCache(): Promise<void>;

  /**
   * Logs a debug message when debug logging is enabled.
   * @param buildMessage A function that returns the message to log.
   */
  protected debugLog(buildMessage: () => string): void {
    if (!this.logger.dontLogToolData && debug.enabled(this.logger.namespace)) {
      // Only build the message when debug logging is enabled.
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

export function attachCallToolResultMetadata(
  content: CallToolResult['content'],
  metadata: CallToolResultMetadata,
): CallToolResultContent {
  const result = content as CallToolResultContent;
  for (const [key, value] of Object.entries(metadata) as Array<
    [keyof CallToolResultMetadata, unknown]
  >) {
    if (typeof value === 'undefined') {
      continue;
    }
    Object.defineProperty(result, key, {
      value,
      enumerable: false,
      configurable: true,
    });
  }
  return result;
}
