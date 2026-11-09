import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  toolRef,
  type ModelSettings,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const MODEL = 'fixture-unlisted-request-controls';
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-controls-key',
    supportsWebsockets: false,
  });
}
afterEach(() => ModelServer.closeAll());
function checkValues(
  request: Record<string, any>,
  cap = 23,
  temperature: number | null = 0.4,
) {
  expect(request.max_output_tokens).toBe(cap);
  if (temperature === null) expect(request).not.toHaveProperty('temperature');
  else expect(request.temperature).toBe(temperature);
  expect(request.top_p).toBe(0.7);
  expect(request.parallel_tool_calls).toBe(false);
  expect(request.text.verbosity).toBe('high');
  expect(request.metadata).toEqual({ workflow: 'captured' });
  expect(request.store).toBe(true);
  expect(request.prompt_cache_retention).toBe('24h');
  expect(request.prompt_cache_options).toEqual({ ttl: '12h' });
  expect(request).not.toHaveProperty('request_controls');
}

it('captures actual wire controls, preserves sparse updates and restores values and clears', async () => {
  const server = new ModelServer(
    Array.from({ length: 5 }, () => [message('finished')]),
  );
  const metadata = { workflow: 'captured' };
  const settings: ModelSettings = {
    maxOutputTokens: 23,
    temperature: 0.4,
    topP: 0.7,
    parallelToolCalls: false,
    verbosity: 'high',
    metadata,
    store: true,
    promptCacheRetention: '24h',
    promptCacheTtl: '12h',
  };
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: MODEL,
    instructions: 'Answer.',
    provider,
    modelSettings: settings,
  });
  metadata.workflow = 'mutated';
  settings.maxOutputTokens = 999;
  const session = await agent.session();
  let saved;
  let cleared;
  try {
    expect((await (await session.submit('initial')).wait()).finalOutput).toBe(
      'finished',
    );
    await session.update({
      modelSettings: { maxOutputTokens: 47, temperature: null },
    });
    await (await session.submit('patch')).wait();
    saved = await session.saveState();
    await session.update({
      modelSettings: {
        maxOutputTokens: null,
        topP: null,
        parallelToolCalls: null,
        verbosity: null,
        metadata: null,
        store: null,
        promptCacheRetention: null,
        promptCacheTtl: null,
      },
    });
    await (await session.submit('cleared')).wait();
    cleared = await session.saveState();
  } finally {
    await session.close();
  }
  {
    await using restored = await agent.session({ state: saved! });
    await (await restored.submit('captured')).wait();
  }
  {
    await using restored = await agent.session({ state: cleared! });
    await (await restored.submit('clears')).wait();
  }
  checkValues(server.requests[0]!);
  checkValues(server.requests[1]!, 47, null);
  checkValues(server.requests[3]!, 47, null);
  for (const index of [2, 4]) {
    const request = server.requests[index]!;
    for (const field of [
      'max_output_tokens',
      'temperature',
      'top_p',
      'metadata',
      'prompt_cache_retention',
      'prompt_cache_options',
    ])
      expect(request).not.toHaveProperty(field);
    expect(request.store).toBe(false);
    expect(request.parallel_tool_calls).toBe(true);
    expect(
      (request.text as { verbosity?: unknown } | undefined)?.verbosity,
    ).toBeUndefined();
  }
  server.assertExhausted();
}, 40_000);

it.each([
  [undefined, undefined],
  ['30m', 'in_memory'],
  ['12h', '24h'],
  ['12h', undefined],
  [undefined, '24h'],
] as const)(
  'keeps TTL %s and retention %s independent, with omission unchanged',
  async (ttl, retention) => {
    const server = new ModelServer([[message('finished')]]);
    await using provider = await providerFor(server);
    await new Agent({
      model: MODEL,
      instructions: 'Answer.',
      provider,
      modelSettings: {
        ...(ttl === undefined ? {} : { promptCacheTtl: ttl }),
        ...(retention === undefined ? {} : { promptCacheRetention: retention }),
      },
    }).run('cache');
    if (ttl === undefined) {
      expect(server.requests[0]).not.toHaveProperty('prompt_cache_options');
    } else {
      expect(server.requests[0]?.prompt_cache_options).toEqual({ ttl });
    }
    if (retention === undefined)
      expect(server.requests[0]).not.toHaveProperty('prompt_cache_retention');
    else expect(server.requests[0]?.prompt_cache_retention).toBe(retention);
    server.assertExhausted();
  },
  25_000,
);

