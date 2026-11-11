import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  fileSessionStore,
  isFunctionApprovalRequest,
  localStorage,
  manualTool,
  parseSessionState,
  tool,
  type RunBudget,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-run-budget',
    supportsWebsockets: false,
  });
}

const exceeded = { code: 'run_budget_exceeded', retryable: false };
const missing = { code: 'run_budget_usage_unavailable', retryable: false };

it.each([1, 2])(
  'keeps a budget of %i through live managed approval',
  async (maxRequests) => {
    const effects: string[] = [];
    const record = tool({
      name: 'record',
      parameters: z.object({}),
      needsApproval: true,
      execute: () => {
        effects.push('accepted');
        return 'recorded';
      },
    });
    const server = new ModelServer([
      [call('record', {}, { callId: 'approved-effect' })],
      ...(maxRequests === 2 ? [[message('Done')]] : []),
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Record and answer.',
      provider,
      tools: [record],
    });
    await using session = await agent.session();
    const turn = await session.submit('begin', { budget: { maxRequests } });
    let approved = false;
    for await (const event of session.interactions()) {
      if (!isFunctionApprovalRequest(event)) continue;
      expect(effects).toEqual([]);
      await expect(session.suspend()).rejects.toThrow(
        'Cannot capture an active run with a budget',
      );
      await session.respond(event.approve());
      approved = true;
      break;
    }
    expect(approved).toBe(true);
    if (maxRequests === 1)
      await expect(turn.wait()).rejects.toMatchObject(exceeded);
    else
      await expect(turn.wait()).resolves.toMatchObject({ finalOutput: 'Done' });
    expect(effects).toEqual(['accepted']);
    expect(server.requests).toHaveLength(maxRequests);
    server.assertExhausted();
  },
);

it.each(['local', 'custom'])(
  'starts a fresh budget after settled %s store reopen',
  async (backend) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-budget-reopen-'));
    try {
      const storage =
        backend === 'local'
          ? localStorage(join(directory, 'profile'))
          : fileSessionStore(directory);
      const server = new ModelServer([[message('First')], [message('Second')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({ instructions: 'Answer.', provider });
      const session = await agent.session({ storage });
      const identity = session.id;
      try {
        await expect(
          (
            await session.submit('first', { budget: { maxRequests: 1 } })
          ).wait(),
        ).resolves.toMatchObject({ finalOutput: 'First' });
        await expect(session.saveState()).rejects.toThrow('Persistent storage');
      } finally {
        await session.close();
      }
      await using reopened = await agent.session({ storage, resume: identity });
      expect(reopened.id).toBe(identity);
      await expect(
        (
          await reopened.submit('second', { budget: { maxRequests: 1 } })
        ).wait(),
      ).resolves.toMatchObject({ finalOutput: 'Second' });
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1]!.input)).toContain('First');
      server.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function reported(total: number): string {
  return JSON.stringify({
    input_tokens: total,
    output_tokens: 0,
    total_tokens: total,
  });
}

it.each([0, 2])(
  'admits %i root requests and their tool effects without requiring usage',
  async (maxRequests) => {
    let effects = 0;
    const action = tool({
      name: 'step',
      parameters: z.object({}),
      execute: () => ++effects,
    });
    const server = new ModelServer(
      Array.from({ length: maxRequests }, (_, index) => [
        call('step', {}, { callId: `budget-step-${index}` }),
      ]),
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use the tool.',
      provider,
      tools: [action],
    });
    await using session = await agent.session();
    const beforeStep = vi.fn(() => undefined);
    const turn = await session.submit('go', {
      budget: { maxRequests },
      beforeStep,
    });
    await expect(turn.wait()).rejects.toMatchObject(exceeded);
    const attention = await turn.waitForAttention();
    expect(attention).toMatchObject({
      type: 'needs_attention',
      reason: 'budget_exceeded',
      error: exceeded,
    });
    if (!('type' in attention)) throw new Error('Expected the budget stop');
    await expect(turn.wait()).rejects.toBe(attention.error);
    expect(beforeStep).toHaveBeenCalledTimes(maxRequests);
    expect(server.requests).toHaveLength(maxRequests);
    expect(effects).toBe(maxRequests);
    server.assertExhausted();
  },
);

it.each([7, 8])(
  'stops the next request after cumulative reported tokens reach %i',
  async (total) => {
    const execute = vi.fn(() => 'done');
    const action = tool({ name: 'step', parameters: z.object({}), execute });
    const server = new ModelServer(
      [
        [call('step', {}, { callId: 'first' })],
        [call('step', {}, { callId: 'second' })],
        [message('unexpected third request')],
      ],
      [reported(3), reported(total - 3)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use the tool.',
      provider,
      tools: [action],
    });
    const budget: RunBudget = { maxTokens: 7 };
    await expect(agent.run('go', { budget })).rejects.toMatchObject(exceeded);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(server.requests).toHaveLength(2);
  },
);

it('estimates reported responses on the next gate and leaves the final answer valid', async () => {
  const action = tool({
    name: 'step',
    parameters: z.object({}),
    execute: () => 'done',
  });
  const server = new ModelServer(
    [[call('step', {}, { callId: 'paid' })], [message('final answer')]],
    [reported(7), reported(8)],
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    tools: [action],
  });
  const estimateCostMicros = vi.fn(
    ({ totalTokens }) => Number(totalTokens) * 2,
  );
  await expect(
    agent.run('stop at equality', {
      budget: { maxEstimatedCostMicros: 14, estimateCostMicros },
    }),
  ).rejects.toMatchObject(exceeded);
  expect(estimateCostMicros).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ totalTokens: 7 }),
  );
  expect(server.requests).toHaveLength(1);
  await expect(
    agent.run('complete', {
      budget: { maxTokens: 1, maxEstimatedCostMicros: 14, estimateCostMicros },
    }),
  ).resolves.toMatchObject({ finalOutput: 'final answer' });
  expect(estimateCostMicros).toHaveBeenCalledTimes(1);
  server.assertExhausted();
});

