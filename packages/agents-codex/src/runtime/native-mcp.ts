import { z } from 'zod';
import { jsonObject, losslessJsonObjectSchema } from './binding';

/** Protocol result callback on native MCP calls reaching an admitted root or native child turn. */
export const nativeMcpResultInfoSchema = z.object({
  nonce: z.string(),
  thread_id: z.string(),
  turn_id: z.string(),
  call_id: z.string(),
  source: z.enum(['config', 'connector', 'plugin', 'selected_plugin', 'other']),
  server_name: z.string(),
  tool_name: z.string(),
  callable_namespace: z.string(),
  callable_name: z.string(),
  arguments: jsonObject,
  result: losslessJsonObjectSchema.optional(),
  phase: z.literal('metadata').optional(),
  route: z.enum(['direct', 'code']).optional(),
  model: z.string().optional(),
  cell_id: z.string().optional(),
  runtime_tool_call_id: z.string().optional(),
});
export type NativeMcpResultInfo = z.infer<typeof nativeMcpResultInfoSchema>;
