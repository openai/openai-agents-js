import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  ToolTimeoutError,
  tool,
  type ToolContext,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';
import { nativeDescendantModel } from './fixtures/native-descendant-model';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

function toolText(request: Record<string, unknown>, callId: string) {
  const item = (request.input as Array<Record<string, unknown>>).find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  );
  expect(item).toBeDefined();
  return typeof item!.output === 'string'
    ? item!.output
    : (item!.output as Array<{ text?: string }>)
        .map((part) => part.text ?? '')
        .join('');
}

it.each(['return', 'reject'] as const)(
  'continues a public root Session after timeout and %s cleanup',
  async (outcome) => {
    const stopped = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    let callbackContext: ToolContext | undefined;
    const after = vi.fn((output) => output);
    const server = new ModelServer([
      [call('slow', {}, { callId: 'slow-root' })],
      (request) => {
        expect(toolText(request, 'slow-root')).toBe('deadline:slow');
        return [message('recovered')];
      },
      [message('session still usable')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use slow.',
      provider,
      tools: [
        tool({
          name: 'slow',
          parameters: z.object({}),
          result: z.number(),
          callbackTimeout: 0.01,
          timeoutBehavior: 'error_as_result',
          after,
          async execute(_, context) {
            callbackContext = context;
            effects.push('effect');
            context.signal.addEventListener('abort', () => stopped.resolve(), {
              once: true,
            });
            await release.promise;
            effects.push('cleanup');
            if (outcome === 'reject') throw new Error('cleanup failed');
            return 123;
          },
          timeoutErrorFunction(context, error) {
            expect(effects).toEqual(['effect', 'cleanup']);
            expect(context.signal.aborted).toBe(false);
            expect(error).toBeInstanceOf(ToolTimeoutError);
            expect(callbackContext!.signal.reason).toBe(error);
            expect(error.timeoutSeconds).toBe(0.01);
            return `deadline:${error.toolName}`;
          },
        }),
      ],
    });
    await using session = await agent.session();
    const turn = await session.submit('start');
    let settled = false;
    const pending = turn.wait().finally(() => {
      settled = true;
    });
    try {
      await stopped.promise;
      expect(settled).toBe(false);
      expect(server.requests).toHaveLength(1);
      release.resolve();
      expect((await pending).finalOutput).toBe('recovered');
      expect(after).not.toHaveBeenCalled();
      expect(effects).toEqual(['effect', 'cleanup']);
      const finished = (await Array.fromAsync(turn.events())).filter(
        (event) => event.type === 'tool_finished',
      );
      expect(finished).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'slow', status: 'failed' }),
        ]),
      );
      expect((await (await session.submit('again')).wait()).finalOutput).toBe(
        'session still usable',
      );
      server.assertExhausted();
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  },
);

it.each(['raise_exception', 'error_as_result'] as const)(
  'retains cleanup failure when the parent cancels before a %s deadline',
  async (timeoutBehavior) => {
    const entered = Promise.withResolvers<void>();
    const cleanup = new Error('callback cleanup failed');
    const formatter = vi.fn(() => 'must not publish timeout text');
    const server = new ModelServer([
      [call('slow', {}, { callId: 'cancelled-before-deadline' })],
    ]);
    await using provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Use slow.',
      provider,
      tools: [
        tool({
          name: 'slow',
          parameters: z.object({}),
          callbackTimeout: 60,
          timeoutBehavior,
          timeoutErrorFunction: formatter,
          async execute(_, context) {
            const aborted = new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            entered.resolve();
            await aborted;
            throw cleanup;
          },
        }),
      ],
    }).session();
    const turn = await session.submit('start');
    const outcome = turn.wait().catch((error: unknown) => error);
    try {
      await entered.promise;
      const failure = await turn.cancel().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toContain(cleanup);
      expect(await outcome).toBeInstanceOf(AggregateError);
      expect(formatter).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    } finally {
      await session.close().catch(() => {});
      await outcome;
    }
  },
);

