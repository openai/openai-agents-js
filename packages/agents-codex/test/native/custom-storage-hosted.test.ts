import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, fileSessionStore, webSearch } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('retains provider-hosted search in the selected canonical backend across native resume', async () => {
  const action = { type: 'search', query: 'synthetic query', sources: [] };
  const server = new ModelServer([
    [
      { type: 'web_search_call', id: 'ws_stored', status: 'completed', action },
      message('stored answer'),
    ],
    [message('continued')],
  ]);
  const config = await server.config();
  const directory = await mkdtemp(join(tmpdir(), 'native-hosted-storage-'));
  try {
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-storage-hosted',
    });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      tools: [webSearch({ route: 'hosted' })],
    });
    const storage = fileSessionStore(directory);
    const session = await agent.session({ storage });
    const identity = session.id;
    try {
      expect(
        (await (await session.submit('research')).wait()).finalOutput,
      ).toBe('stored answer');
    } finally {
      await session.close();
    }
    const restored = await agent.session({ storage, resume: identity });
    try {
      const searches = (await Array.fromAsync(restored.items())).filter(
        (item) => item.type === 'web_search_call',
      );
      expect(searches).toHaveLength(1);
      expect(searches[0]).toMatchObject({ action });
      expect(
        (await (await restored.submit('continue')).wait()).finalOutput,
      ).toBe('continued');
    } finally {
      await restored.close();
    }
    expect(JSON.stringify(server.requests[0]?.tools)).toContain('web_search');
    expect(JSON.stringify(server.requests[1]?.input)).toContain(
      'stored answer',
    );
    server.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
