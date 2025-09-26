import type { MCPTool, CallToolResultContent } from './mcp';
import {
  BaseMCPServerStdio,
  BaseMCPServerStreamableHttp,
  BaseMCPServerSSE,
  invalidateServerToolsCache,
} from './mcp';
import {
  MCPConnectionError,
  MCPToolError,
  MCPRetryManager,
  MCPRetryConfig,
  createErrorContext,
} from './errors';
// Define default timeout constant (30 seconds)
const DEFAULT_REQUEST_TIMEOUT_MSEC = 30000;
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * Enhanced MCP server options that include retry configuration.
 */
export interface EnhancedMCPServerStdioOptions {
  retryConfig?: Partial<MCPRetryConfig>;
  // Base options
  command?: string;
  fullCommand?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  encoding?: string;
  encodingErrorHandler?: 'strict' | 'ignore' | 'replace';
  timeout?: number;
  toolFilter?: any;
  logger?: any;
}

export interface EnhancedMCPServerStreamableHttpOptions {
  retryConfig?: Partial<MCPRetryConfig>;
  // Base options
  url: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  timeout?: number;
  toolFilter?: any;
  logger?: any;
  authProvider?: any;
  requestInit?: any;
  fetch?: any;
  reconnectionOptions?: any;
  sessionId?: string;
}

export interface EnhancedMCPServerSSEOptions {
  retryConfig?: Partial<MCPRetryConfig>;
  // Base options
  url: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  timeout?: number;
  toolFilter?: any;
  logger?: any;
  authProvider?: any;
  requestInit?: any;
  eventSourceInit?: any;
}

/**
 * Enhanced MCP Stdio server with improved error handling and retry logic.
 */
export class EnhancedMCPServerStdio extends BaseMCPServerStdio {
  protected session: Client | null = null;
  protected _cacheDirty = true;
  protected _toolsList: any[] = [];
  protected clientSessionTimeoutSeconds?: number;
  protected timeout: number;
  protected retryManager: MCPRetryManager;

  params: any;
  private _name: string;
  private transport: any = null;

  constructor(params: EnhancedMCPServerStdioOptions) {
    super(params as any);
    this.clientSessionTimeoutSeconds = params.clientSessionTimeoutSeconds ?? 5;
    this.timeout = params.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    this.retryManager = new MCPRetryManager(params.retryConfig);

    if (params.fullCommand) {
      const elements = params.fullCommand.split(' ');
      const command = elements.shift();
      if (!command) {
        throw new Error('Invalid fullCommand: ' + params.fullCommand);
      }
      this.params = {
        ...params,
        command: command,
        args: elements,
        encoding: params.encoding || 'utf-8',
        encodingErrorHandler: params.encodingErrorHandler || 'strict',
      };
    } else {
      this.params = params;
    }
    this._name = params.name || `stdio: ${this.params.command}`;
  }

  get name(): string {
    return this._name;
  }

