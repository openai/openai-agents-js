import { describe, expect, it, vi } from 'vitest';
import { NodeMCPServerStreamableHttp } from '../../../src/shims/mcp-server/node';
import { allowConsole } from '../../../../../helpers/tests/console-guard';

function createTool(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

describe('MCP SDK v2 compatibility', () => {
  it('uses a pinned session without initialize and preserves one-page resource lists', async () => {
    const requests: Array<{ method: string; params?: { cursor?: string } }> =
      [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params?: { cursor?: string };
      };
      requests.push({ method: message.method, params: message.params });

      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }

      let result: Record<string, unknown>;
      switch (message.method) {
        case 'tools/list':
          result =
            message.params?.cursor === 'next-tools'
              ? { tools: [createTool('second-tool')] }
              : {
                  tools: [createTool('first-tool')],
                  nextCursor: 'next-tools',
                };
          break;
        case 'tools/call':
          result = {
            content: [{ type: 'text', text: 'called' }],
          };
          break;
        case 'resources/list':
          result = {
            resources: [{ uri: 'file:///first.txt', name: 'First resource' }],
            nextCursor: 'next-resources',
          };
          break;
        case 'resources/templates/list':
          result = {
            resourceTemplates: [
              {
                uriTemplate: 'file:///{name}.txt',
                name: 'Text resource',
              },
            ],
            nextCursor: 'next-templates',
          };
          break;
        default:
          throw new Error(`Unexpected MCP request: ${message.method}`);
      }

      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    };
    const server = new NodeMCPServerStreamableHttp({
      name: 'pinned-v2-client',
      url: 'https://example.test/mcp',
      sessionId: 'existing-session',
      fetch,
    });

    try {
      await server.connect();
      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'first-tool',
        'second-tool',
      ]);
      await expect(server.callTool('first-tool', {})).resolves.toEqual([
        { type: 'text', text: 'called' },
      ]);
      await expect(server.listResources()).resolves.toMatchObject({
        resources: [{ uri: 'file:///first.txt' }],
        nextCursor: 'next-resources',
      });
      await expect(server.listResourceTemplates()).resolves.toMatchObject({
        resourceTemplates: [{ uriTemplate: 'file:///{name}.txt' }],
        nextCursor: 'next-templates',
      });
      expect(requests.map((request) => request.method)).toEqual([
        'tools/list',
        'tools/list',
        'tools/call',
        'resources/list',
        'resources/templates/list',
      ]);
    } finally {
      await server.close();
    }
  });

  it('lists more than 64 tool pages for a pinned session', async () => {
    const pageCount = 65;
    const requestedCursors: Array<string | undefined> = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: { cursor?: string };
      };
      if (message.method !== 'tools/list') {
        throw new Error(`Unexpected MCP request: ${message.method}`);
      }

      const cursor = message.params?.cursor;
      requestedCursors.push(cursor);
      const page = cursor === undefined ? 0 : Number(cursor);
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [createTool(`tool-${page}`)],
          ...(page + 1 < pageCount ? { nextCursor: String(page + 1) } : {}),
        },
      });
    };
    const server = new NodeMCPServerStreamableHttp({
      name: 'large-pinned-tool-list',
      url: 'https://example.test/mcp',
      sessionId: 'existing-session',
      fetch,
    });

    await server.connect();
    try {
      const tools = await server.listTools();
      expect(tools).toHaveLength(pageCount);
      expect(tools[0]?.name).toBe('tool-0');
      expect(tools.at(-1)?.name).toBe('tool-64');
      expect(requestedCursors).toHaveLength(pageCount);
    } finally {
      await server.close();
    }
  });

  it('rejects repeated tool-list cursors for a pinned session', async () => {
    let listRequests = 0;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      if (message.method !== 'tools/list') {
        throw new Error(`Unexpected MCP request: ${message.method}`);
      }

      listRequests += 1;
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [createTool(`tool-${listRequests}`)],
          nextCursor: 'repeated-cursor',
        },
      });
    };
    const server = new NodeMCPServerStreamableHttp({
      name: 'repeated-pinned-tool-cursor',
      url: 'https://example.test/mcp',
      sessionId: 'existing-session',
      fetch,
    });

    await server.connect();
    try {
      await expect(server.listTools()).rejects.toThrow(
        'MCP server returned a repeated cursor while listing tools.',
      );
      expect(listRequests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('preserves modern header filtering across a same-session reconnect', async () => {
    const requests: string[] = [];
    let mirroredHeader: string | null = null;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      requests.push(message.method);
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }

      if (message.method === 'server/discover') {
        return Response.json({
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
      }
      if (message.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            tools: [
              {
                ...createTool('modern-tool'),
                inputSchema: {
                  type: 'object',
                  properties: {
                    token: {
                      type: 'string',
                      'x-mcp-header': 'X-Test-Token',
                    },
                  },
                  required: ['token'],
                  additionalProperties: false,
                },
              },
              {
                ...createTool('invalid-header-tool'),
                inputSchema: {
                  type: 'object',
                  properties: {
                    token: {
                      type: 'string',
                      'x-mcp-header': 'Bad Header',
                    },
                  },
                  required: ['token'],
                  additionalProperties: false,
                },
              },
            ],
          },
        });
      }
      if (message.method === 'tools/call') {
        mirroredHeader = new Headers(init?.headers).get(
          'Mcp-Param-X-Test-Token',
        );
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            content: [{ type: 'text', text: 'recovered modern call' }],
          },
        });
      }
      throw new Error(`Unexpected MCP request: ${message.method}`);
    };
    const server = new NodeMCPServerStreamableHttp({
      name: 'modern-resume-client',
      url: 'https://example.test/mcp',
      fetch,
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await server.connect();
    try {
      expect((await server.listTools()).map((tool) => tool.name)).toEqual([
        'modern-tool',
      ]);
      const originalTransport = (server as any).transport;
      originalTransport._sessionId = 'modern-session';
      await originalTransport.close();

      await expect(
        server.callTool('modern-tool', { token: 'header-value' }),
      ).resolves.toEqual([{ type: 'text', text: 'recovered modern call' }]);
      expect(server.sessionId).toBe('modern-session');
      expect(mirroredHeader).toBe('header-value');
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("excluding tool 'invalid-header-tool'"),
      );
      expect(requests).toEqual(['server/discover', 'tools/list', 'tools/call']);
    } finally {
      consoleWarn.mockRestore();
      await server.close();
    }
  });

  it('does not request unadvertised lists from a modern server', async () => {
    allowConsole(['debug']);
    const requests: string[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      requests.push(message.method);
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'server/discover') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            supportedVersions: ['2026-07-28'],
            capabilities: {},
          },
        });
      }
      throw new Error(`Unexpected MCP request: ${message.method}`);
    };
    const server = new NodeMCPServerStreamableHttp({
      name: 'modern-server-without-lists',
      url: 'https://example.test/mcp',
      fetch,
    });

    await server.connect();
    try {
      await expect(server.listTools()).resolves.toEqual([]);
      await expect(server.listResources()).resolves.toEqual({ resources: [] });
      await expect(server.listResourceTemplates()).resolves.toEqual({
        resourceTemplates: [],
      });
      expect(requests).toEqual(['server/discover']);
    } finally {
      await server.close();
    }
  });

  it('rejects required-task tools before and after a legacy same-session reconnect', async () => {
    const requests: string[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      requests.push(message.method);
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'server/discover') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      if (message.method === 'initialize') {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'legacy-server', version: '1.0.0' },
            },
          },
          { headers: { 'mcp-session-id': 'legacy-session' } },
        );
      }
      if (message.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              createTool('regular-tool'),
              {
                ...createTool('required-task-tool'),
                execution: { taskSupport: 'required' },
              },
            ],
          },
        });
      }
      if (message.method === 'tools/call') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: 'recovered legacy call' }],
          },
        });
      }
      throw new Error(`Unexpected MCP request: ${message.method}`);
    };
    const server = new NodeMCPServerStreamableHttp({
      name: 'legacy-task-resume-client',
      url: 'https://example.test/mcp',
      fetch,
    });

    await server.connect();
    await server.listTools();
    await expect(
      server.callTool('required-task-tool', {}),
    ).rejects.toMatchObject({
      name: 'ProtocolError',
      code: -32600,
    });
    await (server as any).transport.close();

    try {
      await expect(server.callTool('regular-tool', {})).resolves.toEqual([
        { type: 'text', text: 'recovered legacy call' },
      ]);
      await expect(
        server.callTool('required-task-tool', {}),
      ).rejects.toMatchObject({
        name: 'ProtocolError',
        code: -32600,
      });
      expect(requests).toEqual([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/list',
        'notifications/initialized',
        'tools/call',
      ]);
    } finally {
      await server.close();
    }
  });

  it('does not let a rejected tool listing populate v2 call metadata', async () => {
    let markListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    let resolveListResponse!: (response: Response) => void;
    const listResponse = new Promise<Response>((resolve) => {
      resolveListResponse = resolve;
    });
    let listRequestId: number | undefined;
    const requests: string[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      requests.push(message.method);
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'server/discover') {
        return Response.json({
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
      }
      if (message.method === 'tools/list') {
        listRequestId = message.id;
        markListStarted();
        return listResponse;
      }
      if (message.method === 'tools/call') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            content: [{ type: 'text', text: 'call completed' }],
            structuredContent: { message: 123 },
          },
        });
      }
      throw new Error(`Unexpected MCP request: ${message.method}`);
    };
    const server = new NodeMCPServerStreamableHttp({
      name: 'stale-list-client',
      url: 'https://example.test/mcp',
      fetch,
    });

    await server.connect();
    const listing = server.listTools();
    await listStarted;
    await server.invalidateToolsCache();
    resolveListResponse(
      Response.json({
        jsonrpc: '2.0',
        id: listRequestId,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          tools: [
            {
              ...createTool('stale-tool'),
              outputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
              },
            },
          ],
        },
      }),
    );

    try {
      await expect(listing).rejects.toThrow(
        'MCP tool listing became stale before it completed.',
      );
      await expect(server.callTool('stale-tool', {})).resolves.toEqual([
        { type: 'text', text: 'call completed' },
      ]);
      expect(requests).toEqual(['server/discover', 'tools/list', 'tools/call']);
    } finally {
      await server.close();
    }
  });
});
