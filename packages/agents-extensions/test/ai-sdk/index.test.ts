import { describe, test, expect, vi } from 'vitest';
import {
  AiSdkModel,
  getResponseFormat,
  itemsToLanguageV2Messages,
  parseArguments,
  toolChoiceToLanguageV2Format,
  toolToLanguageV2Tool,
} from '../../src/ai-sdk/index';
import { protocol, withTrace, UserError } from '@openai/agents';
import { ReadableStream } from 'node:stream/web';
import type { JSONSchema7, LanguageModelV2 } from '@ai-sdk/provider';
import type { SerializedOutputType } from '@openai/agents';
import { allowConsole } from '../../../../helpers/tests/console-guard';

function stubModel(
  partial: Partial<Pick<LanguageModelV2, 'doGenerate' | 'doStream'>>,
  options?: {
    provider?: string;
    modelId?: string;
    specificationVersion?: string;
  },
): LanguageModelV2 {
  return {
    specificationVersion: options?.specificationVersion ?? 'v2',
    provider: options?.provider ?? 'stub',
    modelId: options?.modelId ?? 'm',
    supportedUrls: {} as any,
    async doGenerate(options) {
      if (partial.doGenerate) {
        return partial.doGenerate(options) as any;
      }
      return {
        content: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        response: { id: 'id' },
        providerMetadata: {},
        finishReason: 'stop',
        warnings: [],
      } as any;
    },
    async doStream(options) {
      if (partial.doStream) {
        return partial.doStream(options);
      }
      return {
        stream: new ReadableStream(),
      } as any;
    },
  } as LanguageModelV2;
}

function partsStream(parts: any[]): ReadableStream<any> {
  return ReadableStream.from(
    (async function* () {
      for (const p of parts) {
        yield p;
      }
    })(),
  );
}

describe('getResponseFormat', () => {
  test('converts text output type', () => {
    const outputType: SerializedOutputType = 'text';
    const result = getResponseFormat(outputType);
    expect(result).toEqual({ type: 'text' });
  });

  test('converts json schema output type', () => {
    const outputType: SerializedOutputType = {
      type: 'json_schema',
      name: 'output',
      strict: false,
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    };
    const result = getResponseFormat(outputType);
    expect(result).toEqual({
      type: 'json',
      name: outputType.name,
      schema: outputType.schema,
    });
  });
});

describe('AiSdkModel end-to-end scenarios', () => {
  test('streams interleaved text and multiple tool calls with usage', async () => {
    const parts = [
      { type: 'text-delta', delta: 'Hello ' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'search',
        input: '{"q":"a"}',
        providerMetadata: { meta: 1 },
      },
      { type: 'text-delta', delta: 'world' },
      {
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'lookup',
        input: '{"id":2}',
        providerMetadata: { meta: 2 },
      },
      {
        type: 'response-metadata',
        id: 'resp-stream',
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 5 },
      },
    ];

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return { stream: partsStream(parts) } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello world' }],
        status: 'completed',
        providerData: { model: 'stub:m', responseId: 'resp-stream' },
      },
      {
        type: 'function_call',
        callId: 'c1',
        name: 'search',
        arguments: '{"q":"a"}',
        status: 'completed',
        providerData: { model: 'stub:m', meta: 1, responseId: 'resp-stream' },
      },
      {
        type: 'function_call',
        callId: 'c2',
        name: 'lookup',
        arguments: '{"id":2}',
        status: 'completed',
        providerData: { model: 'stub:m', meta: 2, responseId: 'resp-stream' },
      },
    ]);
    expect(final.response.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
  });

  test('supports v3 models without throwing during conversion', async () => {
    const v3Model: any = {
      specificationVersion: 'v3',
      provider: 'v3-provider',
      modelId: 'v3-model',
      supportedUrls: {},
      async doGenerate(options: any) {
        return {
          content: [
            {
              type: 'text',
              text: 'hello v3',
            },
          ],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          response: { id: 'resp-v3' },
          providerMetadata: options,
          finishReason: 'stop',
          warnings: [],
        };
      },
      async doStream() {
        return { stream: partsStream([{ type: 'text-delta', delta: 'hi' }]) };
      },
    };

    const model = new AiSdkModel(v3Model);
    const resp = await withTrace('v3-model', () =>
      model.getResponse({
        input: 'prompt',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: true,
      } as any),
    );

    expect(resp.output[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'hello v3' }],
    });
  });

  test('returns JSON schema output in streaming finish', async () => {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    };
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream([
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1 },
                response: { id: 'resp-json' },
              },
            ]),
          };
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: {
        type: 'json_schema',
        name: 'output',
        schema,
        strict: false,
      },
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([]);
  });
});

