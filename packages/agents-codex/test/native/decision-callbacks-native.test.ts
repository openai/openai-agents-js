import OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  ContinueTurn,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
  OpenAIDecisions,
  tool,
  type BoundDecide,
  type DecisionProvider,
  type TokenUsage,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());
const usage: TokenUsage = {
  inputTokens: 7,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 3,
  reasoningOutputTokens: 0,
  totalTokens: 10,
};
const wireUsage = (total: number) =>
  JSON.stringify({
    input_tokens: total,
    output_tokens: 0,
    total_tokens: total,
  });
async function providerFor(server: ModelServer) {
  const config = await server.config();
  const baseUrl = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  return new NativeProvider({
    baseUrl,
    apiKey: 'synthetic-decisions',
    supportsWebsockets: false,
  });
}
function decisionProvider(value = true): DecisionProvider {
  return {
    getDecision: vi.fn(async () => ({
      value: { response: value },
      usage,
      requestId: 'physical-decision',
      model: 'resolved-decision',
    })),
  };
}
function decisionReply(request: JsonObject, probability: number) {
  expect(request.model).toBe('gpt-6-luna');
  const questions = request.questions as JsonObject[];
  expect(questions).toHaveLength(1);
  expect(questions[0].type).toBe('predicate');
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'decision-http',
    },
    body: JSON.stringify({
      model: 'resolved-decision',
      answers: questions.map((question) => ({
        name: question.name,
        type: question.type,
        probability,
      })),
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }),
  };
}

nativeIt(
  'continues one turn through completion decisions with native accounting and the real shared compiler',
  async () => {
    const paths: string[] = [],
      counts: number[] = [],
      turns: string[] = [];
    let retained: BoundDecide | undefined;
    const server = new ModelServer(
      [
        [message('An explanation.')],
        (request) => decisionReply(request, 0.25),
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'Give one concrete next step.',
          );
          return [message('Open your account settings.')];
        },
        (request) => decisionReply(request, 0.75),
      ],
      [wireUsage(14), () => undefined, wireUsage(14)],
    );
    server.onRecord = (phase, detail) => {
      if (phase === 'MODEL_REQUEST')
        paths.push((detail as { path: string }).path);
    };
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Answer the customer.',
      decisions: new OpenAIDecisions({
        client: new OpenAI({ apiKey: 'synthetic', baseURL, maxRetries: 0 }),
      }),
      beforeComplete: async (context) => {
        counts.push(context.continuationCount);
        turns.push(context.turnId);
        retained = context.decide;
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.subagentId).toBeNull();
        const clear = await context.decide(
          'Does the customer have a clear next step?',
          { input: context.text! },
        );
        if (!clear) return new ContinueTurn('Give one concrete next step.');
      },
    });
    const result = await agent.run('Help with my account.');
    expect(result.finalOutput).toBe('Open your account settings.');
    expect(counts).toEqual([0, 1]);
    expect(new Set(turns).size).toBe(1);
    expect(paths).toEqual([
      '/v1/responses',
      '/v1/decisions',
      '/v1/responses',
      '/v1/decisions',
    ]);
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(48);
    expect(result.threadUsage?.lastTokenUsage.totalTokens).toBe(14);
    await expect(retained!('Expired?', { input: 'Explicit.' })).rejects.toThrow(
      /no longer active|abort/i,
    );
    server.assertExhausted();
  },
  30000,
);

