import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '@openai/agents-codex';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each(['requestMaxRetries', 'streamMaxRetries'] as const)(
  'rejects invalid %s before opening resources',
  (key) => {
    for (const value of [
      -1,
      true,
      1.5,
      Infinity,
      NaN,
      '1',
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() => new NativeProvider({ [key]: value } as never)).toThrow(key);
  },
);

it.each([
  ['request', 0],
  ['request', 1],
  ['stream', 0],
  ['stream', 1],
] as const)(
  'uses native %s retries=%i without replaying tools',
  async (layer, retries) => {
    const effects: string[] = [];
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => {
        effects.push('lookup');
        return 'lookup receipt';
      },
    });
    const server = new ModelServer([
      layer === 'request'
        ? { status: 503, body: 'synthetic temporary failure' }
        : {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: 'data: {"type":"response.created","response":{"id":"dropped"}}\n\n',
          },
      [call('lookup', {}, { callId: 'lookup-call' })],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-retry-key',
      supportsWebsockets: false,
      requestMaxRetries: layer === 'request' ? retries : 0,
      streamMaxRetries: layer === 'stream' ? retries : 0,
    });
    const agent = new Agent({
      instructions: 'Use lookup, then answer.',
      provider,
      tools: [lookup],
    });
    if (retries) {
      expect((await agent.run('go')).finalOutput).toBe('done');
    } else {
      await expect(agent.run('go')).rejects.toThrow();
    }
    expect(server.requests).toHaveLength(retries ? 3 : 1);
    expect(effects).toEqual(retries ? ['lookup'] : []);
    if (retries) {
      expect(server.requests[0].input).toEqual(server.requests[1].input);
      expect(JSON.stringify(server.requests.at(-1)!.input)).toContain(
        'lookup receipt',
      );
      server.assertExhausted();
    }
  },
);
