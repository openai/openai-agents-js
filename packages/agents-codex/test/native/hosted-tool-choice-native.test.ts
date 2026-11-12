import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  fileSearch,
  hostedMcp,
  toolRef,
  parseSessionState,
  tool,
} from '../../src';
import { ModelServer, message, call } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-hosted-choice',
    supportsWebsockets: false,
  });
}

it('projects a captured hosted selector and clears it with the current literal setting', async () => {
  const server = new ModelServer(
    Array.from({ length: 4 }, () => [message('done')]),
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect the synthetic store.',
    tools: [fileSearch(['vs_fixture'])],
    modelSettings: { toolChoice: { type: 'file_search' } },
  });
  const session = await agent.session();
  await (await session.submit('Choose the hosted tool.')).wait();
  expect(server.requests[0]?.tool_choice).toEqual({ type: 'file_search' });
  expect(server.requests[0]?.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'file_search',
        vector_store_ids: ['vs_fixture'],
      }),
    ]),
  );
  const saved = parseSessionState(JSON.stringify(await session.saveState()));
  await session.update({ modelSettings: { toolChoice: 'auto' } });
  await (await session.submit('Use ordinary choice.')).wait();
  expect(server.requests[1]?.tool_choice).toBe('auto');
  await session.close();
  {
    await using restored = await agent.session({ state: saved });
    await (await restored.submit('Restore the captured selector.')).wait();
  }
  {
    await using restored = await agent.session({
      state: saved,
    });
    await restored.update({ modelSettings: { toolChoice: 'auto' } });
    await (await restored.submit('Use the current explicit override.')).wait();
  }
  expect(server.requests.map((request) => request.tool_choice)).toEqual([
    { type: 'file_search' },
    'auto',
    { type: 'file_search' },
    'auto',
  ]);
  server.assertExhausted();
});

it('cannot turn a same-name captured function into a hosted declaration', async () => {
  let effects = 0;
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [
      tool({
        name: 'file_search',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'function';
        },
      }),
    ],
    modelSettings: { toolChoice: { type: 'file_search' } },
  }).session();
  await expect((await session.submit('Choose.')).wait()).rejects.toThrow(
    /hosted.*catalog/i,
  );
  expect(server.requests).toHaveLength(0);
  expect(effects).toBe(0);
});

it('clears only the invocation preference and preserves the captured default', async () => {
  const server = new ModelServer([[message('ordinary')], [message('default')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [fileSearch(['vs_fixture'])],
    modelSettings: { toolChoice: { type: 'file_search' } },
  });
  await using session = await agent.session();
  await (
    await session.submit('Use an invocation override.', {
      modelSettingsOverride: { toolChoice: 'auto' },
    })
  ).wait();
  await (await session.submit('Use the captured default.')).wait();
  expect(server.requests.map((request) => request.tool_choice)).toEqual([
    'auto',
    { type: 'file_search' },
  ]);
  server.assertExhausted();
});

it('switches a hosted preference to the captured function', async () => {
  let effects = 0;
  const server = new ModelServer([
    [message('initial')],
    [call('lookup', {}, { callId: 'choice-lookup' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'found';
    },
  });
  await using session = await new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [fileSearch(['vs_fixture']), lookup],
    modelSettings: { toolChoice: { type: 'file_search' } },
  }).session();
  await (await session.submit('Start.')).wait();
  await session.update({ modelSettings: { toolChoice: toolRef('lookup') } });
  await (await session.submit('Use lookup.')).wait();
  expect(server.requests[1]?.tool_choice).toBe('required');
  expect(effects).toBe(1);
});

it.each(['auto', 'none'] as const)(
  'clears hosted forcing from a managed profile with %s',
  async (mode) => {
    const server = new ModelServer([
      [message('initial')],
      [message('updated')],
    ]);
    await using provider = await providerFor(server);
    const worker = new Agent({
      name: 'Worker',
      tools: [fileSearch(['vs_fixture'])],
      provider,
      model: 'fixture-hosted-choice',
      instructions: 'Work.',
    });
    await using session = await new Agent({
      name: 'Root',
      provider,
      model: 'fixture-hosted-choice',
      instructions: 'Inspect.',
      tools: [fileSearch(['vs_fixture'])],
      handoffs: [worker],
      modelSettings: { toolChoice: { type: 'file_search' } },
    }).session();
    await (await session.submit('Start.')).wait();
    await session.update({ modelSettings: { toolChoice: mode } });
    await (await session.submit('Use the current mode.')).wait();
    expect(server.requests[1]?.tool_choice).toBe(mode);
  },
);

it('selects a named MCP tool when its declaration omits an allowed name list', async () => {
  const server = new ModelServer([[message('done')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'fixture-hosted-choice',
    instructions: 'Inspect.',
    tools: [
      hostedMcp({
        serverLabel: 'docs',
        serverUrl: 'https://docs.invalid/mcp',
        requireApproval: 'never',
      }),
    ],
    modelSettings: {
      toolChoice: { type: 'mcp', serverLabel: 'docs', name: 'lookup' },
    },
  }).session();
  await (await session.submit('Choose lookup.')).wait();
  expect(server.requests[0]?.tool_choice).toEqual({
    type: 'mcp',
    server_label: 'docs',
    name: 'lookup',
  });
  expect(server.requests[0]?.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'mcp', server_label: 'docs' }),
    ]),
  );
});
