import {
  captureModelAttemptSnapshot,
  type CapturedModelAttempt,
} from './model-attempts';
import { responseContent } from './input';
import { z } from 'zod';
import {
  projectResponseFactRecord,
  responseFactRecordSchema,
  type RecordedResponseFact,
} from './response-facts';
import type { HostedToolItem } from './hosted-tools';
import {
  projectTurnReceipt,
  repairTurnReceiptSchema,
  type TurnReceipt,
} from './turn-receipt';
import {
  addTokenCounts,
  addRunUsage,
  mergeRunUsage,
  runUsageSnapshot,
  runUsageToWire,
  type RunUsage,
  nonnegativeTokenCountWireSchema,
  parseTokenCount,
  tokenCountToWire,
  type TokenCount,
  type TokenCountWire,
} from './run-events';
import {
  losslessJsonObjectSchema as jsonObject,
  losslessJsonValueSchema as jsonValue,
  type JsonObject,
  type JsonValue,
} from './binding';

const stringSchema = z.string();
const nullableStringSchema = stringSchema.nullable();
const optionalStringSchema = stringSchema.optional();
const optionalNullableStringSchema = nullableStringSchema.optional();

export const threadHistorySchema = z.array(
  z
    .object({
      type: stringSchema,
      payload: jsonObject,
    })
    .catchall(jsonValue),
);
export type ThreadHistory = z.infer<typeof threadHistorySchema>;

/** Safe counters remain numbers; larger exact counts are bigint. */
export interface RecordedTokenUsage {
  inputTokens: TokenCount;
  inputTokensDetails: {
    cachedTokens: TokenCount;
    /** Omitted when the cache-write count is unavailable or incomplete. */
    cacheWriteTokens?: TokenCount;
  };
  outputTokens: TokenCount;
  outputTokensDetails: { reasoningTokens: TokenCount };
  totalTokens: TokenCount;
}

export interface RecordedTokenUsageWire {
  inputTokens: TokenCountWire;
  inputTokensDetails: {
    cachedTokens: TokenCountWire;
    cacheWriteTokens?: TokenCountWire;
  };
  outputTokens: TokenCountWire;
  outputTokensDetails: { reasoningTokens: TokenCountWire };
  totalTokens: TokenCountWire;
}

/** Counters received from the provider; absent fields remain unknown. */
export interface ReceivedTokenUsage {
  inputTokens?: TokenCount;
  inputTokensDetails?: {
    cachedTokens?: TokenCount;
    cacheWriteTokens?: TokenCount;
  };
  outputTokens?: TokenCount;
  outputTokensDetails?: { reasoningTokens?: TokenCount };
  totalTokens?: TokenCount;
}

export interface ReceivedTokenUsageWire {
  inputTokens?: TokenCountWire;
  inputTokensDetails?: {
    cachedTokens?: TokenCountWire;
    cacheWriteTokens?: TokenCountWire;
  };
  outputTokens?: TokenCountWire;
  outputTokensDetails?: { reasoningTokens?: TokenCountWire };
  totalTokens?: TokenCountWire;
}

/** Retained provider facts, independent of SDK acceptance and turn success. */
export interface RecordedResponse {
  /** Native observation identity; unavailable for unlinked legacy records. */
  id: string | null;
  threadId: string;
  turnId: string;
  /** Provider response body ID, or null when unavailable. */
  responseId: string | null;
  /** Actual provider request header; absent on profiles that cannot supply it. */
  upstreamRequestId?: string;
  status?: 'completed' | 'incomplete' | 'failed';
  incompleteReason?:
    'content_filter' | 'max_output_tokens' | 'interrupted' | 'unknown';
  /** Legacy normalized zeros do not prove the provider supplied those fields. */
  usageSource: 'received' | 'native_normalized';
  usage: ReceivedTokenUsage | null;
}
export type RecordedResponseWire = Omit<RecordedResponse, 'usage'> & {
  usage: ReceivedTokenUsageWire | null;
};

export interface Failure {
  code: string;
  message: string | null;
  httpStatusCode?: number;
}
export type HistoryTurn = {
  id: string;
  object: 'agent.session.turn';
  sessionId: string;
  subagentId: string | null;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error: Failure | null;
  usage: RecordedTokenUsage | null;
  /** Retained native-attempt totals; unavailable without native attempt records. */
  runUsage?: RunUsage;
  /** Retained observations, not complete provider-attempt or charge coverage. */
  responses?: RecordedResponse[];
  responseFacts?: RecordedResponseFact[];
  receipt?: TurnReceipt;
};
export type RecordedTurn = HistoryTurn & {
  parentSessionId?: string;
  parentTurnId?: string;
};
/** JSON-safe observational turn data for history/receipt owners, not Core checkpoints. */
export type RecordedTurnWire = Omit<
  RecordedTurn,
  'usage' | 'responses' | 'receipt' | 'runUsage'
> & {
  usage: RecordedTokenUsageWire | null;
  runUsage?: { readonly [Key in keyof RunUsage]: TokenCountWire };
  responses?: RecordedResponseWire[];
  receipt?: z.infer<typeof repairTurnReceiptSchema>;
};

/** @internal Passive terminal observations; never Core history or grants. */
export type RepairTurnWire = RecordedTurnWire & {
  subagentId: null;
  status: 'completed' | 'failed' | 'cancelled';
  parentSessionId: string;
  parentTurnId: string;
};
const receivedUsageWireSchema = z.strictObject({
  inputTokens: nonnegativeTokenCountWireSchema.optional(),
  inputTokensDetails: z
    .strictObject({
      cachedTokens: nonnegativeTokenCountWireSchema.optional(),
      cacheWriteTokens: nonnegativeTokenCountWireSchema.optional(),
    })
    .optional(),
  outputTokens: nonnegativeTokenCountWireSchema.optional(),
  outputTokensDetails: z
    .strictObject({
      reasoningTokens: nonnegativeTokenCountWireSchema.optional(),
    })
    .optional(),
  totalTokens: nonnegativeTokenCountWireSchema.optional(),
});
const recordedResponseWireSchema = z.strictObject({
  id: z.string().min(1).nullable(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  responseId: nullableStringSchema,
  upstreamRequestId: optionalStringSchema,
  status: z.enum(['completed', 'incomplete', 'failed']).optional(),
  incompleteReason: z
    .enum(['content_filter', 'max_output_tokens', 'interrupted', 'unknown'])
    .optional(),
  usageSource: z.enum(['received', 'native_normalized']),
  usage: receivedUsageWireSchema.nullable(),
});
export const repairTurnWireSchema = z
  .strictObject({
    id: z.string().min(1),
    object: z.literal('agent.session.turn'),
    sessionId: z.string().min(1),
    subagentId: z.null(),
    status: z.enum(['completed', 'failed', 'cancelled']),
    createdAt: z.number().nullable(),
    startedAt: z.number().nullable(),
    completedAt: z.number().nullable(),
    error: z
      .strictObject({
        code: stringSchema,
        message: nullableStringSchema,
        httpStatusCode: z.number().optional(),
      })
      .nullable(),
    usage: z
      .strictObject({
        inputTokens: nonnegativeTokenCountWireSchema,
        inputTokensDetails: z.strictObject({
          cachedTokens: nonnegativeTokenCountWireSchema,
          cacheWriteTokens: nonnegativeTokenCountWireSchema.optional(),
        }),
        outputTokens: nonnegativeTokenCountWireSchema,
        outputTokensDetails: z.strictObject({
          reasoningTokens: nonnegativeTokenCountWireSchema,
        }),
        totalTokens: nonnegativeTokenCountWireSchema,
      })
      .nullable(),
    runUsage: z
      .strictObject({
        requests: nonnegativeTokenCountWireSchema,
        missingUsageRequests: nonnegativeTokenCountWireSchema,
        inputTokens: nonnegativeTokenCountWireSchema,
        cachedInputTokens: nonnegativeTokenCountWireSchema,
        cacheWriteInputTokens: nonnegativeTokenCountWireSchema,
        outputTokens: nonnegativeTokenCountWireSchema,
        reasoningOutputTokens: nonnegativeTokenCountWireSchema,
        totalTokens: nonnegativeTokenCountWireSchema,
      })
      .optional(),
    responses: z.array(recordedResponseWireSchema).optional(),
    responseFacts: z.array(responseFactRecordSchema).optional(),
    receipt: repairTurnReceiptSchema.optional(),
    parentSessionId: z.string().min(1),
    parentTurnId: z.string().min(1),
  })
  .refine(
    (turn) =>
      turn.receipt === undefined ||
      (turn.receipt.threadId === turn.sessionId &&
        turn.receipt.turnId === turn.id),
    'Repair receipt identity must match its recorded turn',
  )
  .refine(
    (turn) =>
      turn.responses === undefined ||
      turn.responses.every((response) => response.turnId === turn.id),
    'Repair response identity must match its recorded turn',
  ) satisfies z.ZodType<RepairTurnWire>;
export const repairItemWireSchema = z.strictObject({
  parentSessionId: z.string().min(1),
  parentTurnId: z.string().min(1),
  sessionId: z.string().min(1),
  item: z
    .object({
      id: z.string().min(1),
      turnId: z.string().min(1),
      type: z.string().min(1),
    })
    .catchall(jsonValue),
});
export type RepairItemWire = z.infer<typeof repairItemWireSchema>;

function mapRecordedUsage<T>(
  usage: RecordedTokenUsage | RecordedTokenUsageWire,
  convert: (value: number | bigint | string) => T,
) {
  return {
    inputTokens: convert(usage.inputTokens),
    inputTokensDetails: {
      cachedTokens: convert(usage.inputTokensDetails.cachedTokens),
      ...(usage.inputTokensDetails.cacheWriteTokens === undefined
        ? {}
        : {
            cacheWriteTokens: convert(
              usage.inputTokensDetails.cacheWriteTokens,
            ),
          }),
    },
    outputTokens: convert(usage.outputTokens),
    outputTokensDetails: {
      reasoningTokens: convert(usage.outputTokensDetails.reasoningTokens),
    },
    totalTokens: convert(usage.totalTokens),
  };
}

function mapReceivedUsage<T>(
  usage: ReceivedTokenUsage | ReceivedTokenUsageWire,
  convert: (value: number | bigint | string) => T,
) {
  return {
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: convert(usage.inputTokens) }),
    ...(usage.inputTokensDetails === undefined
      ? {}
      : {
          inputTokensDetails: {
            ...(usage.inputTokensDetails.cachedTokens === undefined
              ? {}
              : {
                  cachedTokens: convert(usage.inputTokensDetails.cachedTokens),
                }),
            ...(usage.inputTokensDetails.cacheWriteTokens === undefined
              ? {}
              : {
                  cacheWriteTokens: convert(
                    usage.inputTokensDetails.cacheWriteTokens,
                  ),
                }),
          },
        }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: convert(usage.outputTokens) }),
    ...(usage.outputTokensDetails === undefined
      ? {}
      : {
          outputTokensDetails: {
            ...(usage.outputTokensDetails.reasoningTokens === undefined
              ? {}
              : {
                  reasoningTokens: convert(
                    usage.outputTokensDetails.reasoningTokens,
                  ),
                }),
          },
        }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: convert(usage.totalTokens) }),
  };
}

