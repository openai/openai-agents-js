import type { AgentInputItem } from '../types';
import type { RunContext } from '../runContext';
import type { RequestUsage } from '../usage';

/**
 * A function that combines session history with new input items before the model call.
 */
export type SessionInputCallback = (
  historyItems: AgentInputItem[],
  newItems: AgentInputItem[],
) => AgentInputItem[] | Promise<AgentInputItem[]>;

export type SessionHistoryReplaceFunctionCallMutation = {
  type: 'replace_function_call';
  callId: string;
  replacement: Extract<AgentInputItem, { type: 'function_call' }>;
};

export type SessionHistoryMutation = SessionHistoryReplaceFunctionCallMutation;

export type SessionHistoryRewriteArgs = {
  mutations: SessionHistoryMutation[];
};

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
   * Optionally rewrite a stored history item before it is sent back to the model.
   *
   * Session implementations can use this to strip provider-managed replay metadata while
   * preserving their public `getItems()` shape for UI and deletion workflows.
   */
  prepareHistoryItemForModelInput?(item: AgentInputItem): AgentInputItem;

  /**
   * Optionally normalize stored and expected history before persistence reconciliation compares
   * them.
   *
   * Session implementations can use this to remove backend-assigned metadata while preserving
   * their public `getItems()` shape.
   */
  prepareHistoryItemsForPersistenceComparison?(
    items: AgentInputItem[],
  ): AgentInputItem[];

  /**
   * Optionally preserve reasoning item IDs when persisting generated output.
   *
   * Some remote session stores require provider-assigned reasoning identities to accept stored
   * reasoning items, even when model replay should omit those IDs.
   */
  preserveReasoningItemIdsForPersistence?(): boolean;

  /**
   * Append new items to the conversation history.
   *
   * @param items - Items to add to the session history.
   */
  addItems(items: AgentInputItem[]): Promise<void>;

  /**
   * Optionally replace the logical session history with a compaction marker and its retained
   * suffix without resetting the session identity.
   *
   * Implementations may append the replacement when their backend treats the leading compaction
   * item as the authoritative replay boundary. If this method is absent, the runner falls back to
   * clearing and rebuilding the session with rollback protection.
   */
  replaceHistoryWithCompaction?(items: AgentInputItem[]): Promise<void>;

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

/**
 * Optional session capability for receiving the active run context.
 *
 * Sessions opt in explicitly so existing implementations keep their legacy method call shapes.
 * The runner passes the same {@link RunContext} instance to every history operation in a run.
 */
export interface RunContextAwareSession<TContext = unknown> extends Session {
  readonly acceptsRunContext: true;

  getItems(
    limit?: number,
    runContext?: RunContext<TContext>,
  ): Promise<AgentInputItem[]>;

  addItems(
    items: AgentInputItem[],
    runContext?: RunContext<TContext>,
  ): Promise<void>;

  replaceHistoryWithCompaction?(
    items: AgentInputItem[],
    runContext?: RunContext<TContext>,
  ): Promise<void>;

  popItem(
    runContext?: RunContext<TContext>,
  ): Promise<AgentInputItem | undefined>;

  clearSession(runContext?: RunContext<TContext>): Promise<void>;
}

export interface SessionHistoryRewriteAwareSession extends Session {
  applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> | void;
}

export type SessionHistoryAppendItemsTransaction = {
  type: 'append_items';
  items: AgentInputItem[];
};

export type SessionHistoryReplaceSuffixTransaction = {
  type: 'replace_suffix';
  expectedSuffix: AgentInputItem[];
  replacement: AgentInputItem[];
};

export type SessionHistoryTransaction =
  SessionHistoryAppendItemsTransaction | SessionHistoryReplaceSuffixTransaction;

export type SessionHistoryTransactionArgs = {
  /**
   * A non-empty identifier that remains stable when this transaction is retried.
   */
  operationId: string;
  transaction: SessionHistoryTransaction;
};

/**
 * Optional session capability for atomic, idempotent history changes.
 *
 * Implementations must persist the operation identifier and history change atomically. Repeating
 * an operation identifier with the same transaction must succeed without applying the transaction
 * again. Reusing an operation identifier with a different transaction, or attempting to replace a
 * suffix that does not match, must fail without changing history.
 *
 * Implementations may reject item metadata that cannot be snapshotted and compared deterministically,
 * but must do so before changing history or recording the operation identifier.
 */
export interface SessionHistoryTransactionAwareSession extends Session {
  applyHistoryTransaction(
    args: SessionHistoryTransactionArgs,
    runContext?: RunContext<any>,
  ): Promise<void> | void;
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
    runContext?: RunContext<any>,
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

export function isRunContextAwareSession(
  session: Session | undefined,
): session is RunContextAwareSession<unknown> {
  return (
    !!session &&
    (session as Partial<RunContextAwareSession<unknown>>).acceptsRunContext ===
      true
  );
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

export function isSessionHistoryTransactionAwareSession(
  session: Session | undefined,
): session is SessionHistoryTransactionAwareSession {
  return (
    !!session &&
    typeof (session as SessionHistoryTransactionAwareSession)
      .applyHistoryTransaction === 'function'
  );
}
