import { describe, test, expect, vi } from 'vitest';
import {
  AiSdkModel,
  getResponseFormat,
  itemsToLanguageV2Messages,
  parseArguments,
  toolChoiceToLanguageV2Format,
  toolToLanguageV2Tool,
} from '../src/aiSdk';
import { protocol, withTrace, UserError } from '@openai/agents';
import { ReadableStream } from 'node:stream/web';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { SerializedOutputType } from '@openai/agents';

function stubModel(
  partial: Partial<Pick<LanguageModelV2, 'doGenerate' | 'doStream'>>,
): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'stub',
    modelId: 'm',
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
            data: 'http://x/img',
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
        providerData: { p: 1 },
      },
    ]);
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
        providerData: { p: 1 },
      },
    ]);
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
    });
  });

  test('should store reasoning in response for non-streaming text output', async () => {
    const mockProviderResult = {
      content: [{ type: 'text', text: 'This is the final answer.' }],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      providerMetadata: { p: 1 },
      response: { id: 'fake-id-123' },
      finishReason: 'stop',
      warnings: [],
      reasoning: '<thinking>I am thinking about the answer.</thinking>',
    };

    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return mockProviderResult as any;
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

    expect(res.reasoning).toBeDefined();
    expect(res.reasoning).toBe(
      '<thinking>I am thinking about the answer.</thinking>',
    );
    expect(res.responseId).toBe('fake-id-123');
  });

  test('should store reasoning in final response_done event for streaming', async () => {
    async function* mockProviderStream() {
      yield {
        type: 'response-metadata',
        id: 'fake-stream-id-456',
      };

      yield {
        type: 'reasoning-delta',
        reasoningDelta: '<thinking>Step 1: I am thinking.',
      };

      yield {
        type: 'text-delta',
        delta: 'Here is the answer.',
      };

      yield {
        type: 'reasoning-delta',
        reasoningDelta: ' Step 2: More thinking.</thinking>',
      };

      yield {
        type: 'finish',
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      };
    }

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: mockProviderStream(),
          } as any;
        },
      }),
    );

    const stream = model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any);

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const finalEvent = events.find((e) => e.type === 'response_done') as
      | protocol.StreamEventResponseCompleted
      | undefined;

    expect(finalEvent).toBeDefined();

    expect(finalEvent!.response.reasoning).toBeDefined();
    expect(finalEvent!.response.reasoning).toBe(
      '<thinking>Step 1: I am thinking. Step 2: More thinking.</thinking>',
    );

    expect(finalEvent!.response.id).toBe('fake-stream-id-456');
    expect(finalEvent!.response.usage.totalTokens).toBe(15);

    const textOutput = finalEvent!.response.output.find(
      (o) => o.type === 'message' && o.content[0].type === 'output_text',
    ) as any;
    expect(textOutput.content[0].text).toBe('Here is the answer.');
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
      },
      {
        type: 'function_call',
        callId: 'c1',
        name: 'foo',
        arguments: '{"k":"v"}',
        status: 'completed',
      },
    ]);
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
});
