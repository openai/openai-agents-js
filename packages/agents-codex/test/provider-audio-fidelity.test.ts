import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import {
  AiSdkModel,
  ChatCompletionsModel,
  type ModelRequest,
} from '../src/runtime/models';
import {
  nativeInput,
  responseContent,
  type InputAudio,
} from '../src/runtime/input';

function request(audioUrl = 'data:audio/wav;base64,UklGRg=='): ModelRequest {
  return {
    body: {
      model: 'fixture',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'before' },
            { type: 'input_audio', audio_url: audioUrl },
            { type: 'input_text', text: 'after' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'function', name: 'lookup', namespace: 'functions' },
    },
    context: undefined,
    sessionId: 'session',
    turnId: 'turn',
    signal: new AbortController().signal,
  };
}

it('captures ordered audio references and detached history without transport', () => {
  const audio: InputAudio = {
    type: 'input_audio',
    audio_url: 'https://example.test/audio.ogg',
  };
  const value = nativeInput({
    role: 'user',
    content: [
      { type: 'input_text', text: 'before' },
      audio,
      { type: 'input_text', text: 'after' },
    ],
  });
  expect(value).toEqual([
    { type: 'text', text: 'before' },
    { type: 'audio', audio_url: audio.audio_url },
    { type: 'text', text: 'after' },
  ]);
  audio.audio_url = 'changed';
  expect((value[1] as any).audio_url).toBe('https://example.test/audio.ogg');
  expect(
    responseContent([
      { type: 'audio', audio_url: 'data:audio/ogg;base64,Tw==' },
    ]),
  ).toEqual([{ type: 'input_audio', audio_url: 'data:audio/ogg;base64,Tw==' }]);
});

it.each([
  { mime: 'wav', format: 'wav' },
  { mime: 'mpeg', format: 'mp3' },
  { mime: 'text', format: undefined },
])(
  'preserves $mime and named choice through the actual OpenAI library',
  async ({ mime, format }) => {
    const seen: any[] = [];
    const client = new OpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        seen.push(JSON.parse(init?.body as string));
        return new Response(
          JSON.stringify({
            id: 'chat_audio',
            object: 'chat.completion',
            created: 0,
            model: 'fixture',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'ok' },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const input = request(`data:audio/${mime};base64,UklGRg==`);
    if (format === undefined)
      (input.body.input as any[])[0].content.splice(1, 1);
    await new ChatCompletionsModel(client).complete(input);
    expect(seen[0].messages[0].content).toEqual(
      [
        { type: 'text', text: 'before' },
        { type: 'input_audio', input_audio: { data: 'UklGRg==', format } },
        { type: 'text', text: 'after' },
      ].filter((part) => format !== undefined || part.type !== 'input_audio'),
    );
    expect(seen[0].tool_choice).toEqual({
      type: 'function',
      function: { name: 'lookup' },
    });
    expect(input.body.tool_choice).toEqual({
      type: 'function',
      name: 'lookup',
      namespace: 'functions',
    });
  },
);

it.each(['v2', 'v3', 'v4'] as const)(
  'preserves ordered audio MIME/data and named choice in %s',
  async (specificationVersion) => {
    let calls = 0;
    const model = new AiSdkModel({
      specificationVersion,
      provider: 'other.messages',
      modelId: 'fixture',
      doGenerate(options) {
        calls++;
        expect(options.prompt[0].content).toEqual([
          { type: 'text', text: 'before' },
          {
            type: 'file',
            mediaType: 'audio/ogg;codecs=opus',
            data:
              specificationVersion === 'v4'
                ? { type: 'data', data: 'Tw==' }
                : 'Tw==',
          },
          { type: 'text', text: 'after' },
        ]);
        expect(options.toolChoice).toEqual({
          type: 'tool',
          toolName: 'lookup',
        });
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
        };
      },
    });
    await model.complete(request('data:audio/ogg;codecs=opus;base64,Tw=='));
    expect(calls).toBe(1);
  },
);

it.each(['https://example.test/private.wav', 'data:audio/ogg;base64,Tw=='])(
  'rejects unsupported Chat audio before the client: %s',
  async (audioUrl) => {
    let calls = 0;
    const model = new ChatCompletionsModel({
      chat: {
        completions: {
          create() {
            calls++;
            throw new Error('unexpected client call');
          },
        },
      },
    });
    await expect(model.complete(request(audioUrl))).rejects.toThrow(/audio/i);
    expect(calls).toBe(0);
  },
);

it.each(['foreign', 'missing', 'empty', 'catalogue'])(
  'rejects a %s named selector before a client call',
  async (boundary) => {
    let calls = 0;
    const model = new ChatCompletionsModel({
      chat: {
        completions: {
          create() {
            calls++;
            throw new Error('unexpected client call');
          },
        },
      },
    });
    const value = request();
    value.body.tool_choice = {
      type: 'function',
      name: boundary === 'missing' ? 'other' : 'lookup',
      namespace: boundary === 'foreign' ? 'other' : 'functions',
    };
    if (boundary === 'empty') value.body.tools = [];
    if (boundary === 'catalogue')
      (value.body.tools as any[])[0].namespace = 'other';
    await expect(model.complete(value)).rejects.toThrow(/offered|namespace/);
    expect(calls).toBe(0);
  },
);

it('preserves inline audio through actual Google file conversion', async () => {
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
  const seen: any[] = [];
  const google = createGoogleGenerativeAI({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'ok' }] },
              finishReason: 'STOP',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const value = request('data:audio/wav;base64,UklGRg==');
  await new AiSdkModel(google('fixture')).complete(value);
  expect(seen).toHaveLength(1);
  expect(seen[0].contents[0].parts).toEqual([
    { text: 'before' },
    { inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } },
    { text: 'after' },
  ]);
  expect(seen[0].toolConfig.functionCallingConfig).toMatchObject({
    mode: 'ANY',
    allowedFunctionNames: ['lookup'],
  });
});

