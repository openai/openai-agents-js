import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeError, tool, type Session } from '@openai/agents';
import {
  httpError,
  text,
  toolCall,
  withScriptedResponses,
  type ScriptedResponses,
} from '../../src/testing';

it('runs sequential public Sessions and closes the borrowed provider', async () => {
  let retained!: ScriptedResponses;
  let agent!: Agent;
  await withScriptedResponses([[text('discard')]], async (peer) => {
    retained = peer;
    expect(peer.remainingSteps).toBe(1);
    peer.clear();
    expect(peer.remainingSteps).toBe(0);
    peer.append([text('one')], [text('two')]);
    expect(peer.remainingSteps).toBe(2);
    agent = new Agent({
      instructions: 'Reply.',
      model: 'gpt-5.5',
      provider: peer.provider,
    });
    for (const expected of ['one', 'two']) {
      const session = await agent.session();
      try {
        const turn = await session.submit('Reply.');
        expect((await turn.wait()).finalOutput).toBe(expected);
        expect(peer.remainingSteps).toBe(1);
      } finally {
        await session.close();
      }
      if (expected === 'one') {
        peer.append([text('discard later')]);
        expect(peer.remainingSteps).toBe(2);
      }
    }
    peer.clear();
    expect(peer.remainingSteps).toBe(0);
    expect(peer.requests).toHaveLength(2);
  });
  retained.assertExhausted();
  expect(retained.remainingSteps).toBe(0);
  await expect(agent.session()).rejects.toThrow('closed');
});

it('executes one real context-bound tool and submits its output through Core', async () => {
  const context = { effects: 0 };
  await withScriptedResponses(
    [
      [toolCall('lookup', { key: 'a' }, { callId: 'lookup-1' })],
      [text('Found it.')],
      [text('Still found.')],
    ],
    async (peer) => {
      const agent = new Agent<typeof context>({
        instructions: 'Use lookup.',
        model: 'gpt-5.5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({ key: z.string() }),
            execute: ({ key }, ctx) => {
              expect(ctx.context).toBe(context);
              context.effects++;
              return `found:${key}`;
            },
          }),
        ],
      });
      const session = await agent.session({ context });
      try {
        expect(
          (await (await session.submit('Find a.')).wait()).finalOutput,
        ).toBe('Found it.');
        expect(
          (await (await session.submit('Remember?')).wait()).finalOutput,
        ).toBe('Still found.');
        expect(context.effects).toBe(1);
        expect(peer.toolOutput('lookup-1')).toBe('found:a');
        expect(peer.toolOutput('missing')).toBeUndefined();
        expect(peer.requests).toHaveLength(3);
      } finally {
        await session.close();
      }
    },
  );
});

it('preserves real terminal native HTTP failures and overflow', async () => {
  await withScriptedResponses([httpError(400)], async (peer) => {
    const agent = new Agent({
      instructions: 'Reply.',
      model: 'gpt-5.5',
      provider: peer.provider,
    });
    await expect(agent.run('Reply.')).rejects.toBeInstanceOf(NativeError);
  });
  let retained!: ScriptedResponses;
  let original: unknown;
  await withScriptedResponses([], async (peer) => {
    retained = peer;
    const agent = new Agent({
      instructions: 'Reply.',
      model: 'gpt-5.5',
      provider: peer.provider,
    });
    try {
      await agent.run('Reply.');
    } catch (error) {
      original = error;
      throw error;
    }
  }).then(
    () => {
      throw new Error('unexpected success');
    },
    (error) => expect(error).toBe(original),
  );
  expect(original).toBeInstanceOf(NativeError);
  expect(() => retained.assertExhausted()).toThrow('1 unexpected requests');
});

it('refuses an active borrowed Session while still closing its endpoint', async () => {
  let session: Session | undefined;
  let provider: ScriptedResponses['provider'] | undefined;
  let url = '';
  try {
    await expect(
      withScriptedResponses([], async (peer) => {
        provider = peer.provider;
        url = `${provider.baseUrl}/responses`;
        session = await new Agent({
          instructions: 'Reply.',
          model: 'gpt-5.5',
          provider,
        }).session();
      }),
    ).rejects.toThrow('open or opening sessions');
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
  } finally {
    await session?.close();
    await provider?.close();
  }
});

it('joins a real interrupted tool callback before ending the scripted scope', async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await withScriptedResponses(
    [[toolCall('held', {}, { callId: 'held-1' })]],
    async (peer) => {
      const session = await new Agent({
        instructions: 'Use held.',
        model: 'gpt-5.5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'held',
            parameters: z.object({}),
            execute: async (_args, { signal }) => {
              signal.addEventListener('abort', () => aborted.resolve(), {
                once: true,
              });
              entered.resolve();
              await release.promise;
              return 'late';
            },
          }),
        ],
      }).session();
      try {
        const turn = await session.submit('Begin');
        const failed = turn.wait().catch((error) => error);
        await entered.promise;
        await session.interrupt({ scope: 'all' });
        await aborted.promise;
        let closed = false;
        const closing = session.close().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
        release.resolve();
        await closing;
        expect(await failed).toBeInstanceOf(Error);
      } finally {
        release.resolve();
        await session.close();
      }
    },
  );
});

it('uses scripted usage and headers for real budget admission and rate observations', async () => {
  let effects = 0;
  await withScriptedResponses(
    [
      {
        items: [toolCall('lookup', {}, { callId: 'budget-lookup' })],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
        headers: {
          'x-ratelimit-limit-requests': '10',
          'x-ratelimit-remaining-requests': '5',
          'x-ratelimit-reset-requests': '1s',
        },
      },
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Use lookup.',
        model: 'gpt-5.5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'found';
            },
          }),
        ],
      });
      const session = await agent.session();
      try {
        const turn = await session.submit('Lookup.', {
          budget: { maxTokens: 7 },
        });
        await expect(turn.wait()).rejects.toMatchObject({
          code: 'run_budget_exceeded',
        });
        const events = [];
        for await (const event of turn.events()) events.push(event);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'api_rate_limits_updated',
            snapshot: expect.objectContaining({
              requests: { limit: 10, remaining: 5, resetAfterSeconds: 1 },
            }),
          }),
        );
        expect(effects).toBe(1);
        expect(peer.requests).toHaveLength(1);
      } finally {
        await session.close();
      }
    },
  );
});
