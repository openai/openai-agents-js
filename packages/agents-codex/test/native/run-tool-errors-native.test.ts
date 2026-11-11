import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type ToolErrorContext,
  type ToolErrorFormatter,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-run-tool-errors',
    supportsWebsockets: false,
  });
}

const cases = (['arguments', 'execution'] as const).flatMap((phase) =>
  (
    [
      'formatted',
      'empty',
      'undefined',
      'throws',
      'invalid',
      'per-tool',
      'suppressed',
      'omitted',
    ] as const
  ).map((policy) => ({ phase, policy, managed: false })),
);
cases.push({ phase: 'arguments', policy: 'formatted', managed: true });
cases.push({ phase: 'arguments', policy: 'per-tool', managed: true });

it.each(cases)(
  'owns $phase recovery with $policy (managed: $managed)',
  async ({ phase, policy, managed }) => {
    const recovered = policy !== 'suppressed' && policy !== 'omitted';
    const server = new ModelServer([
      [
        call(
          'lookup',
          { key: phase === 'arguments' ? 7 : 'valid' },
          { callId: 'run-error' },
        ),
      ],
      ...(recovered ? [[message('recovered')]] : []),
    ]);
    await using selected = await provider(server);
    const application = { label: 'owning-session' };
    const original = new Error('synthetic-private-function-failure');
    const seen: ToolErrorContext<typeof application>[] = [];
    let body = 0;
    let after = 0;
    let local = 0;
    const formatter: ToolErrorFormatter<typeof application> = async (
      context,
    ) => {
      seen.push(context);
      expect(context.context).toBe(application);
      expect(context.call.callId).toBe('run-error');
      expect(context.call.tool.name).toBe('lookup');
      expect(context.phase).toBe(phase);
      if (phase === 'arguments')
        expect(context.error).toBeInstanceOf(z.ZodError);
      else expect(context.error).toBe(original);
      if (policy === 'throws')
        throw new Error('synthetic-private-formatter-failure');
      if (policy === 'invalid') return 7 as unknown as string;
      if (policy === 'empty') return '';
      if (policy === 'undefined') return undefined;
      return 'session recovery';
    };
    const checked = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      result: z.object({ accepted: z.boolean() }),
      finishTurn: true,
      needsApproval: managed,
      execute() {
        body++;
        throw original;
      },
      after(output) {
        after++;
        return output;
      },
      ...(policy === 'suppressed' ? { errorFunction: null } : {}),
      ...(policy === 'per-tool'
        ? phase === 'arguments'
          ? {
              inputErrorFunction: () => {
                local++;
                return 'local recovery';
              },
            }
          : {
              errorFunction: () => {
                local++;
                return 'local recovery';
              },
            }
        : {}),
    });
    const agent = new Agent<typeof application>({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider: selected,
      tools: [checked],
    });
    await using session = await agent.session({
      context: application,
      ...(policy === 'omitted' ? {} : { toolErrorFormatter: formatter }),
    });
    const outcome = (await session.submit('begin')).wait();
    if (!recovered) {
      if (phase === 'execution') await expect(outcome).rejects.toBe(original);
      else await expect(outcome).rejects.toBeInstanceOf(z.ZodError);
      expect(seen).toHaveLength(0);
    } else {
      expect((await outcome).finalOutput).toBe('recovered');
      expect(seen).toHaveLength(policy === 'per-tool' ? 0 : 1);
      expect(local).toBe(policy === 'per-tool' ? 1 : 0);
      const encoded = JSON.stringify(server.requests[1]!.input);
      const expected =
        policy === 'per-tool'
          ? 'local recovery'
          : policy === 'formatted'
            ? 'session recovery'
            : policy === 'empty'
              ? ''
              : phase === 'arguments'
                ? "Invalid arguments for function 'lookup'."
                : "Function 'lookup' failed.";
      expect(encoded).toContain(expected);
      expect(encoded).not.toContain(original.message);
      expect(encoded).not.toContain('synthetic-private-formatter-failure');
    }
    expect(body).toBe(phase === 'arguments' ? 0 : 1);
    expect(after).toBe(0);
    server.assertExhausted();
  },
);