export function recordedTurnToWire(turn: RecordedTurn): RecordedTurnWire {
  const { responses, receipt, runUsage, ...rest } = turn;
  return {
    ...rest,
    ...(runUsage === undefined
      ? {}
      : {
          runUsage: {
            ...runUsageToWire(runUsage),
            requests: tokenCountToWire(runUsage.requests),
            missingUsageRequests: tokenCountToWire(
              runUsage.missingUsageRequests,
            ),
          },
        }),
    ...(responses === undefined
      ? {}
      : {
          responses: responses.map((response) => ({
            ...response,
            usage:
              response.usage === null
                ? null
                : mapReceivedUsage(response.usage, (value) =>
                    tokenCountToWire(parseTokenCount(value)),
                  ),
          })),
        }),
    ...(receipt
      ? {
          receipt: {
            ...receipt,
            executors: receipt.executors?.length === 0 ? [] : null,
          },
        }
      : {}),
    usage:
      turn.usage === null
        ? null
        : mapRecordedUsage(turn.usage, (value) =>
            tokenCountToWire(parseTokenCount(value)),
          ),
  };
}

export function recordedTurnFromWire(turn: RecordedTurnWire): RecordedTurn {
  const { responses, runUsage, ...rest } = turn;
  return {
    ...rest,
    ...(runUsage === undefined
      ? {}
      : {
          runUsage: runUsageSnapshot(
            addRunUsage(null, {
              input_tokens: runUsage.inputTokens,
              cached_input_tokens: runUsage.cachedInputTokens,
              cache_write_input_tokens: runUsage.cacheWriteInputTokens,
              output_tokens: runUsage.outputTokens,
              reasoning_output_tokens: runUsage.reasoningOutputTokens,
              total_tokens: runUsage.totalTokens,
            }),
            parseTokenCount(runUsage.requests),
            parseTokenCount(runUsage.missingUsageRequests),
          ),
        }),
    ...(responses === undefined
      ? {}
      : {
          responses: responses.map((response) => ({
            ...response,
            usage:
              response.usage === null
                ? null
                : mapReceivedUsage(response.usage, parseTokenCount),
          })),
        }),
    usage:
      turn.usage === null
        ? null
        : mapRecordedUsage(turn.usage, parseTokenCount),
  };
}

export type ItemStatus = 'in_progress' | 'completed' | 'failed' | 'incomplete';
type ItemIdentity = { id: string; turnId: string };
const outputTextPartSchema = z.object({
  type: z.literal('output_text'),
  text: stringSchema,
  annotations: jsonValue.optional(),
});
/** Provider annotations use offsets into this part's original text. */
export type OutputTextPart = z.infer<typeof outputTextPartSchema>;
type InputTextPart = { type: 'input_text'; text: string };
// History is passive canonical JSON, not a new user-input capability. Preserve
// provider fields without requiring callers to construct these observed DTOs.
const historyAudioPartSchema = z
  .object({ type: z.literal('input_audio'), audio_url: stringSchema })
  .catchall(jsonValue);
const historyImagePartSchema = z
  .object({
    type: z.literal('input_image'),
    image_url: optionalStringSchema,
    file_id: optionalStringSchema,
    detail: z.enum(['auto', 'low', 'high', 'original']).nullable().optional(),
  })
  .catchall(jsonValue);
const historyFilePartSchema = z
  .object({
    type: z.literal('input_file'),
    file_id: optionalStringSchema,
    file_data: optionalStringSchema,
    file_url: optionalStringSchema,
    filename: optionalNullableStringSchema,
  })
  .catchall(jsonValue);
type AudioPart = z.infer<typeof historyAudioPartSchema>;
type ImagePart = z.infer<typeof historyImagePartSchema>;
type FilePart = z.infer<typeof historyFilePartSchema>;
const webSearchSourcesSchema = z.array(
  z.object({ type: z.literal('url'), url: stringSchema }),
);
export type WebSearchSource = z.infer<typeof webSearchSourcesSchema>[number];
export type WebSearchAction =
  | {
      type: 'search';
      query: string | null;
      queries: string[] | null;
      /** URLs reported by the provider, when available. */
      sources?: WebSearchSource[];
    }
  | { type: 'open_page'; url: string | null }
  | { type: 'find_in_page'; url: string | null; pattern: string | null }
  | { type: 'other' };

