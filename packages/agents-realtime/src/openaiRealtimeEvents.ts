import { z } from '@openai/zod/v3';
import type { MessageEvent as WebSocketMessageEvent } from 'ws';

// Event schemas mirroring the structures defined in the OpenAI SDK typings.
// Most fields from the interfaces in `realtime.d.ts` are captured here to
// provide better runtime validation when parsing events from the server.

export const realtimeResponse = z.object({
  id: z.string().optional().nullable(),
  conversation_id: z.string().optional().nullable(),
  max_output_tokens: z.number().or(z.literal('inf')).optional().nullable(),
  metadata: z.record(z.string(), z.any()).optional().nullable(),
  modalities: z.array(z.string()).optional().nullable(),
  object: z.literal('realtime.response').optional().nullable(),
  output: z.array(z.any()).optional().nullable(),
  output_audio_format: z.string().optional().nullable(),
  status: z
    .enum(['completed', 'incomplete', 'failed', 'cancelled', 'in_progress'])
    .optional()
    .nullable(),
  status_details: z.record(z.string(), z.any()).optional().nullable(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      input_tokens_details: z.record(z.string(), z.any()).optional().nullable(),
      output_tokens: z.number().optional(),
      output_tokens_details: z
        .record(z.string(), z.any())
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
  voice: z.string().optional().nullable(),
});

// Basic content schema used by ConversationItem.
export const conversationItemContentSchema = z.object({
  id: z.string().optional(),
  audio: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  transcript: z.string().nullable().optional(),
  type: z.union([
    z.literal('input_text'),
    z.literal('input_audio'),
    z.literal('item_reference'),
    z.literal('text'),
    z.literal('audio'),
  ]),
});

export const conversationItemSchema = z.object({
  id: z.string().optional(),
  arguments: z.string().optional(),
  call_id: z.string().optional(),
  content: z.array(conversationItemContentSchema).optional(),
  name: z.string().optional(),
  object: z.literal('realtime.item').optional(),
  output: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system']).optional(),
  status: z.enum(['completed', 'incomplete', 'in_progress']).optional(),
  type: z.enum(['message', 'function_call', 'function_call_output']).optional(),
});

export const conversationCreatedEventSchema = z.object({
  type: z.literal('conversation.created'),
  event_id: z.string(),
  conversation: z.object({
    id: z.string().optional(),
    object: z.literal('realtime.conversation').optional(),
  }),
});

export const conversationItemCreatedEventSchema = z.object({
  type: z.literal('conversation.item.created'),
  event_id: z.string(),
  item: conversationItemSchema,
  previous_item_id: z.string().nullable().optional(),
});

export const conversationItemDeletedEventSchema = z.object({
  type: z.literal('conversation.item.deleted'),
  event_id: z.string(),
  item_id: z.string(),
});

export const conversationItemInputAudioTranscriptionCompletedEventSchema =
  z.object({
    type: z.literal('conversation.item.input_audio_transcription.completed'),
    event_id: z.string(),
    item_id: z.string(),
    content_index: z.number(),
    transcript: z.string(),
    logprobs: z.array(z.any()).nullable().optional(),
  });

export const conversationItemInputAudioTranscriptionDeltaEventSchema = z.object(
  {
    type: z.literal('conversation.item.input_audio_transcription.delta'),
    event_id: z.string(),
    item_id: z.string(),
    content_index: z.number().optional(),
    delta: z.string().optional(),
    logprobs: z.array(z.any()).nullable().optional(),
  },
);

export const conversationItemInputAudioTranscriptionFailedEventSchema =
  z.object({
    type: z.literal('conversation.item.input_audio_transcription.failed'),
    event_id: z.string(),
    item_id: z.string(),
    content_index: z.number(),
    error: z.object({
      code: z.string().optional(),
      message: z.string().optional(),
      param: z.string().optional(),
      type: z.string().optional(),
    }),
  });

export const conversationItemRetrievedEventSchema = z.object({
  type: z.literal('conversation.item.retrieved'),
  event_id: z.string(),
  item: conversationItemSchema,
});

export const conversationItemTruncatedEventSchema = z.object({
  type: z.literal('conversation.item.truncated'),
  event_id: z.string(),
  item_id: z.string(),
  audio_end_ms: z.number(),
  content_index: z.number(),
});

export const conversationItemCreateEventSchema = z.object({
  type: z.literal('conversation.item.create'),
  item: conversationItemSchema,
  event_id: z.string().optional(),
  previous_item_id: z.string().nullable().optional(),
});

export const conversationItemDeleteEventSchema = z.object({
  type: z.literal('conversation.item.delete'),
  item_id: z.string(),
  event_id: z.string().optional(),
});

export const conversationItemRetrieveEventSchema = z.object({
  type: z.literal('conversation.item.retrieve'),
  item_id: z.string(),
  event_id: z.string().optional(),
});

export const conversationItemTruncateEventSchema = z.object({
  type: z.literal('conversation.item.truncate'),
  item_id: z.string(),
  audio_end_ms: z.number(),
  content_index: z.number(),
  event_id: z.string().optional(),
});

export const errorEventSchema = z.object({
  type: z.literal('error'),
  event_id: z.string().optional(),
  error: z.any().optional(),
});

export const inputAudioBufferClearedEventSchema = z.object({
  type: z.literal('input_audio_buffer.cleared'),
  event_id: z.string(),
});

export const inputAudioBufferAppendEventSchema = z.object({
  type: z.literal('input_audio_buffer.append'),
  audio: z.string(),
  event_id: z.string().optional(),
});

export const inputAudioBufferClearEventSchema = z.object({
  type: z.literal('input_audio_buffer.clear'),
  event_id: z.string().optional(),
});

export const inputAudioBufferCommitEventSchema = z.object({
  type: z.literal('input_audio_buffer.commit'),
  event_id: z.string().optional(),
});

export const inputAudioBufferCommittedEventSchema = z.object({
  type: z.literal('input_audio_buffer.committed'),
  event_id: z.string(),
  item_id: z.string(),
  previous_item_id: z.string().nullable().optional(),
});

export const inputAudioBufferSpeechStartedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_started'),
  event_id: z.string(),
  item_id: z.string(),
  audio_start_ms: z.number(),
});

