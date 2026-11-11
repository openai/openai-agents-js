import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  TurnAborted,
  manualTool,
  type InteractionHandler,
  type Turn,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  createManualRequest,
  type ManualToolReply,
} from '../../src/runtime/manual';
import { startPublicExecutor } from './fixtures/public-executor';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
afterEach(() => ModelServer.closeAll());

it('keeps one interaction handler across typed roots and shares it with one-shot runs', async () => {
  const decision = manualTool({
    name: 'decision',
    description: 'Ask the application.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('decision', {}, { callId: 'first' })],
    [message('{"response":3}')],
    [call('decision', {}, { callId: 'second' })],
    [message('second answer')],
    [call('decision', {}, { callId: 'owned' })],
    [message('owned answer')],
  ]);
  await using provider = await providerFor(server);
  const seen: string[] = [];
  const decide: InteractionHandler = (request) => {
    const matched = decision.match(request);
    if (!matched) throw new Error('Unexpected interaction');
    seen.push(matched.callId);
    return matched.reply('accepted');
  };
  const agent = new Agent({
    instructions: 'Ask decision.',
    model: 'gpt-5',
    tools: [decision],
    provider,
  });
  {
    await using session = await agent.session({ onInteraction: decide });
    const first = await session.submit('Count.', { outputType: z.number() });
    expectTypeOf(first).toEqualTypeOf<Turn<number>>();
    expect((await first.wait()).finalOutput).toBe(3);
    const second = await session.submit('Answer.');
    expectTypeOf(second).toEqualTypeOf<Turn<string>>();
    expect((await second.wait()).finalOutput).toBe('second answer');
  }
  expect(
    (await agent.run('Owned.', { onInteraction: decide })).finalOutput,
  ).toBe('owned answer');
  expect(seen).toEqual(['first', 'second', 'owned']);
  server.assertExhausted();
});

it('joins an entered retained handler before cancellation or queued work can settle', async () => {
  const decision = manualTool({
    name: 'decision',
    description: 'Ask the application.',
    parameters: z.object({}),
    result: z.string(),
  });
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    [call('decision', {}, { callId: 'held' })],
    [message('next answer')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Ask.',
    model: 'gpt-5',
    tools: [decision],
    provider,
  }).session({
    async onInteraction(request, signal) {
      const matched = decision.match(request);
      if (!matched) throw new Error('Unexpected interaction');
      entered.resolve();
      try {
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
        return matched.reply('unreachable');
      } finally {
        cleaning.resolve();
        await release.promise;
      }
    },
  });
  const root = await session.submit('First.');
  await entered.promise;
  const next = await session.enqueue('Second.');
  const result = root.wait();
  const rejected = expect(result).rejects.toBeInstanceOf(TurnAborted);
  const stopping = root.cancel();
  await cleaning.promise;
  expect(next.turnId).toBeNull();
  expect(server.requests).toHaveLength(1);
  release.resolve();
  await stopping;
  await rejected;
  expect((await next.wait()).finalOutput).toBe('next answer');
  server.assertExhausted();
});

