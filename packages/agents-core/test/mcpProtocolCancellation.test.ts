import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

class ProbeTransport {
  onmessage?: (message: unknown) => void;
  onerror?: (error: unknown) => void;
  onclose?: () => void;

  sentMethods: string[] = [];
  cancelledRequestIds: number[] = [];
  private responseTimers = new Map<number, ReturnType<typeof setTimeout>>();

  async start(): Promise<void> {}

  async close(): Promise<void> {
    for (const timer of this.responseTimers.values()) {
      clearTimeout(timer);
    }
    this.responseTimers.clear();
    this.onclose?.();
  }

  async send(message: {
    id?: number;
    method?: string;
    params?: { requestId?: number };
  }): Promise<void> {
    this.sentMethods.push(message.method ?? `response:${message.id}`);

    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      if (requestId !== undefined) {
        this.cancelledRequestIds.push(requestId);
        const timer = this.responseTimers.get(requestId);
        if (timer) {
          clearTimeout(timer);
          this.responseTimers.delete(requestId);
        }
      }
      return;
    }

    if (message.method === 'notifications/initialized') {
      return;
    }

    if (message.method === 'initialize' && message.id !== undefined) {
      const timer = setTimeout(() => {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'probe-server', version: '1.0.0' },
          },
        });
        this.responseTimers.delete(message.id!);
      }, 0);
      this.responseTimers.set(message.id, timer);
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const responseDelay = message.method === 'slow' ? 40 : 5;
    const timer = setTimeout(() => {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: { ok: `${message.method}-done` },
      });
      this.responseTimers.delete(message.id!);
    }, responseDelay);
    this.responseTimers.set(message.id, timer);
  }
}

describe('upstream MCP request cancellation characterization', () => {
  it('cancels only the aborted request and lets siblings complete', async () => {
    const transport = new ProbeTransport();
    const client = new Client({ name: 'probe-client', version: '1.0.0' });
    await client.connect(transport as any);

    try {
      const resultSchema = z.object({
        ok: z.string(),
      }) as unknown as Parameters<Client['request']>[1];
      const slowController = new AbortController();
      const slowPromise = client.request({ method: 'slow' }, resultSchema, {
        signal: slowController.signal,
      });
      const fastPromise = client.request({ method: 'fast' }, resultSchema);

      setTimeout(() => slowController.abort('probe abort'), 10);

      const [slowResult, fastResult] = await Promise.allSettled([
        slowPromise,
        fastPromise,
      ]);

      expect(slowResult).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({
          name: 'McpError',
          code: -32001,
          message: 'MCP error -32001: probe abort',
        }),
      });
      expect(fastResult).toEqual({
        status: 'fulfilled',
        value: { ok: 'fast-done' },
      });
      expect(transport.cancelledRequestIds).toEqual([1]);
      expect(transport.sentMethods).toEqual([
        'initialize',
        'notifications/initialized',
        'slow',
        'fast',
        'notifications/cancelled',
      ]);
    } finally {
      await client.close();
    }
  });
});
