import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([
  ['auto', false, false],
  ['standard', false, false],
  ['standard', true, false],
  ['standard', true, true],
] as const)(
  'preserves catalog routing with %s Responses format and controls=%s, personal Apps=%s on a plain run',
  async (responsesFormat, controls, personalApps) => {
    const server = new ModelServer([[message('Finished.')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      responsesFormat,
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-key',
      supportsWebsockets: false,
      ...(personalApps
        ? {
            chatGPT: {
              accountId: 'synthetic-apps-account',
              accessToken: 'synthetic-apps-token',
            },
          }
        : {}),
    });
    const standard = responsesFormat === 'standard';
    const result = await new Agent({
      model: 'gpt-6.1-sol',
      instructions: 'Answer.',
      provider,
      modelSettings: controls
        ? {
            store: true,
            parallelToolCalls: false,
            verbosity: 'high',
            promptCacheRetention: '24h',
            promptCacheTtl: '12h',
          }
        : {},
    }).run('Use the selected formatter.');
    expect(result.finalOutput).toBe('Finished.');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.model).toBe('gpt-6.1-sol');
    expect(
      server.requestHeaders[0]!['x-openai-internal-codex-responses-lite'],
    ).toBe(standard ? undefined : 'true');
    if (controls)
      expect(server.requests[0]).toMatchObject({
        store: true,
        parallel_tool_calls: false,
        text: { verbosity: 'high' },
        prompt_cache_retention: '24h',
        prompt_cache_options: { ttl: '12h' },
      });
    server.assertExhausted();
  },
  30_000,
);

it.each(['root', 'destination'])(
  'rejects distinct standard %s handoff providers before dispatch',
  async (role) => {
    await using rootProvider = new NativeProvider({
      apiKey: 'synthetic-root',
      responsesFormat: role === 'root' ? 'standard' : 'auto',
    });
    await using destinationProvider = new NativeProvider({
      apiKey: 'synthetic-destination',
      responsesFormat: role === 'destination' ? 'standard' : 'auto',
    });
    const destination = new Agent({
      name: 'Destination',
      instructions: 'Finish.',
      provider: destinationProvider,
    });
    const root = new Agent({
      name: 'Root',
      instructions: 'Start.',
      provider: rootProvider,
      handoffs: [destination],
    });
    await expect(root.session()).rejects.toThrow(
      'requires a shared native handoff provider',
    );
  },
);

it('uses one standard Responses provider across a supported handoff', async () => {
  const server = new ModelServer([
    [
      call(
        'transfer_to_destination',
        {},
        { callId: 'shared-standard-transfer' },
      ),
    ],
    [message('Destination finished.')],
  ]);
  await using provider = new NativeProvider({
    responsesFormat: 'standard',
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-shared-key',
    supportsWebsockets: false,
  });
  const destination = new Agent({
    name: 'destination',
    instructions: 'Finish.',
    model: 'gpt-6.1-sol',
    modelSettings: { verbosity: 'high' },
    provider,
  });
  const root = new Agent({
    instructions: 'Transfer.',
    model: 'gpt-6.1-sol',
    provider,
    handoffs: [destination],
  });
  expect((await root.run('Transfer.')).finalOutput).toBe(
    'Destination finished.',
  );
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]).toMatchObject({
    model: 'gpt-6.1-sol',
    text: { verbosity: 'high' },
  });
  for (const headers of server.requestHeaders)
    expect(headers['x-openai-internal-codex-responses-lite']).toBeUndefined();
  server.assertExhausted();
}, 30_000);
