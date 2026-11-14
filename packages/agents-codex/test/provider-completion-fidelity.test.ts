import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { expect, it } from 'vitest';
import { AiSdkModel, type ModelRequest } from '../src/runtime/models';
function request(): ModelRequest {
  return {
    body: {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply.' }],
        },
      ],
      tools: [],
    },
    context: undefined,
    sessionId: 'fixture',
    turnId: 'fixture',
    signal: new AbortController().signal,
  };
}
it('preserves named OpenAI strict output, parallel controls and image detail on the actual wire', async () => {
  let calls = 0;
  const provider = createOpenAI({
    name: 'proxy',
    apiKey: 'synthetic',
    fetch: async (_url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.messages[0].content[1].image_url).toEqual({
        url: 'https://example.com/image.png',
        detail: 'high',
      });
      return new Response(
        JSON.stringify({
          id: 'chat_done',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4.1',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"value":42}' },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const model = new AiSdkModel(
    provider.chat('gpt-4.1'),
    { openai: { strictJsonSchema: false, parallelToolCalls: true } },
    { providerFamily: 'openai' },
  );
  const input = request();
  input.body.parallel_tool_calls = false;
  input.body.text = {
    format: {
      type: 'json_schema',
      name: 'answer',
      strict: true,
      schema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  };
  (input.body.input as any[])[0].content.push({
    type: 'input_image',
    image_url: 'https://example.com/image.png',
    detail: 'high',
  });
  await model.complete(input);
  expect(calls).toBe(1);
});
it.each(['v2', 'v3', 'v4'] as const)(
  'preserves the %s remote tool-image protocol or rejects before client entry',
  async (specificationVersion) => {
    let calls = 0;
    let output: any;
    const model = new AiSdkModel({
      specificationVersion,
      provider: 'fixture.messages',
      modelId: 'fixture',
      doGenerate(options) {
        calls++;
        output = options.prompt.find((message: any) => message.role === 'tool')
          .content[0].output;
        return {
          finishReason: 'stop',
          content: [{ type: 'text', text: 'ok' }],
        };
      },
    });
    const input = request();
    input.body.input = [
      {
        type: 'function_call',
        call_id: 'image-call',
        name: 'paint',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'image-call',
        output: [
          { type: 'input_image', image_url: 'https://example.com/image.png' },
        ],
      },
    ];
    if (specificationVersion === 'v2') {
      await expect(model.complete(input)).rejects.toThrow(
        'v2 does not support remote image tool outputs',
      );
      expect(calls).toBe(0);
    } else {
      await model.complete(input);
      expect(calls).toBe(1);
      expect(output).toEqual({
        type: 'content',
        value: [
          specificationVersion === 'v3'
            ? { type: 'image-url', url: 'https://example.com/image.png' }
            : {
                type: 'file',
                mediaType: 'image',
                data: {
                  type: 'url',
                  url: new URL('https://example.com/image.png'),
                },
              },
        ],
      });
    }
  },
);
it.each(
  ['anthropic.messages', 'custom.messages'].flatMap((name) =>
    ['enabled', 'adaptive'].map((type) => ({ name, type })),
  ),
)(
  'retains configured Anthropic $type thinking and output for $name',
  async ({ name, type }) => {
    let calls = 0;
    const provider = createAnthropic({
      name,
      apiKey: 'fixture',
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            id: 'msg_thinking',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [
              {
                type: 'thinking',
                thinking: 'synthetic reasoning',
                signature: 'opaque-signature',
              },
              { type: 'text', text: 'ok' },
            ],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const model = new AiSdkModel(provider('claude-sonnet-4-6'), {
      anthropic: {
        thinking: {
          type,
          ...(type === 'enabled' ? { budgetTokens: 2048 } : {}),
        },
      },
    });
    const response = await model.complete(request());
    expect(calls).toBe(1);
    expect(response.output).toMatchObject([
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'synthetic reasoning' }],
      },
      { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
    ]);
  },
);
it.each(['v2', 'v3', 'v4'] as const)(
  'coalesces %s text without crossing tool calls',
  async (specificationVersion) => {
    const model = new AiSdkModel({
      specificationVersion,
      provider: 'fixture.messages',
      modelId: 'fixture',
      doGenerate() {
        return {
          finishReason: 'stop',
          content: [
            { type: 'text', text: '4' },
            { type: 'text', text: '2' },
            {
              type: 'tool-call',
              toolCallId: 'call',
              toolName: 'lookup',
              input: '{}',
            },
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        };
      },
    });
    expect((await model.complete(request())).output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '42' }],
      },
      {
        type: 'function_call',
        call_id: 'call',
        name: 'lookup',
        arguments: '{}',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ab' }],
      },
    ]);
  },
);

it('gives native summary controls precedence over captured Responses options', async () => {
  const summaries: unknown[] = [];
  const model = new AiSdkModel(
    {
      specificationVersion: 'v4',
      provider: 'openai.responses',
      modelId: 'gpt-5',
      doGenerate(options) {
        summaries.push(options.providerOptions.openai.reasoningSummary);
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
        };
      },
    },
    { openai: { reasoningSummary: 'detailed' } },
  );
  const selected = request();
  selected.body.reasoning = { summary: 'auto' };
  await model.complete(selected);
  await model.complete(request());
  expect(summaries).toEqual(['auto', 'detailed']);
});

it('keeps explicitly disabled Anthropic thinking available', async () => {
  let calls = 0;
  const provider = createAnthropic({
    apiKey: 'fixture',
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          id: 'msg_disabled',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const model = new AiSdkModel(provider('claude-sonnet-4-6'), {
    anthropic: { thinking: { type: 'disabled' } },
  });
  expect((await model.complete(request())).output).toEqual([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    },
  ]);
  expect(calls).toBe(1);
});
