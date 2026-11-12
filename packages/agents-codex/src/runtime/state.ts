import { modelAttemptSnapshotSchema } from './model-attempts';
import { nativeInput, type UserInput } from './input';
import { captureFile, captureImage, mediaRecord } from './media';
import { z } from 'zod';
import type { OutputIdentity } from './output';
import {
  checkpointSelectionFields,
  type CheckpointSelections,
} from './selection-state';
import {
  repairTurnWireSchema,
  repairItemWireSchema,
  type RepairTurnWire,
  type RepairItemWire,
} from './history';
import { nonnegativeTokenCountWireSchema } from './run-events';
import { runBudgetCheckpointSchema } from './run-budget';
import {
  binding,
  losslessJsonObjectSchema,
  codeModeCellKeysSchema,
  isCellNumber,
  decode,
  encode,
  losslessJsonValueSchema as jsonValue,
  type JsonValue,
  jsonObject,
  parseNative,
} from './binding';

const stringSchema = z.string();
const nullableStringSchema = stringSchema.nullable();
const optionalStringSchema = stringSchema.optional();
const optionalNullableStringSchema = nullableStringSchema.optional();

const goalSnapshotSchema = z.strictObject({
  thread_id: z.string().min(1),
  // Codex trims Unicode White_Space before counting Rust chars(), rather
  // than JS UTF-16 code units. Keep imported goal intent under that limit.
  objective: z.string().refine((value) => {
    const length = [
      ...value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''),
    ].length;
    return length > 0 && length <= 4000;
  }, 'goal objective must contain 1 to 4000 characters'),
  status: z.enum(['paused', 'complete']),
  token_budget: z.number().int().positive().safe().nullable().optional(),
  tokens_used: z.number().int().nonnegative().safe().optional(),
  time_used_seconds: z.number().int().nonnegative().safe().optional(),
  created_at: z.number().int().nonnegative().safe().nullable().optional(),
  updated_at: z.number().int().nonnegative().safe().nullable().optional(),
});
const checklistSchema = z.object({
  thread_id: stringSchema,
  turn_id: stringSchema,
  explanation: optionalNullableStringSchema,
  plan: z.array(
    z.object({
      step: stringSchema,
      status: z.enum(['pending', 'in_progress', 'completed']),
    }),
  ),
});

/** Last accepted whole-list native update; reading it grants no tool authority. */
export interface ChecklistState {
  readonly threadId: string;
  readonly turnId: string;
  readonly explanation: string | null;
  readonly plan: readonly {
    readonly step: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
  }[];
}

/** @internal Reuse the checkpoint wire validator without reconstructing events. */
export function readChecklist(source: string): ChecklistState | null {
  const state = decode(checklistSchema.nullable(), source);
  return state === null
    ? null
    : Object.freeze({
        threadId: state.thread_id,
        turnId: state.turn_id,
        explanation: state.explanation ?? null,
        plan: Object.freeze(state.plan.map((step) => Object.freeze(step))),
      });
}

