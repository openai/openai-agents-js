import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  ChatCompletionsModel,
  NativeProvider,
  tool,
  toolRef,
  type ModelRequest,
  type UserMessage,
  type SessionState,
} from '../../src';

it('preserves admitted mixed audio content through one native tool continuation', async () => {
  const seen: ModelRequest[] = [];
  const effects: string[] = [];
  const message: UserMessage = {
    role: 'user',
    content: [
      { type: 'input_text', text: 'before' },
      { type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==' },
      { type: 'input_text', text: 'after' },
    ],
  };
  const lookup = tool({
    name: 'lookup',
    description: 'Lookup.',
    parameters: z.object({}),
    execute() {
      effects.push('lookup');
      return 'found';
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: {
      complete(request) {
        seen.push(request);
        return {
          output:
            seen.length === 1
              ? [
                  {
                    type: 'function_call',
                    name: 'lookup',
                    call_id: 'call_audio',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'ok' }],
                  },
                ],
        };
      },
    },
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Use lookup once.',
    tools: [lookup],
    provider,
    modelSettings: {
      toolChoice: toolRef('lookup'),
      inputModalities: ['text', 'audio'],
    },
  }).run(message);
  expect(result.finalOutput).toBe('ok');
  expect(effects).toEqual(['lookup']);
  expect(seen).toHaveLength(2);
  for (const request of seen) {
    const original = (request.body.input as any[]).find(
      (item) => item.role === 'user',
    );
    expect(original.content).toEqual(message.content);
  }
  expect(
    (seen[1].body.input as any[]).some(
      (item) => item.type === 'function_call_output',
    ),
  ).toBe(true);
});

it('keeps modality replacement, clear and restore scoped to the selected Agent', async () => {
  const seen: ModelRequest[] = [];
  const message: UserMessage = {
    role: 'user',
    content: [
      { type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==' },
    ],
  };
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: {
      complete(request) {
        seen.push(request);
        expect(request.body).not.toHaveProperty('input_modalities');
        expect(request.body).not.toHaveProperty('request_controls');
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        };
      },
    },
  });
  const hasAudio = () =>
    (seen.at(-1)!.body.input as any[]).some((item) =>
      item.content?.some((part: any) => part.type === 'input_audio'),
    );
  const declared = new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
    modelSettings: { inputModalities: ['text', 'audio'] },
  });
  const states: { state: SessionState; expected: boolean }[] = [];
  {
    await using session = await declared.session();
    await (await session.submit(message)).wait();
    expect(hasAudio()).toBe(true);
    states.push({ state: await session.saveState(), expected: true });
    await session.update({ modelSettings: { temperature: 0.5 } });
    await (await session.submit('sparse update preserves audio')).wait();
    expect(hasAudio()).toBe(true);
    await session.update({ modelSettings: { inputModalities: ['text'] } });
    await (await session.submit(message)).wait();
    expect(hasAudio()).toBe(false);
    states.push({ state: await session.saveState(), expected: false });
    await session.update({ modelSettings: { inputModalities: null } });
    await (await session.submit(message)).wait();
    expect(hasAudio()).toBe(false);
    states.push({ state: await session.saveState(), expected: false });
  }
  for (const { state, expected } of states) {
    await using restored = await declared.session({ state });
    await (await restored.submit(message)).wait();
    expect(hasAudio()).toBe(expected);
  }
  await new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
  }).run(message);
  expect(hasAudio()).toBe(false);
});