export type SessionItem = ItemIdentity &
  (
    | HostedToolItem
    | {
        type: 'message';
        role: 'user' | 'assistant';
        status: ItemStatus;
        phase: string | null;
        content: (
          InputTextPart | OutputTextPart | ImagePart | FilePart | AudioPart
        )[];
        /** Visible assistant text when Core removed markup from the original parts. */
        displayText?: string;
      }
    | {
        type: 'reasoning';
        summary: { type: 'summary_text'; text: string }[];
        status: ItemStatus | null;
      }
    | {
        type: 'function_call';
        callId: string;
        name: string;
        arguments: JsonValue;
        status: ItemStatus;
      }
    | {
        type: 'function_call_output';
        callId: string;
        status: ItemStatus;
        reconciliation?: 'applied' | 'not_applied';
        output: JsonValue;
        error: string | null;
      }
    | {
        type: 'local_shell_call';
        callId: string | null;
        action: JsonObject;
        status: ItemStatus;
      }
    | {
        type: 'tool_search_call';
        callId: string | null;
        execution: string;
        arguments: JsonValue;
        status: ItemStatus;
      }
    | {
        type: 'tool_search_output';
        callId: string | null;
        execution: string;
        tools: JsonValue[];
        status: ItemStatus;
      }
    | {
        type: 'mcp_call';
        threadId?: string;
        callId?: string | null;
        serverLabel: string;
        name: string;
        arguments: JsonValue;
        status: ItemStatus;
        output: JsonValue;
        error: JsonValue;
      }
    | {
        type: 'command_execution';
        threadId?: string;
        callId?: string;
        argv?: string[];
        command: string;
        cwd: string | null;
        status: ItemStatus;
        output: string | null;
        exitCode: number | null;
        durationMs: number | null;
      }
    | {
        type: 'file_change';
        threadId: string;
        callId: string;
        status: ItemStatus;
        changes: Record<string, PatchChange>;
        stdout: string | null;
        stderr: string | null;
      }
    | {
        type: 'web_search_call';
        status: ItemStatus;
        action: WebSearchAction | null;
        results?: JsonValue[];
      }
    | {
        type: 'create_subagent_call';
        status: ItemStatus;
        agentId: string;
        subagentId: string | null;
      }
    | {
        type: 'wait_for_subagents_call';
        status: ItemStatus;
        senderAgentId: string;
      }
    | {
        type:
          | 'send_subagent_input_call'
          | 'resume_subagent_call'
          | 'interrupt_subagent_call'
          | 'close_subagent_call';
        status: ItemStatus;
        senderAgentId: string;
        recipientAgentId: string;
      }
  );

/** A completed native hosted search call or an assistant message with annotations. */
export type SearchItem = Extract<
  SessionItem,
  { type: 'web_search_call' | 'message' }
>;
const patchContentChanges = [
  z.object({ type: z.literal('add'), content: stringSchema }),
  z.object({ type: z.literal('delete'), content: stringSchema }),
] as const;
const patchChangeSchema = z.discriminatedUnion('type', [
  ...patchContentChanges,
  z.object({
    type: z.literal('update'),
    unifiedDiff: stringSchema,
    movePath: nullableStringSchema,
  }),
]);
const nativePatchChangeSchema = z
  .discriminatedUnion('type', [
    ...patchContentChanges,
    z.object({
      type: z.literal('update'),
      unified_diff: stringSchema,
      move_path: nullableStringSchema,
    }),
  ])
  .transform((change) =>
    change.type === 'update'
      ? {
          type: change.type,
          unifiedDiff: change.unified_diff,
          movePath: change.move_path,
        }
      : change,
  );
export type PatchChange = z.infer<typeof patchChangeSchema>;
export type ExecutionItem = Extract<
  SessionItem,
  { type: 'command_execution' | 'file_change' | 'mcp_call' }
> & { threadId: string; callId: string };

/** The raw recorded source remains available to lower-level history consumers. */
export type HistoryItem = SessionItem & { data: JsonObject };

const repairItemStatusSchema = z.enum([
  'in_progress',
  'completed',
  'failed',
  'incomplete',
]);
const hostedToolStatusSchema = z.enum([
  'in_progress',
  'searching',
  'interpreting',
  'generating',
  'completed',
  'incomplete',
  'failed',
]);
const shellToolStatusSchema = hostedToolStatusSchema.or(z.literal('unknown'));
const repairItemProjectionSchema = z.intersection(
  z.object({ id: z.string().min(1), turnId: z.string().min(1) }),
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('message'),
      role: z.enum(['user', 'assistant']),
      status: repairItemStatusSchema,
      phase: nullableStringSchema,
      displayText: optionalStringSchema,
      content: z.array(
        z.discriminatedUnion('type', [
          z.object({
            type: z.literal('input_text'),
            text: stringSchema,
          }),
          outputTextPartSchema,
          historyAudioPartSchema,
          historyImagePartSchema,
          historyFilePartSchema,
        ]),
      ),
    }),
    z.object({
      type: z.literal('reasoning'),
      summary: z.array(
        z.object({ type: z.literal('summary_text'), text: stringSchema }),
      ),
      status: repairItemStatusSchema.nullable(),
    }),
    z.object({
      type: z.literal('function_call'),
      callId: stringSchema,
      name: stringSchema,
      arguments: jsonValue,
      status: repairItemStatusSchema,
    }),
    z.object({
      type: z.literal('function_call_output'),
      callId: stringSchema,
      reconciliation: z.enum(['applied', 'not_applied']).optional(),
      status: repairItemStatusSchema,
      output: jsonValue,
      error: nullableStringSchema,
    }),
    z.object({
      type: z.literal('mcp_call'),
      threadId: optionalStringSchema,
      callId: optionalNullableStringSchema,
      serverLabel: stringSchema,
      name: stringSchema,
      arguments: jsonValue,
      status: repairItemStatusSchema,
      output: jsonValue,
      error: jsonValue,
      turn_id: optionalStringSchema,
      provider_data: jsonObject.optional(),
    }),
    z.object({
      type: z.literal('mcp_list_tools'),
      turn_id: stringSchema,
      status: hostedToolStatusSchema,
      provider_data: jsonObject,
      server_label: stringSchema,
      tools: jsonValue,
      error: jsonValue,
    }),
    z.object({
      type: z.literal('command_execution'),
      threadId: optionalStringSchema,
      callId: optionalStringSchema,
      argv: z.array(stringSchema).optional(),
      command: stringSchema,
      cwd: nullableStringSchema,
      status: repairItemStatusSchema,
      output: nullableStringSchema,
      exitCode: z.number().nullable(),
      durationMs: z.number().nullable(),
    }),
    z.object({
      type: z.literal('file_change'),
      threadId: stringSchema,
      callId: stringSchema,
      status: repairItemStatusSchema,
      changes: z.record(stringSchema, patchChangeSchema),
      stdout: nullableStringSchema,
      stderr: nullableStringSchema,
    }),
    z.object({
      type: z.literal('file_search_call'),
      turn_id: stringSchema,
      status: hostedToolStatusSchema,
      provider_data: jsonObject,
      queries: z.array(stringSchema),
      results: jsonValue,
    }),
    z.object({
      type: z.literal('code_interpreter_call'),
      turn_id: stringSchema,
      status: hostedToolStatusSchema,
      provider_data: jsonObject,
      container_id: stringSchema,
      code: nullableStringSchema,
      outputs: jsonValue,
    }),
    z.object({
      type: z.literal('image_generation_call'),
      turn_id: stringSchema,
      status: hostedToolStatusSchema,
      provider_data: jsonObject,
      result: nullableStringSchema,
      revised_prompt: nullableStringSchema,
    }),
    z.object({
      type: z.literal('shell_call'),
      turn_id: stringSchema,
      status: shellToolStatusSchema,
      provider_data: jsonObject,
      call_id: stringSchema,
      action: jsonValue,
    }),
    z.object({
      type: z.literal('shell_call_output'),
      turn_id: stringSchema,
      status: shellToolStatusSchema,
      provider_data: jsonObject,
      call_id: stringSchema,
      output: jsonValue,
    }),
    z.object({
      type: z.literal('web_search_call'),
      status: repairItemStatusSchema,
      results: z.array(jsonValue).optional(),
      action: z
        .discriminatedUnion('type', [
          z.object({
            type: z.literal('search'),
            query: nullableStringSchema,
            queries: z.array(stringSchema).nullable(),
            sources: webSearchSourcesSchema.optional(),
          }),
          z.object({
            type: z.literal('open_page'),
            url: nullableStringSchema,
          }),
          z.object({
            type: z.literal('find_in_page'),
            url: nullableStringSchema,
            pattern: nullableStringSchema,
          }),
          z.object({ type: z.literal('other') }),
        ])
        .nullable(),
    }),
    z.object({
      type: z.literal('create_subagent_call'),
      status: repairItemStatusSchema,
      agentId: stringSchema,
      subagentId: nullableStringSchema,
    }),
    z.object({
      type: z.literal('wait_for_subagents_call'),
      status: repairItemStatusSchema,
      senderAgentId: stringSchema,
    }),
    z.object({
      type: z.enum([
        'send_subagent_input_call',
        'resume_subagent_call',
        'interrupt_subagent_call',
        'close_subagent_call',
      ]),
      status: repairItemStatusSchema,
      senderAgentId: stringSchema,
      recipientAgentId: stringSchema,
    }),
  ]),
) satisfies z.ZodType<SessionItem>;