it.each([
  { maxOutputTokens: 0 },
  { maxOutputTokens: true },
  { maxOutputTokens: 2 ** 53 },
  { temperature: NaN },
  { temperature: 2.01 },
  { topP: -0.1 },
  { parallelToolCalls: 1 },
  { store: 'true' },
  { metadata: { x: 'v'.repeat(513) } },
])('rejects invalid controls before resource opening: %j', (settings) => {
  expect(
    () =>
      new Agent({
        instructions: 'Never open.',
        modelSettings: settings as ModelSettings,
      }),
  ).toThrow();
});

it.each([undefined, 'crm'])(
  'narrows to the captured named leaf in namespace %s and clears with a literal',
  async (namespace) => {
    const effects: string[] = [];
    const selected = tool({
      name: 'selected',
      namespace,
      parameters: z.object({}),
      execute: () => {
        effects.push('selected');
        return 'selected-result';
      },
    });
    const excluded = tool({
      name: 'excluded',
      parameters: z.object({}),
      execute: () => {
        effects.push('excluded');
        return 'excluded-result';
      },
    });
    const server = new ModelServer([
      [call('selected', {}, { callId: 'selected-once', namespace })],
      [message('finished')],
      [message('literal cleared')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      model: MODEL,
      instructions: 'Select.',
      tools: [selected, excluded],
      provider,
      modelSettings: { toolChoice: toolRef('selected', namespace) },
    }).session();
    await (await session.submit('named')).wait();
    await session.update({ modelSettings: { toolChoice: 'auto' } });
    await (await session.submit('literal')).wait();
    expect(effects).toEqual(['selected']);
    for (const request of server.requests.slice(0, 2)) {
      expect(request.tool_choice).toBe('required');
      const specs = request.tools as Record<string, any>[];
      expect(specs).toHaveLength(1);
      const spec = specs[0]!;
      if (spec.type === 'namespace') {
        expect(spec.name).toBe(namespace ?? 'functions');
        expect(spec.tools.map((item: any) => item.name)).toEqual(['selected']);
      } else {
        expect(namespace).toBeUndefined();
        expect(spec.name).toBe('selected');
      }
    }
    expect(server.requests[2]?.tool_choice).toBe('auto');
    expect(JSON.stringify(server.requests[2]?.tools)).toContain('excluded');
    server.assertExhausted();
  },
  30_000,
);

it.each(['unadmitted', 'operation', 'beforeStep', 'deferred'] as const)(
  'cannot revive a named target removed by %s',
  async (removed) => {
    const selected = tool({
      name: 'selected',
      deferLoading: removed === 'deferred',
      parameters: z.object({}),
      execute: () => {
        throw new Error('Rejected target executed');
      },
    });
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    await expect(
      (async () => {
        await using session = await new Agent({
          model: removed === 'deferred' ? 'gpt-5.5' : MODEL,
          instructions: 'Select.',
          provider,
          tools: [selected],
          modelSettings: {
            toolChoice: toolRef(
              removed === 'unadmitted' ? 'not-captured' : 'selected',
            ),
          },
        }).session();
        await (
          await session.submit(
            'reject',
            removed === 'operation'
              ? { tools: [] }
              : removed === 'beforeStep'
                ? { beforeStep: () => [] }
                : {},
          )
        ).wait();
      })(),
    ).rejects.toThrow(/named|tool|defer/i);
    expect(server.requests).toEqual([]);
    server.assertExhausted();
  },
  25_000,
);

it('stops an explicit output cap after one completed tool without retry or replay', async () => {
  const effects: string[] = [];
  const committed = tool({
    name: 'committed',
    parameters: z.object({}),
    execute: () => {
      effects.push('one');
      return 'committed-result';
    },
  });
  const limit = JSON.stringify({
    type: 'response.incomplete',
    response: {
      id: 'response-2',
      incomplete_details: { reason: 'max_output_tokens' },
    },
  });
  const server = new ModelServer(
    [
      [call('committed', {}, { callId: 'committed-once' })],
      [message('partial')],
    ],
    [],
    undefined,
    [
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'response-1' },
      }),
      limit,
    ],
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: MODEL,
    instructions: 'Act.',
    tools: [committed],
    provider,
    modelSettings: { maxOutputTokens: 17 },
  }).session();
  await expect((await session.submit('limited')).wait()).rejects.toThrow(
    'max_output_tokens',
  );
  expect(effects).toEqual(['one']);
  expect(server.requests).toHaveLength(2);
  expect(server.requests.map((request) => request.max_output_tokens)).toEqual([
    17, 17,
  ]);
  const turns = [];
  for await (const turn of session.turns()) turns.push(turn);
  expect(turns.at(-1)?.responses?.at(-1)).toMatchObject({
    status: 'incomplete',
    incompleteReason: 'max_output_tokens',
  });
  server.assertExhausted();
}, 30_000);