it('composes native audio and named selection through the real Chat library', async () => {
  const seen: any[] = [];
  const effects: string[] = [];
  const client = new OpenAI({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init?.body as string));
      const message =
        seen.length > 1
          ? { role: 'assistant', content: 'ok' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_audio_client',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            };
      return new Response(
        JSON.stringify({
          id: 'chat_audio',
          object: 'chat.completion',
          created: 0,
          model: 'fixture',
          choices: [
            {
              index: 0,
              finish_reason: seen.length > 1 ? 'stop' : 'tool_calls',
              message,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const lookup = tool({
    name: 'lookup',
    description: 'Lookup.',
    parameters: z.object({}),
    execute() {
      effects.push('lookup');
      return 'found';
    },
  });
  const other = tool({
    name: 'other',
    description: 'Unselected.',
    parameters: z.object({}),
    execute() {
      effects.push('other');
      return 'unselected';
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: new ChatCompletionsModel(client),
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Use lookup once.',
    tools: [lookup, other],
    provider,
    modelSettings: {
      inputModalities: ['text', 'audio'],
      toolChoice: toolRef('lookup'),
    },
  }).run({
    role: 'user',
    content: [
      { type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==' },
    ],
  });
  expect(result.finalOutput).toBe('ok');
  expect(effects).toEqual(['lookup']);
  expect(seen).toHaveLength(2);
  expect(seen[0].tool_choice).toBe('required');
  expect(seen[0].tools.map((item: any) => item.function.name)).toEqual([
    'lookup',
  ]);
  for (const body of seen) {
    expect(
      body.messages.find((item: any) => item.role === 'user').content,
    ).toEqual([
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    ]);
    expect(body).not.toHaveProperty('input_modalities');
  }
});

it.each([true, false])(
  'preserves public audio history with audioOnly=%s',
  async (audioOnly) => {
    const message: UserMessage = {
      role: 'user',
      content: audioOnly
        ? [{ type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==' }]
        : [
            { type: 'input_text', text: 'before' },
            {
              type: 'input_audio',
              audio_url: 'data:audio/wav;base64,UklGRg==',
            },
            { type: 'input_text', text: 'after' },
          ],
    };
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      modelBackend: {
        complete() {
          return {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
          };
        },
      },
    });
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      modelSettings: { inputModalities: ['text', 'audio'] },
    });
    let state: SessionState;
    {
      await using session = await agent.session();
      await (await session.submit(message)).wait();
      const items = [];
      for await (const item of session.items()) items.push(item);
      expect(
        items.find((item) => item.type === 'message' && item.role === 'user'),
      ).toMatchObject({ content: message.content });
      state = await session.saveState();
    }
    await using restored = await agent.session({ state });
    const items = [];
    for await (const item of restored.items()) items.push(item);
    expect(
      items.find((item) => item.type === 'message' && item.role === 'user'),
    ).toMatchObject({ content: message.content });
  },
);

it.each([true, false])(
  'captures seeded audio source and order with audioOnly=%s',
  async (audioOnly) => {
    const message: UserMessage = {
      role: 'user',
      content: audioOnly
        ? [{ type: 'input_audio', audio_url: 'opaque:audio-source' }]
        : [
            { type: 'input_text', text: 'before' },
            { type: 'input_audio', audio_url: 'opaque:audio-source' },
            { type: 'input_text', text: 'after' },
          ],
    };
    const seen: ModelRequest[] = [];
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      modelBackend: {
        complete(request) {
          seen.push(request);
          return {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
          };
        },
      },
    });
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      modelSettings: { inputModalities: ['text', 'audio'] },
    });
    let state: SessionState;
    {
      await using session = await agent.session({ initialMessages: [message] });
      const seeded = (await session.modelContext()).items.find(
        (item: any) => item.type === 'message' && item.role === 'user',
      ) as any;
      expect(seeded.content).toEqual(message.content);
      expect(seen).toHaveLength(0);
      state = await session.saveState();
    }
    await using restored = await agent.session({ state });
    await (await restored.submit('continue')).wait();
    const seeded = (seen[0].body.input as any[]).find(
      (item) => item.role === 'user',
    );
    expect(seeded.content).toEqual(message.content);
  },
);

it.each([
  { type: 'input_audio' },
  { type: 'input_audio', audio_url: '' },
  { type: 'input_audio', audio_url: null },
  { type: 'input_audio', audio_url: 42 },
  { type: 'input_audio', audio_url: 'source', file_id: 'other' },
])('rejects malformed seeded audio before model effects: %j', async (part) => {
  let calls = 0;
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: {
      complete() {
        calls++;
        throw new Error('unexpected model effect');
      },
    },
  });
  const agent = new Agent({
    provider,
    instructions: 'Answer.',
    modelSettings: { inputModalities: ['text', 'audio'] },
  });
  await expect(
    agent.session({
      initialMessages: [
        { role: 'user', content: [part] } as unknown as UserMessage,
      ],
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
