import { z } from 'zod';
import {
  projectTurnReceipt,
  repairTurnReceiptSchema,
  type TurnReceipt,
} from './turn-receipt';
import {
  addTokenCounts,
  nonnegativeTokenCountWireSchema,
  parseTokenCount,
  tokenCountToWire,
  type TokenCount,
  type TokenCountWire,
} from './run-events';
import {
  jsonObject,
  jsonValue,
  type JsonObject,
  type JsonValue,
} from './binding';

export const threadHistorySchema = z.array(
  z
    .object({
      type: z.string(),
      payload: jsonObject,
    })
    .catchall(jsonValue),
);
export type ThreadHistory = z.infer<typeof threadHistorySchema>;

/** Safe counters remain numbers; larger exact counts are bigint. */
export interface RecordedTokenUsage {
  inputTokens: TokenCount;
  inputTokensDetails: { cachedTokens: TokenCount };
  outputTokens: TokenCount;
  outputTokensDetails: { reasoningTokens: TokenCount };
  totalTokens: TokenCount;
}

export interface RecordedTokenUsageWire {
  inputTokens: TokenCountWire;
  inputTokensDetails: { cachedTokens: TokenCountWire };
  outputTokens: TokenCountWire;
  outputTokensDetails: { reasoningTokens: TokenCountWire };
  totalTokens: TokenCountWire;
}

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
  receipt?: TurnReceipt;
};
export type RecordedTurn = HistoryTurn & {
  parentSessionId?: string;
  parentTurnId?: string;
};
/** JSON-safe observational turn data for history/receipt owners, not Core checkpoints. */
export type RecordedTurnWire = Omit<RecordedTurn, 'usage' | 'receipt'> & {
  usage: RecordedTokenUsageWire | null;
  receipt?: z.infer<typeof repairTurnReceiptSchema>;
};

/** @internal Passive terminal observations; never Core history or grants. */
export type RepairTurnWire = RecordedTurnWire & {
  subagentId: null;
  status: 'completed' | 'failed' | 'cancelled';
  parentSessionId: string;
  parentTurnId: string;
};
export const repairTurnWireSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('agent.session.turn'),
    sessionId: z.string().min(1),
    subagentId: z.null(),
    status: z.enum(['completed', 'failed', 'cancelled']),
    createdAt: z.number().nullable(),
    startedAt: z.number().nullable(),
    completedAt: z.number().nullable(),
    error: z
      .object({
        code: z.string(),
        message: z.string().nullable(),
        httpStatusCode: z.number().optional(),
      })
      .strict()
      .nullable(),
    usage: z
      .object({
        inputTokens: nonnegativeTokenCountWireSchema,
        inputTokensDetails: z
          .object({ cachedTokens: nonnegativeTokenCountWireSchema })
          .strict(),
        outputTokens: nonnegativeTokenCountWireSchema,
        outputTokensDetails: z
          .object({ reasoningTokens: nonnegativeTokenCountWireSchema })
          .strict(),
        totalTokens: nonnegativeTokenCountWireSchema,
      })
      .strict()
      .nullable(),
    receipt: repairTurnReceiptSchema.optional(),
    parentSessionId: z.string().min(1),
    parentTurnId: z.string().min(1),
  })
  .strict()
  .refine(
    (turn) =>
      turn.receipt === undefined ||
      (turn.receipt.threadId === turn.sessionId &&
        turn.receipt.turnId === turn.id),
    'Repair receipt identity must match its recorded turn',
  ) satisfies z.ZodType<RepairTurnWire>;
export const repairItemWireSchema = z
  .object({
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
  })
  .strict();
export type RepairItemWire = z.infer<typeof repairItemWireSchema>;