export const CODEX_REVISION = '7c2ce90716335c889a5076ded9a630459f9c9899';
const snapshotFileSchema = z.unknown().transform((value, context) => {
  try {
    return captureFile(value) as ReturnType<typeof captureFile> &
      Record<string, JsonValue>;
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Invalid saved file reference',
    });
    return z.NEVER;
  }
});
const snapshotImageSchema = z.unknown().transform((value, context) => {
  try {
    const source = mediaRecord(value);
    if (Object.hasOwn(source, 'detail'))
      throw new TypeError('Detail belongs to the snapshot output');
    return captureImage(source) as ReturnType<typeof captureImage> &
      Record<string, JsonValue>;
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Invalid saved image reference',
    });
    return z.NEVER;
  }
});
const cellOutputSchema = z.union([
  z.strictObject({ File: z.strictObject({ file: snapshotFileSchema }) }),
  z.strictObject({
    RichImage: z.strictObject({
      image: snapshotImageSchema,
      detail: z.enum(['Auto', 'Low', 'High', 'Original']).nullable().optional(),
    }),
  }),
  z.strictObject({ Text: z.strictObject({ text: stringSchema }) }),
  z.strictObject({
    Image: z.strictObject({
      image_url: stringSchema,
      detail: z.enum(['Auto', 'Low', 'High', 'Original']).nullable().optional(),
    }),
  }),
  z.strictObject({ Audio: z.strictObject({ audio_url: stringSchema }) }),
]);
const codeModeSnapshotSchema = z
  .strictObject({
    format_version: z.literal(1),
    // Like native reply IDs, counters retain their exact decimal text in JS.
    next_cell_id: z.string().refine(isCellNumber, 'Invalid next cell ID'),
    stored_values: losslessJsonObjectSchema,
    completed_cells: codeModeCellKeysSchema.pipe(
      z.record(
        stringSchema,
        z.strictObject({
          public_cell_id: optionalNullableStringSchema,
          pending_initial_yield_items: z
            .array(cellOutputSchema)
            .nullable()
            .optional(),
          event: z.union([
            z.strictObject({
              Completed: z.strictObject({
                content_items: z.array(cellOutputSchema),
                error_text: optionalNullableStringSchema,
              }),
            }),
            z.strictObject({
              Terminated: z.strictObject({
                content_items: z.array(cellOutputSchema),
              }),
            }),
          ]),
        }),
      ),
    ),
  })
  .superRefine((snapshot, ctx) => {
    for (const [id, cell] of Object.entries(snapshot.completed_cells)) {
      const publicId = cell.public_cell_id;
      const [generation, wire] = publicId?.startsWith('g')
        ? publicId.slice(1).split(':')
        : [];
      if (
        (isCellNumber(id) &&
          isCellNumber(snapshot.next_cell_id) &&
          BigInt(id) >= BigInt(snapshot.next_cell_id)) ||
        (publicId != null &&
          publicId !== id &&
          !(
            generation &&
            isCellNumber(generation) &&
            BigInt(generation) > 1n &&
            wire === id &&
            publicId === `g${generation}:${id}`
          ))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['completed_cells', id],
          message: 'Invalid retained cell identity',
        });
    }
  });
const childStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('active'),
    thread_id: stringSchema,
    parent_thread_id: stringSchema,
    closed_at: z.null().optional(),
    metadata: jsonObject,
    history: z.array(losslessJsonObjectSchema),
    memory_mode: z.enum(['enabled', 'disabled']).nullable().optional(),
    checklist: checklistSchema.nullable().optional(),
    goal: goalSnapshotSchema.nullable().optional(),
    code_mode: codeModeSnapshotSchema.nullable().optional(),
  }),
  z.object({
    status: z.literal('closed'),
    thread_id: stringSchema,
    parent_thread_id: stringSchema,
    closed_at: z.number().nonnegative().nullable().optional(),
    metadata: jsonObject,
    history: z.array(losslessJsonObjectSchema),
    memory_mode: z.enum(['enabled', 'disabled']).nullable().optional(),
    checklist: checklistSchema.nullable().optional(),
    goal: goalSnapshotSchema.nullable().optional(),
    code_mode: codeModeSnapshotSchema.nullable().optional(),
  }),
]);
const rootState = {
  codex_revision: z.literal(CODEX_REVISION),
  source_session_id: z.string().min(1),
  executor_read_only: z.boolean().optional(),
  executor_policy_digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  history: z.array(losslessJsonObjectSchema),
  pending_actions: z.array(losslessJsonObjectSchema).default([]),
  recovery: z
    .object({
      interrupted_thread_ids: z.array(stringSchema),
      expired_actions: z.array(losslessJsonObjectSchema),
    })
    .nullable()
    .optional(),
};
const treeState = {
  root_metadata: jsonObject,
  root_code_mode: codeModeSnapshotSchema.nullable().optional(),
  root_checklist: checklistSchema.nullable().optional(),
  root_goal: goalSnapshotSchema.nullable().optional(),
  descendants: z.array(childStateSchema).default([]),
  interrupted_thread_ids: z.array(stringSchema).default([]),
  root_tool_origins: z
    .record(
      stringSchema,
      z.object({
        turn_id: z.string().min(1),
        originating_item_id: z.string().min(1),
      }),
    )
    .default({}),
  root_turn_budget: z
    .object({
      turn_id: z.string().min(1),
      admitted: z.string().regex(/^(0|[1-9][0-9]*)$/),
      limit: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .nullable()
    .optional(),
};
const manualContinuationSchema = z.object({
  model_override: z.string().min(1).optional(),
  model_settings_override: losslessJsonObjectSchema.optional(),
  // Outcome metadata remains ordinary data; native restore validates its
  // original completed-response anchor and binds fresh callback receipts.
  tool_outcomes: z
    .object({
      response_observation_id: z.string().min(1),
      call_ids: z.array(z.string().min(1)),
      outcomes: z.array(z.tuple([z.string().min(1), z.boolean()])),
      held_call_ids: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  turn_id: z.string().min(1),
  reply_order: z.array(z.string().min(1)),
  // Legacy format3 stored text function outputs; new checked receipts retain
  // native content and custom output without another JS transform.
  accepted_replies: z.record(
    stringSchema,
    z.union([
      stringSchema,
      z
        .object({
          type: z.literal('response_item'),
          payload: z
            .object({
              type: z.enum([
                'function_call_output',
                'custom_tool_call_output',
                'shell_call_output',
              ]),
              call_id: z.string().min(1),
              output: jsonValue,
            })
            .catchall(jsonValue),
          metadata: jsonObject.optional(),
        })
        .catchall(jsonValue),
      z
        .object({
          type: z.enum([
            'function_call_output',
            'custom_tool_call_output',
            'shell_call_output',
          ]),
          call_id: z.string().min(1),
          output: jsonValue,
        })
        .catchall(jsonValue),
    ]),
  ),
  pending_manual: z
    .array(
      z.object({
        call_id: z.string().min(1),
        name: z.string().min(1),
        namespace: optionalStringSchema,
        arguments: stringSchema,
        shell: z.boolean().optional(),
        approval_required: z.boolean().optional(),
        effective_arguments: optionalStringSchema,
      }),
    )
    .min(1),
});
const manualUsageSchema = z.object({
  requests: nonnegativeTokenCountWireSchema.optional(),
  missingUsageRequests: nonnegativeTokenCountWireSchema.optional(),
  inputTokens: nonnegativeTokenCountWireSchema,
  cachedInputTokens: nonnegativeTokenCountWireSchema,
  cacheWriteInputTokens: nonnegativeTokenCountWireSchema,
  outputTokens: nonnegativeTokenCountWireSchema,
  reasoningOutputTokens: nonnegativeTokenCountWireSchema,
  totalTokens: nonnegativeTokenCountWireSchema,
});
/** @internal Validate the durable diagnostic snapshot before native sealing. */
export const guardrailCheckpointSchema = z.object({
  kind: z.enum(['input', 'output']),
  name: stringSchema,
  agent_profile: nullableStringSchema,
  session_id: stringSchema,
  turn_id: stringSchema,
  subagent_id: optionalStringSchema,
  result: z.object({
    tripwireTriggered: z.boolean(),
    outputInfo: jsonValue.optional(),
  }),
  tool_call: z
    .object({
      tool: z.object({ name: stringSchema, namespace: nullableStringSchema }),
      sessionId: stringSchema,
      turnId: stringSchema,
      callId: nullableStringSchema,
      childId: nullableStringSchema,
      childIncarnation: nullableStringSchema,
      role: nullableStringSchema,
      model: nullableStringSchema,
      route: z.enum(['direct', 'code']),
      outerCallId: nullableStringSchema,
      cellId: nullableStringSchema,
      nestedCallId: nullableStringSchema,
    })
    .optional(),
});
const originalInputSchema = jsonValue.transform((value, context) => {
  try {
    nativeInput(value as UserInput);
    return value as UserInput & JsonValue;
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid original run input' });
    return z.NEVER;
  }
});
const manualContextSchema = z.object({
  guardrail_results: z.array(guardrailCheckpointSchema).optional(),
  original_input: originalInputSchema.optional(),
  remaining_model_steps: z.number().int().nonnegative().safe().optional(),
  instructions: nullableStringSchema,
  result_schemas: z.array(
    z.object({
      name: stringSchema,
      namespace: optionalStringSchema,
      schema: jsonValue,
    }),
  ),
  usage: manualUsageSchema.nullable(),
  model_attempt: modelAttemptSnapshotSchema.optional(),
  model_usage_offset: manualUsageSchema.optional(),
});
const outputContextSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['plain', 'native', 'prompted']),
  budget: z.number().int().nonnegative().safe().default(0),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
const applicationToolOutputSchema = z.strictObject({
  submissionId: stringSchema,
  turnId: stringSchema,
  callId: stringSchema,
  name: stringSchema,
  namespace: nullableStringSchema,
  rootTurnId: optionalStringSchema,
  applicationData: losslessJsonObjectSchema,
});

/** Passive accepted tool data. Display identities never authorize tool execution. */
export type ApplicationToolOutput = z.infer<typeof applicationToolOutputSchema>;

const rememberedApprovalSchema = z.strictObject({
  profile_id: nullableStringSchema,
  profile: z.string().regex(/^[0-9a-f]{64}$/),
  key: z.string().min(1),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
  approve: z.boolean(),
  reason: nullableStringSchema,
});
/** @internal Application-keyed future policy, never a native invocation grant. */
export type RememberedApproval = z.infer<typeof rememberedApprovalSchema>;

const sdkOutputState = {
  remembered_approvals: z
    .array(rememberedApprovalSchema)
    .superRefine((records, ctx) => {
      const keys = records.map((record) =>
        JSON.stringify([record.profile_id, record.key, record.signature]),
      );
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Remembered approvals must identify distinct declarations',
        });
    })
    .optional(),
  output_context: outputContextSchema,
  repair_turns: z.array(repairTurnWireSchema).default([]),
  repair_items: z.array(repairItemWireSchema).default([]),
  application_tool_outputs: z.array(applicationToolOutputSchema).optional(),
  pending_application_tool_outputs: z
    .array(applicationToolOutputSchema)
    .superRefine((outputs, ctx) => {
      const seen = new Set<string>();
      outputs.forEach((output, index) => {
        const key = JSON.stringify([output.turnId, output.callId]);
        if (seen.has(key))
          ctx.addIssue({
            code: 'custom',
            message: 'Duplicate pending application tool output',
            path: [index],
          });
        seen.add(key);
      });
    })
    .optional(),
};
const checkpointTreeSchema = z.object({ ...rootState, ...treeState });
const planProviderPrefix = 'native_agent_siwc_v1_';
const planProviderPattern = /^native_agent_siwc_v1_[a-f0-9]{64}$/;

function validatePlanCheckpointFormat(
  provider: unknown,
  planFormat: boolean,
  ctx: z.RefinementCtx,
): void {
  if (
    planFormat
      ? typeof provider !== 'string' || !planProviderPattern.test(provider)
      : typeof provider === 'string' && provider.startsWith(planProviderPrefix)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid Sign in with ChatGPT checkpoint format',
    });
  }
}

