import {
  describe,
  test,
  expect,
  vi,
  afterAll,
  beforeAll,
  beforeEach,
} from 'vitest';
import { getEventListeners } from 'node:events';
import {
  NodeMCPServerStdio,
  NodeMCPServerSSE,
  NodeMCPServerStreamableHttp,
} from '../../../src/shims/mcp-server/node';
import { mcpToFunctionTool } from '../../../src/mcp';
import { RunContext } from '../../../src/runContext';
import { UserError } from '../../../src/errors';
import {
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  type JSONRPCMessage,
  type Client,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client';
import type { Logger } from '../../../src/logger';
import { connectMcpServers } from '../../../src/mcpServers';
import {
  MCPServerStdio as ExportedStdio,
  MCPServerSSE as ExportedSSE,
} from '@openai/agents-core/_shims';

let lastConnectOptions: any;
let lastListToolsOptions: any;
let lastListResourcesOptions: any;
let lastListResourcesParams: any;
let lastListResourceTemplatesOptions: any;
let lastListResourceTemplatesParams: any;
let lastCallToolOptions: any;
let lastCallToolParams: any;
let lastReadResourceOptions: any;
let lastReadResourceParams: any;
let lastClientOptions: any;
let callToolImplementation:
  ((params: any, options: any) => Promise<any>) | undefined;
let connectImplementation:
  ((transport: any, options: any) => Promise<void>) | undefined;
let listToolsImplementation:
  ((params: any, options: any) => Promise<any>) | undefined;
let listToolsCalls: Array<{ params: any; options: any }>;
let listResourcesImplementation:
  ((params: any, options: any) => Promise<any>) | undefined;
let terminateSessionImplementation: (() => Promise<void>) | undefined;
let retainCallToolSignalListener = false;

const credentialEndpoint = new URL('https://example.test/mcp');
credentialEndpoint.username = 'user_marker';
credentialEndpoint.password = 'password_marker';
credentialEndpoint.searchParams.set('token', 'query_marker');
credentialEndpoint.hash = 'fragment_marker';
const CREDENTIAL_ENDPOINT = credentialEndpoint.toString();
const CREDENTIAL_MARKERS = [
  'user_marker',
  'password_marker',
  'query_marker',
  'fragment_marker',
] as const;

function createUnsafeTransportError(): Error {
  const cause = new Error(`Nested failure for ${CREDENTIAL_ENDPOINT}`);
  const error = new Error(
    `Transport failed for ${CREDENTIAL_ENDPOINT}`,
  ) as Error & { event: { message: string }; status: number };
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    writable: true,
  });
  error.event = { message: `Event failed for ${CREDENTIAL_ENDPOINT}` };
  error.status = 502;
  return error;
}

function createMockTool(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: `Mock tool ${name}`,
    inputSchema: {
      type: 'object',
    },
    ...extra,
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectCachedToolsInvalidatedImmediately(server: {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<Array<{ name: string }>>;
  invalidateToolsCache(): Promise<void>;
}): Promise<void> {
  let currentToolName = 'old-tool';
  listToolsImplementation = async () => ({
    tools: [createMockTool(currentToolName)],
  });

  await server.connect();
  expect((await server.listTools()).map((tool) => tool.name)).toEqual([
    'old-tool',
  ]);

  currentToolName = 'new-tool';
  const invalidation = server.invalidateToolsCache();
  const crossingListing = server.listTools();
  await invalidation;

  expect((await crossingListing).map((tool) => tool.name)).toEqual([
    'new-tool',
  ]);
  expect((await server.listTools()).map((tool) => tool.name)).toEqual([
    'new-tool',
  ]);
  await server.close();
}

async function expectInvalidationClearsListedToolMetadata(server: {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<Array<{ name: string }>>;
  invalidateToolsCache(): Promise<void>;
  callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<unknown>;
}): Promise<void> {
  listToolsImplementation = async () => ({
    tools: [
      createMockTool('task-tool', {
        execution: { taskSupport: 'required' },
      }),
    ],
  });

  await server.connect();
  await server.listTools();
  await server.invalidateToolsCache();

  await expect(server.callTool('task-tool', {})).resolves.toBeDefined();
  expect(lastCallToolOptions?.toolDefinition).toBeUndefined();
  await server.close();
}

function getErrorGraphText(value: unknown, seen = new Set<object>()): string {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return typeof value === 'string' ? value : '';
  }
  if (seen.has(value)) {
    return '';
  }
  seen.add(value);

  const values: string[] = [];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    if ('value' in descriptor) {
      values.push(getErrorGraphText(descriptor.value, seen));
    }
  }
  return values.join('\n');
}

function expectNoCredentialMarkers(value: unknown): void {
  const graph = getErrorGraphText(value);
  for (const marker of CREDENTIAL_MARKERS) {
    expect(graph).not.toContain(marker);
  }
}

function createCapturingLogger() {
  return {
    namespace: 'openai-agents:test:mcp-transport-redaction',
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    dontLogModelData: false as boolean,
    dontLogToolData: false as boolean,
  } satisfies Logger;
}

async function expectConsoleErrors<T>(
  expectedCalls: unknown[][],
  callback: () => Promise<T>,
): Promise<T> {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const result = await callback();
    expect(errorSpy.mock.calls).toEqual(expectedCalls);
    return result;
  } finally {
    errorSpy.mockRestore();
  }
}

beforeEach(() => {
  lastConnectOptions = undefined;
  lastListToolsOptions = undefined;
  lastListResourcesOptions = undefined;
  lastListResourcesParams = undefined;
  lastListResourceTemplatesOptions = undefined;
  lastListResourceTemplatesParams = undefined;
  lastCallToolOptions = undefined;
  lastCallToolParams = undefined;
  lastReadResourceOptions = undefined;
  lastReadResourceParams = undefined;
  lastClientOptions = undefined;
  callToolImplementation = undefined;
  connectImplementation = undefined;
  listToolsImplementation = undefined;
  listToolsCalls = [];
  listResourcesImplementation = undefined;
  terminateSessionImplementation = undefined;
  retainCallToolSignalListener = false;
});

beforeAll(() => {
  vi.doMock('@modelcontextprotocol/client/stdio', async (importOriginal) => {
    return {
      ...(await importOriginal()),
      StdioClientTransport: MockStdioClientTransport,
    };
  });
  vi.doMock('@modelcontextprotocol/client', async (importOriginal) => ({
    ...(await importOriginal()),
    Client: MockClient,
    SSEClientTransport: MockSSEClientTransport,
    StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
  }));
});

