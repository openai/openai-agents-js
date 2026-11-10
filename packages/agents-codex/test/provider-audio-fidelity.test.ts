import OpenAI from 'openai';
import { expect, it } from 'vitest';
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
