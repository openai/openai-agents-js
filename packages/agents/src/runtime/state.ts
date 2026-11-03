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
import {
  binding,
  losslessJsonObjectSchema,
  codeModeCellKeysSchema,
  isCellNumber,
  decode,
  encode,
  jsonValue,
  jsonObject,
  parseNative,
} from './binding';
const goalSnapshotSchema = z
  .object({
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
  })
  .strict();
const checklistSchema = z.object({
  thread_id: z.string(),
  turn_id: z.string(),
  explanation: z.string().nullable().optional(),
  plan: z.array(
    z.object({
      step: z.string(),
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
const cellOutputSchema = z.union([
  z.object({ Text: z.object({ text: z.string() }).strict() }).strict(),
  z
    .object({
      Image: z
        .object({
          image_url: z.string(),
          detail: z
            .enum(['Auto', 'Low', 'High', 'Original'])
            .nullable()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ Audio: z.object({ audio_url: z.string() }).strict() }).strict(),
]);
const codeModeSnapshotSchema = z
  .object({
    format_version: z.literal(1),
    // Like native reply IDs, counters retain their exact decimal text in JS.
    next_cell_id: z.string().refine(isCellNumber, 'Invalid next cell ID'),
    stored_values: losslessJsonObjectSchema,
    completed_cells: codeModeCellKeysSchema.pipe(
      z.record(
        z.string(),
        z
          .object({
            public_cell_id: z.string().nullable().optional(),
            pending_initial_yield_items: z
              .array(cellOutputSchema)
              .nullable()
              .optional(),
            event: z.union([
              z
                .object({
                  Completed: z
                    .object({
                      content_items: z.array(cellOutputSchema),
                      error_text: z.string().nullable().optional(),
                    })
                    .strict(),
                })
                .strict(),
              z
                .object({
                  Terminated: z
                    .object({ content_items: z.array(cellOutputSchema) })
                    .strict(),
                })
                .strict(),
            ]),
          })
          .strict(),
      ),
    ),
  })
  .strict()
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
    thread_id: z.string(),
    parent_thread_id: z.string(),
    closed_at: z.null().optional(),
    metadata: jsonObject,
    history: z.array(jsonObject),
    memory_mode: z.enum(['enabled', 'disabled']).nullable().optional(),
    checklist: checklistSchema.nullable().optional(),
    goal: goalSnapshotSchema.nullable().optional(),
    code_mode: codeModeSnapshotSchema.nullable().optional(),
  }),
  z.object({
    status: z.literal('closed'),
    thread_id: z.string(),
    parent_thread_id: z.string(),
    closed_at: z.number().nonnegative().nullable().optional(),
    metadata: jsonObject,
    history: z.array(jsonObject),
    memory_mode: z.enum(['enabled', 'disabled']).nullable().optional(),
    checklist: checklistSchema.nullable().optional(),
    goal: goalSnapshotSchema.nullable().optional(),
    code_mode: codeModeSnapshotSchema.nullable().optional(),
  }),
]);
const rootState = {
  codex_revision: z.literal(CODEX_REVISION),
  source_session_id: z.string().min(1),
  history: z.array(jsonObject),
  pending_actions: z.array(jsonObject).default([]),
  recovery: z
    .object({
      interrupted_thread_ids: z.array(z.string()),
      expired_actions: z.array(jsonObject),
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
  interrupted_thread_ids: z.array(z.string()).default([]),
  root_tool_origins: z
    .record(
      z.string(),
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
  turn_id: z.string().min(1),
  reply_order: z.array(z.string().min(1)),
  accepted_replies: z.record(
    z.string(),
    z
      .object({
        type: z.enum(['function_call_output', 'custom_tool_call_output']),
        call_id: z.string().min(1),
        output: jsonValue,
      })
      .catchall(jsonValue),
  ),
  pending_manual: z
    .array(
      z.object({
        call_id: z.string().min(1),
        name: z.string().min(1),
        namespace: z.string().optional(),
        arguments: z.string(),
      }),
    )
    .min(1),
});
const manualContextSchema = z.object({
  remaining_model_steps: z.number().int().nonnegative().safe().optional(),
  instructions: z.string().nullable(),
  result_schemas: z.array(
    z.object({
      name: z.string(),
      namespace: z.string().optional(),
      schema: jsonValue,
    }),
  ),
  usage: z
    .object({
      inputTokens: nonnegativeTokenCountWireSchema,
      cachedInputTokens: nonnegativeTokenCountWireSchema,
      cacheWriteInputTokens: nonnegativeTokenCountWireSchema,
      outputTokens: nonnegativeTokenCountWireSchema,
      reasoningOutputTokens: nonnegativeTokenCountWireSchema,
      totalTokens: nonnegativeTokenCountWireSchema,
    })
    .nullable(),
});
const outputContextSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['plain', 'native', 'prompted']),
    budget: z.number().int().nonnegative().safe().default(0),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const sdkOutputState = {
  output_context: outputContextSchema,
  repair_turns: z.array(repairTurnWireSchema).default([]),
  repair_items: z.array(repairItemWireSchema).default([]),
};
const checkpointTreeSchema = z.object({ ...rootState, ...treeState });
const nativeCheckpointSchema = checkpointTreeSchema
  .extend({ format_version: z.union([z.literal(2), z.literal(4)]) })
  .catchall(jsonValue)
  .superRefine((state, ctx) => {
    validateCheckpointTree(state, ctx);
    if (
      [
        'output_context',
        'repair_turns',
        'repair_items',
        'manual_continuation',
        'manual_context',
        'operation_tools',
        'default_tools',
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

const checkpointFields = {
  native: nativeCheckpointSchema,
  ...sdkOutputState,
  default_tools: checkpointSelectionFields.default_tools,
  network_policy_digest: z
    .string()
    .regex(/^sha256:v1:[a-f0-9]{64}$/)
    .nullable(),
};
export const sessionStateSchema = z
  .discriminatedUnion(
    'kind',
    [
      z.strictObject({ kind: z.literal('idle'), ...checkpointFields }),
      z.strictObject({
        kind: z.literal('manual'),
        ...checkpointFields,
        manual_continuation: manualContinuationSchema,
        manual_context: manualContextSchema,
        operation_tools: checkpointSelectionFields.operation_tools,
      }),
    ],
    {
      error:
        'Expected an idle or manual checkpoint. Open older flat checkpoints with the SDK that saved them.',
    },
  )
  .superRefine((state, ctx) => {
    const turns = new Map<string, (typeof state.repair_turns)[number]>();
    for (const turn of state.repair_turns) {
      const key = JSON.stringify([turn.sessionId, turn.id]);
      if (
        turn.parentSessionId !== state.native.source_session_id ||
        turn.sessionId === state.native.source_session_id ||
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
        item.parentSessionId !== state.native.source_session_id ||
        item.parentTurnId !== turn.parentTurnId
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid passive repair item identity',
        });
      }
    }
    if (state.kind === 'manual') {
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
        if (receipt.call_id !== callId) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Manual continuation receipt must match its original call ID',
          });
        }
      }
    }
  });
function validateCheckpointTree(
  state: z.infer<typeof checkpointTreeSchema>,
  ctx: z.RefinementCtx,
): void {
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

export type ManualSessionState = Extract<SessionState, { kind: 'manual' }>;
export function isManualSessionState(
  state: SessionState | null | undefined,
): state is ManualSessionState {
  return state?.kind === 'manual';
}
/** @internal Validate trusted current selection before acquiring provider resources. */
export function assertOutputState(
  state: SessionState | undefined,
  identity: OutputIdentity,
): void {
  if (!state) return;
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
/** @internal Build the SDK envelope around the native codec payload. */
export function fromNativeCheckpoint(
  state: NativeCheckpoint,
  identity: OutputIdentity,
  {
    repairs,
    manual,
    selection,
    networkPolicy,
  }: {
    repairs?: {
      readonly turns: readonly RepairTurnWire[];
      readonly items: readonly RepairItemWire[];
    };
    manual?: { manual_continuation: unknown; manual_context: unknown };
    selection?: CheckpointSelections;
    networkPolicy?: string;
  } = {},
): SessionState {
  return sessionStateSchema.parse({
    native: state,
    kind: manual ? 'manual' : 'idle',
    ...manual,
    ...selection,
    network_policy_digest: networkPolicy ?? null,
    output_context: identity,
    repair_turns:
      repairs?.turns.map((turn) => ({
        ...turn,
        parentSessionId: state.source_session_id,
      })) ?? [],
    repair_items:
      repairs?.items.map((item) => ({
        ...item,
        parentSessionId: state.source_session_id,
      })) ?? [],
  });
}
/** @internal Hide arbitrary saved keys reported by strict-object errors. */
export function validateSessionState(input: unknown): SessionState {
  const result = sessionStateSchema.safeParse(input);
  if (result.success) return result.data;
  if (result.error.issues.some((issue) => issue.code === 'unrecognized_keys'))
    throw new TypeError('Checkpoint contains unexpected fields');
  throw result.error;
}
/** Validate a serialized session checkpoint read from application storage. */
export function parseSessionState(source: string): SessionState {
  try {
    return validateSessionState(parseNative(source));
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
  if (state.native.codex_revision !== native.CODEX_REVISION)
    throw new TypeError('Checkpoint belongs to an unsupported Codex revision');
  return native._read_session_instructions(encode(state.native.history));
}

/** @internal Reject changed authority before reconnecting to the executor. */
export function assertCheckpointNetworkPolicy(
  state: SessionState | null | undefined,
  current: string | undefined,
): void {
  if (state == null) return;
  if (state.network_policy_digest !== (current ?? null))
    throw new TypeError(
      'Checkpoint and Environment must agree on the network policy',
    );
}