describe('NodeMCPServerStdio', () => {
  test('forwards the tool page cap and preserves per-page timeouts', async () => {
    listToolsImplementation = async () => ({
      tools: [createMockTool('tool')],
      nextCursor: 'another-page',
    });
    const server = new NodeMCPServerStdio({
      fullCommand: 'synthetic',
      maxListPages: 1,
      clientSessionTimeoutSeconds: 7,
    });
    await server.connect();
    try {
      expect(lastClientOptions?.listMaxPages).toBe(1);
      await expect(server.listTools()).rejects.toThrow('exceeded maxListPages');
      expect(listToolsCalls).toHaveLength(1);
      expect(lastListToolsOptions?.timeout).toBe(7000);
    } finally {
      await server.close();
    }
  });

  test('should be available', async () => {
    const server = new NodeMCPServerStdio({
      name: 'test',
      fullCommand: 'test',
      cacheToolsList: true,
    });
    expect(server).toBeDefined();
    expect(server.name).toBe('test');
    expect(server.cacheToolsList).toBe(true);
    await server.connect();
    expect(lastConnectOptions?.timeout).toBe(5000);
    expect(lastClientOptions?.versionNegotiation).toEqual({ mode: 'auto' });
    expect(lastClientOptions?.listMaxPages).toBe(64);
    await server.close();
  });

  test('installed MCP client should support automatic tool pagination', async () => {
    const { Client } = await vi.importActual<
      typeof import('@modelcontextprotocol/client')
    >('@modelcontextprotocol/client');
    const client = new Client({
      name: 'metadata-compatibility-test',
      version: '1.0.0',
    });

    expect(typeof client.listTools).toBe('function');
  });

  test('should apply custom client session timeout when connecting', async () => {
    const server = new NodeMCPServerStdio({
      name: 'custom-timeout',
      fullCommand: 'test',
      clientSessionTimeoutSeconds: 12,
    });

    await server.connect();

    expect(lastConnectOptions?.timeout).toBe(12000);

    await server.close();
  });

  test('should reuse request options for session methods', async () => {
    const server = new NodeMCPServerStdio({
      name: 'with-options',
      fullCommand: 'test',
      clientSessionTimeoutSeconds: 6,
    });

    await server.connect();
    await server.listTools();
    const controller = new AbortController();
    await server.callTool('mock-tool', {}, undefined, {
      signal: controller.signal,
    });

    expect(lastConnectOptions?.timeout).toBe(6000);
    expect(lastListToolsOptions?.timeout).toBe(6000);
    expect(lastCallToolOptions?.timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MSEC);
    expect(lastCallToolOptions?.signal).toBeDefined();
    expect(lastCallToolOptions?.signal).not.toBe(controller.signal);
    expect(lastCallToolOptions?.toolDefinition).toMatchObject({
      name: 'mock-tool',
    });

    await server.close();
  });

  test('should preserve caller cancellation for in-flight tool calls', async () => {
    let markCallStarted: (() => void) | undefined;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    callToolImplementation = async (_params, options) => {
      markCallStarted?.();
      return new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('MCP SDK wrapped cancellation')),
          { once: true },
        );
      });
    };
    const server = new NodeMCPServerStdio({
      name: 'cancel-in-flight',
      fullCommand: 'test',
    });
    await server.connect();
    const tool = mcpToFunctionTool(
      {
        name: 'mock-tool',
        description: 'Mock tool',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );
    const controller = new AbortController();
    const abortReason = new Error('caller cancelled');

    const pendingCall = tool.invoke(new RunContext({}), '{}', {
      signal: controller.signal,
    });
    await callStarted;
    controller.abort(abortReason);

    await expect(pendingCall).rejects.toBe(abortReason);
    await server.close();
  });

  test('should isolate retained request listeners from the caller signal', async () => {
    retainCallToolSignalListener = true;
    const server = new NodeMCPServerStdio({
      name: 'isolated-request-signal',
      fullCommand: 'test',
    });
    await server.connect();
    const controller = new AbortController();

    await server.callTool('mock-tool', {}, undefined, {
      signal: controller.signal,
    });

    expect(lastCallToolOptions.signal).not.toBe(controller.signal);
    expect(getEventListeners(lastCallToolOptions.signal, 'abort')).toHaveLength(
      1,
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await server.close();
  });

  test('should pass _meta to tool calls', async () => {
    const server = new NodeMCPServerStdio({
      name: 'meta-test',
      fullCommand: 'test',
    });

    await server.connect();
    await server.callTool(
      'mock-tool',
      { foo: 'bar' },
      {
        request_id: 'req-123',
      },
    );

    expect(lastCallToolParams?._meta).toEqual({ request_id: 'req-123' });

    await server.close();
  });

  test('should return a serializable full tool result', async () => {
    const server = new NodeMCPServerStdio({
      name: 'full-result-test',
      fullCommand: 'test',
    });

    await server.connect();
    const result = await server.callToolResult('mock-tool', {});

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { renderer: 'chart' },
      structuredContent: { answer: 42 },
      isError: true,
    });
    expect(await server.callTool('mock-tool', {})).toEqual([
      { type: 'text', text: 'ok' },
    ]);

    await server.close();
  });

  test('should list every tool page and cache only the complete result', async () => {
    const continuation = createDeferred();
    const continuationStarted = createDeferred();
    listToolsImplementation = async (params) => {
      if (params === undefined) {
        return {
          tools: [createMockTool('first-tool')],
          nextCursor: '',
        };
      }
      expect(params).toEqual({ cursor: '' });
      continuationStarted.resolve();
      await continuation.promise;
      return { tools: [createMockTool('second-tool')] };
    };
    const server = new NodeMCPServerStdio({
      name: 'paginated-tools',
      fullCommand: 'test',
      cacheToolsList: true,
      clientSessionTimeoutSeconds: 6,
    });

    await server.connect();
    const pendingTools = server.listTools();
    await continuationStarted.promise;

    continuation.resolve();
    const tools = await pendingTools;
    const cachedTools = await server.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'first-tool',
      'second-tool',
    ]);
    expect(cachedTools).toBe(tools);
    expect(listToolsCalls.map((call) => call.params)).toEqual([
      undefined,
      { cursor: '' },
    ]);
    expect(listToolsCalls.map((call) => call.options.timeout)).toEqual([
      6000, 6000,
    ]);
    await server.close();
  });

  test('should reject a tool listing invalidated before commit', async () => {
    const continuation = createDeferred();
    const continuationStarted = createDeferred();
    listToolsImplementation = async (params) => {
      if (params === undefined) {
        return {
          tools: [createMockTool('stale-first-tool')],
          nextCursor: 'continuation',
        };
      }
      continuationStarted.resolve();
      await continuation.promise;
      return { tools: [createMockTool('stale-second-tool')] };
    };
    const server = new NodeMCPServerStdio({
      name: 'invalidated-pagination',
      fullCommand: 'test',
      cacheToolsList: true,
    });

    await server.connect();
    const staleListing = server.listTools();
    await continuationStarted.promise;
    await server.invalidateToolsCache();
    continuation.resolve();

    await expect(staleListing).rejects.toThrow(
      'MCP tool listing became stale before it completed.',
    );
    listToolsImplementation = async () => ({
      tools: [createMockTool('refreshed-tool')],
    });
    expect((await server.listTools()).map((tool) => tool.name)).toEqual([
      'refreshed-tool',
    ]);

    await server.close();
  });

  test('should stop serving cached tools when invalidation starts', async () => {
    await expectCachedToolsInvalidatedImmediately(
      new NodeMCPServerStdio({
        name: 'immediate-stdio-invalidation',
        fullCommand: 'test',
        cacheToolsList: true,
      }),
    );
  });

  test('should clear listed tool metadata on invalidation', async () => {
    await expectInvalidationClearsListedToolMetadata(
      new NodeMCPServerStdio({
        name: 'stdio-invalidation-metadata',
        fullCommand: 'test',
        cacheToolsList: true,
      }),
    );
  });

  test('should reject a tool listing from a replaced session', async () => {
    const continuation = createDeferred();
    const continuationStarted = createDeferred();
    listToolsImplementation = async (params) => {
      if (params === undefined) {
        return {
          tools: [createMockTool('old-first-tool')],
          nextCursor: 'continuation',
        };
      }
      continuationStarted.resolve();
      await continuation.promise;
      return { tools: [createMockTool('old-second-tool')] };
    };
    const server = new NodeMCPServerStdio({
      name: 'replaced-session-pagination',
      fullCommand: 'test',
      cacheToolsList: true,
    });

    await server.connect();
    const staleListing = server.listTools();
    await continuationStarted.promise;
    await server.close();
    await server.connect();
    continuation.resolve();

    await expect(staleListing).rejects.toThrow(
      'MCP tool listing became stale before it completed.',
    );
    listToolsImplementation = async () => ({
      tools: [createMockTool('new-session-tool')],
    });
    expect((await server.listTools()).map((tool) => tool.name)).toEqual([
      'new-session-tool',
    ]);

    await server.close();
  });

  test('should forward resource requests to session methods', async () => {
    const server = new NodeMCPServerStdio({
      name: 'resource-test',
      fullCommand: 'test',
      clientSessionTimeoutSeconds: 7,
    });

    await server.connect();
    const resources = await server.listResources({ cursor: 'resource-cursor' });
    const templates = await server.listResourceTemplates({
      cursor: 'template-cursor',
    });
    const resource = await server.readResource('file:///mock-resource.txt');

    expect(resources.resources[0].uri).toBe('file:///mock-resource.txt');
    expect(templates.resourceTemplates[0].uriTemplate).toBe(
      'file:///mock/{name}.txt',
    );
    expect(resource.contents[0]).toMatchObject({
      uri: 'file:///mock-resource.txt',
      text: 'resource-body',
    });
    expect(lastListResourcesParams).toEqual({ cursor: 'resource-cursor' });
    expect(lastListResourcesOptions?.timeout).toBe(7000);
    expect(lastListResourcesOptions?.cacheMode).toBeUndefined();
    expect(lastListResourceTemplatesParams).toEqual({
      cursor: 'template-cursor',
    });
    expect(lastListResourceTemplatesOptions?.timeout).toBe(7000);
    expect(lastListResourceTemplatesOptions?.cacheMode).toBeUndefined();
    expect(lastReadResourceParams).toEqual({
      uri: 'file:///mock-resource.txt',
    });
    expect(lastReadResourceOptions?.timeout).toBe(7000);
    expect(lastReadResourceOptions?.cacheMode).toBe('refresh');

    await server.close();
  });

  afterAll(() => {
    vi.clearAllMocks();
  });
});

