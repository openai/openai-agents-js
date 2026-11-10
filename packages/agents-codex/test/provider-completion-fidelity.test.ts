import { createAnthropic } from '@ai-sdk/anthropic';
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
it.each(
  ['anthropic.messages', 'custom.messages'].flatMap((name) =>
    ['enabled', 'adaptive'].map((type) => ({ name, type })),
  ),
)(
  'rejects configured Anthropic $type thinking for $name before client entry',
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
    const failure = await model.complete(request()).then(
      () => undefined,
      (error: Error) => error,
    );
    expect({ error: failure?.message, calls }).toEqual({
      error: 'AiSdkModel does not support configured Anthropic thinking',
      calls: 0,
    });
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
