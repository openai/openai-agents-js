import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BatchTraceProcessor,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  type ModelRequest,
  type Span,
} from '@openai/agents-core';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import { OpenAITracingExporter } from '../src/openaiTracingExporter';

// Measure actual serialization work rather than relying on machine timing.
function measureSerialization() {
  const stringify = JSON.stringify;
  let bytes = 0;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
    const result = stringify(...args);
    bytes += result === undefined ? 0 : new TextEncoder().encode(result).length;
    return result;
  });
  return () => {
    spy.mockRestore();
    return bytes;
  };
}

afterEach(() => {
  setTraceProcessors([]);
  setTracingDisabled(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('trace truncation work', () => {
  it.each(['success', 'rejection', 'stream rejection'] as const)(
    'bounds export of wide user content after model %s',
    async (mode) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const exporter = new OpenAITracingExporter({ apiKey: 'test-key' });
      const exportSpy = vi.spyOn(exporter, 'export');
      const processor = new BatchTraceProcessor(exporter, {
        scheduleDelay: 60_000,
      });
      setTraceProcessors([processor]);
      setTracingDisabled(false);
      const create = vi.fn();
      if (mode === 'success') {
        create.mockResolvedValue({
          id: 'test-completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      } else {
        create.mockRejectedValue(new Error('synthetic provider rejection'));
      }
      const model = new OpenAIChatCompletionsModel(
        {
          chat: { completions: { create } },
          baseURL: 'https://example.com',
        } as any,
        'test-model',
      );
      const content = Array.from({ length: 8_000 }, () => ({
        type: 'input_text' as const,
        text: 'a',
      }));
      const request: ModelRequest = {
        input: [{ role: 'user', content }],
        modelSettings: {},
        tools: [],
        handoffs: [],
        outputType: 'text',
        tracing: true,
      };
      try {
        const call = withTrace('wide-input-test', async () => {
          if (mode === 'stream rejection') {
            for await (const event of model.getStreamedResponse(request)) {
              void event;
            }
          } else {
            await model.getResponse(request);
          }
        });
        if (mode === 'success') await call;
        else await expect(call).rejects.toThrow('synthetic provider rejection');

        const finishMeasurement = measureSerialization();
        await processor.forceFlush();
        const bytes = finishMeasurement();
        // A fixed ceiling includes initial sizing, the budget's last traversal,
        // and the final small payload. The old loop processes gigabytes here.
        expect(bytes).toBeLessThan(10_000_000);
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        const generation = sent.data.find(
          (item: any) => item.span_data?.type === 'generation',
        );
        expect(generation.span_data.input).toEqual({
          truncated: true,
          original_type: 'Array',
          preview: '<Array len=1 truncated>',
        });
        const source = exportSpy.mock.calls[0][0].find(
          (item) => 'spanData' in item && item.spanData.type === 'generation',
        ) as Span<any>;
        expect(source.spanData.input[0].content).toHaveLength(8_000);
        expect(create.mock.calls[0][0].messages[0].content).toHaveLength(8_000);
        expect(content).toHaveLength(8_000);
      } finally {
        await processor.shutdown();
      }
    },
  );

  it.each(['input', 'output'] as const)(
    'bounds a wide mapping in %s',
    async (field) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const exporter = new OpenAITracingExporter({
        apiKey: 'test-key',
        endpoint: 'https://example.com/ingest',
      });
      const value = Object.fromEntries(
        Array.from({ length: 8_000 }, (_, i) => [`key-${i}`, 'abcdefghij']),
      );
      const item = {
        toJSON: () => ({
          object: 'trace.span',
          span_data: { type: 'generation', [field]: value },
        }),
      } as any;
      const finishMeasurement = measureSerialization();
      await exporter.export([item]);
      expect(finishMeasurement()).toBeLessThan(10_000_000);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body).data[0]
        .span_data[field];
      expect(sent).toEqual({
        truncated: true,
        original_type: 'Object',
        preview: '<Object len=8000 truncated>',
      });
      expect(Object.keys(value)).toHaveLength(8_000);
    },
  );
});
