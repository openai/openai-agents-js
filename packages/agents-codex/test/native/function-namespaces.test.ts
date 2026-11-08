import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool, toolRef } from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

it('dispatches identical short names by captured namespace and selects qualified references', async () => {
  const effects: string[] = [];
  const options = {
    name: 'lookup',
    namespace: 'alpha',
    namespaceDescription: 'Alpha records',
    parameters: z.object({ key: z.string() }),
    execute({ key }: { key: string }) {
      effects.push(`alpha:${key}`);
      return `alpha:${key}`;
    },
  };
  const alpha = { ...tool(options) };
  const beta = tool({
    ...options,
    namespace: 'beta',
    namespaceDescription: 'Beta records',
    execute({ key }) {
      effects.push(`beta:${key}`);
      return `beta:${key}`;
    },
  });
  const server = new ModelServer([
    (request) => {
      expect(request.tools).toEqual([
        expect.objectContaining({
          type: 'namespace',
          name: 'alpha',
          description: 'Alpha records',
          tools: [expect.objectContaining({ name: 'lookup' })],
        }),
        expect.objectContaining({
          type: 'namespace',
          name: 'beta',
          description: 'Beta records',
          tools: [expect.objectContaining({ name: 'lookup' })],
        }),
      ]);
      return [
        call('lookup', { key: 'a' }, { namespace: 'alpha', callId: 'alpha-1' }),
        call('lookup', { key: 'b' }, { namespace: 'beta', callId: 'beta-1' }),
      ];
    },
    (request) => {
      expect(JSON.stringify(request.input)).toContain('alpha:a');
      expect(JSON.stringify(request.input)).toContain('beta:b');
      return [message('both')];
    },
    (request) => {
      expect(request.tools).toEqual([
        expect.objectContaining({ type: 'namespace', name: 'beta' }),
      ]);
      return [
        call(
          'lookup',
          { key: 'selected' },
          { namespace: 'beta', callId: 'beta-2' },
        ),
      ];
    },
    [message('selected')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use the selected lookup.',
    model: 'gpt-5',
    provider,
    tools: [alpha, beta],
  });
  await using session = await agent.session();
  alpha.namespace = 'retargeted';
  alpha.namespaceDescription = 'Changed';
  alpha.name = 'changed';
  options.namespace = 'changed-again';
  expect((await (await session.submit('both')).wait()).finalOutput).toBe(
    'both',
  );
  expect(
    (
      await (
        await session.submit('beta', {
          beforeStep: () => [toolRef('lookup', 'beta')],
        })
      ).wait()
    ).finalOutput,
  ).toBe('selected');
  expect(effects.sort()).toEqual(['alpha:a', 'beta:b', 'beta:selected']);
  server.assertExhausted();
});

it.each([
  ['records', 'records'],
  [undefined, 'functions'],
])(
  'rejects duplicate qualified identities %s/%s before a model request',
  async (first, second) => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const declaration = (namespace: string | undefined) =>
      tool({
        name: 'lookup',
        namespace,
        parameters: z.object({}),
        execute: () => 'unused',
      });
    const agent = new Agent({
      instructions: 'No request.',
      provider,
      tools: [declaration(first), declaration(second)],
    });
    await expect(agent.session()).rejects.toThrow(
      `Duplicate tool ${first ?? 'functions'}.lookup`,
    );
    expect(server.requests).toHaveLength(0);
  },
);