it('captures complete modality declarations and sparse clears', async () => {
  const { captureModelSettings, modelOverrides } =
    await import('../src/runtime/provider');
  const values: ('text' | 'image' | 'audio')[] = ['text', 'audio'];
  const captured = captureModelSettings({ inputModalities: values });
  values.push('image');
  expect(captured.inputModalities).toEqual(['text', 'audio']);
  expect(modelOverrides(undefined, captured)).toEqual({
    request_controls: { input_modalities: ['text', 'audio'] },
  });
  expect(modelOverrides()).toEqual({});
  expect(modelOverrides(undefined, { inputModalities: null })).toEqual({
    request_controls: { input_modalities: null },
  });
});
it.each(
  [[], ['audio', 'audio'], ['video'], 'audio', [1]].map((value) => ({ value })),
)(
  'rejects an invalid modality declaration: %j',
  async ({ value: inputModalities }) => {
    const { captureModelSettings } = await import('../src/runtime/provider');
    expect(() => captureModelSettings({ inputModalities } as any)).toThrow(
      /inputModalities/,
    );
  },
);

const audioCapacity = 64 * 1024 * 1024;
it('rejects a raw oversized remote audio input before receipt serialization', () => {
  const serialise = vi.spyOn(JSON, 'stringify');
  try {
    expect(() =>
      nativeInput({
        role: 'user',
        content: [
          {
            type: 'input_audio',
            audio_url: 'https://audio.test/' + 'a'.repeat(audioCapacity),
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(serialise).not.toHaveBeenCalled();
  } finally {
    serialise.mockRestore();
  }
});
it('bounds encoded Unicode audio and the aggregate audio input without large quoting', () => {
  const real = JSON.stringify;
  let largest = 0;
  const serialise = vi.spyOn(JSON, 'stringify').mockImplementation(((
    value: unknown,
  ) => {
    if (typeof value === 'string') largest = Math.max(largest, value.length);
    return real(value);
  }) as typeof JSON.stringify);
  try {
    expect(() =>
      nativeInput({
        role: 'user',
        content: [
          {
            type: 'input_audio',
            audio_url: 'https://audio.test/' + '😀'.repeat(audioCapacity / 4),
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      nativeInput({
        role: 'user',
        content: [
          { type: 'input_audio', audio_url: 'a'.repeat(audioCapacity / 2) },
          { type: 'input_audio', audio_url: 'a'.repeat(audioCapacity / 2) },
        ],
      }),
    ).toThrow(RangeError);
    expect(largest).toBeLessThanOrEqual(32_768);
  } finally {
    serialise.mockRestore();
  }
});
it('accepts the bounded audio reference edge and rejects one additional byte', () => {
  const overhead = JSON.stringify([{ type: 'audio', audio_url: '' }]).length;
  const atLimit = 'a'.repeat(audioCapacity - overhead);
  expect(
    nativeInput({
      role: 'user',
      content: [{ type: 'input_audio', audio_url: atLimit }],
    }),
  ).toEqual([{ type: 'audio', audio_url: atLimit }]);
  expect(() =>
    nativeInput({
      role: 'user',
      content: [{ type: 'input_audio', audio_url: atLimit + 'a' }],
    }),
  ).toThrow(RangeError);
});

it('shares the audio budget across manually constructed initial messages', async () => {
  const { captureInitialMessages } =
    await import('../src/runtime/initial-messages');
  const audio = 'a'.repeat(audioCapacity / 2);
  expect(() =>
    captureInitialMessages([
      { role: 'user', content: [{ type: 'input_audio', audio_url: audio }] },
      { role: 'user', content: [{ type: 'input_audio', audio_url: audio }] },
    ]),
  ).toThrow(RangeError);
});

it('shares first-run audio capacity across seeds and input before opening resources', async () => {
  const { Agent } = await import('../src');
  const agent = new Agent({ model: 'fixture', instructions: 'Test.' });
  const open = vi
    .spyOn(agent, 'session')
    .mockRejectedValue(new Error('opened'));
  const message = {
    role: 'user' as const,
    content: [
      { type: 'input_audio' as const, audio_url: 'a'.repeat(40 * 1024 * 1024) },
    ],
  };
  await expect(
    agent.run(message, { initialMessages: [message] }),
  ).rejects.toThrow(RangeError);
  expect(open).not.toHaveBeenCalled();
});

it('reserves the full first-run envelope before quoting a near-limit audio value', async () => {
  const { Agent } = await import('../src');
  const agent = new Agent({ model: 'fixture', instructions: 'Test.' });
  const open = vi
    .spyOn(agent, 'session')
    .mockRejectedValue(new Error('opened'));
  const audio = 'a'.repeat(audioCapacity - 33);
  const real = JSON.stringify;
  let largeQuotes = 0;
  const serialise = vi.spyOn(JSON, 'stringify').mockImplementation(((
    value: unknown,
    ...args: unknown[]
  ) => {
    if (typeof value === 'string' && value.length > 32_768) largeQuotes++;
    return Reflect.apply(real, JSON, [value, ...args]);
  }) as typeof JSON.stringify);
  try {
    await expect(
      agent.run({
        role: 'user',
        content: [{ type: 'input_audio', audio_url: audio }],
      }),
    ).rejects.toThrow(RangeError);
    expect(open).not.toHaveBeenCalled();
    expect(largeQuotes).toBe(0);
  } finally {
    serialise.mockRestore();
  }
});

it('checks complete receipt bytes including trailing fields and exact native integer tokens', async () => {
  const { encode, encodeReceipt } = await import('../src/runtime/binding');
  const dto = {
    generation: '18446744073709551615',
    input: [{ type: 'audio', audio_url: '😀\n"' }],
    trailing: 'tail',
  };
  const expected = encodeReceipt(dto);
  const bytes = Buffer.byteLength(expected);
  expect(encodeReceipt(dto, bytes)).toBe(expected);
  expect(() => encodeReceipt(dto, bytes - 1)).toThrow(RangeError);
  const ordinary = encode(dto);
  expect(encode(dto, Buffer.byteLength(ordinary))).toBe(ordinary);
  expect(() => encode(dto, Buffer.byteLength(ordinary) - 1)).toThrow(
    RangeError,
  );
  expect(encodeReceipt(dto)).toBe(expected);
});
