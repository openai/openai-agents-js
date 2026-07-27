import { describe, test, expect, vi } from 'vitest';
import { MCPServerSSE, MCPServerStdio, MCPServerStreamableHttp } from '../src';

describe('MCPServerStdio', () => {
  test('should be available', () => {
    const server = new MCPServerStdio({
      name: 'test',
      fullCommand: 'test',
      cacheToolsList: true,
    });
    expect(server).toBeDefined();
    expect(server.name).toBe('test');
    expect(server.cacheToolsList).toBe(true);
  });

  test.each([
    [
      'stdio',
      () =>
        new MCPServerStdio({
          name: 'stdio',
          fullCommand: 'test',
        }),
    ],
    [
      'streamable HTTP',
      () =>
        new MCPServerStreamableHttp({
          name: 'streamable-http',
          url: 'https://example.com/mcp',
        }),
    ],
    [
      'SSE',
      () =>
        new MCPServerSSE({
          name: 'sse',
          url: 'https://example.com/sse',
        }),
    ],
  ])('forwards call options through the %s wrapper', async (_name, create) => {
    const callToolResult = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const server = create();
    (server as any).underlying = {
      callToolResult,
      sessionId: undefined,
    };
    const signal = new AbortController().signal;

    await server.callTool('mock-tool', {}, undefined, { signal });

    expect(callToolResult).toHaveBeenCalledWith('mock-tool', {}, undefined, {
      signal,
    });
  });
});
