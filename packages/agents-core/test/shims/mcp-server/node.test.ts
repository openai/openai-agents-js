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
import { TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol';
import type { Logger } from '../../../src/logger';
import { connectMcpServers } from '../../../src/mcpServers';

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
let callToolImplementation:
  ((params: any, resultSchema: any, options: any) => Promise<any>) | undefined;
let connectImplementation:
  ((transport: any, options: any) => Promise<void>) | undefined;
let listToolsImplementation:
  ((params: any, options: any) => Promise<any>) | undefined;
let listToolsCalls: Array<{ params: any; options: any }>;
let clientToolMetadataCacheCalls: any[][];
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
  callToolImplementation = undefined;
  connectImplementation = undefined;
  listToolsImplementation = undefined;
  listToolsCalls = [];
  clientToolMetadataCacheCalls = [];
  listResourcesImplementation = undefined;
  terminateSessionImplementation = undefined;
  retainCallToolSignalListener = false;
});

describe('NodeMCPServerStdio', () => {
  beforeAll(() => {
    vi.mock(
      '@modelcontextprotocol/sdk/client/stdio.js',
      async (importOriginal) => {
        return {
          ...(await importOriginal()),
          StdioClientTransport: MockStdioClientTransport,
        };
      },
    );
    vi.mock(
      '@modelcontextprotocol/sdk/client/index.js',
      async (importOriginal) => {
        return {
          ...(await importOriginal()),
          Client: MockClient,
        };
      },
    );
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
    await server.close();
  });

  test('installed MCP client should support aggregate tool metadata caching', async () => {
    const { Client } = await vi.importActual<
      typeof import('@modelcontextprotocol/sdk/client/index.js')
    >('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client({
      name: 'metadata-compatibility-test',
      version: '1.0.0',
    });

    expect(typeof (client as any).cacheToolMetadata).toBe('function');
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

    await server.close();
  });

  test('should preserve caller cancellation for in-flight tool calls', async () => {
    let markCallStarted: (() => void) | undefined;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    callToolImplementation = async (_params, _resultSchema, options) => {
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

    expect(clientToolMetadataCacheCalls).toEqual([]);

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
    expect(
      clientToolMetadataCacheCalls.map((tools) =>
        tools.map((tool) => tool.name),
      ),
    ).toEqual([['first-tool', 'second-tool']]);

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
    expect(clientToolMetadataCacheCalls).toEqual([]);

    listToolsImplementation = async () => ({
      tools: [createMockTool('refreshed-tool')],
    });
    expect((await server.listTools()).map((tool) => tool.name)).toEqual([
      'refreshed-tool',
    ]);

    await server.close();
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
    expect(clientToolMetadataCacheCalls).toEqual([]);

    listToolsImplementation = async () => ({
      tools: [createMockTool('new-session-tool')],
    });
    expect((await server.listTools()).map((tool) => tool.name)).toEqual([
      'new-session-tool',
    ]);

    await server.close();
  });

  test('should limit missing metadata caching failures to tool listing', async () => {
    const server = new NodeMCPServerStdio({
      name: 'missing-metadata-cache',
      fullCommand: 'test',
    });

    await server.connect();
    const session = (server as any).session;
    session.request = vi.fn(async () => ({
      tools: [createMockTool('uncommitted-tool')],
    }));
    session.cacheToolMetadata = undefined;

    const resources = await server.listResources();
    expect(resources.resources[0].uri).toBe('file:///mock-resource.txt');
    await expect(server.listTools()).rejects.toThrow(
      'The installed MCP SDK does not support tool metadata caching required for paginated tool listing.',
    );
    expect(session.request).not.toHaveBeenCalled();

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
    expect(lastListResourceTemplatesParams).toEqual({
      cursor: 'template-cursor',
    });
    expect(lastListResourceTemplatesOptions?.timeout).toBe(7000);
    expect(lastReadResourceParams).toEqual({
      uri: 'file:///mock-resource.txt',
    });
    expect(lastReadResourceOptions?.timeout).toBe(7000);

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
  constructor(options: { name: string; version: string }) {
    this.options = options;
  }
  connect(_transport: any, options?: any): Promise<void> {
    lastConnectOptions = options;
    if (connectImplementation) {
      return connectImplementation(_transport, options);
    }
    return Promise.resolve();
  }
  cacheToolMetadata(tools: any[]): void {
    clientToolMetadataCacheCalls.push(tools);
  }
  async request(request: any, _resultSchema: any, options?: any): Promise<any> {
    if (request.method !== 'tools/list') {
      throw new Error(`Unexpected request method: ${request.method}`);
    }
    const params = request.params;
    lastListToolsOptions = options;
    listToolsCalls.push({ params, options });
    return listToolsImplementation
      ? await listToolsImplementation(params, options)
      : { tools: [createMockTool('mock-tool')] };
  }
  callTool(_params: any, _resultSchema?: any, options?: any): Promise<any> {
    lastCallToolParams = _params;
    lastCallToolOptions = options;
    if (retainCallToolSignalListener && options?.signal) {
      options.signal.addEventListener('abort', () => {});
    }
    if (callToolImplementation) {
      return callToolImplementation(_params, _resultSchema, options);
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
  beforeAll(() => {
    vi.mock(
      '@modelcontextprotocol/sdk/client/sse.js',
      async (importOriginal) => {
        return {
          ...(await importOriginal()),
          SSEClientTransport: MockSSEClientTransport,
        };
      },
    );
    vi.mock(
      '@modelcontextprotocol/sdk/client/index.js',
      async (importOriginal) => {
        return {
          ...(await importOriginal()),
          Client: MockClient,
        };
      },
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
    expect(clientToolMetadataCacheCalls).toEqual([]);

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
    callToolImplementation = async (_params, _resultSchema, options) => {
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
  beforeAll(() => {
    vi.mock(
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
      async (importOriginal) => {
        return {
          ...(await importOriginal()),
          StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
        };
      },
    );
    vi.mock(
      '@modelcontextprotocol/sdk/client/index.js',
      async (importOriginal) => {
        return {
          ...(await importOriginal()),
          Client: MockClient,
        };
      },
    );
  });

  beforeEach(() => {
    MockStreamableHTTPClientTransport.instances = [];
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

  test('should redact cursors from later tool page errors and restore metadata', async () => {
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
    expect(clientToolMetadataCacheCalls.at(-1)).toEqual([]);

    await server.close();
  });

  test('should preserve caller cancellation on credentialed endpoints without reconnecting', async () => {
    let markCallStarted: (() => void) | undefined;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    callToolImplementation = async (_params, _resultSchema, options) => {
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
