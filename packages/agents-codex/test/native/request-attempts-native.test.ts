import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  InteractionRequired,
  NativeAgents,
  NativeProvider,
  manualTool,
  tool,
  type RequestAttempts,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { startPublicExecutor } from './fixtures/public-executor';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

const unavailable = {
  availability: 'unavailable',
  counts: [],
  borrowedRequestsUnavailable: true,
};
const retry = {
  status: 503,
  headers: { 'content-type': 'application/json', 'retry-after': '0' },
  body: JSON.stringify({ error: { message: 'Synthetic retry' } }),
};
function expected(count: number, transport = 'http_sse') {
  return {
    availability: 'complete',
    counts: [{ owner: 'root', operation: 'generation', transport, count }],
    borrowedRequestsUnavailable: false,
  };
}
async function providerFor(
  server: ModelServer,
  requestMaxRetries = 0,
  responseMode: 'streaming' | 'buffered' = 'streaming',
) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-request-attempts',
    supportsWebsockets: false,
    requestMaxRetries,
    streamMaxRetries: 0,
    responseMode,
  });
}
function frozen(snapshot: RequestAttempts | undefined) {
  expect(snapshot).toBeDefined();
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot!.counts)).toBe(true);
  for (const count of snapshot!.counts)
    expect(Object.isFrozen(count)).toBe(true);
  expect(Object.keys(snapshot!).sort()).toEqual([
    'availability',
    'borrowedRequestsUnavailable',
    'counts',
  ]);
}

it('counts both actual sentinel HTTP retries and retains each exact turn snapshot after close', async () => {
  const server = new ModelServer([
    retry,
    [message('recovered')],
    [message('second')],
  ]);
  await using provider = await providerFor(server, 1);
  const session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
  }).session({ includeRequestAttempts: true });
  try {
    const first = await session.submit('first');
    expect((await first.wait()).finalOutput).toBe('recovered');
    expect(first.requestAttempts).toEqual(expected(2));
    expect(Number(first.runUsage.requests)).toBe(1);
    const snapshot = first.requestAttempts;
    frozen(snapshot);
    const second = await session.submit('second');
    await second.wait();
    expect(second.requestAttempts).toEqual(expected(1));
    expect(first.requestAttempts).toBe(snapshot);
    expect(server.requests).toHaveLength(3);
    await session.close();
    expect(first.requestAttempts).toBe(snapshot);
    expect(second.requestAttempts).toEqual(expected(1));
  } finally {
    await session.close();
  }
  server.assertExhausted();
});

it('leaves the default turn without a request-attempt snapshot', async () => {
  const server = new ModelServer([[message('done')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  const turn = await session.submit('go');
  expect(turn.requestAttempts).toBeUndefined();
  await turn.wait();
  expect(turn.requestAttempts).toBeUndefined();
  await session.close();
  expect(turn.requestAttempts).toBeUndefined();
  server.assertExhausted();
});

it('keeps the snapshot undefined until the exact turn settles', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    async () => {
      entered.resolve();
      await release.promise;
      return [message('done')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go');
  try {
    await entered.promise;
    expect(turn.requestAttempts).toBeUndefined();
    release.resolve();
    await turn.wait();
    expect(turn.requestAttempts).toEqual(expected(1));
  } finally {
    release.resolve();
  }
  server.assertExhausted();
});

it('retains every attempted retry after retry exhaustion', async () => {
  const server = new ModelServer([retry, retry]);
  await using provider = await providerFor(server, 1);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go');
  await expect(turn.wait()).rejects.toThrow();
  expect(turn.requestAttempts).toEqual(expected(2));
  const snapshot = turn.requestAttempts;
  await session.close();
  expect(turn.requestAttempts).toBe(snapshot);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it.each(['cancel', 'close'] as const)(
  'retains attempted requests after active %s',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('discarded')];
      },
    ]);
    await using provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session({ includeRequestAttempts: true });
    try {
      const turn = await session.submit('go');
      await entered.promise;
      expect(turn.requestAttempts).toBeUndefined();
      if (mode === 'cancel') await turn.cancel();
      else await session.close();
      await expect(turn.wait()).rejects.toThrow();
      expect(turn.requestAttempts).toEqual(expected(1));
      frozen(turn.requestAttempts);
      await session.close();
      expect(turn.requestAttempts).toEqual(expected(1));
    } finally {
      release.resolve();
      await session.close();
    }
    server.assertExhausted();
  },
);

it('reports buffered HTTP JSON separately from streaming HTTP', async () => {
  const server = new ModelServer([
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'resp_buffered_attempts',
        object: 'response',
        status: 'completed',
        output: [message('buffered done')],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    },
  ]);
  await using provider = await providerFor(server, 0, 'buffered');
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'fixture-hosted-responses',
    provider,
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go');
  expect((await turn.wait()).finalOutput).toBe('buffered done');
  expect(turn.requestAttempts).toEqual(expected(1, 'http_json'));
  server.assertExhausted();
});

