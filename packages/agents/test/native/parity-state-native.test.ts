import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('restores retained native goal data using the current session store', async () => {
  const server = new ModelServer([
    [message('remembered')],
    [message('continued')],
  ]);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
  const agent = new Agent({
    instructions: 'Remember the conversation.',
    model: 'gpt-5',
    provider,
  });
  try {
    const first = await agent.run('Remember this.', { returnState: true });
    const state = first.state!;
    // Imported native snapshots may retain a paused goal without granting goal tools.
    state.root_goal = {
      thread_id: state.source_session_id,
      objective: 'Retained native objective',
      status: 'paused',
      token_budget: 100,
      tokens_used: 17,
      time_used_seconds: 3,
    };
    const restored = await agent.session({ state });
    try {
      expect(
        (await (await restored.submit('Continue.')).wait()).finalOutput,
      ).toBe('continued');
      const saved = await restored.saveState();
      expect(saved.root_goal).toMatchObject({
        objective: 'Retained native objective',
        status: 'paused',
        token_budget: 100,
        tokens_used: 17,
        time_used_seconds: 3,
      });
    } finally {
      await restored.close();
    }
    server.assertExhausted();
  } finally {
    await provider.close();
  }
});