class MockStdioClientTransport {
  options: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  };
  constructor(options: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }) {
    this.options = options;
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class MockClient {
  options: {
    name: string;
    version: string;
  };
  constructor(options: { name: string; version: string }, clientOptions?: any) {
    this.options = options;
    lastClientOptions = clientOptions;
  }
  connect(_transport: any, options?: any): Promise<void> {
    lastConnectOptions = options;
    if (connectImplementation) {
      return connectImplementation(_transport, options);
    }
    return Promise.resolve();
  }
  getServerCapabilities(): Record<string, unknown> {
    return { tools: {}, resources: {} };
  }
  getProtocolEra(): 'legacy' {
    return 'legacy';
  }
  request(request: any, options?: any): Promise<any> {
    switch (request.method) {
      case 'resources/list':
        return this.listResources(request.params, options);
      case 'resources/templates/list':
        return this.listResourceTemplates(request.params, options);
      case 'tools/list':
        lastListToolsOptions = options;
        listToolsCalls.push({ params: request.params, options });
        return listToolsImplementation
          ? listToolsImplementation(request.params, options)
          : Promise.resolve({ tools: [createMockTool('mock-tool')] });
      default:
        throw new Error(`Unexpected mock MCP request: ${request.method}`);
    }
  }
  callTool(_params: any, options?: any): Promise<any> {
    lastCallToolParams = _params;
    lastCallToolOptions = options;
    if (retainCallToolSignalListener && options?.signal) {
      options.signal.addEventListener('abort', () => {});
    }
    if (callToolImplementation) {
      return callToolImplementation(_params, options);
    }
    return Promise.resolve({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { renderer: 'chart' },
      structuredContent: { answer: 42 },
      isError: true,
    });
  }
  listResources(params?: any, options?: any): Promise<any> {
    lastListResourcesParams = params;
    lastListResourcesOptions = options;
    if (listResourcesImplementation) {
      return listResourcesImplementation(params, options);
    }
    return Promise.resolve({
      resources: [
        {
          uri: 'file:///mock-resource.txt',
          name: 'Mock resource',
        },
      ],
      nextCursor: 'next-resource-cursor',
    });
  }
  listResourceTemplates(params?: any, options?: any): Promise<any> {
    lastListResourceTemplatesParams = params;
    lastListResourceTemplatesOptions = options;
    return Promise.resolve({
      resourceTemplates: [
        {
          uriTemplate: 'file:///mock/{name}.txt',
          name: 'Mock template',
        },
      ],
      nextCursor: 'next-template-cursor',
    });
  }
  readResource(params: any, options?: any): Promise<any> {
    lastReadResourceParams = params;
    lastReadResourceOptions = options;
    return Promise.resolve({
      contents: [
        {
          uri: params.uri,
          text: 'resource-body',
        },
      ],
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let capturedFetch: any = undefined;

class MockSSEClientTransport {
  url: URL;
  options: {
    authProvider?: any;
    requestInit?: any;
    eventSourceInit?: any;
    fetch?: any;
  };

  constructor(
    url: URL,
    options: {
      authProvider?: any;
      requestInit?: any;
      eventSourceInit?: any;
      fetch?: any;
    },
  ) {
    this.url = url;
    this.options = options;
    capturedFetch = options.fetch;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('NodeMCPServerSSE', () => {
  test('forwards the tool page cap and preserves per-page timeouts', async () => {
    listToolsImplementation = async () => ({
      tools: [createMockTool('tool')],
      nextCursor: 'another-page',
    });
    const server = new NodeMCPServerSSE({
      url: 'https://example.test/sse',
      maxListPages: 1,
      clientSessionTimeoutSeconds: 7,
    });
    await server.connect();
    try {
      expect(lastClientOptions?.listMaxPages).toBe(1);
      await expect(server.listTools()).rejects.toThrow('exceeded maxListPages');
      expect(listToolsCalls).toHaveLength(1);
      expect(lastListToolsOptions?.timeout).toBe(7000);
    } finally {
      await server.close();
    }
  });

  test('should stop serving cached tools when invalidation starts', async () => {
    await expectCachedToolsInvalidatedImmediately(
      new NodeMCPServerSSE({
        url: 'https://example.com/sse',
        name: 'immediate-sse-invalidation',
        cacheToolsList: true,
      }),
    );
  });

  test('should clear listed tool metadata on invalidation', async () => {
    await expectInvalidationClearsListedToolMetadata(
      new NodeMCPServerSSE({
        url: 'https://example.com/sse',
        name: 'sse-invalidation-metadata',
        cacheToolsList: true,
      }),
    );
  });

  test('should forward custom fetch to SSEClientTransport', async () => {
    const customFetch = vi.fn(async (_input, _init) => {
      return new Response('{}', { status: 200 });
    });

    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'test-sse-server',
      fetch: customFetch,
    });

    expect(server).toBeDefined();
    expect(server.name).toBe('test-sse-server');

    await server.connect();

    expect(capturedFetch).toBe(customFetch);
    expect(lastConnectOptions?.timeout).toBe(5000);

    await server.close();
  });

  test('should accept SSE server without custom fetch', async () => {
    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'test-sse-server-no-fetch',
    });

    expect(server).toBeDefined();
    await server.connect();
    expect(lastConnectOptions?.timeout).toBe(5000);
    await server.close();
  });

  test('should remove endpoint credentials from SSE connect errors and logs', async () => {
    const logger = createCapturingLogger();
    const unsafeError = createUnsafeTransportError();
    connectImplementation = async () => {
      throw unsafeError;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).not.toBe(unsafeError);
    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expect((error as Error & { status?: number }).status).toBeUndefined();
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test('should fail closed for invalid SSE endpoint errors and logs', async () => {
    const logger = createCapturingLogger();
    const invalidEndpoint = `//${['user_marker', 'password_marker'].join(
      ':',
    )}@example.test/mcp`;
    const server = new NodeMCPServerSSE({
      url: invalidEndpoint,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).toMatchObject({
      name: 'MCPTransportError',
      message:
        'MCP SSE connect failed; configured endpoint was invalid and was redacted.',
    });
    expect((error as Error & { input?: unknown }).input).toBeUndefined();
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test.each([
    [
      'symbol field',
      () => {
        const error = new Error('opaque transport failure');
        Object.defineProperty(error, Symbol('details'), {
          value: CREDENTIAL_ENDPOINT,
        });
        return error;
      },
    ],
    [
      'custom prototype',
      () =>
        Object.assign(Object.create({ details: CREDENTIAL_ENDPOINT }), {
          message: 'opaque transport failure',
        }),
    ],
    [
      'Map field',
      () =>
        Object.assign(new Error('opaque transport failure'), {
          details: new Map([['endpoint', CREDENTIAL_ENDPOINT]]),
        }),
    ],
  ])('should replace SSE errors with an opaque %s', async (_label, factory) => {
    const logger = createCapturingLogger();
    const opaqueError = factory();
    connectImplementation = async () => {
      throw opaqueError;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).not.toBe(opaqueError);
    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test('should not inspect accessor-backed SSE error fields', async () => {
    const logger = createCapturingLogger();
    const errorWithAccessor = new Error('opaque transport failure');
    let accessorReads = 0;
    Object.defineProperty(errorWithAccessor, 'details', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return CREDENTIAL_ENDPOINT;
      },
    });
    connectImplementation = async () => {
      throw errorWithAccessor;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expect(accessorReads).toBe(0);
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test('should replace opaque revoked proxy errors without inspecting them', async () => {
    const logger = createCapturingLogger();
    const { proxy, revoke } = Proxy.revocable(createUnsafeTransportError(), {});
    revoke();
    connectImplementation = async () => {
      throw proxy;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test('should redact DOMException details while preserving abort semantics', async () => {
    const logger = createCapturingLogger();
    const unsafeAbort = new DOMException(CREDENTIAL_ENDPOINT, 'AbortError');
    connectImplementation = async () => {
      throw unsafeAbort;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).toMatchObject({ name: 'AbortError' });
    expect((error as Error & { code?: number }).code).toBeUndefined();
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test('should preserve prototype-backed abort semantics', async () => {
    class PrototypeAbortError extends Error {}
    Object.defineProperty(PrototypeAbortError.prototype, 'name', {
      value: 'AbortError',
    });
    const logger = createCapturingLogger();
    const unsafeAbort = new PrototypeAbortError(CREDENTIAL_ENDPOINT);
    connectImplementation = async () => {
      throw unsafeAbort;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).toMatchObject({ name: 'AbortError' });
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test.each(['ABORT_ERR', 'ERR_ABORTED'] as const)(
    'should preserve manager abort semantics for %s',
    async (code) => {
      const logger = createCapturingLogger();
      const abortError = Object.assign(new Error('request cancelled'), {
        code,
      });
      connectImplementation = async () => {
        throw abortError;
      };
      const server = new NodeMCPServerSSE({
        url: CREDENTIAL_ENDPOINT,
        logger,
      });

      const session = await expectConsoleErrors(
        [['Failed to connect MCP server:', 'object']],
        () =>
          connectMcpServers([server], {
            strict: true,
            suppressAbortError: true,
          }),
      );

      expect(session.errors.get(server)).toMatchObject({
        name: 'AbortError',
      });
      expect(
        (session.errors.get(server) as (Error & { code?: string }) | undefined)
          ?.code,
      ).toBeUndefined();
      expectNoCredentialMarkers(session.errors.get(server));
      await session.close();
    },
  );

  test.each([
    ['Error message', 'abc', () => new Error('ERR_abc_INVALID')],
    ['thrown string', 'abc', () => 'ERR_abc_INVALID'],
    ['thrown number', '123', () => 123],
    [
      'numeric status field',
      '123',
      () => Object.assign(new Error('safe failure'), { status: 123 }),
    ],
  ])(
    'should replace a transport %s for a short query credential',
    async (_label, credential, factory) => {
      const logger = createCapturingLogger();
      const endpoint = new URL('https://example.test/mcp');
      endpoint.searchParams.set('token', credential);
      const unsafeError = factory();
      connectImplementation = async () => {
        throw unsafeError;
      };
      const server = new NodeMCPServerSSE({
        url: endpoint.toString(),
        logger,
      });

      const error = await server.connect().catch((caught) => caught);

      expect(error).not.toBe(unsafeError);
      expect(error).toMatchObject({ name: 'MCPTransportError' });
      expect((error as Error).message).not.toContain(credential);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(credential);
    },
  );

  test('should remove endpoint credentials stored only in a custom stack', async () => {
    const logger = createCapturingLogger();
    const unsafeError = new Error('safe transport failure');
    unsafeError.stack = 'password_marker';
    connectImplementation = async () => {
      throw unsafeError;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).not.toBe(unsafeError);
    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test('should replace Error subclasses with custom constructors', async () => {
    class CustomConstructorError extends Error {}
    let constructorReads = 0;
    Object.defineProperty(CustomConstructorError.prototype, 'constructor', {
      configurable: true,
      get: () => {
        constructorReads += 1;
        return CREDENTIAL_ENDPOINT;
      },
    });
    const logger = createCapturingLogger();
    const unsafeError = new CustomConstructorError('safe transport failure');
    connectImplementation = async () => {
      throw unsafeError;
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(constructorReads).toBe(0);
    expect(error).not.toBe(unsafeError);
    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expectNoCredentialMarkers(error);
    expectNoCredentialMarkers(logger.error.mock.calls);
  });

  test('should pass request options to session calls', async () => {
    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'test-sse-options',
      clientSessionTimeoutSeconds: 4,
    });

    await server.connect();
    await server.listTools();
    const controller = new AbortController();
    await server.callTool('mock-tool', {}, undefined, {
      signal: controller.signal,
    });

    expect(lastConnectOptions?.timeout).toBe(4000);
    expect(lastListToolsOptions?.timeout).toBe(4000);
    expect(lastCallToolOptions?.timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MSEC);
    expect(lastCallToolOptions?.signal).toBeDefined();
    expect(lastCallToolOptions?.signal).not.toBe(controller.signal);

    await server.close();
  });

  test('should reject repeated tool cursors without caching partial results', async () => {
    listToolsImplementation = async (params) => {
      if (params === undefined) {
        return {
          tools: [createMockTool('first-tool')],
          nextCursor: 'repeated-cursor',
        };
      }
      return {
        tools: [createMockTool('second-tool')],
        nextCursor: 'repeated-cursor',
      };
    };
    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'repeated-tool-cursor',
      cacheToolsList: true,
    });

    await server.connect();

    await expect(server.listTools()).rejects.toThrow(
      'MCP server returned a repeated cursor while listing tools.',
    );
    expect(listToolsCalls.map((call) => call.params)).toEqual([
      undefined,
      { cursor: 'repeated-cursor' },
    ]);
    listToolsCalls = [];
    listToolsImplementation = async () => ({
      tools: [createMockTool('recovered-tool')],
    });

    expect((await server.listTools()).map((tool) => tool.name)).toEqual([
      'recovered-tool',
    ]);
    expect(listToolsCalls.map((call) => call.params)).toEqual([undefined]);

    await server.close();
  });

  test('should preserve caller cancellation on credentialed endpoints', async () => {
    let markCallStarted: (() => void) | undefined;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    callToolImplementation = async (_params, options) => {
      markCallStarted?.();
      return new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('MCP SDK wrapped cancellation')),
          { once: true },
        );
      });
    };
    const server = new NodeMCPServerSSE({
      url: CREDENTIAL_ENDPOINT,
    });
    await server.connect();
    const controller = new AbortController();
    const abortReason = new Error('caller cancelled');

    const pendingCall = server.callTool('mock-tool', {}, undefined, {
      signal: controller.signal,
    });
    await callStarted;
    controller.abort(abortReason);

    await expect(pendingCall).rejects.toBe(abortReason);
    await server.close();
  });

  test('should return a serializable full tool result', async () => {
    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'test-sse-full-result',
    });

    await server.connect();

    expect(
      JSON.parse(JSON.stringify(await server.callToolResult('mock-tool', {}))),
    ).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { renderer: 'chart' },
      structuredContent: { answer: 42 },
      isError: true,
    });

    await server.close();
  });

  test('should forward resource requests to session methods', async () => {
    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'test-sse-resources',
      clientSessionTimeoutSeconds: 4,
    });

    await server.connect();
    await server.listResources({ cursor: 'resource-cursor' });
    await server.listResourceTemplates({ cursor: 'template-cursor' });
    await server.readResource('file:///mock-resource.txt');

    expect(lastListResourcesParams).toEqual({ cursor: 'resource-cursor' });
    expect(lastListResourcesOptions?.timeout).toBe(4000);
    expect(lastListResourceTemplatesParams).toEqual({
      cursor: 'template-cursor',
    });
    expect(lastListResourceTemplatesOptions?.timeout).toBe(4000);
    expect(lastReadResourceParams).toEqual({
      uri: 'file:///mock-resource.txt',
    });
    expect(lastReadResourceOptions?.timeout).toBe(4000);

    await server.close();
  });

  afterAll(() => {
    vi.clearAllMocks();
    capturedFetch = undefined;
  });
});

class MockStreamableHTTPClientTransport {
  static instances: MockStreamableHTTPClientTransport[] = [];

  url: URL;
  sessionId: string | undefined;
  options: {
    authProvider?: any;
    requestInit?: any;
    fetch?: any;
    reconnectionOptions?: any;
    sessionId?: string;
  };
  terminateSessionMock = vi.fn().mockResolvedValue(undefined);

  constructor(
    url: URL,
    options: {
      authProvider?: any;
      requestInit?: any;
      fetch?: any;
      reconnectionOptions?: any;
      sessionId?: string;
    },
  ) {
    this.url = url;
    this.options = options;
    this.sessionId = options.sessionId ?? 'generated-session-id';
    MockStreamableHTTPClientTransport.instances.push(this);
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  terminateSession(): Promise<void> {
    if (terminateSessionImplementation) {
      return terminateSessionImplementation();
    }
    return this.terminateSessionMock();
  }
}

describe('NodeMCPServerStreamableHttp', () => {
  test('forwards the tool page cap and preserves per-page timeouts', async () => {
    listToolsImplementation = async () => ({
      tools: [createMockTool('tool')],
      nextCursor: 'another-page',
    });
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.test/mcp',
      maxListPages: 1,
      clientSessionTimeoutSeconds: 7,
    });
    await server.connect();
    try {
      expect(lastClientOptions?.listMaxPages).toBe(1);
      await expect(server.listTools()).rejects.toThrow('exceeded maxListPages');
      expect(listToolsCalls).toHaveLength(1);
      expect(lastListToolsOptions?.timeout).toBe(7000);
    } finally {
      await server.close();
    }
  });

  beforeEach(() => {
    MockStreamableHTTPClientTransport.instances = [];
  });

  test('should stop serving cached tools when invalidation starts', async () => {
    await expectCachedToolsInvalidatedImmediately(
      new NodeMCPServerStreamableHttp({
        url: 'https://example.com/stream',
        name: 'immediate-streamable-http-invalidation',
        cacheToolsList: true,
      }),
    );
  });

  test('should clear listed tool metadata on invalidation', async () => {
    await expectInvalidationClearsListedToolMetadata(
      new NodeMCPServerStreamableHttp({
        url: 'https://example.com/stream',
        name: 'streamable-http-invalidation-metadata',
        cacheToolsList: true,
      }),
    );
  });

  test('should apply session timeout when connecting', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'test-stream',
      clientSessionTimeoutSeconds: 8,
    });

    await server.connect();

    expect(lastConnectOptions?.timeout).toBe(8000);

    await server.close();
  });

  test('should not copy numeric streamable HTTP status diagnostics', async () => {
    const logger = createCapturingLogger();
    const safeError = Object.assign(
      new Error(
        'Streamable HTTP error: Server returned 401 after successful authentication',
      ),
      { code: 401 },
    );
    connectImplementation = async () => {
      throw safeError;
    };
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.test/mcp?version=1',
      logger,
    });

    const error = await server.connect().catch((caught) => caught);

    expect(error).not.toBe(safeError);
    expect(error).toMatchObject({
      name: 'MCPTransportError',
      message:
        'MCP streamable HTTP connect failed for https://example.test/mcp; configured endpoint credentials were redacted.',
    });
    expect((error as Error & { code?: number }).code).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Error initializing MCP server:',
      error,
    );
  });

  test('should remove endpoint credentials from resource errors', async () => {
    const logger = createCapturingLogger();
    const unsafeError = createUnsafeTransportError();
    const server = new NodeMCPServerStreamableHttp({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });
    await server.connect();
    listResourcesImplementation = async () => {
      throw unsafeError;
    };

    const error = await server.listResources().catch((caught) => caught);

    expect(error).not.toBe(unsafeError);
    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expect((error as Error & { status?: number }).status).toBeUndefined();
    expectNoCredentialMarkers(error);
    await server.close();
  });

  test('should remove endpoint credentials from tool-call error graphs', async () => {
    const logger = createCapturingLogger();
    const unsafeError = createUnsafeTransportError();
    const server = new NodeMCPServerStreamableHttp({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });
    await server.connect();
    callToolImplementation = async () => {
      throw unsafeError;
    };

    const error = await server
      .callTool('unsafe-tool', {})
      .catch((caught) => caught);

    expect(error).not.toBe(unsafeError);
    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expect((error as Error & { status?: number }).status).toBeUndefined();
    expectNoCredentialMarkers(error);
    await server.close();
  });

  test('should sanitize errors thrown during recovery classification', async () => {
    const logger = createCapturingLogger();
    const server = new NodeMCPServerStreamableHttp({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });
    await server.connect();
    const classificationInput = new Error('placeholder');
    Object.defineProperty(classificationInput, 'message', {
      configurable: true,
      get: () => {
        throw new Error(CREDENTIAL_ENDPOINT);
      },
    });
    callToolImplementation = async () => {
      throw classificationInput;
    };

    const error = await server
      .callTool('unsafe-tool', {})
      .catch((caught) => caught);

    expect(error).toMatchObject({ name: 'MCPTransportError' });
    expectNoCredentialMarkers(error);
    await server.close();
  });

  test('should remove endpoint credentials from cleanup warnings', async () => {
    const logger = createCapturingLogger();
    const server = new NodeMCPServerStreamableHttp({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });
    await server.connect();
    terminateSessionImplementation = async () => {
      throw createUnsafeTransportError();
    };

    await server.close();

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to terminate MCP session:',
      expect.objectContaining({
        name: 'MCPTransportError',
      }),
    );
    const loggedError = logger.warn.mock.calls[0]?.[1] as
      (Error & { status?: number }) | undefined;
    expect(loggedError?.status).toBeUndefined();
    expectNoCredentialMarkers(logger.warn.mock.calls);
  });

  test('should not inspect cleanup errors when tool logging is disabled', async () => {
    const logger = createCapturingLogger();
    const server = new NodeMCPServerStreamableHttp({
      url: CREDENTIAL_ENDPOINT,
      logger,
    });
    await server.connect();
    let policyReads = 0;
    Object.defineProperty(logger, 'dontLogToolData', {
      get: () => {
        policyReads += 1;
        return policyReads === 1;
      },
    });
    let ownKeysReads = 0;
    const error = new Proxy(createUnsafeTransportError(), {
      ownKeys(target) {
        ownKeysReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    terminateSessionImplementation = async () => {
      throw error;
    };

    await server.close();

    expect(policyReads).toBe(1);
    expect(ownKeysReads).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to terminate MCP session:',
      'object',
    );
    expectNoCredentialMarkers(logger.warn.mock.calls);
  });

  test('should forward request options to session methods', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'test-stream-options',
      clientSessionTimeoutSeconds: 9,
    });

    await server.connect();
    await server.listTools();
    const controller = new AbortController();
    await server.callTool('mock-tool', {}, undefined, {
      signal: controller.signal,
    });

    expect(lastConnectOptions?.timeout).toBe(9000);
    expect(lastListToolsOptions?.timeout).toBe(9000);
    expect(lastCallToolOptions?.timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MSEC);
    expect(lastCallToolOptions?.signal).toBeDefined();
    expect(lastCallToolOptions?.signal).not.toBe(controller.signal);

    await server.close();
  });

  test('should redact cursors from later tool page errors', async () => {
    const opaqueCursor = 'SECRET_OPAQUE_CURSOR';
    const unsafeError = new Error(`Continuation failed for ${opaqueCursor}`);
    listToolsImplementation = async (params) => {
      if (params === undefined) {
        return {
          tools: [createMockTool('first-tool')],
          nextCursor: opaqueCursor,
        };
      }
      throw unsafeError;
    };
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.test/mcp',
      name: 'unsafe-tool-page',
    });

    await server.connect();
    const error = await server.listTools().catch((caught) => caught);

    expect(error).not.toBe(unsafeError);
    expect(error).toMatchObject({
      name: 'Error',
      message: 'MCP tool listing failed while fetching a continuation page.',
    });
    expect(getErrorGraphText(error)).not.toContain(opaqueCursor);
    expect(listToolsCalls.map((call) => call.params)).toEqual([
      undefined,
      { cursor: opaqueCursor },
    ]);

    const firstPageError = new Error('First page failed');
    listToolsImplementation = async () => {
      throw firstPageError;
    };
    await expect(server.listTools()).rejects.toBe(firstPageError);

    listToolsImplementation = async () => ({
      tools: [createMockTool('recovered-tool')],
    });
    expect((await server.listTools()).map((tool) => tool.name)).toEqual([
      'recovered-tool',
    ]);

    await server.close();
  });

  test('should preserve caller cancellation on credentialed endpoints without reconnecting', async () => {
    let markCallStarted: (() => void) | undefined;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    callToolImplementation = async (_params, options) => {
      markCallStarted?.();
      return new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('MCP SDK wrapped cancellation')),
          { once: true },
        );
      });
    };
    const server = new NodeMCPServerStreamableHttp({
      url: CREDENTIAL_ENDPOINT,
      name: 'cancel-without-reconnect',
    });
    await server.connect();
    const controller = new AbortController();
    const abortReason = new Error('caller cancelled');

    const pendingCall = server.callTool('mock-tool', {}, undefined, {
      signal: controller.signal,
    });
    await callStarted;
    controller.abort(abortReason);

    await expect(pendingCall).rejects.toBe(abortReason);
    expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    await server.close();
  });

  test('should return a serializable full tool result', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'test-stream-full-result',
    });

    await server.connect();

    expect(
      JSON.parse(JSON.stringify(await server.callToolResult('mock-tool', {}))),
    ).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { renderer: 'chart' },
      structuredContent: { answer: 42 },
      isError: true,
    });

    await server.close();
  });

  test('should expose the active session id after connect', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'test-stream-session',
    });

    expect(server.sessionId).toBeUndefined();

    await server.connect();

    expect(server.sessionId).toBe('generated-session-id');

    await server.close();

    expect(server.sessionId).toBeUndefined();
  });

  test('should forward resource requests to session methods', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'test-stream-resources',
      clientSessionTimeoutSeconds: 9,
    });

    await server.connect();
    await server.listResources({ cursor: 'resource-cursor' });
    await server.listResourceTemplates({ cursor: 'template-cursor' });
    await server.readResource('file:///mock-resource.txt');

    expect(lastListResourcesParams).toEqual({ cursor: 'resource-cursor' });
    expect(lastListResourcesOptions?.timeout).toBe(9000);
    expect(lastListResourceTemplatesParams).toEqual({
      cursor: 'template-cursor',
    });
    expect(lastListResourceTemplatesOptions?.timeout).toBe(9000);
    expect(lastReadResourceParams).toEqual({
      uri: 'file:///mock-resource.txt',
    });
    expect(lastReadResourceOptions?.timeout).toBe(9000);

    await server.close();
  });

  test('should terminate session during close with a detached transport', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'terminate-session',
    });

    const closeTransport = vi.fn().mockResolvedValue(undefined);
    const closeSession = vi.fn().mockResolvedValue(undefined);

    (server as any).transport = {
      getSessionId: vi.fn(() => 'session-123'),
      sessionId: 'session-123',
      close: closeTransport,
    };
    (server as any).session = { close: closeSession };

    await server.close();

    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(MockStreamableHTTPClientTransport.instances).toHaveLength(1);
    expect(
      MockStreamableHTTPClientTransport.instances[0].options.sessionId,
    ).toBe('session-123');
    expect(
      MockStreamableHTTPClientTransport.instances[0].terminateSessionMock,
    ).toHaveBeenCalledTimes(1);
  });

  test('should still close cleanly when transport lacks terminateSession', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'no-terminate',
    });

    const closeTransport = vi.fn().mockResolvedValue(undefined);
    const closeSession = vi.fn().mockResolvedValue(undefined);

    (server as any).transport = {
      close: closeTransport,
    };
    (server as any).session = { close: closeSession };

    await server.close();

    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  afterAll(() => {
    vi.clearAllMocks();
  });
});