it('marks borrowed model transport attempts unavailable instead of reporting zero', async () => {
  let callbacks = 0;
  await using provider = new NativeProvider({
    modelBackend: {
      complete: () => {
        callbacks++;
        return { output: [message('borrowed done')] };
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go');
  expect((await turn.wait()).finalOutput).toBe('borrowed done');
  expect(callbacks).toBe(1);
  expect(turn.requestAttempts).toEqual(unavailable);
  expect(turn.submissionRequestAttempts).toEqual(unavailable);
  frozen(turn.requestAttempts);
  await session.close();
  expect(turn.requestAttempts).toEqual(unavailable);
});

it('counts owned WebSocket create sends without recording response content', async () => {
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  let generations = 0;
  server.on('upgrade', (request, socket, head) => {
    ws.handleUpgrade(request, socket, head, (connection) =>
      connection.on('message', (data) => {
        const request = JSON.parse(data.toString());
        const warmup = request.generate === false;
        if (!warmup) generations++;
        const id = warmup ? 'warmup' : 'accepted';
        connection.send(
          JSON.stringify({ type: 'response.created', response: { id } }),
        );
        if (!warmup)
          connection.send(
            JSON.stringify({
              type: 'response.output_item.done',
              output_index: 0,
              item: message('PRIVATE_WEBSOCKET_CONTENT'),
            }),
          );
        connection.send(
          JSON.stringify({ type: 'response.completed', response: { id } }),
        );
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local WebSocket address');
  try {
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic',
      supportsWebsockets: true,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session({ includeRequestAttempts: true });
    const turn = await session.submit('go');
    expect((await turn.wait()).finalOutput).toBe('PRIVATE_WEBSOCKET_CONTENT');
    expect(generations).toBe(1);
    expect(turn.requestAttempts?.availability).toBe('complete');
    expect(
      turn.requestAttempts?.counts.filter(
        (entry) => entry.operation === 'generation',
      ),
    ).toEqual(expected(1, 'websocket').counts);
    expect(JSON.stringify(turn.requestAttempts)).not.toContain(
      'PRIVATE_WEBSOCKET_CONTENT',
    );
    frozen(turn.requestAttempts);
  } finally {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('attributes automatic compaction separately from root generation', async () => {
  const server = new ModelServer(
    [
      [call('lookup', {}, { callId: 'lookup' })],
      [message('Synthetic compacted history.')],
      [message('done')],
    ],
    [
      JSON.stringify({
        input_tokens: 260000,
        output_tokens: 1000,
        total_tokens: 261000,
      }),
    ],
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use lookup and answer.',
    model: 'gpt-5.5',
    provider,
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => 'lookup done',
      }),
    ],
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go');
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(server.requests).toHaveLength(3);
  expect(turn.requestAttempts?.availability).toBe('complete');
  expect(turn.requestAttempts?.counts).toEqual(
    expect.arrayContaining([
      {
        owner: 'root',
        operation: 'generation',
        transport: 'http_sse',
        count: 2,
      },
      {
        owner: 'root',
        operation: 'compaction',
        transport: 'http_sse',
        count: 1,
      },
    ]),
  );
  server.assertExhausted();
});

it('attributes a native child request admitted before its root settles', async () => {
  const childEntered = Promise.withResolvers<void>();
  let rootId: string | undefined;
  let rootCalls = 0;
  const respond = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id !== rootId) {
      childEntered.resolve();
      return [message('child done')];
    }
    if (rootCalls++ === 0)
      return [
        call(
          'spawn_agent',
          { task_name: 'worker', message: 'Answer.' },
          { namespace: 'collaboration', callId: 'spawn' },
        ),
      ];
    await childEntered.promise;
    return [message('root done')];
  };
  const server = new ModelServer(Array.from({ length: 3 }, () => respond));
  const executor = await startPublicExecutor();
  try {
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents()],
    }).session({
      includeRequestAttempts: true,
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    const turn = await session.submit('go');
    expect((await turn.wait()).finalOutput).toBe('root done');
    expect(turn.requestAttempts?.availability).toBe('complete');
    expect(turn.requestAttempts?.counts).toEqual(
      expect.arrayContaining([
        {
          owner: 'root',
          operation: 'generation',
          transport: 'http_sse',
          count: 2,
        },
        {
          owner: 'child',
          operation: 'generation',
          transport: 'http_sse',
          count: 1,
        },
      ]),
    );
    expect(server.requests).toHaveLength(3);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 20000);

it('captures a sealed explicit root while leaving restored native work outside capture', async () => {
  const decision = manualTool({
    name: 'decision',
    description: 'Choose.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('decision', {}, { callId: 'decision' })],
    [message('restored done')],
    [message('fresh done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Ask and answer.',
    provider,
    tools: [decision],
  });
  const source = await agent.session({ includeRequestAttempts: true });
  try {
    const original = await source.submit('go');
    const pending = await original.wait({ until: 'manual_tool' });
    expect(pending).toHaveProperty('requests');
    expect(original.requestAttempts).toBeUndefined();
    const state = await source.suspend();
    await expect(original.wait()).rejects.toBeInstanceOf(InteractionRequired);
    expect(original.requestAttempts).toEqual(expected(1));
    const snapshot = original.requestAttempts;
    await source.close();
    expect(original.requestAttempts).toBe(snapshot);
    await using restored = await agent.session({
      state,
      includeRequestAttempts: true,
      includeOutputAccepted: true,
    });
    const continuation = restored.restoredTurn;
    if (!continuation) throw new Error('Missing restored turn');
    let replied = false;
    for await (const interaction of restored.interactions()) {
      const request = decision.match(interaction);
      if (!request) continue;
      await restored.respond(request.reply('approved'));
      replied = true;
      break;
    }
    expect(replied).toBe(true);
    const accepted = [];
    for await (const event of continuation.events())
      if (event.type === 'output_accepted') accepted.push(event);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      sessionId: restored.id,
      submissionId: continuation.submissionId,
    });
    expect((await continuation.wait()).finalOutput).toBe('restored done');
    expect(continuation.requestAttempts).toBeUndefined();
    const fresh = await restored.submit('fresh');
    expect((await fresh.wait()).finalOutput).toBe('fresh done');
    expect(fresh.requestAttempts).toEqual(expected(1));
  } finally {
    await source.close();
  }
  server.assertExhausted();
});

it('keeps isolated output repair attempts outside the original native snapshot', async () => {
  const server = new ModelServer([
    [message('invalid')],
    [message('{"count":2}')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Count.',
    provider,
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go', {
    outputType: {
      mode: 'prompted',
      schema: z.object({ count: z.number() }),
      maxRetries: 1,
    },
  });
  expect((await turn.wait()).finalOutput).toEqual({ count: 2 });
  expect(server.requests).toHaveLength(2);
  expect(turn.requestAttempts).toEqual(expected(1));
  expect(turn.submissionRequestAttempts).toEqual(expected(2));
  frozen(turn.submissionRequestAttempts);
  server.assertExhausted();
});

it('retains owned repair sends after provider failure without counting a later unrelated submission', async () => {
  const server = new ModelServer([
    [message('invalid')],
    retry,
    [message('fresh')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Count',
    provider,
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go', {
    outputType: {
      mode: 'prompted',
      schema: z.object({ count: z.number() }),
      maxRetries: 1,
    },
  });
  await expect(turn.wait()).rejects.toThrow();
  expect(turn.requestAttempts).toEqual(expected(1));
  expect(turn.submissionRequestAttempts).toEqual(expected(2));
  const snapshot = turn.submissionRequestAttempts;
  const fresh = await session.submit('fresh');
  await fresh.wait();
  expect(fresh.submissionRequestAttempts).toEqual(expected(1));
  expect(turn.submissionRequestAttempts).toBe(snapshot);
  expect(server.requests).toHaveLength(3);
  server.assertExhausted();
});

it('retains owned repair sends after cancellation and keeps concurrent Session reports separate', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    [message('invalid')],
    async () => {
      entered.resolve();
      await release.promise;
      return [message('{"count":2}')];
    },
  ]);
  const otherServer = new ModelServer([[message('unrelated')]]);
  await using provider = await providerFor(server);
  await using otherProvider = await providerFor(otherServer);
  await using session = await new Agent({
    instructions: 'Count',
    provider,
  }).session({ includeRequestAttempts: true });
  await using other = await new Agent({
    instructions: 'Other',
    provider: otherProvider,
  }).session({ includeRequestAttempts: true });
  const turn = await session.submit('go', {
    outputType: {
      mode: 'prompted',
      schema: z.object({ count: z.number() }),
      maxRetries: 1,
    },
  });
  const result = turn.wait();
  void result.catch(() => {});
  try {
    await entered.promise;
    expect(turn.submissionRequestAttempts).toBeUndefined();
    const independent = await other.submit('other');
    await independent.wait();
    await turn.cancel();
    await expect(result).rejects.toThrow();
    expect(turn.requestAttempts).toEqual(expected(1));
    expect(turn.submissionRequestAttempts).toEqual(expected(2));
    expect(independent.submissionRequestAttempts).toEqual(expected(1));
  } finally {
    release.resolve();
  }
  server.assertExhausted();
  otherServer.assertExhausted();
});
