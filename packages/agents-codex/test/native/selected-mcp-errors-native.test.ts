import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  TurnAborted,
  selectMcpTools,
  type ToolErrorFunction,
} from '../../src';
import { MCPServerStreamableHttp } from '@openai/agents/classic';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each(['custom', 'default', 'disabled', 'raise', 'cancel'] as const)(
  'keeps native %s failure policy on a real borrowed MCP client',
  async (policy) => {
    let effects = 0;
    let inventories = 0;
    const http = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (input.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (input.method === 'initialize')
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'borrowed', version: '1' },
        };
      else if (input.method === 'tools/list') {
        inventories++;
        result = {
          tools: [
            {
              name: 'lookup',
              description: 'Read',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          ],
        };
      } else if (input.method === 'server/discover') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: input.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
        return;
      } else {
        effects++;
        response
          .writeHead(500, { 'content-type': 'text/plain' })
          .end('PRIVATE_PEER_ERROR');
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    const client = new MCPServerStreamableHttp({
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    const context = { tenant: 'native-borrowed' };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fallback = vi.fn<ToolErrorFunction<typeof context>>(async (seen) => {
      expect(seen.context).toBe(context);
      expect(seen.callId).toBe('borrowed-failure');
      expect(seen.effectiveArguments).toEqual({ value: 'ok' });
      entered.resolve();
      if (policy === 'cancel') await release.promise;
      return 'native custom fallback';
    });
    const inherited = vi.fn(async (seen) => {
      expect(seen.context).toBe(context);
      return 'native default fallback';
    });
    const recovered = policy === 'custom' || policy === 'default';
    const model = new ModelServer([
      [
        call(
          'lookup',
          { value: 'ok' },
          { namespace: 'crm', callId: 'borrowed-failure' },
        ),
      ],
      ...(recovered ? [[message('recovered')]] : []),
    ]);
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    try {
      await client.connect();
      const [selected] = await selectMcpTools(
        { name: 'crm', server: client },
        { context },
      );
      const configured =
        policy === 'default'
          ? selected!
          : {
              ...selected!,
              errorFunction:
                policy === 'custom' || policy === 'cancel' ? fallback : null,
            };
      await using session = await new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Use lookup.',
        tools: [configured],
      }).session({
        context,
        toolErrorFormatter: policy === 'raise' ? undefined : inherited,
      });
      const turn = await session.submit('Read');
      const result = turn.wait();
      void result.catch(() => {});
      if (policy === 'cancel') {
        await entered.promise;
        const stopping = turn.cancel();
        release.resolve();
        await stopping;
        await expect(result).rejects.toBeInstanceOf(TurnAborted);
      } else if (recovered) {
        expect((await result).finalOutput).toBe('recovered');
        expect(JSON.stringify(model.requests[1])).toContain(
          policy === 'custom'
            ? 'native custom fallback'
            : 'native default fallback',
        );
        expect(JSON.stringify(model.requests[1])).not.toContain(
          'PRIVATE_PEER_ERROR',
        );
      } else await expect(result).rejects.toThrow();
      await session.close();
      await client.invalidateToolsCache();
      expect((await client.listTools())[0]!.name).toBe('lookup');
      expect(inventories).toBe(2);
      expect(effects).toBe(1);
      expect(fallback).toHaveBeenCalledTimes(
        policy === 'custom' || policy === 'cancel' ? 1 : 0,
      );
      expect(inherited).toHaveBeenCalledTimes(policy === 'default' ? 1 : 0);
      model.assertExhausted();
    } finally {
      await client.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  30_000,
);
