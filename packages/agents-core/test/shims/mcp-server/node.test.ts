import { describe, test, expect, vi, afterAll, beforeAll } from 'vitest';
import {
  NodeMCPServerStdio,
  NodeMCPServerSSE,
} from '../../../src/shims/mcp-server/node';
import { TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types';

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
  connect(): Promise<void> {
    return Promise.resolve();
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

    await server.close();
  });

  test('should accept SSE server without custom fetch', async () => {
    const server = new NodeMCPServerSSE({
      url: 'https://example.com/sse',
      name: 'test-sse-server-no-fetch',
    });

    expect(server).toBeDefined();
    await server.connect();
    await server.close();
  });

  afterAll(() => {
    vi.clearAllMocks();
    capturedFetch = undefined;
  });
});
