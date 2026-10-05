import { describe, expect, it, vi } from 'vitest';
import { MCPServerStreamableHttp } from '../src';

describe('MCP streamable HTTP session cleanup', () => {
  it.each(['headers', 'body'] as const)(
    'bounds close and aborts a DELETE stalled at response %s',
    async (stallAt) => {
      let deleteSignal: AbortSignal | null | undefined;
      let releaseDelete = () => {};
      let notifyDeleteStarted = () => {};
      const deleteStarted = new Promise<void>((resolve) => {
        notifyDeleteStarted = resolve;
      });
      const logger = {
        namespace: 'mcp-close-test',
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        dontLogModelData: true,
        dontLogToolData: true,
      };
      const server = new MCPServerStreamableHttp({
        url: 'https://example.test/mcp',
        clientSessionTimeoutSeconds: 0.05,
        logger,
        fetch: async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'DELETE') {
            deleteSignal = init.signal;
            notifyDeleteStarted();
            if (stallAt === 'headers') {
              return new Promise<Response>((resolve, reject) => {
                releaseDelete = () => resolve(new Response(null));
                deleteSignal?.addEventListener(
                  'abort',
                  () => {
                    reject(deleteSignal?.reason);
                  },
                  { once: true },
                );
              });
            }
            return new Response(
              new ReadableStream({
                start(controller) {
                  releaseDelete = () => controller.close();
                  deleteSignal?.addEventListener(
                    'abort',
                    () => {
                      releaseDelete = () => {};
                      controller.error(deleteSignal?.reason);
                    },
                    { once: true },
                  );
                },
              }),
            );
          }
          if (init?.method === 'GET') {
            return new Response(null, { status: 405 });
          }
          const message = JSON.parse(String(init?.body));
          if (message.id === undefined) {
            return new Response(null, { status: 202 });
          }
          return Response.json(
            {
              jsonrpc: '2.0',
              id: message.id,
              result:
                message.method === 'initialize'
                  ? {
                      protocolVersion: '2025-06-18',
                      capabilities: { tools: {} },
                      serverInfo: { name: 'cleanup-test', version: '1.0.0' },
                    }
                  : { tools: [] },
            },
            { headers: { 'mcp-session-id': 'cleanup-session' } },
          );
        },
      });
      await server.connect();
      expect(server.sessionId).toBe('cleanup-session');
      vi.useFakeTimers();
      let closed = false;
      const closing = server.close().then(() => {
        closed = true;
      });
      try {
        await deleteStarted;
        await vi.advanceTimersByTimeAsync(49);
        expect(closed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(closed).toBe(true);
        expect(deleteSignal?.aborted).toBe(true);
        expect(server.sessionId).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        // A completed close must also release the public wrapper's lifecycle guard.
        await server.connect();
        await expect(server.listTools()).resolves.toEqual([]);
      } finally {
        releaseDelete();
        await closing;
        const cleanup = server.close();
        await vi.advanceTimersByTimeAsync(50);
        await cleanup;
        vi.useRealTimers();
      }
    },
  );

  it.each([200, 405])(
    'preserves completed termination with HTTP %s',
    async (status) => {
      const requests: string[] = [];
      let deleteSignal: AbortSignal | null | undefined;
      const server = new MCPServerStreamableHttp({
        url: 'https://example.test/mcp',
        sessionId: 'existing-session',
        fetch: async (_url: string | URL | Request, init?: RequestInit) => {
          requests.push(init?.method ?? 'GET');
          deleteSignal = init?.signal;
          return new Response(null, { status });
        },
      });
      await server.connect();
      await server.close();
      expect(requests).toEqual(['DELETE']);
      expect(deleteSignal?.aborted).toBe(true);
      expect(server.sessionId).toBeUndefined();
    },
  );
});
