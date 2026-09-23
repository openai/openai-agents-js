import { describe, expect, it, vi } from 'vitest';
import {
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
} from '../../../src/mcp';
import { UserError } from '../../../src/errors';

// Synthetic wire responses exercise the real client's negotiation and pagination.
function paginatedServer(
  era: 'modern' | 'legacy',
  maxListPages?: number,
  url = 'https://example.test/mcp',
) {
  const cursors: Array<string | undefined> = [];
  let terminalPage = 3;
  let failContinuation = false;
  let emptyFirstPage = false;
  let retryContinuation = false;
  let repeatCursor = false;
  const onUnauthorized = vi.fn(async () => {});
  const fetch = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params?: { cursor?: string };
      };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const complete = (result: Record<string, unknown>) =>
        Response.json(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              ...(era === 'modern'
                ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
                : {}),
              ...result,
            },
          },
          { headers: { 'mcp-session-id': 'page-limit-session' } },
        );
      if (message.method === 'server/discover') {
        if (era === 'legacy')
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          });
        return complete({
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {}, resources: {} },
        });
      }
      if (message.method === 'initialize')
        return complete({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'page-limit-server', version: '1.0.0' },
        });
      if (message.method === 'tools/list') {
        const cursor = message.params?.cursor;
        cursors.push(cursor);
        if (cursor !== undefined && retryContinuation) {
          retryContinuation = false;
          return new Response(null, { status: 401 });
        }
        // Keep regressions finite even before the implementation enforces the cap.
        if (cursors.length > 70)
          throw new Error('Synthetic page guard reached.');
        if (cursor !== undefined && failContinuation)
          throw new Error('Synthetic page failure.');
        const page = cursor === undefined ? 1 : Number(cursor);
        return complete({
          tools:
            emptyFirstPage && page === 1
              ? []
              : [
                  {
                    name: `tool-${page}`,
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
          ...(page < terminalPage
            ? {
                nextCursor:
                  repeatCursor && cursor !== undefined
                    ? cursor
                    : String(page + 1),
              }
            : {}),
        });
      }
      if (message.method === 'resources/list')
        return complete({
          resources: [{ name: 'sample', uri: 'file:///sample.txt' }],
          nextCursor: 'next-resource',
        });
      if (message.method === 'resources/templates/list')
        return complete({
          resourceTemplates: [
            { name: 'sample', uriTemplate: 'file:///{name}' },
          ],
          nextCursor: 'next-template',
        });
      throw new Error(`Unexpected method: ${message.method}`);
    },
  );
  const options = {
    url,
    fetch,
    maxListPages,
    cacheToolsList: true,
    authProvider: { token: async () => undefined, onUnauthorized },
  };
  const server = new MCPServerStreamableHttp(options);
  return {
    server,
    options,
    cursors,
    onUnauthorized,
    repeatCursor() {
      repeatCursor = true;
    },
    retryContinuation() {
      retryContinuation = true;
    },
    terminalAt(page: number) {
      terminalPage = page;
    },
    failContinuation() {
      failContinuation = true;
    },
    emptyFirstPage() {
      emptyFirstPage = true;
    },
  };
}

