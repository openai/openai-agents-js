import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, Runner } from '../../src';
import { ModelServer } from './fixtures/model-server';

afterEach(async () => {
  await ModelServer.closeAll();
});

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-opaque-boundary',
    supportsWebsockets: false,
  });
}

it('rejects opaque service item references as public input before dispatch', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  });
  await expect(
    Runner.run(agent, {
      role: 'user',
      content: [
        { type: 'item_reference', id: 'service-owned-opaque-reference' },
      ],
    } as never),
  ).rejects.toThrow('Unsupported user content type');
  expect(server.requests).toHaveLength(0);
}, 15_000);

it('rejects opaque-reference lossy projection in restricted preparation before dispatch', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  }).session();
  let edits = 0;
  const turn = await session.submit('answer', {
    prepareRequest({ request }) {
      edits += 1;
      request.input.push({
        type: 'item_reference',
        id: 42,
      });
      return request;
    },
  });
  await expect(turn.wait()).rejects.toThrow();
  expect(edits).toBe(1);
  expect(server.requests).toHaveLength(0);
  expect(JSON.stringify(await session.saveState())).not.toContain(
    '"type":"item_reference"',
  );
}, 15_000);
