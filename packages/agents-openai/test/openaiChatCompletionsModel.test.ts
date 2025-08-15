import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTrace, setTracingDisabled } from '@openai/agents-core';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import { HEADERS } from '../src/defaults';

vi.mock('../src/openaiChatCompletionsStreaming', () => {
  return {
    convertChatCompletionsStreamToResponses: vi.fn(async function* () {
      yield { type: 'first' } as any;
      yield { type: 'second' } as any;
    }),
  };
});

vi.mock('openai/helpers/zod', async () => {
  const actual: any = await vi.importActual('openai/helpers/zod');
  return {
    ...actual,
    zodResponseFormat: vi.fn(actual.zodResponseFormat),
  };
});

import { convertChatCompletionsStreamToResponses } from '../src/openaiChatCompletionsStreaming';
import type { SerializedOutputType } from '@openai/agents-core';

class FakeClient {
  chat = { completions: { create: vi.fn() } };
  baseURL = 'base';
}

describe('OpenAIChatCompletionsModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTracingDisabled(true);
  });

  it('handles text message output', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const result = await withTrace('t', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt',
        messages: [{ role: 'user', content: 'u' }],
      }),
      { headers: HEADERS, signal: undefined },
    );
    expect(result.output).toEqual([
      {
        id: 'r',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'hi',
            providerData: {},
          },
        ],
      },
    ]);
  });

  it('parses usage tokens from snake_case fields', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const result = await withTrace('t', () => model.getResponse(req));

    expect(result.usage.inputTokens).toBe(11);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.usage.totalTokens).toBe(18);
  });

  it('outputs message when content is empty string', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const result = await withTrace('t', () => model.getResponse(req));

    expect(result.output).toEqual([
      {
        id: 'r',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '', providerData: {} }],
      },
    ]);
  });

  it('handles refusal message', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { refusal: 'no' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const result = await withTrace('t', () => model.getResponse(req));

    expect(result.output).toEqual([
      {
        id: 'r',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'refusal', refusal: 'no', providerData: {} }],
      },
    ]);
  });

  it('handles audio message', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { audio: { data: 'zzz', format: 'mp3' } } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const result = await withTrace('t', () => model.getResponse(req));

    expect(result.output).toEqual([
      {
        id: 'r',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'audio', audio: 'zzz', providerData: { format: 'mp3' } },
        ],
      },
    ]);
  });

  it('handles reasoning messages from third-party providers', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [
        {
          message: { reasoning: 'because', content: 'hi' },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const result = await withTrace('t', () => model.getResponse(req));

    expect(result.output).toEqual([
      {
        type: 'reasoning',
        content: [],
        rawContent: [{ type: 'reasoning_text', text: 'because' }],
      },
      {
        id: 'r',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'hi',
            providerData: { reasoning: 'because' },
          },
        ],
      },
    ]);
  });

  it('handles function tool calls', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call1',
                type: 'function',
                some: 'x',
                function: { name: 'do', arguments: '{"a":1}', extra: 'y' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const result = await withTrace('t', () => model.getResponse(req));

    expect(result.output).toEqual([
      {
        id: 'r',
        type: 'function_call',
        arguments: '{"a":1}',
        name: 'do',
        callId: 'call1',
        status: 'completed',
        providerData: {
          type: 'function',
          some: 'x',
          function: { name: 'do', arguments: '{"a":1}', extra: 'y' },
          extra: 'y',
        },
      },
    ]);
  });

  it('uses correct response_format for different output types', async () => {
    const client = new FakeClient();
    const emptyResp = {
      id: 'r',
      choices: [{ message: {} }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(emptyResp);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');

    // text
    await withTrace('t', () =>
      model.getResponse({
        input: 'u',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
      } as any),
    );
    expect(
      client.chat.completions.create.mock.calls[0][0].response_format,
    ).toEqual({ type: 'text' });

    const schema: SerializedOutputType = {
      type: 'json_schema',
      name: 'output',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        required: ['foo'],
        additionalProperties: false,
      },
    };
    await withTrace('t', () =>
      model.getResponse({
        input: 'u',
        modelSettings: {},
        tools: [],
        outputType: schema,
        handoffs: [],
        tracing: false,
      }),
    );
    expect(
      client.chat.completions.create.mock.calls[1][0].response_format,
    ).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'output',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            foo: { type: 'string' },
          },
          required: ['foo'],
          additionalProperties: false,
        },
      },
    });

    // json object via JsonSchemaDefinition
    const jsonOutput = {
      type: 'json_schema',
      name: 'o',
      strict: true,
      schema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    } as any;
    await withTrace('t', () =>
      model.getResponse({
        input: 'u',
        modelSettings: {},
        tools: [],
        outputType: jsonOutput,
        handoffs: [],
        tracing: false,
      } as any),
    );
    expect(
      client.chat.completions.create.mock.calls[2][0].response_format,
    ).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'o',
        strict: true,
        schema: jsonOutput.schema,
      },
    });
  });

  it('throws when parallelToolCalls set without tools', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: { parallelToolCalls: true },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };
    await expect(withTrace('t', () => model.getResponse(req))).rejects.toThrow(
      'Parallel tool calls are not supported without tools',
    );
  });

  it('getStreamedResponse propagates streamed events', async () => {
    const client = new FakeClient();
    async function* fakeStream() {
      yield { id: 'c' } as any;
    }
    client.chat.completions.create.mockResolvedValue(fakeStream());

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'hi',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };
    const events: any[] = [];
    await withTrace('t', async () => {
      for await (const e of model.getStreamedResponse(req)) {
        events.push(e);
      }
    });

    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true }),
      { headers: HEADERS, signal: undefined },
    );
    expect(convertChatCompletionsStreamToResponses).toHaveBeenCalled();
    expect(events).toEqual([{ type: 'first' }, { type: 'second' }]);
  });
});