describe.each(['modern', 'legacy'] as const)(
  '%s MCP tool page limits',
  (era) => {
    it.each([1, 2])(
      'accepts a terminal page at the limit %i and preserves the cache policy',
      async (limit) => {
        const fixture = paginatedServer(era, limit);
        fixture.terminalAt(limit);
        await fixture.server.connect();
        try {
          const names = limit === 1 ? ['tool-1'] : ['tool-1', 'tool-2'];
          expect(
            (await fixture.server.listTools()).map((tool) => tool.name),
          ).toEqual(names);
          expect(
            (await fixture.server.listTools()).map((tool) => tool.name),
          ).toEqual(names);
          // Modern stateless wrappers intentionally refetch on each public call.
          expect(fixture.cursors).toHaveLength(
            era === 'modern' ? limit * 2 : limit,
          );
        } finally {
          await fixture.server.close();
        }
      },
    );

    it('rejects further pagination without requesting or caching partial tools', async () => {
      const fixture = paginatedServer(era, 2);
      fixture.terminalAt(70);
      await fixture.server.connect();
      try {
        await expect(fixture.server.listTools()).rejects.toThrow(UserError);
        expect(fixture.cursors).toEqual([undefined, '2']);
        fixture.terminalAt(1);
        expect(
          (await fixture.server.listTools()).map((tool) => tool.name),
        ).toEqual(['tool-1']);
        expect(fixture.cursors).toEqual([undefined, '2', undefined]);
        await fixture.server.listTools();
        expect(fixture.cursors).toHaveLength(era === 'modern' ? 4 : 3);
      } finally {
        await fixture.server.close();
      }
    });

    it('preserves the safe page-limit error for endpoints requiring redaction', async () => {
      const endpoint = new URL('https://example.test/mcp');
      endpoint.username = 'user_marker';
      endpoint.password = 'password_marker';
      endpoint.searchParams.set('token', 'query_marker');
      endpoint.hash = 'fragment_marker';
      const fixture = paginatedServer(era, 1, endpoint.toString());
      await fixture.server.connect();
      try {
        const error = await fixture.server
          .listTools()
          .catch((caught) => caught);
        expect(error).toBeInstanceOf(UserError);
        expect(error.message).toContain('exceeded maxListPages');
        expect(error.cause).toBeUndefined();
        expect(String(error.stack)).not.toContain('_marker');
        expect(fixture.cursors).toEqual([undefined]);
        fixture.terminalAt(1);
        await expect(fixture.server.listTools()).resolves.toMatchObject([
          { name: 'tool-1' },
        ]);
        expect(fixture.cursors).toEqual([undefined, undefined]);
      } finally {
        await fixture.server.close();
      }
    });

    it.each([undefined, 2])(
      'preserves existing repeated-cursor behavior with limit %s',
      async (limit) => {
        const fixture = paginatedServer(era, limit);
        fixture.repeatCursor();
        await fixture.server.connect();
        try {
          if (era === 'modern') {
            await expect(fixture.server.listTools()).resolves.toMatchObject([
              { name: 'tool-1' },
              { name: 'tool-2' },
            ]);
          } else {
            await expect(fixture.server.listTools()).rejects.toThrow(
              'repeated cursor',
            );
          }
          expect(fixture.cursors).toEqual([undefined, '2']);
        } finally {
          await fixture.server.close();
        }
      },
    );

    it.each([2, 3])(
      'preserves the successful-page budget across a transport auth retry (terminal page %i)',
      async (terminalPage) => {
        const fixture = paginatedServer(era, 2);
        fixture.terminalAt(terminalPage);
        fixture.retryContinuation();
        await fixture.server.connect();
        try {
          if (terminalPage === 2) {
            await expect(fixture.server.listTools()).resolves.toMatchObject([
              { name: 'tool-1' },
              { name: 'tool-2' },
            ]);
          } else {
            await expect(fixture.server.listTools()).rejects.toThrow(
              'exceeded maxListPages',
            );
          }
          expect(fixture.cursors).toEqual([undefined, '2', '2']);
          expect(fixture.onUnauthorized).toHaveBeenCalledTimes(1);
        } finally {
          await fixture.server.close();
        }
      },
    );

    it('counts an empty continuation page toward the limit', async () => {
      const fixture = paginatedServer(era, 1);
      fixture.emptyFirstPage();
      await fixture.server.connect();
      try {
        await expect(fixture.server.listTools()).rejects.toThrow(
          'exceeded maxListPages',
        );
        expect(fixture.cursors).toEqual([undefined]);
        fixture.terminalAt(1);
        await expect(fixture.server.listTools()).resolves.toEqual([]);
      } finally {
        await fixture.server.close();
      }
    });

    it('leaves omitted limits unlimited beyond the native default of 64 pages', async () => {
      const fixture = paginatedServer(era);
      fixture.terminalAt(65);
      await fixture.server.connect();
      try {
        const tools = await fixture.server.listTools();
        expect(tools).toHaveLength(65);
        expect(tools.at(-1)?.name).toBe('tool-65');
        expect(fixture.cursors).toHaveLength(65);
      } finally {
        await fixture.server.close();
      }
    });

    it('does not turn a continuation request failure into a partial success', async () => {
      const fixture = paginatedServer(era, 2);
      fixture.failContinuation();
      await fixture.server.connect();
      try {
        await expect(fixture.server.listTools()).rejects.toThrow();
        expect(fixture.cursors).toEqual([undefined, '2']);
        fixture.terminalAt(1);
        await expect(fixture.server.listTools()).resolves.toMatchObject([
          { name: 'tool-1' },
        ]);
        expect(fixture.cursors).toEqual([undefined, '2', undefined]);
      } finally {
        await fixture.server.close();
      }
    });

    it('retains construction-time limits across reconnect and ignores later option mutation', async () => {
      const fixture = paginatedServer(era, 1);
      fixture.options.maxListPages = 10;
      await fixture.server.connect();
      try {
        await expect(fixture.server.listTools()).rejects.toThrow(
          'exceeded maxListPages',
        );
        await fixture.server.close();
        await fixture.server.connect();
        await expect(fixture.server.listTools()).rejects.toThrow(
          'exceeded maxListPages',
        );
        expect(fixture.cursors).toEqual([undefined, undefined]);
      } finally {
        await fixture.server.close();
      }
    });

    it('preserves caller-controlled resource pagination', async () => {
      const fixture = paginatedServer(era, 1);
      await fixture.server.connect();
      try {
        await expect(fixture.server.listResources()).resolves.toMatchObject({
          nextCursor: 'next-resource',
        });
        await expect(
          fixture.server.listResources({ cursor: 'next-resource' }),
        ).resolves.toMatchObject({ nextCursor: 'next-resource' });
        await expect(
          fixture.server.listResourceTemplates(),
        ).resolves.toMatchObject({ nextCursor: 'next-template' });
        await expect(
          fixture.server.listResourceTemplates({ cursor: 'next-template' }),
        ).resolves.toMatchObject({ nextCursor: 'next-template' });
      } finally {
        await fixture.server.close();
      }
    });
  },
);

describe('MCP page limit configuration', () => {
  const constructors = [
    (limit: number) =>
      new MCPServerStdio({ command: 'synthetic', maxListPages: limit }),
    (limit: number) =>
      new MCPServerStdio({ fullCommand: 'synthetic', maxListPages: limit }),
    (limit: number) =>
      new MCPServerSSE({
        url: 'https://example.test/sse',
        maxListPages: limit,
      }),
    (limit: number) =>
      new MCPServerStreamableHttp({
        url: 'https://example.test/mcp',
        maxListPages: limit,
      }),
  ];
  it.each([0, -1, 1.5])(
    'rejects %s synchronously in all public constructors',
    (limit) => {
      for (const construct of constructors) {
        expect(() => construct(limit)).toThrow(
          'maxListPages must be a positive integer',
        );
      }
    },
  );
});
