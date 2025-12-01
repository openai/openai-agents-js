import { describe, it, expect } from 'vitest';
import { convertChatCompletionsStreamToResponses } from '../src/openaiChatCompletionsStreaming';
import { FAKE_ID } from '../src/openaiChatCompletionsModel';
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat';

function makeChunk(delta: any, usage?: any) {
  return {
    id: 'c',
    created: 0,
    model: 'm',
    object: 'chat.completion.chunk',
    choices: [{ delta }],
    usage,
  } as any;
}

describe('convertChatCompletionsStreamToResponses', () => {
  it('emits protocol events for streamed chat completions', async () => {
    const response: ChatCompletion = {
      id: 'res1',
      created: 0,
      model: 'gpt-test',
      object: 'chat.completion',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;

    const chunk1: ChatCompletionChunk = {
      id: 'res1',
      created: 1,
      model: 'gpt-test',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: { content: 'hello' },
        },
      ],
    } as any;

    const chunk2: ChatCompletionChunk = {
      id: 'res1',
      created: 2,
      model: 'gpt-test',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: { refusal: 'nope' },
        },
      ],
    } as any;

    const chunk3: ChatCompletionChunk = {
      id: 'res1',
      created: 3,
      model: 'gpt-test',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call1',
                function: { name: 'fn', arguments: '{}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    } as any;

    async function* fakeStream() {
      yield chunk1;
      yield chunk2;
      yield chunk3;
    }

    const events = [] as any[];
    for await (const ev of convertChatCompletionsStreamToResponses(
      response,
      fakeStream() as any,
    )) {
      events.push(ev);
    }

    expect(events[0]).toEqual({
      type: 'response_started',
      providerData: { ...chunk1 },
    });
    expect(events[1]).toEqual({ type: 'model', event: chunk1 });
    expect(events[2]).toEqual({
      type: 'output_text_delta',
      delta: 'hello',
      providerData: { ...chunk1 },
    });
    expect(events[3]).toEqual({ type: 'model', event: chunk2 });
    expect(events[4]).toEqual({ type: 'model', event: chunk3 });

    expect(events[5]).toEqual({
      type: 'response_done',
      response: {
        id: 'res1',
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          inputTokensDetails: { cached_tokens: 0 },
          outputTokensDetails: { reasoning_tokens: 0 },
        },
        output: [
          {
            id: FAKE_ID,
            role: 'assistant',
            type: 'message',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'hello',
                providerData: { annotations: [] },
              },
              { type: 'refusal', refusal: 'nope' },
            ],
          },
          {
            id: FAKE_ID,
            type: 'function_call',
            arguments: '{}',
            name: 'fn',
            callId: 'call1',
          },
        ],
      },
    });
  });
});

describe('convertChatCompletionsStreamToResponses', () => {
  it('converts chunks to protocol events', async () => {
    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      yield makeChunk({ content: 'he' });
      yield makeChunk(
        { content: 'llo' },
        { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      );
      yield makeChunk({
        tool_calls: [
          { index: 0, id: 'call', function: { name: 'fn', arguments: 'a' } },
        ],
      });
    }

    const resp = { id: 'r' } as any;
    const events: any[] = [];
    for await (const e of convertChatCompletionsStreamToResponses(
      resp,
      stream() as any,
    )) {
      events.push(e);
    }

    expect(events[0]).toEqual({
      type: 'response_started',
      providerData: makeChunk({ content: 'he' }),
    });
    // last event should be final response
    const final = events[events.length - 1];
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([
      {
        id: FAKE_ID,
        content: [
          {
            text: 'hello',
            type: 'output_text',
            providerData: { annotations: [] },
          },
        ],
        role: 'assistant',
        type: 'message',
        status: 'completed',
      },
      {
        id: FAKE_ID,
        type: 'function_call',
        name: 'fn',
        callId: 'call',
        arguments: 'a',
      },
    ]);
    expect(final.response.usage.totalTokens).toBe(0);
  });

  it('ignores chunks with empty choices', async () => {
    const emptyChunk: ChatCompletionChunk = {
      id: 'e',
      created: 0,
      model: 'm',
      object: 'chat.completion.chunk',
      choices: [],
    } as any;

    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      yield emptyChunk;
      yield makeChunk({ content: 'hi' });
    }

    const resp = { id: 'r' } as any;
    const events: any[] = [];
    for await (const e of convertChatCompletionsStreamToResponses(
      resp,
      stream() as any,
    )) {
      events.push(e);
    }

    const deltas = events.filter((ev) => ev.type === 'output_text_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe('hi');
  });

  it('accumulates reasoning deltas into a reasoning item', async () => {
    const resp: ChatCompletion = {
      id: 'r1',
      created: 0,
      model: 'gpt-test',
      object: 'chat.completion',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;

    async function* stream() {
      yield makeChunk({ reasoning: 'foo' });
      yield makeChunk({ reasoning: 'bar' });
    }

    const events: any[] = [];
    for await (const e of convertChatCompletionsStreamToResponses(
      resp,
      stream() as any,
    )) {
      events.push(e);
    }

    const final = events[events.length - 1];
    expect(final.type).toBe('response_done');
    expect(final.response.output[0]).toEqual({
      type: 'reasoning',
      content: [],
      rawContent: [{ type: 'reasoning_text', text: 'foobar' }],
    });
  });

  it('strips leading {} from tool call arguments when followed by real args', async () => {
    const resp = { id: 'r' } as any;

    async function* stream() {
      yield makeChunk({
        tool_calls: [
          { index: 0, id: 'call1', function: { name: 'fn', arguments: '{}' } },
        ],
      });
      yield makeChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"key":"value"}' } }],
      });
    }

    const events: any[] = [];
    for await (const e of convertChatCompletionsStreamToResponses(
      resp,
      stream() as any,
    )) {
      events.push(e);
    }

    const final = events[events.length - 1];
    const functionCall = final.response.output.find(
      (o: any) => o.type === 'function_call',
    );
    expect(functionCall.arguments).toBe('{"key":"value"}');
  });

  it('preserves {} for legitimate empty tool call arguments', async () => {
    const resp = { id: 'r' } as any;

    async function* stream() {
      yield makeChunk({
        tool_calls: [
          { index: 0, id: 'call1', function: { name: 'fn', arguments: '{}' } },
        ],
      });
    }

    const events: any[] = [];
    for await (const e of convertChatCompletionsStreamToResponses(
      resp,
      stream() as any,
    )) {
      events.push(e);
    }

    const final = events[events.length - 1];
    const functionCall = final.response.output.find(
      (o: any) => o.type === 'function_call',
    );
    expect(functionCall.arguments).toBe('{}');
  });
});
