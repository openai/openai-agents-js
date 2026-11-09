import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '@openai/agents';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('queries accepted reasoning history without treating it as final output or a reasoning stream event', async () => {
  const server = new ModelServer([
    [
      {
        type: 'reasoning',
        id: 'reasoning-history-proof',
        summary: [{ type: 'summary_text', text: 'retained reasoning summary' }],
        encrypted_content: 'synthetic-private-reasoning',
      },
      message('final answer'),
    ],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-reasoning-proof',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
  }).session();
  const turn = await session.submit('Reason first.');
  expect((await turn.wait()).finalOutput).toBe('final answer');
  const items = await Array.fromAsync(session.items());
  const reasoning = items.filter((item) => item.type === 'reasoning');
  expect(reasoning).toHaveLength(1);
  expect(reasoning[0]).toMatchObject({
    summary: [{ type: 'summary_text', text: 'retained reasoning summary' }],
  });
  expect(JSON.stringify(items)).not.toContain('synthetic-private-reasoning');
  const observations = await Array.fromAsync(turn.events());
  expect(observations.at(-1)).toMatchObject({
    type: 'turn_finished',
    status: 'completed',
  });
  expect(observations.some((event) => /reasoning/.test(event.type))).toBe(
    false,
  );
  expect(JSON.stringify(observations)).not.toContain(
    'synthetic-private-reasoning',
  );
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});
