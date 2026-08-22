import { describe, it, expect, vi } from 'vitest';
import { ModelBehaviorError, UserError } from '@openai/agents-core';
import { convertChatCompletionsStreamToResponses } from '../src/openaiChatCompletionsStreaming';
import { FAKE_ID } from '../src/openaiChatCompletionsModel';
import logger from '../src/logger';
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
    choices: [{ index: 0, delta }],
    usage,
  } as any;
}

function urlCitation(
  url = 'https://example.com/weather',
  title = 'Weather',
  startIndex = 0,
  endIndex = 7,
) {
  return {
    type: 'url_citation',
    url_citation: {
      start_index: startIndex,
      end_index: endIndex,
      url,
      title,
    },
  };
}

describe('convertChatCompletionsStreamToResponses', () => {
  it('surfaces an empty content-filter terminal as a refusal', async () => {
    const response: ChatCompletion = {
      id: 'filtered-response',
      created: 0,
      model: 'gpt-test',
      object: 'chat.completion',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;

    async function* stream() {
      yield {
        id: 'filtered-response',
        created: 0,
        model: 'gpt-test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
      } as any;
    }

    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: 'response_done',
      response: {
        output: [
          {
            id: 'filtered-response',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'refusal',
                refusal: "Response withheld by the provider's content filter.",
              },
            ],
          },
        ],
      },
    });
    expect(response.choices).toEqual([
      {
        index: 0,
        finish_reason: 'content_filter',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: "Response withheld by the provider's content filter.",
        },
      },
    ]);
  });

  it('rejects an annotation-only truncated stream after emitting raw events', async () => {
    const response = {
      id: 'truncated-response',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    const usage = {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      completion_tokens_details: { reasoning_tokens: 6 },
    };
    const annotationChunk = makeChunk({ annotations: [urlCitation()] }, usage);
    const terminalChunk = {
      ...makeChunk({}),
      choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
    } as any;

    async function* stream() {
      yield annotationChunk;
      yield terminalChunk;
    }

    const events: any[] = [];
    let caught: unknown;
    try {
      for await (const event of convertChatCompletionsStreamToResponses(
        response,
        stream() as any,
        { preserveRawUsage: true },
      )) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelBehaviorError);
    expect((caught as Error).message).toContain("finish_reason='length'");
    expect(events.filter((event) => event.type === 'model')).toEqual([
      expect.objectContaining({ event: annotationChunk }),
      expect.objectContaining({ event: terminalChunk }),
    ]);
    expect(events.some((event) => event.type === 'response_done')).toBe(false);
    expect(response.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 6 },
    });
  });

  it('preserves a late iterator error after an empty length terminal chunk', async () => {
    const response = {
      id: 'truncated-response',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;
    const usageChunk = makeChunk(
      {},
      {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    );
    const terminalChunk = {
      ...makeChunk({}),
      choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
    } as any;
    const transportError = new Error('stream connection failed');

    async function* stream() {
      yield usageChunk;
      yield terminalChunk;
      throw transportError;
    }

    const events: any[] = [];
    let caught: unknown;
    try {
      for await (const event of convertChatCompletionsStreamToResponses(
        response,
        stream() as any,
        { preserveRawUsage: true },
      )) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(transportError);
    expect(events.filter((event) => event.type === 'model')).toEqual([
      expect.objectContaining({ event: usageChunk }),
      expect.objectContaining({ event: terminalChunk }),
    ]);
    expect(events.some((event) => event.type === 'response_done')).toBe(false);
    expect(response).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  it.each([
    ['whitespace text', { content: ' ' }],
    ['refusal', { refusal: 'provider refusal' }],
    ['audio', { audio: { id: 'audio-1', data: 'abc' } }],
    ['reasoning', { reasoning: 'partial reasoning' }],
    [
      'function call',
      {
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
    ],
  ])('preserves a truncated stream containing %s', async (_label, delta) => {
    const response = { id: 'partial-response' } as any;
    const usage = {
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    };

    async function* stream() {
      yield makeChunk(delta, usage);
      yield {
        ...makeChunk({}),
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      } as any;
    }

    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
      { preserveRawUsage: true },
    )) {
      events.push(event);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toHaveLength(1);
    expect(final.response.rawUsage).toEqual(usage);
  });

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
    expect(events[1]).toEqual({
      type: 'model',
      event: chunk1,
      providerData: { rawModelEventSource: 'openai-chat-completions' },
    });
    expect(events[2]).toEqual({
      type: 'output_text_delta',
      delta: 'hello',
      itemId: 'res1',
      providerData: { ...chunk1 },
    });
    expect(events[3]).toEqual({
      type: 'model',
      event: chunk2,
      providerData: { rawModelEventSource: 'openai-chat-completions' },
    });
    expect(events[4]).toEqual({
      type: 'model',
      event: chunk3,
      providerData: { rawModelEventSource: 'openai-chat-completions' },
    });

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
            id: 'res1',
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
            id: 'res1',
            type: 'function_call',
            arguments: '{}',
            name: 'fn',
            callId: 'call1',
          },
        ],
      },
    });

    expect(response.choices).toEqual([
      {
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: 'hello',
          refusal: 'nope',
          tool_calls: [
            {
              id: 'call1',
              type: 'function',
              function: { name: 'fn', arguments: '{}' },
            },
          ],
        },
      },
    ]);
    expect(response.usage).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
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
        id: 'r',
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
        id: 'r',
        type: 'function_call',
        name: 'fn',
        callId: 'call',
        arguments: 'a',
      },
    ]);
    // The usage reported on the middle chunk must be retained even though the
    // trailing tool_calls chunk carries no usage of its own.
    expect(final.response.usage.totalTokens).toBe(3);
  });

  it('accumulates streamed audio into the final assistant message', async () => {
    const chunks = [
      makeChunk({ audio: { transcript: 'hel' } }),
      makeChunk({
        role: 'assistant',
        content: null,
        refusal: null,
        audio: { id: 'audio-test', data: 'abc' },
      }),
      makeChunk({
        audio: { data: 'def', transcript: 'lo', format: 'pcm16' },
      }),
      makeChunk({ audio: { expires_at: 2 } }),
    ];

    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    const response = { id: 'r' } as ChatCompletion;
    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === 'model')).toHaveLength(4);
    expect(
      events.filter((event) => event.type === 'output_text_delta'),
    ).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'response_done',
      response: {
        output: [
          {
            id: 'r',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'audio',
                audio: 'abcdef',
                providerData: {
                  id: 'audio-test',
                  transcript: 'hello',
                  format: 'pcm16',
                  expires_at: 2,
                },
              },
            ],
          },
        ],
      },
    });
    expect(response.choices).toEqual([
      {
        index: 0,
        logprobs: null,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          audio: {
            id: 'audio-test',
            data: 'abcdef',
            transcript: 'hello',
            format: 'pcm16',
            expires_at: 2,
          },
        },
      },
    ]);
  });

  it('isolates audio snapshots from mutable stream events', async () => {
    async function* stream() {
      yield makeChunk({
        audio: {
          id: 'audio-snapshot',
          data: 'ORIGINAL',
          transcript: 'original',
          details: { format: 'pcm16' },
        },
      });
    }

    const response = { id: 'r' } as ChatCompletion;
    const iterator = convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )[Symbol.asyncIterator]();

    const started = await iterator.next();
    const startedAudio = (started.value as any).providerData.choices[0].delta
      .audio;
    startedAudio.data = 'MUTATED_STARTED';
    startedAudio.transcript = 'mutated started';
    startedAudio.details.format = 'mutated-started';

    const raw = await iterator.next();
    const rawAudio = (raw.value as any).event.choices[0].delta.audio;
    rawAudio.data = 'MUTATED_RAW';
    rawAudio.transcript = 'mutated raw';
    rawAudio.details.format = 'mutated-raw';

    const completed = await iterator.next();
    expect(completed.done).toBe(false);
    expect((completed.value as any).response.output[0].content).toEqual([
      {
        type: 'audio',
        audio: 'ORIGINAL',
        providerData: {
          id: 'audio-snapshot',
          transcript: 'original',
          details: { format: 'pcm16' },
        },
      },
    ]);
    (
      completed.value as any
    ).response.output[0].content[0].providerData.details.format =
      'mutated-completed';

    expect((await iterator.next()).done).toBe(true);
    expect(response.choices[0].message.audio).toEqual({
      id: 'audio-snapshot',
      data: 'ORIGINAL',
      transcript: 'original',
      details: { format: 'pcm16' },
    });
  });

  it('preserves audio from a content-filtered stream', async () => {
    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      yield {
        ...makeChunk({
          audio: {
            id: 'audio-filtered',
            data: 'AAA=',
            transcript: 'hello',
            expires_at: 2,
          },
        }),
        choices: [
          {
            index: 0,
            delta: {
              audio: {
                id: 'audio-filtered',
                data: 'AAA=',
                transcript: 'hello',
                expires_at: 2,
              },
            },
            finish_reason: 'content_filter',
          },
        ],
      } as any;
    }

    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      { id: 'r' } as ChatCompletion,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events.at(-1).response.output).toEqual([
      {
        id: 'r',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'audio',
            audio: 'AAA=',
            providerData: {
              id: 'audio-filtered',
              transcript: 'hello',
              expires_at: 2,
            },
          },
        ],
      },
    ]);
  });

  it('ignores nullable streamed audio fragments', async () => {
    async function* stream() {
      yield makeChunk({ audio: null });
      yield makeChunk({
        audio: {
          id: 'audio-nullable',
          data: 'abc',
          transcript: 'hel',
        },
      });
      yield makeChunk({
        audio: {
          data: null,
          transcript: null,
          expires_at: 2,
        },
      });
      yield makeChunk({
        audio: {
          data: 'def',
          transcript: 'lo',
        },
      });
    }

    const response = { id: 'r' } as ChatCompletion;
    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === 'model')).toHaveLength(4);
    expect(events.at(-1).response.output[0].content).toEqual([
      {
        type: 'audio',
        audio: 'abcdef',
        providerData: {
          id: 'audio-nullable',
          transcript: 'hello',
          expires_at: 2,
        },
      },
    ]);
    expect(response.choices[0].message.audio).toEqual({
      id: 'audio-nullable',
      data: 'abcdef',
      transcript: 'hello',
      expires_at: 2,
    });
  });

  it('rejects audio streams that end without audio data', async () => {
    async function* stream() {
      yield makeChunk({
        audio: { id: 'audio-incomplete', transcript: 'hello' },
      });
    }

    await expect(async () => {
      for await (const _event of convertChatCompletionsStreamToResponses(
        { id: 'r' } as ChatCompletion,
        stream() as any,
      )) {
        // Consume the stream.
      }
    }).rejects.toThrow(
      'Chat Completions stream ended with audio output but no audio data.',
    );
  });

  it('rejects malformed audio deltas', async () => {
    async function* stream() {
      yield makeChunk({ audio: 'invalid' });
    }

    await expect(async () => {
      for await (const _event of convertChatCompletionsStreamToResponses(
        { id: 'r' } as ChatCompletion,
        stream() as any,
      )) {
        // Consume the stream.
      }
    }).rejects.toThrow(
      'Chat Completions stream returned malformed audio output: expected delta.audio to be an object.',
    );
  });

  it.each([
    {
      name: 'numeric data',
      audio: { data: 42 },
      message:
        'Chat Completions stream returned malformed audio output: expected delta.audio.data to be a string.',
    },
    {
      name: 'numeric transcript',
      audio: { transcript: 42 },
      message:
        'Chat Completions stream returned malformed audio output: expected delta.audio.transcript to be a string.',
    },
  ])('rejects malformed audio fields: $name', async ({ audio, message }) => {
    async function* stream() {
      yield makeChunk({ audio });
    }

    await expect(async () => {
      for await (const _event of convertChatCompletionsStreamToResponses(
        { id: 'r' } as ChatCompletion,
        stream() as any,
      )) {
        // Consume the stream.
      }
    }).rejects.toThrow(message);
  });

  it('does not accept inherited audio data from provider metadata', async () => {
    const audio = JSON.parse(
      '{"__proto__":{"data":"forged"},"id":"audio-incomplete"}',
    );

    async function* stream() {
      yield makeChunk({ audio });
    }

    await expect(async () => {
      for await (const _event of convertChatCompletionsStreamToResponses(
        { id: 'r' } as ChatCompletion,
        stream() as any,
      )) {
        // Consume the stream.
      }
    }).rejects.toThrow(
      'Chat Completions stream ended with audio output but no audio data.',
    );
  });

  it('rejects non-cloneable audio metadata before emitting events', async () => {
    async function* stream() {
      yield makeChunk({
        audio: {
          data: 'AAA=',
          unsupported: () => 'not cloneable',
        },
      });
    }

    const iterator = convertChatCompletionsStreamToResponses(
      { id: 'r' } as ChatCompletion,
      stream() as any,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(
      'Chat Completions stream returned malformed audio output: expected delta.audio to be cloneable.',
    );
  });

  it('uses text output precedence while retaining streamed audio for tracing', async () => {
    async function* stream() {
      yield makeChunk({
        content: 'hello',
        audio: {
          id: 'audio-mixed',
          data: 'AAA=',
          transcript: 'hello',
        },
      });
    }

    const response = { id: 'r' } as ChatCompletion;
    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events.at(-1).response.output).toEqual([
      {
        id: 'r',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'hello',
            providerData: { annotations: [] },
          },
        ],
      },
    ]);
    expect(response.choices[0].message.audio).toEqual({
      id: 'audio-mixed',
      data: 'AAA=',
      transcript: 'hello',
    });
  });

  it('preserves URL citations from text and annotation-only deltas once', async () => {
    const weatherCitation = urlCitation();
    const forecastCitation = urlCitation(
      'https://example.com/forecast',
      'Forecast',
      8,
      16,
    );

    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      yield makeChunk({
        content: 'Weather',
        annotations: [weatherCitation],
      });
      yield makeChunk({
        annotations: [weatherCitation, forecastCitation],
      });
      yield makeChunk({
        content: ' forecast',
        annotations: [forecastCitation],
      });
    }

    const response = { id: 'r' } as ChatCompletion;
    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === 'output_text_delta')
        .map((event) => event.delta),
    ).toEqual(['Weather', ' forecast']);
    expect(events.at(-1).response.output[0].content[0]).toEqual({
      type: 'output_text',
      text: 'Weather forecast',
      providerData: {
        annotations: [weatherCitation, forecastCitation],
      },
    });
    expect(response.choices[0].message.annotations).toEqual([
      weatherCitation,
      forecastCitation,
    ]);
  });

  it('ignores malformed and unsupported streamed annotations', async () => {
    const validCitation = urlCitation();

    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      yield makeChunk({
        content: 'Weather',
        annotations: [
          null,
          { type: 'file_citation', file_citation: { file_id: 'file-1' } },
          {
            type: 'url_citation',
            url_citation: { url: 'https://example.com/incomplete' },
          },
          {
            type: 'url_citation',
            url_citation: {
              start_index: '0',
              end_index: 7,
              url: 'https://example.com/wrong-index',
              title: 'Wrong index',
            },
          },
          validCitation,
        ],
      });
      yield makeChunk({ annotations: 5 });
    }

    const response = { id: 'r' } as ChatCompletion;
    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events.at(-1).response.output[0].content[0].providerData).toEqual({
      annotations: [validCitation],
    });
    expect(response.choices[0].message.annotations).toEqual([validCitation]);
  });

  it('ignores URL citations received before text begins', async () => {
    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      yield makeChunk({ annotations: [urlCitation()] });
      yield makeChunk({ content: 'Weather' });
    }

    const response = { id: 'r' } as ChatCompletion;
    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events.at(-1).response.output[0].content[0].providerData).toEqual({
      annotations: [],
    });
    expect(response.choices[0].message.annotations).toBeUndefined();
  });

  it('uses a response ID received after the first text chunk for the final message', async () => {
    const firstChunk = {
      ...makeChunk({ content: 'hello' }),
      id: '',
    } as ChatCompletionChunk;
    const finalChunk = {
      ...makeChunk({}),
      id: 'late-response-id',
      choices: [],
    } as ChatCompletionChunk;

    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      yield firstChunk;
      yield finalChunk;
    }

    const response = { id: FAKE_ID } as ChatCompletion;
    const events: any[] = [];
    for await (const event of convertChatCompletionsStreamToResponses(
      response,
      stream() as any,
    )) {
      events.push(event);
    }

    expect(events[2]).toEqual({
      type: 'output_text_delta',
      delta: 'hello',
      providerData: firstChunk,
    });
    expect(events.at(-1).response.output[0]).toMatchObject({
      id: 'late-response-id',
      type: 'message',
    });
  });

  it('preserves usage reported on an earlier chunk when the final chunk has no usage', async () => {
    async function* stream(): AsyncGenerator<
      ChatCompletionChunk,
      void,
      unknown
    > {
      // usage is delivered on an early chunk (some OpenAI-compatible
      // providers or gateways may emit a later chunk without usage after
      // reporting usage)...
      yield makeChunk(
        { content: 'Hello' },
        {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: {
            cached_tokens: 0,
            provider_metric: null,
          },
        },
      );
      // ...and the terminal chunk carries no usage at all.
      yield {
        id: 'c',
        created: 0,
        model: 'm',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      } as any;
    }

    const resp = { id: 'r' } as any;
    const iterator = convertChatCompletionsStreamToResponses(
      resp,
      stream() as any,
      { preserveRawUsage: true },
    )[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('response_started');
    (first.value as any).providerData.usage.prompt_tokens = 999;
    (
      first.value as any
    ).providerData.usage.prompt_tokens_details.cached_tokens = 88;

    const events: any[] = [first.value];
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    ) {
      events.push(next.value);
    }

    const final = events[events.length - 1];
    expect(final.type).toBe('response_done');
    expect(final.response.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
    });
    expect(final.response.rawUsage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: {
        cached_tokens: 0,
        provider_metric: null,
      },
    });
    expect(resp.usage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
    });
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

  it('filters multiple choices by default', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const chunks: ChatCompletionChunk[] = [
      {
        id: 'c',
        created: 0,
        model: 'm',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 1,
            delta: {
              content: 'ignored-first',
              annotations: [urlCitation('https://example.com/ignored')],
            },
          },
        ],
      } as any,
      {
        id: 'c',
        created: 0,
        model: 'm',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { content: 'kept', annotations: [urlCitation()] },
          },
          {
            index: 1,
            delta: {
              content: 'ignored-second',
              annotations: [urlCitation('https://example.com/ignored')],
            },
          },
        ],
      } as any,
      {
        id: 'c',
        created: 0,
        model: 'm',
        object: 'chat.completion.chunk',
        choices: [{ index: 2, delta: { content: 'ignored-third' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      } as any,
    ];

    async function* stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    const events: any[] = [];
    for await (const e of convertChatCompletionsStreamToResponses(
      { id: 'r' } as any,
      stream() as any,
    )) {
      events.push(e);
    }

    expect(
      events
        .filter((event) => event.type === 'output_text_delta')
        .map((event) => event.delta),
    ).toEqual(['kept']);
    const final = events.at(-1);
    expect(final.response.output[0].content[0].text).toBe('kept');
    expect(
      final.response.output[0].content[0].providerData.annotations,
    ).toEqual([urlCitation()]);
    expect(final.response.usage.totalTokens).toBe(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'multiple choices or nonzero choice indexes',
    );
    warnSpy.mockRestore();
  });

  it('rejects multiple choices in strict mode', async () => {
    async function* stream() {
      yield {
        id: 'c',
        created: 0,
        model: 'm',
        object: 'chat.completion.chunk',
        choices: [
          { index: 0, delta: { content: 'first' } },
          { index: 1, delta: { content: 'second' } },
        ],
      } as any;
    }

    await expect(async () => {
      for await (const _event of convertChatCompletionsStreamToResponses(
        { id: 'r' } as any,
        stream() as any,
        { strictFeatureValidation: true },
      )) {
        // Consume the stream.
      }
    }).rejects.toThrow(UserError);
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

  it('aggregates multiple function calls into a single trace choice', async () => {
    const resp: ChatCompletion = {
      id: 'r-multi',
      created: 0,
      model: 'gpt-test',
      object: 'chat.completion',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;

    async function* stream() {
      yield makeChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call1',
            function: { name: 'lookup', arguments: '{"city":' },
          },
          {
            index: 1,
            id: 'call2',
            function: { name: 'timezone', arguments: '{"zone":"JST"}' },
          },
        ],
      });
      yield {
        ...makeChunk({
          tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }],
        }),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      } as any;
    }

    for await (const _event of convertChatCompletionsStreamToResponses(
      resp,
      stream() as any,
    )) {
      // Drain all events.
    }

    expect(resp.choices).toEqual([
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
              id: 'call1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"city":"Tokyo"}' },
            },
            {
              id: 'call2',
              type: 'function',
              function: { name: 'timezone', arguments: '{"zone":"JST"}' },
            },
          ],
        },
      },
    ]);
  });

  it('ignores streamed custom tool calls by default', async () => {
    async function* stream() {
      yield makeChunk({
        tool_calls: [{ index: 0, id: 'call1', type: 'custom' }],
      });
      yield makeChunk({
        tool_calls: [
          { index: 0, function: { name: 'ignored', arguments: 'x' } },
        ],
      });
      yield makeChunk({ content: 'done' });
    }

    const events: any[] = [];
    for await (const e of convertChatCompletionsStreamToResponses(
      { id: 'r' } as any,
      stream() as any,
    )) {
      events.push(e);
    }

    const final = events.at(-1);
    expect(final.response.output).toHaveLength(1);
    expect(final.response.output[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'done' }],
    });
    expect(
      final.response.output.some((item: any) => item.type === 'function_call'),
    ).toBe(false);
  });

  it('rejects a truncated stream containing only an ignored custom tool call', async () => {
    async function* stream() {
      yield makeChunk({
        tool_calls: [{ index: 0, id: 'call1', type: 'custom' }],
      });
      yield {
        ...makeChunk({}),
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      } as any;
    }

    await expect(async () => {
      for await (const _event of convertChatCompletionsStreamToResponses(
        { id: 'r' } as any,
        stream() as any,
      )) {
        // Consume the stream.
      }
    }).rejects.toThrow(ModelBehaviorError);
  });

  it('rejects streamed custom tool calls in strict mode', async () => {
    async function* stream() {
      yield {
        ...makeChunk({
          tool_calls: [{ index: 0, id: 'call1', type: 'custom' }],
        }),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call1', type: 'custom' }],
            },
            finish_reason: 'length',
          },
        ],
      } as any;
    }

    await expect(async () => {
      for await (const _event of convertChatCompletionsStreamToResponses(
        { id: 'r' } as any,
        stream() as any,
        { strictFeatureValidation: true },
      )) {
        // Consume the stream.
      }
    }).rejects.toThrow('Custom tool calls are not supported');
  });

  it('falls back to FAKE_ID when streaming chunks do not include an id', async () => {
    const resp: ChatCompletion = {
      id: FAKE_ID,
      created: 0,
      model: 'gpt-test',
      object: 'chat.completion',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as any;

    async function* stream() {
      yield {
        ...makeChunk({ content: 'hello' }),
        id: undefined,
      } as any;
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
    expect(final.response.id).toBe(FAKE_ID);
    expect(final.response.output[0]).toMatchObject({
      id: FAKE_ID,
      type: 'message',
    });
  });
});