describe('itemsToLanguageV2Messages', () => {
  test('converts user text and function call items', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hi',
            providerData: { test: { cacheControl: { type: 'ephemeral' } } },
          },
        ],
      } as any,
      {
        type: 'function_call',
        callId: '1',
        name: 'foo',
        arguments: '{}',
        providerData: { a: 1 },
      } as any,
      {
        type: 'function_call_result',
        callId: '1',
        name: 'foo',
        output: { type: 'text', text: 'out' },
        providerData: { b: 2 },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hi',
            providerOptions: { test: { cacheControl: { type: 'ephemeral' } } },
          },
        ],
        providerOptions: {},
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'foo',
            input: {},
            providerOptions: { a: 1 },
          },
        ],
        providerOptions: { a: 1 },
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'foo',
            output: { type: 'text', value: 'out' },
            providerOptions: { b: 2 },
          },
        ],
        providerOptions: { b: 2 },
      },
    ]);
  });

  test('throws on built-in tool calls', () => {
    const items: protocol.ModelItem[] = [
      { type: 'hosted_tool_call', name: 'search' } as any,
    ];
    expect(() => itemsToLanguageV2Messages(stubModel({}), items)).toThrow();
  });

  test('throws on computer tool calls and results', () => {
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'computer_call' } as any,
      ]),
    ).toThrow(UserError);
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'computer_call_result' } as any,
      ]),
    ).toThrow(UserError);
  });

  test('throws on shell tool calls and results', () => {
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [{ type: 'shell_call' } as any]),
    ).toThrow(UserError);
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'shell_call_output' } as any,
      ]),
    ).toThrow(UserError);
  });

  test('throws on apply_patch tool calls and results', () => {
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'apply_patch_call' } as any,
      ]),
    ).toThrow(UserError);
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'apply_patch_call_output' } as any,
      ]),
    ).toThrow(UserError);
  });

  test('converts user images, function results and reasoning items', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' },
          { type: 'input_image', image: 'http://x/img' },
        ],
      } as any,
      {
        type: 'function_call',
        callId: '1',
        name: 'do',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: '1',
        name: 'do',
        output: { type: 'text', text: 'out' },
      } as any,
      { type: 'reasoning', content: [{ text: 'why' }] } as any,
    ];
    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi', providerOptions: {} },
          {
            type: 'file',
            data: new URL('http://x/img'),
            mediaType: 'image/*',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'do',
            input: {},
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'do',
            output: { type: 'text', value: 'out' },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'why', providerOptions: {} }],
        providerOptions: {},
      },
    ]);
  });

  test('converts structured tool output lists', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call',
        callId: 'tool-1',
        name: 'describe_image',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: 'tool-1',
        name: 'describe_image',
        output: [
          { type: 'input_text', text: 'A scenic view.' },
          {
            type: 'input_image',
            image: 'https://example.com/image.png',
          },
        ],
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'describe_image',
            input: {},
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'describe_image',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'A scenic view.' },
                {
                  type: 'media',
                  data: 'https://example.com/image.png',
                  mediaType: 'image/*',
                },
              ],
            },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('handles undefined providerData without throwing', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
        providerData: undefined,
      } as any,
    ];
    expect(() => itemsToLanguageV2Messages(stubModel({}), items)).not.toThrow();
    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', providerOptions: {} }],
        providerOptions: {},
      },
    ]);
  });

  test('throws UserError for unsupported content or unknown item type', () => {
    const bad: protocol.ModelItem[] = [
      { role: 'user', content: [{ type: 'bad' as any }] } as any,
    ];
    expect(() => itemsToLanguageV2Messages(stubModel({}), bad)).toThrow(
      UserError,
    );

    const unknown: protocol.ModelItem[] = [{ type: 'bogus' } as any];
    expect(() => itemsToLanguageV2Messages(stubModel({}), unknown)).toThrow(
      UserError,
    );
  });

  test('rejects input_file content', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: 'file_123',
          },
        ],
      } as any,
    ];

    expect(() => itemsToLanguageV2Messages(stubModel({}), items)).toThrow(
      /File inputs are not supported/,
    );
  });

  test('passes through unknown items via providerData', () => {
    const custom = { role: 'system', content: 'x', providerOptions: { a: 1 } };
    const items: protocol.ModelItem[] = [
      { type: 'unknown', providerData: custom } as any,
    ];
    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([custom]);
  });
});

