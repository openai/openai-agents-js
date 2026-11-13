import {
  losslessJsonValueSchema,
  type JsonObject,
  type JsonValue,
} from './binding';
import type { BoundDecide } from './decisions';
import type { ToolCallInfo } from './call-metadata';
import type { ToolOutput } from './tools';

/** Accept by returning undefined, continue with feedback, or stop this turn. */
export type CompletionDecision =
  | { readonly action: 'continue'; readonly instructions: string }
  | { readonly action: 'stop' };

/** Proposed completion before acceptance. Already streamed text stays visible. */
export interface CompletionContext<Context = unknown, Output = JsonValue> {
  /** Available only until this hook invocation settles. */
  readonly decide: BoundDecide;
  readonly context: Context;
  readonly text: string | null;
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId?: string;
  readonly model: string;
  readonly continuationCount: number;
  readonly signal: AbortSignal;
  readonly toolCall?: ToolCallInfo;
  readonly toolBatchCallIds?: readonly string[];
  /** Detached validated JSON proposal; editing it cannot change accepted output. */
  readonly finalOutput?: Output;
}

/** Captured history before summarization. A returned summary becomes canonical history. */
export interface CompactionContext<Context = unknown> {
  readonly context: Context;
  readonly items: readonly JsonObject[];
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId?: string;
  readonly requestId: string;
  readonly model: string;
  readonly automatic: boolean;
  readonly signal: AbortSignal;
}
/** Return a nonempty summary to skip native summarization, or undefined to use it. */
export type BeforeCompact<Context = unknown> = (
  context: CompactionContext<Context>,
) => string | void | Promise<string | void>;

/**
 * Request-only Responses input; replacements never rewrite canonical history.
 * Application instruction envelopes are input items, so filtering them changes
 * that request. Core base instructions and tool declarations remain separate.
 * Restore binds fresh callbacks from the supplied Agent declarations.
 */
export interface ModelRequestContext<Context = unknown> {
  readonly context: Context;
  readonly items: readonly JsonObject[];
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId?: string;
  /** Native request-projection identity; this is not an upstream HTTP request ID. */
  readonly requestId: string;
  readonly model: string;
  readonly purpose: 'turn' | 'compaction' | 'output_repair';
  readonly signal: AbortSignal;
}
export type BeforeComplete<Context = unknown> = (
  context: CompletionContext<Context>,
) => void | CompletionDecision | Promise<void | CompletionDecision>;

/** Accepted output and original arguments from one direct function call. */
export interface ToolBatchResult {
  readonly call: ToolCallInfo;
  readonly arguments: string;
  readonly output: ToolOutput;
}

/** Live settled direct function results in their original model call order. */
export interface ToolBatchCompletionContext<Context = unknown> {
  readonly context: Context;
  readonly results: readonly ToolBatchResult[];
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId?: string;
  readonly model: string;
  readonly continuationCount: number;
  readonly signal: AbortSignal;
}

export type ToolBatchCompletionDecision =
  | CompletionDecision
  | { readonly action: 'finish'; readonly output: JsonValue };

/**
 * Finish supplies JSON input for the output validator; undefined continues normally.
 * A restored batch reaches this callback only when every included tool result was
 * supplied after restore. Newly sampled batches follow the usual rules.
 */
export type ToolBatchCompletion<Context = unknown> = (
  context: ToolBatchCompletionContext<Context>,
) =>
  | void
  | ToolBatchCompletionDecision
  | Promise<void | ToolBatchCompletionDecision>;

/** @internal Detach final data before any further callback or native await. */
export function captureToolBatchDecision(
  value: unknown,
): ToolBatchCompletionDecision | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const captured = { ...value } as Record<string, unknown>;
    if (
      captured.action === 'finish' &&
      Object.keys(captured).length === 2 &&
      Object.hasOwn(captured, 'output')
    ) {
      try {
        return Object.freeze({
          action: 'finish',
          output: losslessJsonValueSchema.parse(captured.output),
        });
      } catch {
        throw new TypeError('Tool batch final output must be JSON data');
      }
    }
    return captureCompletionDecision(captured);
  }
  return captureCompletionDecision(value);
}
export type ContextTransform<Context = unknown> = (
  context: ModelRequestContext<Context>,
) => readonly JsonObject[] | void | Promise<readonly JsonObject[] | void>;

/** @internal Capture a closed decision before returning to native ownership checks. */
export function captureCompletionDecision(
  value: unknown,
): CompletionDecision | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected a completion decision');
  const captured = { ...value } as Record<string, unknown>;
  if (captured.action === 'stop' && Object.keys(captured).length === 1)
    return Object.freeze({ action: 'stop' });
  if (
    captured.action === 'continue' &&
    Object.keys(captured).length === 2 &&
    typeof captured.instructions === 'string' &&
    captured.instructions.trim()
  )
    return Object.freeze({
      action: 'continue',
      instructions: captured.instructions,
    });
  throw new TypeError('Expected stop or continue with nonempty instructions');
}
