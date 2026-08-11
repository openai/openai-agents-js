import { FunctionTool, tool, Tool, type ToolCallDetails } from './tool';
import { UserError } from './errors';
import {
  MCPServerStdio as UnderlyingMCPServerStdio,
  MCPServerStreamableHttp as UnderlyingMCPServerStreamableHttp,
  MCPServerSSE as UnderlyingMCPServerSSE,
} from '@openai/agents-core/_shims';
import {
  getCurrentSpan,
  getCurrentTrace,
  withMCPListToolsSpan,
  type MCPListToolsSpanData,
  type Span,
} from './tracing';
import {
  logger as globalLogger,
  logToolActionWarning,
  type Logger,
} from './logger';
import {
  JsonObjectSchema,
  JsonObjectSchemaNonStrict,
  JsonObjectSchemaStrict,
  UnknownContext,
} from './types';
import type {
  MCPToolCustomDataContext,
  MCPToolCustomDataExtractor,
  MCPToolFilterCallable,
  MCPToolFilterStatic,
  MCPToolMetaContext,
  MCPToolMetaResolver,
} from './mcpUtil';
import { getMcpServerExternalName } from './mcpLogging';
import type { RunContext } from './runContext';
import type { Agent } from './agent';
import { maybeExtractToolOutputCustomData } from './utils/customData';
import {
  BaseMCPServerSSE,
  BaseMCPServerStdio,
  BaseMCPServerStreamableHttp,
  MCPTool,
} from './mcpShared';
import {
  beginServerToolsCacheListing,
  cachedMcpToolKeysByServer as _cachedToolKeysByServer,
  cachedMcpTools as _cachedTools,
} from './mcpToolCache';
import { getToolCallParentSpanFromDetails } from './agentToolRunConfig';
import {
  assertOpenAIStrictToolSchemaPreservesOpenObjects,
  isJsonSchemaDepthError,
} from './utils/strictToolSchema';

export {
  BaseMCPServerSSE,
  BaseMCPServerStdio,
  BaseMCPServerStreamableHttp,
  DEFAULT_SSE_MCP_CLIENT_LOGGER_NAME,
  DEFAULT_STDIO_MCP_CLIENT_LOGGER_NAME,
  DEFAULT_STREAMABLE_HTTP_MCP_CLIENT_LOGGER_NAME,
  MCPTool,
  attachCallToolResultMetadata,
} from './mcpShared';
export { invalidateServerToolsCache } from './mcpToolCache';

export type MCPToolErrorFunction = (args: {
  context: RunContext;
  error: Error | unknown;
}) => Promise<string> | string;

export interface MCPCallToolOptions {
  signal?: AbortSignal;
}

const MCP_FUNCTION_TOOL_NAME_MAX_LENGTH = 64;
const MCP_FUNCTION_TOOL_HASH_LENGTH = 8;

type PrefixedToolNameCandidate = {
  batchKey: string;
  baseName: string;
  seed: string;
  initialName: string;
  serverIndex: number;
  toolIndex: number;
};

class MCPToolsLifecycleGuard {
  private generation = 0;
  private activeOperations = 0;