describe('toolToLanguageV2Tool', () => {
  const model = stubModel({});
  test('maps function tools', () => {
    const tool = {
      type: 'function',
      name: 'foo',
      description: 'd',
      parameters: {} as any,
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'function',
      name: 'foo',
      description: 'd',
      inputSchema: {},
    });
  });

  test('maps builtin tools', () => {
    const tool = {
      type: 'hosted_tool',
      name: 'search',
      providerData: { args: { q: 1 } },
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'provider-defined',
      id: `${model.provider}.search`,
      name: 'search',
      args: { q: 1 },
    });
  });

  test('normalizes OpenAI v3 builtin tool IDs', () => {
    const v3Model = stubModel(
      {},
      { provider: 'openai.responses', specificationVersion: 'v3' },
    );
    const tool = {
      type: 'hosted_tool',
      name: 'file_search',
      providerData: { args: { query: 'x' } },
    } as any;
    expect(toolToLanguageV2Tool(v3Model, tool)).toEqual({
      type: 'provider',
      id: 'openai.file_search',
      name: 'file_search',
      args: { query: 'x' },
    });
  });

  test('maps computer tools', () => {
    const tool = {
      type: 'computer',
      name: 'comp',
      environment: 'env',
      dimensions: [2, 3],
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'provider-defined',
      id: `${model.provider}.comp`,
      name: 'comp',
      args: { environment: 'env', display_width: 2, display_height: 3 },
    });
  });

  test('throws on unknown type', () => {
    const tool = { type: 'x', name: 'u' } as any;
    expect(() => toolToLanguageV2Tool(model, tool)).toThrow();
  });
});

