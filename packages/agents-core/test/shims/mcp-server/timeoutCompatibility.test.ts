import { describe, expect, test, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import {
  NodeMCPServerStdio,
  NodeMCPServerSSE,
  NodeMCPServerStreamableHttp,
} from '../../../src/shims/mcp-server/node';

class StdioProbe extends NodeMCPServerStdio {
  readTimeout(): number {
    return this.timeout;
  }
  attachSession(session: Client): void {
    this.session = session;
  }
}
class SSEProbe extends NodeMCPServerSSE {
  readTimeout(): number {
    return this.timeout;
  }
  attachSession(session: Client): void {
    this.session = session;
  }
}
class HTTPProbe extends NodeMCPServerStreamableHttp {
  readTimeout(): number {
    return this.timeout;
  }
  attachSession(session: Client): void {
    this.session = session;
  }
}

const factories = [
  {
    name: 'stdio',
    create: (timeout?: number) =>
      new StdioProbe({ command: 'unused', timeout }),
  },
  {
    name: 'sse',
    create: (timeout?: number) =>
      new SSEProbe({ url: 'https://example.test/mcp', timeout }),
  },
  {
    name: 'streamable HTTP',
    create: (timeout?: number) =>
      new HTTPProbe({ url: 'https://example.test/mcp', timeout }),
  },
];

// The compatibility default is a pinned SDK contract, not a future upstream promise.
describe.each(factories)(
  '$name Classic timeout compatibility',
  ({ create }) => {
    test.each([
      { input: undefined, expected: 60_000 },
      { input: 0, expected: 0 },
      { input: 2_345, expected: 2_345 },
    ])(
      'retains constructor and tool-call timeout $expected',
      async ({ input, expected }) => {
        const server = create(input);
        const callTool = vi.fn(async () => ({
          content: [{ type: 'text', text: 'ok' }],
        }));
        const close = vi.fn(async () => {});
        server.attachSession({ callTool, close } as unknown as Client);
        try {
          // This assignment also checks the unchanged protected numeric subclass contract.
          const timeout: number = server.readTimeout();
          expect(timeout).toBe(expected);
          await expect(
            server.callToolResult('lookup', {}),
          ).resolves.toMatchObject({
            content: [{ type: 'text', text: 'ok' }],
          });
          expect(callTool).toHaveBeenCalledOnce();
          expect(callTool).toHaveBeenCalledWith(
            { name: 'lookup', arguments: {} },
            expect.objectContaining({ timeout: expected }),
          );
        } finally {
          await server.close();
        }
        expect(close).toHaveBeenCalledOnce();
      },
    );
  },
);
