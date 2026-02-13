import { describe, test, expect } from 'vitest';
import { AiSdkModel } from '../../src/ai-sdk/index';
import {
  BatchTraceProcessor,
  ConsoleSpanExporter,
  setTraceProcessors,
  setTracingDisabled,
  Span,
  TracingProcessor,
  withTrace,
} from '@openai/agents';
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

class CollectingProcessor implements TracingProcessor {
  public spans: Span<any>[] = [];

  async onTraceStart(): Promise<void> {}

  async onTraceEnd(): Promise<void> {}

  async onSpanStart(): Promise<void> {}

  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spans.push(span);
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
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
      inputTokensDetails: [{ cached_tokens: 0 }],
      outputTokensDetails: [],
      requestUsageEntries: undefined,
    });
  });

  test('maps cacheRead/cacheWrite usage in generation spans (#945, #955)', async () => {
    const processor = new CollectingProcessor();
    setTracingDisabled(false);
    setTraceProcessors([processor]);

    try {
      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            return {
              content: [{ type: 'text', text: 'ok' }],
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 5,
                  cacheRead: 2,
                  cacheWrite: 3,
                } as any,
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
          tracing: true,
        } as any),
      );

      expect(res.usage.inputTokensDetails).toEqual([
        { cached_tokens: 2, cache_write_tokens: 3 },
      ]);

      const generationSpan = processor.spans.find(
        (span) => span.spanData.type === 'generation',
      );

      expect(generationSpan?.spanData?.usage).toEqual({
        input_tokens: 10,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
      });
    } finally {
      setTracingDisabled(true);
      setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);
    }
  });

  test('handles object usage in doStream (Google AI SDK compatibility)', async () => {
    const parts = [
      { type: 'text-delta', delta: 'a' },
      {
        type: 'finish',
        finishReason: 'stop',
        // Simulating Google AI SDK behavior where tokens are objects
        usage: {
          inputTokens: { total: 5, cacheRead: 1, cacheWrite: 2 } as any,
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
      inputTokensDetails: { cached_tokens: 1, cache_write_tokens: 2 },
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
