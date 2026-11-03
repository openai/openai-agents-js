import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
  type Turn,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-preparation-cap',
    supportsWebsockets: false,
  });
}

// The public index counts beforeStep entries, including rejected/cancelled ones.
// This application policy limits which root preparations may proceed; it does not
// count transport retries, successful responses, internal work or child trees.
it.each([0, 1, 2])(
  'admits at most %i root preparations and fences the next provider request',
  async (limit) => {
    let effects = 0;
    const action = tool({
      name: 'step',
      parameters: z.object({}),
      execute: () => {
        effects++;
        return 'step finished';
      },
    });
    const server = new ModelServer([
      ...Array.from({ length: limit }, (_, index) => [
        call('step', {}, { callId: `budget-step-${index}` }),
      ]),
      [message('must not reach the provider')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use the admitted step tool.',
      provider,
      tools: [action],
    }).session();
    const exhausted = new Error('Application preparation cap reached');
    const indices: number[] = [];
    const owners: Turn<unknown>[] = [];
    const turn = await session.submit('go', {
      tools: [action],
      beforeStep({ submission, stepIndex }) {
        indices.push(stepIndex);
        owners.push(submission);
        if (stepIndex >= limit) throw exhausted;
        return [action];
      },
    });
    await expect(turn.wait()).rejects.toBe(exhausted);
    expect(indices).toEqual(Array.from({ length: limit + 1 }, (_, i) => i));
    expect(owners.every((owner) => owner === turn)).toBe(true);
    expect(server.requests).toHaveLength(limit);
    expect(effects).toBe(limit);
  },
  30_000,
);

it.each([1, 2])(
  'retains the remaining preparation cap of %i through the original manual reply',
  async (limit) => {
    const decision = manualTool({
      name: 'decision',
      description: 'Return the original decision.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'budget-decision' })],
      [message('finished')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask for a decision, then finish.',
      provider,
      tools: [decision],
    }).session();
    const exhausted = new Error('Application preparation cap reached');
    const indices: number[] = [];
    let remaining = limit;
    const turn = await session.submit('go', {
      tools: [decision],
      beforeStep({ stepIndex }) {
        indices.push(stepIndex);
        if (stepIndex >= limit) throw exhausted;
        remaining = limit - stepIndex - 1;
        return [decision];
      },
    });
    const batch = await turn.wait({ until: 'request' });
    if (!('requests' in batch))
      throw new Error('Expected the original request');
    expect(batch.requests).toHaveLength(1);
    const request = decision.match(batch.requests[0]);
    if (!request) throw new Error('Expected the original decision');
    expect(request.callId).toBe('budget-decision');
    const again = await turn.wait({ until: 'request' });
    if (!('requests' in again)) throw new Error('Expected the held request');
    const repeated = decision.match(again.requests[0]);
    expect(repeated).toMatchObject({
      sessionId: request.sessionId,
      submissionId: request.submissionId,
      turnId: request.turnId,
      callId: request.callId,
    });
    expect(indices).toEqual([0]);
    expect(remaining).toBe(limit - 1);
    expect(server.requests).toHaveLength(1);
    const reply = request.reply('approved');
    const completion = turn.wait();
    void completion.catch(() => undefined);
    await session.respond(reply);
    if (limit === 1) {
      await expect(completion).rejects.toBe(exhausted);
      expect(server.requests).toHaveLength(1);
    } else {
      expect((await completion).finalOutput).toBe('finished');
      expect(server.requests).toHaveLength(2);
      const input = JSON.stringify(server.requests[1]!.input);
      expect(input).toContain('budget-decision');
      expect(input).toContain('approved');
      server.assertExhausted();
    }
    expect(indices).toEqual([0, 1]);
    expect(remaining).toBe(0);
    await expect(session.respond(reply)).rejects.toThrow();
    expect(server.requests).toHaveLength(limit);
  },
  30_000,
);

it('starts a fresh preparation index for an independent root in the same Session', async () => {
  const server = new ModelServer([[message('first')], [message('second')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer once.',
    provider,
  }).session();
  const observed: { index: number; owner: Turn<unknown> }[] = [];
  const beforeStep = ({
    stepIndex,
    submission,
  }: {
    stepIndex: number;
    submission: Turn<unknown>;
  }) => {
    observed.push({ index: stepIndex, owner: submission });
    if (stepIndex >= 1) throw new Error('Application preparation cap reached');
    return undefined;
  };
  const first = await session.submit('first', { beforeStep });
  expect((await first.wait()).finalOutput).toBe('first');
  const second = await session.submit('second', { beforeStep });
  expect((await second.wait()).finalOutput).toBe('second');
  expect(observed.map(({ index }) => index)).toEqual([0, 0]);
  expect(observed.map(({ owner }) => owner)).toEqual([first, second]);
  expect(first).not.toBe(second);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it('keeps preparation indices through live steering and its original manual reply', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const decision = manualTool({
    name: 'decision',
    description: 'Return the original decision.',
    parameters: z.object({}),
    result: z.string(),
  });
  const marker = 'steering-budget-marker';
  const server = new ModelServer([
    async () => {
      entered.resolve();
      await release.promise;
      return [message('first native answer')];
    },
    [call('decision', {}, { callId: 'steered-budget-decision' })],
    [message('final native answer')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer, then handle retained steering.',
    provider,
    tools: [decision],
  }).session();
  const indices: number[] = [];
  const owners: Turn<unknown>[] = [];
  try {
    const turn = await session.submit('first', {
      beforeStep({ submission, stepIndex }) {
        indices.push(stepIndex);
        owners.push(submission);
        return [decision];
      },
    });
    const completion = turn.wait();
    void completion.catch(() => undefined);
    await entered.promise;
    await turn.steer(marker);
    release.resolve();
    const batch = await turn.wait({ until: 'request' });
    if (!('requests' in batch))
      throw new Error('Expected the successor request');
    expect(batch.turn).toBe(turn);
    expect(batch.requests).toHaveLength(1);
    const request = decision.match(batch.requests[0]);
    if (!request) throw new Error('Expected the original manual declaration');
    expect(request.callId).toBe('steered-budget-decision');
    expect(request.submissionId).toBe(turn.submissionId);
    await session.respond(request.reply('approved'));
    expect((await completion).finalOutput).toBe('final native answer');
    expect(indices).toEqual([0, 1, 2]);
    expect(owners.every((owner) => owner === turn)).toBe(true);
    expect(server.requests).toHaveLength(3);
    expect(JSON.stringify(server.requests[0]!.input)).not.toContain(marker);
    expect(JSON.stringify(server.requests[1]!.input)).toContain(marker);
    server.assertExhausted();
  } finally {
    release.resolve();
  }
}, 30_000);

it.each([1, 2])(
  'restores the remaining model steps after manual suspension (limit %i)',
  async (maxModelSteps) => {
    const decision = manualTool({
      name: 'decision',
      description: 'Request approval',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'approval' })],
      [message('finished')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Request approval and finish.',
      tools: [decision],
      provider,
    });
    await using session = await agent.session();
    const turn = await session.submit('go', { maxModelSteps });
    const batch = await turn.wait({ until: 'request' });
    expect(batch).toHaveProperty('requests');
    const state = parseSessionState(JSON.stringify(await session.suspend()));
    await session.close();
    expect(state).toMatchObject({ remaining_model_steps: maxModelSteps - 1 });
    await expect(agent.run(null, { state, maxModelSteps: 5 })).rejects.toThrow(
      'Cannot replace',
    );
    const resumed = agent.run(null, {
      state,
      onInteraction(action) {
        return decision.match(action)!.reply('approved');
      },
    });
    if (maxModelSteps === 1) {
      await expect(resumed).rejects.toMatchObject({
        code: 'max_model_steps_exceeded',
        retryable: false,
      });
    } else {
      await expect(resumed).resolves.toMatchObject({ finalOutput: 'finished' });
      expect(JSON.stringify(server.requests[1]!.input)).toContain('approved');
    }
    expect(server.requests).toHaveLength(maxModelSteps);
  },
  30_000,
);

it('enforces one-shot limits before sampling and gives a new run its own budget', async () => {
  const server = new ModelServer([[message('one')]]);
  await using provider = await providerFor(server);
  // A session factory may rebuild its opening options. The limit belongs
  // to the subsequent submission even when that factory forwards no options.
  class CustomAgent extends Agent {
    override session() {
      return super.session();
    }
  }
  const agent = new CustomAgent({ instructions: 'Answer.', provider });
  for (const maxModelSteps of [-1, 1.5, NaN, Infinity, 2 ** 53]) {
    await expect(agent.run('invalid', { maxModelSteps })).rejects.toThrow(
      'nonnegative safe integer',
    );
  }
  await expect(agent.run('zero', { maxModelSteps: 0 })).rejects.toMatchObject({
    code: 'max_model_steps_exceeded',
  });
  expect(server.requests).toHaveLength(0);
  await expect(agent.run('one', { maxModelSteps: 1 })).resolves.toMatchObject({
    finalOutput: 'one',
  });
  server.assertExhausted();
});
