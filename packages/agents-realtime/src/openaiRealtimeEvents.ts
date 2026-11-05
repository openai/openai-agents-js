import { protocol } from '@openai/agents-core';
import type OpenAI from 'openai';
import { z } from 'zod';
import type { MessageEvent as WebSocketMessageEvent } from 'ws';

// Keep the released MCP spelling at the adapter boundary. Provider fields come
// from the SDK; local execution and history are validated by their own schemas.
type LegacyMcpCall = Omit<OpenAI.Realtime.RealtimeMcpToolCall, 'type'> & {
  type: 'mcp_tool_call';
};
type WithLegacyItem<T> = T extends { item: unknown }
  ? Omit<T, 'item'> & {
      item: (OpenAI.Realtime.ConversationItem | LegacyMcpCall) &
        Record<string, unknown>;
    }
  : T;
export type RealtimeServerEvent =
  WithLegacyItem<OpenAI.Realtime.RealtimeServerEvent>;
export type RealtimeClientEvent = OpenAI.Realtime.RealtimeClientEvent;
export type RealtimeServerGenericEvent = { type: string } & Record<string, any>;

const envelope = z.object({ type: z.string() }).passthrough();
const itemEvent = z.object({ item: z.object({}).passthrough() }).passthrough();
const responseEvent = z
  .object({ response: z.object({}).passthrough() })
  .passthrough();
const sessionEvent = z
  .object({ session: z.object({}).passthrough() })
  .passthrough();
const itemIdEvent = z.object({ item_id: z.string() }).passthrough();
const textDeltaEvent = z
  .object({
    delta: z.string(),
    item_id: z.string(),
    response_id: z.string(),
  })
  .passthrough();

// These are handler preconditions, not a second copy of the provider schema.
// Never validate passive metadata, status enums, or the complete event union.
const handlerInputs: Partial<Record<RealtimeServerEvent['type'], z.ZodType>> = {
  'conversation.item.added': itemEvent,
  'conversation.item.done': itemEvent,
  'conversation.item.retrieved': itemEvent,
  'response.output_item.added': itemEvent.extend({ response_id: z.string() }),
  'response.output_item.done': itemEvent.extend({ response_id: z.string() }),
  'response.created': responseEvent,
  'response.done': responseEvent,
  'session.created': sessionEvent,
  'session.updated': sessionEvent,
  'conversation.item.deleted': itemIdEvent,
  'conversation.item.truncated': itemIdEvent,
  'conversation.item.input_audio_transcription.completed': itemIdEvent,
  'response.mcp_call.in_progress': itemIdEvent,
  'mcp_list_tools.in_progress': z
    .object({ item_id: z.string().optional() })
    .passthrough(),
  'response.output_text.delta': textDeltaEvent,
  'response.output_audio_transcript.delta': textDeltaEvent,
  'response.output_audio.delta': textDeltaEvent.extend({
    content_index: z.number(),
  }),
};

// Accounting requires numeric counters, but provider details remain opaque.
export const responseDoneEventSchema = z
  .object({
    response: z
      .object({
        id: z.string().nullish(),
        output: z.array(z.any()).nullish(),
        usage: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            input_token_details: protocol.TokenDetails.nullish(),
            output_token_details: protocol.TokenDetails.nullish(),
          })
          .nullish(),
      })
      .passthrough(),
  })
  .passthrough();

type ParseResult = {
  data: RealtimeServerEvent | null;
  raw: RealtimeServerGenericEvent | null;
};

/**
 * Decode the provider envelope and check only handler prerequisites. Unknown
 * events and extension fields remain available to listeners. SDK types describe
 * known payloads; they are not a runtime allowlist of server events.
 */
export function parseRealtimeEvent(
  event: MessageEvent | WebSocketMessageEvent,
): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(event.data.toString());
  } catch {
    return { data: null, raw: null };
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return { data: null, raw: null };
  const payload = parsed.data;
  const guard = Object.prototype.hasOwnProperty.call(
    handlerInputs,
    payload.type,
  )
    ? handlerInputs[payload.type as RealtimeServerEvent['type']]
    : undefined;
  return {
    data:
      guard && !guard.safeParse(payload).success
        ? null
        : (payload as unknown as RealtimeServerEvent),
    raw: payload,
  };
}