const nativeCheckpointSchema = checkpointTreeSchema
  .extend({
    format_version: z.union([z.literal(2), z.literal(4), z.literal(5)]),
  })
  .catchall(jsonValue)
  .superRefine((state, ctx) => {
    validateCheckpointTree(state, ctx);
    validatePlanCheckpointFormat(
      state.root_metadata.model_provider,
      state.format_version === 5,
      ctx,
    );
    if (
      [
        'output_context',
        'repair_turns',
        'repair_items',
        'application_tool_outputs',
        'remembered_approvals',
        'pending_application_tool_outputs',
        'manual_continuation',
        'manual_context',
        'run_budget',
        'operation_tools',
        'default_tools',
        'default_resource_servers',
        'network_policy_digest',
      ].some((key) => key in state)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Expected a native checkpoint, not an SDK envelope',
      });
    if (
      state.format_version === 2 &&
      (state.root_code_mode != null ||
        state.descendants.some((child) => child.code_mode != null))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Native CodeMode state requires format_version=4',
      });
  });
export type NativeCheckpoint = z.infer<typeof nativeCheckpointSchema>;

/** @internal Decode only checkpoint payloads returned by the native owner. */
export function parseNativeCheckpoint(source: unknown): NativeCheckpoint {
  return nativeCheckpointSchema.parse(
    typeof source === 'string' ? parseNative(source) : source,
  );
}

