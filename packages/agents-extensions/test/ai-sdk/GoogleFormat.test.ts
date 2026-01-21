import { describe, test, expect } from 'vitest';
import { AiSdkModel } from '../../src/ai-sdk/index';
import { withTrace } from '@openai/agents';
import { ReadableStream } from 'node:stream/web';
import type { LanguageModelV2 } from '@ai-sdk/provider';

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

describe('AiSdkModel issue #802', () => {
  test('handles object usage in doGenerate (Google AI SDK compatibility)', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [{ type: 'text', text: 'ok' }],
            // Simulating Google AI SDK behavior where tokens are objects
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0 } as any,
              outputTokens: { total: 20 } as any,
              totalTokens: { total: 30 } as any,
            },
            providerMetadata: {},
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

    expect(res.usage).toEqual({
      requests: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      inputTokensDetails: [],
      outputTokensDetails: [],
      requestUsageEntries: undefined,
    });
  });

  test('handles object usage in doStream (Google AI SDK compatibility)', async () => {
    const parts = [
      { type: 'text-delta', delta: 'a' },
      {
        type: 'finish',
        finishReason: 'stop',
        // Simulating Google AI SDK behavior where tokens are objects
        usage: {
          inputTokens: { total: 5 } as any,
          outputTokens: { total: 8 } as any,
        },
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

    let finalUsage: any;
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      if (ev.type === 'response_done') {
        finalUsage = ev.response.usage;
      }
    }

    expect(finalUsage).toEqual({
      inputTokens: 5,
      outputTokens: 8,
      totalTokens: 13,
    });
  });

  test('preserves toolChoice and provider options through streaming tool calls', async () => {
    const parts = [
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'search',
        input: '{"q":"hello"}',
        providerMetadata: { google: { routing: 'edge' } },
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];

    const receivedOptions: any[] = [];
    const model = new AiSdkModel(
      stubModel({
        async doStream(options) {
          receivedOptions.push(options);
          return { stream: partsStream(parts) } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {
        toolChoice: 'search',
        providerData: { google: { routing: 'edge' } },
      },
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    expect(receivedOptions[0].toolChoice).toEqual({
      type: 'tool',
      toolName: 'search',
    });
    expect(receivedOptions[0].google).toEqual({ routing: 'edge' });

    const final = events.at(-1);
    expect(final.response.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'tool-1',
      name: 'search',
      providerData: {
        model: 'stub:m',
        google: { routing: 'edge' },
      },
    });
  });
});
