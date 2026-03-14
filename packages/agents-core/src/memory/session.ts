import type { AgentInputItem } from '../types';
import type { RequestUsage } from '../usage';

/**
 * A function that combines session history with new input items before the model call.
 */
export type SessionInputCallback = (
  historyItems: AgentInputItem[],
  newItems: AgentInputItem[],
) => AgentInputItem[] | Promise<AgentInputItem[]>;

/**
 * Interface representing a persistent session store for conversation history.
 */
export interface Session {
  /**
   * Ensure and return the identifier for this session.
   */
  getSessionId(): Promise<string>;

  /**
   * Retrieve items from the conversation history.
   *
   * @param limit - The maximum number of items to return. When provided the most
   * recent {@link limit} items should be returned in chronological order.
   */
  getItems(limit?: number): Promise<AgentInputItem[]>;

  /**
   * Append new items to the conversation history.
   *
   * @param items - Items to add to the session history.
   */
  addItems(items: AgentInputItem[]): Promise<void>;

  /**
   * Remove and return the most recent item from the conversation history if it
   * exists.
   */
  popItem(): Promise<AgentInputItem | undefined>;

  /**
   * Remove all items that belong to the session and reset its state.
   */
  clearSession(): Promise<void>;
}

export type SessionFunctionCallItem = Extract<
  AgentInputItem,
  { type: 'function_call' }
>;

export type ReplaceFunctionCallSessionHistoryMutation = {
  /**
   * Replace the canonical persisted function call for this call id and drop any later duplicate
   * function-call items with the same call id.
   */
  type: 'replace_function_call';
  /**
   * Stable tool call identifier shared by the function call and its output.
   */
  callId: string;
  /**
   * Canonical function-call item to keep in persisted history.
   */
  replacement: SessionFunctionCallItem;
};

export type SessionHistoryMutation = ReplaceFunctionCallSessionHistoryMutation;

export type SessionHistoryRewriteArgs = {
  /**
   * Ordered history mutations to apply to the persisted session items.
   */
  mutations: SessionHistoryMutation[];
};

/**
 * Session subtype that can rewrite previously persisted history items after a turn finishes.
 */
export interface SessionHistoryRewriteAwareSession extends Session {
  /**
   * Apply the provided history mutations to the persisted session items.
   */
  applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> | void;
}

export function isSessionHistoryRewriteAwareSession(
  session: Session | undefined,
): session is SessionHistoryRewriteAwareSession {
  return (
    !!session &&
    typeof (session as SessionHistoryRewriteAwareSession)
      .applyHistoryMutations === 'function'
  );
}

/**
 * Session subtype that can run compaction logic after a completed turn is persisted.
 */
export type OpenAIResponsesCompactionArgs = {
  /**
   * The `response.id` from a completed OpenAI Responses API turn, if available.
   *
   * When omitted, implementations may fall back to a cached value or throw.
   */
  responseId?: string | undefined;
  /**
   * How the compaction request should provide conversation history.
   *
   * When omitted, implementations use their configured default.
   */
  compactionMode?: 'previous_response_id' | 'input' | 'auto';
  /**
   * Whether the last model response was stored on the server.
   *
   * When set to false, compaction should avoid `previous_response_id` unless explicitly overridden.
   */
  store?: boolean;
  /**
   * When true, compaction should run regardless of any internal thresholds or hooks.
   */
  force?: boolean;
};

export type OpenAIResponsesCompactionResult = {
  usage: RequestUsage;
};

export interface OpenAIResponsesCompactionAwareSession extends Session {
  /**
   * Invoked by the runner after it persists a completed turn into the session.
   *
   * Implementations may decide to call `responses.compact` (or an equivalent API) and replace the
   * stored history.
   *
   * This hook is best-effort. Implementations should consider handling transient failures and
   * deciding whether to retry or skip compaction for the current turn.
   */
  runCompaction(
    args?: OpenAIResponsesCompactionArgs,
  ):
    | Promise<OpenAIResponsesCompactionResult | null>
    | OpenAIResponsesCompactionResult
    | null;
}

export function isOpenAIResponsesCompactionAwareSession(
  session: Session | undefined,
): session is OpenAIResponsesCompactionAwareSession {
  return (
    !!session &&
    typeof (session as OpenAIResponsesCompactionAwareSession).runCompaction ===
      'function'
  );
}