  async connect(): Promise<void> {
    const connectionDetails = {
      command: this.params.command,
      args: this.params.args,
      env: this.params.env,
      cwd: this.params.cwd,
      encoding: this.params.encoding,
      encodingErrorHandler: this.params.encodingErrorHandler,
    };

    return this.retryManager.executeWithRetry(
      async () => {
        try {
          const { StdioClientTransport } = await import(
            '@modelcontextprotocol/sdk/client/stdio.js'
          );
          const { Client } = await import(
            '@modelcontextprotocol/sdk/client/index.js'
          );

          this.transport = new StdioClientTransport({
            command: this.params.command,
            args: this.params.args,
            env: this.params.env,
            cwd: this.params.cwd,
          });

          this.session = new Client({
            name: this._name,
            version: '1.0.0',
          });

          await this.session.connect(this.transport);

          this.debugLog(() => `Connected to MCP server: ${this._name}`);
        } catch (error) {
          this.logger.error('Error initializing MCP server:', error);
          await this.close();

          throw new MCPConnectionError(
            `Failed to connect to MCP stdio server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            'stdio',
            connectionDetails,
            error instanceof Error ? error : new Error(String(error)),
            undefined,
            createErrorContext('mcp_stdio_connection'),
          );
        }
      },
      'mcp_stdio_connection',
      {
        serverName: this._name,
        errorContext: createErrorContext('mcp_stdio_connection'),
      },
    );
  }

  async invalidateToolsCache(): Promise<void> {
    await invalidateServerToolsCache(this.name);
    this._cacheDirty = true;
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.session) {
      throw new MCPConnectionError(
        'Server not initialized. Make sure you call connect() first.',
        this._name,
        'stdio',
        { command: this.params.command },
        undefined,
        undefined,
        createErrorContext('mcp_list_tools_check'),
      );
    }

    if (this.cacheToolsList && !this._cacheDirty && this._toolsList) {
      return this._toolsList;
    }

    return this.retryManager.executeWithRetry(
      async () => {
        const { ListToolsResultSchema } = await import(
          '@modelcontextprotocol/sdk/types.js'
        );

        try {
          const response = await this.session!.listTools();
          this.debugLog(() => `Listed tools: ${JSON.stringify(response)}`);
          this._toolsList = ListToolsResultSchema.parse(response).tools;
          this._cacheDirty = false;
          return this._toolsList;
        } catch (error) {
          throw new MCPToolError(
            `Failed to list tools from MCP server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            'all',
            'list',
            error instanceof Error ? error : new Error(String(error)),
            undefined,
            undefined,
            undefined,
            createErrorContext('mcp_list_tools'),
          );
        }
      },
      'mcp_list_tools',
      {
        serverName: this._name,
        toolName: 'all',
        errorContext: createErrorContext('mcp_list_tools'),
      },
    );
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    if (!this.session) {
      throw new MCPConnectionError(
        'Server not initialized. Make sure you call connect() first.',
        this._name,
        'stdio',
        { command: this.params.command },
        undefined,
        undefined,
        createErrorContext('mcp_call_tool_check'),
      );
    }

    return this.retryManager.executeWithRetry(
      async () => {
        const { CallToolResultSchema } = await import(
          '@modelcontextprotocol/sdk/types.js'
        );

        try {
          const response = await this.session!.callTool(
            {
              name: toolName,
              arguments: args ?? {},
            },
            undefined,
            {
              timeout: this.timeout,
            },
          );

          const parsed = CallToolResultSchema.parse(response);
          const result = parsed.content;

          this.debugLog(
            () =>
              `Called tool ${toolName} (args: ${JSON.stringify(args)}, result: ${JSON.stringify(result)})`,
          );

          return result as CallToolResultContent;
        } catch (error) {
          throw new MCPToolError(
            `Failed to call tool "${toolName}" on MCP server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            toolName,
            'call',
            error instanceof Error ? error : new Error(String(error)),
            args || undefined,
            undefined,
            undefined,
            createErrorContext('mcp_call_tool'),
          );
        }
      },
      'mcp_call_tool',
      {
        serverName: this._name,
        toolName,
        errorContext: createErrorContext('mcp_call_tool'),
      },
    );
  }

  async close(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        this.logger.warn('Error closing transport:', error);
      }
      this.transport = null;
    }
    if (this.session) {
      try {
        await this.session.close();
      } catch (error) {
        this.logger.warn('Error closing session:', error);
      }
      this.session = null;
    }
  }
}

/**
 * Enhanced MCP SSE server with improved error handling and retry logic.
 */
export class EnhancedMCPServerSSE extends BaseMCPServerSSE {
  protected session: Client | null = null;
  protected _cacheDirty = true;
  protected _toolsList: any[] = [];
  protected clientSessionTimeoutSeconds?: number;
  protected timeout: number;
  protected retryManager: MCPRetryManager;

  params: EnhancedMCPServerSSEOptions;
  private _name: string;
  private transport: any = null;

  constructor(params: EnhancedMCPServerSSEOptions) {
    super(params as any);
    this.clientSessionTimeoutSeconds = params.clientSessionTimeoutSeconds ?? 5;
    this.params = params;
    this._name = params.name || `sse: ${this.params.url}`;
    this.timeout = params.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    this.retryManager = new MCPRetryManager(params.retryConfig);
  }

  get name(): string {
    return this._name;
  }

  async connect(): Promise<void> {
    const connectionDetails = {
      url: this.params.url,
      authProvider: !!this.params.authProvider,
      requestInit: this.params.requestInit,
      eventSourceInit: this.params.eventSourceInit,
    };

    return this.retryManager.executeWithRetry(
      async () => {
        try {
          const { SSEClientTransport } = await import(
            '@modelcontextprotocol/sdk/client/sse.js'
          );
          const { Client } = await import(
            '@modelcontextprotocol/sdk/client/index.js'
          );

          this.transport = new SSEClientTransport(new URL(this.params.url), {
            authProvider: this.params.authProvider,
            requestInit: this.params.requestInit,
            eventSourceInit: this.params.eventSourceInit,
          });

          this.session = new Client({
            name: this._name,
            version: '1.0.0',
          });

          await this.session.connect(this.transport);

          this.debugLog(() => `Connected to MCP server: ${this._name}`);
        } catch (error) {
          this.logger.error('Error initializing MCP server:', error);
          await this.close();

          throw new MCPConnectionError(
            `Failed to connect to MCP SSE server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            'sse',
            connectionDetails,
            error instanceof Error ? error : new Error(String(error)),
            undefined,
            createErrorContext('mcp_sse_connection'),
          );
        }
      },
      'mcp_sse_connection',
      {
        serverName: this._name,
        errorContext: createErrorContext('mcp_sse_connection'),
      },
    );
  }

