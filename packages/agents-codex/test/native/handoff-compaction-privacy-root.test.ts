import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('keeps filtered source input from provider compaction', async () => {
  const server = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'transfer' })],
    [message('destination reached')],
    [message('unexpected provider compaction')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-handoff-privacy',
    supportsWebsockets: false,
  });
  const destination = new Agent({
    name: 'destination',
    instructions: 'Destination authority.',
  });
  const source = new Agent({
    name: 'source',
    model: 'gpt-5.5',
    provider,
    handoffs: [destination],
    instructions: 'Transfer to the destination.',
    prepareHandoffInput: (value) => ({
      ...value,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'safe destination input' }],
        },
      ],
      previous: [],
      generated: [],
    }),
  });
  await using session = await source.session();
  expect(
    (await (await session.submit('private source record')).wait()).finalOutput,
  ).toBe('destination reached');
  const result = await session.compact().catch((error: unknown) => error);
  expect(server.requests).toHaveLength(2);
  expect(JSON.stringify(server.requests[1]?.input)).toContain(
    'safe destination input',
  );
  expect(JSON.stringify(server.requests[1]?.input)).not.toContain(
    'private source record',
  );
  expect(result).toMatchObject({
    message: expect.stringContaining(
      'Native compaction cannot combine with a filtered handoff presentation',
    ),
  });
}, 30_000);
