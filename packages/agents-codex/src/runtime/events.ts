import { z } from 'zod';
import { jsonValue, parseNative, parseCertifiedRootText } from './binding';

export const nativeMarker = z.object({
  thread: z.string(),
  manual_grant: z.string().optional(),
  instance: z.string().optional(),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/),
  slot: z.number().int().nonnegative().safe(),
});
export const nativeEventSchema = z
  .object({
    id: z.string(),
    msg: z
      .object({
        type: z.string(),
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
export function parseEvent(source: string): NativeEvent {
  return nativeEventSchema.parse(parseNative(source));
}

type CertifiedRootTextEvent = {
  id: string;
  msg: Record<'type' | 'thread_id' | 'turn_id' | 'item_id' | 'delta', string>;
};

// Only called on ordinary JSON.parse output. Check names without reading
// inherited values; Zod reads optional fields and assigns every output key.
function isPlainCertifiedRootText(
  value: unknown,
): value is CertifiedRootTextEvent {
  const inherited = {};
  if (
    'id' in inherited ||
    'msg' in inherited ||
    'type' in inherited ||
    'thread_id' in inherited ||
    'turn_id' in inherited ||
    'item_id' in inherited ||
    'delta' in inherited ||
    '_sdk_python_tool' in inherited ||
    'subagent_id' in inherited ||
    'subagent_instance_id' in inherited ||
    'subagent_incarnation' in inherited ||
    'subagent_managed_tools' in inherited ||
    'subagent_turn_failed' in inherited ||
    'error_affects_turn_status' in inherited
  )
    return false;
  for (const key in inherited) {
    void key;
    return false;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const root = value as Record<string, unknown>;
  let rootKeys = 0;
  for (const key in root) {
    if (!Object.hasOwn(root, key) || (key !== 'id' && key !== 'msg'))
      return false;
    rootKeys++;
  }
  if (
    rootKeys !== 2 ||
    typeof root.id !== 'string' ||
    root.msg === null ||
    typeof root.msg !== 'object' ||
    Array.isArray(root.msg)
  )
    return false;
  const msg = root.msg as Record<string, unknown>;
  let messageKeys = 0;
  for (const key in msg) {
    if (
      !Object.hasOwn(msg, key) ||
      (key !== 'type' &&
        key !== 'thread_id' &&
        key !== 'turn_id' &&
        key !== 'item_id' &&
        key !== 'delta') ||
      typeof msg[key] !== 'string'
    )
      return false;
    messageKeys++;
  }
  return messageKeys === 5 && msg.type === 'agent_message_content_delta';
}

/** @internal Only native-certified root text can bypass the generic schema. */
export function parseCertifiedRootTextEvent(source: string): NativeEvent {
  const value = parseCertifiedRootText(source);
  if (isPlainCertifiedRootText(value)) {
    // Zod emits known fields first, then catchall keys in input order.
    return {
      id: value.id,
      msg: { type: value.msg.type, ...(value.msg as Record<string, string>) },
    };
  }
  return nativeEventSchema.parse(value);
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
