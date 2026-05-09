import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTrace, setTracingDisabled } from '@openai/agents-core';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import { HEADERS } from '../src/defaults';
import logger from '../src/logger';

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

  it('warns and ignores server-managed conversation state by default', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      previousResponseId: 'resp_123',
      conversationId: 'conv_123',
    };

    await withTrace('t', () => model.getResponse(req));
    await withTrace('t', () => model.getResponse(req));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'server-managed conversation state',
    );
    expect(warnSpy.mock.calls[0]?.[0]).toContain('previousResponseId');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('conversationId');
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('throws for server-managed conversation state in strict mode', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt', {
      strictFeatureValidation: true,
    });
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      previousResponseId: 'resp_123',
    };

    await expect(withTrace('t', () => model.getResponse(req))).rejects.toThrow(
      'server-managed conversation state',
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('warns and ignores reusable prompts by default', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      prompt: { promptId: 'pmpt_123' },
    };

    await withTrace('t', () => model.getResponse(req));
    await withTrace('t', () => model.getResponse(req));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'Reusable prompts are only supported by the Responses API',
    );
    expect(
      client.chat.completions.create.mock.calls[0]?.[0],
    ).not.toHaveProperty('prompt');
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('throws for reusable prompts in strict mode', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt', {
      strictFeatureValidation: true,
    });
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      prompt: { promptId: 'pmpt_123' },
    };

    await expect(withTrace('t', () => model.getResponse(req))).rejects.toThrow(
      'Reusable prompts',
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('preserves SDK retries for direct callers when no runner retry policy is configured', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r-default-retries',
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

    await withTrace('t', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(client.chat.completions.create.mock.calls[0]?.[1]).toEqual({
      headers: HEADERS,
      signal: undefined,
    });
  });

  it('preserves SDK retries for direct callers when a retry policy is present', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r-policy-no-runner-retries',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {
        retry: {
          policy: () => true,
        },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await withTrace('t', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(client.chat.completions.create.mock.calls[0]?.[1]).toEqual({
      headers: HEADERS,
      signal: undefined,
    });
  });

  it('preserves SDK retries for direct callers when maxRetries is configured', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r-max-retries-no-policy',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {
        retry: {
          maxRetries: 2,
        },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await withTrace('t', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(client.chat.completions.create.mock.calls[0]?.[1]).toEqual({
      headers: HEADERS,
      signal: undefined,
    });
  });

  it('disables SDK retries when runner retries are enabled', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r-runner-retries',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {
        retry: {
          maxRetries: 2,
          policy: () => true,
        },
      },
      _internal: {
        runnerManagedRetry: true,
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await withTrace('t', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(client.chat.completions.create.mock.calls[0]?.[1]).toEqual({
      headers: HEADERS,
      maxRetries: 0,
      signal: undefined,
    });
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

  it('sends prompt cache retention when provided', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [{ message: { content: 'cached' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {
        promptCacheRetention: 'in-memory',
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await withTrace('t', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt_cache_retention: 'in_memory',
      }),
      { headers: HEADERS, signal: undefined },
    );
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

  it('merges top-level reasoning and text settings into chat completions request payload', async () => {
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
      modelSettings: {
        reasoning: { effort: 'high' },
        text: { verbosity: 'medium' },
        providerData: { customOption: 'keep' },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await withTrace('t', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    const [args, options] = client.chat.completions.create.mock.calls[0];
    expect(args.reasoning_effort).toBe('high');
    expect(args.verbosity).toBe('medium');
    expect(args.customOption).toBe('keep');
    expect(options).toEqual({
      headers: HEADERS,
      signal: undefined,
    });
  });

  it('passes none reasoning effort through to chat completions payloads', async () => {
    const client = new FakeClient();
    const response = {
      id: 'gpt-5.1-response',
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    client.chat.completions.create.mockResolvedValue(response);

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt-5.1');
    const req: any = {
      input: 'prompt',
      modelSettings: {
        reasoning: { effort: 'none' },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await withTrace('gpt-5.1 none', () => model.getResponse(req));

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    const [args, options] = client.chat.completions.create.mock.calls[0];
    expect(args.reasoning_effort).toBe('none');
    expect(options).toEqual({
      headers: HEADERS,
      signal: undefined,
    });
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

  it('rejects namespaced function tools before sending a request', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [
        {
          type: 'function',
          name: 'lookup_account',
          description: 'Look up CRM accounts.',
          parameters: { type: 'object', properties: {}, required: [] },
          strict: true,
          namespace: 'crm',
          namespaceDescription: 'CRM tools',
        },
        {
          type: 'function',
          name: 'lookup_account',
          description: 'Look up billing accounts.',
          parameters: { type: 'object', properties: {}, required: [] },
          strict: true,
          namespace: 'billing',
          namespaceDescription: 'Billing tools',
        },
      ],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await expect(withTrace('t', () => model.getResponse(req))).rejects.toThrow(
      'Namespaced function tools created with toolNamespace() are only supported with the Responses API.',
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('rejects deferred function tools before sending a request', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: {},
      tools: [
        {
          type: 'function',
          name: 'lookup_account',
          description: 'Look up an account.',
          parameters: { type: 'object', properties: {}, required: [] },
          strict: true,
          deferLoading: true,
        },
      ],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await expect(withTrace('t', () => model.getResponse(req))).rejects.toThrow(
      'Function tools with deferLoading: true are only supported with the Responses API.',
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('rejects required toolChoice when no tools are available', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: { toolChoice: 'required' },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await expect(withTrace('t', () => model.getResponse(req))).rejects.toThrow(
      'modelSettings.toolChoice="required" requires at least one available tool in Chat Completions mode.',
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('rejects named toolChoice when the tool is unavailable', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'u',
      modelSettings: { toolChoice: 'missing_tool' },
      tools: [
        {
          type: 'function',
          name: 'available_tool',
          description: 'Available tool.',
          parameters: { type: 'object', properties: {}, required: [] },
          strict: true,
        },
      ],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    await expect(withTrace('t', () => model.getResponse(req))).rejects.toThrow(
      'modelSettings.toolChoice="missing_tool" does not match any available tool or handoff in Chat Completions mode.',
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('handles content and tool calls in the same message', async () => {
    const client = new FakeClient();
    const response = {
      id: 'r',
      choices: [
        {
          message: {
            content: 'hi',
            tool_calls: [
              {
                id: 'call1',
                type: 'function',
                function: { name: 'do', arguments: '{"a":1}' },
                extra: 'y',
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
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'hi',
            providerData: {
              tool_calls: [
                {
                  id: 'call1',
                  type: 'function',
                  function: { name: 'do', arguments: '{"a":1}' },
                  extra: 'y',
                },
              ],
            },
          },
        ],
      },
      {
        id: 'r',
        type: 'function_call',
        arguments: '{"a":1}',
        name: 'do',
        callId: 'call1',
        status: 'completed',
        providerData: {
          type: 'function',
          function: { name: 'do', arguments: '{"a":1}' },
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
    ).toBeUndefined();

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

  it('warns and ignores unsupported stream response features by default', async () => {
    const client = new FakeClient();
    async function* fakeStream() {
      yield { id: 'c' } as any;
    }
    client.chat.completions.create.mockResolvedValue(fakeStream());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt');
    const req: any = {
      input: 'hi',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      previousResponseId: 'resp_123',
      prompt: { promptId: 'pmpt_123' },
    };

    await withTrace('t', async () => {
      for await (const _event of model.getStreamedResponse(req)) {
        // Consume the stream.
      }
    });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'server-managed conversation state',
    );
    expect(warnSpy.mock.calls[1]?.[0]).toContain('Reusable prompts');
    expect(
      client.chat.completions.create.mock.calls[0]?.[0],
    ).not.toHaveProperty('prompt');
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('throws for unsupported stream response features in strict mode', async () => {
    const client = new FakeClient();
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt', {
      strictFeatureValidation: true,
    });
    const req: any = {
      input: 'hi',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      conversationId: 'conv_123',
    };

    await expect(
      withTrace('t', async () => {
        for await (const _event of model.getStreamedResponse(req)) {
          // Consume the stream.
        }
      }),
    ).rejects.toThrow('server-managed conversation state');
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('populates usage from response_done event when initial usage is zero', async () => {
    // override the original implementation to add the response_done event.
    vi.mocked(convertChatCompletionsStreamToResponses).mockImplementationOnce(
      async function* () {
        yield { type: 'first' } as any;
        yield { type: 'second' } as any;
        yield {
          type: 'response_done',
          response: {
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              inputTokensDetails: { cached_tokens: 2 },
              outputTokensDetails: { reasoning_tokens: 3 },
            },
          },
        } as any;
      },
    );

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
    const responseDone = events.find((e) => e.type === 'response_done');
    expect(responseDone).toBeDefined();
    expect(responseDone.response.usage.totalTokens).toBe(15);
  });
});
