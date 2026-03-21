import {
  describe,
  test,
  expect,
  vi,
  afterAll,
  beforeAll,
  beforeEach,
} from 'vitest';
import {
  NodeMCPServerStdio,
  NodeMCPServerSSE,
  NodeMCPServerStreamableHttp,
} from '../../../src/shims/mcp-server/node';
import { TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol';

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
    await server.callTool('mock-tool', {});

    expect(lastConnectOptions?.timeout).toBe(6000);
    expect(lastListToolsOptions?.timeout).toBe(6000);
    expect(lastCallToolOptions?.timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MSEC);

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
    return Promise.resolve();
  }
  listTools(_params?: any, options?: any): Promise<any> {
    lastListToolsOptions = options;
    return Promise.resolve({
      tools: [
        {
          name: 'mock-tool',
          description: 'Mock tool',
          inputSchema: {
            type: 'object',
          },
        },
      ],
    });
  }
  callTool(_params: any, _resultSchema?: any, options?: any): Promise<any> {
    lastCallToolParams = _params;
    lastCallToolOptions = options;
    return Promise.resolve({
      content: [{ type: 'text', text: 'ok' }],
    });
  }
  listResources(params?: any, options?: any): Promise<any> {
    lastListResourcesParams = params;
    lastListResourcesOptions = options;
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

  test('should pass request options to session calls', async () => {
    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'test-sse-options',
      clientSessionTimeoutSeconds: 4,
    });

    await server.connect();
    await server.listTools();
    await server.callTool('mock-tool', {});

    expect(lastConnectOptions?.timeout).toBe(4000);
    expect(lastListToolsOptions?.timeout).toBe(4000);
    expect(lastCallToolOptions?.timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MSEC);

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

  test('should forward request options to session methods', async () => {
    const server = new NodeMCPServerStreamableHttp({
      url: 'https://example.com/stream',
      name: 'test-stream-options',
      clientSessionTimeoutSeconds: 9,
    });

    await server.connect();
    await server.listTools();
    await server.callTool('mock-tool', {});

    expect(lastConnectOptions?.timeout).toBe(9000);
    expect(lastListToolsOptions?.timeout).toBe(9000);
    expect(lastCallToolOptions?.timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MSEC);

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
