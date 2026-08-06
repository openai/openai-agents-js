import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Span,
  Trace,
  createTaskSpan,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  type ModelRequest,
  type TracingProcessor,
} from '@openai/agents-core';
import type OpenAI from 'openai';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';

class RecordingProcessor implements TracingProcessor {
  readonly spansEnded: Span<any>[] = [];

  async onTraceStart(_trace: Trace): Promise<void> {}
  async onTraceEnd(_trace: Trace): Promise<void> {}
  async onSpanStart(_span: Span<any>): Promise<void> {}
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function modelRequest(): ModelRequest {
  return {
    input: 'hello',
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: true,
  };
}

describe('model tracing parent', () => {
  afterEach(() => {
    setTracingDisabled(true);
    setTraceProcessors([]);
  });

  it('uses the explicit parent for Chat Completions generation spans', async () => {
    const processor = new RecordingProcessor();
    setTraceProcessors([processor]);
    setTracingDisabled(false);
    const nonStreamingResponse = {
      id: 'chat-response',
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    async function* streamingResponse() {
      yield {
        id: 'chat-stream-response',
        created: 1,
        model: 'gpt-test',
        object: 'chat.completion.chunk',
        choices: [
          { index: 0, delta: { content: 'done' }, finish_reason: null },
        ],
      };
      yield {
        id: 'chat-stream-response',
        created: 1,
        model: 'gpt-test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
    const create = vi
      .fn()
      .mockResolvedValueOnce(nonStreamingResponse)
      .mockResolvedValueOnce(streamingResponse());
    const client = {
      baseURL: 'https://example.test',
      chat: { completions: { create } },
    };
    const model = new OpenAIChatCompletionsModel(
      client as unknown as OpenAI,
      'gpt-test',
    );

    await withTrace('chat parent', async (trace) => {
      const parent = createTaskSpan({ data: { name: 'chat task' } }, trace);
      parent.start();
      const request: any = modelRequest();
      request._internal = { tracingParent: parent };
      await model.getResponse(request);
      for await (const _event of model.getStreamedResponse(request)) {
        // Consume the stream.
      }
      parent.end();
    });

    const generationSpans = processor.spansEnded.filter(
      (span) => span.spanData.type === 'generation',
    );
    const parent = processor.spansEnded.find(
      (span) => span.spanData.type === 'task',
    );
    expect(generationSpans).toHaveLength(2);
    expect(generationSpans.map((span) => span.parentId)).toEqual([
      parent?.spanId,
      parent?.spanId,
    ]);
  });

  it('uses the explicit parent for Responses spans', async () => {
    const processor = new RecordingProcessor();
    setTraceProcessors([processor]);
    setTracingDisabled(false);
    const response = {
      id: 'response-id',
      object: 'response',
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    async function* streamingResponse() {
      yield { type: 'response.created', response };
      yield { type: 'response.completed', response };
    }
    const create = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(streamingResponse());
    const client = { responses: { create } } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(client, 'gpt-test');

    await withTrace('responses parent', async (trace) => {
      const parent = createTaskSpan(
        { data: { name: 'responses task' } },
        trace,
      );
      parent.start();
      const request: any = modelRequest();
      request._internal = { tracingParent: parent };
      await model.getResponse(request);
      for await (const _event of model.getStreamedResponse(request)) {
        // Consume the stream.
      }
      parent.end();
    });

    const responseSpans = processor.spansEnded.filter(
      (span) => span.spanData.type === 'response',
    );
    const parent = processor.spansEnded.find(
      (span) => span.spanData.type === 'task',
    );
    expect(responseSpans).toHaveLength(2);
    expect(responseSpans.map((span) => span.parentId)).toEqual([
      parent?.spanId,
      parent?.spanId,
    ]);
  });
});