export const sessionStateSchema = z
  .discriminatedUnion('format_version', [
    z
      .object({
        format_version: z.literal(17),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        network_policy_digest: z
          .string()
          .regex(/^sha256:v1:[a-f0-9]{64}$/)
          .optional(),
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
        run_budget: runBudgetCheckpointSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(18),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        network_policy_digest: z
          .string()
          .regex(/^sha256:v1:[a-f0-9]{64}$/)
          .optional(),
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
        run_budget: runBudgetCheckpointSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(16),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(12),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        network_policy_digest: z.string().regex(/^sha256:v1:[a-f0-9]{64}$/),
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(13),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        network_policy_digest: z.string().regex(/^sha256:v1:[a-f0-9]{64}$/),
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(14),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        network_policy_digest: z.string().regex(/^sha256:v1:[a-f0-9]{64}$/),
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(15),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        network_policy_digest: z.string().regex(/^sha256:v1:[a-f0-9]{64}$/),
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(8),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(9),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(10),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(11),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        ...checkpointSelectionFields,
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(6),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(7),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(2),
        ...rootState,
        ...treeState,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(4),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(5),
        ...rootState,
        ...treeState,
        ...sdkOutputState,
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
      })
      .catchall(jsonValue),
    z
      .object({
        format_version: z.literal(3),
        ...rootState,
        ...treeState,
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
      })
      .catchall(jsonValue),
  ])
  .superRefine((state, ctx) => {
    const aware = state.format_version !== 2 && state.format_version !== 3;
    const budgeted = state.format_version === 17 || state.format_version === 18;
    if (budgeted !== 'run_budget' in state)
      ctx.addIssue({
        code: 'custom',
        message: 'Request budgets require a budgeted manual checkpoint format',
      });
    const plan = state.format_version === 16;
    const network = state.format_version >= 12 && !plan;
    validatePlanCheckpointFormat(state.root_metadata.model_provider, plan, ctx);
    if (
      plan &&
      (state.descendants.length ||
        state.interrupted_thread_ids.length ||
        state.repair_turns.length ||
        state.repair_items.length ||
        'manual_continuation' in state ||
        'manual_context' in state)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Sign in with ChatGPT requires a settled single-agent checkpoint',
      });
    }
    const selected = state.format_version >= 8 && state.format_version <= 11;
    const hasSelection =
      'operation_tools' in state ||
      'default_tools' in state ||
      'default_resource_servers' in state;
    if (!network && !plan && selected !== hasSelection)
      ctx.addIssue({
        code: 'custom',
        message: 'Selection metadata requires a selected checkpoint format',
      });
    if (!network && 'network_policy_digest' in state)
      ctx.addIssue({
        code: 'custom',
        message: 'Network policy identity requires a network checkpoint format',
      });
    if (
      (state.format_version === 8 ||
        state.format_version === 10 ||
        state.format_version === 12 ||
        state.format_version === 14 ||
        state.format_version === 16) &&
      'operation_tools' in state
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Operation selection requires a manual checkpoint',
      });
    if (
      state.format_version !== 6 &&
      state.format_version !== 7 &&
      state.format_version !== 10 &&
      state.format_version !== 11 &&
      state.format_version !== 14 &&
      state.format_version !== 15 &&
      state.format_version !== 18 &&
      (state.root_code_mode != null ||
        state.descendants.some((child) => child.code_mode != null))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'CodeMode state requires a VM checkpoint format',
      });
    if (
      !aware &&
      ['output_context', 'repair_turns', 'repair_items'].some(
        (key) => key in state,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Output context requires an SDK checkpoint format',
      });
    }
    if (aware) {
      const turns = new Map<string, (typeof state.repair_turns)[number]>();
      for (const turn of state.repair_turns) {
        const key = JSON.stringify([turn.sessionId, turn.id]);
        if (
          turn.parentSessionId !== state.source_session_id ||
          turn.sessionId === state.source_session_id ||
          turns.has(key)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Invalid passive repair turn identity',
          });
        }
        turns.set(key, turn);
      }
      for (const item of state.repair_items) {
        const turn = turns.get(
          JSON.stringify([item.sessionId, item.item.turnId]),
        );
        if (
          !turn ||
          item.parentSessionId !== state.source_session_id ||
          item.parentTurnId !== turn.parentTurnId
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Invalid passive repair item identity',
          });
        }
      }
    }

    if (
      state.format_version !== 3 &&
      state.format_version !== 5 &&
      state.format_version !== 7 &&
      state.format_version !== 9 &&
      state.format_version !== 11 &&
      state.format_version !== 13 &&
      state.format_version !== 15 &&
      state.format_version !== 17 &&
      state.format_version !== 18 &&
      ('manual_continuation' in state || 'manual_context' in state)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Manual continuations require a manual checkpoint format',
      });
    }
    if (
      state.format_version === 3 ||
      state.format_version === 5 ||
      state.format_version === 7 ||
      state.format_version === 9 ||
      state.format_version === 11 ||
      state.format_version === 13 ||
      state.format_version === 15 ||
      state.format_version === 17 ||
      state.format_version === 18
    ) {
      const continuation = state.manual_continuation;
      const pending = continuation.pending_manual.map((call) => call.call_id);
      const keys = [...pending, ...Object.keys(continuation.accepted_replies)];
      if (
        new Set(keys).size !== keys.length ||
        new Set(continuation.reply_order).size !==
          continuation.reply_order.length ||
        keys.length !== continuation.reply_order.length ||
        keys.some((id) => !continuation.reply_order.includes(id))
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Manual continuation results must partition the original calls',
        });
      }
      for (const [callId, receipt] of Object.entries(
        continuation.accepted_replies,
      )) {
        if (
          typeof receipt !== 'string' &&
          (receipt.type === 'response_item'
            ? receipt.payload.call_id
            : receipt.call_id) !== callId
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Manual continuation receipt must match its original call ID',
          });
        }
      }
    }
    validateCheckpointTree(state, ctx);
  });
