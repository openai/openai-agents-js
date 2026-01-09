import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setTracingDisabled } from '@openai/agents-core';
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
    choices: [{ index: 0, delta }],
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
});
