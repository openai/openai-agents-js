import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([0, 1])(
  'uses native HTTP retry budget %s for actual provider attempts',
  async (budget) => {
    const server = new ModelServer([
      {
        status: 503,
        body: JSON.stringify({ error: { message: 'retryable failure' } }),
      },
      ...(budget ? [[message('retry recovered')]] : []),
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-key',
      supportsWebsockets: false,
      requestMaxRetries: budget,
      streamMaxRetries: 0,
    });
    const agent = new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
    });
    if (budget)
      expect((await agent.run('Reply.')).finalOutput).toBe('retry recovered');
    else await expect(agent.run('Reply.')).rejects.toThrow();
    expect(server.requests).toHaveLength(budget + 1);
  },
);

it.each([
  'requestMaxRetries',
  'streamMaxRetries',
  'streamIdleTimeoutMs',
  'websocketConnectTimeoutMs',
] as const)('captures native phase setting %s including zero', (key) => {
  for (const value of [-1, true, 1.5, null])
    expect(() => new NativeProvider({ [key]: value } as never)).toThrow(
      'nonnegative safe integer',
    );
  const provider = new NativeProvider({ [key]: 0 });
  const lease = provider._acquire();
  const wire = {
    requestMaxRetries: 'request_max_retries',
    streamMaxRetries: 'stream_max_retries',
    streamIdleTimeoutMs: 'stream_idle_timeout_ms',
    websocketConnectTimeoutMs: 'websocket_connect_timeout_ms',
  }[key];
  expect(lease.config['model_providers.native_agent']).toHaveProperty(wire, 0);
});
