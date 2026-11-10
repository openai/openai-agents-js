import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { Agent, HttpMCP, NativeProvider } from '../src';
import { ModelServer, call, message } from './native/fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

async function peer(toolNames = ['lookup']) {
  const effects: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let rpc;
    try {
      rpc = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc)) {
      response.writeHead(400).end();
      return;
    }
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'replacement-policy', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: toolNames.map((name) => ({
          name,
          description: 'Read a record.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        })),
      };
    else if (rpc.method === 'tools/call') {
      effects.push(rpc.params);
      result = { content: [{ type: 'text', text: 'record' }] };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP peer');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    effects,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

it.each([
  ['GET', '/mcp', undefined, 405],
  ['DELETE', '/mcp', undefined, 405],
  ['POST', '/missing', '{}', 404],
  ['POST', '/mcp', '', 400],
  ['POST', '/mcp', '{', 400],
  ['POST', '/mcp', 'null', 400],
  ['POST', '/mcp', '[]', 400],
] as const)(
  'MCP fixture handles %s %s with body %j as HTTP %i',
  async (method, path, body, status) => {
    const remote = await peer();
    try {
      const response = await fetch(new URL(path, remote.url), { method, body });
      expect(response.status).toBe(status);
      if (status === 405) expect(response.headers.get('allow')).toBe('POST');
      expect(remote.effects).toHaveLength(0);
    } finally {
      await remote.close();
    }
  },
);

it('MCP fixture accepts JSON-RPC requests and notifications', async () => {
  const remote = await peer();
  const post = (body: unknown) =>
    fetch(remote.url, { method: 'POST', body: JSON.stringify(body) });
  try {
    const initialized = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } },
    });
    const notified = await post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notified.status).toBe(202);
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(await listed.json()).toMatchObject({
      id: 2,
      result: { tools: [expect.objectContaining({ name: 'lookup' })] },
    });
    const params = { name: 'lookup', arguments: {} };
    const called = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params,
    });
    expect(await called.json()).toMatchObject({
      id: 3,
      result: { content: [{ type: 'text', text: 'record' }] },
    });
    expect(remote.effects).toEqual([params]);
  } finally {
    await remote.close();
  }
});

