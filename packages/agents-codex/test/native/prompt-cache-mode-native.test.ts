import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, type ModelSettings } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const cases: {
  name: string;
  settings: ModelSettings;
  expected?: { mode?: 'explicit'; ttl?: '30m' };
}[] = [
  { name: 'omitted', settings: {} },
  {
    name: 'ttl-only',
    settings: { promptCacheTtl: '30m' },
    expected: { ttl: '30m' },
  },
  {
    name: 'mode-only',
    settings: { promptCacheMode: 'explicit' },
    expected: { mode: 'explicit' },
  },
  {
    name: 'mode-and-ttl',
    settings: { promptCacheMode: 'explicit', promptCacheTtl: '30m' },
    expected: { mode: 'explicit', ttl: '30m' },
  },
  { name: 'cleared', settings: { promptCacheMode: null } },
  {
    name: 'clear-with-ttl',
    settings: { promptCacheMode: null, promptCacheTtl: '30m' },
    expected: { ttl: '30m' },
  },
];

afterEach(() => ModelServer.closeAll());
it.each(cases)('forwards cache mode $name', async ({ settings, expected }) => {
  const server = new ModelServer([[message('Accepted.')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-cache',
    supportsWebsockets: false,
  });
  const result = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    modelSettings: settings,
  }).run('ordinary prefix');
  expect(result.finalOutput).toBe('Accepted.');
  expect(server.requests).toHaveLength(1);
  if (expected === undefined)
    expect(server.requests[0]).not.toHaveProperty('prompt_cache_options');
  else expect(server.requests[0]?.prompt_cache_options).toEqual(expected);
});
