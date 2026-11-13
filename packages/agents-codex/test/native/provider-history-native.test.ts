import { createServer, request as proxyRequest, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Agent,
  type ModelSettings,
  NativeProvider,
  getProviderHistory,
  localStorage,
  StdioMCP,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  binding,
  jsonObject,
  type NativeThread,
} from '../../src/runtime/binding';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const fronts: Server[] = [];
afterEach(async () => {
  for (const server of fronts.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await ModelServer.closeAll();
});

nativeIt(
  'refuses borrowed response producers before provider I/O',
  async () => {
    const model = new ModelServer([]);
    const remote = await peer(model);
    let calls = 0;
    await using provider = new NativeProvider({
      ...remote.options,
      modelBackend: {
        async complete() {
          calls++;
          throw new Error('Unexpected borrowed response dispatch');
        },
      },
    });
    const agent = new Agent({
      instructions: 'Never dispatch.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    await expect(
      agent.run('Never dispatch.', {
        providerHistory: { type: 'previous_response', id: 'response_current' },
      }),
    ).rejects.toThrow('owning Responses transport');
    expect(calls).toBe(0);
    expect(remote.wire).toEqual([]);
  },
  30_000,
);

async function peer(
  model: ModelServer,
  rejection?: number,
  allowChangedRoute?: boolean,
) {
  let posts = 0;
  const wire: Array<[string | undefined, string | undefined]> = [];
  const identities: Array<{
    method: string | undefined;
    originator: string | string[] | undefined;
    userAgent: string | undefined;
  }> = [];
  const auth: Array<{
    method: string | undefined;
    authorization: string | undefined;
    grant: string | string[] | undefined;
  }> = [];
  const reads: Array<[string | undefined, string | undefined]> = [];
  const routing: Array<{
    method: string | undefined;
    header: string | string[] | undefined;
    query: string | null;
  }> = [];
  const port = await model.port();
  const front = createServer((request, response) => {
    const address = new URL(request.url ?? '/', 'http://synthetic.invalid');
    routing.push({
      method: request.method,
      header: request.headers['x-history-route'],
      query: address.searchParams.get('tenant'),
    });
    wire.push([request.method, request.url]);
    identities.push({
      method: request.method,
      originator: request.headers.originator,
      userAgent: request.headers['user-agent'],
    });
    auth.push({
      method: request.method,
      authorization: request.headers.authorization,
      grant: request.headers['x-sdk-sentinel-grant'],
    });
    if (request.method === 'GET') {
      reads.push([request.url, request.headers.authorization]);
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== 'Bearer current-owner') {
        response
          .writeHead(403)
          .end(JSON.stringify({ error: 'Rejected account' }));
        return;
      }
      if (
        allowChangedRoute === false &&
        (request.headers['x-history-route'] !== 'A' ||
          address.searchParams.get('tenant') !== 'A')
      ) {
        response
          .writeHead(403)
          .end(JSON.stringify({ error: 'Rejected route' }));
        return;
      }
      const match = address.pathname.match(
        /^\/v1\/(responses|conversations)\/([^/?]+)$/,
      );
      if (!match) {
        response.writeHead(404).end('{}');
        return;
      }
      response.end(
        JSON.stringify({
          id: decodeURIComponent(match[2]!),
          ...(match[1] === 'responses'
            ? { status: 'completed' }
            : { object: 'conversation' }),
        }),
      );
      return;
    }
    if (request.method === 'POST' && posts++ === 0 && rejection !== undefined) {
      request.resume();
      response.writeHead(rejection, {
        'content-type':
          rejection === 200 ? 'text/event-stream' : 'application/json',
      });
      response.end(
        rejection === 200
          ? ''
          : JSON.stringify({
              error: {
                message: 'Request rejected',
                type: 'invalid_request_error',
              },
            }),
      );
      return;
    }
    const upstream = proxyRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: request.method,
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 500, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  fronts.push(front);
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const address = front.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test listener');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    baseUrl,
    wire,
    identities,
    reads,
    routing,
    auth,
    options: {
      baseUrl,
      apiKey: 'current-owner',
      supportsWebsockets: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
    },
  };
}

nativeIt(
  'identifies the SDK on provider history anchor GET and model POST requests',
  async () => {
    const model = new ModelServer([[message('Finished.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    await agent.run('Continue.', {
      providerHistory: { type: 'previous_response', id: 'response_external' },
    });
    const { version } = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(
      remote.identities.map(({ method, originator, userAgent }) => ({
        method,
        originator,
        client: userAgent?.split(' ', 1)[0],
      })),
    ).toEqual(
      ['GET', 'POST'].map((method) => ({
        method,
        originator: 'openai_agents_js',
        client: `openai_agents_js/${version}`,
      })),
    );
  },
  30_000,
);

nativeIt(
  'advances a response chain with each native tool effect once',
  async () => {
    const model = new ModelServer([
      [call('effect', { label: 'first' }, { callId: 'call_first' })],
      [call('effect', { label: 'second' }, { callId: 'call_second' })],
      [message('Finished.')],
    ]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const effects: string[] = [];
    const agent = new Agent({
      instructions: 'Run both effects.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
      tools: [
        tool({
          name: 'effect',
          parameters: z.object({ label: z.string() }),
          execute: ({ label }) => {
            effects.push(label);
            return label;
          },
        }),
      ],
    });
    await agent.run('Run.', {
      providerHistory: { type: 'previous_response', id: 'response_external' },
    });
    expect(effects).toEqual(['first', 'second']);
    expect(remote.auth.filter((item) => item.method === 'GET')).toHaveLength(1);
    expect(remote.auth.filter((item) => item.method === 'POST')).toHaveLength(
      3,
    );
    expect(
      remote.auth.every(
        (item) => item.authorization === 'Bearer current-owner',
      ),
    ).toBe(true);
    expect(remote.auth.every((item) => item.grant === undefined)).toBe(true);
    expect(model.requests.map((body) => body.previous_response_id)).toEqual([
      'response_external',
      'response-1',
      'response-2',
    ]);
    for (const [index, id] of [
      [1, 'call_first'],
      [2, 'call_second'],
    ] as const) {
      expect(model.requests[index]!.input).toEqual([
        expect.objectContaining({ type: 'function_call_output', call_id: id }),
      ]);
    }
    expect(remote.reads).toEqual([
      ['/v1/responses/response_external', 'Bearer current-owner'],
    ]);
  },
  30_000,
);

nativeIt(
  'retains a conversation ID and only unsent input with store false',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: false },
    });
    await using session = await agent.session({
      providerHistory: { type: 'conversation', id: 'conv_current' },
    });
    await (await session.submit('Before.')).wait();
    await (await session.submit('After.')).wait();
    expect(model.requests.map((body) => body.conversation)).toEqual([
      'conv_current',
      'conv_current',
    ]);
    expect(model.requests.map((body) => body.store)).toEqual([false, false]);
    expect(model.requests[1]!.input).toEqual([
      expect.objectContaining({ role: 'user' }),
    ]);
  },
  30_000,
);

nativeIt(
  'requires the current anchor and account on portable restore',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    const state = await (async () => {
      await using session = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      await (await session.submit('Before.')).wait();
      return session.saveState();
    })();
    await expect(agent.session({ state })).rejects.toThrow();
    await expect(
      agent.session({
        state,
        providerHistory: { type: 'previous_response', id: 'wrong' },
      }),
    ).rejects.toThrow();
    expect(model.requests).toHaveLength(1);
    await using rejected = new NativeProvider({
      ...remote.options,
      apiKey: 'rejected-owner',
    });
    const other = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider: rejected,
      modelSettings: { store: true },
    });
    await expect(
      other.run('Rejected.', {
        state,
        providerHistory: { type: 'previous_response', id: 'response-1' },
      }),
    ).rejects.toThrow();
    expect(model.requests).toHaveLength(1);
    await using restored = await agent.session({
      state,
      providerHistory: { type: 'previous_response', id: 'response-1' },
    });
    await (await restored.submit('After.')).wait();
    expect(model.requests[1]!.previous_response_id).toBe('response-1');
    expect(model.requests[1]!.input).toEqual([
      expect.objectContaining({ role: 'user' }),
    ]);
    expect(remote.reads).toContainEqual([
      '/v1/responses/response-1',
      'Bearer rejected-owner',
    ]);
  },
  30_000,
);