it('sends controls on real native WebSocket generation frames', async () => {
  const peer = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/v1/responses',
  });
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  const frames: Record<string, any>[] = [];
  const errors: unknown[] = [];
  peer.on('connection', (socket) =>
    socket.on('message', (payload) => {
      try {
        const frame = JSON.parse(payload.toString());
        frames.push(frame);
        const id = `ws-${frames.length}`;
        socket.send(
          JSON.stringify({ type: 'response.created', response: { id } }),
        );
        if (frame.generate !== false)
          socket.send(
            JSON.stringify({
              type: 'response.output_item.done',
              output_index: 0,
              item: message('websocket'),
            }),
          );
        socket.send(
          JSON.stringify({ type: 'response.completed', response: { id } }),
        );
      } catch (error) {
        errors.push(error);
        socket.close();
      }
    }),
  );
  try {
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-ws-controls',
      supportsWebsockets: true,
    });
    const result = await new Agent({
      model: MODEL,
      instructions: 'Answer.',
      provider,
      modelSettings: {
        maxOutputTokens: 29,
        temperature: 0.25,
        metadata: { wire: 'websocket' },
        promptCacheTtl: '12h',
        promptCacheRetention: 'in_memory',
      },
    }).run('websocket');
    expect(result.finalOutput).toBe('websocket');
    const generated = frames.filter((frame) => frame.generate !== false);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every((frame) => frame.max_output_tokens === 29)).toBe(
      true,
    );
    expect(generated.at(-1)).toMatchObject({
      temperature: 0.25,
      metadata: { wire: 'websocket' },
      prompt_cache_options: { ttl: '12h' },
      prompt_cache_retention: 'in_memory',
    });
    expect(errors).toEqual([]);
  } finally {
    for (const socket of peer.clients) socket.terminate();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  }
}, 30_000);

it('rejects known Lite before publishing a model or controls change', async () => {
  const server = new ModelServer([[message('still standard')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: MODEL,
    instructions: 'Answer.',
    provider,
    modelSettings: { maxOutputTokens: 31 },
  }).session();
  await expect(session.update({ model: 'gpt-5.6-sol' })).rejects.toThrow(
    /standard Responses|Responses Lite/,
  );
  expect(
    (await (await session.submit('old settings remain')).wait()).finalOutput,
  ).toBe('still standard');
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]).toMatchObject({
    model: MODEL,
    max_output_tokens: 31,
  });
  server.assertExhausted();
}, 30_000);

it('surfaces provider rejection of an unknown model control without dropping it or retrying', async () => {
  const body = JSON.stringify({
    error: {
      type: 'invalid_request_error',
      code: 'unsupported_parameter',
      message: 'unsupported explicit temperature',
    },
  });
  const server = new ModelServer([{ status: 400, body }]);
  await using provider = await providerFor(server);
  await expect(
    new Agent({
      model: MODEL,
      instructions: 'Answer.',
      provider,
      modelSettings: { temperature: 0.4 },
    }).run('unsupported'),
  ).rejects.toThrow(/unsupported explicit temperature/);
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]?.temperature).toBe(0.4);
  server.assertExhausted();
}, 30_000);