describe('exported Node shim subclass compatibility', () => {
  class StdioSubclass extends ExportedStdio {
    connectionVersion = 123;
    pendingConnections = 'subclass pending';
    closingConnections = 'subclass closing';
    closeConnection = vi.fn(async () => {});
  }

  class SSESubclass extends ExportedSSE {
    connectionVersion = 123;
    pendingConnections = 'subclass pending';
    closingConnections = 'subclass closing';
    closeConnection = vi.fn(async () => {});
  }

  test.each([
    ['Stdio', () => new StdioSubclass({ command: 'test' })],
    ['SSE', () => new SSESubclass({ url: 'http://localhost' })],
  ] as const)(
    'preserves %s subclass members during connection cleanup',
    async (_name, createServer) => {
      const open = new Set<unknown>();
      connectImplementation = async (transport) => {
        open.add(transport);
        transport.close = async () => {
          open.delete(transport);
        };
      };
      const server = createServer();
      await server.connect();
      await server.connect();
      await server.close();

      expect(open.size).toBe(0);
      expect(server.connectionVersion).toBe(123);
      expect(server.pendingConnections).toBe('subclass pending');
      expect(server.closingConnections).toBe('subclass closing');
      expect(server.closeConnection).not.toHaveBeenCalled();
    },
  );
});