nativeIt.each(['root', 'target', 'opening'] as const)(
  'keeps provider precedence across an active handoff (%s)',
  async (mode) => {
    const root = decisionProvider(false),
      target = decisionProvider(true),
      opening = decisionProvider(true);
    const server = new ModelServer(
      [[call('transfer_to_b', {}, { callId: 'handoff' })], [message('done')]],
      [wireUsage(14), wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const destination = new Agent({
      name: 'B',
      instructions: 'Finish.',
      ...(mode !== 'root' ? { decisions: target } : {}),
    });
    const agent = new Agent({
      model: 'gpt-5.5',
      name: 'A',
      instructions: 'Transfer.',
      provider,
      decisions: root,
      handoffs: [destination],
    });
    const observed: boolean[] = [];
    const result = await agent.run('Handle this.', {
      ...(mode === 'opening' ? { decisions: opening } : {}),
      beforeStep: async (context) => {
        observed.push(
          await context.decide('Ready?', { input: 'Explicit input only.' }),
        );
        return undefined;
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(observed).toEqual(
      mode === 'root'
        ? [false, false]
        : mode === 'target'
          ? [false, true]
          : [true, true],
    );
    expect(root.getDecision).toHaveBeenCalledTimes(
      mode === 'opening' ? 0 : mode === 'target' ? 1 : 2,
    );
    expect(target.getDecision).toHaveBeenCalledTimes(mode === 'target' ? 1 : 0);
    expect(opening.getDecision).toHaveBeenCalledTimes(
      mode === 'opening' ? 2 : 0,
    );
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(48);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'captures the root provider before a session wrapper suspends',
  async () => {
    const original = decisionProvider(false),
      replacement = decisionProvider(true);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const server = new ModelServer([[message('done')]], [wireUsage(14)]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions: original,
    });
    const open = agent.session.bind(agent);
    agent.session = (async (options: Parameters<typeof agent.session>[0]) => {
      entered.resolve();
      await release.promise;
      return open(options);
    }) as typeof agent.session;
    let observed: boolean | undefined;
    const run = agent.run('Go.', {
      beforeStep: async (context) => {
        observed = await context.decide('Ready?', { input: 'Explicit.' });
        return undefined;
      },
    });
    await entered.promise;
    agent.decisions = replacement;
    release.resolve();
    await run;
    expect(observed).toBe(false);
    expect(original.getDecision).toHaveBeenCalledTimes(1);
    expect(replacement.getDecision).not.toHaveBeenCalled();
  },
  30000,
);

nativeIt(
  'charges completion decisions before the next root budget gate',
  async () => {
    const decisions = decisionProvider();
    const server = new ModelServer([[message('candidate')]], [wireUsage(14)]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
      beforeComplete: async (context) => {
        await context.decide('Ready?', { input: context.text! });
        return new ContinueTurn('Try again.');
      },
    });
    await expect(
      agent.run('Go.', { budget: { maxTokens: 24 } }),
    ).rejects.toMatchObject({ code: 'run_budget_exceeded' });
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
  },
  30000,
);

nativeIt.each(['turn', 'session'] as const)(
  'joins %s cancellation with completed decision accounting and expires the callback helper',
  async (mode) => {
    const entered = Promise.withResolvers<void>(),
      aborted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let retained: BoundDecide | undefined;
    const decisions: DecisionProvider = {
      getDecision: vi.fn(async (_request, { signal }) => {
        signal!.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return {
          value: { response: true },
          usage,
          requestId: 'cancelled-decision',
        };
      }),
    };
    const server = new ModelServer([[message('unexpected')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
    }).session();
    const turn = await session.submit('Go.', {
      beforeStep: async (context) => {
        retained = context.decide;
        await context.decide('Ready?', { input: 'Explicit.' });
        return undefined;
      },
    });
    const result = turn.wait();
    const usageEvents: unknown[] = [];
    const observation = (async () => {
      for await (const event of turn.events())
        if (event.type === 'usage_updated' && event.usage)
          usageEvents.push(event.usage.totalTokenUsage.totalTokens);
    })();
    void observation.catch(() => {});
    void result.catch(() => {});
    void entered.promise.catch(() => {});
    void aborted.promise.catch(() => {});
    const watchdog = setTimeout(() => {
      const error = new Error('Decision cancellation fixture did not complete');
      entered.reject(error);
      aborted.reject(error);
      release.resolve();
    }, 20000);
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error('Turn completed before decision admission');
        }),
      ]);
      let stopped = false;
      const stopping = (mode === 'turn' ? turn.cancel() : session.close()).then(
        () => {
          stopped = true;
        },
      );
      await aborted.promise;
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      await expect(result).rejects.toThrow();
      await observation;
      expect(usageEvents.at(-1)).toBe(10);
      await expect(
        retained!('Expired?', { input: 'Explicit.' }),
      ).rejects.toThrow();
      expect(decisions.getDecision).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(0);
    } finally {
      clearTimeout(watchdog);
      release.resolve();
    }
  },
  40000,
);

nativeIt(
  'keeps a native child decision on the child usage ledger and out of the root budget',
  async () => {
    const executor = await startPublicExecutor();
    const approvalDecisions = decisionProvider();
    vi.mocked(approvalDecisions.getDecision).mockResolvedValue({
      value: { response: true },
      usage: { ...usage, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      requestId: 'approval-check',
    });
    const completed = Promise.withResolvers<void>();
    void completed.promise.catch(() => {});
    const watchdog = setTimeout(
      () =>
        completed.reject(new Error('Child decision callback did not complete')),
      20000,
    );
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const thread = (request: JsonObject) =>
      String(
        JSON.parse(
          (request.client_metadata as Record<string, string>)[
            'x-codex-turn-metadata'
          ],
        ).thread_id,
      );
    const reply = (request: JsonObject) => {
      const id = thread(request);
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id !== rootId) return [message('Child candidate.')];
      if (count === 1)
        return [
          call(
            'spawn_agent',
            {
              task_name: 'research',
              message: 'Check.',
              agent_type: 'research',
            },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      if (count === 2)
        return [call('wait_for_child', {}, { callId: 'join-child' })];
      return [message('Root finished.')];
    };
    const server = new ModelServer(
      Array.from({ length: 4 }, () => reply),
      Array.from(
        { length: 4 },
        () => (request: JsonObject) =>
          wireUsage(thread(request) === rootId ? 14 : 7),
      ),
    );
    try {
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use research.',
        decisions: decisionProvider(),
        beforeComplete: async (context) => {
          if (context.subagentId !== null) {
            try {
              await context.decide('Child ready?', { input: context.text! });
            } finally {
              completed.resolve();
            }
          }
        },
        tools: [
          new NativeAgents({
            approval: async (context, call) => {
              expect(call.name).toBe('spawn_agent');
              return context.decide('Permit this delegation?', {
                input: JSON.stringify(call.input),
                provider: approvalDecisions,
              });
            },
            additionalRoles: [
              new NativeRole({
                name: 'research',
                description: 'Checks.',
                instructions: 'Check the research.',
              }),
            ],
          }),
          tool({
            name: 'wait_for_child',
            parameters: z.object({}),
            execute: async () => {
              await completed.promise;
              return 'Child checked.';
            },
          }),
        ],
      });
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const result = await (
        await session.submit('Use research.', { budget: { maxTokens: 29 } })
      ).wait();
      expect(result.finalOutput).toBe('Root finished.');
      expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(42);
      const children = [];
      for await (const child of session.subagents()) children.push(child);
      expect(children).toHaveLength(1);
      const child = await children[0].turn!.wait();
      expect(child.finalOutput).toBe('Child candidate.');
      expect(child.threadUsage?.totalTokenUsage.totalTokens).toBe(17);
      expect(child.threadUsage?.lastTokenUsage.totalTokens).toBe(7);
      expect(approvalDecisions.getDecision).toHaveBeenCalledTimes(1);
      server.assertExhausted();
    } finally {
      clearTimeout(watchdog);
      completed.resolve();
      await executor.close();
    }
  },
  40000,
);