nativeIt(
  'keeps unstored WebSocket lineage on one physical connection',
  async () => {
    const model = new ModelServer([]);
    const sockets = new WebSocketServer({ noServer: true });
    const frames: Array<{
      input: unknown[];
      previous_response_id?: string;
      store: boolean;
    }> = [];
    let connections = 0;
    model.onUpgrade((request, socket, head) => {
      connections++;
      sockets.handleUpgrade(request, socket, head, (connection) => {
        connection.on('message', (raw) => {
          const payload = JSON.parse(raw.toString());
          frames.push(payload);
          const id = `response_ws_${frames.length}`;
          const send = (frame: object) =>
            connection.send(JSON.stringify(frame));
          send({ type: 'response.created', response: { id } });
          send({
            type: 'response.output_item.done',
            output_index: 0,
            item: message('Done.'),
          });
          send({ type: 'response.completed', response: { id } });
        });
      });
    });
    try {
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${await model.port()}/v1`,
        apiKey: 'synthetic-websocket',
        supportsWebsockets: true,
      });
      const agent = new Agent({
        instructions: 'Continue the current response chain.',
        model: 'gpt-5.5',
        provider,
        modelSettings: { store: false },
      });
      await using session = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      await (await session.submit('Before.')).wait();
      await (await session.submit('After.')).wait();
      expect(connections).toBe(1);
      expect(frames).toHaveLength(2);
      expect(frames[0]!.previous_response_id).toBeUndefined();
      expect(frames[1]!.previous_response_id).toBe('response_ws_1');
      expect(frames[1]!.store).toBe(false);
      expect(frames[1]!.input).toEqual([
        expect.objectContaining({ role: 'user' }),
      ]);
      expect(JSON.stringify(frames[1]!.input)).toContain('After.');
      expect(model.requests).toEqual([]);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    }
  },
  30_000,
);

nativeIt(
  'clears unsent history after WebSocket owner revocation',
  async () => {
    const native = await binding();
    const submit = native.NativeThread.prototype._submit;
    let revoke: (() => void) | undefined;
    const capture = vi
      .spyOn(native.NativeThread.prototype, '_submit')
      .mockImplementation(function (this: NativeThread, raw) {
        revoke = () => this._revoke_native_interception();
        return submit.call(this, raw);
      });
    let entered!: () => void;
    const handshakeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const handshakeReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new ModelServer([]);
    const sockets = new WebSocketServer({ noServer: true });
    let connections = 0;
    const frames: unknown[] = [];
    model.onUpgrade((request, socket, head) => {
      entered();
      void handshakeReleased.then(() => {
        sockets.handleUpgrade(request, socket, head, (connection) => {
          connections++;
          connection.on('message', (raw) =>
            frames.push(JSON.parse(raw.toString())),
          );
        });
      });
    });
    try {
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${await model.port()}/v1`,
        apiKey: 'synthetic-key',
        supportsWebsockets: true,
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      });
      const agent = new Agent({
        instructions: 'Never dispatch a revoked request.',
        model: 'gpt-5.5',
        provider,
        modelSettings: { store: false },
      });
      await using session = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      const turn = await session.submit('Known unsent.');
      await handshakeEntered;
      expect(revoke).toBeDefined();
      revoke!();
      release();
      await expect(turn.wait()).rejects.toThrow(/interception|store=true/);
      const state = await session.saveState();
      const row = [...state.history].reverse().find((item) => {
        const payload = jsonObject.safeParse(item.payload);
        return (
          payload.success &&
          payload.data.type === 'thread_settings_applied' &&
          payload.data.thread_id === state.source_session_id
        );
      });
      const payload = jsonObject.parse(row!.payload);
      const settings = jsonObject.parse(payload.thread_settings);
      const history = jsonObject.parse(settings.provider_history);
      expect(history.pending ?? false).toBe(false);
      expect(connections).toBe(1);
      expect(frames).toEqual([]);
      expect(model.requests).toEqual([]);
    } finally {
      release();
      capture.mockRestore();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    }
  },
  30_000,
);

