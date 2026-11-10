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
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: new ChatCompletionsModel(client),
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Use lookup once.',
    tools: [lookup],
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
  expect(seen[0].tool_choice).toEqual({
    type: 'function',
    function: { name: 'lookup' },
  });
  for (const body of seen) {
    expect(
      body.messages.find((item: any) => item.role === 'user').content,
    ).toEqual([
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    ]);
    expect(body).not.toHaveProperty('input_modalities');
  }
});