// Saved histories cannot authorize a hosted prompt. Live declarations travel
// separately; the native serializer deliberately omits their references.
function checkpointRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function validateStoredPromptControls(
  state: z.infer<typeof checkpointTreeSchema>,
  ctx: z.RefinementCtx,
): void {
  const check = (controls: unknown, path: (string | number)[]) => {
    if (
      checkpointRecord(checkpointRecord(controls)?.hosted_prompt)?.reference !=
      null
    )
      ctx.addIssue({
        code: 'custom',
        path,
        message: 'Stored hosted prompt references are not authorized',
      });
  };
  const metadata = (value: unknown, path: (string | number)[]) => {
    const profile = checkpointRecord(
      checkpointRecord(value)?.sdk_agent_profile,
    );
    check(checkpointRecord(profile?.model)?.request_controls, path);
  };
  const row = (value: unknown, path: (string | number)[]) => {
    const item = checkpointRecord(value);
    const payload = checkpointRecord(item?.payload);
    if (item?.type === 'response_item') metadata(item.metadata, path);
    if (
      item?.type === 'event_msg' &&
      payload?.type === 'thread_settings_applied'
    )
      check(checkpointRecord(payload.thread_settings)?.request_controls, path);
    if (
      item?.type === 'compacted' &&
      Array.isArray(payload?.replacement_history_metadata)
    )
      payload.replacement_history_metadata.forEach((entry, i) =>
        metadata(entry, [
          ...path,
          'payload',
          'replacement_history_metadata',
          i,
        ]),
      );
  };
  state.history.forEach((value, i) => row(value, ['history', i]));
  state.descendants?.forEach((child, i) =>
    child.history.forEach((value, j) =>
      row(value, ['descendants', i, 'history', j]),
    ),
  );
  const accepted = checkpointRecord(
    checkpointRecord(checkpointRecord(state)?.manual_continuation)
      ?.accepted_replies,
  );
  if (accepted)
    for (const [id, value] of Object.entries(accepted))
      row(value, ['manual_continuation', 'accepted_replies', id]);
}

function validateCheckpointTree(
  state: z.infer<typeof checkpointTreeSchema>,
  ctx: z.RefinementCtx,
): void {
  validateStoredPromptControls(state, ctx);
  if (
    state.root_checklist &&
    state.root_checklist.thread_id !== state.source_session_id
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint checklist thread identity mismatch',
    });
  }
  if (
    state.root_goal &&
    state.root_goal.thread_id !== state.source_session_id
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint goal thread identity mismatch',
    });
  }
  for (const child of state.descendants) {
    if (child.checklist && child.checklist.thread_id !== child.thread_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Checkpoint child checklist thread identity mismatch',
      });
    }
    if (child.goal && child.goal.thread_id !== child.thread_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Checkpoint child goal thread identity mismatch',
      });
    }
  }
  const parents = new Map(
    state.descendants.map((child) => [child.thread_id, child.parent_thread_id]),
  );
  if (
    parents.size !== state.descendants.length ||
    parents.has(state.source_session_id)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint thread IDs must be unique',
    });
  }
  for (const id of state.interrupted_thread_ids) {
    if (id !== state.source_session_id && !parents.has(id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Interrupted thread is outside the native tree',
      });
    }
  }
  for (const id of parents.keys()) {
    const visited = new Set<string>();
    let current = id;
    while (current !== state.source_session_id) {
      const parent = parents.get(current);
      if (visited.has(current) || parent === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Checkpoint descendants must form a rooted tree',
        });
        break;
      }
      visited.add(current);
      current = parent;
    }
  }
}
export type SessionState = z.infer<typeof sessionStateSchema>;