it('inherits global argument formatting beside a per-tool body formatter through Agent.run', async () => {
  const server = new ModelServer([
    [call('lookup', { key: 7 }, { callId: 'global-input' })],
    [message('done')],
  ]);
  await using selected = await provider(server);
  let global = 0;
  let local = 0;
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({ key: z.string() }),
        execute: () => {
          throw new Error('must not execute');
        },
        errorFunction: () => {
          local++;
          return 'body only';
        },
      }),
    ],
  });
  expect(
    (
      await agent.run('begin', {
        toolErrorFormatter: (context) => {
          global++;
          expect(context.phase).toBe('arguments');
          return 'run recovery';
        },
      })
    ).finalOutput,
  ).toBe('done');
  expect({ global, local }).toEqual({ global: 1, local: 0 });
  expect(JSON.stringify(server.requests[1]!.input)).toContain('run recovery');
  server.assertExhausted();
});

it.each([false, true])(
  'joins global formatter cancellation without late publication (cleanup error: %s)',
  async (cleanupError) => {
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'cancel-format' })],
    ]);
    await using selected = await provider(server);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('synthetic-formatter-cleanup');
    let exited = false;
    const session = await new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute() {
            throw new Error('body failure');
          },
        }),
      ],
    }).session({
      toolErrorFormatter: async () => {
        entered.resolve();
        try {
          await release.promise;
        } finally {
          exited = true;
        }
        if (cleanupError) throw failure;
        return 'late recovery';
      },
    });
    try {
      const turn = await session.submit('begin');
      const outcome = turn.wait().catch((error: unknown) => error);
      await entered.promise;
      const cancellation = turn.cancel().catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exited).toBe(false);
      release.resolve();
      const [cancelResult, result] = await Promise.all([cancellation, outcome]);
      expect(exited).toBe(true);
      expect(server.requests).toHaveLength(1);
      if (cleanupError) {
        const errors = [cancelResult, result].flatMap((error) =>
          error instanceof AggregateError ? error.errors : [error],
        );
        expect(errors).toContain(failure);
      }
      server.assertExhausted();
    } finally {
      release.resolve();
      await session.close().catch(() => {});
    }
  },
);

it.each(['before', 'effective input', 'result', 'after', 'approval'] as const)(
  'leaves %s failures with their existing owner despite a global formatter',
  async (phase) => {
    const server = new ModelServer([
      [call('lookup', { key: 'valid' }, { callId: 'fatal-policy' })],
    ]);
    await using selected = await provider(server);
    let formatted = 0;
    const checked = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      result: z.string(),
      needsApproval:
        phase === 'approval'
          ? () => {
              throw new Error('approval failure');
            }
          : false,
      before() {
        if (phase === 'before') throw new Error('policy failure');
        if (phase === 'effective input')
          return {
            action: 'replaceArguments' as const,
            arguments: { key: 7 as unknown as string },
          };
        return { action: 'allow' as const };
      },
      execute: () =>
        phase === 'result' ? (7 as unknown as string) : 'valid result',
      after(output) {
        if (phase === 'after') throw new Error('after failure');
        return output;
      },
    });
    await using session = await new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider: selected,
      tools: [checked],
    }).session({
      toolErrorFormatter: () => {
        formatted++;
        return 'must not recover';
      },
    });
    await expect((await session.submit('begin')).wait()).rejects.toThrow();
    expect(formatted).toBe(0);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it.each(['resolve', 'reject'] as const)(
  'lets a %s-based asynchronous formatter observe invocation cancellation',
  async (settlement) => {
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'formatter-signal' })],
    ]);
    await using selected = await provider(server);
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const release = Promise.withResolvers<void>();
    let aborted = false;
    let exited = false;
    const session = await new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute() {
            throw new Error('body failure');
          },
        }),
      ],
    }).session({
      toolErrorFormatter: async (context) => {
        entered.resolve(context.signal);
        context.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            if (settlement === 'reject') release.reject(context.signal.reason);
            else release.resolve();
          },
          { once: true },
        );
        try {
          await release.promise;
          return 'late formatter result';
        } finally {
          exited = true;
        }
      },
    });
    const turn = await session.submit('begin');
    const outcome = turn.wait().catch(() => undefined);
    try {
      const signal = await entered.promise;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
      await turn.cancel();
      await outcome;
      expect({ aborted, exited }).toEqual({ aborted: true, exited: true });
      expect(signal!.aborted).toBe(true);
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    } finally {
      release.resolve();
      await turn.cancel().catch(() => {});
      await session.close().catch(() => {});
      await outcome;
    }
  },
);