export const inputAudioBufferSpeechStoppedEventSchema = z.object({
  type: z.literal('input_audio_buffer.speech_stopped'),
  event_id: z.string(),
  item_id: z.string(),
  audio_end_ms: z.number(),
});

export const outputAudioBufferStartedEventSchema = z
  .object({
    type: z.literal('output_audio_buffer.started'),
    event_id: z.string(),
  })
  .passthrough();

export const outputAudioBufferStoppedEventSchema = z
  .object({
    type: z.literal('output_audio_buffer.stopped'),
    event_id: z.string(),
  })
  .passthrough();

export const outputAudioBufferClearedEventSchema = z.object({
  type: z.literal('output_audio_buffer.cleared'),
  event_id: z.string(),
});

export const rateLimitsUpdatedEventSchema = z.object({
  type: z.literal('rate_limits.updated'),
  event_id: z.string(),
  rate_limits: z.array(
    z.object({
      limit: z.number().optional(),
      name: z.enum(['requests', 'tokens']).optional(),
      remaining: z.number().optional(),
      reset_seconds: z.number().optional(),
    }),
  ),
});

export const responseAudioDeltaEventSchema = z.object({
  type: z.literal('response.audio.delta'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  delta: z.string(),
  output_index: z.number(),
  response_id: z.string(),
});

export const responseAudioDoneEventSchema = z.object({
  type: z.literal('response.audio.done'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  output_index: z.number(),
  response_id: z.string(),
});

export const responseAudioTranscriptDeltaEventSchema = z.object({
  type: z.literal('response.audio_transcript.delta'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  delta: z.string(),
  output_index: z.number(),
  response_id: z.string(),
});

export const responseAudioTranscriptDoneEventSchema = z.object({
  type: z.literal('response.audio_transcript.done'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  transcript: z.string(),
  output_index: z.number(),
  response_id: z.string(),
});

export const responseContentPartAddedEventSchema = z.object({
  type: z.literal('response.content_part.added'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  output_index: z.number(),
  response_id: z.string(),
  part: z.object({
    audio: z.string().optional(),
    text: z.string().optional(),
    transcript: z.string().optional(),
    type: z.enum(['text', 'audio']).optional(),
  }),
});

export const responseContentPartDoneEventSchema = z.object({
  type: z.literal('response.content_part.done'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  output_index: z.number(),
  response_id: z.string(),
  part: z.object({
    audio: z.string().optional(),
    text: z.string().optional(),
    transcript: z.string().optional(),
    type: z.enum(['text', 'audio']).optional(),
  }),
});

export const responseCreatedEventSchema = z.object({
  type: z.literal('response.created'),
  event_id: z.string(),
  response: realtimeResponse,
});

export const responseDoneEventSchema = z.object({
  type: z.literal('response.done'),
  event_id: z.string(),
  response: realtimeResponse,
});

export const responseFunctionCallArgumentsDeltaEventSchema = z.object({
  type: z.literal('response.function_call_arguments.delta'),
  event_id: z.string(),
  item_id: z.string(),
  call_id: z.string(),
  delta: z.string(),
  output_index: z.number(),
  response_id: z.string(),
});

export const responseFunctionCallArgumentsDoneEventSchema = z.object({
  type: z.literal('response.function_call_arguments.done'),
  event_id: z.string(),
  item_id: z.string(),
  call_id: z.string(),
  arguments: z.string(),
  output_index: z.number(),
  response_id: z.string(),
});

export const responseOutputItemAddedEventSchema = z.object({
  type: z.literal('response.output_item.added'),
  event_id: z.string(),
  item: conversationItemSchema,
  output_index: z.number(),
  response_id: z.string(),
});

export const responseOutputItemDoneEventSchema = z.object({
  type: z.literal('response.output_item.done'),
  event_id: z.string(),
  item: conversationItemSchema,
  output_index: z.number(),
  response_id: z.string(),
});

export const responseTextDeltaEventSchema = z.object({
  type: z.literal('response.text.delta'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  delta: z.string(),
  output_index: z.number(),
  response_id: z.string(),
});

export const responseTextDoneEventSchema = z.object({
  type: z.literal('response.text.done'),
  event_id: z.string(),
  item_id: z.string(),
  content_index: z.number(),
  text: z.string(),
  output_index: z.number(),
  response_id: z.string(),
});

export const sessionCreatedEventSchema = z.object({
  type: z.literal('session.created'),
  event_id: z.string(),
  session: z.any(),
});

export const sessionUpdatedEventSchema = z.object({
  type: z.literal('session.updated'),
  event_id: z.string(),
  session: z.any(),
});

export const responseCancelEventSchema = z.object({
  type: z.literal('response.cancel'),
  event_id: z.string().optional(),
  response_id: z.string().optional(),
});

export const responseCreateEventSchema = z.object({
  type: z.literal('response.create'),
  event_id: z.string().optional(),
  response: z.any().optional(),
});

export const sessionUpdateEventSchema = z.object({
  type: z.literal('session.update'),
  event_id: z.string().optional(),
  session: z.any(),
});

export const transcriptionSessionUpdateEventSchema = z.object({
  type: z.literal('transcription_session.update'),
  event_id: z.string().optional(),
  session: z.any(),
});

export const transcriptionSessionUpdatedEventSchema = z.object({
  type: z.literal('transcription_session.updated'),
  event_id: z.string(),
  session: z.any(),
});

/**
 * This schema is used if an event is unknown to the client. The Realtime API might introduce
 * new events at some point and we should handle them gracefully by treating them as generic events
 * only requiring a type and an optional event_id.
 */
export const genericEventSchema = z
  .object({
    type: z.string(),
    event_id: z.string().optional().nullable(),
  })
  .passthrough();

export const realtimeServerEventSchema = z.discriminatedUnion('type', [
  conversationCreatedEventSchema,
  conversationItemCreatedEventSchema,
  conversationItemDeletedEventSchema,
  conversationItemInputAudioTranscriptionCompletedEventSchema,
  conversationItemInputAudioTranscriptionDeltaEventSchema,
  conversationItemInputAudioTranscriptionFailedEventSchema,
  conversationItemRetrievedEventSchema,
  conversationItemTruncatedEventSchema,
  errorEventSchema,
  inputAudioBufferClearedEventSchema,
  inputAudioBufferCommittedEventSchema,
  inputAudioBufferSpeechStartedEventSchema,
  inputAudioBufferSpeechStoppedEventSchema,
  outputAudioBufferStartedEventSchema,
  outputAudioBufferStoppedEventSchema,
  outputAudioBufferClearedEventSchema,
  rateLimitsUpdatedEventSchema,
  responseAudioDeltaEventSchema,
  responseAudioDoneEventSchema,
  responseAudioTranscriptDeltaEventSchema,
  responseAudioTranscriptDoneEventSchema,
  responseContentPartAddedEventSchema,
  responseContentPartDoneEventSchema,
  responseCreatedEventSchema,
  responseDoneEventSchema,
  responseFunctionCallArgumentsDeltaEventSchema,
  responseFunctionCallArgumentsDoneEventSchema,
  responseOutputItemAddedEventSchema,
  responseOutputItemDoneEventSchema,
  responseTextDeltaEventSchema,
  responseTextDoneEventSchema,
  sessionCreatedEventSchema,
  sessionUpdatedEventSchema,
  transcriptionSessionUpdatedEventSchema,
]);

export const realtimeClientEventSchema = z.discriminatedUnion('type', [
  conversationItemCreateEventSchema,
  conversationItemDeleteEventSchema,
  conversationItemRetrieveEventSchema,
  conversationItemTruncateEventSchema,
  inputAudioBufferAppendEventSchema,
  inputAudioBufferClearEventSchema,
  inputAudioBufferCommitEventSchema,
  responseCancelEventSchema,
  responseCreateEventSchema,
  sessionUpdateEventSchema,
  transcriptionSessionUpdateEventSchema,
]);

export type RealtimeServerGenericEvent = z.infer<typeof genericEventSchema> &
  Record<string, any>;

export type RealtimeServerEvent = z.infer<typeof realtimeServerEventSchema> &
  Record<string, any>;

export type RealtimeClientEvent = z.infer<typeof realtimeClientEventSchema> &
  Record<string, any>;

type ParseResult =
  | {
      data: RealtimeServerEvent;
      isGeneric: false;
    }
  | {
      data: RealtimeServerGenericEvent;
      isGeneric: true;
    }
  | {
      data: null;
      isGeneric: true;
    };

/**
 * Parses a realtime event from the server. If the event is unknown to the client, it will be treated as a generic event.
 * @param event - The event to parse.
 * @returns The parsed event or null if the event is unknown to the client.
 */
export function parseRealtimeEvent(
  event: MessageEvent | WebSocketMessageEvent,
): ParseResult {
  const raw = JSON.parse(event.data.toString());
  const parsed = realtimeServerEventSchema.safeParse(raw);
  if (!parsed.success) {
    const genericParsed = genericEventSchema.safeParse(raw);
    if (genericParsed.success) {
      return { data: genericParsed.data, isGeneric: true };
    }
    return { data: null, isGeneric: true };
  }
  return { data: parsed.data, isGeneric: false };
}