export function isBudgetedManualSessionState(
  state: SessionState | null | undefined,
): state is Extract<SessionState, { format_version: 17 | 18 }> {
  return state?.format_version === 17 || state?.format_version === 18;
}

/** Existing manual owner, with or without an SDK output envelope. */
export type ManualSessionState = Extract<
  SessionState,
  { format_version: 3 | 5 | 7 | 9 | 11 | 13 | 15 | 17 | 18 }
>;
export function isManualSessionState(
  state: SessionState | null | undefined,
): state is ManualSessionState {
  return (
    state?.format_version === 3 ||
    state?.format_version === 5 ||
    state?.format_version === 7 ||
    state?.format_version === 9 ||
    state?.format_version === 11 ||
    state?.format_version === 13 ||
    state?.format_version === 15 ||
    state?.format_version === 17 ||
    state?.format_version === 18
  );
}
export function isOutputAwareState(
  state: SessionState | null | undefined,
): state is Extract<
  SessionState,
  {
    format_version:
      4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18;
  }
> {
  return (
    state?.format_version === 4 ||
    state?.format_version === 5 ||
    state?.format_version === 6 ||
    state?.format_version === 7 ||
    state?.format_version === 8 ||
    state?.format_version === 9 ||
    state?.format_version === 10 ||
    state?.format_version === 11 ||
    state?.format_version === 12 ||
    state?.format_version === 13 ||
    state?.format_version === 14 ||
    state?.format_version === 15 ||
    state?.format_version === 16 ||
    state?.format_version === 17 ||
    state?.format_version === 18
  );
}
/** @internal Read static SDK overlays only after the versioned state validator. */
export function readCheckpointSelections(
  state: SessionState | null | undefined,
): CheckpointSelections {
  if (
    state?.format_version === 8 ||
    state?.format_version === 9 ||
    state?.format_version === 10 ||
    state?.format_version === 11 ||
    state?.format_version === 12 ||
    state?.format_version === 13 ||
    state?.format_version === 14 ||
    state?.format_version === 15 ||
    state?.format_version === 16 ||
    state?.format_version === 17 ||
    state?.format_version === 18
  )
    return {
      ...(state.default_resource_servers === undefined
        ? {}
        : { default_resource_servers: state.default_resource_servers }),
      ...(state.default_tools === undefined
        ? {}
        : { default_tools: state.default_tools }),
      ...(state.operation_tools === undefined
        ? {}
        : { operation_tools: state.operation_tools }),
    };
  return {};
}
/** @internal Validate trusted current selection before acquiring provider resources. */
export function assertOutputState(
  state: SessionState | undefined,
  identity: OutputIdentity,
): void {
  if (!isOutputAwareState(state)) return;
  const saved = state.output_context;
  if (
    saved.version !== identity.version ||
    saved.mode !== identity.mode ||
    saved.budget !== identity.budget ||
    saved.fingerprint !== identity.fingerprint
  ) {
    throw new TypeError('Checkpoint requires matching current output contract');
  }
}
/** @internal Attach passive SDK data; supplied repairs replace the prior snapshot. */
export function withOutputState(
  state: SessionState,
  identity: OutputIdentity,
  prior?: SessionState | null,
  repairs?: OutputRepairs,
): SessionState {
  const receipts = isOutputAwareState(prior)
    ? prior
    : isOutputAwareState(state)
      ? state
      : undefined;
  return sessionStateSchema.parse({
    ...state,
    format_version:
      state.format_version >= 8
        ? state.format_version
        : nativeCheckpoint(state).format_version === 4
          ? isManualSessionState(state)
            ? 7
            : 6
          : isManualSessionState(state)
            ? 5
            : 4,
    ...outputStateFields(state.source_session_id, identity, receipts, repairs),
  });
}

