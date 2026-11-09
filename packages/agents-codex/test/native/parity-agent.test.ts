import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type ToolContext,
  type SessionOptions,
  type ObservedEvent,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const test = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

async function providerFor(server: ModelServer) {
  const config = await server.config();
  const provider = config['model_providers.fixture'] as { base_url: string };
  return new NativeProvider({
    baseUrl: provider.base_url,
    apiKey: 'fixture-key',
  });
}
afterEach(() => ModelServer.closeAll());

describe('Python-aligned public Agent API', () => {
  test('captures typed context, decodes structured output, and returns restorable state', async () => {
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'lookup-1' })],
      [message('{"answer":42}')],
      [message('{"answer":43}')],
    ]);
    const provider = await providerFor(server);
    const context = { account: 'a' };
    let invoked: ToolContext<typeof context> | undefined;
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({ count: z.number().default(42) }),
      execute: async ({ count }, info: ToolContext<typeof context>) => {
        invoked = info;
        return count;
      },
    });
    const agent = new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      outputType: z.object({ answer: z.number() }),
      tools: [lookup],
    });
    const result = await agent.run('Answer', { context, returnState: true });
    const answer: number = result.finalOutput.answer;
    expect(answer).toBe(42);
    expect(invoked?.context).toBe(context);
    expect(invoked?.submission).toBe(result.turn);
    expect(invoked?.originalArguments).toEqual({});
    expect(invoked?.effectiveArguments).toEqual({ count: 42 });
    expect(result.state).toBeDefined();
    expect(await result.turn.wait()).toMatchObject({
      finalOutput: { answer: 42 },
    });
    const resumed = await agent.run('Next', { context, state: result.state });
    expect(resumed.finalOutput).toEqual({ answer: 43 });
    expect(resumed.turn.sessionId).toBe(result.turn.sessionId);
    expect(resumed.turn).not.toBe(result.turn);
    await provider.close();
    server.assertExhausted();
  });

  test('copies constructor declarations and uses the current provider for each new session', async () => {
    const inspectDeclaration = (request: Record<string, unknown>) => {
      expect(request.reasoning).toMatchObject({ effort: 'low' });
      expect(request.tools).toEqual([
        expect.objectContaining({ type: 'function', name: 'lookup' }),
      ]);
    };
    const first = new ModelServer([
      (request) => {
        inspectDeclaration(request);
        return [message('first provider')];
      },
    ]);
    const second = new ModelServer([
      (request) => {
        inspectDeclaration(request);
        return [message('second provider')];
      },
    ]);
    const initialProvider = await providerFor(first);
    const nextProvider = await providerFor(second);
    const tools = [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => 'record',
      }),
    ];
    const modelSettings = { reasoningEffort: 'low' };
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider: initialProvider,
      tools,
      modelSettings,
    });
    tools.length = 0;
    modelSettings.reasoningEffort = 'high';
    try {
      expect((await agent.run('First')).finalOutput).toBe('first provider');
      agent.provider = nextProvider;
      expect((await agent.run('Second')).finalOutput).toBe('second provider');
      first.assertExhausted();
      second.assertExhausted();
    } finally {
      await initialProvider.close();
      await nextProvider.close();
    }
  });

  test('fences provider close after acquisition and while live, then closes permanently', async () => {
    const server = new ModelServer([[message('ok')]]);
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer briefly.',
      model: 'gpt-5',
      provider,
    });
    const acquired = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const acquire = provider._acquire.bind(provider);
    const spy = vi.spyOn(provider, '_acquire').mockImplementation(() => {
      const lease = acquire();
      return {
        ...lease,
        async open() {
          acquired.resolve();
          await proceed.promise;
          return lease.open();
        },
      };
    });
    const opening = agent.session();
    await acquired.promise;
    try {
      await expect(provider.close()).rejects.toThrow();
    } finally {
      proceed.resolve();
      spy.mockRestore();
    }
    const session = await opening;
    try {
      await expect(provider.close()).rejects.toThrow();
      const turn = await session.submit({
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      });
      expect((await turn.wait()).finalOutput).toBe('ok');
    } finally {
      await session.close();
    }
    await provider.close();
    await expect(agent.session()).rejects.toThrow();
    server.assertExhausted();
  });

  it('rejects proxy settings in seatbelt before acquiring the provider', async () => {
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt');
    vi.stubEnv('https_proxy', 'http://127.0.0.1:1');
    vi.stubEnv('NO_PROXY', '*');
    const agent = new Agent({ instructions: 'Answer briefly.' });
    try {
      const opening = agent.session().then((session) => session.close());
      await Promise.all([
        expect(opening).rejects.toThrow(/proxy/i),
        expect(agent.provider.close()).resolves.toBeUndefined(),
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('rejects unsupported input before provider work and exposes only declared tools', async () => {
    const server = new ModelServer([
      (request) => {
        expect(request.tools).toEqual([]);
        return [message('text only')];
      },
    ]);
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    await expect(
      agent.run({
        role: 'user',
        content: [{ type: 'input_image', image_url: 'file:///tmp/image.png' }],
      }),
    ).rejects.toThrow('Unsupported media URL scheme');
    expect(server.requests).toHaveLength(0);
    expect((await agent.run('Hello')).finalOutput).toBe('text only');
    await provider.close();
    server.assertExhausted();
  });

  test('streams to independent cursors and keeps each history iterator on its original snapshot', async () => {
    const release = Promise.withResolvers<void>();
    const streamedOutput = 'hello' + '.'.repeat(4_200);
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* Drain the request body. */
      }
      const index = ++requests;
      const text = index === 1 ? streamedOutput : 'next';
      const item = {
        type: 'message',
        id: `message-${index}`,
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      };
      const send = (event: unknown) =>
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ type: 'response.created', response: { id: `response-${index}` } });
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, content: [] },
      });
      send({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: index === 1 ? 'hello' : text,
      });
      if (index === 1) {
        await release.promise;
        for (let i = 0; i < 4_200; i++)
          send({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: '.',
          });
      }
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({
        type: 'response.completed',
        response: {
          id: `response-${index}`,
          output: [item],
          usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 8,
          },
        },
      });
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'fixture',
    });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    let session: Awaited<ReturnType<typeof agent.session>> | undefined;
    try {
      session = await agent.session();
      const left = session.events();
      const right = session.events();
      const turn = await session.submit('Hello');
      let delta;
      for (;;) {
        const next = await left.next();
        if (next.done) throw new Error('Stream ended before its text delta');
        if ('type' in next.value && next.value.type === 'output_text_delta') {
          delta = next.value;
          break;
        }
      }
      expect(delta).toMatchObject({
        turnId: turn.turnId,
        submissionId: turn.submissionId,
        delta: 'hello',
      });
      let rightDelta;
      for (;;) {
        const next = await right.next();
        if (next.done)
          throw new Error('Second stream ended before its text delta');
        if ('type' in next.value && next.value.type === 'output_text_delta') {
          rightDelta = next.value;
          break;
        }
      }
      expect(rightDelta).toEqual(delta);
      await left.return!();
      release.resolve();
      const first = await turn.wait();
      expect(first.finalOutput).toBe(streamedOutput);
      expect((await right.next()).value).toMatchObject({ type: 'gap' });
      expect(first.threadUsage).toMatchObject({
        totalTokenUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      });
      const snapshot = session.items();
      const firstItem = await snapshot.next();
      const second = await session.submit('Again');
      expect((await second.wait()).finalOutput).toBe('next');
      const oldItems = firstItem.done ? [] : [firstItem.value];
      for await (const item of snapshot) oldItems.push(item);
      expect(oldItems.some((item) => item.turnId === second.turnId)).toBe(
        false,
      );
      const current = [];
      for await (const item of session.items()) current.push(item);
      expect(current).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: streamedOutput }],
          }),
          expect.objectContaining({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'next' }],
          }),
        ]),
      );
      expect(await turn.wait()).toBe(first);
      await right.return!();
    } finally {
      release.resolve();
      try {
        await session?.close();
        await provider.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }, 10_000);

  test('unwraps a primitive structured output and rejects unconstrained output before a request', async () => {
    const server = new ModelServer([[message('{"response":7}')]]);
    const provider = await providerFor(server);
    const unsupported = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      outputType: z.unknown(),
    });
    await expect(unsupported.run('Invalid')).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      outputType: z.number(),
    });
    expect((await agent.run('Count')).finalOutput).toBe(7);
    await provider.close();
    server.assertExhausted();
  });

  test('uses the public session override for one-shot runs and keeps explicit string output as plaintext', async () => {
    class ObservedAgent extends Agent {
      opened = 0;
      observed: Promise<ObservedEvent[]> | undefined;
      override async session(options: SessionOptions = {}) {
        this.opened++;
        const session = await super.session(options);
        this.observed = (async () => {
          const events = [];
          for await (const event of session.events()) events.push(event);
          return events;
        })();
        return session;
      }
    }
    const server = new ModelServer([[message('plain text, not JSON')]]);
    const provider = await providerFor(server);
    const agent = new ObservedAgent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      outputType: z.string(),
    });
    expect((await agent.run('Hello')).finalOutput).toBe('plain text, not JSON');
    expect(agent.opened).toBe(1);
    const events = await agent.observed!;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn_started' }),
        expect.objectContaining({ type: 'turn_finished', status: 'completed' }),
        expect.objectContaining({ type: 'session_ended' }),
      ]),
    );
    await provider.close();
    server.assertExhausted();
  });
});

test('validates blank structured output and exempts only explicit compaction', async () => {
  const server = new ModelServer([
    [{ ...message('   '), phase: 'final_answer' }],
    [message('{"answer":7}')],
    [message('Summary: answer seven.')],
  ]);
  const provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Return an answer object.',
    model: 'gpt-5',
    provider,
    outputType: z.object({ answer: z.number() }),
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session();
    const blank = await session.submit('First answer');
    await expect(blank.wait()).rejects.toBeInstanceOf(Error);
    for await (const event of session.events()) {
      if (event.type === 'turn_finished' && event.turnId === blank.turnId) {
        expect(event.status).toBe('failed');
        break;
      }
    }
    const valid = await (await session.submit('Try again')).wait();
    expect(valid.finalOutput).toEqual({ answer: 7 });
    await session.compact();
    expect(await session.wait()).toBe(valid);
    server.assertExhausted();
  } finally {
    try {
      await session?.close();
    } finally {
      await provider.close();
    }
  }
});