  private startLifecycleBranch(
    operation: (() => Promise<void>) | undefined,
  ): Promise<void> {
    try {
      return operation?.() ?? Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private beginLifecycleOperation(): void {
    this.activeOperations += 1;
    this.generation += 1;
  }

  private endLifecycleOperation(): void {
    this.activeOperations -= 1;
  }

  async runLifecycleOperation(
    invalidate: () => Promise<void>,
    operation?: () => Promise<void>,
  ): Promise<void> {
    this.beginLifecycleOperation();
    try {
      const [invalidationResult, operationResult] = await Promise.allSettled([
        this.startLifecycleBranch(invalidate),
        this.startLifecycleBranch(operation),
      ]);
      if (invalidationResult.status === 'rejected') {
        throw invalidationResult.reason;
      }
      if (operationResult.status === 'rejected') {
        throw operationResult.reason;
      }
    } finally {
      this.endLifecycleOperation();
    }
  }

  invalidate(): void {
    this.generation += 1;
  }

  beginListing(): number {
    if (this.activeOperations > 0) {
      throw new Error(
        'Cannot list MCP tools while a server lifecycle operation is in progress.',
      );
    }
    return this.generation;
  }

  assertListingIsCurrent(listingGeneration: number): void {
    if (this.activeOperations > 0 || listingGeneration !== this.generation) {
      throw new Error('MCP tool listing became stale before it completed.');
    }
  }
}

/**
 * Interface for MCP server implementations.
 * Provides methods for connecting, listing tools, calling tools, and cleanup.
 */
export interface MCPServer {
  cacheToolsList: boolean;
  toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  toolMetaResolver?: MCPToolMetaResolver;
  customDataExtractor?: MCPToolCustomDataExtractor;
  /**
   * Whether to use MCP `structuredContent` as the model-visible tool output when available.
   * Defaults to false to preserve the existing content-based output behavior.
   */
  useStructuredContent?: boolean;
  /**
   * Optional function to convert MCP tool failures into model-visible messages.
   * Set to null to rethrow errors instead of converting them.
   */
  errorFunction?: MCPToolErrorFunction | null;
  connect(): Promise<void>;
  readonly name: string;
  close(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent>;
  /**
   * Invoke a tool and return the full serializable MCP result.
   */
  callToolResult?(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult>;
  invalidateToolsCache(): Promise<void>;
}

/**
 * Minimal params accepted by MCP resource-listing methods.
 */
export interface MCPListResourcesParams {
  cursor?: string;
  [key: string]: unknown;
}

/**
 * Minimal MCP resource definition used by this SDK.
 */
export interface MCPResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Minimal MCP resource template definition used by this SDK.
 */
export interface MCPResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Text resource content returned by `readResource`.
 */
export interface MCPTextResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
  [key: string]: unknown;
}

/**
 * Binary resource content returned by `readResource`.
 */
export interface MCPBlobResourceContent {
  uri: string;
  mimeType?: string;
  blob: string;
  [key: string]: unknown;
}

export type MCPResourceContent =
  MCPTextResourceContent | MCPBlobResourceContent;

/**
 * Result returned by `listResources`.
 */
export interface MCPListResourcesResult {
  resources: MCPResource[];
  nextCursor?: string;
  [key: string]: unknown;
}

/**
 * Result returned by `listResourceTemplates`.
 */
export interface MCPListResourceTemplatesResult {
  resourceTemplates: MCPResourceTemplate[];
  nextCursor?: string;
  [key: string]: unknown;
}

/**
 * Result returned by `readResource`.
 */
export interface MCPReadResourceResult {
  contents: MCPResourceContent[];
  [key: string]: unknown;
}

/**
 * Extended MCP server surface for servers that expose resources.
 */
export interface MCPServerWithResources extends MCPServer {
  listResources(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourcesResult>;
  listResourceTemplates(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourceTemplatesResult>;
  readResource(uri: string): Promise<MCPReadResourceResult>;
}

/**
 * Public interface of an MCP server that provides tools.
 * You can use this class to pass MCP server settings to your agent.
 */
export class MCPServerStdio
  extends BaseMCPServerStdio
  implements MCPServerWithResources
{
  private underlying: UnderlyingMCPServerStdio;
  private readonly toolsLifecycle = new MCPToolsLifecycleGuard();
  constructor(options: MCPServerStdioOptions) {
    super(options);
    this.underlying = new UnderlyingMCPServerStdio(options);
  }
  get name(): string {
    return this.underlying.name;
  }
  private async invalidateToolsCaches(): Promise<void> {
    this._cachedTools = undefined;
    await this.underlying.invalidateToolsCache();
  }
  connect(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(
      () => this.invalidateToolsCaches(),
      () => this.underlying.connect(),
    );
  }
  close(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(
      () => this.invalidateToolsCaches(),
      () => this.underlying.close(),
    );
  }
  async listTools(): Promise<MCPTool[]> {
    const listingGeneration = this.toolsLifecycle.beginListing();
    if (this.cacheToolsList && this._cachedTools) {
      return this._cachedTools;
    }
    const tools = await this.underlying.listTools();
    this.toolsLifecycle.assertListingIsCurrent(listingGeneration);
    if (this.cacheToolsList) {
      this._cachedTools = tools;
    }
    return tools;
  }
  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    return (await this.callToolResult(toolName, args, meta, options)).content;
  }
  callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    return this.underlying.callToolResult(toolName, args, meta, options);
  }
  listResources(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourcesResult> {
    return this.underlying.listResources(params);
  }
  listResourceTemplates(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourceTemplatesResult> {
    return this.underlying.listResourceTemplates(params);
  }
  readResource(uri: string): Promise<MCPReadResourceResult> {
    return this.underlying.readResource(uri);
  }
  invalidateToolsCache(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(() =>
      this.invalidateToolsCaches(),
    );
  }
}

export class MCPServerStreamableHttp
  extends BaseMCPServerStreamableHttp
  implements MCPServerWithResources
{
  private underlying: UnderlyingMCPServerStreamableHttp;
  private _cachedToolsSessionId: string | undefined = undefined;
  private readonly toolsLifecycle = new MCPToolsLifecycleGuard();
  constructor(options: MCPServerStreamableHttpOptions) {
    super(options);
    this.underlying = new UnderlyingMCPServerStreamableHttp(options);
  }
  private clearLocalToolsCache(): void {
    this._cachedTools = undefined;
    this._cachedToolsSessionId = undefined;
  }
  private async invalidateToolsCaches(): Promise<void> {
    this.clearLocalToolsCache();
    await this.underlying.invalidateToolsCache();
  }
  get name(): string {
    return this.underlying.name;
  }
  get sessionId(): string | undefined {
    return this.underlying.sessionId;
  }
  connect(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(
      () => this.invalidateToolsCaches(),
      () => this.underlying.connect(),
    );
  }
  close(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(
      () => this.invalidateToolsCaches(),
      () => this.underlying.close(),
    );
  }
  async listTools(): Promise<MCPTool[]> {
    const listingGeneration = this.toolsLifecycle.beginListing();
    const sessionId = this.sessionId;
    if (sessionId === undefined) {
      this.toolsLifecycle.invalidate();
      await this.invalidateToolsCaches();
      return this.underlying.listTools();
    }

    if (
      this.cacheToolsList &&
      this._cachedTools &&
      this._cachedToolsSessionId === sessionId
    ) {
      return this._cachedTools;
    }
    const tools = await this.underlying.listTools();
    this.toolsLifecycle.assertListingIsCurrent(listingGeneration);
    if (this.cacheToolsList) {
      this._cachedTools = tools;
      this._cachedToolsSessionId = sessionId;
    }
    return tools;
  }
  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    return (await this.callToolResult(toolName, args, meta, options)).content;
  }
  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    const previousSessionId = this.sessionId;
    try {
      return await this.underlying.callToolResult(
        toolName,
        args,
        meta,
        options,
      );
    } finally {
      if (previousSessionId !== this.sessionId) {
        this.toolsLifecycle.invalidate();
        await this.invalidateToolsCaches();
      }
    }
  }
  listResources(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourcesResult> {
    return this.underlying.listResources(params);
  }
  listResourceTemplates(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourceTemplatesResult> {
    return this.underlying.listResourceTemplates(params);
  }
  readResource(uri: string): Promise<MCPReadResourceResult> {
    return this.underlying.readResource(uri);
  }
  invalidateToolsCache(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(() =>
      this.invalidateToolsCaches(),
    );
  }
}

export class MCPServerSSE
  extends BaseMCPServerSSE
  implements MCPServerWithResources
{
  private underlying: UnderlyingMCPServerSSE;
  private readonly toolsLifecycle = new MCPToolsLifecycleGuard();
  constructor(options: MCPServerSSEOptions) {
    super(options);
    this.underlying = new UnderlyingMCPServerSSE(options);
  }
  get name(): string {
    return this.underlying.name;
  }
  private async invalidateToolsCaches(): Promise<void> {
    this._cachedTools = undefined;
    await this.underlying.invalidateToolsCache();
  }
  connect(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(
      () => this.invalidateToolsCaches(),
      () => this.underlying.connect(),
    );
  }
  close(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(
      () => this.invalidateToolsCaches(),
      () => this.underlying.close(),
    );
  }
  async listTools(): Promise<MCPTool[]> {
    const listingGeneration = this.toolsLifecycle.beginListing();
    if (this.cacheToolsList && this._cachedTools) {
      return this._cachedTools;
    }
    const tools = await this.underlying.listTools();
    this.toolsLifecycle.assertListingIsCurrent(listingGeneration);
    if (this.cacheToolsList) {
      this._cachedTools = tools;
    }
    return tools;
  }
  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    return (await this.callToolResult(toolName, args, meta, options)).content;
  }
  callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    return this.underlying.callToolResult(toolName, args, meta, options);
  }
  listResources(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourcesResult> {
    return this.underlying.listResources(params);
  }
  listResourceTemplates(
    params?: MCPListResourcesParams,
  ): Promise<MCPListResourceTemplatesResult> {
    return this.underlying.listResourceTemplates(params);
  }
  readResource(uri: string): Promise<MCPReadResourceResult> {
    return this.underlying.readResource(uri);
  }
  invalidateToolsCache(): Promise<void> {
    return this.toolsLifecycle.runLifecycleOperation(() =>
      this.invalidateToolsCaches(),
    );
  }
}

/**
 * Fetches and flattens all tools from multiple MCP servers.
 * Logs and skips any servers that fail to respond.
 */

/**
 * Function signature for generating the MCP tool cache key.
 * Customizable so the cache key can depend on any context—server, agent, runContext, etc.
 */
export type MCPToolCacheKeyGenerator = (params: {
  server: MCPServer;
  agent?: Agent<any, any>;
  runContext?: RunContext<any>;
}) => string;

/**
 * Default cache key generator for MCP tools.
 * Uses server name, or server+agent if using callable filter.
 */
export const defaultMCPToolCacheKey: MCPToolCacheKeyGenerator = ({
  server,
  agent,
}) => {
  if (server.toolFilter && typeof server.toolFilter === 'function' && agent) {
    return `${server.name}:${agent.name}`;
  }
  return server.name;
};

function logMcpToolFilterDebug(buildMessage: () => string): void {
  if (!globalLogger.dontLogToolData) {
    globalLogger.debug(buildMessage());
  }
}

/**
 * Fetches and filters raw MCP tools from a single MCP server.
 */
async function getMcpToolsFromServer<TContext = UnknownContext>({
  server,
  runContext,
  agent,
  generateMCPToolCacheKey,
  tracingParent,
}: {
  server: MCPServer;
  runContext?: RunContext<TContext>;
  agent?: Agent<any, any>;
  generateMCPToolCacheKey?: MCPToolCacheKeyGenerator;
  tracingParent?: Span<any>;
}): Promise<MCPTool[]> {
  const cacheKey = (generateMCPToolCacheKey || defaultMCPToolCacheKey)({
    server,
    agent,
    runContext,
  });
  const serverName = server.name;
  // Use cache key generator injected from the outside, or the default if absent.
  if (server.cacheToolsList && _cachedTools[cacheKey]) {
    return _cachedTools[cacheKey];
  }
  const cacheListing = beginServerToolsCacheListing(serverName);

  const listToolsForServer = async (
    span?: Span<MCPListToolsSpanData>,
  ): Promise<MCPTool[]> => {
    const fetchedMcpTools = await server.listTools();
    let mcpTools: MCPTool[] = fetchedMcpTools;

    if (runContext && agent) {
      const context = { runContext, agent, serverName: server.name };
      const filteredTools: MCPTool[] = [];
      for (const tool of fetchedMcpTools) {
        const filter = server.toolFilter;
        if (filter) {
          if (typeof filter === 'function') {
            const filtered = await filter(context, tool);
            if (!filtered) {
              logMcpToolFilterDebug(
                () =>
                  `MCP Tool (server: ${getMcpServerExternalName(server.name)}, tool: ${tool.name}) is blocked by the callable filter.`,
              );
              continue;
            }
          } else {
            const allowedToolNames = filter.allowedToolNames ?? [];
            const blockedToolNames = filter.blockedToolNames ?? [];
            if (allowedToolNames.length > 0 || blockedToolNames.length > 0) {
              const allowed =
                allowedToolNames.length > 0
                  ? allowedToolNames.includes(tool.name)
                  : true;
              const blocked =
                blockedToolNames.length > 0
                  ? blockedToolNames.includes(tool.name)
                  : false;
              if (!allowed || blocked) {
                if (blocked) {
                  logMcpToolFilterDebug(
                    () =>
                      `MCP Tool (server: ${getMcpServerExternalName(server.name)}, tool: ${tool.name}) is blocked by the static filter.`,
                  );
                } else if (!allowed) {
                  logMcpToolFilterDebug(
                    () =>
                      `MCP Tool (server: ${getMcpServerExternalName(server.name)}, tool: ${tool.name}) is not allowed by the static filter.`,
                  );
                }
                continue;
              }
            }
          }
        }
        filteredTools.push(tool);
      }
      mcpTools = filteredTools;
    }

    if (span) {
      span.spanData.result = mcpTools.map((t) => t.name);
    }
    // Cache store
    if (server.cacheToolsList && cacheListing.isCurrent()) {
      _cachedTools[cacheKey] = mcpTools;
      if (!_cachedToolKeysByServer[serverName]) {
        _cachedToolKeysByServer[serverName] = new Set();
      }
      _cachedToolKeysByServer[serverName].add(cacheKey);
    }
    return mcpTools;
  };

  try {
    if (!tracingParent && !getCurrentTrace()) {
      return await listToolsForServer();
    }

    return await withMCPListToolsSpan(
      listToolsForServer,
      {
        data: { server: getMcpServerExternalName(server.name) },
      },
      tracingParent,
    );
  } finally {
    cacheListing.release();
  }
}

function convertMcpToolsToFunctionTools<TContext = UnknownContext>({
  mcpTools,
  server,
  convertSchemasToStrict,
  toolNameOverrides,
  errorFunction,
}: {
  mcpTools: MCPTool[];
  server: MCPServer;
  convertSchemasToStrict: boolean;
  toolNameOverrides?: Array<string | undefined>;
  errorFunction?: MCPToolErrorFunction | null;
}): FunctionTool<TContext, any, unknown>[] {
  return mcpTools.map((mcpTool, index) =>
    mcpToFunctionTool(mcpTool, server, convertSchemasToStrict, {
      toolNameOverride: toolNameOverrides?.[index],
      errorFunction,
    }),
  );
}

/**
 * Fetches all function tools from a single MCP server.
 */
async function getFunctionToolsFromServer<TContext = UnknownContext>({
  server,
  convertSchemasToStrict,
  runContext,
  agent,
  generateMCPToolCacheKey,
  errorFunction,
  tracingParent,
}: {
  server: MCPServer;
  convertSchemasToStrict: boolean;
  runContext?: RunContext<TContext>;
  agent?: Agent<any, any>;
  generateMCPToolCacheKey?: MCPToolCacheKeyGenerator;
  errorFunction?: MCPToolErrorFunction | null;
  tracingParent?: Span<any>;
}): Promise<FunctionTool<TContext, any, unknown>[]> {
  const mcpTools = await getMcpToolsFromServer({
    server,
    runContext,
    agent,
    generateMCPToolCacheKey,
    tracingParent,
  });
  return convertMcpToolsToFunctionTools({
    mcpTools,
    server,
    convertSchemasToStrict,
    errorFunction,
  });
}

/**
 * Options for fetching MCP tools.
 */
export type GetAllMcpToolsOptions<TContext> = {
  mcpServers: MCPServer[];
  convertSchemasToStrict?: boolean;
  runContext?: RunContext<TContext>;
  agent?: Agent<TContext, any>;
  generateMCPToolCacheKey?: MCPToolCacheKeyGenerator;
  errorFunction?: MCPToolErrorFunction | null;
  includeServerInToolNames?: boolean;
  reservedToolNames?: Set<string>;
  tracingParent?: Span<any>;
};

/**
 * Returns all MCP tools from the provided servers, using the function tool conversion.
 * If runContext and agent are provided, callable tool filters will be applied.
 */
export async function getAllMcpTools<TContext = UnknownContext>(
  mcpServersOrOpts: MCPServer[] | GetAllMcpToolsOptions<TContext>,
  runContext?: RunContext<TContext>,
  agent?: Agent<TContext, any>,
  convertSchemasToStrict = false,
): Promise<Tool<TContext>[]> {
  const opts = Array.isArray(mcpServersOrOpts)
    ? {
        mcpServers: mcpServersOrOpts,
        runContext,
        agent,
        convertSchemasToStrict,
      }
    : mcpServersOrOpts;

  const {
    mcpServers,
    convertSchemasToStrict: convertSchemasToStrictFromOpts = false,
    runContext: runContextFromOpts,
    agent: agentFromOpts,
    generateMCPToolCacheKey,
    errorFunction,
    includeServerInToolNames = false,
    reservedToolNames,
    tracingParent,
  } = opts;
  const allTools: Tool<TContext>[] = [];
  const toolNames = new Set<string>();

  if (includeServerInToolNames) {
    const serverToolBatches = await Promise.all(
      mcpServers.map(async (server, serverIndex) => ({
        server,
        serverIndex,
        mcpTools: await getMcpToolsFromServer({
          server,
          runContext: runContextFromOpts,
          agent: agentFromOpts,
          generateMCPToolCacheKey,
          tracingParent,
        }),
      })),
    );
    const toolNameOverrides = buildPrefixedToolNameOverrides(
      serverToolBatches,
      new Set(reservedToolNames ?? []),
    );

    for (const { server, serverIndex, mcpTools } of serverToolBatches) {
      const serverTools = convertMcpToolsToFunctionTools<TContext>({
        mcpTools,
        server,
        convertSchemasToStrict: convertSchemasToStrictFromOpts,
        errorFunction,
        toolNameOverrides: mcpTools.map((_, toolIndex) =>
          toolNameOverrides.get(getToolNameOverrideKey(serverIndex, toolIndex)),
        ),
      });
      const serverToolNames = new Set(serverTools.map((t) => t.name));
      const intersection = [...serverToolNames]
        .filter((n) => toolNames.has(n))
        .sort();
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

  for (const server of mcpServers) {
    const serverTools = await getFunctionToolsFromServer({
      server,
      convertSchemasToStrict: convertSchemasToStrictFromOpts,
      runContext: runContextFromOpts,
      agent: agentFromOpts,
      generateMCPToolCacheKey,
      errorFunction,
      tracingParent,
    });
    const serverToolNames = new Set(serverTools.map((t) => t.name));
    const intersection = [...serverToolNames]
      .filter((n) => toolNames.has(n))
      .sort();
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

function getToolNameOverrideKey(
  serverIndex: number,
  toolIndex: number,
): string {
  return `${serverIndex}:${toolIndex}`;
}

function getSafeToolNamePart(value: string, fallback: string): string {
  const safe = Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 127 && /[A-Za-z0-9_-]/.test(char) ? char : '_';
    })
    .join('')
    .replace(/^[_-]+|[_-]+$/g, '');
  return safe || fallback;
}

function getUtf8Bytes(value: string): number[] {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return bytes;
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function getSha1Hex(value: string): string {
  const bytes = getUtf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }

  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff);
  }

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(80).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] =
        ((bytes[byteOffset] ?? 0) << 24) |
        ((bytes[byteOffset + 1] ?? 0) << 16) |
        ((bytes[byteOffset + 2] ?? 0) << 8) |
        (bytes[byteOffset + 3] ?? 0);
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3] ^
          words[index - 8] ^
          words[index - 14] ^
          words[index - 16],
        1,
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotateLeft(a, 5) + f + e + k + (words[index] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function shortenToolName(
  baseName: string,
  seed: string,
  forceHash = false,
): string {
  if (!forceHash && baseName.length <= MCP_FUNCTION_TOOL_NAME_MAX_LENGTH) {
    return baseName;
  }

  const hashSuffix = getSha1Hex(seed).slice(0, MCP_FUNCTION_TOOL_HASH_LENGTH);
  const suffix = `_${hashSuffix}`;
  const stemLength = MCP_FUNCTION_TOOL_NAME_MAX_LENGTH - suffix.length;
  const stem = baseName.slice(0, stemLength).replace(/[_-]+$/g, '') || 'mcp';
  return `${stem}${suffix}`;
}

function buildPrefixedToolBaseName(
  serverName: string,
  toolName: string,
): string {
  const serverPart = getSafeToolNamePart(serverName, 'server');
  const toolPart = getSafeToolNamePart(toolName, 'tool');
  return `mcp_${serverPart}__${toolPart}`;
}

function buildPrefixedToolNameOverrides(
  serverToolBatches: Array<{
    server: MCPServer;
    serverIndex: number;
    mcpTools: MCPTool[];
  }>,
  reservedNames: Set<string>,
): Map<string, string> {
  const baseNameCounts = new Map<string, number>();
  for (const { server, mcpTools } of serverToolBatches) {
    const serverName = getMcpServerExternalName(server.name);
    for (const mcpTool of mcpTools) {
      const baseName = buildPrefixedToolBaseName(serverName, mcpTool.name);
      baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
    }
  }

  const candidates: PrefixedToolNameCandidate[] = [];
  const rawServerNamesBySeed = new Map<string, string>();
  for (const { server, serverIndex, mcpTools } of serverToolBatches) {
    const serverName = getMcpServerExternalName(server.name);
    mcpTools.forEach((mcpTool, toolIndex) => {
      const baseName = buildPrefixedToolBaseName(serverName, mcpTool.name);
      const seed = `${serverName}\0${mcpTool.name}`;
      const previousRawServerName = rawServerNamesBySeed.get(seed);
      if (
        previousRawServerName !== undefined &&
        previousRawServerName !== server.name
      ) {
        throw new UserError(
          `MCP server names are indistinguishable after URL redaction for tool '${mcpTool.name}': '${serverName}'. Configure unique safe server names when includeServerInToolNames is enabled.`,
        );
      }
      rawServerNamesBySeed.set(seed, server.name);
      const forceHash =
        (baseNameCounts.get(baseName) ?? 0) > 1 || reservedNames.has(baseName);
      candidates.push({
        batchKey: getToolNameOverrideKey(serverIndex, toolIndex),
        baseName,
        seed,
        initialName: shortenToolName(baseName, seed, forceHash),
        serverIndex,
        toolIndex,
      });
    });
  }

  const usedNames = new Set(reservedNames);
  const overrides = new Map<string, string>();
  for (const candidate of candidates.sort((left, right) => {
    return (
      left.initialName.localeCompare(right.initialName) ||
      left.seed.localeCompare(right.seed) ||
      left.serverIndex - right.serverIndex ||
      left.toolIndex - right.toolIndex
    );
  })) {
    let publicName = candidate.initialName;
    let collisionIndex = 1;
    while (usedNames.has(publicName)) {
      publicName = shortenToolName(
        candidate.baseName,
        `${candidate.seed}\0${collisionIndex}`,
        true,
      );
      collisionIndex += 1;
    }

    usedNames.add(publicName);
    overrides.set(candidate.batchKey, publicName);
  }

  return overrides;
}

async function resolveMcpToolMeta<TContext>(
  server: MCPServer,
  runContext: RunContext<TContext>,
  toolName: string,
  args: Record<string, unknown> | null,
): Promise<Record<string, unknown> | undefined> {
  const resolver = server.toolMetaResolver;
  if (!resolver) {
    return undefined;
  }

  const context: MCPToolMetaContext<TContext> = {
    runContext,
    serverName: server.name,
    toolName,
    arguments: args,
  };

  const resolved = await resolver(context);
  if (resolved == null) {
    return undefined;
  }
  if (typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new TypeError(
      'MCP tool meta resolver must return an object or null.',
    );
  }
  return resolved;
}

/**
 * Converts an MCP tool definition to a function tool for the Agents SDK.
 */
export type MCPFunctionToolConversionOptions = {
  toolNameOverride?: string;
  errorFunction?: MCPToolErrorFunction | null;
};

export function mcpToFunctionTool(
  mcpTool: MCPTool,
  server: MCPServer,
  convertSchemasToStrict: boolean,
  options: MCPFunctionToolConversionOptions = {},
) {
  const toolName = options.toolNameOverride ?? mcpTool.name;
  const customDataByCall = new WeakMap<
    RunContext<any>,
    Map<string, MCPToolCustomDataContext<any>>
  >();
  const serverErrorFunction = server.errorFunction;
  const mcpErrorFunction =
    serverErrorFunction !== undefined
      ? serverErrorFunction
      : options.errorFunction;
  const errorFunction =
    typeof mcpErrorFunction === 'function'
      ? (context: RunContext, error: Error | unknown) =>
          mcpErrorFunction({ context, error })
      : mcpErrorFunction;
  async function invoke(
    input: any,
    runContext?: RunContext<any>,
    details?: ToolCallDetails,
  ) {
    let args = {};
    if (typeof input === 'string' && input) {
      args = JSON.parse(input);
    } else if (typeof input === 'object' && input != null) {
      args = input;
    }
    const currentSpan =
      getToolCallParentSpanFromDetails(details) ?? getCurrentSpan();
    if (currentSpan) {
      currentSpan.spanData['mcp_data'] = {
        server: getMcpServerExternalName(server.name),
      };
    }
    const meta = runContext
      ? await resolveMcpToolMeta(server, runContext, mcpTool.name, args)
      : undefined;
    const callOptions = details?.signal
      ? { signal: details.signal }
      : undefined;
    const useFullResult =
      (server.useStructuredContent === true ||
        server.customDataExtractor !== undefined) &&
      server.callToolResult !== undefined;
    let result: CallToolResult;
    if (useFullResult) {
      result = callOptions
        ? await server.callToolResult!(mcpTool.name, args, meta, callOptions)
        : meta === undefined
          ? await server.callToolResult!(mcpTool.name, args)
          : await server.callToolResult!(mcpTool.name, args, meta);
    } else {
      result = {
        content: callOptions
          ? await server.callTool(mcpTool.name, args, meta, callOptions)
          : meta === undefined
            ? await server.callTool(mcpTool.name, args)
            : await server.callTool(mcpTool.name, args, meta),
      };
    }
    const content = result.content as CallToolResultContent;
    const resultMeta = result._meta ?? content._meta;
    const structuredContent =
      result.structuredContent ?? content.structuredContent;
    const isError = result.isError ?? content.isError;
    const toolOutput =
      server.useStructuredContent === true &&
      isError !== true &&
      structuredContent !== undefined
        ? JSON.stringify(structuredContent)
        : content.length === 1
          ? content[0]
          : content;
    if (runContext && details?.toolCall?.callId && server.customDataExtractor) {
      let byCall = customDataByCall.get(runContext);
      if (!byCall) {
        byCall = new Map();
        customDataByCall.set(runContext, byCall);
      }
      byCall.set(details.toolCall.callId, {
        runContext,
        serverName: server.name,
        toolName: mcpTool.name,
        toolDisplayName: toolName,
        arguments: cloneMcpCustomDataContextValue(args),
        resultMeta: cloneMcpCustomDataContextValue(resultMeta),
        structuredContent: cloneMcpCustomDataContextValue(structuredContent),
        isError,
        toolOutput: cloneMcpCustomDataContextValue(toolOutput),
      });
    }
    return toolOutput;
  }

  const inputSchema = mcpTool.inputSchema ?? {};
  const inputSchemaIsEmpty = Object.keys(inputSchema).length === 0;
  const schema = {
    ...inputSchema,
    type: inputSchema.type ?? 'object',
    properties: inputSchema.properties ?? {},
    required: inputSchema.required ?? [],
  } as JsonObjectSchema<any>;
  const strictSchema = (
    inputSchemaIsEmpty ? { ...schema, additionalProperties: false } : schema
  ) as JsonObjectSchemaStrict<any>;
  let preserveSchemaOnFallback = false;

  if (convertSchemasToStrict || schema.additionalProperties === true) {
    try {
      assertOpenAIStrictToolSchemaPreservesOpenObjects(strictSchema);
      return tool({
        name: toolName,
        description: mcpTool.description || '',
        parameters: strictSchema,
        strict: true,
        execute: invoke,
        errorFunction,
        customDataExtractor: async (context) => {
          const mcpContext = getMcpCustomDataContext(
            customDataByCall,
            context.runContext,
            context.toolCall.callId,
          );
          return mcpContext
            ? maybeExtractToolOutputCustomData(
                server.customDataExtractor,
                mcpContext,
              )
            : undefined;
        },
      });
    } catch (e) {
      if (convertSchemasToStrict && isJsonSchemaDepthError(e)) {
        throw e;
      }
      preserveSchemaOnFallback = true;
      logToolActionWarning(
        globalLogger,
        'Error converting MCP schema to strict mode:',
        e,
      );
    }
  }

  const nonStrictSchema: JsonObjectSchemaNonStrict<any> = {
    ...schema,
    additionalProperties:
      preserveSchemaOnFallback && 'additionalProperties' in schema
        ? schema.additionalProperties
        : true,
  } as JsonObjectSchemaNonStrict<any>;
  return tool({
    name: toolName,
    description: mcpTool.description || '',
    parameters: nonStrictSchema,
    strict: false,
    execute: invoke,
    errorFunction,
    customDataExtractor: async (context) => {
      const mcpContext = getMcpCustomDataContext(
        customDataByCall,
        context.runContext,
        context.toolCall.callId,
      );
      return mcpContext
        ? maybeExtractToolOutputCustomData(
            server.customDataExtractor,
            mcpContext,
          )
        : undefined;
    },
  });
}

function getMcpCustomDataContext(
  contexts: WeakMap<
    RunContext<any>,
    Map<string, MCPToolCustomDataContext<any>>
  >,
  runContext: RunContext<any>,
  callId: string,
): MCPToolCustomDataContext<any> | undefined {
  const byCall = contexts.get(runContext);
  const context = byCall?.get(callId);
  byCall?.delete(callId);
  return context;
}

function cloneMcpCustomDataContextValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
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
  toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  /**
   * Optional resolver for MCP request metadata (`_meta`) on tool calls.
   * Invoked before calling `callTool`.
   */
  toolMetaResolver?: MCPToolMetaResolver;
  /**
   * Whether to use MCP `structuredContent` as model-visible output when available.
   */
  useStructuredContent?: boolean;
  /**
   * Optional callback that attaches SDK-only custom data to local MCP tool output items.
   */
  customDataExtractor?: MCPToolCustomDataExtractor;
  /**
   * Optional function to convert MCP tool failures into model-visible messages.
   * Set to null to rethrow errors instead of converting them.
   */
  errorFunction?: MCPToolErrorFunction | null;
  timeout?: number;
}
export interface DefaultMCPServerStdioOptions extends BaseMCPServerStdioOptions {
  command: string;
  args?: string[];
}
export interface FullCommandMCPServerStdioOptions extends BaseMCPServerStdioOptions {
  fullCommand: string;
}
export type MCPServerStdioOptions =
  DefaultMCPServerStdioOptions | FullCommandMCPServerStdioOptions;

export interface MCPServerStreamableHttpOptions {
  url: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  logger?: Logger;
  toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  /**
   * Optional resolver for MCP request metadata (`_meta`) on tool calls.
   * Invoked before calling `callTool`.
   */
  toolMetaResolver?: MCPToolMetaResolver;
  /**
   * Whether to use MCP `structuredContent` as model-visible output when available.
   */
  useStructuredContent?: boolean;
  /**
   * Optional callback that attaches SDK-only custom data to local MCP tool output items.
   */
  customDataExtractor?: MCPToolCustomDataExtractor;
  /**
   * Optional function to convert MCP tool failures into model-visible messages.
   * Set to null to rethrow errors instead of converting them.
   */
  errorFunction?: MCPToolErrorFunction | null;
  timeout?: number;

  // ----------------------------------------------------
  // OAuth
  // import { OAuthClientProvider } from '@modelcontextprotocol/client';
  authProvider?: any;
  // RequestInit
  requestInit?: any;
  // Custom fetch implementation used for all network requests.
  // import { FetchLike } from '@modelcontextprotocol/client';
  fetch?: any;
  // import { StreamableHTTPReconnectionOptions } from '@modelcontextprotocol/client';
  reconnectionOptions?: any;
  sessionId?: string;
  // ----------------------------------------------------
}

export interface MCPServerSSEOptions {
  url: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  logger?: Logger;
  toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  /**
   * Optional resolver for MCP request metadata (`_meta`) on tool calls.
   * Invoked before calling `callTool`.
   */
  toolMetaResolver?: MCPToolMetaResolver;
  /**
   * Whether to use MCP `structuredContent` as model-visible output when available.
   */
  useStructuredContent?: boolean;
  /**
   * Optional callback that attaches SDK-only custom data to local MCP tool output items.
   */
  customDataExtractor?: MCPToolCustomDataExtractor;
  /**
   * Optional function to convert MCP tool failures into model-visible messages.
   * Set to null to rethrow errors instead of converting them.
   */
  errorFunction?: MCPToolErrorFunction | null;
  timeout?: number;

  // ----------------------------------------------------
  // OAuth
  // import { OAuthClientProvider } from '@modelcontextprotocol/client';
  authProvider?: any;
  // RequestInit
  requestInit?: any;
  // Custom fetch implementation used for all network requests.
  // import { FetchLike } from '@modelcontextprotocol/client';
  fetch?: any;
  // import { SSEClientTransportOptions } from '@modelcontextprotocol/client';
  eventSourceInit?: any;
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
    content: Array<{ type: string; [key: string]: unknown }>;
    _meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}
export type CallToolResult = CallToolResponse['result'];
export type CallToolResultMetadata = Pick<
  CallToolResult,
  '_meta' | 'structuredContent' | 'isError'
>;
export type CallToolResultContent = CallToolResult['content'] &
  CallToolResultMetadata;

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