nativeIt(
  'never replays an uncertain WebSocket dispatch',
  async () => {
    const model = new ModelServer([]);
    const sockets = new WebSocketServer({ noServer: true });
    const frames: unknown[] = [];
    let connections = 0;
    model.onUpgrade((request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (connection) => {
        connections++;
        connection.on('message', (raw) => {
          frames.push(JSON.parse(raw.toString()));
          connection.send(
            JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_pending' },
            }),
          );
          connection.close();
        });
      });
    });
    try {
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${await model.port()}/v1`,
        apiKey: 'synthetic-key',
        supportsWebsockets: true,
        requestMaxRetries: 2,
        streamMaxRetries: 2,
      });
      const agent = new Agent({
        instructions: 'Dispatch the synthetic prompt once.',
        model: 'gpt-5.5',
        provider,
        modelSettings: { store: false },
      });
      await using session = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      await expect(
        (await session.submit('Dispatch once.')).wait(),
      ).rejects.toThrow();
      await expect(
        (await session.submit('Never resend.')).wait(),
      ).rejects.toThrow(/reconcil/);
      const state = await session.saveState();
      const row = [...state.history].reverse().find((item) => {
        const payload = jsonObject.safeParse(item.payload);
        return (
          payload.success &&
          payload.data.type === 'thread_settings_applied' &&
          payload.data.thread_id === state.source_session_id
        );
      });
      const payload = jsonObject.parse(row!.payload);
      const settings = jsonObject.parse(payload.thread_settings);
      expect(jsonObject.parse(settings.provider_history).pending).toBe(true);
      expect(connections).toBe(1);
      expect(frames).toHaveLength(1);
      expect(model.requests).toEqual([]);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    }
  },
  30_000,
);

nativeIt.each([false, undefined])(
  'rebinds saved conversation storage to current %s',
  async (store) => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const source = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    const mode = { type: 'conversation', id: 'conv_current' } as const;
    const state = await (async () => {
      await using session = await source.session({ providerHistory: mode });
      await (await session.submit('Before.')).wait();
      return session.saveState();
    })();
    const current = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: store === undefined ? {} : { store },
    });
    await using session = await current.session({
      state,
      providerHistory: mode,
    });
    await (await session.submit('After.')).wait();
    expect(model.requests.map((body) => body.store)).toEqual([true, false]);
  },
  30_000,
);

nativeIt(
  'retains current store permission through restored profile publication',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const other = new Agent({
      name: 'Other',
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    const agent = new Agent({
      name: 'Root',
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
      handoffs: [other],
    });
    const state = await (async () => {
      await using session = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      await (await session.submit('Before.')).wait();
      return session.saveState();
    })();
    await using session = await agent.session({
      state,
      providerHistory: { type: 'previous_response', id: 'response-1' },
    });
    await (await session.submit('After.')).wait();
    expect(model.requests.map((body) => body.store)).toEqual([true, true]);
  },
  30_000,
);

nativeIt.each([false, true])(
  'refuses supplied compaction and retains the session (restored=%s)',
  async (restore) => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
    });
    const providerHistory = {
      type: 'conversation' as const,
      id: 'conv_current',
    };
    let state;
    if (restore) {
      await using source = await agent.session({ providerHistory });
      state = await source.saveState();
    }
    await using session = await agent.session({
      providerHistory,
      ...(state ? { state } : {}),
    });
    await (await session.submit('Before.')).wait();
    const before = await session.historySnapshot();
    await expect(
      session.compact({ summary: 'Unpublished summary.' }),
    ).rejects.toThrow('Compaction is unavailable for provider-managed history');
    expect((await session.historySnapshot()).items).toEqual(before.items);
    await (await session.submit('After.')).wait();
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.input).toEqual([
      expect.objectContaining({ role: 'user' }),
    ]);
  },
  30_000,
);

nativeIt(
  'refuses rewritten MCP arguments without another provider request',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lineage-mcp-'));
    try {
      const roster = join(directory, 'roster.json'),
        effects = join(directory, 'effects.jsonl');
      await writeFile(effects, '');
      await writeFile(
        roster,
        JSON.stringify({
          tools: [
            {
              name: 'lookup',
              inputSchema: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
              },
            },
          ],
          result: { content: [{ type: 'text', text: 'accepted' }] },
        }),
      );
      let before = 0;
      const declaration = new StdioMCP({
        name: 'fixture',
        tools: ['lookup'],
        approvalMode: 'preapproved',
        command: process.execPath,
        args: [resolve(import.meta.dirname, 'mcp-peer.mjs'), roster, effects],
        before: () => {
          before++;
          return {
            action: 'replaceArguments' as const,
            arguments: { key: 'effective' },
          };
        },
      });
      const model = new ModelServer([
        [
          call(
            'lookup',
            { key: 'original' },
            { callId: 'rewritten', namespace: 'mcp__fixture' },
          ),
        ],
        [message('Must not dispatch.')],
      ]);
      const remote = await peer(model);
      await using provider = new NativeProvider(remote.options);
      const agent = new Agent({
        instructions: 'Use lookup.',
        model: 'gpt-5.5',
        provider,
        modelSettings: { store: true },
        tools: [declaration],
      });
      await using session = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      await expect((await session.submit('Run.')).wait()).rejects.toThrow(
        'rewritten tool arguments',
      );
      expect(before).toBe(1);
      const calls = (await readFile(effects, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(calls.length).toBeLessThanOrEqual(1);
      for (const item of calls)
        expect(item.arguments).toEqual({ key: 'effective' });
      expect(model.requests).toHaveLength(1);
      await expect(
        (async () => {
          await (await session.submit('Again.')).wait();
        })(),
      ).rejects.toThrow();
      expect(model.requests).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

nativeIt.each([false, true])(
  'preserves acknowledged history and valid edits (restored=%s)',
  async (restore) => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
    });
    const providerHistory = {
      type: 'conversation' as const,
      id: 'conv_current',
    };
    let state;
    if (restore) {
      await using source = await agent.session({ providerHistory });
      await (await source.submit('Before.')).wait();
      state = await source.saveState();
    }
    await using session = await agent.session({
      providerHistory,
      ...(state ? { state } : {}),
    });
    if (!restore) await (await session.submit('Before.')).wait();
    const before = await session.historySnapshot();
    await expect(
      session.transactHistory({
        expectedRevision: before.revision,
        keep: 0,
        items: [],
      }),
    ).rejects.toThrow('acknowledged provider history');
    expect(await session.historySnapshot()).toEqual(before);
    const revision = await session.transactHistory({
      expectedRevision: before.revision,
      keep: before.total,
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Unsent draft.' }],
        },
      ],
    });
    expect((await session.historySnapshot()).total).toBe(before.total + 1);
    await session.transactHistory({
      expectedRevision: revision,
      keep: before.total,
      items: [],
    });
    expect((await session.historySnapshot()).items).toEqual(before.items);
    await (await session.submit('After.')).wait();
    expect(model.requests).toHaveLength(2);
  },
  30_000,
);

nativeIt(
  'preserves canonical metadata that the wire formatter omits',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
    });
    const prior = {
      type: 'message',
      id: 'msg_prior',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'Prior.',
          annotations: [{ type: 'future_annotation', value: 'retained' }],
        },
      ],
    };
    await using session = await agent.session({
      providerHistory: { type: 'conversation', id: 'conv_current' },
    });
    const initial = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: initial.revision,
      keep: initial.total,
      items: [prior],
    });
    await (await session.submit('Before.')).wait();
    const before = await session.historySnapshot();
    expect(before.items).toContainEqual(
      expect.objectContaining({ id: 'msg_prior', content: prior.content }),
    );
    expect(JSON.stringify(model.requests[0]!.input)).not.toContain(
      'future_annotation',
    );
    await session.transactHistory({
      expectedRevision: before.revision,
      keep: before.total,
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Unsent draft.' }],
        },
      ],
    });
    expect(
      (await session.historySnapshot()).items.slice(0, before.total),
    ).toEqual(before.items);
    await (await session.submit('After.')).wait();
    expect(model.requests).toHaveLength(2);
  },
  30_000,
);

nativeIt.each([
  undefined,
  { type: 'conversation' as const, id: 'conv_current' },
  { type: 'previous_response' as const, id: 'response_external' },
])(
  'retains the remote owner when forking (%j)',
  async (providerHistory) => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    await using session = await agent.session({ providerHistory });
    await (await session.submit('Before.')).wait();
    const before = await session.historySnapshot();
    if (providerHistory)
      await expect(session.fork()).rejects.toThrow(
        'Fork is unavailable for provider-managed history',
      );
    else expect(await session.fork()).toBeTruthy();
    expect((await session.historySnapshot()).items).toEqual(before.items);
    await (await session.submit('After.')).wait();
    expect(model.requests).toHaveLength(2);
  },
  30_000,
);

nativeIt.each([false, true])(
  'retains the remote owner for stored forks (%s)',
  async (remoteMode) => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-fork-'));
    try {
      const model = new ModelServer([
        [message('Before.')],
        [message('After.')],
      ]);
      const remote = await peer(model);
      await using provider = new NativeProvider(remote.options);
      const agent = new Agent({
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session({
        storage: localStorage(join(directory, 'threads')),
        ...(remoteMode
          ? {
              providerHistory: {
                type: 'conversation' as const,
                id: 'conv_current',
              },
            }
          : {}),
      });
      await (await session.submit('Before.')).wait();
      const before = (await session.storedSessions()).sessions
        .map((item) => item.id)
        .sort();
      let forkId;
      if (remoteMode)
        await expect(session.forkStored()).rejects.toThrow(
          'Fork is unavailable for provider-managed history',
        );
      else forkId = await session.forkStored();
      const after = (await session.storedSessions()).sessions
        .map((item) => item.id)
        .sort();
      expect(after).toEqual(remoteMode ? before : [...before, forkId].sort());
      await (await session.submit('After.')).wait();
      expect(model.requests).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

for (const [status, restore] of [
  [400, false],
  [429, false],
  [500, false],
  [200, false],
  [400, true],
  [429, true],
] as const) {
  nativeIt(
    `lineage releases only a definitive pre-stream rejection fence (${status}, restored=${restore})`,
    async () => {
      const model = new ModelServer([[message('Recovered.')]]);
      const remote = await peer(model, status);
      await using provider = new NativeProvider(remote.options);
      const agent = new Agent({
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session({
        providerHistory: { type: 'conversation', id: 'conv_current' },
      });
      await expect((await session.submit('Before.')).wait()).rejects.toThrow();
      if (status === 400 || status === 429) {
        if (restore) {
          const state = await session.saveState();
          await session.close();
          await using resumed = await agent.session({
            state,
            providerHistory: { type: 'conversation', id: 'conv_current' },
          });
          await (await resumed.submit('After.')).wait();
        } else {
          await (await session.submit('After.')).wait();
        }
        expect(
          remote.wire.filter(([method]) => method === 'POST'),
        ).toHaveLength(2);
      } else {
        await expect((await session.submit('After.')).wait()).rejects.toThrow(
          'reconciliation',
        );
        expect(
          remote.wire.filter(([method]) => method === 'POST'),
        ).toHaveLength(1);
      }
    },
    30000,
  );
}
nativeIt(
  'lineage sends current instructions after a normal update',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Original instructions.',
      model: 'gpt-5.5',
      provider,
    });
    await using session = await agent.session({
      providerHistory: { type: 'conversation', id: 'conv_current' },
    });
    await (await session.submit('Before.')).wait();
    await session.update({ instructions: 'Current instructions.' });
    await (await session.submit('After.')).wait();
    expect(JSON.stringify(model.requests[1]!.input)).toContain(
      'Current instructions.',
    );
  },
  30000,
);
for (const store of [undefined, false]) {
  nativeIt(
    `lineage refuses an incompatible reachable handoff before dispatch (${store})`,
    async () => {
      const model = new ModelServer([]);
      const remote = await peer(model);
      await using provider = new NativeProvider(remote.options);
      const target = new Agent({
        name: 'Other',
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
        modelSettings: store === undefined ? {} : { store },
      });
      const agent = new Agent({
        name: 'Root',
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
        modelSettings: { store: true },
        handoffs: [target],
      });
      await expect(
        agent.session({ providerHistory: { type: 'previous_response' } }),
      ).rejects.toThrow('store=true');
      expect(remote.wire).toEqual([]);
    },
    30000,
  );
}
nativeIt(
  'lineage exposes the advanced anchor as detached restore data',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    const source = await agent.session({
      providerHistory: { type: 'previous_response' },
    });
    await (await source.submit('Before.')).wait();
    const state = await source.saveState();
    await source.close();
    // Application-owned authorization, independent of the imported checkpoint.
    const authorized = { type: 'previous_response' as const, id: 'response-1' };
    const selected = getProviderHistory(state);
    expect(selected).toEqual(authorized);
    (selected as { id: string }).id = 'modified';
    expect(getProviderHistory(state)).toEqual({
      type: 'previous_response',
      id: 'response-1',
    });
    const tampered = JSON.parse(
      JSON.stringify(state).replaceAll('response-1', 'victim-response'),
    );
    const beforeRejectedRestore = remote.wire.length;
    await expect(
      agent.session({ state: tampered, providerHistory: authorized }),
    ).rejects.toThrow('exact current anchor');
    expect(remote.wire).toHaveLength(beforeRejectedRestore);
    await using restored = await agent.session({
      state,
      providerHistory: authorized,
    });
    await (await restored.submit('After.')).wait();
    expect(model.requests[1]!.previous_response_id).toBe('response-1');
  },
  30000,
);

nativeIt(
  'lineage carries changed handoff instructions without acknowledging request-only rows',
  async () => {
    const model = new ModelServer([
      [call('transfer_to_other', {}, { callId: 'handoff-other' })],
      [message('Other accepted.')],
    ]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const other = new Agent({
      name: 'Other',
      instructions: 'Current target instructions.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
    });
    const agent = new Agent({
      name: 'Root',
      instructions: 'Original root instructions.',
      model: 'gpt-5.5',
      provider,
      modelSettings: { store: true },
      handoffs: [other],
    });
    await using session = await agent.session({
      providerHistory: { type: 'previous_response' },
    });
    await (await session.submit('Handoff.')).wait();
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]!.input)).toContain(
      'Current target instructions.',
    );
  },
  30000,
);
nativeIt(
  'lineage selects HTTP for an implicit default provider transport',
  async () => {
    const model = new ModelServer([[message('Accepted.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider({
      apiKey: 'current-owner',
      requestMaxRetries: 0,
      streamMaxRetries: 0,
    });
    const acquire = provider._acquire.bind(provider);
    const replacement = vi
      .spyOn(provider, '_acquire')
      .mockImplementation((...args) => {
        const lease = acquire(...args);
        const config = lease.config['model_providers.native_agent'] as Record<
          string,
          unknown
        >;
        expect(config.supports_websockets).toBe(true);
        config.base_url = remote.baseUrl;
        return lease;
      });
    try {
      const agent = new Agent({
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session({
        providerHistory: { type: 'conversation', id: 'conv_current' },
      });
      await (await session.submit('Before.')).wait();
      expect(model.requests).toHaveLength(1);
    } finally {
      replacement.mockRestore();
    }
  },
  30000,
);

for (const store of [false, null]) {
  nativeIt(
    `lineage refuses an incompatible storage update before publication (${store})`,
    async () => {
      const model = new ModelServer([
        [message('Before.')],
        [message('After.')],
      ]);
      const remote = await peer(model);
      await using provider = new NativeProvider(remote.options);
      const agent = new Agent({
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
        modelSettings: { store: true },
      });
      await using session = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      await (await session.submit('Before.')).wait();
      await expect(
        session.update({ modelSettings: { store } }),
      ).rejects.toThrow('store=true');
      await (await session.submit('After.')).wait();
      expect(model.requests.map((body) => body.store)).toEqual([true, true]);
    },
    30000,
  );
}

for (const kind of ['conversation', 'previous_response'] as const) {
  for (const phase of ['pre_turn', 'mid_turn'] as const) {
    nativeIt(
      `lineage skips local automatic compaction (${kind}, ${phase})`,
      async () => {
        const effects: string[] = [];
        const record = tool({
          name: 'record_effect',
          parameters: z.object({ value: z.string() }),
          execute: ({ value }) => {
            effects.push(value);
            return 'Accepted.';
          },
        });
        const model = new ModelServer(
          [
            [
              phase === 'mid_turn'
                ? call(
                    'record_effect',
                    { value: 'once' },
                    { callId: 'effect-once' },
                  )
                : message('Before.'),
            ],
            [message('After.')],
          ],
          [
            JSON.stringify({
              input_tokens: 1_000_000,
              output_tokens: 1,
              total_tokens: 1_000_001,
            }),
          ],
        );
        const remote = await peer(model);
        await using provider = new NativeProvider(remote.options);
        const agent = new Agent({
          instructions: 'Continue.',
          model: 'gpt-5.5',
          provider,
          modelSettings: { store: true },
          tools: [record],
        });
        const selected =
          kind === 'conversation'
            ? { type: kind, id: 'conv_current' }
            : { type: kind };
        await using session = await agent.session({
          providerHistory: selected,
        });
        await (await session.submit('Before.')).wait();
        if (phase === 'pre_turn') await (await session.submit('After.')).wait();
        expect(model.requests).toHaveLength(2);
        expect(effects).toEqual(phase === 'mid_turn' ? ['once'] : []);
      },
      30000,
    );
  }
  const choices: ModelSettings[] = [
    { providerCompaction: { type: 'static', threshold: 1024 } },
    { contextManagement: [{ type: 'compaction', compact_threshold: 1024 }] },
  ];
  for (const [index, settings] of choices.entries()) {
    nativeIt(
      `lineage refuses provider compaction before dispatch (${kind}, ${index})`,
      async () => {
        const model = new ModelServer([[message('After clear.')]]);
        const remote = await peer(model);
        await using provider = new NativeProvider(remote.options);
        const agent = new Agent({
          instructions: 'Continue.',
          model: 'gpt-5.5',
          provider,
          modelSettings: { store: true, ...settings },
        });
        const selected =
          kind === 'conversation'
            ? { type: kind, id: 'conv_current' }
            : { type: kind };
        await using session = await agent.session({
          providerHistory: selected,
        });
        await expect((await session.submit('Before.')).wait()).rejects.toThrow(
          'Provider-side compaction is unavailable',
        );
        expect(remote.wire).toEqual([]);
        await session.update({ modelSettings: { contextManagement: null } });
        await (await session.submit('After.')).wait();
        expect(model.requests).toHaveLength(1);
        expect(model.requests[0]).not.toHaveProperty('context_management');
      },
      30000,
    );
  }
  for (const context of [null, []]) {
    nativeIt(
      `lineage allows explicitly disabled provider compaction (${kind}, ${JSON.stringify(context)})`,
      async () => {
        const model = new ModelServer([
          [message('Before.')],
          [message('After.')],
        ]);
        const remote = await peer(model);
        await using provider = new NativeProvider(remote.options);
        const agent = new Agent({
          instructions: 'Continue.',
          model: 'gpt-5.5',
          provider,
          modelSettings: {
            store: true,
            providerCompaction: { type: 'static', threshold: 1024 },
            contextManagement: context,
          },
        });
        const selected =
          kind === 'conversation'
            ? { type: kind, id: 'conv_current' }
            : { type: kind };
        await using session = await agent.session({
          providerHistory: selected,
        });
        await (await session.submit('Before.')).wait();
        await (await session.submit('After.')).wait();
        expect(model.requests).toHaveLength(2);
        for (const body of model.requests)
          expect(body.context_management ?? null).toEqual(context);
      },
      30000,
    );
  }
}

nativeIt(
  'lineage sampling reference preserves canonical history and followup',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
    });
    await using session = await agent.session({
      providerHistory: { type: 'conversation', id: 'conv_current' },
    });
    await (
      await session.submit('Before.', {
        prepareRequest({ request }) {
          request.input.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'sampling-only-note' }],
          });
          return request;
        },
      })
    ).wait();
    expect(JSON.stringify(model.requests[0]?.input)).toContain(
      'sampling-only-note',
    );
    const canonical = await session.historySnapshot();
    expect(JSON.stringify(canonical)).not.toContain('sampling-only-note');
    await (await session.submit('After.')).wait();
    expect(model.requests).toHaveLength(2);
  },
  30000,
);

for (const mode of [
  'replacement',
  'omission',
  'repeated_replacement',
  'cold_omission',
] as const) {
  nativeIt(
    `lineage sampling occurrence delivery ${mode}`,
    async () => {
      const model = new ModelServer([
        [message('Before.')],
        [message('After.')],
      ]);
      const remote = await peer(model);
      await using provider = new NativeProvider(remote.options);
      const agent = new Agent({
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session({
        providerHistory: { type: 'conversation', id: 'conv_current' },
      });
      let calls = 0;
      const prepareRequest = ({
        request,
      }: import('../../src').PrepareRequestContext) => {
        calls++;
        if (calls !== 1 && mode !== 'repeated_replacement') return;
        const input = z.array(jsonObject).parse(request.input);
        const index = input.findIndex((item) => item.role === 'user');
        expect(index).toBeGreaterThanOrEqual(0);
        if (mode === 'omission' || mode === 'cold_omission')
          input.splice(index, 1);
        else
          input[index]!.content = [
            { type: 'input_text', text: 'sampling-replacement' },
          ];
        request.input = input;
        return request;
      };
      await (await session.submit('original-input', { prepareRequest })).wait();
      const firstInput = JSON.stringify(model.requests[0]!.input);
      expect(firstInput).not.toContain('original-input');
      if (mode === 'replacement' || mode === 'repeated_replacement')
        expect(firstInput).toContain('sampling-replacement');
      if (mode === 'cold_omission') {
        const state = await session.saveState();
        await session.close();
        await using restored = await agent.session({
          state,
          providerHistory: { type: 'conversation', id: 'conv_current' },
        });
        await (await restored.submit('After.', { prepareRequest })).wait();
      } else {
        await (await session.submit('After.', { prepareRequest })).wait();
      }
      expect(model.requests).toHaveLength(2);
      expect(
        JSON.stringify(model.requests[1]!.input).includes('original-input'),
      ).toBe(mode === 'omission' || mode === 'cold_omission');
    },
    30000,
  );
}
nativeIt(
  'lineage sampling full idless multiplicity survives prefix insertion and initial reorder',
  async () => {
    const model = new ModelServer([[message('Before.')], [message('After.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
    });
    await using session = await agent.session({
      providerHistory: { type: 'conversation', id: 'conv_current' },
    });
    const snap = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: snap.revision,
      keep: snap.total,
      items: [
        { type: 'item_reference', id: 'provider_item' },
        { type: 'item_reference', id: 'provider_item' },
      ],
    });
    await (
      await session.submit('Before.', {
        prepareRequest({ request }) {
          request.input.reverse();
          request.input.unshift({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'sampling-prefix' }],
          });
          return request;
        },
      })
    ).wait();
    await (await session.submit('After.')).wait();
    expect(model.requests).toHaveLength(2);
  },
  30000,
);
nativeIt(
  'lineage sampling reduced idless group refuses before dispatch',
  async () => {
    const model = new ModelServer([[message('Recovered.')]]);
    const remote = await peer(model);
    await using provider = new NativeProvider(remote.options);
    const agent = new Agent({
      instructions: 'Continue.',
      model: 'gpt-5.5',
      provider,
    });
    await using session = await agent.session({
      providerHistory: { type: 'conversation', id: 'conv_current' },
    });
    const snap = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: snap.revision,
      keep: snap.total,
      items: [
        { type: 'item_reference', id: 'provider_item' },
        { type: 'item_reference', id: 'provider_item' },
      ],
    });
    await expect(
      (
        await session.submit('Before.', {
          prepareRequest({ request }) {
            const input = z.array(jsonObject).parse(request.input);
            const index = input.findIndex(
              (item) => item.type === 'item_reference',
            );
            input.splice(index, 1);
            request.input = input;
            return request;
          },
        })
      ).wait(),
    ).rejects.toThrow('ambiguous');
    expect(remote.wire).toEqual([]);
    await (await session.submit('Recovered.')).wait();
    expect(model.requests).toHaveLength(1);
    expect(
      z
        .array(jsonObject)
        .parse(model.requests[0]!.input)
        .filter((item) => item.type === 'item_reference'),
    ).toHaveLength(2);
  },
  30000,
);

nativeIt.each([false, true])(
  'refuses conversation-owned stored reverts without closing (%s)',
  async (remoteMode) => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-revert-'));
    try {
      const model = new ModelServer([
        [message('Before.')],
        [message('After.')],
      ]);
      const remote = await peer(model);
      await using provider = new NativeProvider(remote.options);
      const agent = new Agent({
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
      });
      const storage = localStorage(join(directory, 'threads'));
      await using session = await agent.session({
        storage,
        ...(remoteMode
          ? {
              providerHistory: {
                type: 'conversation' as const,
                id: 'conv_current',
              },
            }
          : {}),
      });
      const sourceId = session.id;
      await (await session.submit('Before.')).wait();
      const turns = [];
      for await (const turn of session.turns()) turns.push(turn.id);
      const before = await session.historySnapshot();
      if (remoteMode) {
        await expect(
          session.revertStored({ beforeTurnId: turns[0]! }),
        ).rejects.toThrow(
          'Revert is unavailable for provider-managed conversations',
        );
        const after = await session.historySnapshot();
        expect(after.items).toEqual(before.items);
        expect(after.revision).toEqual(before.revision);
        await (await session.submit('After.')).wait();
      } else {
        await session.revertStored({ beforeTurnId: turns[0]! });
        await using restored = await agent.session({
          storage,
          resume: sourceId,
        });
        expect((await restored.storedTurns()).turns).toEqual([]);
        await (await restored.submit('After.')).wait();
      }
      expect(model.requests).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

for (const kind of ['header', 'query', 'cold'] as const) {
  nativeIt.each([false, true])(
    `rebinds provider history through current ${kind} routing (%s)`,
    async (permitted) => {
      const model = new ModelServer([
        [message('Before.')],
        [message('After.')],
      ]);
      const remote = await peer(model, undefined, permitted);
      await using provider = new NativeProvider(remote.options);
      const original: ModelSettings = {
        store: true,
        extraHeaders: { 'x-history-route': 'A' },
        extraQuery: { tenant: 'A' },
      };
      const agent = new Agent({
        instructions: 'Continue.',
        model: 'gpt-5.5',
        provider,
        modelSettings: original,
      });
      await using source = await agent.session({
        providerHistory: { type: 'previous_response' },
      });
      await (await source.submit('Before.')).wait();
      const changed: ModelSettings = {
        ...(kind !== 'query'
          ? { extraHeaders: { 'x-history-route': 'B' } }
          : {}),
        ...(kind !== 'header' ? { extraQuery: { tenant: 'B' } } : {}),
      };
      const finish = async (
        active: typeof source,
        override?: ModelSettings,
      ) => {
        if (permitted) {
          await (
            await active.submit('After.', { modelSettingsOverride: override })
          ).wait();
        } else {
          await expect(
            (async () => {
              await (
                await active.submit('After.', {
                  modelSettingsOverride: override,
                })
              ).wait();
            })(),
          ).rejects.toThrow('anchor validation failed');
          expect(model.requests).toHaveLength(1);
          await (
            await active.submit('Retry the original route.', {
              modelSettingsOverride: original,
            })
          ).wait();
        }
      };
      if (kind === 'cold') {
        const state = await source.saveState();
        await source.close();
        const current = new Agent({
          instructions: 'Continue.',
          model: 'gpt-5.5',
          provider,
          modelSettings: { ...original, ...changed },
        });
        await using restored = await current.session({
          state,
          providerHistory: { type: 'previous_response', id: 'response-1' },
        });
        await finish(restored);
      } else await finish(source, changed);
      expect(remote.routing).toContainEqual({
        method: 'GET',
        header: kind === 'query' ? 'A' : 'B',
        query: kind === 'header' ? 'A' : 'B',
      });
      expect(model.requests).toHaveLength(2);
      expect(remote.routing.filter((item) => item.method === 'POST')).toEqual([
        { method: 'POST', header: 'A', query: 'A' },
        {
          method: 'POST',
          header: permitted && kind !== 'query' ? 'B' : 'A',
          query: permitted && kind !== 'header' ? 'B' : 'A',
        },
      ]);
    },
    30_000,
  );
}

nativeIt.each(['previous_response', 'conversation'] as const)(
  'rebinds stored %s on a fresh physical WebSocket',
  async (type) => {
    const sockets = new WebSocketServer({ noServer: true });
    const reads: Array<[string, string | undefined]> = [];
    const frames: Array<[number, Record<string, unknown>]> = [];
    let connections = 0;
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method !== 'GET') {
        posts++;
        response.writeHead(400).end();
        return;
      }
      const path = request.url ?? '';
      reads.push([path, request.headers.authorization]);
      if (request.headers.authorization !== 'Bearer current-owner') {
        response.writeHead(403).end();
        return;
      }
      const id = path.split('/').at(-1);
      const result = path.includes('/conversations/')
        ? { id, object: 'conversation' }
        : { id, status: 'completed' };
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(result));
    });
    fronts.push(server);
    server.on('upgrade', (request, socket, head) => {
      const number = ++connections;
      sockets.handleUpgrade(request, socket, head, (connection) => {
        connection.on('message', (raw) => {
          const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
          frames.push([number, payload]);
          const id = `resp_ws_${frames.length}`;
          const item = message(`answer ${frames.length}`);
          const send = (event: object) =>
            connection.send(JSON.stringify(event));
          send({ type: 'response.created', response: { id } });
          send({ type: 'response.output_item.done', output_index: 0, item });
          send({ type: 'response.completed', response: { id } });
        });
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (typeof address !== 'object' || address === null)
      throw new Error('Synthetic provider did not open a port');
    const options = {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      supportsWebsockets: true,
    };
    const sourceSelection =
      type === 'conversation' ? { type, id: 'conv_exact' } : { type };
    const restoredSelection =
      type === 'conversation'
        ? { type, id: 'conv_exact' }
        : { type, id: 'resp_ws_1' };
    try {
      const state = await (async () => {
        await using provider = new NativeProvider({
          ...options,
          apiKey: 'current-owner',
        });
        const source = new Agent({
          instructions: 'Keep only unsent input.',
          model: 'gpt-5.5',
          modelSettings: { store: true },
          provider,
        });
        await using session = await source.session({
          providerHistory: sourceSelection,
        });
        await (await session.submit('before')).wait();
        return await session.saveState();
      })();
      await using wrong = new NativeProvider({
        ...options,
        apiKey: 'wrong-owner',
      });
      const denied = new Agent({
        instructions: 'Keep only unsent input.',
        model: 'gpt-5.5',
        modelSettings: { store: true },
        provider: wrong,
      });
      await (async () => {
        await using session = await denied.session({
          state,
          providerHistory: restoredSelection,
        });
        await expect((await session.submit('denied')).wait()).rejects.toThrow(
          /Provider history anchor validation failed.*403/,
        );
      })();
      expect(frames).toHaveLength(1);
      await using provider = new NativeProvider({
        ...options,
        apiKey: 'current-owner',
      });
      const restored = new Agent({
        instructions: 'Keep only unsent input.',
        model: 'gpt-5.5',
        modelSettings: { store: true },
        provider,
      });
      await using session = await restored.session({
        state,
        providerHistory: restoredSelection,
      });
      await (await session.submit('after')).wait();
      expect(frames).toHaveLength(2);
      const [[firstSocket, first], [secondSocket, second]] = frames as [
        [number, Record<string, unknown>],
        [number, Record<string, unknown>],
      ];
      expect(firstSocket).not.toBe(secondSocket);
      expect(first.store).toBe(true);
      expect(second.store).toBe(true);
      expect(second.input).toEqual([expect.objectContaining({ role: 'user' })]);
      expect(JSON.stringify(second.input)).toContain('after');
      expect(JSON.stringify(second.input)).not.toContain('before');
      expect(posts).toBe(0);
      if (type === 'previous_response') {
        expect(first.previous_response_id).toBeUndefined();
        expect(second.previous_response_id).toBe('resp_ws_1');
        expect(reads).toEqual([
          ['/v1/responses/resp_ws_1', 'Bearer wrong-owner'],
          ['/v1/responses/resp_ws_1', 'Bearer current-owner'],
        ]);
      } else {
        expect(first.conversation).toBe('conv_exact');
        expect(second.conversation).toBe('conv_exact');
        expect(reads).toEqual([
          ['/v1/conversations/conv_exact', 'Bearer current-owner'],
          ['/v1/conversations/conv_exact', 'Bearer wrong-owner'],
          ['/v1/conversations/conv_exact', 'Bearer current-owner'],
        ]);
      }
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    }
  },
  15_000,
);