nativeIt(
  'keeps retained response callbacks separate from accepted replacement callbacks',
  async () => {
    const remote = await peer();
    const model = new ModelServer([
      [
        call(
          'lookup',
          {},
          { callId: 'new-source-call', namespace: 'mcp__records' },
        ),
      ],
      [message('reused')],
    ]);
    const websocket = new WebSocketServer({ noServer: true });
    const frames: Record<string, any>[] = [];
    let socket: WebSocket | undefined;
    let accepted: Record<string, any> = {};
    model.onUpgrade((request, transport, head) =>
      websocket.handleUpgrade(request, transport, head, (connection) =>
        websocket.emit('connection', connection),
      ),
    );
    websocket.on('connection', (connection) => {
      socket = connection;
      connection.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        if (frame.type === 'session.update') {
          accepted = { ...accepted, ...frame.session };
          connection.send(
            JSON.stringify({
              type: 'session.updated',
              session: { ...accepted, id: 'retained-policy' },
            }),
          );
        }
      });
    });
    const originalBefore = vi.fn(() => ({ action: 'allow' as const }));
    const replacementBefore = vi.fn(() => ({ action: 'stop' as const }));
    const originalResult = vi.fn(() => ({
      content: [{ type: 'text' as const, text: 'original result policy' }],
    }));
    const replacementResult = vi.fn(() => ({
      content: [{ type: 'text' as const, text: 'replacement result policy' }],
    }));
    const descriptor = (fresh: boolean) =>
      new HttpMCP({
        name: 'records',
        url: remote.url,
        tools: ['lookup'],
        approvalMode: 'preapproved',
        before: fresh ? replacementBefore : originalBefore,
        transformResult: fresh ? replacementResult : originalResult,
      });
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-retained-policy',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        name: 'A',
        instructions: 'Read records.',
        tools: [descriptor(false)],
        handoffs: [new Agent({ name: 'B', instructions: 'Answer.' })],
        provider,
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        automaticallyTriggerResponseForMcpToolCalls: false,
      });
      const name = accepted.tools.find((item: { name?: string }) =>
        item.name?.includes('lookup'),
      ).name;
      socket!.send(
        JSON.stringify({
          type: 'response.created',
          response: { id: 'retained-response' },
        }),
      );
      await session.update({ tools: [descriptor(true)] });
      await expect(
        (await session.submit('Use the replacement policy.')).wait(),
      ).rejects.toThrow();
      expect(replacementBefore).toHaveBeenCalledTimes(1);
      expect(remote.effects).toHaveLength(0);
      const item = {
        id: 'retained-item',
        type: 'function_call',
        name,
        call_id: 'retained-call',
        arguments: '{}',
      };
      socket!.send(
        JSON.stringify({
          type: 'response.output_item.done',
          response_id: 'retained-response',
          output_index: 0,
          item,
        }),
      );
      socket!.send(
        JSON.stringify({
          type: 'response.done',
          response: { id: 'retained-response', output: [item] },
        }),
      );
      await vi.waitFor(
        () =>
          expect(
            frames.find((frame) => frame.item?.call_id === 'retained-call')
              ?.item.output,
          ).toContain('original result policy'),
        { timeout: 10000 },
      );
      expect(remote.effects).toHaveLength(1);
      expect(originalBefore).toHaveBeenCalledTimes(1);
      expect(originalResult).toHaveBeenCalledTimes(1);
      expect(replacementResult).not.toHaveBeenCalled();
      await voice.close();
      expect(
        (await (await session.submit('Continue.')).wait()).finalOutput,
      ).toBe('reused');
      model.assertExhausted();
    } finally {
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await remote.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

for (const phase of ['before', 'approval'] as const) {
  nativeIt.each(['added', 'changed', 'removed'] as const)(
    `uses accepted ${phase} callbacks after MCP replacement (%s)`,
    async (change) => {
      const remote = await peer();
      const original = vi.fn(() =>
        phase === 'before' ? { action: 'allow' as const } : true,
      );
      const replacement = vi.fn(() =>
        phase === 'before' ? { action: 'stop' as const } : false,
      );
      const originalResult = vi.fn(() => ({
        content: [{ type: 'text' as const, text: 'original result' }],
      }));
      const replacementResult = vi.fn(() => ({
        content: [
          { type: 'text' as const, text: 'accepted replacement result' },
        ],
      }));
      const descriptor = (
        callback?: typeof original | typeof replacement,
        fresh = false,
      ) =>
        new HttpMCP({
          name: 'records',
          url: remote.url,
          tools: ['lookup'],
          approvalMode: 'preapproved',
          transformResult: fresh ? replacementResult : originalResult,
          ...(callback
            ? phase === 'before'
              ? { before: callback as () => { action: 'allow' | 'stop' } }
              : { approval: callback as () => boolean }
            : {}),
        });
      const model = new ModelServer([
        [
          call(
            'lookup',
            {},
            { callId: 'updated-call', namespace: 'mcp__records' },
          ),
        ],
        [message(change === 'removed' ? 'completed' : 'reused')],
        ...(change === 'removed' ? [[message('reused')]] : []),
      ]);
      try {
        const config = await model.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-replacement-policy',
          supportsWebsockets: false,
        });
        const leaf = new Agent({ name: 'B', instructions: 'B can answer.' });
        await using session = await new Agent({
          name: 'A',
          instructions: 'Use the selected record tool.',
          tools: [descriptor(change === 'added' ? undefined : original)],
          handoffs: [leaf],
          provider,
        }).session();
        await session.update({
          tools: [
            descriptor(change === 'removed' ? undefined : replacement, true),
          ],
        });
        const outcome = await (
          await session.submit('Look up the record.')
        )
          .wait()
          .catch((error: unknown) => error);
        expect(remote.effects).toHaveLength(change === 'removed' ? 1 : 0);
        expect(originalResult).not.toHaveBeenCalled();
        expect(replacementResult).toHaveBeenCalledTimes(
          change === 'removed' ? 1 : 0,
        );
        expect(original).not.toHaveBeenCalled();
        expect(replacement).toHaveBeenCalledTimes(change === 'removed' ? 0 : 1);
        if (change === 'removed') {
          expect(outcome).toMatchObject({ finalOutput: 'completed' });
          expect(JSON.stringify(model.requests[1].input)).toContain(
            'accepted replacement result',
          );
        } else expect(outcome).toBeInstanceOf(Error);
        expect(
          (await (await session.submit('Continue.')).wait()).finalOutput,
        ).toBe('reused');
        model.assertExhausted();
      } finally {
        await remote.close();
        await ModelServer.closeAll();
      }
    },
    20000,
  );
}

nativeIt.each(['session', 'operation'] as const)(
  'preserves raw MCP selection and permits same-name endpoint replacement (%s activation)',
  async (activation) => {
    const original = await peer(['find-record', 'find_record']);
    const replacement = await peer(['find-record', 'find_record']);
    const model = new ModelServer([
      [
        call(
          'find_record',
          {},
          { callId: 'raw-name-call', namespace: 'mcp__records' },
        ),
      ],
      [message('completed')],
    ]);
    const descriptor = (url: string, raw = 'find-record') =>
      new HttpMCP({
        name: 'records',
        url,
        tools: [raw],
        activation,
        approvalMode: 'preapproved',
      });
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-raw-name-replacement',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Read the selected record.',
        provider,
        tools: [descriptor(original.url)],
      }).session();
      await expect(
        session.update({
          tools: [descriptor(replacement.url, 'find_record')],
        }),
      ).rejects.toThrow('Updated MCP raw identities');
      expect(model.requests).toHaveLength(0);
      expect(original.effects).toHaveLength(0);
      expect(replacement.effects).toHaveLength(0);
      await session.update({ tools: [descriptor(replacement.url)] });
      expect((await (await session.submit('Read.')).wait()).finalOutput).toBe(
        'completed',
      );
      expect(original.effects).toHaveLength(0);
      expect(replacement.effects).toEqual([
        expect.objectContaining({ name: 'find-record' }),
      ]);
      model.assertExhausted();
    } finally {
      await original.close();
      await replacement.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);