type OutputRepairs = {
  readonly turns: readonly RepairTurnWire[];
  readonly items: readonly RepairItemWire[];
  readonly applicationToolOutputs?: readonly ApplicationToolOutput[];
  readonly pendingApplicationToolOutputs?: readonly ApplicationToolOutput[];
};
function outputStateFields(
  sessionId: string,
  identity: OutputIdentity,
  receipts:
    | Extract<
        SessionState,
        {
          format_version:
            4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18;
        }
      >
    | undefined,
  repairs: OutputRepairs | undefined,
) {
  const applicationOutputs =
    repairs?.applicationToolOutputs ?? receipts?.application_tool_outputs;
  const pendingApplicationOutputs =
    repairs?.pendingApplicationToolOutputs ??
    receipts?.pending_application_tool_outputs;
  return {
    ...(pendingApplicationOutputs !== undefined &&
    (pendingApplicationOutputs.length ||
      receipts?.pending_application_tool_outputs !== undefined)
      ? { pending_application_tool_outputs: pendingApplicationOutputs }
      : {}),
    ...(applicationOutputs?.length
      ? { application_tool_outputs: applicationOutputs }
      : {}),
    output_context: identity,
    repair_turns: (repairs?.turns ?? receipts?.repair_turns ?? []).map(
      (turn) => ({ ...turn, parentSessionId: sessionId }),
    ),
    repair_items: (repairs?.items ?? receipts?.repair_items ?? []).map(
      (item) => ({ ...item, parentSessionId: sessionId }),
    ),
  };
}

/** @internal Assemble native data with the captured SDK output contract exactly once. */
export function fromNativeCheckpoint(
  state: NativeCheckpoint,
  identity: OutputIdentity,
  prior?: SessionState | null,
  repairs?: OutputRepairs,
  manual?: {
    manual_continuation: unknown;
    manual_context: unknown;
    run_budget?: unknown;
  },
  selection: CheckpointSelections = {},
  networkPolicy: string | undefined = undefined,
  executorReadOnly = false,
): SessionState {
  return sessionStateSchema.parse({
    ...state,
    ...manual,
    ...selection,
    ...(executorReadOnly ? { executor_read_only: true } : {}),
    format_version:
      manual?.run_budget !== undefined
        ? state.format_version === 4
          ? 18
          : 17
        : state.format_version === 5
          ? 16
          : networkPolicy === undefined
            ? (state.format_version === 4 ? 6 : 4) +
              (manual ? 1 : 0) +
              (selection.operation_tools !== undefined ||
              selection.default_tools !== undefined ||
              selection.default_resource_servers !== undefined
                ? 4
                : 0)
            : (state.format_version === 4 ? 14 : 12) + (manual ? 1 : 0),
    ...(networkPolicy === undefined
      ? {}
      : { network_policy_digest: networkPolicy }),
    ...outputStateFields(
      state.source_session_id,
      identity,
      isOutputAwareState(prior) ? prior : undefined,
      repairs,
    ),
  });
}
/** @internal Strip SDK overlays while preserving the native VM codec version. */
export function nativeCheckpoint(state: SessionState) {
  const {
    manual_continuation: _continuation,
    manual_context: _context,
    run_budget: _budget,
    output_context: _output,
    operation_tools: _operation,
    default_tools: _defaults,
    default_resource_servers: _resourceServers,
    network_policy_digest: _network,
    executor_read_only: _readOnly,
    repair_turns: _turns,
    repair_items: _items,
    application_tool_outputs: _applicationOutputs,
    remembered_approvals: _rememberedApprovals,
    pending_application_tool_outputs: _pendingApplicationOutputs,
    ...checkpoint
  } = state;
  return {
    ...checkpoint,
    format_version:
      state.format_version === 16
        ? 5
        : state.format_version === 6 ||
            state.format_version === 7 ||
            state.format_version === 10 ||
            state.format_version === 11 ||
            state.format_version === 14 ||
            state.format_version === 15 ||
            state.format_version === 18
          ? 4
          : 2,
  };
}

/** Validate a serialized session checkpoint read from application storage. */
export function parseSessionState(source: string): SessionState {
  try {
    return sessionStateSchema.parse(parseNative(source));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError('Invalid native session checkpoint JSON');
    }
    throw error;
  }
}

/** Read the latest accepted instructions from a checkpoint in trusted application storage. */
export async function readSessionInstructions(
  state: SessionState,
): Promise<string> {
  const native = await binding();
  if (state.codex_revision !== native.CODEX_REVISION)
    throw new TypeError('Checkpoint belongs to an unsupported Codex revision');
  return native._read_session_instructions(encode(state.history));
}

/** @internal Reject changed authority before reconnecting to the executor. */
export function assertCheckpointNetworkPolicy(
  state: SessionState | null | undefined,
  current: string | undefined,
): void {
  if (state == null) return;
  const saved =
    state.format_version >= 12 ? state.network_policy_digest : undefined;
  if (saved !== current)
    throw new TypeError(
      'Checkpoint and Environment must agree on the network policy',
    );
}
