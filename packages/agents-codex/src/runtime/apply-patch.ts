import { z } from 'zod';
import type { JsonObject } from './binding';
import {
  createApplyPatchTool,
  ToolOutput,
  type FunctionTool,
  type ToolCallContext,
  type ToolContext,
} from './tools';

type MaybePromise<T> = T | Promise<T>;
export type ApplyPatchOperation =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'update_file'; path: string; diff: string; moveTo?: string }
  | { type: 'delete_file'; path: string };
export interface ApplyPatchResult {
  status?: 'completed' | 'failed';
  output?: string;
  /** Application-only JSON retained with the accepted editor result. */
  applicationData?: JsonObject | null;
}
export interface ApplyPatchEditor<Context = unknown> {
  createFile(
    operation: ApplyPatchOperation,
    context: ToolCallContext<Context>,
  ): MaybePromise<ApplyPatchResult | void>;
  updateFile(
    operation: ApplyPatchOperation,
    context: ToolCallContext<Context>,
  ): MaybePromise<ApplyPatchResult | void>;
  deleteFile(
    operation: ApplyPatchOperation,
    context: ToolCallContext<Context>,
  ): MaybePromise<ApplyPatchResult | void>;
}

export const applyPatchOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_file'),
    path: z.string(),
    diff: z.string(),
  }),
  z.object({
    type: z.literal('update_file'),
    path: z.string(),
    diff: z.string(),
    move_to: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('delete_file'), path: z.string() }),
]);
const callSchema = z.object({
  type: z.literal('apply_patch_call'),
  call_id: z.string().min(1),
  operation: applyPatchOperationSchema,
});
const resultSchema = z.object({
  status: z.enum(['completed', 'failed']).default('completed'),
  output: z.string().optional(),
});

/** A borrowed editor using native callback admission and accepted call/result history.
 * Paths and diff interpretation remain application-owned. The SDK has no editor close owner.
 */
export function applyPatchTool<Context = unknown>(options: {
  editor: ApplyPatchEditor<Context>;
  needsApproval?:
    boolean | ((context: ToolContext<Context>) => MaybePromise<boolean>);
}): FunctionTool<Context> {
  const callbacks = {
    create_file: options.editor.createFile.bind(options.editor),
    update_file: options.editor.updateFile.bind(options.editor),
    delete_file: options.editor.deleteFile.bind(options.editor),
  };
  return createApplyPatchTool<typeof callSchema, Context>(
    { type: 'applyPatch' },
    {
      name: 'apply_patch',
      description: "Apply patches with the application's editor",
      parameters: callSchema,
      needsApproval: options.needsApproval,
      // Typed editor failures retain their native failure path.
      errorFunction: null,
      execute: async ({ operation }, context) => {
        const publicOperation: ApplyPatchOperation =
          operation.type === 'update_file'
            ? {
                type: operation.type,
                path: operation.path,
                diff: operation.diff,
                ...(operation.move_to === undefined
                  ? {}
                  : { moveTo: operation.move_to }),
              }
            : operation;
        const returned = await callbacks[operation.type](
          publicOperation,
          context,
        );
        const result = resultSchema.parse(returned ?? {});
        return new ToolOutput(
          [{ type: 'inputText', text: JSON.stringify(result) }],
          result.status === 'completed',
          returned ? returned.applicationData : undefined,
        );
      },
    },
  );
}