it('keeps the retained handler alive for a child after its root completes', async () => {
  const executor = await startPublicExecutor();
  const allowQuestion = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const decision = manualTool({
    name: 'decision',
    description: 'Ask the application.',
    parameters: z.object({}),
    result: z.string(),
  });
  const entered =
    Promise.withResolvers<NonNullable<ReturnType<typeof decision.match>>>();
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const server = new ModelServer(
    Array.from({ length: 4 }, () => async (request) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id === rootId)
        return count === 1
          ? [
              call(
                'spawn_agent',
                { task_name: 'worker', message: 'Ask decision.' },
                { namespace: 'collaboration', callId: 'spawn-worker' },
              ),
            ]
          : [message('root done')];
      if (count === 1) await allowQuestion.promise;
      return count === 1
        ? [call('decision', {}, { callId: 'manual-child' })]
        : [message('child done')];
    }),
  );
  let session: Awaited<ReturnType<Agent['session']>> | undefined;
  let provider: NativeProvider | undefined;
  try {
    provider = await providerFor(server);
    const retainedSession = await new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents(), decision],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
      async onInteraction(request) {
        const matched = decision.match(request);
        if (!matched) throw new Error('Unexpected interaction');
        expect(matched.subagentId).not.toBeNull();
        entered.resolve(matched);
        await release.promise;
        return matched.reply('accepted after root completion');
      },
    });
    session = retainedSession;
    const root = await retainedSession.submit('Delegate.');
    const result = await root.wait();
    expect(result.finalOutput).toBe('root done');
    allowQuestion.resolve();
    const { subagentId, turnId } = await entered.promise;
    // The handler can enter before the native event reader captures TurnStarted.
    const childTurn = await vi.waitUntil(
      async () => {
        const children = await Array.fromAsync(retainedSession.subagents());
        return (
          children.find(
            (child) => child.id === subagentId && child.turn?.turnId === turnId,
          )?.turn ?? false
        );
      },
      { timeout: 3000 },
    );
    release.resolve();
    expect((await childTurn.wait()).finalOutput).toBe('child done');
    await retainedSession.close();
    server.assertExhausted();
  } finally {
    allowQuestion.resolve();
    release.resolve();
    try {
      await session?.close();
    } finally {
      await provider?.[Symbol.asyncDispose]();
      await executor.close();
    }
  }
}, 30_000);

it.each([
  ['bound', true],
  ['delivered', true],
  ['missing', true],
  ['foreign', true],
  ['missing', false],
  ['foreign', false],
] as const)(
  'validates a %s handler return (answered by another consumer: %s)',
  async (kind, answered) => {
    const decision = manualTool({
      name: 'decision',
      description: 'Ask the application.',
      parameters: z.object({}),
      result: z.string(),
    });
    const entered = Promise.withResolvers<Parameters<InteractionHandler>[0]>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const continuing = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('decision', {}, { callId: 'held' })],
      async () => {
        continuing.resolve();
        await finish.promise;
        return [message('reader answer accepted')];
      },
    ]);
    await using provider = await providerFor(server);
    let delivered: ManualToolReply | undefined;
    await using session = await new Agent({
      instructions: 'Ask.',
      model: 'gpt-5',
      tools: [decision],
      provider,
    }).session({
      async onInteraction(request) {
        const matched = decision.match(request);
        if (!matched) throw new Error('Unexpected interaction');
        entered.resolve(request);
        await release.promise;
        returned.resolve();
        if (kind === 'delivered') return delivered!;
        if (kind === 'missing') return undefined as never;
        if (kind === 'foreign') {
          const foreign = createManualRequest(
            decision,
            {
              sessionId: 'foreign',
              submissionId: 'foreign',
              subagentId: null,
              turnId: 'foreign',
              callId: 'foreign',
            },
            {},
            () => true,
          ).request()!;
          return foreign.reply('foreign');
        }
        return matched.reply('handler answer');
      },
    });
    try {
      const root = await session.submit('First.');
      const result = root.wait();
      const expected =
        kind === 'bound' || kind === 'delivered'
          ? expect(result).resolves.toMatchObject({
              finalOutput: 'reader answer accepted',
            })
          : expect(result).rejects.toThrow(
              'onInteraction must return a reply to the manual request it received',
            );
      const request = decision.match(await entered.promise)!;
      delivered = request.reply('reader answer');
      if (answered) {
        await session.respond(delivered);
        await expect(session.respond(delivered)).rejects.toThrow();
        await continuing.promise;
      }
      release.resolve();
      await returned.promise;
      finish.resolve();
      await expected;
      if (answered) {
        expect(JSON.stringify(server.requests[1])).toContain('reader answer');
        expect(JSON.stringify(server.requests[1])).not.toContain(
          'handler answer',
        );
        server.assertExhausted();
      } else {
        expect(server.requests).toHaveLength(1);
      }
    } finally {
      release.resolve();
      finish.resolve();
    }
  },
);
