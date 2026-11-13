import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  type ModelSettings,
  type UserInput,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const marker = { mode: 'explicit' } as const;
const settings: ModelSettings = {
  promptCacheMode: 'explicit',
  promptCacheTtl: '30m',
};
const inputs = [
  {
    name: 'text',
    part: {
      type: 'input_text',
      text: '<user_instructions>user data</user_instructions>',
    },
  },
  {
    name: 'image',
    part: {
      type: 'input_image',
      image_url:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    },
  },
  {
    name: 'audio',
    part: {
      type: 'input_audio',
      audio_url:
        'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  },
  {
    name: 'file',
    part: { type: 'input_file', file_id: 'file_synthetic_cache_document' },
  },
] as const;

function userParts(body: Record<string, unknown>) {
  const input = body.input as {
    role?: string;
    content: Record<string, unknown>[];
  }[];
  const user = input.find((item) => item.role === 'user');
  if (!user) throw new Error('Expected user history');
  return user.content;
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-cache',
    supportsWebsockets: false,
  });
}
afterEach(() => ModelServer.closeAll());
it.each(inputs)(
  'keeps cache marker on current $name content',
  async ({ part }) => {
    const server = new ModelServer([[message('plain')], [message('cached')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
      modelSettings: {
        ...settings,
        inputModalities: ['text', 'image', 'audio'],
      },
    });
    expect(
      (await agent.run({ role: 'user', content: [part] })).finalOutput,
    ).toBe('plain');
    expect(
      (
        await agent.run({
          role: 'user',
          content: [{ ...part, promptCacheBreakpoint: marker }],
        })
      ).finalOutput,
    ).toBe('cached');
    expect(server.requests).toHaveLength(2);
    const first = server.requests[0];
    const second = server.requests[1];
    if (!first || !second) throw new Error('Expected both native requests');
    const plain = userParts(first);
    const cached = structuredClone(userParts(second));
    const marked = cached.at(-1);
    if (!marked) throw new Error('Expected cached part');
    expect(marked.prompt_cache_breakpoint).toEqual(marker);
    delete marked.prompt_cache_breakpoint;
    expect(cached).toEqual(plain);
    expect(second.prompt_cache_options).toEqual({
      mode: 'explicit',
      ttl: '30m',
    });
  },
);
it.each([
  null,
  { mode: 'bad' },
  { mode: true },
  { mode: 'explicit', extra: true },
])('rejects invalid marker before native provider I/O %j', async (value) => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  });
  await expect(
    agent.run({
      role: 'user',
      content: [
        { type: 'input_text', text: 'prefix', promptCacheBreakpoint: value },
      ],
    } as unknown as UserInput),
  ).rejects.toThrow(/cache.*breakpoint/i);
  expect(server.requests).toHaveLength(0);
});
it('keeps cache marker through portable manual checkpoint', async () => {
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('lookup', { key: 'a' }, { callId: 'cache-call' })],
    [message('restored')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    provider,
    tools: [lookup],
    modelSettings: settings,
  });
  const saved = await (async () => {
    await using source = await agent.session();
    const turn = await source.submit({
      role: 'user',
      content: [
        { type: 'input_text', text: 'prefix', promptCacheBreakpoint: marker },
      ],
    });
    const pending = await turn.wait({ until: 'manual_tool' });
    if (!('requests' in pending) || !lookup.match(pending.requests[0]))
      throw new Error('Expected lookup');
    return await source.suspend();
  })();
  await using restored = await agent.session({
    state: JSON.parse(JSON.stringify(saved)),
  });
  const turn = restored.restoredTurn;
  if (!turn) throw new Error('Expected restored turn');
  const pending = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in pending)) throw new Error('Expected restored request');
  const request = lookup.match(pending.requests[0]);
  if (!request) throw new Error('Expected current lookup');
  await restored.respond(request.reply('accepted'));
  expect((await turn.wait()).finalOutput).toBe('restored');
  expect(server.requests).toHaveLength(2);
  const first = server.requests[0];
  const second = server.requests[1];
  if (!first || !second) throw new Error('Expected both requests');
  expect(userParts(first)).toEqual(userParts(second));
  expect(userParts(second).at(-1)?.prompt_cache_breakpoint).toEqual(marker);
}, 20_000);
it('keeps fresh canonical history marker on its own input', async () => {
  const server = new ModelServer([[message('accepted')]]);
  await using provider = await providerFor(server);
  const result = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    modelSettings: settings,
  }).run('continue', {
    initialMessages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'history prefix',
            promptCacheBreakpoint: marker,
          },
        ],
      },
    ],
  });
  expect(result.finalOutput).toBe('accepted');
  const body = server.requests[0];
  if (!body) throw new Error('Expected request');
  const entries = (body.input as { role: string; content: unknown[] }[])
    .filter((item) => item.role === 'user')
    .flatMap((item) => item.content);
  expect(entries).toEqual([
    {
      type: 'input_text',
      text: 'history prefix',
      prompt_cache_breakpoint: marker,
    },
    { type: 'input_text', text: 'continue' },
  ]);
});

it('keeps native cache prefix through the borrowed Chat adapter', async () => {
  const { ChatCompletionsModel } = await import('../../src');
  const calls: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          calls.push(request);
          return {
            id: 'chat_synthetic_cache',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-5.5',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'accepted' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };
  await using provider = new NativeProvider({
    apiKey: 'synthetic-cache-chat',
    modelBackend: new ChatCompletionsModel(client, 'gpt-5.5'),
  });
  const result = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Answer.',
    modelSettings: settings,
  }).run({
    role: 'user',
    content: [
      { type: 'input_text', text: 'prefix', promptCacheBreakpoint: marker },
    ],
  });
  expect(result.finalOutput).toBe('accepted');
  expect(calls).toHaveLength(1);
  const request = calls[0];
  if (!request) throw new Error('Expected adapter request');
  expect(request.prompt_cache_options).toEqual({
    mode: 'explicit',
    ttl: '30m',
  });
  const user = (request.messages as { role: string; content: unknown }[]).find(
    (item) => item.role === 'user',
  );
  expect(user?.content).toEqual([
    { type: 'text', text: 'prefix', prompt_cache_breakpoint: marker },
  ]);
});
