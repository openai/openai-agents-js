import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  RecoverRun,
  localStorage,
  nativeGoals,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('appends recovered output to a portable native goal checkpoint', async () => {
  const server = new ModelServer([
    [message('{"answer":42}')],
    [message('{"answer":"continued"}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-goal-recovery',
    supportsWebsockets: false,
  });
  const outputType = z.object({ answer: z.string() });
  const directory = await mkdtemp(join(tmpdir(), 'native-goal-recovery-'));
  try {
    let saved;
    {
      await using session = await new Agent({
        instructions: 'Answer.',
        provider,
        outputType,
        tools: [nativeGoals()],
      }).session({ storage: localStorage(directory) });
      await session.setPausedGoal('Keep the established goal', {
        tokenBudget: 200,
      });
      saved = await session.saveState();
    }
    expect(saved.root_goal).toMatchObject({
      objective: 'Keep the established goal',
      status: 'paused',
      token_budget: 200,
    });
    const agent = new Agent({ instructions: 'Answer.', provider, outputType });
    const recovered = await agent.run('first', {
      state: saved,
      returnHistory: true,
      returnState: true,
      errorHandler: ({ kind }) => {
        expect(kind).toBe('invalid_output');
        return new RecoverRun({ answer: 'accepted fallback' });
      },
    });
    expect(recovered.finalOutput).toEqual({ answer: 'accepted fallback' });
    expect(JSON.stringify(recovered.history)).toContain('accepted fallback');
    expect(recovered.state?.root_goal).toEqual(saved.root_goal);
    await using restored = await agent.session({ state: recovered.state });
    const snapshot = await restored.historySnapshot();
    await expect(
      restored.transactHistory({
        expectedRevision: snapshot.revision,
        keep: 0,
        items: [],
      }),
    ).rejects.toThrow(
      'history transactions do not rewrite goal-backed sessions',
    );
    expect((await (await restored.submit('next')).wait()).finalOutput).toEqual({
      answer: 'continued',
    });
    expect(JSON.stringify(server.requests[1]?.input)).toContain(
      'accepted fallback',
    );
    expect((await restored.saveState()).root_goal).toEqual(saved.root_goal);
    server.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
