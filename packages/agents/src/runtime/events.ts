import { z } from 'zod';
import { jsonValue, parseNative } from './binding';

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