describe('AiSdkModel.getResponse', () => {
  test('handles text output', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: { p: 1 },
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id',
          p: 1,
        },
      },
    ]);
  });

  test('accepts specificationVersion v3 models with compatible shape', async () => {
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate() {
            return {
              content: [{ type: 'text', text: 'ok v3' }],
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              providerMetadata: {},
              response: { id: 'id-v3' },
              finishReason: 'stop',
              warnings: [],
            } as any;
          },
        },
        { specificationVersion: 'v3' },
      ),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output[0]).toMatchObject({
      providerData: {
        model: 'stub:m',
        responseId: 'id-v3',
      },
    });
  });

  test('normalizes empty string tool input for object schemas', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'objectTool',
                input: '',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: { meta: true },
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'objectTool',
            description: 'accepts object',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      arguments: '{}',
    });
  });

  test('normalizes empty string tool input for handoff schemas', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'handoff-call',
                toolName: 'handoffTool',
                input: '',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: { meta: true },
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [
          {
            toolName: 'handoffTool',
            toolDescription: 'handoff accepts object',
            inputJsonSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            strictJsonSchema: true,
          } as any,
        ],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      arguments: '{}',
    });
  });

  test('forwards toolChoice to AI SDK (generate)', async () => {
    const seen: any[] = [];
    const model = new AiSdkModel(
      stubModel({
        async doGenerate(options) {
          seen.push(options.toolChoice);
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    // auto
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'auto' },
        outputType: 'text',
        tracing: false,
      } as any),
    );
    // required
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'required' },
        outputType: 'text',
        tracing: false,
      } as any),
    );
    // none
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'none' },
        outputType: 'text',
        tracing: false,
      } as any),
    );
    // specific tool
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'myTool' as any },
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(seen).toEqual([
      { type: 'auto' },
      { type: 'required' },
      { type: 'none' },
      { type: 'tool', toolName: 'myTool' },
    ]);
  });

  test('aborts when signal already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const doGenerate = vi.fn(async (opts: any) => {
      if (opts.abortSignal?.aborted) {
        throw new Error('aborted');
      }
      return {
        content: [{ type: 'text', text: 'should not' }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        response: { id: 'id' },
        finishReason: 'stop',
        warnings: [],
      };
    });
    const model = new AiSdkModel(
      stubModel({
        // @ts-expect-error don't care about the type error here
        doGenerate,
      }),
    );

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
          signal: abort.signal,
        } as any),
      ),
    ).rejects.toThrow('aborted');
    expect(doGenerate).toHaveBeenCalled();
  });

  test('handles function call output', async () => {
    allowConsole(['warn']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'foo',
                input: {} as any,
              },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: { p: 1 },
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toEqual([
      {
        type: 'function_call',
        callId: 'c1',
        name: 'foo',
        arguments: '{}',
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id',
          p: 1,
        },
      },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      "Received tool call for unknown tool 'foo'.",
    );
    warnSpy.mockRestore();
  });

  test('preserves per-tool-call providerMetadata (e.g., Gemini thoughtSignature)', async () => {
    const toolCallProviderMetadata = {
      google: { thoughtSignature: 'sig123' },
    };
    const resultProviderMetadata = {
      google: { usageMetadata: { totalTokenCount: 100 } },
    };

    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'get_weather',
                input: { location: 'Tokyo' },
                providerMetadata: toolCallProviderMetadata,
              },
            ],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            providerMetadata: resultProviderMetadata,
            response: { id: 'resp-1' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'What is the weather in Tokyo?',
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: {} },
          },
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'c1',
      name: 'get_weather',
      providerData: {
        model: 'stub:m',
        responseId: 'resp-1',
        ...toolCallProviderMetadata,
      },
    });
    // Ensure we get per-tool-call metadata, not result-level metadata
    expect(res.output[0].providerData).not.toEqual(resultProviderMetadata);
  });

  test('falls back to result.providerMetadata when toolCall.providerMetadata is undefined', async () => {
    allowConsole(['warn']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resultProviderMetadata = { fallback: true };

    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'foo',
                input: {},
                // No providerMetadata on tool call
              },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: resultProviderMetadata,
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output[0].providerData).toEqual({
      model: 'stub:m',
      responseId: 'id',
      ...resultProviderMetadata,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Received tool call for unknown tool 'foo'.",
    );
    warnSpy.mockRestore();
  });

  test('propagates errors', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          throw new Error('bad');
        },
      }),
    );

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow('bad');
  });

  test('prepends system instructions to prompt for doGenerate', async () => {
    let received: any;
    const model = new AiSdkModel(
      stubModel({
        async doGenerate(options) {
          received = options.prompt;
          return {
            content: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          };
        },
      }),
    );

    await withTrace('t', () =>
      model.getResponse({
        systemInstructions: 'inst',
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(received[0]).toEqual({
      role: 'system',
      content: 'inst',
    });
  });

  test('handles NaN usage in doGenerate', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [],
            usage: {
              inputTokens: Number.NaN,
              outputTokens: Number.NaN,
              totalTokens: Number.NaN,
            },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          };
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.usage).toEqual({
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokensDetails: [],
      outputTokensDetails: [],
      requestUsageEntries: undefined,
    });
  });
});

