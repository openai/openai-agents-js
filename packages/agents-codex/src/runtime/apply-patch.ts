import { z } from 'zod';
import { losslessJsonObjectSchema, type JsonObject } from './binding';
import {
  createApplyPatchTool,
  ToolOutput,
  tool,
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

type EditorToolOptions<Context> = {
  editor: ApplyPatchEditor<Context>;
  needsApproval?:
    boolean | ((context: ToolContext<Context>) => MaybePromise<boolean>);
};

function captureEditor<Context>(editor: ApplyPatchEditor<Context>) {
  const callbacks = {
    create_file: editor.createFile.bind(editor),
    update_file: editor.updateFile.bind(editor),
    delete_file: editor.deleteFile.bind(editor),
  };
  return async (
    operation: z.infer<typeof applyPatchOperationSchema>,
    context: ToolCallContext<Context>,
  ) => {
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
    const returned = await callbacks[operation.type](publicOperation, context);
    return {
      result: resultSchema.parse(returned ?? {}),
      applicationData: returned ? returned.applicationData : undefined,
    };
  };
}

/** A borrowed editor using native callback admission and accepted call/result history.
 * Paths and diff interpretation remain application-owned. The SDK has no editor close owner.
 */
export function applyPatchTool<Context = unknown>(
  options: EditorToolOptions<Context>,
): FunctionTool<Context> {
  const edit = captureEditor(options.editor);
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
        const { result, applicationData } = await edit(operation, context);
        return new ToolOutput(
          [{ type: 'inputText', text: JSON.stringify(result) }],
          result.status === 'completed',
          applicationData,
        );
      },
    },
  );
}

const batchSchema = z.object({
  operations: z.array(applyPatchOperationSchema).min(1),
});

/** Apply an ordered batch with a borrowed editor. A failed result is recorded
 * and the next operation continues. Each result stays in input order.
 */
export function applyPatchBatchTool<Context = unknown>(
  options: EditorToolOptions<Context>,
): FunctionTool<Context> {
  const edit = captureEditor(options.editor);
  return tool<typeof batchSchema, Context>({
    name: 'apply_patch_batch',
    description:
      "Apply an ordered list of operations with the application's editor",
    parameters: batchSchema,
    strict: false,
    needsApproval: options.needsApproval,
    errorFunction: null,
    execute: async ({ operations }, context) => {
      const results: z.infer<typeof resultSchema>[] = [];
      const privateResults: (JsonObject | null)[] = [];
      for (const operation of operations) {
        context.signal.throwIfAborted();
        const { result, applicationData } = await edit(operation, context);
        results.push(result);
        privateResults.push(
          applicationData == null
            ? null
            : losslessJsonObjectSchema.parse(applicationData),
        );
      }
      return new ToolOutput(
        [{ type: 'inputText', text: JSON.stringify({ results }) }],
        results.every((result) => result.status === 'completed'),
        privateResults.some((result) => result !== null)
          ? { operations: privateResults }
          : undefined,
      );
    },
  });
}
