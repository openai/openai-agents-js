import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('preserves originals through repeated compaction without copying the prefix', async () => {
  const server = new ModelServer([]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-compaction-growth',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Keep the original available.',
    model: 'gpt-5',
    provider,
  });
  const payload = 'x'.repeat(128 * 1024);
  const original = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: payload }],
  };
  let retained;
  let saved;
  {
    await using session = await agent.session();
    const initial = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: initial.revision,
      keep: 0,
      items: [original],
    });
    retained = await session.historySnapshot();
    const beforeSize = JSON.stringify(await session.saveState()).length;
    for (let index = 0; index < 4; index++) {
      await session.compact({ summary: `Small replacement summary ${index}.` });
    }
    saved = await session.saveState();
    const afterSize = JSON.stringify(saved).length;
    expect(afterSize - beforeSize).toBeLessThan(payload.length);
    expect(await session.historySnapshot()).toEqual(retained);
  }
  await using restored = await agent.session({ state: saved });
  expect(await restored.historySnapshot()).toEqual(retained);
  expect(server.requests).toEqual([]);
  server.assertExhausted();
});