it.each([
  { firstUsage: undefined, missingUsage: undefined, blocked: true },
  { firstUsage: undefined, missingUsage: 'continue', blocked: false },
  { firstUsage: reported(0), missingUsage: undefined, blocked: false },
] as const)(
  'distinguishes missing and zero usage ($firstUsage, $missingUsage)',
  async ({ firstUsage, missingUsage, blocked }) => {
    const action = tool({
      name: 'step',
      parameters: z.object({}),
      execute: () => 'done',
    });
    const server = new ModelServer(
      [[call('step', {}, { callId: 'step' })], [message('finished')]],
      [() => firstUsage],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      tools: [action],
    });
    await using session = await agent.session();
    const turn = await session.submit('go', {
      budget: { maxTokens: 1, missingUsage },
    });
    const pending = turn.wait();
    if (blocked) {
      await expect(pending).rejects.toMatchObject(missing);
      const attention = await turn.waitForAttention();
      expect(attention).toMatchObject({
        type: 'needs_attention',
        reason: 'budget_exceeded',
        error: missing,
      });
      if (!('type' in attention)) throw new Error('Expected the budget stop');
      await expect(turn.wait()).rejects.toBe(attention.error);
    } else
      await expect(pending).resolves.toMatchObject({ finalOutput: 'finished' });
    expect(server.requests).toHaveLength(blocked ? 1 : 2);
  },
);

it.each([
  { missingUsage: 'stop', useEstimator: true },
  { missingUsage: 'continue', useEstimator: true },
  { missingUsage: 'stop', useEstimator: false },
] as const)(
  'applies $missingUsage to an unknown estimate (estimator: $useEstimator)',
  async ({ missingUsage, useEstimator }) => {
    const action = tool({
      name: 'step',
      parameters: z.object({}),
      execute: () => 'done',
    });
    const server = new ModelServer(
      [[call('step', {}, { callId: 'step' })], [message('finished')]],
      [reported(0)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      tools: [action],
    });
    const estimateCostMicros = vi.fn(() => undefined);
    const pending = agent.run('go', {
      budget: {
        maxEstimatedCostMicros: 1,
        missingUsage,
        estimateCostMicros: useEstimator ? estimateCostMicros : undefined,
      },
    });
    if (missingUsage === 'stop')
      await expect(pending).rejects.toMatchObject(missing);
    else
      await expect(pending).resolves.toMatchObject({ finalOutput: 'finished' });
    if (useEstimator)
      expect(estimateCostMicros).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ totalTokens: 0 }),
      );
    expect(server.requests).toHaveLength(missingUsage === 'stop' ? 1 : 2);
  },
);

it.each([
  [
    'throwing',
    () => {
      throw new Error('private application data');
    },
  ],
  [
    'async',
    async () => {
      throw new Error('private application data');
    },
  ],
] as const)(
  'rejects a %s estimator without disclosing the error',
  async (_kind, estimateCostMicros) => {
    const action = tool({
      name: 'step',
      parameters: z.object({}),
      execute: () => 'done',
    });
    const server = new ModelServer(
      [[call('step', {}, { callId: 'step' })]],
      [reported(2)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      tools: [action],
    });
    const pending = agent.run('go', {
      budget: {
        maxEstimatedCostMicros: 1,
        // Exercise invalid JavaScript callbacks that bypass the public type.
        estimateCostMicros:
          estimateCostMicros as RunBudget['estimateCostMicros'],
      },
    });
    await expect(pending).rejects.toMatchObject({
      code: 'run_budget_invalid_estimate',
      retryable: false,
      message: expect.not.stringContaining('private application data'),
    });
    await expect(pending).rejects.not.toHaveProperty('cause');
    server.assertExhausted();
  },
);

