import { describe, test, expect, vi, afterAll, beforeAll } from 'vitest';
import { NodeMCPServerStdio } from '../../../src/shims/mcp-server/node';
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
