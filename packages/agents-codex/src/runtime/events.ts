import { z } from 'zod';
import {
  type JsonValue,
  jsonValue,
  losslessJsonValueSchema,
  mayNeedNativeReviver,
  parseNative,
} from './binding';

export const nativeMarker = z.object({
  thread: z.string(),
  manual_grant: z.string().optional(),
  instance: z.string().optional(),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/),
  slot: z.number().int().nonnegative().safe(),
});
const nativeEventPayloadFields = {
  data: losslessJsonValueSchema.optional(),
  arguments: losslessJsonValueSchema.optional(),
  tool_completion: losslessJsonValueSchema.optional(),
  items: losslessJsonValueSchema.optional(),
};
export const nativeEventSchema = z
  .object({
    id: z.string(),
    msg: z
      .object({
        type: z.string(),
        ...nativeEventPayloadFields,
        _sdk_python_tool: nativeMarker.optional(),
      })
      .catchall(jsonValue),
    subagent_id: z.string().optional(),
    subagent_instance_id: z.string().optional(),
    subagent_incarnation: z.string().optional(),
    subagent_managed_tools: z.boolean().optional(),
    subagent_turn_failed: z.boolean().optional(),
    error_affects_turn_status: z.boolean().optional(),
  })
  .catchall(jsonValue);
export type NativeEvent = z.infer<typeof nativeEventSchema>;

const ordinaryEventTypes = new Set([
  'agent_message',
  'item_completed',
  'item_started',
  'mcp_startup_complete',
  'raw_response_completed',
  'raw_response_item',
  '_sdk_request_metadata',
  'task_complete',
  'task_started',
  'thread_settings_applied',
  'token_count',
  'user_message',
  'warning',
]);
const nativeEventPayloadKeys = Object.keys(nativeEventPayloadFields);

function isOrdinaryJson(value: unknown, depth = 0): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value !== 'object') return true;
  if (depth === 32) return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isOrdinaryJson(item, depth + 1)) return false;
    }
    return true;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      key === 'prototype' ||
      key === '_sdk_callback' ||
      key === '_sdk_python_tool' ||
      key === 'checkpoint' ||
      key === 'manual_continuation' ||
      key in Object.prototype ||
      key in Array.prototype ||
      !isOrdinaryJson(record[key], depth + 1)
    )
      return false;
  }
  return true;
}

function tryOwnedOrdinaryEvent(source: string): NativeEvent | undefined {
  if (mayNeedNativeReviver(source)) return;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const event = value as Record<string, unknown>;
  if (
    Object.keys(event).length !== 2 ||
    !Object.hasOwn(event, 'id') ||
    typeof event.id !== 'string' ||
    !Object.hasOwn(event, 'msg') ||
    typeof event.msg !== 'object' ||
    event.msg === null
  )
    return;
  const msg = event.msg as Record<string, JsonValue>;
  if (
    !Object.hasOwn(msg, 'type') ||
    typeof msg.type !== 'string' ||
    !ordinaryEventTypes.has(msg.type) ||
    !isOrdinaryJson(msg)
  )
    return;

  // Match the schema's field order while reusing the owned nested JSON.
  const normalized: NativeEvent['msg'] = { type: msg.type };
  for (const key of nativeEventPayloadKeys) {
    if (Object.hasOwn(msg, key)) normalized[key] = msg[key];
  }
  for (const key of Object.keys(msg)) {
    if (!Object.hasOwn(normalized, key)) normalized[key] = msg[key];
  }
  return { id: event.id, msg: normalized };
}

// Only this closed, string-only shape needs neither integer restoration nor
// recursive JSON normalization. Every other shape keeps the original source path.
function isExactRootTextDelta(value: unknown): value is NativeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(event).length !== 2 ||
    !Object.hasOwn(event, 'id') ||
    !Object.hasOwn(event, 'msg') ||
    typeof event.id !== 'string'
  )
    return false;
  const msg = event.msg;
  if (typeof msg !== 'object' || msg === null) return false;
  const text = msg as Record<string, unknown>;
  return (
    Reflect.ownKeys(text).length === 5 &&
    Object.hasOwn(text, 'type') &&
    text.type === 'agent_message_content_delta' &&
    Object.hasOwn(text, 'thread_id') &&
    typeof text.thread_id === 'string' &&
    Object.hasOwn(text, 'turn_id') &&
    typeof text.turn_id === 'string' &&
    Object.hasOwn(text, 'item_id') &&
    typeof text.item_id === 'string' &&
    Object.hasOwn(text, 'delta') &&
    typeof text.delta === 'string'
  );
}

export function parseEvent(source: string): NativeEvent {
  // Compact root text closes a string, msg and root. Child metadata closes
  // after msg. These hints can miss text; only the parsed guard proves safety.
  if (
    typeof source === 'string' &&
    source.endsWith('"}}') &&
    source.slice(0, 512).includes('"type":"agent_message_content_delta"')
  ) {
    const parsed: unknown = JSON.parse(source);
    if (isExactRootTextDelta(parsed)) return parsed;
  }
  return (
    tryOwnedOrdinaryEvent(source) ??
    nativeEventSchema.parse(parseNative(source))
  );
}

/** @internal Native batches retain original event strings and exact receipt tokens. */
export function parseEvents(source: string): NativeEvent[] {
  return z.array(z.string()).parse(JSON.parse(source)).map(parseEvent);
}
export const requestTypes: ReadonlySet<string> = new Set([
  'dynamic_tool_call_request',
  'exec_approval_request',
  'apply_patch_approval_request',
  'elicitation_request',
  'request_user_input',
  'request_permissions',
]);