function mapRecordedUsage<T>(
  usage: RecordedTokenUsage | RecordedTokenUsageWire,
  convert: (value: number | bigint | string) => T,
) {
  return {
    inputTokens: convert(usage.inputTokens),
    inputTokensDetails: {
      cachedTokens: convert(usage.inputTokensDetails.cachedTokens),
    },
    outputTokens: convert(usage.outputTokens),
    outputTokensDetails: {
      reasoningTokens: convert(usage.outputTokensDetails.reasoningTokens),
    },
    totalTokens: convert(usage.totalTokens),
  };
}

export function recordedTurnToWire(turn: RecordedTurn): RecordedTurnWire {
  const { receipt, ...wire } = turn;
  return {
    ...wire,
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
  return {
    ...turn,
    usage:
      turn.usage === null
        ? null
        : mapRecordedUsage(turn.usage, parseTokenCount),
  };
}

export type ItemStatus = 'in_progress' | 'completed' | 'failed' | 'incomplete';
type ItemIdentity = { id: string; turnId: string };
type TextPart = { type: 'input_text' | 'output_text'; text: string };
type ImagePart = { type: 'input_image'; image_url: string; detail?: string };
export type WebSearchAction =
  | { type: 'search'; query: string | null; queries: string[] | null }
  | { type: 'open_page'; url: string | null }
  | { type: 'find_in_page'; url: string | null; pattern: string | null }
  | { type: 'other' };

export type SessionItem = ItemIdentity &
  (
    | {
        type: 'message';
        role: 'user' | 'assistant';
        status: ItemStatus;
        phase: string | null;
        content: (TextPart | ImagePart)[];
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
        type: 'mcp_call';
        threadId?: string;
        callId?: string;
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
const patchContentChanges = [
  z.object({ type: z.literal('add'), content: z.string() }),
  z.object({ type: z.literal('delete'), content: z.string() }),
] as const;
const patchChangeSchema = z.discriminatedUnion('type', [
  ...patchContentChanges,
  z.object({
    type: z.literal('update'),
    unifiedDiff: z.string(),
    movePath: z.string().nullable(),
  }),
]);
const nativePatchChangeSchema = z
  .discriminatedUnion('type', [
    ...patchContentChanges,
    z.object({
      type: z.literal('update'),
      unified_diff: z.string(),
      move_path: z.string().nullable(),
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
const repairItemProjectionSchema = z.intersection(
  z.object({ id: z.string().min(1), turnId: z.string().min(1) }),
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('message'),
      role: z.enum(['user', 'assistant']),
      status: repairItemStatusSchema,
      phase: z.string().nullable(),
      content: z.array(
        z.discriminatedUnion('type', [
          z.object({
            type: z.enum(['input_text', 'output_text']),
            text: z.string(),
          }),
          z.object({
            type: z.literal('input_image'),
            image_url: z.string(),
            detail: z.string().optional(),
          }),
        ]),
      ),
    }),
    z.object({
      type: z.literal('reasoning'),
      summary: z.array(
        z.object({ type: z.literal('summary_text'), text: z.string() }),
      ),
      status: repairItemStatusSchema.nullable(),
    }),
    z.object({
      type: z.literal('function_call'),
      callId: z.string(),
      name: z.string(),
      arguments: jsonValue,
      status: repairItemStatusSchema,
    }),
    z.object({
      type: z.literal('function_call_output'),
      callId: z.string(),
      reconciliation: z.enum(['applied', 'not_applied']).optional(),
      status: repairItemStatusSchema,
      output: jsonValue,
      error: z.string().nullable(),
    }),
    z.object({
      type: z.literal('mcp_call'),
      threadId: z.string().optional(),
      callId: z.string().optional(),
      serverLabel: z.string(),
      name: z.string(),
      arguments: jsonValue,
      status: repairItemStatusSchema,
      output: jsonValue,
      error: jsonValue,
    }),
    z.object({
      type: z.literal('command_execution'),
      threadId: z.string().optional(),
      callId: z.string().optional(),
      argv: z.array(z.string()).optional(),
      command: z.string(),
      cwd: z.string().nullable(),
      status: repairItemStatusSchema,
      output: z.string().nullable(),
      exitCode: z.number().nullable(),
      durationMs: z.number().nullable(),
    }),
    z.object({
      type: z.literal('file_change'),
      threadId: z.string(),
      callId: z.string(),
      status: repairItemStatusSchema,
      changes: z.record(z.string(), patchChangeSchema),
      stdout: z.string().nullable(),
      stderr: z.string().nullable(),
    }),
    z.object({
      type: z.literal('web_search_call'),
      status: repairItemStatusSchema,
      action: z
        .discriminatedUnion('type', [
          z.object({
            type: z.literal('search'),
            query: z.string().nullable(),
            queries: z.array(z.string()).nullable(),
          }),
          z.object({
            type: z.literal('open_page'),
            url: z.string().nullable(),
          }),
          z.object({
            type: z.literal('find_in_page'),
            url: z.string().nullable(),
            pattern: z.string().nullable(),
          }),
          z.object({ type: z.literal('other') }),
        ])
        .nullable(),
    }),
    z.object({
      type: z.literal('create_subagent_call'),
      status: repairItemStatusSchema,
      agentId: z.string(),
      subagentId: z.string().nullable(),
    }),
    z.object({
      type: z.literal('wait_for_subagents_call'),
      status: repairItemStatusSchema,
      senderAgentId: z.string(),
    }),
    z.object({
      type: z.enum([
        'send_subagent_input_call',
        'resume_subagent_call',
        'interrupt_subagent_call',
        'close_subagent_call',
      ]),
      status: repairItemStatusSchema,
      senderAgentId: z.string(),
      recipientAgentId: z.string(),
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
    },
    outputTokens: usageCount(raw, 'output_tokens'),
    outputTokensDetails: {
      reasoningTokens: usageCount(raw, 'reasoning_output_tokens'),
    },
    totalTokens: usageCount(raw, 'total_tokens'),
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
    case 'search':
      return {
        type: 'search',
        query: text(action.query),
        queries: Array.isArray(action.queries)
          ? action.queries.filter(
              (value): value is string => typeof value === 'string',
            )
          : null,
      };
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
    raw.type !== 'custom_tool_call_output'
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
    raw.type === 'custom_tool_call_output';
  const call = raw.type === 'function_call' || raw.type === 'custom_tool_call';
  const id =
    text(raw.id) ??
    ((call || output) && typeof raw.call_id === 'string'
      ? raw.call_id + (output ? ':output' : '')
      : null);
  if (!id) return null;
  const common = { id, turnId, data: raw };
  if (
    raw.type === 'message' &&
    (raw.role === 'user' || raw.role === 'assistant')
  ) {
    const accepted =
      raw.role === 'user' ? ['input_text', 'input_image'] : ['output_text'];
    return {
      ...common,
      type: 'message',
      role: raw.role,
      status: 'completed',
      phase: raw.role === 'assistant' ? text(raw.phase) : null,
      content: objects(raw.content).filter((part) =>
        accepted.includes(String(part.type)),
      ) as (TextPart | ImagePart)[],
    };
  }
  if (raw.type === 'reasoning')
    return {
      ...common,
      type: 'reasoning',
      summary: objects(raw.summary) as { type: 'summary_text'; text: string }[],
      status: null,
    };
  if (call && typeof raw.call_id === 'string' && typeof raw.name === 'string')
    return {
      ...common,
      type: 'function_call',
      callId: raw.call_id,
      name: raw.namespace ? `${raw.namespace}.${raw.name}` : raw.name,
      arguments: raw.arguments ?? raw.input ?? null,
      status: 'in_progress',
    };
  if (output && typeof raw.call_id === 'string') {
    const reconciliation = reconciliationOutcome(raw);
    return {
      ...common,
      type: 'function_call_output',
      callId: raw.call_id,
      status: reconciliation === 'not_applied' ? 'failed' : 'completed',
      output: raw.output ?? null,
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
            (part): (TextPart | ImagePart)[] =>
              part.type === 'text' && typeof part.text === 'string'
                ? [{ type: 'input_text', text: part.text }]
                : part.type === 'image' && typeof part.image_url === 'string'
                  ? [{ type: 'input_image', image_url: part.image_url }]
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
          content: [
            {
              type: 'output_text',
              text: objects(raw.content)
                .filter((part) => part.type === 'Text')
                .map((part) => text(part.text) ?? '')
                .join(''),
            },
          ],
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
        part.type === 'inputText'
          ? [{ type: 'input_text', text: part.text ?? '' }]
          : part.type === 'inputImage'
            ? [{ type: 'input_image', image_url: part.imageUrl ?? '' }]
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
    case 'WebSearch':
      return [
        {
          ...common,
          type: 'web_search_call',
          status: done ? 'completed' : 'in_progress',
          action: webAction(raw),
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

/** Project canonical records, preferring native item events without inventing final text. */
export function projectHistory(
  history: ThreadHistory,
  sessionId: string,
  subagentId?: string,
) {
  const turns = new Map<string, HistoryTurn>();
  const usage = new Map<string, RecordedTokenUsage>();
  const responseUsage = new Map<string, JsonObject>();
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
    const output = item.type === 'function_call_output';
    const key = JSON.stringify([item.turnId, output, recordedId, item.id]);
    const callKey = JSON.stringify([
      item.turnId,
      'callId' in item ? item.callId : item.id,
    ]);
    const call = latestCalls.get(callKey);
    let occurrence = identities.get(key);
    if (output && call) {
      if (!call.output) occurrence = undefined;
      else if (occurrence === call.output || native !== call.output.native)
        occurrence = call.output;
      else occurrence = undefined;
    } else if (native && call && !call.native) occurrence = call;
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
    if (item.type === 'function_call') latestCalls.set(callKey, occurrence);
    else if (output && call) call.output = occurrence;
    return occurrence;
  }
  const receipts = new Map<string, TurnReceipt>();
  for (const { type, payload, metadata: recordedMetadata } of history) {
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
    } else if (
      type === 'token_usage_record' &&
      typeof payload.turn_id === 'string'
    ) {
      const value = object(payload.turn_token_usage);
      if (value) usage.set(payload.turn_id, recordedUsage(value));
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
        ['function_call_output', 'custom_tool_call_output'].includes(
          String(payload.type),
        ) &&
        metadata?.turn_id === aborted &&
        latestCalls.has(JSON.stringify([aborted, payload.call_id]))
      )
        turn = aborted;
      if (turn) {
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
          responseUsage.delete(id);
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
          if (item) remember({ ...item, data: native }, true);
        }
        continue;
      }
      if (pendingUser?.item.turnId !== id) pendingUser = undefined;
      current = id;
      aborted = null;
      if (!order.includes(id)) order.push(id);
      if (payload.type === 'error' && !failures.has(id))
        failures.set(id, failure(payload));
      if (payload.type === 'raw_response_completed') {
        const report = object(payload.token_usage);
        if (report) {
          const total = responseUsage.get(id) ?? {};
          for (const key of usageFields) {
            const sum = addTokenCounts(
              usageCount(total, key),
              usageCount(report, key),
            );
            total[key] = tokenCountToWire(sum);
          }
          responseUsage.set(id, total);
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
            JSON.stringify([item.turnId, false, true, item.id]),
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
        if (started) {
          failures.delete(id);
          responseUsage.delete(id);
        }
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
    const total = responseUsage.get(id);
    turn.usage = usage.get(id) ?? (total ? recordedUsage(total) : null);
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
      const output = occurrence.output?.item;
      if (output?.type === 'function_call_output' && output.reconciliation)
        item.status = output.status;
      else if (!occurrence.native) {
        const terminal = turns.get(item.turnId)?.status;
        item.status =
          output?.status ??
          (terminal && terminal !== 'in_progress'
            ? 'incomplete'
            : 'in_progress');
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
