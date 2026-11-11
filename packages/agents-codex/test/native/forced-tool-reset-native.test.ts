import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
  toolRef,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-reset-key',
    supportsWebsockets: false,
  });
}
function echoTool(effects: string[]) {
  return tool({
    name: 'echo',
    description: 'Echo once',
    parameters: z.object({ value: z.string() }),
    execute: ({ value }) => {
      effects.push(value);
      return value;
    },
  });
}
function localOnly(server: ModelServer) {
  for (const request of server.requests)
    expect(request).not.toHaveProperty('reset_tool_choice');
  server.assertExhausted();
}

it.each(['omitted', false, null] as const)(
  'preserves persistent forcing with reset=%s',
  async (setting) => {
    const effects: string[] = [];
    const server = new ModelServer([
      [call('echo', { value: 'accepted' }, { callId: 'persistent' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    const result = await new Agent({
      instructions: 'Use echo.',
      provider,
      tools: [echoTool(effects)],
      modelSettings: {
        toolChoice: 'required',
        ...(setting === 'omitted' ? {} : { resetToolChoice: setting }),
      },
    }).run('go');
    expect(result.finalOutput).toBe('done');
    expect(effects).toEqual(['accepted']);
    expect(server.requests.map((request) => request.tool_choice)).toEqual([
      'required',
      'required',
    ]);
    localOnly(server);
  },
);

it.each([false, true])(
  'releases forcing and restores the declaration for a new run: named=%s',
  async (named) => {
    const effects: string[] = [];
    const server = new ModelServer(
      [0, 1].flatMap((index) => [
        [call('echo', { value: String(index) }, { callId: `call-${index}` })],
        [message('done')],
      ]),
    );
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use echo.',
      provider,
      tools: [echoTool(effects)],
      modelSettings: {
        toolChoice: named ? toolRef('echo') : 'required',
        resetToolChoice: true,
      },
    }).session();
    for (let index = 0; index < 2; index++)
      expect((await (await session.submit('go')).wait()).finalOutput).toBe(
        'done',
      );
    expect(effects).toEqual(['0', '1']);
    for (const index of [0, 2]) {
      if (named)
        expect((server.requests[index].tool_choice as JsonObject).name).toBe(
          'echo',
        );
      else expect(server.requests[index].tool_choice).toBe('required');
      expect(server.requests[index + 1].tool_choice ?? 'auto').toBe('auto');
    }
    localOnly(server);
  },
);

it('preserves the incoming handoff profile first named choice', async () => {
  const effects: string[] = [];
  const server = new ModelServer([
    [call('transfer_to_b', {}, { callId: 'handoff' })],
    [call('echo', { value: 'B' }, { callId: 'target' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({
    name: 'B',
    instructions: 'Use echo.',
    tools: [echoTool(effects)],
    modelSettings: { toolChoice: toolRef('echo'), resetToolChoice: true },
  });
  const source = new Agent({
    name: 'A',
    instructions: 'Transfer to B.',
    provider,
    handoffs: [target],
    modelSettings: { toolChoice: 'required', resetToolChoice: true },
  });
  expect((await source.run('go')).finalOutput).toBe('done');
  expect(effects).toEqual(['B']);
  expect(server.requests[0].tool_choice).toBe('required');
  expect((server.requests[1].tool_choice as JsonObject).name).toBe('echo');
  expect(server.requests[2].tool_choice ?? 'auto').toBe('auto');
  localOnly(server);
});

it('releases forcing after a restored manual receipt without repeating its accepted sibling', async () => {
  const effects: string[] = [];
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const server = new ModelServer([
    [
      call('echo', { value: 'once' }, { callId: 'automatic' }),
      call('lookup', { key: 'pending' }, { callId: 'manual' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use both tools.',
    provider,
    tools: [echoTool(effects), lookup],
    modelSettings: { toolChoice: 'required', resetToolChoice: true },
  });
  await using original = await agent.session();
  const batch = await (
    await original.submit('go')
  ).wait({ until: 'manual_tool' });
  if (!('requests' in batch)) throw new Error('Expected a manual request');
  const request = lookup.match(batch.requests[0]);
  expect(request).toBeDefined();
  const saved = parseSessionState(JSON.stringify(await original.suspend()));
  await original.close();
  expect(effects).toEqual(['once']);
  expect(server.requests).toHaveLength(1);
  await using restored = await agent.session({ state: saved });
  const pending = await restored.wait({ until: 'manual_tool' });
  if (!('requests' in pending))
    throw new Error('Expected a restored manual request');
  const current = lookup.match(pending.requests[0]);
  expect(current).toBeDefined();
  expect(current!.callId).toBe(request!.callId);
  await restored.respond(current!.reply('accepted'));
  expect((await restored.wait()).finalOutput).toBe('done');
  expect(effects).toEqual(['once']);
  expect(server.requests).toHaveLength(2);
  expect(server.requests[0].tool_choice).toBe('required');
  expect(server.requests[1].tool_choice ?? 'auto').toBe('auto');
  localOnly(server);
});

it('preserves none when reset is enabled', async () => {
  const server = new ModelServer([[message('done')]]);
  await using provider = await providerFor(server);
  expect(
    (
      await new Agent({
        instructions: 'Answer.',
        provider,
        modelSettings: { toolChoice: 'none', resetToolChoice: true },
      }).run('go')
    ).finalOutput,
  ).toBe('done');
  expect(server.requests[0].tool_choice).toBe('none');
  localOnly(server);
});