it('validates before opening or allocating a root and preserves the independent step cap', async () => {
  const server = new ModelServer([[message('finished')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Answer.', provider });
  const opening = vi.spyOn(agent, 'session');
  for (const budget of [
    {},
    { maxRequests: -1 },
    { maxTokens: 2 ** 53 },
    { maxEstimatedCostMicros: 1.5 },
  ]) {
    await expect(agent.run('invalid', { budget })).rejects.toBeInstanceOf(
      TypeError,
    );
  }
  await expect(agent.run(null, { budget: { maxRequests: 1 } })).rejects.toThrow(
    'resuming',
  );
  expect(opening).not.toHaveBeenCalled();
  await using session = await agent.session();
  await expect(
    session.enqueue('invalid', { budget: {} }),
  ).rejects.toBeInstanceOf(TypeError);
  const stopped = await session.submit('step cap', {
    maxModelSteps: 0,
    budget: { maxRequests: 1 },
  });
  await expect(stopped.wait()).rejects.toMatchObject({
    code: 'max_model_steps_exceeded',
  });
  expect(server.requests).toHaveLength(0);
  const turn = await session.enqueue('go', {
    budget: { maxRequests: 1 },
  });
  await expect(turn.wait()).resolves.toMatchObject({ finalOutput: 'finished' });
  server.assertExhausted();
});

it('preserves the budget through a warm reply, refuses active capture, and resets on fresh roots', async () => {
  const decision = manualTool({
    name: 'decision',
    description: 'Request a decision.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('decision', {}, { callId: 'manual' })],
    [message('new root')],
    [message('restored idle')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    tools: [decision],
  });
  const budget = { maxRequests: 1 };
  await using session = await agent.session();
  const turn = await session.submit('go', { budget });
  const batch = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in batch)) throw new Error('Expected a manual request');
  const request = decision.match(batch.requests[0]);
  if (!request) throw new Error('Expected the decision request');
  const reason = 'Cannot capture an active run with a budget';
  expect(await session.checkpointStatus({ kind: 'manualWait' })).toEqual({
    status: 'notReady',
    reasons: [reason],
  });
  await expect(session.suspend()).rejects.toHaveProperty('message', reason);
  expect(server.requests).toHaveLength(1);
  await session.respond(request.reply('approved'));
  await expect(turn.wait()).rejects.toMatchObject(exceeded);
  expect(server.requests).toHaveLength(1);
  await expect(
    (await session.submit('new root', { budget })).wait(),
  ).resolves.toMatchObject({
    finalOutput: 'new root',
  });
  const state = parseSessionState(JSON.stringify(await session.saveState()));
  await expect(
    agent.run('restored idle', {
      state,
      budget,
      onInteraction: (action) => decision.match(action)!.reply('approved'),
    }),
  ).resolves.toMatchObject({ finalOutput: 'restored idle' });
  server.assertExhausted();
});

it('refuses automatic active capture from a one-shot run without a handler', async () => {
  const decision = manualTool({
    name: 'decision',
    description: 'Request a decision.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('decision', {}, { callId: 'manual' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Ask for a decision.',
    provider,
    tools: [decision],
  });
  await expect(
    agent.run('go', { budget: { maxRequests: 2 } }),
  ).rejects.toMatchObject({
    name: 'InteractionRequired',
    cause: expect.objectContaining({
      message: 'Cannot capture an active run with a budget',
    }),
  });
  server.assertExhausted();
});

it('retains a request limit when steering needs a successor', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    async () => {
      entered.resolve();
      await release.promise;
      return [message('first response')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  try {
    const turn = await session.submit('first', { budget: { maxRequests: 1 } });
    await entered.promise;
    await turn.steer('retained input');
    release.resolve();
    await expect(turn.wait()).rejects.toMatchObject(exceeded);
    expect(JSON.stringify(server.requests[0]!.input)).not.toContain(
      'retained input',
    );
    server.assertExhausted();
  } finally {
    release.resolve();
  }
});

it.each([1, 2])(
  'shares a limit of %i requests with an output correction',
  async (maxRequests) => {
    const server = new ModelServer([
      [message('invalid JSON')],
      ...(maxRequests === 2 ? [[message('{"count":2}')]] : []),
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const turn = await session.submit('go', {
      ...{ budget: { maxRequests }, maxModelSteps: 1 },
      outputType: {
        mode: 'prompted',
        schema: z.object({ count: z.number() }),
        maxRetries: 1,
      },
    });
    if (maxRequests === 1)
      await expect(turn.wait()).rejects.toMatchObject(exceeded);
    else
      await expect(turn.wait()).resolves.toMatchObject({
        finalOutput: { count: 2 },
      });
    server.assertExhausted();
  },
);