describe('AiSdkModel.getStreamedResponse', () => {
  test('streams events and completes', async () => {
    const parts = [
      { type: 'text-delta', delta: 'a' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'foo',
        input: '{"k":"v"}',
      },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'a' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
      {
        type: 'function_call',
        callId: 'c1',
        name: 'foo',
        arguments: '{"k":"v"}',
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
    ]);
  });

  test('preserves per-tool-call providerMetadata in streaming mode (e.g., Gemini thoughtSignature)', async () => {
    const toolCallProviderMetadata = {
      google: { thoughtSignature: 'stream-sig-456' },
    };

    const parts = [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'get_weather',
        input: '{"location":"Tokyo"}',
        providerMetadata: toolCallProviderMetadata,
      },
      { type: 'response-metadata', id: 'resp-stream-1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ];

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'What is the weather?',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: {} },
        },
      ],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toHaveLength(1);
    expect(final.response.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'c1',
      name: 'get_weather',
      providerData: {
        model: 'stub:m',
        responseId: 'resp-stream-1',
        ...toolCallProviderMetadata,
      },
    });
  });

  test('includes base providerData in streaming mode even when providerMetadata is not present', async () => {
    const parts = [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'foo',
        input: '{}',
        // No providerMetadata
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ];

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'c1',
      name: 'foo',
    });
    // Base provider data should be present to preserve model origin
    expect(final.response.output[0].providerData).toEqual({
      model: 'stub:m',
    });
  });

  test('propagates stream errors', async () => {
    const err = new Error('bad');
    const parts = [{ type: 'error', error: err }];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    await expect(async () => {
      const iter = model.getStreamedResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any);

      for await (const ev of iter) {
        if (ev.type === 'response_done') {
          expect(ev.response.id).toBeDefined();
        } else if (ev.type === 'model') {
          expect(ev.event).toBeDefined();
        }
      }
    }).rejects.toThrow('bad');
  });

  test('aborts streaming when signal already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const doStream = vi.fn(async (opts: any) => {
      if (opts.abortSignal?.aborted) {
        throw new Error('aborted');
      }
      return {
        stream: partsStream([]),
      } as any;
    });
    const model = new AiSdkModel(
      stubModel({
        doStream,
      }),
    );

    await expect(async () => {
      const iter = model.getStreamedResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
        signal: abort.signal,
      } as any);
      for await (const _ of iter) {
        /* nothing */
      }
    }).rejects.toThrow('aborted');
    expect(doStream).toHaveBeenCalled();
  });

  test('prepends system instructions to prompt for doStream', async () => {
    let received: any;
    const model = new AiSdkModel(
      stubModel({
        async doStream(options) {
          received = options.prompt;
          return {
            stream: partsStream([]),
          } as any;
        },
      }),
    );

    const iter = model.getStreamedResponse({
      systemInstructions: 'inst',
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any);

    for await (const _ of iter) {
      // exhaust iterator
    }

    expect(received[0]).toEqual({
      role: 'system',
      content: 'inst',
    });
  });

  test('handles NaN usage in stream finish event', async () => {
    const parts = [
      { type: 'text-delta', delta: 'a' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: Number.NaN, outputTokens: Number.NaN },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    let final: any;
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      if (ev.type === 'response_done') {
        final = ev.response.usage;
      }
    }

    expect(final).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  test('prepends system instructions to prompt for doStream', async () => {
    let received: any;
    const model = new AiSdkModel(
      stubModel({
        async doStream(options) {
          received = options.prompt;
          return { stream: partsStream([]) } as any;
        },
      }),
    );

    for await (const _ of model.getStreamedResponse({
      systemInstructions: 'inst',
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      // drain
    }

    expect(received[0]).toEqual({ role: 'system', content: 'inst' });
  });
});

describe('toolChoiceToLanguageV2Format', () => {
  test('maps default choices and specific tool', () => {
    expect(toolChoiceToLanguageV2Format(undefined)).toBeUndefined();
    expect(toolChoiceToLanguageV2Format(null as any)).toBeUndefined();
    expect(toolChoiceToLanguageV2Format('auto')).toEqual({ type: 'auto' });
    expect(toolChoiceToLanguageV2Format('required')).toEqual({
      type: 'required',
    });
    expect(toolChoiceToLanguageV2Format('none')).toEqual({ type: 'none' });
    expect(toolChoiceToLanguageV2Format('runTool' as any)).toEqual({
      type: 'tool',
      toolName: 'runTool',
    });
  });
});

describe('Extended thinking / Reasoning support', () => {
  describe('Non-streaming (getResponse)', () => {
    test('captures reasoning parts and outputs them before tool calls', async () => {
      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            return {
              content: [
                {
                  type: 'reasoning',
                  text: 'Let me think through this step by step...',
                  providerMetadata: {
                    anthropic: { signature: 'sig_abc123' },
                  },
                },
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'get_weather',
                  input: { location: 'Tokyo' },
                },
              ],
              usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
              providerMetadata: { anthropic: { thinkingTokens: 30 } },
              response: { id: 'resp-1' },
              finishReason: 'tool-calls',
              warnings: [],
            } as any;
          },
        }),
      );

      const res = await withTrace('t', () =>
        model.getResponse({
          input: 'What is the weather in Tokyo?',
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get weather info',
              parameters: { type: 'object', properties: {} },
            },
          ],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      );

      // Reasoning item should come FIRST, before tool calls
      expect(res.output).toHaveLength(2);
      expect(res.output[0]).toMatchObject({
        type: 'reasoning',
        content: [
          {
            type: 'input_text',
            text: 'Let me think through this step by step...',
          },
        ],
        rawContent: [
          {
            type: 'reasoning_text',
            text: 'Let me think through this step by step...',
          },
        ],
        providerData: {
          model: 'stub:m',
          responseId: 'resp-1',
          anthropic: { signature: 'sig_abc123' },
        },
      });
      expect(res.output[1]).toMatchObject({
        type: 'function_call',
        callId: 'call-1',
        name: 'get_weather',
      });
    });

    test('handles reasoning without signature (non-Anthropic providers)', async () => {
      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            return {
              content: [
                {
                  type: 'reasoning',
                  text: 'Thinking about this problem...',
                  // No providerMetadata / signature
                },
                { type: 'text', text: 'The answer is 42.' },
              ],
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              providerMetadata: {},
              response: { id: 'resp-2' },
              finishReason: 'stop',
              warnings: [],
            } as any;
          },
        }),
      );

      const res = await withTrace('t', () =>
        model.getResponse({
          input: 'What is the meaning of life?',
          tools: [],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      );

      expect(res.output).toHaveLength(2);
      expect(res.output[0]).toMatchObject({
        type: 'reasoning',
        content: [
          { type: 'input_text', text: 'Thinking about this problem...' },
        ],
        providerData: {
          model: 'stub:m',
          responseId: 'resp-2',
        },
      });
      expect(res.output[1]).toMatchObject({
        type: 'message',
        content: [{ type: 'output_text', text: 'The answer is 42.' }],
      });
    });
  });

  describe('Streaming (getStreamedResponse)', () => {
    test('captures reasoning stream events and outputs them before tool calls', async () => {
      const parts = [
        {
          type: 'reasoning-start',
          id: 'reasoning-1',
          providerMetadata: { anthropic: { thinking: 'enabled' } },
        },
        {
          type: 'reasoning-delta',
          id: 'reasoning-1',
          delta: 'Let me think...',
        },
        { type: 'reasoning-delta', id: 'reasoning-1', delta: ' step by step.' },
        {
          type: 'reasoning-end',
          id: 'reasoning-1',
          providerMetadata: { anthropic: { signature: 'sig_stream_123' } },
        },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'search',
          input: '{"query":"test"}',
        },
        { type: 'response-metadata', id: 'resp-stream-1' },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 20, outputTokens: 40 },
        },
      ];

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            return {
              stream: partsStream(parts),
            } as any;
          },
        }),
      );

      const events: any[] = [];
      for await (const ev of model.getStreamedResponse({
        input: 'Search for something',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        events.push(ev);
      }

      const final = events.at(-1);
      expect(final.type).toBe('response_done');

      // Reasoning should come FIRST in output
      expect(final.response.output).toHaveLength(2);
      expect(final.response.output[0]).toMatchObject({
        type: 'reasoning',
        id: 'reasoning-1',
        content: [
          { type: 'input_text', text: 'Let me think... step by step.' },
        ],
        rawContent: [
          { type: 'reasoning_text', text: 'Let me think... step by step.' },
        ],
        providerData: {
          model: 'stub:m',
          responseId: 'resp-stream-1',
          anthropic: { signature: 'sig_stream_123' },
        },
      });
      expect(final.response.output[1]).toMatchObject({
        type: 'function_call',
        callId: 'c1',
        name: 'search',
      });
    });

    test('handles multiple reasoning blocks in streaming', async () => {
      const parts = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'First thought.' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'reasoning-start', id: 'r2' },
        { type: 'reasoning-delta', id: 'r2', delta: 'Second thought.' },
        { type: 'reasoning-end', id: 'r2' },
        { type: 'text-delta', delta: 'Final answer.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      ];

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            return {
              stream: partsStream(parts),
            } as any;
          },
        }),
      );

      const events: any[] = [];
      for await (const ev of model.getStreamedResponse({
        input: 'Complex problem',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        events.push(ev);
      }

      const final = events.at(-1);
      expect(final.type).toBe('response_done');
      expect(final.response.output).toHaveLength(3);
      expect(final.response.output[0]).toMatchObject({
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'First thought.' }],
      });
      expect(final.response.output[1]).toMatchObject({
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Second thought.' }],
      });
      expect(final.response.output[2]).toMatchObject({
        type: 'message',
        content: [{ type: 'output_text', text: 'Final answer.' }],
      });
    });

    test('handles reasoning-delta without reasoning-start', async () => {
      const parts = [
        {
          type: 'reasoning-delta',
          id: 'orphan',
          delta: 'Direct thinking content',
        },
        { type: 'reasoning-end', id: 'orphan' },
        { type: 'text-delta', delta: 'Response.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 10 },
        },
      ];

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            return {
              stream: partsStream(parts),
            } as any;
          },
        }),
      );

      const events: any[] = [];
      for await (const ev of model.getStreamedResponse({
        input: 'test',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        events.push(ev);
      }

      const final = events.at(-1);
      expect(final.response.output[0]).toMatchObject({
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Direct thinking content' }],
      });
    });
  });

  describe('Round-trip conversion (ReasoningItem to AI SDK and back)', () => {
    test('preserves signature in providerData through itemsToLanguageV2Messages', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'My reasoning process...' }],
          providerData: { anthropic: { signature: 'preserved_sig_456' } },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(stubModel({}), items);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'My reasoning process...',
            providerOptions: { anthropic: { signature: 'preserved_sig_456' } },
          },
        ],
        providerOptions: { anthropic: { signature: 'preserved_sig_456' } },
      });
    });

    test('omits providerOptions when providerData model does not match target model', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'function_call',
          callId: 'c1',
          name: 'foo',
          arguments: '{}',
          providerData: { model: 'anthropic:claude-3' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'google', modelId: 'gemini-2.0-pro' }),
        items,
      );
      expect(msgs).toHaveLength(1);
      const assistant = msgs[0];
      if (assistant.role !== 'assistant') {
        throw new Error('Expected assistant message');
      }
      expect((assistant as any).content[0].providerOptions).toEqual({});
    });

    test('preserves Gemini thoughtSignature in providerOptions when model matches', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'function_call',
          callId: 'c1',
          name: 'foo',
          arguments: '{}',
          providerData: {
            model: 'google:gemini-2.0-pro',
            google: { thoughtSignature: 'sig-123' },
          },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'google', modelId: 'gemini-2.0-pro' }),
        items,
      );
      const assistant = msgs[0] as any;
      expect(assistant.content[0].providerOptions).toMatchObject({
        google: { thoughtSignature: 'sig-123' },
      });
    });

    test('bundles reasoning with tool call for DeepSeek Reasoner', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Internal chain.' }],
          providerData: {
            model: 'deepseek:deepseek-reasoner',
            deepseek: { signature: 'sig' },
          },
        } as any,
        {
          type: 'function_call',
          callId: 'c1',
          name: 'foo',
          arguments: '{}',
          providerData: {
            model: 'deepseek:deepseek-reasoner',
            deepseek: { signature: 'sig' },
          },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-reasoner' }),
        items,
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Internal chain.',
              providerOptions: { deepseek: { signature: 'sig' } },
            },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'foo',
              input: {},
              providerOptions: { deepseek: { signature: 'sig' } },
            },
          ],
          providerOptions: { deepseek: { signature: 'sig' } },
        },
      ]);
    });

    test('bundles reasoning with tool call when DeepSeek thinking mode is enabled', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Thinking...' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c2',
          name: 'bar',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Thinking...',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c2',
              toolName: 'bar',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('bundles reasoning when DeepSeek thinking flag is a string', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Thinking as a flag.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-string',
          name: 'flagged',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: 'enabled' } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Thinking as a flag.',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c-string',
              toolName: 'flagged',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('bundles reasoning when DeepSeek thinking is nested', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Nested thinking.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-nested',
          name: 'nested',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { deepseek: { thinking: { type: 'enabled' } } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Nested thinking.',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c-nested',
              toolName: 'nested',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('bundles reasoning when DeepSeek thinking lives under providerOptions', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [
            {
              type: 'input_text',
              text: 'Provider options thinking.',
            },
          ],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-provider-options',
          name: 'viaOptions',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        {
          providerData: {
            providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
          },
        },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Provider options thinking.',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c-provider-options',
              toolName: 'viaOptions',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('emits pending DeepSeek reasoning with assistant text when no tool call follows', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Thinking in order.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Here is the reply.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Thinking in order.',
              providerOptions: {},
            },
            {
              type: 'text',
              text: 'Here is the reply.',
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('emits pending DeepSeek reasoning before tool calls when assistant text precedes tools', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Initial reasoning.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Responding first.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-before-tools',
          name: 'afterMessage',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Initial reasoning.',
              providerOptions: {},
            },
            {
              type: 'text',
              text: 'Responding first.',
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c-before-tools',
              toolName: 'afterMessage',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('does not bundle reasoning when DeepSeek thinking is disabled', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Disabled thinking' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-off',
          name: 'offTool',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { deepseek: { thinking: { type: 'disabled' } } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Disabled thinking',
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c-off',
              toolName: 'offTool',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('does not bundle reasoning for non-DeepSeek models even when thinking is set', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Other chain' }],
          providerData: { vendor: 'other' },
        } as any,
        {
          type: 'function_call',
          callId: 'c3',
          name: 'baz',
          arguments: '{}',
          providerData: { vendor: 'other' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'other', modelId: 'some-reasoner' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Other chain',
              providerOptions: { vendor: 'other' },
            },
          ],
          providerOptions: { vendor: 'other' },
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c3',
              toolName: 'baz',
              input: {},
              providerOptions: { vendor: 'other' },
            },
          ],
          providerOptions: { vendor: 'other' },
        },
      ]);
    });
  });
});

