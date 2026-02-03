import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setTracingDisabled, withTrace } from '@openai/agents-core';
import * as AgentsCore from '@openai/agents-core';
import {
  OpenAIChatCompletionsModel,
  FAKE_ID,
} from '../src/openaiChatCompletionsModel';
import { HEADERS } from '../src/defaults';

type ChunkDelta = {
  content?: string;
  refusal?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

function makeChunk(delta: ChunkDelta, usage?: any) {
  return {
    id: 'res-stream',
    created: 0,
    model: 'gpt-stream',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: null }],
    usage,
  } as any;
}

describe('OpenAIChatCompletionsModel streaming scenarios', () => {
  beforeEach(() => {
    setTracingDisabled(true);
  });

  it('streams mixed deltas into a combined response with usage', async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield makeChunk({ content: 'Hello ', reasoning: 'Step 1' });
        yield makeChunk({ refusal: 'No thanks' });
        yield makeChunk({
          content: 'world',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              function: { name: 'lookup', arguments: '{"zip":' },
            },
          ],
        });
        yield makeChunk(
          {
            reasoning: ' continued',
            tool_calls: [{ index: 0, function: { arguments: '"94107"}' } }],
          },
          {
            prompt_tokens: 9,
            completion_tokens: 13,
            total_tokens: 22,
            prompt_tokens_details: { cached_tokens: 4 },
            completion_tokens_details: { reasoning_tokens: 6 },
          },
        );
      },
    };

    const create = vi.fn().mockResolvedValue(stream);
    const client = {
      chat: { completions: { create } },
      baseURL: 'https://example',
    };

    const model = new OpenAIChatCompletionsModel(client as any, 'gpt-stream');
    const events: any[] = [];

    const request: any = {
      input: 'hi there',
      modelSettings: {
        reasoning: { effort: 'medium' },
        text: { verbosity: 'high' },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    for await (const event of model.getStreamedResponse(request)) {
      events.push(event);
    }

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-stream',
        stream: true,
        messages: [
          {
            role: 'user',
            content: 'hi there',
          },
        ],
        reasoning_effort: 'medium',
        verbosity: 'high',
      }),
      { headers: HEADERS, signal: undefined },
    );

    const finalEvent = events.find((ev) => ev.type === 'response_done');
    expect(finalEvent).toBeDefined();
    expect(finalEvent.response.output).toEqual([
      {
        type: 'reasoning',
        content: [],
        rawContent: [{ type: 'reasoning_text', text: 'Step 1 continued' }],
      },
      {
        id: FAKE_ID,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'Hello world',
            providerData: { annotations: [] },
          },
          { type: 'refusal', refusal: 'No thanks' },
        ],
      },
      {
        id: FAKE_ID,
        type: 'function_call',
        name: 'lookup',
        callId: 'call-1',
        arguments: '{"zip":"94107"}',
      },
    ]);
    expect(finalEvent.response.usage).toEqual({
      inputTokens: 9,
      outputTokens: 13,
      totalTokens: 22,
      inputTokensDetails: { cached_tokens: 4 },
      outputTokensDetails: { reasoning_tokens: 6 },
    });
  });

  it('stores a chat-completion shaped choice in generation spans for streaming traces', async () => {
    setTracingDisabled(false);
    const createGenerationSpanSpy = vi.spyOn(
      AgentsCore,
      'createGenerationSpan',
    );

    try {
      const stream = {
        async *[Symbol.asyncIterator]() {
          yield makeChunk({
            tool_calls: [
              {
                index: 0,
                id: 'call-weather',
                function: { name: 'weather', arguments: '{"city":' },
              },
              {
                index: 1,
                id: 'call-timezone',
                function: { name: 'timezone', arguments: '{"city":"Tokyo"}' },
              },
            ],
          });
          yield {
            ...makeChunk(
              {
                tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }],
              },
              {
                prompt_tokens: 3,
                completion_tokens: 6,
                total_tokens: 9,
              },
            ),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '"Tokyo"}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          } as any;
        },
      };

      const create = vi.fn().mockResolvedValue(stream);
      const client = {
        chat: { completions: { create } },
        baseURL: 'https://example',
      };

      const model = new OpenAIChatCompletionsModel(client as any, 'gpt-stream');
      const request: any = {
        input: 'find weather in Tokyo',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: true,
        signal: undefined,
      };

      await withTrace('stream-trace', async () => {
        for await (const _event of model.getStreamedResponse(request)) {
          // Drain.
        }
      });

      const generationSpan = createGenerationSpanSpy.mock.results
        .map((result) => result.value as { spanData?: Record<string, any> })
        .find((span) => span?.spanData?.type === 'generation');
      expect(generationSpan).toBeDefined();
      if (!generationSpan?.spanData) {
        throw new Error('Expected generation span data to exist');
      }

      const tracedOutput = generationSpan.spanData.output?.[0];
      expect(tracedOutput.choices).toEqual([
        {
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call-weather',
                type: 'function',
                function: {
                  name: 'weather',
                  arguments: '{"city":"Tokyo"}',
                },
              },
              {
                id: 'call-timezone',
                type: 'function',
                function: {
                  name: 'timezone',
                  arguments: '{"city":"Tokyo"}',
                },
              },
            ],
          },
        },
      ]);
      expect(tracedOutput.usage).toMatchObject({
        prompt_tokens: 3,
        completion_tokens: 6,
        total_tokens: 9,
      });
    } finally {
      createGenerationSpanSpy.mockRestore();
      setTracingDisabled(true);
    }
  });
});