  async invalidateToolsCache(): Promise<void> {
    await invalidateServerToolsCache(this.name);
    this._cacheDirty = true;
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.session) {
      throw new MCPConnectionError(
        'Server not initialized. Make sure you call connect() first.',
        this._name,
        'sse',
        { url: this.params.url },
        undefined,
        undefined,
        createErrorContext('mcp_list_tools_check'),
      );
    }

    if (this.cacheToolsList && !this._cacheDirty && this._toolsList) {
      return this._toolsList;
    }

    return this.retryManager.executeWithRetry(
      async () => {
        const { ListToolsResultSchema } = await import(
          '@modelcontextprotocol/sdk/types.js'
        );

        try {
          const response = await this.session!.listTools();
          this.debugLog(() => `Listed tools: ${JSON.stringify(response)}`);
          this._toolsList = ListToolsResultSchema.parse(response).tools;
          this._cacheDirty = false;
          return this._toolsList;
        } catch (error) {
          throw new MCPToolError(
            `Failed to list tools from MCP server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            'all',
            'list',
            error instanceof Error ? error : new Error(String(error)),
            undefined,
            undefined,
            undefined,
            createErrorContext('mcp_list_tools'),
          );
        }
      },
      'mcp_list_tools',
      {
        serverName: this._name,
        toolName: 'all',
        errorContext: createErrorContext('mcp_list_tools'),
      },
    );
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    if (!this.session) {
      throw new MCPConnectionError(
        'Server not initialized. Make sure you call connect() first.',
        this._name,
        'sse',
        { url: this.params.url },
        undefined,
        undefined,
        createErrorContext('mcp_call_tool_check'),
      );
    }

    return this.retryManager.executeWithRetry(
      async () => {
        const { CallToolResultSchema } = await import(
          '@modelcontextprotocol/sdk/types.js'
        );

        try {
          const response = await this.session!.callTool(
            {
              name: toolName,
              arguments: args ?? {},
            },
            undefined,
            {
              timeout: this.timeout,
            },
          );

          const parsed = CallToolResultSchema.parse(response);
          const result = parsed.content;

          this.debugLog(
            () =>
              `Called tool ${toolName} (args: ${JSON.stringify(args)}, result: ${JSON.stringify(result)})`,
          );

          return result as CallToolResultContent;
        } catch (error) {
          throw new MCPToolError(
            `Failed to call tool "${toolName}" on MCP server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            toolName,
            'call',
            error instanceof Error ? error : new Error(String(error)),
            args || undefined,
            undefined,
            undefined,
            createErrorContext('mcp_call_tool'),
          );
        }
      },
      'mcp_call_tool',
      {
        serverName: this._name,
        toolName,
        errorContext: createErrorContext('mcp_call_tool'),
      },
    );
  }

  async close(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        this.logger.warn('Error closing transport:', error);
      }
      this.transport = null;
    }
    if (this.session) {
      try {
        await this.session.close();
      } catch (error) {
        this.logger.warn('Error closing session:', error);
      }
      this.session = null;
    }
  }
}

/**
 * Enhanced MCP Streamable HTTP server with improved error handling and retry logic.
 */
export class EnhancedMCPServerStreamableHttp extends BaseMCPServerStreamableHttp {
  protected session: Client | null = null;
  protected _cacheDirty = true;
  protected _toolsList: any[] = [];
  protected clientSessionTimeoutSeconds?: number;
  protected timeout: number;
  protected retryManager: MCPRetryManager;

  params: EnhancedMCPServerStreamableHttpOptions;
  private _name: string;
  private transport: any = null;

  constructor(params: EnhancedMCPServerStreamableHttpOptions) {
    super(params as any);
    this.clientSessionTimeoutSeconds = params.clientSessionTimeoutSeconds ?? 5;
    this.params = params;
    this._name = params.name || `streamable-http: ${this.params.url}`;
    this.timeout = params.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    this.retryManager = new MCPRetryManager(params.retryConfig);
  }

  get name(): string {
    return this._name;
  }

