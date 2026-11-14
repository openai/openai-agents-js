import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('preserves explicitly captured standard Responses reasoning across restore and clear', async () => {
  const server = new ModelServer(
    ['first', 'restored', 'override', 'cleared'].map((output) => [
      message(output),
    ]),
  );
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-reasoning-options-key',
    supportsWebsockets: false,
  });
  const options = {
    context: 'all_turns',
    mode: 'pro',
    vendor: { budget: 123 },
  };
  const agent = new Agent({
    model: 'fixture-unlisted-request-controls',
    instructions: 'Answer.',
    provider,
    modelSettings: { reasoningEffort: 'medium', reasoningOptions: options },
  });
  options.mode = 'mutated';
  let state;
  {
    await using session = await agent.session();
    expect((await (await session.submit('Begin.')).wait()).finalOutput).toBe(
      'first',
    );
    state = await session.saveState();
  }
  await using restored = await agent.session({ state });
  expect((await (await restored.submit('Continue.')).wait()).finalOutput).toBe(
    'restored',
  );
  await restored.update({
    modelSettings: { reasoningOptions: { context: null } },
  });
  await (await restored.submit('Change the reasoning context.')).wait();
  await restored.update({ modelSettings: { reasoningOptions: null } });
  await (await restored.submit('Reset options.')).wait();

  const expected = {
    context: 'all_turns',
    mode: 'pro',
    vendor: { budget: 123 },
    effort: 'medium',
    summary: 'auto',
  };
  expect(server.requests.map((request) => request.reasoning)).toEqual([
    expected,
    expected,
    { context: null, effort: 'medium', summary: 'auto' },
    { effort: 'medium', summary: 'auto' },
  ]);
  server.assertExhausted();
}, 30_000);
