import OpenAI from 'openai';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ResponsesModel,
  tool,
  manualTool,
  parseSessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

// Exact provider-wire payloads and native continuation require a real HTTP fixture.
it.each(['native-http', 'borrowed-responses'] as const)(
  'captures hosted prompt references through %s and native tool continuation',
  async (route) => {
    const outputs = [
      [call('lookup', { key: 'fixture' }, { callId: 'prompt-call' })],
      [message('finished')],
    ];
    const server = new ModelServer(
      route === 'native-http'
        ? outputs
        : outputs.map((output, index) => ({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: `response-${index + 1}`,
              object: 'response',
              status: 'completed',
              output,
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            }),
          })),
    );
    const config = await server.config();
    const baseUrl = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    const fallback = new ModelServer([]);
    const fallbackConfig = await fallback.config();
    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: 'synthetic-prompt-key',
      maxRetries: 0,
    });
    const prompt = {
      id: 'pmpt_native_fixture',
      version: '3',
      variables: {
        topic: 'captured',
        document: { type: 'input_file', file_id: 'file_fixture' },
      },
    };
    const expectedPrompt = structuredClone(prompt);
    let effects = 0;
    await using provider = new NativeProvider({
      baseUrl:
        route === 'native-http'
          ? baseUrl
          : (fallbackConfig['model_providers.fixture'] as { base_url: string })
              .base_url,
      apiKey: 'synthetic-native-key',
      supportsWebsockets: false,
      ...(route === 'borrowed-responses'
        ? { modelBackend: new ResponsesModel(client) }
        : {}),
    });
    const agent = new Agent({
      provider,
      model: 'fixture-hosted-prompt',
      instructions: 'Answer with the lookup result.',
      modelSettings: { extraBody: { prompt } },
      tools: [
        tool({
          name: 'lookup',
          description: 'Read the synthetic fixture.',
          parameters: z.object({ key: z.string() }),
          execute: ({ key }) => {
            expect(key).toBe('fixture');
            effects++;
            return 'fixture-result';
          },
        }),
      ],
    });
    prompt.id = 'mutated';
    prompt.variables.topic = 'mutated';
    expect((await agent.run('Use the hosted prompt.')).finalOutput).toBe(
      'finished',
    );
    expect(effects).toBe(1);
    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      expect(request.prompt).toEqual(expectedPrompt);
      // This proof covers reference forwarding, not prompt-owned model/tool defaults.
      expect(request.model).toBe('fixture-hosted-prompt');
      expect(request.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'lookup' })]),
      );
    }
    expect(JSON.stringify(server.requests[1]!.input)).toContain(
      'fixture-result',
    );
    expect(fallback.requests).toHaveLength(0);
    server.assertExhausted();
  },
  20_000,
);

it.each([false, true])(
  'resolves a captured prompt with explicit overrides=%s through the native request owner',
  async (explicit) => {
    const server = new ModelServer([[message('prompt result')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-native-key',
      supportsWebsockets: false,
    });
    const reference = { id: 'pmpt_owned', variables: { topic: 'captured' } };
    let resolutions = 0;
    const agent = new Agent({
      provider,
      hostedPrompt: () => {
        resolutions++;
        return reference;
      },
      transformContext: () => {
        reference.variables.topic = 'changed after capture';
      },
      ...(explicit
        ? { model: 'fixture-explicit', instructions: '', tools: [] }
        : {}),
    });
    expect((await agent.run('Use current declared prompt.')).finalOutput).toBe(
      'prompt result',
    );
    expect(resolutions).toBe(1);
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.prompt).toEqual({
      id: 'pmpt_owned',
      variables: { topic: 'captured' },
    });
    if (explicit) {
      expect(request.model).toBe('fixture-explicit');
      expect(request.instructions).toBe('');
      expect(request.tools).toEqual([]);
    } else {
      for (const field of [
        'model',
        'instructions',
        'tools',
        'reasoning',
        'text',
        'tool_choice',
        'parallel_tool_calls',
      ])
        expect(request).not.toHaveProperty(field);
    }
    server.assertExhausted();
  },
  20_000,
);