describe.each([
  [
    'SSE',
    () =>
      new NodeMCPServerSSE({
        url: 'https://example.test/sse',
        logger: createCapturingLogger(),
      }),
  ],
  [
    'stdio',
    () =>
      new NodeMCPServerStdio({
        command: 'test',
        logger: createCapturingLogger(),
      }),
  ],
] as const)('%s connection ownership', (_name, createServer) => {
  test('releases both transports after a reconnect and one close', async () => {
    const server = createServer();
    const open = new Set<unknown>();
    connectImplementation = async (transport) => {
      open.add(transport);
      transport.close = async () => {
        open.delete(transport);
      };
    };
    await server.connect();
    await server.connect();
    await server.close();
    expect(open.size).toBe(0);
  });

  test('discards a connection that finishes after close', async () => {
    const server = createServer();
    const started = createDeferred();
    const release = createDeferred();
    let open = false;
    connectImplementation = async (transport) => {
      transport.close = async () => {
        open = false;
      };
      open = true;
      started.resolve();
      await release.promise;
    };
    const pending = server.connect();
    await started.promise;
    await server.close();
    expect(open).toBe(false);
    release.resolve();
    await expect(pending).rejects.toThrow('changed during connect');
    expect(open).toBe(false);
    await expect(server.listTools()).rejects.toThrow('not initialized');
  });

  test('keeps the successful connection when an older connect fails', async () => {
    const server = createServer();
    const started = createDeferred();
    const release = createDeferred();
    connectImplementation = async () => {
      connectImplementation = undefined;
      started.resolve();
      await release.promise;
      throw new Error('first setup failed');
    };
    const first = server.connect();
    await started.promise;
    try {
      await server.connect();
      release.resolve();
      await expect(first).rejects.toThrow('first setup failed');
      expect((await server.listTools())[0].name).toBe('mock-tool');
    } finally {
      await server.close();
    }
  });
});