nativeIt(
  'inherits decisions in request preparation and scopes a tool provider override to that call',
  async () => {
    const inherited = decisionProvider(false),
      override = decisionProvider(true);
    const effects: boolean[] = [];
    const server = new ModelServer(
      [[call('check', {}, { callId: 'check' })], [message('done')]],
      [wireUsage(14), wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Check then finish.',
      decisions: inherited,
      tools: [
        tool({
          name: 'check',
          parameters: z.object({}),
          execute: async (_, context) => {
            const result = await context.decide('Ready?', {
              input: 'Tool input only.',
              provider: override,
            });
            effects.push(result);
            return result;
          },
        }),
      ],
    });
    const result = await agent.run('Go.', {
      budget: { maxRequests: 2, maxTokens: 100 },
      prepareRequest: async (context) => {
        expect(
          await context.decide('Ready?', { input: 'Preparation input only.' }),
        ).toBe(false);
        return undefined;
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(effects).toEqual([true]);
    expect(inherited.getDecision).toHaveBeenCalledTimes(2);
    expect(override.getDecision).toHaveBeenCalledTimes(1);
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(58);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'returns a typed standalone value through the actual shared compiler with one physical request',
  async () => {
    const server = new ModelServer([(request) => decisionReply(request, 0.75)]);
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    const decisions = new OpenAIDecisions({
      client: new OpenAI({ apiKey: 'synthetic', baseURL, maxRetries: 0 }),
    });
    await expect(
      decisions.decide('Ready?', {
        input: 'Explicit input.',
        outputType: z.strictObject({ ready: z.boolean() }),
      }),
    ).resolves.toEqual({ ready: true });
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'stops before HTTP when a beforeStep decision reaches the token budget',
  async () => {
    const decisions = decisionProvider();
    const server = new ModelServer([[message('unexpected')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
    });
    await expect(
      agent.run('Go.', {
        beforeStep: async (context) => {
          await context.decide('Ready?', { input: 'Explicit.' });
          return undefined;
        },
        budget: { maxRequests: 1, maxTokens: 10 },
      }),
    ).rejects.toMatchObject({ code: 'run_budget_exceeded' });
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(0);
  },
  30000,
);

nativeIt.each(['final', 'continue'] as const)(
  'preserves admitted preparation and checks auxiliary usage at the next gate (%s)',
  async (mode) => {
    const decisions = decisionProvider();
    let effects = 0;
    const server = new ModelServer(
      [
        [
          mode === 'final'
            ? message('done')
            : call('step', {}, { callId: 'step' }),
        ],
      ],
      [wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
      tools: [
        tool({
          name: 'step',
          parameters: z.object({}),
          execute: () => ++effects,
        }),
      ],
    });
    const result = agent.run('Go.', {
      prepareRequest: async (context) => {
        await context.decide('Ready?', { input: 'Explicit.' });
        return undefined;
      },
      budget:
        mode === 'final'
          ? { maxRequests: 1, maxTokens: 10 }
          : { maxRequests: 2, maxTokens: 24 },
    });
    if (mode === 'final') {
      const completed = await result;
      expect(completed.finalOutput).toBe('done');
      expect(completed.threadUsage?.totalTokenUsage.totalTokens).toBe(24);
    } else {
      await expect(result).rejects.toMatchObject({
        code: 'run_budget_exceeded',
      });
      expect(effects).toBe(1);
    }
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'replies to a failing completion callback and rejects its original turn',
  async () => {
    const server = new ModelServer([[message('candidate')]], [wireUsage(14)]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Answer.',
      beforeComplete: () => {
        throw new Error('Synthetic completion failure');
      },
    });
    await expect(agent.run('Go.')).rejects.toThrow(
      'Synthetic completion failure',
    );
    server.assertExhausted();
  },
  15000,
);