it('keeps prompt instruction ownership after an explicit model update', async () => {
  const server = new ModelServer([[message('before')], [message('after')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-key',
    supportsWebsockets: false,
  });
  const agent = new Agent({ provider, hostedPrompt: { id: 'pmpt_current' } });
  await using session = await agent.session();
  await (await session.submit('before model update')).wait();
  await session.update({ model: 'fixture-updated' });
  await (await session.submit('after model update')).wait();
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]!.model).toBe('fixture-updated');
  expect(server.requests[1]!).not.toHaveProperty('instructions');
  expect(JSON.stringify(server.requests[1]!.input)).not.toContain(
    'model_switch',
  );
  server.assertExhausted();
}, 20_000);

it('resolves the current hosted prompt factory after a cold restore without overriding prompt defaults', async () => {
  const server = new ModelServer([
    [message('before restore result')],
    [message('after restore result')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-key',
    supportsWebsockets: false,
  });
  let current = {
    id: 'pmpt_before_restore',
    version: '1',
    variables: { topic: 'before restore' },
  };
  let resolutions = 0;
  const agent = new Agent({
    provider,
    hostedPrompt: () => {
      resolutions++;
      return current;
    },
  });
  const session = await agent.session();
  let saved;
  try {
    expect(
      (await (await session.submit('before restore')).wait()).finalOutput,
    ).toBe('before restore result');
    saved = JSON.parse(JSON.stringify(await session.saveState()));
  } finally {
    await session.close();
  }
  expect(resolutions).toBe(1);
  const before = structuredClone(current);
  current = {
    id: 'pmpt_current_restore',
    version: '2',
    variables: { topic: 'current authorized prompt' },
  };
  await using restored = await agent.session({ state: saved });
  expect(
    (await (await restored.submit('after restore')).wait()).finalOutput,
  ).toBe('after restore result');
  expect(resolutions).toBe(2);
  expect(server.requests).toHaveLength(2);
  expect(server.requests.map((request) => request.prompt)).toEqual([
    before,
    current,
  ]);
  for (const request of server.requests) {
    for (const field of [
      'model',
      'instructions',
      'tools',
      'reasoning',
      'text',
      'tool_choice',
      'parallel_tool_calls',
    ])
      expect(request).not.toHaveProperty(field);
  }
  expect(JSON.stringify(server.requests[1]!.input)).toContain(
    'before restore result',
  );
  server.assertExhausted();
}, 20_000);

it('rebinds an omitted hosted prompt through a manual checkpoint', async () => {
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read.',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('lookup', { key: 'A' }, { callId: 'prompt-manual' })],
    [message('restored prompt')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-key',
    supportsWebsockets: false,
  });
  let current = { id: 'pmpt_manual_before' };
  let resolutions = 0;
  const agent = new Agent({
    provider,
    tools: [lookup],
    hostedPrompt: () => {
      resolutions++;
      return current;
    },
  });
  const source = await agent.session();
  const turn = await source.submit('Read');
  const first = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in first)) throw new Error('Expected pending tool');
  const state = parseSessionState(JSON.stringify(await source.suspend()));
  await source.close();
  current = { id: 'pmpt_manual_after' };
  await using restored = await agent.session({ state });
  const continuation = restored.restoredTurn;
  if (!continuation) throw new Error('Expected restored continuation');
  const pending = await continuation.wait({ until: 'manual_tool' });
  if (!('requests' in pending)) throw new Error('Expected restored tool');
  const request = lookup.match(pending.requests[0]);
  if (!request) throw new Error('Expected exact lookup request');
  await restored.respond(request.reply('known'));
  expect((await continuation.wait()).finalOutput).toBe('restored prompt');
  expect(resolutions).toBe(2);
  expect(server.requests.map((request) => request.prompt)).toEqual([
    { id: 'pmpt_manual_before' },
    { id: 'pmpt_manual_after' },
  ]);
  for (const request of server.requests) {
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('instructions');
  }
  server.assertExhausted();
}, 20_000);