it.each(['cleanup', 'formatter'] as const)(
  'withholds timeout text when public root cancellation occurs during %s',
  async (stage) => {
    const stopped = Promise.withResolvers<void>();
    const formatterEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('slow', {}, { callId: 'cancelled-root' })],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use slow.',
      provider,
      tools: [
        tool({
          name: 'slow',
          parameters: z.object({}),
          callbackTimeout: 0.01,
          timeoutBehavior: 'error_as_result',
          async execute(_, context) {
            await new Promise<void>((resolve) =>
              context.signal.addEventListener(
                'abort',
                () => {
                  stopped.resolve();
                  resolve();
                },
                { once: true },
              ),
            );
            if (stage === 'cleanup') await release.promise;
            return 'late';
          },
          async timeoutErrorFunction() {
            formatterEntered.resolve();
            await release.promise;
            return 'must not publish timeout text';
          },
        }),
      ],
    }).session();
    const turn = await session.submit('start');
    const outcome = turn.wait().catch((error: unknown) => error);
    try {
      await (stage === 'cleanup' ? stopped.promise : formatterEntered.promise);
      const cancelled = turn.cancel();
      release.resolve();
      await cancelled;
      expect(await outcome).toBeInstanceOf(Error);
      expect(server.requests).toHaveLength(1);
      expect(
        JSON.stringify(await Array.fromAsync(session.items())),
      ).not.toContain('must not publish timeout text');
      server.assertExhausted();
    } finally {
      release.resolve();
      await outcome;
    }
  },
);

it.each(['raise_exception', 'error_as_result'] as const)(
  'handles %s in a public child after root completion',
  async (timeoutBehavior) => {
    const executor = await startPublicExecutor();
    const allowChild = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const server = new ModelServer(
      Array.from(
        { length: timeoutBehavior === 'error_as_result' ? 5 : 4 },
        () => async (request) => {
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
                    { task_name: 'worker', message: 'Use slow.' },
                    { namespace: 'collaboration', callId: 'spawn-worker' },
                  ),
                ]
              : [message(count === 2 ? 'root done' : 'root still usable')];
          if (count === 1) {
            await allowChild.promise;
            return [call('slow', {}, { callId: 'slow-child' })];
          }
          expect(toolText(request, 'slow-child')).toBe('child deadline');
          return [message('child recovered')];
        },
      ),
    );
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: nativeDescendantModel,
        provider,
        tools: [
          new NativeAgents(),
          tool({
            name: 'slow',
            parameters: z.object({}),
            callbackTimeout: 0.01,
            timeoutBehavior,
            async execute(_, context) {
              effects.push('effect');
              context.signal.addEventListener(
                'abort',
                () => stopped.resolve(),
                { once: true },
              );
              await release.promise;
              effects.push('cleanup');
              throw new Error('cleanup rejection');
            },
            timeoutErrorFunction(context, error) {
              expect(context.signal.aborted).toBe(false);
              expect(error).toBeInstanceOf(ToolTimeoutError);
              expect(effects).toEqual(['effect', 'cleanup']);
              return 'child deadline';
            },
          }),
        ],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect(
        (await (await session.submit('delegate')).wait()).finalOutput,
      ).toBe('root done');
      allowChild.resolve();
      await stopped.promise;
      const children = await Array.fromAsync(session.subagents());
      const child = children[0]?.turn;
      if (!child) throw new Error('Expected captured child turn');
      let settled = false;
      const outcome = child
        .wait()
        .then(
          (value) => value,
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      if (timeoutBehavior === 'error_as_result')
        expect(await outcome).toMatchObject({ finalOutput: 'child recovered' });
      else expect(await outcome).toBeInstanceOf(ToolTimeoutError);
      expect(effects).toEqual(['effect', 'cleanup']);
      expect((await (await session.submit('again')).wait()).finalOutput).toBe(
        'root still usable',
      );
      server.assertExhausted();
      expect(
        executor.requests.some((request) => request.method === 'process/start'),
      ).toBe(false);
    } finally {
      allowChild.resolve();
      release.resolve();
      await executor.close();
    }
  },
  30_000,
);

it('runs the public scripted timeout policy example', async () => {
  const { runToolTimeoutPolicyExample } =
    await import('../../../../examples/codex/tool-timeout-policy');
  await expect(runToolTimeoutPolicyExample()).resolves.toEqual({
    finalOutput: 'The lookup timed out. Please try another source.',
    failureText: 'slow_lookup timed out after 0.02 seconds.',
    effects: ['lookup started', 'cleanup finished'],
  });
});
