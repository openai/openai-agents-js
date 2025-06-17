import { describe, test, expect, vi } from 'vitest';
import {
  AiSdkModel,
  getResponseFormat,
  itemsToLanguageV1Messages,
  toolToLanguageV1Tool,
} from '../src/aiSdk';
import { protocol, withTrace, UserError } from '@openai/agents';
import { ReadableStream } from 'node:stream/web';
import type { LanguageModelV1 } from '@ai-sdk/provider';
import type { SerializedOutputType } from '@openai/agents';

function stubModel(
  partial: Partial<Pick<LanguageModelV1, 'doGenerate' | 'doStream'>>,
): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    provider: 'stub',
    modelId: 'm',
    defaultObjectGenerationMode: undefined,
    async doGenerate(options) {
      if (partial.doGenerate) {
        return partial.doGenerate(options) as any;
      }
      return {
        text: '',
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        rawCall: { rawPrompt: '', rawSettings: {} },
      } as any;
    },
    async doStream(options) {
      if (partial.doStream) {
        return partial.doStream(options);
      }
      return {
        stream: new ReadableStream(),
        rawCall: { rawPrompt: '', rawSettings: {} },
      };
    },
  } as LanguageModelV1;
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

describe('itemsToLanguageV1Messages', () => {
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
        output: { type: 'output_text', text: 'out' },
        providerData: { b: 2 },
      } as any,
    ];

    const msgs = itemsToLanguageV1Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hi',
            providerMetadata: { test: { cacheControl: { type: 'ephemeral' } } },
          },
        ],
        providerMetadata: {},
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'foo',
            args: {},
            providerMetadata: { a: 1 },
          },
        ],
        providerMetadata: { a: 1 },
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'foo',
            result: { type: 'output_text', text: 'out' },
            providerMetadata: { b: 2 },
          },
        ],
        providerMetadata: { b: 2 },
      },
    ]);
  });

  test('throws on built-in tool calls', () => {
    const items: protocol.ModelItem[] = [
      { type: 'hosted_tool_call', name: 'search' } as any,
    ];
    expect(() => itemsToLanguageV1Messages(stubModel({}), items)).toThrow();
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
        output: { type: 'output_text', text: 'out' },
      } as any,
      { type: 'reasoning', content: [{ text: 'why' }] } as any,
    ];
    const msgs = itemsToLanguageV1Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi', providerMetadata: {} },
          {
            type: 'image',
            image: new URL('http://x/img'),
            providerMetadata: {},
          },
        ],
        providerMetadata: {},
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'do',
            args: {},
            providerMetadata: {},
          },
        ],
        providerMetadata: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'do',
            result: { type: 'output_text', text: 'out' },
            providerMetadata: {},
          },
        ],
        providerMetadata: {},
      },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'why', providerMetadata: {} }],
        providerMetadata: {},
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
    expect(() => itemsToLanguageV1Messages(stubModel({}), items)).not.toThrow();
    const msgs = itemsToLanguageV1Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', providerMetadata: {} }],
        providerMetadata: {},
      },
    ]);
  });

  test('throws UserError for unsupported content or unknown item type', () => {
    const bad: protocol.ModelItem[] = [
      { role: 'user', content: [{ type: 'bad' as any }] } as any,
    ];
    expect(() => itemsToLanguageV1Messages(stubModel({}), bad)).toThrow(
      UserError,
    );

    const unknown: protocol.ModelItem[] = [{ type: 'bogus' } as any];
    expect(() => itemsToLanguageV1Messages(stubModel({}), unknown)).toThrow(
      UserError,
    );
  });
});

describe('toolToLanguageV1Tool', () => {
  const model = stubModel({});
  test('maps function tools', () => {
    const tool = {
      type: 'function',
      name: 'foo',
      description: 'd',
      parameters: {} as any,
    } as any;
    expect(toolToLanguageV1Tool(model, tool)).toEqual({
      type: 'function',
      name: 'foo',
      description: 'd',
      parameters: {},
    });
  });

  test('maps builtin tools', () => {
    const tool = {
      type: 'hosted_tool',
      name: 'search',
      providerData: { args: { q: 1 } },
    } as any;
    expect(toolToLanguageV1Tool(model, tool)).toEqual({
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
    expect(toolToLanguageV1Tool(model, tool)).toEqual({
      type: 'provider-defined',
      id: `${model.provider}.comp`,
      name: 'comp',
      args: { environment: 'env', display_width: 2, display_height: 3 },
    });
  });

  test('throws on unknown type', () => {
    const tool = { type: 'x', name: 'u' } as any;
    expect(() => toolToLanguageV1Tool(model, tool)).toThrow();
  });
});

describe('AiSdkModel.getResponse', () => {
  test('handles text output', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            text: 'ok',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 2 },
            providerMetadata: { p: 1 },
            rawCall: { rawPrompt: '', rawSettings: {} },
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

  test('aborts when signal already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const doGenerate = vi.fn(async (opts: any) => {
      if (opts.abortSignal?.aborted) {
        throw new Error('aborted');
      }
      return {
        text: 'should not',
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        rawCall: { rawPrompt: '', rawSettings: {} },
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
            toolCalls: [
              {
                toolCallType: 'function',
                toolCallId: 'c1',
                toolName: 'foo',
                args: {} as any,
              },
            ],
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 2 },
            providerMetadata: { p: 1 },
            rawCall: { rawPrompt: '', rawSettings: {} },
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
        arguments: {},
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
            text: '',
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
            providerMetadata: {},
            rawCall: { rawPrompt: '', rawSettings: {} },
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
            text: '',
            finishReason: 'stop',
            usage: { promptTokens: Number.NaN, completionTokens: Number.NaN },
            providerMetadata: {},
            rawCall: { rawPrompt: '', rawSettings: {} },
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
});

describe('AiSdkModel.getStreamedResponse', () => {
  test('streams events and completes', async () => {
    const parts = [
      { type: 'text-delta', textDelta: 'a' },
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'c1',
        toolName: 'foo',
        args: '{"k":',
      },
      {
        type: 'tool-call-delta',
        toolCallType: 'function',
        toolCallId: 'c1',
        toolName: '',
        argsTextDelta: '"v"}',
      },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 2 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
            rawCall: { rawPrompt: '', rawSettings: {} },
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
            rawCall: { rawPrompt: '', rawSettings: {} },
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
        rawCall: { rawPrompt: '', rawSettings: {} },
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
            rawCall: { rawPrompt: '', rawSettings: {} },
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
      { type: 'text-delta', textDelta: 'a' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: Number.NaN, completionTokens: Number.NaN },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
            rawCall: { rawPrompt: '', rawSettings: {} },
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
});

describe('AiSdkModel', () => {
  test('should be available', () => {
    const model = new AiSdkModel({} as any);
    expect(model).toBeDefined();
  });

  test('converts trailing function_call items to messages', async () => {
    let received: any;
    const fakeModel = {
      specificationVersion: 'v1',
      provider: 'fake',
      modelId: 'm',
      defaultObjectGenerationMode: undefined,
      doGenerate: vi.fn(async (opts: any) => {
        received = opts.prompt;
        return {
          text: 'ok',
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
          providerMetadata: {},
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
            args: {},

            providerMetadata: { meta: 1 },
          },
        ],
        providerMetadata: { meta: 1 },
      },
    ]);
  });
});