/** @internal Project complete known items without changing opaque receipt data. */
export function repairItemFromWire(
  item: RepairItemWire['item'],
): SessionItem | null {
  const result = repairItemProjectionSchema.safeParse(item);
  return result.success ? result.data : null;
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}
function text(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function number(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}
function objects(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value)
    ? value.flatMap((entry): JsonObject[] => {
        const result = object(entry);
        return result ? [result] : [];
      })
    : [];
}
function status(value: JsonValue | undefined, done: boolean): ItemStatus {
  if (value === 'inProgress') return 'in_progress';
  if (value === 'interrupted' || value === 'declined') return 'incomplete';
  return value === 'completed' ||
    value === 'failed' ||
    value === 'in_progress' ||
    value === 'incomplete'
    ? value
    : done
      ? 'completed'
      : 'in_progress';
}
const usageFields = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

function usageCount(raw: JsonObject, key: string): TokenCount {
  return parseTokenCount(raw[key] === undefined ? 0 : raw[key]);
}

function recordedUsage(raw: JsonObject): RecordedTokenUsage {
  return {
    inputTokens: usageCount(raw, 'input_tokens'),
    inputTokensDetails: {
      cachedTokens: usageCount(raw, 'cached_input_tokens'),
      ...(raw.cache_write_input_tokens === undefined
        ? {}
        : { cacheWriteTokens: usageCount(raw, 'cache_write_input_tokens') }),
    },
    outputTokens: usageCount(raw, 'output_tokens'),
    outputTokensDetails: {
      reasoningTokens: usageCount(raw, 'reasoning_output_tokens'),
    },
    totalTokens: usageCount(raw, 'total_tokens'),
  };
}
function receivedUsage(raw: JsonObject): ReceivedTokenUsage {
  const count = (key: string) =>
    raw[key] == null ? undefined : parseTokenCount(raw[key]);
  const inputTokens = count('input_tokens');
  const cachedTokens = count('cached_input_tokens');
  const cacheWriteTokens = count('cache_write_input_tokens');
  const outputTokens = count('output_tokens');
  const reasoningTokens = count('reasoning_output_tokens');
  const totalTokens = count('total_tokens');
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedTokens === undefined && cacheWriteTokens === undefined
      ? {}
      : {
          inputTokensDetails: {
            ...(cachedTokens === undefined ? {} : { cachedTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
          },
        }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined
      ? {}
      : { outputTokensDetails: { reasoningTokens } }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function failure(raw: JsonObject): Failure {
  const info = object(raw.codex_error_info);
  const variant =
    text(raw.codex_error_info) ?? (info ? Object.keys(info)[0] : '') ?? '';
  let code = variant.replace(
    /[A-Z]/g,
    (letter, offset) => (offset ? '_' : '') + letter.toLowerCase(),
  );
  const details = info ? object(info[variant]) : undefined;
  const http = number(details?.http_status_code);
  if (
    [
      'http_connection_failed',
      'response_stream_connection_failed',
      'response_stream_disconnected',
      'response_too_many_failed_attempts',
    ].includes(code)
  ) {
    const mapped: Record<number, string> = {
      401: 'authentication_error',
      403: 'authentication_error',
      402: 'usage_limit_exceeded',
      404: 'resource_not_found',
      408: 'request_timeout',
      504: 'request_timeout',
      429: 'rate_limit_exceeded',
      503: 'server_overloaded',
      529: 'server_overloaded',
    };
    code =
      http === null
        ? code === 'response_too_many_failed_attempts'
          ? 'server_error'
          : 'connection_failed'
        : (mapped[http] ??
          (http >= 500
            ? 'server_error'
            : http >= 400
              ? 'invalid_request'
              : 'connection_failed'));
  } else {
    const aliases: Record<string, string> = {
      context_window_exceeded: 'context_length_exceeded',
      unauthorized: 'authentication_error',
      bad_request: 'invalid_request',
      internal_server_error: 'server_error',
      thread_rollback_failed: 'server_error',
      other: 'internal_error',
    };
    const known = [
      'model_invocation_deadline_exceeded',
      'session_budget_exceeded',
      'usage_limit_exceeded',
      'project_spend_limit_exceeded',
      'organization_spend_limit_exceeded',
      'organization_usage_limit_exceeded',
      'billing_not_active',
      'credit_balance_exhausted',
      'rate_limit_exceeded',
      'flex_unavailable',
      'server_overloaded',
      'cyber_policy',
      'misalignment_policy_violation',
      'sandbox_error',
      'active_turn_not_steerable',
    ];
    code = aliases[code] ?? (known.includes(code) ? code : 'internal_error');
  }
  return {
    code,
    message: text(raw.message),
    ...(code === 'server_overloaded' && http !== null
      ? { httpStatusCode: http }
      : {}),
  };
}
function webAction(raw: JsonObject): WebSearchAction | null {
  const action = object(raw.action);
  if (!action)
    return typeof raw.query === 'string'
      ? { type: 'search', query: raw.query, queries: null }
      : null;
  switch (action.type) {
    case 'search': {
      const sources = webSearchSourcesSchema.safeParse(action.sources);
      return {
        type: 'search',
        query: text(action.query),
        queries: Array.isArray(action.queries)
          ? action.queries.filter(
              (value): value is string => typeof value === 'string',
            )
          : null,
        ...(sources.success ? { sources: sources.data } : {}),
      };
    }
    case 'open_page':
    case 'openPage':
      return { type: 'open_page', url: text(action.url) };
    case 'find_in_page':
    case 'findInPage':
      return {
        type: 'find_in_page',
        url: text(action.url),
        pattern: text(action.pattern),
      };
    default:
      return { type: 'other' };
  }
}
function reconciliationOutcome(raw: JsonObject) {
  if (
    raw.type !== 'function_call_output' &&
    raw.type !== 'custom_tool_call_output' &&
    raw.type !== 'computer_call_output' &&
    raw.type !== 'apply_patch_call_output'
  )
    return undefined;
  const kinds = object(
    raw.internal_chat_message_metadata_passthrough,
  )?.content_item_kinds;
  if (!Array.isArray(kinds) || kinds.length !== 1) return undefined;
  if (kinds[0] === 'sdk_reconciliation.applied') return 'applied';
  if (kinds[0] === 'sdk_reconciliation.not_applied') return 'not_applied';
}

function responseItem(raw: JsonObject, turnId: string): HistoryItem | null {
  const output =
    raw.type === 'function_call_output' ||
    raw.type === 'custom_tool_call_output' ||
    raw.type === 'computer_call_output' ||
    raw.type === 'apply_patch_call_output' ||
    raw.type === 'shell_call_output' ||
    raw.type === 'tool_search_output';
  const call =
    raw.type === 'function_call' ||
    raw.type === 'custom_tool_call' ||
    raw.type === 'computer_call' ||
    raw.type === 'apply_patch_call' ||
    raw.type === 'local_shell_call' ||
    raw.type === 'shell_call' ||
    raw.type === 'tool_search_call';
  const id =
    text(raw.id) ??
    ((call || output) && typeof raw.call_id === 'string'
      ? raw.call_id + (output ? ':output' : '')
      : null);
  if (!id) return null;
  const common = { id, turnId, data: raw };
  const hosted = projectHostedToolItem(raw, turnId);
  if (hosted) return { ...hosted, data: raw };
  if (
    raw.type === 'message' &&
    (raw.role === 'user' || raw.role === 'assistant')
  ) {
    const accepted =
      raw.role === 'user'
        ? ['input_text', 'input_image', 'input_file', 'input_audio']
        : ['output_text'];
    return {
      ...common,
      type: 'message',
      role: raw.role,
      status: 'completed',
      phase: raw.role === 'assistant' ? text(raw.phase) : null,
      content: objects(raw.content).filter((part) =>
        accepted.includes(String(part.type)),
      ) as (
        InputTextPart | OutputTextPart | ImagePart | FilePart | AudioPart
      )[],
    };
  }
  if (raw.type === 'local_shell_call' && object(raw.action))
    return {
      ...common,
      type: 'local_shell_call',
      callId: text(raw.call_id),
      action: object(raw.action)!,
      status: status(raw.status, false),
    };
  if (raw.type === 'tool_search_call' && typeof raw.execution === 'string')
    return {
      ...common,
      type: 'tool_search_call',
      callId: text(raw.call_id),
      execution: raw.execution,
      arguments: raw.arguments ?? null,
      status: status(raw.status, false),
    };
  if (raw.type === 'tool_search_output' && typeof raw.execution === 'string')
    return {
      ...common,
      type: 'tool_search_output',
      callId: text(raw.call_id),
      execution: raw.execution,
      tools: Array.isArray(raw.tools) ? raw.tools : [],
      status: status(raw.status, true),
    };
  if (raw.type === 'reasoning')
    return {
      ...common,
      type: 'reasoning',
      summary: objects(raw.summary) as { type: 'summary_text'; text: string }[],
      status: null,
    };
  if (
    call &&
    typeof raw.call_id === 'string' &&
    (raw.type === 'computer_call' ||
      raw.type === 'apply_patch_call' ||
      typeof raw.name === 'string')
  )
    return {
      ...common,
      type: 'function_call',
      callId: raw.call_id,
      name:
        raw.type === 'apply_patch_call'
          ? 'apply_patch'
          : raw.type === 'computer_call'
            ? 'computer'
            : raw.namespace
              ? `${raw.namespace}.${raw.name}`
              : String(raw.name),
      arguments:
        raw.type === 'computer_call' || raw.type === 'apply_patch_call'
          ? raw
          : (raw.arguments ?? raw.input ?? null),
      status: 'in_progress',
    };
  if (output && typeof raw.call_id === 'string') {
    const reconciliation = reconciliationOutcome(raw);
    return {
      ...common,
      type: 'function_call_output',
      callId: raw.call_id,
      status:
        reconciliation === 'not_applied' ||
        (raw.type === 'apply_patch_call_output' && raw.status === 'failed')
          ? 'failed'
          : 'completed',
      output:
        raw.type === 'apply_patch_call_output'
          ? {
              status: raw.status,
              ...(raw.output === undefined ? {} : { output: raw.output }),
            }
          : raw.type === 'computer_call_output'
            ? {
                output: raw.output ?? null,
                acknowledged_safety_checks:
                  raw.acknowledged_safety_checks ?? [],
              }
            : (raw.output ?? null),
      error: null,
      ...(reconciliation === undefined ? {} : { reconciliation }),
    };
  }
  if (raw.type === 'web_search_call')
    return {
      ...common,
      type: 'web_search_call',
      status: 'completed',
      action: webAction(raw),
      ...(raw.results == null ? {} : { results: raw.results as JsonValue[] }),
    };
  return null;
}
export function projectExecutionItem(
  value: JsonValue | undefined,
  turnId: string,
  threadId: string,
  done = true,
): ExecutionItem | null {
  const raw = object(value);
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  const common = {
    id: raw.id,
    turnId,
    threadId,
    callId: raw.id,
    status: status(raw.status, done),
  };
  switch (raw.type) {
    case 'CommandExecution': {
      const duration = object(raw.duration);
      const argv = Array.isArray(raw.command)
        ? raw.command.map(String)
        : undefined;
      const command = argv
        ? argv
            .map((value) =>
              /^[\w@%+=:,./-]+$/.test(value)
                ? value
                : `'${value.replace(/'/g, `'"'"'`)}'`,
            )
            .join(' ')
        : String(raw.command ?? '');
      return {
        ...common,
        type: 'command_execution',
        ...(argv ? { argv } : {}),
        command,
        cwd: text(raw.cwd),
        output: text(raw.aggregated_output),
        exitCode: number(raw.exit_code),
        durationMs: duration
          ? (number(duration.secs) ?? 0) * 1000 +
            Math.floor((number(duration.nanos) ?? 0) / 1_000_000)
          : null,
      };
    }
    case 'FileChange': {
      const changes = z
        .record(z.string(), nativePatchChangeSchema)
        .safeParse(raw.changes);
      if (!changes.success) return null;
      return {
        ...common,
        type: 'file_change',
        changes: changes.data,
        stdout: text(raw.stdout),
        stderr: text(raw.stderr),
      };
    }
    case 'McpToolCall':
      return {
        ...common,
        type: 'mcp_call',
        serverLabel: String(raw.server),
        name: String(raw.tool),
        arguments: raw.arguments ?? null,
        output: raw.result ?? null,
        error: raw.error ?? null,
      };
    default:
      return null;
  }
}

function nativeItems(
  raw: JsonObject,
  done: boolean,
  turnId: string,
  sourceId: string,
): HistoryItem[] {
  const id = text(raw.id);
  if (!id) return [];
  const common = { id, turnId, data: raw };
  const terminal = status(raw.status, done);
  switch (raw.type) {
    case 'UserMessage':
      return [
        {
          ...common,
          type: 'message',
          role: 'user',
          status: 'completed',
          phase: null,
          content: objects(raw.content).flatMap(
            (part): (InputTextPart | ImagePart | FilePart | AudioPart)[] =>
              ['text', 'image', 'file', 'audio'].includes(String(part.type))
                ? (responseContent([part]) as (
                    InputTextPart | ImagePart | FilePart | AudioPart
                  )[])
                : [],
          ),
        },
      ];
    case 'AgentMessage':
      return [
        {
          ...common,
          type: 'message',
          role: 'assistant',
          status: done ? 'completed' : 'in_progress',
          phase: text(raw.phase),
          ...(typeof raw.display_text === 'string'
            ? { displayText: raw.display_text }
            : {}),
          content: objects(raw.content).flatMap((part) =>
            part.type === 'Text' && typeof part.text === 'string'
              ? [
                  {
                    type: 'output_text',
                    text: part.text,
                    ...(part.annotations === undefined
                      ? {}
                      : { annotations: part.annotations }),
                  },
                ]
              : [],
          ),
        },
      ];
    case 'Reasoning':
      return [
        {
          ...common,
          type: 'reasoning',
          status: done ? 'completed' : 'in_progress',
          summary: Array.isArray(raw.summary_text)
            ? raw.summary_text
                .filter((part): part is string => typeof part === 'string')
                .map((part) => ({ type: 'summary_text', text: part }))
            : [],
        },
      ];
    case 'DynamicToolCall': {
      const toolStatus = raw.success === false ? 'failed' : terminal;
      const call: HistoryItem = {
        ...common,
        type: 'function_call',
        callId: id,
        name: raw.namespace ? `${raw.namespace}.${raw.tool}` : String(raw.tool),
        arguments: raw.arguments ?? null,
        status: toolStatus,
      };
      if (!done || raw.content_items == null) return [call];
      const output = objects(raw.content_items).flatMap((part): JsonObject[] =>
        ['inputText', 'inputImage', 'inputFile'].includes(String(part.type))
          ? (responseContent([part]) as JsonObject[])
          : [],
      );
      const error =
        text(raw.error) ??
        (toolStatus === 'failed'
          ? output
              .filter((part) => part.type === 'input_text')
              .map((part) => part.text)
              .join('\n') || null
          : null);
      return [
        call,
        {
          ...common,
          id: `${id}:output`,
          type: 'function_call_output',
          callId: id,
          status: toolStatus,
          output: toolStatus === 'completed' ? output : null,
          error,
        },
      ];
    }
    case 'hosted_tool_call': {
      const item = projectHostedToolItem(raw.item, turnId);
      return item ? [{ ...item, data: raw }] : [];
    }
    case 'ImageGeneration': {
      const item = projectNativeHostedToolItem(raw, turnId);
      return item ? [{ ...item, data: raw }] : [];
    }
    case 'WebSearch':
      return [
        {
          ...common,
          type: 'web_search_call',
          status: done ? 'completed' : 'in_progress',
          action: webAction(raw),
          ...(raw.results == null
            ? {}
            : { results: raw.results as JsonValue[] }),
        },
      ];
    case 'Extension':
      return raw.kind === 'web.search'
        ? [
            {
              ...common,
              type: 'web_search_call',
              status: done ? 'completed' : 'in_progress',
              action: webAction(raw),
              ...(raw.results == null
                ? {}
                : { results: raw.results as JsonValue[] }),
            },
          ]
        : [];
    case 'SubAgentActivity':
    case 'CollabAgentToolCall': {
      const activity = raw.type === 'SubAgentActivity';
      const tool = activity
        ? (
            {
              started: 'spawn_agent',
              interacted: 'send_input',
              interrupted: 'interrupt_agent',
            } as Record<string, string>
          )[String(raw.kind)]
        : raw.tool;
      const sender = activity ? sourceId : String(raw.sender_thread_id);
      const receivers = activity
        ? [raw.agent_thread_id]
        : Array.isArray(raw.receiver_thread_ids)
          ? raw.receiver_thread_ids
          : [];
      const state = activity ? (done ? 'completed' : 'in_progress') : terminal;
      if (tool === 'spawn_agent')
        return [
          {
            ...common,
            type: 'create_subagent_call',
            status: state,
            agentId: sender,
            subagentId: text(receivers[0]),
          },
        ];
      if (tool === 'wait')
        return [
          {
            ...common,
            type: 'wait_for_subagents_call',
            status: state,
            senderAgentId: sender,
          },
        ];
      const type = (
        {
          send_input: 'send_subagent_input_call',
          resume_agent: 'resume_subagent_call',
          interrupt_agent: 'interrupt_subagent_call',
          close_agent: 'close_subagent_call',
        } as const
      )[String(tool) as 'send_input'];
      return type && receivers.length === 1
        ? [
            {
              ...common,
              type,
              status: state,
              senderAgentId: sender,
              recipientAgentId: String(receivers[0]),
            },
          ]
        : [];
    }
    default:
      return [];
  }
}

export type ModelOutputItem = Extract<
  SessionItem,
  { type: 'message' | 'reasoning' }
>;

export function projectModelOutputItem(
  value: JsonValue | undefined,
  turnId: string,
  threadId: string,
): ModelOutputItem | undefined {
  const raw = object(value);
  if (raw?.type !== 'AgentMessage' && raw?.type !== 'Reasoning') return;
  const [item] = nativeItems(raw, true, turnId, threadId);
  if (item?.type === 'message' || item?.type === 'reasoning') {
    const { data: _data, ...projected } = item;
    return projected;
  }
}

/** Project completed native items carrying hosted search evidence for live consumers. */
export function projectSearchItem(
  value: JsonValue | undefined,
  turnId: string,
  threadId: string,
): SearchItem | undefined {
  const raw = object(value);
  if (raw?.type !== 'AgentMessage' && raw?.type !== 'WebSearch') return;
  const [item] = nativeItems(raw, true, turnId, threadId);
  if (
    item?.type === 'web_search_call' ||
    (item?.type === 'message' &&
      item.content.some(
        (part) =>
          part.type === 'output_text' &&
          part.annotations != null &&
          (!Array.isArray(part.annotations) || part.annotations.length > 0),
      ))
  ) {
    const { data: _data, ...projected } = item;
    return projected;
  }
}

/** Project canonical records, preferring native item events without inventing final text. */
export function projectHistory(
  history: ThreadHistory,
  sessionId: string,
  subagentId?: string,
  itemRecordIndexes?: Map<HistoryItem, number>,
) {
  const turns = new Map<string, HistoryTurn>();
  const usage = new Map<string, RecordedTokenUsage>();
  const responses = new Map<string, RecordedResponse[]>();
  const responseFacts: RecordedResponseFact[] = [];
  const observations = new Map<string, Set<string>>();
  function appendResponse(
    target: Map<string, RecordedResponse[]>,
    id: string,
    response: RecordedResponse,
  ) {
    const entries = target.get(id) ?? [];
    entries.push(response);
    target.set(id, entries);
  }
  const responseUsage = new Map<
    string,
    {
      tokens: JsonObject | null;
      requests: TokenCount;
      missing: TokenCount;
    }
  >();
  const incompleteCacheWriteUsage = new Set<string>();
  const modelAttemptUsage = new Map<
    string,
    Map<string | null, CapturedModelAttempt>
  >();
  const failures = new Map<string, Failure>();
  let items: HistoryOccurrence[] = [];
  const identities = new Map<string, HistoryOccurrence>();
  const latestCalls = new Map<string, HistoryOccurrence>();
  const order: string[] = [];
  let current: string | null = null;
  let aborted: string | null = null;
  let pendingUser: HistoryOccurrence | undefined;
  const userAliases = new Set<HistoryOccurrence>();
  function remember(item: HistoryItem, native: boolean, recordedId = true) {
    const output =
      item.type === 'function_call_output' ||
      item.type === 'tool_search_output';
    const key = JSON.stringify([item.turnId, item.type, recordedId, item.id]);
    const callKey = JSON.stringify([
      item.turnId,
      item.type === 'tool_search_call' || item.type === 'tool_search_output'
        ? 'tool_search'
        : 'function',
      ('callId' in item ? item.callId : undefined) ?? item.id,
    ]);
    const call = latestCalls.get(callKey);
    let occurrence = identities.get(key);
    if (output && call) {
      if (!call.output) occurrence = undefined;
      else if (occurrence === call.output || native !== call.output.native)
        occurrence = call.output;
      else occurrence = undefined;
    } else if (native && call && !call.native && item.type === call.item.type)
      occurrence = call;
    else if (!native && !recordedId && call?.output) occurrence = undefined;
    if (!occurrence) {
      occurrence = { item, native, recordedId };
      items.push(occurrence);
    } else if (native || !occurrence.native) {
      if (native && !occurrence.native) item.data = occurrence.item.data;
      occurrence.item = item;
      occurrence.native = native;
      occurrence.recordedId = recordedId;
    } else {
      occurrence.item.data = item.data;
    }
    identities.set(key, occurrence);
    if (item.type === 'function_call' || item.type === 'tool_search_call')
      latestCalls.set(callKey, occurrence);
    else if (output && call) {
      call.output = occurrence;
      if (
        call.item.type === 'tool_search_call' &&
        item.type === 'tool_search_output'
      )
        call.item.status = item.status;
    }
    return occurrence;
  }
  const receipts = new Map<string, TurnReceipt>();
  for (const [recordIndex, record] of history.entries()) {
    const { type, payload, metadata: recordedMetadata } = record;
    if (type === 'compacted' || type === 'session_meta')
      pendingUser = undefined;
    if (type === 'turn_context' && typeof payload.turn_id === 'string') {
      const receipt = projectTurnReceipt(payload.sdk_receipt, payload.turn_id);
      if (receipt) receipts.set(payload.turn_id, receipt);
      // The latest sample owns the receipt, even if its format is unsupported.
      else if (
        payload.sdk_receipt !== undefined &&
        payload.sdk_receipt !== null
      )
        receipts.delete(payload.turn_id);
      if (current !== payload.turn_id) pendingUser = undefined;
      current = payload.turn_id;
      aborted = null;
      if (!order.includes(current)) order.push(current);
    } else if (type === 'response_fact_record') {
      const fact = projectResponseFactRecord(payload);
      if (fact) responseFacts.push(fact);
    } else if (
      type === 'response_observation_record' &&
      typeof payload.turn_id === 'string' &&
      typeof payload.id === 'string'
    ) {
      const ids = observations.get(payload.turn_id) ?? new Set<string>();
      if (!ids.has(payload.id)) {
        ids.add(payload.id);
        observations.set(payload.turn_id, ids);
        const reason = text(payload.incomplete_reason);
        appendResponse(responses, payload.turn_id, {
          id: payload.id,
          threadId: String(payload.thread_id),
          turnId: payload.turn_id,
          responseId: text(payload.response_id),
          status: payload.status as RecordedResponse['status'],
          ...(typeof payload.upstream_request_id === 'string'
            ? { upstreamRequestId: payload.upstream_request_id }
            : {}),
          ...(reason === null
            ? {}
            : {
                incompleteReason:
                  reason as RecordedResponse['incompleteReason'],
              }),
          usageSource: 'received',
          usage: object(payload.usage)
            ? receivedUsage(object(payload.usage)!)
            : null,
        });
      }
    } else if (
      type === 'token_usage_record' &&
      typeof payload.turn_id === 'string'
    ) {
      const value = object(payload.turn_token_usage);
      if (value) usage.set(payload.turn_id, recordedUsage(value));
      appendResponse(responses, payload.turn_id, {
        id: text(payload.response_observation_id),
        threadId: text(payload.thread_id) ?? sessionId,
        turnId: payload.turn_id,
        responseId: text(payload.response_id),
        usageSource: 'native_normalized',
        usage: object(payload.usage)
          ? recordedUsage(object(payload.usage)!)
          : null,
      });
    } else if (type === 'response_item') {
      let turn = current;
      const metadata = object(
        payload.internal_chat_message_metadata_passthrough,
      );
      if (
        reconciliationOutcome(payload) &&
        typeof metadata?.turn_id === 'string'
      )
        turn = metadata.turn_id;
      if (
        !turn &&
        aborted &&
        [
          'function_call_output',
          'custom_tool_call_output',
          'computer_call_output',
          'apply_patch_call_output',
        ].includes(String(payload.type)) &&
        metadata?.turn_id === aborted &&
        latestCalls.has(JSON.stringify([aborted, 'function', payload.call_id]))
      )
        turn = aborted;
      if (turn) {
        if (
          payload.type === 'apply_patch_call' &&
          object(recordedMetadata)?.sdk_application_tool !== 'apply_patch'
        )
          continue;
        const item = responseItem(payload, turn);
        if (item) {
          if (item.type === 'function_call_output' && item.reconciliation) {
            const reconciled = turns.get(turn);
            if (reconciled?.status === 'in_progress')
              reconciled.status = 'cancelled';
          }
          const occurrence = remember(
            item,
            false,
            typeof payload.id === 'string',
          );
          itemRecordIndexes?.set(item, recordIndex);
          const inputOrder = object(recordedMetadata)?.user_input_order;
          const kinds = metadata?.content_item_kinds;
          if (
            item.type === 'message' &&
            item.role === 'user' &&
            !occurrence.native &&
            metadata?.turn_id === turn &&
            typeof inputOrder === 'number' &&
            Number.isSafeInteger(inputOrder) &&
            inputOrder >= 0 &&
            Array.isArray(kinds) &&
            kinds.length > 0 &&
            kinds.length === objects(payload.content).length &&
            kinds.every(
              (kind) =>
                kind === 'user.text' ||
                kind === 'user.image' ||
                kind === 'user.file' ||
                kind === 'images.preparation_error',
            )
          )
            pendingUser = occurrence;
        }
      }
    } else if (type === 'event_msg') {
      if (
        payload.type === 'thread_rolled_back' &&
        typeof payload.num_turns === 'number'
      ) {
        const removed = new Set(
          order.splice(Math.max(0, order.length - payload.num_turns)),
        );
        for (const id of removed) {
          turns.delete(id);
          usage.delete(id);
          responses.delete(id);
          observations.delete(id);
          responseUsage.delete(id);
          incompleteCacheWriteUsage.delete(id);
          modelAttemptUsage.delete(id);
          failures.delete(id);
        }
        items = items.filter(({ item }) => !removed.has(item.turnId));
        for (const [key, { item }] of identities)
          if (removed.has(item.turnId)) identities.delete(key);
        for (const [key, { item }] of latestCalls)
          if (removed.has(item.turnId)) latestCalls.delete(key);
        current = aborted = null;
        pendingUser = undefined;
        continue;
      }
      const id: string | null =
        text(payload.turn_id) ?? text(payload.turnId) ?? current;
      if (!id) continue;
      const done = payload.type === 'item_completed';
      const native =
        done || payload.type === 'item_started'
          ? object(payload.item)
          : undefined;
      if (
        native?.type === 'McpToolCall' ||
        native?.type === 'CommandExecution' ||
        native?.type === 'FileChange'
      ) {
        // Late execution evidence belongs to a surviving turn and cannot
        // change which turn owns subsequent response items.
        if (turns.has(id)) {
          const item = projectExecutionItem(
            native,
            id,
            text(payload.thread_id) ?? subagentId ?? sessionId,
            done,
          );
          if (item) remember({ ...item, data: native }, true, false);
        }
        continue;
      }
      if (pendingUser?.item.turnId !== id) pendingUser = undefined;
      current = id;
      aborted = null;
      if (!order.includes(id)) order.push(id);
      if (payload.type === 'error' && !failures.has(id))
        failures.set(id, failure(payload));
      const attemptSnapshot =
        payload.type === '_sdk_model_attempt'
          ? payload.data
          : payload.model_attempt;
      if (attemptSnapshot !== undefined) {
        const captured = captureModelAttemptSnapshot(attemptSnapshot);
        const owners = modelAttemptUsage.get(id) ?? new Map();
        owners.set(captured.ownerAttemptId, captured);
        modelAttemptUsage.set(id, owners);
      }
      if (
        payload.type === 'raw_response_completed' &&
        typeof payload.model_attempt_id !== 'string'
      ) {
        const report = object(payload.token_usage);
        const observed = responseUsage.get(id) ?? {
          tokens: null,
          requests: 0,
          missing: 0,
        };
        observed.requests = addTokenCounts(observed.requests, 1);
        if (!report) observed.missing = addTokenCounts(observed.missing, 1);
        responseUsage.set(id, observed);
        if (report?.cache_write_input_tokens === undefined)
          incompleteCacheWriteUsage.add(id);
        if (incompleteCacheWriteUsage.has(id)) {
          const total = observed.tokens;
          if (total) delete total.cache_write_input_tokens;
        }
        if (report) {
          const total = observed.tokens ?? {};
          for (const key of usageFields) {
            const count = usageCount(report, key);
            if (
              key === 'cache_write_input_tokens' &&
              incompleteCacheWriteUsage.has(id)
            )
              continue;
            const sum = addTokenCounts(usageCount(total, key), count);
            total[key] = tokenCountToWire(sum);
          }
          observed.tokens = total;
        }
      }

      if (native) {
        if (native.type === 'ContextCompaction') pendingUser = undefined;
        for (const item of nativeItems(
          native,
          done,
          id,
          text(payload.thread_id) ?? subagentId ?? sessionId,
        )) {
          const seenNative = identities.get(
            JSON.stringify([item.turnId, item.type, true, item.id]),
          )?.native;
          const occurrence = remember(item, true);
          if (native.type === 'UserMessage' && !seenNative) {
            // Core records each accepted input before its distinct native item.
            if (pendingUser && occurrence !== pendingUser)
              userAliases.add(pendingUser);
            pendingUser = undefined;
          }
        }
      }
      const started =
        payload.type === 'task_started' || payload.type === 'turn_started';
      const completed =
        payload.type === 'task_complete' ||
        payload.type === 'turn_complete' ||
        payload.type === 'turn_aborted';
      if (started || completed) {
        pendingUser = undefined;
        if (started && !modelAttemptUsage.has(id)) {
          responseUsage.delete(id);
          incompleteCacheWriteUsage.delete(id);
        }
        if (started) failures.delete(id);
        const error =
          failures.get(id) ??
          (object(payload.error) ? failure(object(payload.error)!) : null);
        const prior = turns.get(id);
        const start = number(payload.started_at) ?? prior?.startedAt ?? null;
        turns.set(id, {
          id,
          object: 'agent.session.turn',
          sessionId,
          subagentId: subagentId ?? null,
          status: started
            ? 'in_progress'
            : error
              ? 'failed'
              : payload.type === 'turn_aborted'
                ? 'cancelled'
                : 'completed',
          createdAt: start,
          startedAt: start,
          completedAt: number(payload.completed_at),
          error,
          usage: null,
        });
        if (completed) {
          for (const occurrence of items) {
            if (
              occurrence.item.turnId === id &&
              occurrence.native &&
              occurrence.item.status === 'in_progress'
            )
              occurrence.item.status = 'incomplete';
          }
          current = null;
          if (payload.type === 'turn_aborted') aborted = id;
        }
      }
    }
  }
  for (const [id, turn] of turns) {
    const receipt = receipts.get(id);
    if (receipt) turn.receipt = receipt;
    const observed = responseUsage.get(id);
    const total = observed?.tokens ?? undefined;
    const nativeOwners = modelAttemptUsage.get(id);
    if (nativeOwners) {
      // A restored ledger can retain the turn ID; only its own latest snapshot replaces it.
      let measured: JsonObject | null = total ? { ...total } : null;
      let cacheWriteKnown = !incompleteCacheWriteUsage.has(id);
      let runMeasured = runUsageSnapshot(
        total ? addRunUsage(null, total) : null,
        observed?.requests ?? 0,
        observed?.missing ?? 0,
      );
      for (const captured of nativeOwners.values()) {
        runMeasured = mergeRunUsage(runMeasured, captured.usage);
        const snapshot = captured.wire;
        const report = snapshot.usage.token_usage;
        if (report === null) {
          if (BigInt(snapshot.usage.requests) !== 0n) cacheWriteKnown = false;
          continue;
        }
        if (report.cache_write_input_tokens === undefined)
          cacheWriteKnown = false;
        measured ??= {};
        for (const key of usageFields) {
          if (key === 'cache_write_input_tokens' && !cacheWriteKnown) continue;
          measured[key] = tokenCountToWire(
            addTokenCounts(usageCount(measured, key), usageCount(report, key)),
          );
        }
      }
      if (measured && !cacheWriteKnown)
        delete measured.cache_write_input_tokens;
      turn.usage = measured ? recordedUsage(measured) : null;
      turn.runUsage = runMeasured;
    } else {
      turn.usage = usage.get(id) ?? (total ? recordedUsage(total) : null);
    }
    const accountedIds = new Set(
      (responses.get(id) ?? [])
        .filter(
          (response) =>
            response.usageSource === 'native_normalized' &&
            response.id !== null,
        )
        .map((response) => response.id),
    );
    const nativeIds = observations.get(id);
    // Only an exact native link identifies the accounting copy of an observation.
    const projectedIds = new Set<string>();
    const retained = (responses.get(id) ?? []).filter((response) => {
      if (response.id === null) return true;
      if (
        (response.usageSource !== 'received' && nativeIds?.has(response.id)) ||
        projectedIds.has(response.id)
      )
        return false;
      projectedIds.add(response.id);
      return true;
    });
    // Core defaults an omitted cache-write field to zero in accounting totals.
    // A partial received total remains unknown even when its known peers are nonzero.
    // Borrowed responses can retain counter availability without a provider ID.
    // A generic application boundary has neither an ID nor received usage.
    if (
      turn.usage &&
      retained.some(
        (response) =>
          response.usageSource === 'received' &&
          (response.responseId !== null || response.usage !== null) &&
          response.id !== null &&
          accountedIds.has(response.id) &&
          response.usage?.inputTokensDetails?.cacheWriteTokens === undefined,
      )
    )
      delete turn.usage.inputTokensDetails.cacheWriteTokens;
    if (retained.length) turn.responses = retained;
    const seenFacts = new Set<string>();
    const facts = responseFacts.filter(
      (record) =>
        record.turnId === id &&
        !seenFacts.has(record.id) &&
        !!seenFacts.add(record.id),
    );
    if (facts.length) turn.responseFacts = facts;
  }
  const cursorIds = new Set(
    items.filter(({ recordedId }) => recordedId).map(({ item }) => item.id),
  );
  for (const [index, occurrence] of items.entries()) {
    const item = occurrence.item;
    if (!occurrence.recordedId) {
      while (cursorIds.has(item.id)) item.id += ':' + index;
      cursorIds.add(item.id);
    }
    if (item.type === 'function_call') {
      const original = item.data;
      const computerCall =
        original.type === 'computer_call' ||
        original.type === 'apply_patch_call';
      if (computerCall) item.arguments = original;
      const output = occurrence.output?.item;
      if (output?.type === 'function_call_output' && output.reconciliation)
        item.status = output.status;
      else if (!occurrence.native || computerCall) {
        const terminal = turns.get(item.turnId)?.status;
        item.status =
          output?.type === 'function_call_output'
            ? output.status
            : terminal && terminal !== 'in_progress'
              ? 'incomplete'
              : 'in_progress';
      }
    }
  }
  return {
    turns: [...turns.values()],
    // Allocate cursors before removing aliases so unrelated cursor IDs stay stable.
    items: items
      .filter((entry) => !userAliases.has(entry))
      .map(({ item }) => item),
  };
}

type HistoryOccurrence = {
  item: HistoryItem;
  native: boolean;
  recordedId: boolean;
  output?: HistoryOccurrence;
};

/** Preserve provider identity and payload in live results, history, and repair. */
export function projectHostedToolItem(
  value: JsonValue | undefined,
  turnId: string,
): HostedToolItem | undefined {
  const raw = object(value);
  if (!raw) return;
  const shell = raw.type === 'shell_call' || raw.type === 'shell_call_output';
  const id =
    text(raw.id) ??
    (shell && typeof raw.call_id === 'string'
      ? raw.call_id + (raw.type === 'shell_call_output' ? ':output' : '')
      : null);
  if (!id) return;
  const identity = {
    id,
    turnId,
    turn_id: turnId,
  };
  if (shell) {
    const status = shellToolStatusSchema.safeParse(raw.status ?? 'unknown');
    if (!status.success || typeof raw.call_id !== 'string') return;
    const {
      internal_chat_message_metadata_passthrough: _coreMetadata,
      ...provider
    } = raw;
    const common = {
      ...identity,
      status: status.data,
      call_id: raw.call_id,
      provider_data: structuredClone(provider),
    };
    return raw.type === 'shell_call'
      ? { ...common, type: raw.type, action: raw.action ?? null }
      : { ...common, type: 'shell_call_output', output: raw.output ?? null };
  }
  const status = hostedToolStatusSchema.safeParse(
    (raw.type === 'mcp_list_tools' || raw.type === 'mcp_call') &&
      raw.status === undefined
      ? raw.error == null
        ? 'completed'
        : 'failed'
      : raw.status,
  );
  if (!status.success) return;
  if (
    raw.type !== 'file_search_call' &&
    raw.type !== 'code_interpreter_call' &&
    raw.type !== 'image_generation_call' &&
    raw.type !== 'mcp_list_tools' &&
    raw.type !== 'mcp_call'
  )
    return;
  const {
    internal_chat_message_metadata_passthrough: _coreMetadata,
    ...provider
  } = raw;
  const common = {
    ...identity,
    status: status.data,
    provider_data: structuredClone(provider),
  };
  switch (raw.type) {
    case 'file_search_call':
      return {
        ...common,
        type: raw.type,
        queries: Array.isArray(raw.queries)
          ? raw.queries.filter(
              (query): query is string => typeof query === 'string',
            )
          : [],
        results: raw.results ?? null,
      };
    case 'code_interpreter_call':
      return {
        ...common,
        type: raw.type,
        container_id: text(raw.container_id) ?? '',
        code: text(raw.code),
        outputs: raw.outputs ?? null,
      };
    case 'image_generation_call':
      return {
        ...common,
        type: raw.type,
        result: text(raw.result),
        revised_prompt: text(raw.revised_prompt),
      };
    case 'mcp_list_tools':
      return {
        ...common,
        type: raw.type,
        server_label: text(raw.server_label) ?? '',
        tools: raw.tools ?? [],
        error: raw.error ?? null,
      };
    case 'mcp_call':
      return {
        ...common,
        type: raw.type,
        serverLabel: text(raw.server_label) ?? '',
        callId: null,
        name: text(raw.name) ?? '',
        arguments: text(raw.arguments) ?? '',
        output: raw.output ?? null,
        error: raw.error ?? null,
      };
  }
}

/** @internal Project the native typed envelope without losing provider fields. */
export function projectNativeHostedToolItem(
  value: JsonValue | undefined,
  turnId: string,
): HostedToolItem | undefined {
  const raw = object(value);
  if (raw?.type === 'hosted_tool_call')
    return projectHostedToolItem(raw.item, turnId);
  if (raw?.type === 'ImageGeneration') {
    const preserved = object(raw.provider_data);
    if (preserved) return projectHostedToolItem(preserved, turnId);
    const {
      saved_path: _savedPath,
      provider_data: _providerData,
      type: _nativeType,
      ...provider
    } = raw;
    return projectHostedToolItem(
      { ...provider, type: 'image_generation_call' },
      turnId,
    );
  }
}

/** Core has been retaining original JSON object records separately from model projections. */
export interface CanonicalHistorySnapshot {
  readonly revision: string;
  readonly total: number;
  readonly items: readonly Record<string, unknown>[];
}