describe.each([
  [
    'SSE',
    () =>
      new NodeMCPServerSSE({
        url: 'https://example.test/sse',
        logger: createCapturingLogger(),
      }),
  ],
  [
    'stdio',
    () =>
      new NodeMCPServerStdio({
        command: 'test',
        logger: createCapturingLogger(),
      }),
  ],
  [
    'exported SSE',
    () =>
      new ExportedSSE({
        url: 'https://example.test/sse',
        logger: createCapturingLogger(),
      }),
  ],
  [
    'exported stdio',
    () =>
      new ExportedStdio({ command: 'test', logger: createCapturingLogger() }),
  ],
] as const)('%s pending handshake cleanup', (_name, createServer) => {
  test('closes a pending transport before its handshake settles and deduplicates failure cleanup', async () => {
    const server = createServer();
    const started = createDeferred();
    const release = createDeferred();
    const closeTransport = vi.fn(async () => {});
    const closeClient = vi.spyOn(MockClient.prototype, 'close');
    connectImplementation = async (transport) => {
      transport.close = closeTransport;
      started.resolve();
      await release.promise;
      throw new Error('cancelled handshake');
    };
    const outcome = server.connect().catch((error: Error) => error);
    try {
      await started.promise;
      await Promise.all([server.close(), server.close()]);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(closeClient).toHaveBeenCalledTimes(1);
      release.resolve();
      expect(await outcome).toMatchObject({
        message: expect.stringContaining('cancelled handshake'),
      });
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(closeClient).toHaveBeenCalledTimes(1);
      await expect(server.listTools()).rejects.toThrow('not initialized');
    } finally {
      release.resolve();
      await outcome;
      closeClient.mockRestore();
    }
  });

  test('can reconnect after disposing a handshake that never settles', async () => {
    const server = createServer();
    const started = createDeferred();
    const closeTransport = vi.fn(async () => {});
    connectImplementation = async (transport) => {
      connectImplementation = undefined;
      transport.close = closeTransport;
      started.resolve();
      await new Promise<void>(() => {});
    };
    void server.connect().catch(() => {});
    await started.promise;
    await server.close();
    expect(closeTransport).toHaveBeenCalledTimes(1);
    try {
      await server.connect();
      expect((await server.listTools())[0].name).toBe('mock-tool');
    } finally {
      await server.close();
    }
    expect(closeTransport).toHaveBeenCalledTimes(1);
  });

  test('closes every parallel pending attempt without waiting for the handshakes', async () => {
    const server = createServer();
    const bothStarted = createDeferred();
    const release = createDeferred();
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    connectImplementation = async (transport) => {
      const close = vi.fn(async () => {});
      closes.push(close);
      transport.close = close;
      if (closes.length === 2) bothStarted.resolve();
      await release.promise;
    };
    const first = server.connect().catch((error: Error) => error);
    const second = server.connect().catch((error: Error) => error);
    try {
      await bothStarted.promise;
      await server.close();
      expect(closes).toHaveLength(2);
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
      release.resolve();
      for (const outcome of await Promise.all([first, second])) {
        expect(outcome).toBeInstanceOf(Error);
        expect(outcome).toMatchObject({
          message: expect.stringContaining('changed during connect'),
        });
      }
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
  });

  test('keeps a new connection while an older pending cleanup is draining', async () => {
    const server = createServer();
    const started = createDeferred();
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const releaseHandshake = createDeferred();
    connectImplementation = async (transport) => {
      connectImplementation = undefined;
      transport.close = async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      };
      started.resolve();
      await releaseHandshake.promise;
      throw new Error('old handshake failed');
    };
    const oldConnect = server.connect().catch((error: Error) => error);
    let closing: Promise<void> | undefined;
    try {
      await started.promise;
      closing = server.close();
      await cleanupStarted.promise;
      await server.connect();
      releaseHandshake.resolve();
      releaseCleanup.resolve();
      await closing;
      expect(await oldConnect).toMatchObject({
        message: expect.stringContaining('old handshake failed'),
      });
      expect((await server.listTools())[0].name).toBe('mock-tool');
    } finally {
      releaseHandshake.resolve();
      releaseCleanup.resolve();
      await oldConnect;
      await closing;
      await server.close();
    }
  });

  test('drains all pending cleanup when one transport close rejects', async () => {
    const server = createServer();
    const bothStarted = createDeferred();
    const secondCleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const releaseHandshake = createDeferred();
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    connectImplementation = async (transport) => {
      const index = closes.length;
      const close = vi.fn(async () => {
        if (index === 0) throw new Error('close failed');
        secondCleanupStarted.resolve();
        await releaseCleanup.promise;
      });
      closes.push(close);
      transport.close = close;
      if (closes.length === 2) bothStarted.resolve();
      await releaseHandshake.promise;
      throw new Error('cancelled handshake');
    };
    const attempts = [server.connect(), server.connect()].map((attempt) =>
      attempt.catch((error: Error) => error),
    );
    let closing: Promise<unknown> | undefined;
    let settled = false;
    try {
      await bothStarted.promise;
      closing = server
        .close()
        .catch((error: Error) => error)
        .finally(() => {
          settled = true;
        });
      await secondCleanupStarted.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseCleanup.resolve();
      expect(await closing).toMatchObject({
        message: expect.stringContaining('close failed'),
      });
      releaseHandshake.resolve();
      for (const attempt of await Promise.all(attempts)) {
        expect(attempt).toMatchObject({
          message: expect.stringContaining('cancelled handshake'),
        });
      }
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    } finally {
      releaseCleanup.resolve();
      releaseHandshake.resolve();
      await closing;
      await Promise.all(attempts);
    }
  });

  test('lets a manager timeout dispose a pending handshake promptly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const server = createServer();
    const started = createDeferred();
    const release = createDeferred();
    const closeTransport = vi.fn(async () => {
      release.resolve();
    });
    connectImplementation = async (transport) => {
      transport.close = closeTransport;
      started.resolve();
      await release.promise;
      throw new Error('cancelled handshake');
    };
    try {
      const opening = connectMcpServers([server], {
        connectTimeoutMs: 5,
        closeTimeoutMs: 50,
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(5);
      const manager = await opening;
      expect(manager.failed).toEqual([server]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain('Failed to connect');
      await manager.close();
      expect(closeTransport).toHaveBeenCalledTimes(1);
      await expect(server.listTools()).rejects.toThrow('not initialized');
    } finally {
      release.resolve();
      await server.close();
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });
});

class ProtectedStdioOwner extends ExportedStdio {
  useClient(client: Client) {
    this.session = client;
  }
}

class ProtectedSSEOwner extends ExportedSSE {
  useClient(client: Client) {
    this.session = client;
  }
}

async function createOwnedClient(
  failure: 'before' | 'after' | 'none',
  beforeFirstClose?: () => Promise<void>,
  reusableClient?: Client,
) {
  const { Client } = await vi.importActual<
    typeof import('@modelcontextprotocol/client')
  >('@modelcontextprotocol/client');
  let attempts = 0;
  let open = true;
  const transport: Transport = {
    async start() {},
    async send(message) {
      if (!('method' in message) || !('id' in message) || message.id == null)
        return;
      const id = message.id;
      queueMicrotask(() =>
        transport.onmessage?.({
          jsonrpc: '2.0',
          id,
          ...(message.method === 'server/discover'
            ? { error: { code: -32601, message: 'Not supported' } }
            : {
                result:
                  message.method === 'initialize'
                    ? {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'synthetic', version: '1' },
                      }
                    : { tools: [] },
              }),
        }),
      );
    },
    async close() {
      attempts += 1;
      if (attempts === 1) {
        await beforeFirstClose?.();
        if (failure === 'before')
          throw new Error('transient client transport close failure');
      }
      open = false;
      transport.onclose?.();
      if (attempts === 1 && failure === 'after')
        throw new Error('close reported after release');
    },
  };
  const client =
    reusableClient ?? new Client({ name: 'protected-owner', version: '1' });
  await client.connect(transport);
  return {
    client,
    get attempts() {
      return attempts;
    },
    get open() {
      return open;
    },
  };
}

describe.each([
  [
    'stdio',
    () =>
      new ProtectedStdioOwner({
        command: 'unused',
        logger: createCapturingLogger(),
      }),
  ],
  [
    'SSE',
    () =>
      new ProtectedSSEOwner({
        url: 'https://example.test/sse',
        logger: createCapturingLogger(),
      }),
  ],
] as const)('%s protected Client cleanup', (_name, createServer) => {
  test('joins an active protected Client cleanup until resource release', async () => {
    const started = createDeferred();
    const release = createDeferred();
    const owned = await createOwnedClient('none', async () => {
      started.resolve();
      await release.promise;
    });
    const server = createServer();
    server.useClient(owned.client);
    const firstClose = server.close();
    await started.promise;
    let secondSettled = false;
    const secondClose = server.close().then(() => {
      secondSettled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondSettled).toBe(false);
      expect(owned.open).toBe(true);
      expect(owned.attempts).toBe(1);
    } finally {
      release.resolve();
      await Promise.all([firstClose, secondClose]);
      await owned.client.close();
    }
    expect(owned.open).toBe(false);
    expect(owned.attempts).toBe(1);
  });

  test.each([
    ['none', 'none'],
    ['before', 'none'],
    ['after', 'none'],
    ['none', 'before'],
    ['before', 'before'],
    ['after', 'before'],
  ] as const)(
    'closes a reused Client after %s then %s cleanup with concurrent callers',
    async (firstFailure, nextFailure) => {
      const first = await createOwnedClient(firstFailure);
      const server = createServer();
      server.useClient(first.client);
      if (firstFailure === 'none') await server.close();
      else await expect(server.close()).rejects.toThrow();
      if (firstFailure === 'before') await server.close();
      expect(first.open).toBe(false);
      const started = createDeferred();
      const release = createDeferred();
      const next = await createOwnedClient(
        nextFailure,
        async () => {
          started.resolve();
          await release.promise;
        },
        first.client,
      );
      server.useClient(next.client);
      const closing = server.close();
      await started.promise;
      let overlapSettled = false;
      const overlap = server.close().finally(() => {
        overlapSettled = true;
      });
      const results = Promise.allSettled([closing, overlap]);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(overlapSettled).toBe(false);
        expect(next.open).toBe(true);
        expect(next.attempts).toBe(1);
      } finally {
        release.resolve();
        await results;
      }
      if (nextFailure === 'before') {
        expect((await results).map((result) => result.status)).toEqual([
          'rejected',
          'rejected',
        ]);
        expect(next.open).toBe(true);
        await Promise.all([server.close(), server.close()]);
        expect(next.attempts).toBe(2);
      } else {
        expect((await results).map((result) => result.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        expect(next.attempts).toBe(1);
      }
      expect(next.open).toBe(false);
      await server.close();
      await first.client.close();
    },
  );

  test('retries still-owned cleanup only after another explicit close', async () => {
    const owned = await createOwnedClient('before');
    const server = createServer();
    server.useClient(owned.client);
    try {
      await expect(server.close()).rejects.toThrow(
        'transient client transport close failure',
      );
      expect(owned.open).toBe(true);
      expect(owned.attempts).toBe(1);
      await Promise.all([server.close(), server.close()]);
      expect(owned.open).toBe(false);
      expect(owned.attempts).toBe(2);
      await server.close();
      expect(owned.attempts).toBe(2);
    } finally {
      await owned.client.close();
    }
  });

  test('does not retain a failed close that already released its connection', async () => {
    const owned = await createOwnedClient('after');
    const server = createServer();
    server.useClient(owned.client);
    await expect(server.close()).rejects.toThrow(
      'close reported after release',
    );
    expect(owned.open).toBe(false);
    await server.close();
    expect(owned.attempts).toBe(1);
  });

  test('keeps a newer protected Client while failed cleanup awaits an explicit retry', async () => {
    const started = createDeferred();
    const release = createDeferred();
    const old = await createOwnedClient('before', async () => {
      started.resolve();
      await release.promise;
    });
    const newer = await createOwnedClient('none');
    const server = createServer();
    server.useClient(old.client);
    const firstClose = server.close().catch((error: Error) => error);
    try {
      await started.promise;
      server.useClient(newer.client);
      release.resolve();
      expect(await firstClose).toMatchObject({
        message: expect.stringContaining(
          'transient client transport close failure',
        ),
      });
      expect(old.open).toBe(true);
      expect(newer.open).toBe(true);
      expect(await server.listTools()).toEqual([]);
      await server.close();
      expect(old.open).toBe(false);
      expect(newer.open).toBe(false);
      expect(old.attempts).toBe(2);
      expect(newer.attempts).toBe(1);
    } finally {
      release.resolve();
      await firstClose;
      await old.client.close();
      await newer.client.close();
    }
  });
});

describe.each([
  ['SSE', NodeMCPServerSSE],
  ['Streamable HTTP', NodeMCPServerStreamableHttp],
] as const)('%s safe tool page-limit errors', (_name, Server) => {
  test('preserves local page-limit errors and still redacts transport UserErrors', async () => {
    const server = new Server({ url: CREDENTIAL_ENDPOINT, maxListPages: 1 });
    listToolsImplementation = async () => ({
      tools: [createMockTool('first-tool')],
      nextCursor: 'opaque-cursor',
    });
    await server.connect();
    try {
      const error = await server.listTools().catch((caught) => caught);
      expect(error).toBeInstanceOf(UserError);
      expect(error.message).toContain('exceeded maxListPages');
      expectNoCredentialMarkers(error);
      listToolsImplementation = async () => {
        throw new UserError(`Transport failed for ${CREDENTIAL_ENDPOINT}`);
      };
      const transportError = await server.listTools().catch((caught) => caught);
      expect(transportError.name).toBe('MCPTransportError');
      expect(transportError).not.toBeInstanceOf(UserError);
      expectNoCredentialMarkers(transportError);
    } finally {
      await server.close();
    }
  });
});