describe('AiSdkModel', () => {
  test('should be available', () => {
    const model = new AiSdkModel({} as any);
    expect(model).toBeDefined();
  });

  test('converts trailing function_call items to messages', async () => {
    let received: any;
    const fakeModel = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'm',
      supportedUrls: [],
      doGenerate: vi.fn(async (opts: any) => {
        received = opts.prompt;
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          providerMetadata: {},
          finishReason: 'stop',
          warnings: [],
        };
      }),
    };

    const model = new AiSdkModel(fakeModel as any);
    await withTrace('t', () =>
      model.getResponse({
        input: [
          {
            type: 'function_call',
            id: '1',
            callId: 'call1',
            name: 'do',
            arguments: '{}',
            status: 'completed',
            providerData: { meta: 1 },
          } as protocol.FunctionCallItem,
        ],
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(received).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call1',
            toolName: 'do',
            input: {},
            providerOptions: { meta: 1 },
          },
        ],
        providerOptions: { meta: 1 },
      },
    ]);
  });

  describe('parseArguments', () => {
    test('should parse valid JSON', () => {
      expect(parseArguments(undefined)).toEqual({});
      expect(parseArguments(null)).toEqual({});
      expect(parseArguments('')).toEqual({});
      expect(parseArguments(' ')).toEqual({});
      expect(parseArguments('{ ')).toEqual({});
      expect(parseArguments('foo')).toEqual({});
      expect(parseArguments('{}')).toEqual({});
      expect(parseArguments('{ }')).toEqual({});

      expect(parseArguments('"foo"')).toEqual('foo');
      expect(parseArguments('[]')).toEqual([]);
      expect(parseArguments('[1,2,3]')).toEqual([1, 2, 3]);
      expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
      expect(parseArguments('{"a":1,"b":"c"}')).toEqual({ a: 1, b: 'c' });
    });
  });

  describe('Error handling with tracing', () => {
    test('captures comprehensive AI SDK error details when tracing enabled', async () => {
      // Simulate an AI SDK error with responseBody and other fields.
      const aiSdkError = new Error('API call failed');
      aiSdkError.name = 'AI_APICallError';
      (aiSdkError as any).responseBody = {
        error: {
          message: 'Rate limit exceeded',
          code: 'rate_limit_exceeded',
          type: 'insufficient_quota',
        },
      };
      (aiSdkError as any).responseHeaders = {
        'x-request-id': 'req_abc123',
        'retry-after': '60',
      };
      (aiSdkError as any).statusCode = 429;

      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            throw aiSdkError;
          },
        }),
      );

      try {
        await withTrace('test-trace', () =>
          model.getResponse({
            input: 'test input',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: true,
          } as any),
        );
        expect.fail('Should have thrown error');
      } catch (error: any) {
        // Error should be re-thrown.
        expect(error.message).toBe('API call failed');
        // Verify error has the AI SDK fields.
        expect((error as any).responseBody).toBeDefined();
        expect((error as any).statusCode).toBe(429);
      }
    });

    test('propagates error with AI SDK fields in streaming mode', async () => {
      const aiSdkError = new Error('Stream failed');
      aiSdkError.name = 'AI_StreamError';
      (aiSdkError as any).responseBody = {
        error: { message: 'Connection timeout', code: 'timeout' },
      };
      (aiSdkError as any).statusCode = 504;

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            throw aiSdkError;
          },
        }),
      );

      try {
        await withTrace('test-stream', async () => {
          const iter = model.getStreamedResponse({
            input: 'test',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: true,
          } as any);

          for await (const _ of iter) {
            // Should not get here.
          }
        });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toBe('Stream failed');
        // Verify error has the AI SDK fields.
        expect((error as any).responseBody).toBeDefined();
        expect((error as any).statusCode).toBe(504);
      }
    });
  });
});
