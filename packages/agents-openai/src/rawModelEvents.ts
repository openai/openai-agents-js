import type {
  RunRawModelStreamEvent,
  RunStreamEvent,
  StreamEventGenericItem,
} from '@openai/agents-core';
import type { ChatCompletionChunk } from 'openai/resources/chat';
import type { ResponseStreamEvent as OpenAIResponseStreamEvent } from 'openai/resources/responses/responses';

export const OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE = 'openai-responses';
export const OPENAI_CHAT_COMPLETIONS_RAW_MODEL_EVENT_SOURCE =
  'openai-chat-completions';

export type OpenAIRawModelEventSource =
  | typeof OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE
  | typeof OPENAI_CHAT_COMPLETIONS_RAW_MODEL_EVENT_SOURCE;

type OpenAIRawModelEventData<
  TSource extends OpenAIRawModelEventSource,
  TEvent,
> = Omit<StreamEventGenericItem, 'event' | 'providerData'> & {
  type: 'model';
  event: TEvent;
  providerData: NonNullable<StreamEventGenericItem['providerData']> & {
    rawModelEventSource: TSource;
  };
};

export type OpenAIResponsesRawModelStreamEvent = Omit<
  RunRawModelStreamEvent,
  'data' | 'source'
> & {
  source: typeof OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE;
  data: OpenAIRawModelEventData<
    typeof OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
    OpenAIResponseStreamEvent
  >;
};

export type OpenAIChatCompletionsRawModelStreamEvent = Omit<
  RunRawModelStreamEvent,
  'data' | 'source'
> & {
  source: typeof OPENAI_CHAT_COMPLETIONS_RAW_MODEL_EVENT_SOURCE;
  data: OpenAIRawModelEventData<
    typeof OPENAI_CHAT_COMPLETIONS_RAW_MODEL_EVENT_SOURCE,
    ChatCompletionChunk
  >;
};

export function isOpenAIResponsesRawModelStreamEvent(
  event: RunStreamEvent,
): event is OpenAIResponsesRawModelStreamEvent {
  return (
    event.type === 'raw_model_stream_event' &&
    event.data.type === 'model' &&
    event.source === OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE
  );
}

export function isOpenAIChatCompletionsRawModelStreamEvent(
  event: RunStreamEvent,
): event is OpenAIChatCompletionsRawModelStreamEvent {
  return (
    event.type === 'raw_model_stream_event' &&
    event.data.type === 'model' &&
    event.source === OPENAI_CHAT_COMPLETIONS_RAW_MODEL_EVENT_SOURCE
  );
}
