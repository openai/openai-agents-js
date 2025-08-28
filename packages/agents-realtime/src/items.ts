import { z } from 'zod';

export const baseItemSchema = z.object({
  itemId: z.string(),
});

export const realtimeMessageItemSchema = z.discriminatedUnion('role', [
  z.object({
    itemId: z.string(),
    previousItemId: z.string().nullable().optional(),
    type: z.literal('message'),
    role: z.literal('system'),
    content: z.array(
      z.object({ type: z.literal('input_text'), text: z.string() }),
    ),
  }),
  z.object({
    itemId: z.string(),
    previousItemId: z.string().nullable().optional(),
    type: z.literal('message'),
    role: z.literal('user'),
    status: z.enum(['in_progress', 'completed']),
    content: z.array(
      z.object({ type: z.literal('input_text'), text: z.string() }).or(
        z.object({
          type: z.literal('input_audio'),
          audio: z.string().nullable().optional(),
          transcript: z.string().nullable(),
        }),
      ),
    ),
  }),
  z.object({
    itemId: z.string(),
    previousItemId: z.string().nullable().optional(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    status: z.enum(['in_progress', 'completed', 'incomplete']),
    content: z.array(
      z.object({ type: z.literal('output_text'), text: z.string() }).or(
        z.object({
          type: z.literal('output_audio'),
          audio: z.string().nullable().optional(),
          transcript: z.string().nullable().optional(),
        }),
      ),
    ),
  }),
]);

export const realtimeToolCallItem = z.object({
  itemId: z.string(),
  previousItemId: z.string().nullable().optional(),
  type: z.literal('function_call'),
  status: z.enum(['in_progress', 'completed', 'incomplete']),
  arguments: z.string(),
  name: z.string(),
  output: z.string().nullable(),
});

export const realtimeMcpCallItem = z.object({
  itemId: z.string(),
  previousItemId: z.string().nullable().optional(),
  type: z.enum(['mcp_call', 'mcp_tool_call']),
  status: z.enum(['in_progress', 'completed', 'incomplete']),
  arguments: z.string(),
  name: z.string(),
  output: z.string().nullable(),
});

export const realtimeMcpCallApprovalRequestItem = z.object({
  itemId: z.string(),
  type: z.literal('mcp_approval_request'),
  serverLabel: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.any()),
  approved: z.boolean().optional().nullable(),
});

export type RealtimeBaseItem = z.infer<typeof baseItemSchema>;
export type RealtimeMessageItem = z.infer<typeof realtimeMessageItemSchema>;
export type RealtimeToolCallItem = z.infer<typeof realtimeToolCallItem>;
export type RealtimeMcpCallItem = z.infer<typeof realtimeMcpCallItem>;
export type RealtimeMcpCallApprovalRequestItem = z.infer<
  typeof realtimeMcpCallApprovalRequestItem
>;
export type RealtimeItem =
  | RealtimeMessageItem
  | RealtimeToolCallItem
  | RealtimeMcpCallItem
  | RealtimeMcpCallApprovalRequestItem;
