import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { Agent, HttpMCP, NativeProvider } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it.each([
  'deny',
  'allow',
  'start-failure',
  'end-failure',
  'start-cancel',
  'pending-restore',
] as const)(
  'observes exact raw MCP at its admitted durable boundary (%s)',
  async (mode) => {
    const allowed = mode !== 'deny';
    const failure = new Error(`raw MCP observer ${mode}`);
    let cancellation: Promise<void> | undefined;
    const effects: unknown[] = [],
      peerFailures: unknown[] = [];
    const peer = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        let bytes = '';
        for await (const chunk of request) bytes += chunk;
        const rpc = JSON.parse(bytes);
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = {};
        if (rpc.method === 'initialize')
          result = {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'raw-native-observer-peer', version: '1' },
          };
        if (rpc.method === 'tools/list')
          result = {
            tools: [
              {
                name: 'lookup',
                description: 'A real raw native MCP operation.',
                inputSchema: {
                  type: 'object',
                  properties: { key: { type: 'string' } },
                  required: ['key'],
                  additionalProperties: false,
                },
              },
            ],
          };
        if (rpc.method === 'tools/call') {
          effects.push(rpc.params);
          result = { content: [{ type: 'text', text: 'raw native result' }] };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      } catch (error) {
        peerFailures.push(error);
        response.writeHead(500).end();
      }
    });
    peer.listen(0, '127.0.0.1');
    await once(peer, 'listening');
    const address = peer.address();
    if (!address || typeof address === 'string')
      throw Error('Missing peer address');
    const server = new ModelServer([
      [
        call(
          'lookup',
          { key: 'value' },
          { namespace: 'mcp__fixture', callId: 'raw-native-call' },
        ),
      ],
      [message('done')],
    ]);
    const config = await server.config();
    const application = { owner: 'raw-native-observer' };
    const seen: string[] = [];
    const runSeen: string[] = [];
    try {
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic',
        supportsWebsockets: false,
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use lookup once.',
        tools: [
          new HttpMCP({
            name: 'fixture',
            url: `http://127.0.0.1:${address.port}/mcp`,
            tools: ['lookup'],
            toolApprovalOverrides: { lookup: 'prompt' },
          }),
        ],
        onToolLifecycle(event) {
          expect(event.context).toBe(application);
          expect(event.agent).toBe(agent);
          expect(event.callId).toBe('raw-native-call');
          expect(event.tool).toEqual({
            name: 'lookup',
            namespace: 'mcp__fixture',
          });
          expect(event.arguments).toEqual({ key: 'value' });
          seen.push(event.kind);
          if (event.kind === 'end') {
            expect(event.status).toBe('completed');
            expect(event.output?.success).toBe(true);
            expect(JSON.stringify(event.output?.contentItems)).toContain(
              'raw native result',
            );
          }
          if (mode === `${event.kind}-failure`) throw failure;
          if (mode === 'start-cancel' && event.kind === 'start')
            cancellation = turn.cancel();
        },
      });
      await using session = await agent.session({
        context: application,
        onToolLifecycle(event) {
          expect(event.context).toBe(application);
          expect(event.agent).toBe(agent);
          expect(event.arguments).toEqual({ key: 'value' });
          runSeen.push(event.kind);
          if (
            event.arguments &&
            typeof event.arguments === 'object' &&
            !Array.isArray(event.arguments)
          )
            event.arguments.key = 'observer-only';
        },
      });
      const turn = await session.submit('Lookup.');
      const pending = await turn.wait({ until: 'interaction' });
      if (
        !('requests' in pending) ||
        pending.requests[0]?.type !== 'approval_request'
      )
        throw Error('Expected actual native MCP approval');
      if (mode === 'pending-restore') {
        expect(seen).toEqual([]);
        expect(effects).toEqual([]);
        const saved = JSON.parse(JSON.stringify(await session.suspend()));
        await expect(turn.wait()).rejects.toThrow();
        await using restored = await agent.session({
          context: application,
          state: saved,
        });
        const recovered = restored.restoredTurn;
        if (!recovered) throw new Error('Missing restored native MCP root');
        const reopened = await recovered.wait({ until: 'interaction' });
        if (
          !('requests' in reopened) ||
          reopened.requests[0]?.type !== 'approval_request'
        )
          throw new Error('Missing restored native MCP approval');
        expect(seen).toEqual([]);
        expect(effects).toEqual([]);
        await restored.respond(reopened.requests[0].reply('allow_once'));
        expect((await recovered.wait()).finalOutput).toBe('done');
        expect(seen).toEqual(['start', 'end']);
        expect(runSeen).toEqual([]);
        expect(effects).toHaveLength(1);
        expect(server.requests).toHaveLength(2);
        expect(peerFailures).toEqual([]);
        expect(
          (await restored.historySnapshot()).items.filter(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'raw-native-call',
          ),
        ).toHaveLength(1);
        return;
      }
      const beforeApproval = [...seen];
      expect(effects).toEqual([]);
      await session.respond(
        pending.requests[0].reply(allowed ? 'allow_once' : 'deny'),
      );
      if (mode === 'start-failure' || mode === 'end-failure')
        await expect(turn.wait()).rejects.toBe(failure);
      else if (mode === 'start-cancel')
        await expect(turn.wait()).rejects.toThrow();
      else expect((await turn.wait()).finalOutput).toBe('done');
      await cancellation;
      const observations = await Array.fromAsync(
        turn.events({ includeExecutionDetails: true }),
      );
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_started',
            family: 'mcp',
            name: 'lookup',
          }),
        ]),
      );
      expect(peerFailures).toEqual([]);
      expect(effects).toHaveLength(
        mode === 'allow' || mode === 'end-failure' ? 1 : 0,
      );
      expect(server.requests).toHaveLength(
        mode === 'allow' || mode === 'deny' ? 2 : 1,
      );
      expect(beforeApproval).toEqual([]);
      expect(seen).toEqual(
        mode === 'deny'
          ? []
          : mode === 'allow' || mode === 'end-failure'
            ? ['start', 'end']
            : ['start'],
      );
      expect(runSeen).toEqual(seen);
      if (effects.length)
        expect(effects[0]).toMatchObject({
          name: 'lookup',
          arguments: { key: 'value' },
        });
      const outputs = (await session.historySnapshot()).items.filter(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'raw-native-call',
      );
      if (mode !== 'start-cancel')
        expect(outputs).toHaveLength(mode === 'start-failure' ? 0 : 1);
      if (mode === 'end-failure') {
        const saved = JSON.parse(JSON.stringify(await session.saveState()));
        await session.close();
        await using restored = await agent.session({
          context: application,
          state: saved,
        });
        expect(
          (await (await restored.submit('Continue.')).wait()).finalOutput,
        ).toBe('done');
        expect(effects).toHaveLength(1);
        expect(seen).toEqual(['start', 'end']);
        expect(
          (await restored.historySnapshot()).items.filter(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'raw-native-call',
          ),
        ).toHaveLength(1);
      }
    } finally {
      peer.closeAllConnections();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  },
);
