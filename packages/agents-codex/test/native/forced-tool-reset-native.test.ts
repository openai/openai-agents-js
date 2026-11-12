import { readFileSync } from 'node:fs';
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
      model: 'gpt-5.5',
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
      model: 'gpt-5.5',
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
      expect(server.requests[index].tool_choice).toBe('required');
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
    model: 'gpt-5.5',
    name: 'B',
    instructions: 'Use echo.',
    tools: [echoTool(effects)],
    modelSettings: { toolChoice: toolRef('echo'), resetToolChoice: true },
  });
  const source = new Agent({
    model: 'gpt-5.5',
    name: 'A',
    instructions: 'Transfer to B.',
    provider,
    handoffs: [target],
    modelSettings: { toolChoice: 'required', resetToolChoice: true },
  });
  expect((await source.run('go')).finalOutput).toBe('done');
  expect(effects).toEqual(['B']);
  expect(server.requests[0].tool_choice).toBe('required');
  expect(server.requests[1].tool_choice).toBe('required');
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
    model: 'gpt-5.5',
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
        model: 'gpt-5.5',
        instructions: 'Answer.',
        provider,
        modelSettings: { toolChoice: 'none', resetToolChoice: true },
      }).run('go')
    ).finalOutput,
  ).toBe('done');
  expect(server.requests[0].tool_choice).toBe('none');
  localOnly(server);
});

it('keeps the original eligible catalog after a named manual restore releases forcing', async () => {
  const effects: string[] = [];
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('lookup', { key: 'pending' }, { callId: 'forced-manual' })],
    [call('echo', { value: 'after-reset' }, { callId: 'eligible-other' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Read, then echo.',
    provider,
    tools: [lookup, echoTool(effects)],
    modelSettings: { toolChoice: toolRef('lookup'), resetToolChoice: true },
  });
  await using original = await agent.session();
  const batch = await (
    await original.submit('go')
  ).wait({ until: 'manual_tool' });
  if (!('requests' in batch)) throw new Error('Expected a manual request');
  const saved = parseSessionState(JSON.stringify(await original.suspend()));
  await original.close();
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0].tool_choice).toBe('required');
  await using restored = await agent.session({ state: saved });
  const pending = await restored.wait({ until: 'manual_tool' });
  if (!('requests' in pending))
    throw new Error('Expected a restored manual request');
  const current = lookup.match(pending.requests[0]);
  expect(current).toBeDefined();
  await restored.respond(current!.reply('accepted'));
  expect((await restored.wait()).finalOutput).toBe('done');
  expect(effects).toEqual(['after-reset']);
  expect(server.requests).toHaveLength(3);
  expect(server.requests[1].tool_choice ?? 'auto').toBe('auto');
  const declarations = (server.requests[1].tools as JsonObject[]).flatMap(
    (spec) =>
      spec.type === 'namespace' ? (spec.tools as JsonObject[]) : [spec],
  );
  expect(declarations.map((spec) => spec.name).sort()).toEqual([
    'echo',
    'lookup',
  ]);
  localOnly(server);
});

it.each([
  { named: false, withUsage: false },
  { named: false, withUsage: true },
  { named: true, withUsage: false },
  { named: true, withUsage: true },
])(
  'releases application forcing after manual restore: named=$named usage=$withUsage',
  async ({ named, withUsage }) => {
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      models: {
        slug: string;
        supported_in_api: boolean;
        use_responses_lite?: boolean;
      }[];
    };
    const model = catalog.models.find(
      (entry) => entry.supported_in_api && !entry.use_responses_lite,
    )?.slug;
    if (!model) throw new Error('Expected a standard Responses catalog model');
    const effects: string[] = [];
    const lookup = manualTool({
      name: 'lookup',
      description: 'Read',
      parameters: z.object({ key: z.string() }),
      result: z.string(),
    });
    const seen: JsonObject[] = [];
    await using provider = new NativeProvider({
      supportsWebsockets: false,
      modelBackend: {
        complete(request) {
          seen.push(request.body);
          return {
            output:
              seen.length === 1
                ? [
                    ...(named
                      ? []
                      : [
                          call(
                            'echo',
                            { value: 'once' },
                            { callId: 'automatic' },
                          ),
                        ]),
                    call('lookup', { key: 'pending' }, { callId: 'manual' }),
                  ]
                : named && seen.length === 2
                  ? [
                      call(
                        'echo',
                        { value: 'after-reset' },
                        { callId: 'eligible-other' },
                      ),
                    ]
                  : [message('done')],
            ...(withUsage
              ? { usage: { input_tokens: 1, output_tokens: 1 } }
              : {}),
          };
        },
      },
    });
    const agent = new Agent({
      model,
      instructions: 'Read, then echo.',
      provider,
      tools: [lookup, echoTool(effects)],
      modelSettings: {
        toolChoice: named ? toolRef('lookup') : 'required',
        resetToolChoice: true,
      },
    });
    await using original = await agent.session();
    const batch = await (
      await original.submit('go')
    ).wait({ until: 'manual_tool' });
    if (!('requests' in batch)) throw new Error('Expected a manual request');
    const saved = parseSessionState(JSON.stringify(await original.suspend()));
    await original.close();
    expect(effects).toEqual(named ? [] : ['once']);
    await using restored = await agent.session({ state: saved });
    const pending = await restored.wait({ until: 'manual_tool' });
    if (!('requests' in pending))
      throw new Error('Expected a restored manual request');
    const current = lookup.match(pending.requests[0]);
    if (!current) throw new Error('Expected lookup');
    await restored.respond(current.reply('accepted'));
    expect((await restored.wait()).finalOutput).toBe('done');
    expect(effects).toEqual(named ? ['after-reset'] : ['once']);
    expect(seen[0].tool_choice).toBe('required');
    expect(seen[1].tool_choice ?? 'auto').toBe('auto');
    const declarations = (seen[1].tools as JsonObject[]).flatMap((spec) =>
      spec.type === 'namespace' ? (spec.tools as JsonObject[]) : [spec],
    );
    expect(declarations.map((spec) => spec.name).sort()).toEqual([
      'echo',
      'lookup',
    ]);
  },
);