  async connect(): Promise<void> {
    const connectionDetails = {
      url: this.params.url,
      authProvider: !!this.params.authProvider,
      requestInit: this.params.requestInit,
      fetch: !!this.params.fetch,
      reconnectionOptions: this.params.reconnectionOptions,
      sessionId: this.params.sessionId,
    };

    return this.retryManager.executeWithRetry(
      async () => {
        try {
          const { StreamableHTTPClientTransport } = await import(
            '@modelcontextprotocol/sdk/client/streamableHttp.js'
          );
          const { Client } = await import(
            '@modelcontextprotocol/sdk/client/index.js'
          );

          this.transport = new StreamableHTTPClientTransport(
            new URL(this.params.url),
            {
              authProvider: this.params.authProvider,
              requestInit: this.params.requestInit,
              fetch: this.params.fetch,
              reconnectionOptions: this.params.reconnectionOptions,
              sessionId: this.params.sessionId,
            },
          );

          this.session = new Client({
            name: this._name,
            version: '1.0.0',
          });

          await this.session.connect(this.transport);

          this.debugLog(() => `Connected to MCP server: ${this._name}`);
        } catch (error) {
          this.logger.error('Error initializing MCP server:', error);
          await this.close();

          throw new MCPConnectionError(
            `Failed to connect to MCP streamable HTTP server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            'streamable-http',
            connectionDetails,
            error instanceof Error ? error : new Error(String(error)),
            undefined,
            createErrorContext('mcp_streamable_http_connection'),
          );
        }
      },
      'mcp_streamable_http_connection',
      {
        serverName: this._name,
        errorContext: createErrorContext('mcp_streamable_http_connection'),
      },
    );
  }

  async invalidateToolsCache(): Promise<void> {
    await invalidateServerToolsCache(this.name);
    this._cacheDirty = true;
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.session) {
      throw new MCPConnectionError(
        'Server not initialized. Make sure you call connect() first.',
        this._name,
        'streamable-http',
        { url: this.params.url },
        undefined,
        undefined,
        createErrorContext('mcp_list_tools_check'),
      );
    }

    if (this.cacheToolsList && !this._cacheDirty && this._toolsList) {
      return this._toolsList;
    }

    return this.retryManager.executeWithRetry(
      async () => {
        const { ListToolsResultSchema } = await import(
          '@modelcontextprotocol/sdk/types.js'
        );

        try {
          const response = await this.session!.listTools();
          this.debugLog(() => `Listed tools: ${JSON.stringify(response)}`);
          this._toolsList = ListToolsResultSchema.parse(response).tools;
          this._cacheDirty = false;
          return this._toolsList;
        } catch (error) {
          throw new MCPToolError(
            `Failed to list tools from MCP server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            'all',
            'list',
            error instanceof Error ? error : new Error(String(error)),
            undefined,
            undefined,
            undefined,
            createErrorContext('mcp_list_tools'),
          );
        }
      },
      'mcp_list_tools',
      {
        serverName: this._name,
        toolName: 'all',
        errorContext: createErrorContext('mcp_list_tools'),
      },
    );
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    if (!this.session) {
      throw new MCPConnectionError(
        'Server not initialized. Make sure you call connect() first.',
        this._name,
        'streamable-http',
        { url: this.params.url },
        undefined,
        undefined,
        createErrorContext('mcp_call_tool_check'),
      );
    }

    return this.retryManager.executeWithRetry(
      async () => {
        const { CallToolResultSchema } = await import(
          '@modelcontextprotocol/sdk/types.js'
        );

        try {
          const response = await this.session!.callTool(
            {
              name: toolName,
              arguments: args ?? {},
            },
            undefined,
            {
              timeout: this.timeout,
            },
          );

          const parsed = CallToolResultSchema.parse(response);
          const result = parsed.content;

          this.debugLog(
            () =>
              `Called tool ${toolName} (args: ${JSON.stringify(args)}, result: ${JSON.stringify(result)})`,
          );

          return result as CallToolResultContent;
        } catch (error) {
          throw new MCPToolError(
            `Failed to call tool "${toolName}" on MCP server: ${error instanceof Error ? error.message : String(error)}`,
            this._name,
            toolName,
            'call',
            error instanceof Error ? error : new Error(String(error)),
            args || undefined,
            undefined,
            undefined,
            createErrorContext('mcp_call_tool'),
          );
        }
      },
      'mcp_call_tool',
      {
        serverName: this._name,
        toolName,
        errorContext: createErrorContext('mcp_call_tool'),
      },
    );
  }

  async close(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        this.logger.warn('Error closing transport:', error);
      }
      this.transport = null;
    }
    if (this.session) {
      try {
        await this.session.close();
      } catch (error) {
        this.logger.warn('Error closing session:', error);
      }
      this.session = null;
    }
  }
}
