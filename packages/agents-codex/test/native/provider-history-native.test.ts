import { createServer, request as proxyRequest, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Agent, NativeProvider, StdioMCP, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

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

async function peer(model: ModelServer) {
  const wire: Array<[string | undefined, string | undefined]> = [];
  const auth: Array<{
    method: string | undefined;
    authorization: string | undefined;
    grant: string | string[] | undefined;
  }> = [];
  const reads: Array<[string | undefined, string | undefined]> = [];
  const port = await model.port();
  const front = createServer((request, response) => {
    wire.push([request.method, request.url]);
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
      const match = request.url?.match(
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
    reads,
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
  'refuses WebSocket lineage before any provider I/O',
  async () => {
    const model = new ModelServer([]);
    const remote = await peer(model);
    await using provider = new NativeProvider({
      ...remote.options,
      supportsWebsockets: true,
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
    ).rejects.toThrow('WebSocket');
    expect(remote.wire).toEqual([]);
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
