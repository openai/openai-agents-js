import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
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

class NegotiationProbeTransport {
  onmessage?: (message: unknown) => void;
  onerror?: (error: unknown) => void;
  onclose?: () => void;

  readonly sentMethods: string[] = [];
  sessionId?: string;
  protocolVersion?: string;

  constructor(private readonly era: 'legacy' | 'modern') {}

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async send(message: {
    id?: number;
    method?: string;
    params?: { cursor?: string };
  }): Promise<void> {
    this.sentMethods.push(message.method ?? `response:${message.id}`);
    if (message.id === undefined) {
      return;
    }

    if (message.method === 'server/discover') {
      if (this.era === 'legacy') {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        });
        return;
      }
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
        },
      });
      return;
    }

    if (message.method === 'initialize') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'legacy-probe-server', version: '1.0.0' },
        },
      });
      return;
    }

    if (message.method === 'tools/list') {
      const modernContinuation = message.params?.cursor === 'modern-next';
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result:
          this.era === 'modern'
            ? {
                resultType: 'complete',
                ttlMs: 0,
                cacheScope: 'private',
                tools: [
                  {
                    name: modernContinuation
                      ? 'modern-tool-2'
                      : 'modern-tool-1',
                    inputSchema: { type: 'object' },
                    ...(!modernContinuation
                      ? {
                          outputSchema: {
                            type: 'object',
                            properties: { message: { type: 'string' } },
                            required: ['message'],
                          },
                        }
                      : {}),
                  },
                ],
                ...(modernContinuation ? {} : { nextCursor: 'modern-next' }),
              }
            : {
                tools: [
                  {
                    name: 'legacy-tool',
                    inputSchema: { type: 'object' },
                  },
                ],
              },
      });
      return;
    }

    if (message.method === 'tools/call') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result:
          this.era === 'modern'
            ? {
                resultType: 'complete',
                content: [{ type: 'text', text: 'invalid structured result' }],
                structuredContent: { message: 123 },
              }
            : {
                content: [{ type: 'text', text: 'legacy result' }],
              },
      });
    }
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
          name: 'SdkError',
          code: 'REQUEST_TIMEOUT',
          message: 'probe abort',
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

describe('upstream MCP v2 protocol negotiation', () => {
  it('uses the 2026 protocol when server/discover succeeds', async () => {
    const transport = new NegotiationProbeTransport('modern');
    const client = new Client(
      { name: 'modern-probe-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );

    await client.connect(transport as any);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ['modern-tool-1', 'modern-tool-2'],
      );
      expect(transport.sentMethods).toEqual([
        'server/discover',
        'tools/list',
        'tools/list',
      ]);
    } finally {
      await client.close();
    }
  });

  it('falls back to the legacy initialize flow for an old server', async () => {
    const transport = new NegotiationProbeTransport('legacy');
    const client = new Client(
      { name: 'legacy-probe-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );

    await client.connect(transport as any);
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-06-18');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ['legacy-tool'],
      );
      expect(transport.sentMethods).toEqual([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    } finally {
      await client.close();
    }
  });

  it('preserves negotiated state and tool metadata across same-session reconnects', async () => {
    const firstTransport = new NegotiationProbeTransport('modern');
    const client = new Client(
      { name: 'resume-probe-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );

    await client.connect(firstTransport as any);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'modern-tool-1',
      'modern-tool-2',
    ]);
    firstTransport.sessionId = 'shared-session';
    await firstTransport.close();

    const resumedTransport = new NegotiationProbeTransport('modern');
    resumedTransport.sessionId = 'shared-session';
    await client.connect(resumedTransport as any);

    try {
      expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(resumedTransport.protocolVersion).toBe('2026-07-28');
      await expect(
        client.callTool({ name: 'modern-tool-1', arguments: {} }),
      ).rejects.toMatchObject({
        name: 'ProtocolError',
        code: -32602,
      });
      expect(resumedTransport.sentMethods).toEqual(['tools/call']);
    } finally {
      await client.close();
    }
  });
});
