import { describe, expect, expectTypeOf, it } from 'vitest';
import { RunRawModelStreamEvent } from '@openai/agents-core';
import type { ChatCompletionChunk } from 'openai/resources/chat';
import type { ResponseStreamEvent as OpenAIResponseStreamEvent } from 'openai/resources/responses/responses';
import {
  isOpenAIChatCompletionsRawModelStreamEvent,
  isOpenAIResponsesRawModelStreamEvent,
  OPENAI_CHAT_COMPLETIONS_RAW_MODEL_EVENT_SOURCE,
  OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
  type OpenAIChatCompletionsRawModelStreamEvent,
  type OpenAIResponsesRawModelStreamEvent,
} from '../src';

describe('raw model event helpers', () => {
  it('narrows OpenAI Responses raw model events', () => {
    const event = new RunRawModelStreamEvent({
      type: 'model',
      event: {
        type: 'response.created',
        response: { id: 'resp_123' } as any,
        sequence_number: 0,
      } as OpenAIResponseStreamEvent,
      providerData: {
        rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
      },
    });

    expect(isOpenAIResponsesRawModelStreamEvent(event)).toBe(true);
    expect(isOpenAIChatCompletionsRawModelStreamEvent(event)).toBe(false);

    if (isOpenAIResponsesRawModelStreamEvent(event)) {
      expect(event.data.event.type).toBe('response.created');
    }

    expectTypeOf<
      OpenAIResponsesRawModelStreamEvent['data']['event']
    >().toMatchTypeOf<OpenAIResponseStreamEvent>();
  });

  it('narrows Chat Completions raw model events', () => {
    const chunk = {
      id: 'chatcmpl_123',
      created: 0,
      model: 'gpt-4.1',
      object: 'chat.completion.chunk',
      choices: [],
    } as ChatCompletionChunk;

    const event = new RunRawModelStreamEvent({
      type: 'model',
      event: chunk,
      providerData: {
        rawModelEventSource: OPENAI_CHAT_COMPLETIONS_RAW_MODEL_EVENT_SOURCE,
      },
    });

    expect(isOpenAIChatCompletionsRawModelStreamEvent(event)).toBe(true);
    expect(isOpenAIResponsesRawModelStreamEvent(event)).toBe(false);

    if (isOpenAIChatCompletionsRawModelStreamEvent(event)) {
      expect(event.data.event.object).toBe('chat.completion.chunk');
    }

    expectTypeOf<
      OpenAIChatCompletionsRawModelStreamEvent['data']['event']
    >().toMatchTypeOf<ChatCompletionChunk>();
  });

  it('does not narrow generic raw model events without an OpenAI source marker', () => {
    const event = new RunRawModelStreamEvent({
      type: 'model',
      event: {
        type: 'text-delta',
        delta: 'hello',
      } as any,
    });

    expect(isOpenAIResponsesRawModelStreamEvent(event)).toBe(false);
    expect(isOpenAIChatCompletionsRawModelStreamEvent(event)).toBe(false);
  });
});
