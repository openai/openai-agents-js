import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import {
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  type Span,
  type Trace,
  type TracingProcessor,
  type ModelRequest,
  type ModelResponse,
} from '@openai/agents-core';
import { OpenAITracingExporter } from '@openai/agents';
import { AiSdkModel } from '../../src/ai-sdk';
import { stubModel } from './fixtures';

class RecordingProcessor implements TracingProcessor {
  spans: Span<any>[] = [];
  async onTraceStart(_trace: Trace) {}
  async onTraceEnd(_trace: Trace) {}
  async onSpanStart(_span: Span<any>) {}
  async onSpanEnd(span: Span<any>) {
    this.spans.push(span);
  }
  async shutdown() {}
  async forceFlush() {}
}

beforeEach(() => {
  setTracingDisabled(false);
});
afterEach(() => {
  setTraceProcessors([]);
  setTracingDisabled(true);
  vi.unstubAllGlobals();
});

test.each([false, true])(
  'retains AI SDK reasoning for results and processors but omits it from OpenAI export (stream: %s)',
  async (stream) => {
    const processor = new RecordingProcessor();
    setTraceProcessors([processor]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              { type: 'reasoning', text: 'synthetic-output-thought' },
              { type: 'text', text: 'ordinary answer' },
            ],
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            finishReason: 'stop',
            warnings: [],
          };
        },
        async doStream() {
          return {
            stream: ReadableStream.from([
              { type: 'reasoning-start', id: 'r1' },
              {
                type: 'reasoning-delta',
                id: 'r1',
                delta: 'synthetic-output-thought',
              },
              { type: 'reasoning-end', id: 'r1' },
              { type: 'text-start', id: 'text1' },
              { type: 'text-delta', id: 'text1', delta: 'ordinary answer' },
              { type: 'text-end', id: 'text1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              },
            ]),
          } as any;
        },
      }),
    );
    const request: ModelRequest = {
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'synthetic-input-thought' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ordinary prior answer' }],
        },
      ],
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: 'text',
      tracing: true,
    };
    let output: ModelResponse['output'] | undefined;
    await withTrace('synthetic-ai-sdk', async () => {
      if (stream) {
        for await (const event of model.getStreamedResponse(request)) {
          if (event.type === 'response_done') output = event.response.output;
        }
      } else output = (await model.getResponse(request)).output;
    });
    const span = processor.spans.find(
      (item) => item.spanData.type === 'generation',
    )!;
    expect(span).toBeDefined();
    const before = structuredClone(span.toJSON());
    const originalOutput = structuredClone(output);
    expect(output?.map((item) => item.type)).toEqual(['reasoning', 'message']);
    expect(JSON.stringify(span.spanData.input)).toContain(
      'synthetic-input-thought',
    );
    expect(JSON.stringify(span.spanData.output)).toContain(
      'synthetic-output-thought',
    );
    await new OpenAITracingExporter({ apiKey: 'synthetic-key' }).export([span]);
    const body = fetchMock.mock.calls[0][1].body;
    expect(body).not.toContain('synthetic-input-thought');
    expect(body).not.toContain('synthetic-output-thought');
    const sent = JSON.parse(body).data[0].span_data;
    expect(sent.output.map((item: any) => item.type)).toEqual(['message']);
    expect(body).toContain('ordinary prior answer');
    expect(body).toContain('ordinary answer');
    expect(sent.usage).toMatchObject({ input_tokens: 2, output_tokens: 3 });
    expect(span.toJSON()).toEqual(before);
    expect(output).toEqual(originalOutput);
    await new OpenAITracingExporter({
      apiKey: 'synthetic-key',
      endpoint: 'https://example.test/ingest',
    }).export([span]);
    expect(fetchMock.mock.calls[1][1].body).toContain(
      'synthetic-input-thought',
    );
    expect(fetchMock.mock.calls[1][1].body).toContain(
      'synthetic-output-thought',
    );
  },
);
