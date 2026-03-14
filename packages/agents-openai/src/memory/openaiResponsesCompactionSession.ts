import OpenAI from 'openai';
import {
  getLogger,
  MemorySession,
  RequestUsage,
  UserError,
} from '@openai/agents-core';
import type {
  AgentInputItem,
  OpenAIResponsesCompactionArgs,
  OpenAIResponsesCompactionAwareSession as OpenAIResponsesCompactionSessionLike,
  Session,
  SessionHistoryMutation,
  SessionHistoryRewriteArgs,
  SessionHistoryRewriteAwareSession,
} from '@openai/agents-core';
import type { OpenAIResponsesCompactionResult } from '@openai/agents-core';
import { DEFAULT_OPENAI_MODEL, getDefaultOpenAIClient } from '../defaults';
import { getInputItems } from '../openaiResponsesModel';
import {
  OPENAI_SESSION_API,
  type OpenAISessionApiTagged,
} from './openaiSessionApi';

const DEFAULT_COMPACTION_THRESHOLD = 10;
const logger = getLogger('openai-agents:openai:compaction');

export type OpenAIResponsesCompactionMode =
  | 'previous_response_id'
  | 'input'
  | 'auto';

export type OpenAIResponsesCompactionDecisionContext = {
  /**
   * The `response.id` from a completed OpenAI Responses API turn, if available.
   * When `compactionMode` is `input`, this may be undefined.
   */
  responseId: string | undefined;
  /**
   * Resolved compaction mode used for this request.
   */
  compactionMode: OpenAIResponsesCompactionMode;
  /**
   * Items considered compaction candidates (excludes user and compaction items).
   * The array must not be mutated.
   */
  compactionCandidateItems: AgentInputItem[];
  /**
   * All stored items retrieved from the underlying session, if available.
   * The array must not be mutated.
   */
  sessionItems: AgentInputItem[];
};

export type OpenAIResponsesCompactionSessionOptions = {
  /**
   * OpenAI client used to call `responses.compact`.
   *
   * When omitted, the session will use `getDefaultOpenAIClient()` if configured. Otherwise it
   * creates a new `OpenAI()` instance via `new OpenAI()`.
   */
  client?: OpenAI;
  /**
   * Session store that receives items and holds the compacted history.
   *
   * The underlying session is the source of truth for persisted items. Compaction clears the
   * underlying session and writes the output items returned by `responses.compact`.
   *
   * This must not be an `OpenAIConversationsSession`, because compaction relies on locally stored
   * items and replaces the underlying session history after `responses.compact`.
   *
   * Defaults to an in-memory session for demos.
   */
  underlyingSession?: Session & { [OPENAI_SESSION_API]?: 'responses' };
  /**
   * The OpenAI model to use for `responses.compact`.
   *
   * Defaults to `DEFAULT_OPENAI_MODEL`. The value must resemble an OpenAI model name (for example
   * `gpt-*`, `o*`, or a fine-tuned `ft:gpt-*` identifier), otherwise the constructor throws.
   */
  model?: OpenAI.ResponsesModel;
  /**
   * Controls how the compaction request is built.
   *
   * - `auto` (default): Uses `input` when the last response was not stored or no response id is available.
   * - `previous_response_id`: Uses the server-managed response chain.
   * - `input`: Sends the locally stored session items as input and does not require a response id.
   *
   * Local history rewrites (for example, approval override argument corrections) temporarily force
   * compaction through `input` until a newer response id is observed, because the stored
   * `previous_response_id` chain no longer matches the canonical local transcript.
   */
  compactionMode?: OpenAIResponsesCompactionMode;
  /**
   * Custom decision hook that determines whether to call `responses.compact`.
   *
   * The default implementation compares the length of
   * {@link OpenAIResponsesCompactionDecisionContext.compactionCandidateItems} to an internal threshold
   * (10). Override this to support token-based triggers or other heuristics using
   * {@link OpenAIResponsesCompactionDecisionContext.compactionCandidateItems} or
   * {@link OpenAIResponsesCompactionDecisionContext.sessionItems}.
   */
  shouldTriggerCompaction?: (
    context: OpenAIResponsesCompactionDecisionContext,
  ) => boolean | Promise<boolean>;
};

/**
 * Session decorator that triggers `responses.compact` when the stored history grows.
 *
 * This session is intended to be passed to `run()` so the runner can automatically supply the
 * latest `responseId` and invoke compaction after each completed turn is persisted.
 *
 * To debug compaction decisions, enable the `debug` logger for
 * `openai-agents:openai:compaction` (for example, `DEBUG=openai-agents:openai:compaction`).
 */
export class OpenAIResponsesCompactionSession
  implements
    OpenAIResponsesCompactionSessionLike,
    SessionHistoryRewriteAwareSession,
    OpenAISessionApiTagged<'responses'>
{
  readonly [OPENAI_SESSION_API] = 'responses' as const;

  private readonly client: OpenAI;
  private readonly underlyingSession: Session;
  private readonly model: OpenAI.ResponsesModel;
  private readonly compactionMode: OpenAIResponsesCompactionMode;
  private responseId?: string;
  private lastStore?: boolean;
  private readonly shouldTriggerCompaction: (
    context: OpenAIResponsesCompactionDecisionContext,
  ) => boolean | Promise<boolean>;
  private compactionCandidateItems: AgentInputItem[] | undefined;
  private sessionItems: AgentInputItem[] | undefined;
  private hasPendingLocalHistoryRewrite: boolean;
  private localHistoryRewriteResponseId?: string;

  constructor(options: OpenAIResponsesCompactionSessionOptions) {
    this.client = resolveClient(options);
    if (isOpenAIConversationsSessionDelegate(options.underlyingSession)) {
      throw new UserError(
        'OpenAIResponsesCompactionSession does not support OpenAIConversationsSession as an underlying session.',
      );
    }
    this.underlyingSession = options.underlyingSession ?? new MemorySession();
    const model = (options.model ?? DEFAULT_OPENAI_MODEL).trim();

    assertSupportedOpenAIResponsesCompactionModel(model);
    this.model = model;

    this.compactionMode = options.compactionMode ?? 'auto';
    this.shouldTriggerCompaction =
      options.shouldTriggerCompaction ?? defaultShouldTriggerCompaction;
    this.compactionCandidateItems = undefined;
    this.sessionItems = undefined;
    this.lastStore = undefined;
    this.hasPendingLocalHistoryRewrite = false;
    this.localHistoryRewriteResponseId = undefined;
  }

  async runCompaction(
    args: OpenAIResponsesCompactionArgs = {},
  ): Promise<OpenAIResponsesCompactionResult | null> {
    this.responseId = args.responseId ?? this.responseId ?? undefined;
    if (args.store !== undefined) {
      this.lastStore = args.store;
    }
    const requestedMode = args.compactionMode ?? this.compactionMode;
    const resolvedMode = this.resolveCompactionMode({
      requestedMode,
      responseId: this.responseId,
      store: args.store ?? this.lastStore,
    });

    if (resolvedMode === 'previous_response_id' && !this.responseId) {
      throw new UserError(
        'OpenAIResponsesCompactionSession.runCompaction requires a responseId from the last completed turn when using previous_response_id compaction.',
      );
    }

    const { compactionCandidateItems, sessionItems } =
      await this.ensureCompactionCandidates();
    const shouldTriggerCompaction =
      args.force === true
        ? true
        : await this.shouldTriggerCompaction({
            responseId: this.responseId,
            compactionMode: resolvedMode,
            compactionCandidateItems,
            sessionItems,
          });
    if (!shouldTriggerCompaction) {
      logger.debug('skip: decision hook %o', {
        responseId: this.responseId,
        compactionMode: resolvedMode,
      });
      return null;
    }

    const unresolvedFunctionCalls =
      findUnresolvedFunctionCallsWithoutResults(sessionItems);
    if (unresolvedFunctionCalls.length > 0) {
      logger.debug('compact: blocked unresolved function calls %o', {
        responseId: this.responseId,
        compactionMode: resolvedMode,
        unresolvedCallIds: unresolvedFunctionCalls.map((item) => item.callId),
      });
      throw new UserError(
        'OpenAIResponsesCompactionSession cannot compact history with unresolved function_call items. responses.compact requires each function_call to have a matching function_call_result. Resume or reject the interruption before compaction runs.',
      );
    }

    logger.debug('compact: start %o', {
      responseId: this.responseId,
      model: this.model,
      compactionMode: resolvedMode,
    });

    const compactRequest: OpenAI.Responses.ResponseCompactParams = {
      model: this.model,
    };
    if (resolvedMode === 'previous_response_id') {
      compactRequest.previous_response_id = this.responseId!;
    } else {
      compactRequest.input = getInputItems(sessionItems);
    }

    const compacted = await this.client.responses.compact(compactRequest);

    await this.underlyingSession.clearSession();
    const outputItems = (compacted.output ?? []) as AgentInputItem[];
    if (outputItems.length > 0) {
      await this.underlyingSession.addItems(outputItems);
    }
    this.compactionCandidateItems = selectCompactionCandidateItems(outputItems);
    this.sessionItems = outputItems;

    logger.debug('compact: done %o', {
      responseId: this.responseId,
      compactionMode: resolvedMode,
      outputItemCount: outputItems.length,
      candidateCount: this.compactionCandidateItems.length,
    });

    return {
      usage: toRequestUsage(compacted.usage),
    };
  }

  async getSessionId(): Promise<string> {
    return this.underlyingSession.getSessionId();
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.underlyingSession.getItems(limit);
  }

  async applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> {
    if (args.mutations.length === 0) {
      return;
    }

    if (isSessionHistoryRewriteDelegate(this.underlyingSession)) {
      await this.underlyingSession.applyHistoryMutations(args);
      await this.refreshCachesFromUnderlyingSession();
      this.markLocalHistoryRewrite();
      return;
    }

    const rewrittenItems = applySessionHistoryMutations(
      await this.underlyingSession.getItems(),
      args.mutations,
    );
    await this.underlyingSession.clearSession();
    if (rewrittenItems.length > 0) {
      await this.underlyingSession.addItems(rewrittenItems);
    }
    this.sessionItems = rewrittenItems;
    this.compactionCandidateItems =
      selectCompactionCandidateItems(rewrittenItems);
    this.markLocalHistoryRewrite();
  }

  async addItems(items: AgentInputItem[]) {
    if (items.length === 0) {
      return;
    }

    await this.underlyingSession.addItems(items);
    if (this.compactionCandidateItems) {
      const candidates = selectCompactionCandidateItems(items);
      if (candidates.length > 0) {
        this.compactionCandidateItems = [
          ...this.compactionCandidateItems,
          ...candidates,
        ];
      }
    }
    if (this.sessionItems) {
      this.sessionItems = [...this.sessionItems, ...items];
    }
  }

  async popItem() {
    const popped = await this.underlyingSession.popItem();
    if (!popped) {
      return popped;
    }
    if (this.sessionItems) {
      const index = this.sessionItems.lastIndexOf(popped);
      if (index >= 0) {
        this.sessionItems.splice(index, 1);
      } else {
        this.sessionItems = await this.underlyingSession.getItems();
      }
    }
    if (this.compactionCandidateItems) {
      const isCandidate = selectCompactionCandidateItems([popped]).length > 0;
      if (isCandidate) {
        const index = this.compactionCandidateItems.indexOf(popped);
        if (index >= 0) {
          this.compactionCandidateItems.splice(index, 1);
        } else {
          // Fallback when the popped item reference differs from stored candidates.
          this.compactionCandidateItems = selectCompactionCandidateItems(
            await this.underlyingSession.getItems(),
          );
        }
      }
    }
    return popped;
  }

  async clearSession() {
    await this.underlyingSession.clearSession();
    this.compactionCandidateItems = [];
    this.sessionItems = [];
    this.hasPendingLocalHistoryRewrite = false;
    this.localHistoryRewriteResponseId = undefined;
  }

  private async refreshCachesFromUnderlyingSession(): Promise<void> {
    const history = await this.underlyingSession.getItems();
    this.sessionItems = history;
    this.compactionCandidateItems = selectCompactionCandidateItems(history);
  }

  private async ensureCompactionCandidates(): Promise<{
    compactionCandidateItems: AgentInputItem[];
    sessionItems: AgentInputItem[];
  }> {
    if (this.compactionCandidateItems && this.sessionItems) {
      logger.debug('candidates: cached %o', {
        candidateCount: this.compactionCandidateItems.length,
      });
      return {
        compactionCandidateItems: [...this.compactionCandidateItems],
        sessionItems: [...this.sessionItems],
      };
    }
    const history = await this.underlyingSession.getItems();
    const compactionCandidates = selectCompactionCandidateItems(history);
    this.compactionCandidateItems = compactionCandidates;
    this.sessionItems = history;
    logger.debug('candidates: initialized %o', {
      historyLength: history.length,
      candidateCount: compactionCandidates.length,
    });
    return {
      compactionCandidateItems: [...compactionCandidates],
      sessionItems: [...history],
    };
  }

  private markLocalHistoryRewrite(): void {
    this.hasPendingLocalHistoryRewrite = true;
    this.localHistoryRewriteResponseId = this.responseId;
  }

  private resolveCompactionMode(options: {
    requestedMode: OpenAIResponsesCompactionMode;
    responseId: string | undefined;
    store: boolean | undefined;
  }): ResolvedCompactionMode {
    const resolvedMode = resolveCompactionMode(options);

    if (!this.hasPendingLocalHistoryRewrite) {
      return resolvedMode;
    }

    if (
      typeof this.localHistoryRewriteResponseId !== 'undefined' &&
      typeof options.responseId !== 'undefined' &&
      options.responseId !== this.localHistoryRewriteResponseId
    ) {
      this.hasPendingLocalHistoryRewrite = false;
      this.localHistoryRewriteResponseId = undefined;
      return resolvedMode;
    }

    if (
      this.hasPendingLocalHistoryRewrite &&
      resolvedMode === 'previous_response_id'
    ) {
      if (
        typeof this.localHistoryRewriteResponseId === 'undefined' &&
        typeof options.responseId !== 'undefined'
      ) {
        this.localHistoryRewriteResponseId = options.responseId;
      }
      logger.debug(
        'compact: forcing input mode after local history rewrite %o',
        {
          responseId: options.responseId,
          requestedMode: options.requestedMode,
        },
      );
      return 'input';
    }

    return resolvedMode;
  }
}

type ResolvedCompactionMode = Exclude<OpenAIResponsesCompactionMode, 'auto'>;

function resolveCompactionMode(options: {
  requestedMode: OpenAIResponsesCompactionMode;
  responseId: string | undefined;
  store: boolean | undefined;
}): ResolvedCompactionMode {
  const { requestedMode, responseId, store } = options;
  if (requestedMode !== 'auto') {
    return requestedMode;
  }
  if (store === false) {
    return 'input';
  }
  if (!responseId) {
    return 'input';
  }
  return 'previous_response_id';
}

function resolveClient(
  options: OpenAIResponsesCompactionSessionOptions,
): OpenAI {
  if (options.client) {
    return options.client;
  }

  const defaultClient = getDefaultOpenAIClient();
  if (defaultClient) {
    return defaultClient;
  }

  return new OpenAI();
}

function defaultShouldTriggerCompaction({
  compactionCandidateItems,
}: OpenAIResponsesCompactionDecisionContext): boolean {
  return compactionCandidateItems.length >= DEFAULT_COMPACTION_THRESHOLD;
}

function selectCompactionCandidateItems(
  items: AgentInputItem[],
): AgentInputItem[] {
  return items.filter((item) => {
    if (item.type === 'compaction') {
      return false;
    }
    return !(item.type === 'message' && item.role === 'user');
  });
}

function findUnresolvedFunctionCallsWithoutResults(
  items: AgentInputItem[],
): Extract<AgentInputItem, { type: 'function_call' }>[] {
  const functionCalls = new Map<
    string,
    Extract<AgentInputItem, { type: 'function_call' }>
  >();
  const resolvedCallIds = new Set<string>();

  for (const item of items) {
    if (item.type === 'function_call') {
      functionCalls.set(item.callId, item);
      continue;
    }

    if (item.type === 'function_call_result') {
      resolvedCallIds.add(item.callId);
    }
  }

  return [...functionCalls.values()].filter(
    (item) => !resolvedCallIds.has(item.callId),
  );
}

function assertSupportedOpenAIResponsesCompactionModel(model: string): void {
  if (!isOpenAIModelName(model)) {
    throw new Error(
      `Unsupported model for OpenAI responses compaction: ${JSON.stringify(model)}`,
    );
  }
}

function isOpenAIModelName(model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed) {
    return false;
  }
  // The OpenAI SDK does not ship a runtime allowlist of model names.
  // This check relies on common model naming conventions and intentionally allows unknown `gpt-*` variants.
  // Fine-tuned model IDs typically look like: ft:gpt-4o-mini:org:project:suffix.
  const withoutFineTunePrefix = trimmed.startsWith('ft:')
    ? trimmed.slice('ft:'.length)
    : trimmed;
  const root = withoutFineTunePrefix.split(':', 1)[0];

  // Allow unknown `gpt-*` variants to avoid needing updates whenever new models ship.
  if (root.startsWith('gpt-')) {
    return true;
  }
  // Allow the `o*` reasoning models
  if (/^o\d[a-z0-9-]*$/i.test(root)) {
    return true;
  }

  return false;
}

function toRequestUsage(
  usage: OpenAI.Responses.ResponseUsage | undefined,
): RequestUsage {
  return new RequestUsage({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    inputTokensDetails: { ...usage?.input_tokens_details },
    outputTokensDetails: { ...usage?.output_tokens_details },
    endpoint: 'responses.compact',
  });
}

function isOpenAIConversationsSessionDelegate(
  underlyingSession: Session | undefined,
): underlyingSession is Session & OpenAISessionApiTagged<'conversations'> {
  return (
    !!underlyingSession &&
    typeof underlyingSession === 'object' &&
    OPENAI_SESSION_API in underlyingSession &&
    (underlyingSession as OpenAISessionApiTagged<'conversations'>)[
      OPENAI_SESSION_API
    ] === 'conversations'
  );
}

function isSessionHistoryRewriteDelegate(
  session: Session | undefined,
): session is SessionHistoryRewriteAwareSession {
  return (
    !!session &&
    typeof (session as SessionHistoryRewriteAwareSession)
      .applyHistoryMutations === 'function'
  );
}

function applySessionHistoryMutations(
  items: AgentInputItem[],
  mutations: SessionHistoryMutation[],
): AgentInputItem[] {
  let nextItems = items.map((item) => structuredClone(item));

  for (const mutation of mutations) {
    if (mutation.type === 'replace_function_call') {
      nextItems = applyReplaceFunctionCallMutation(nextItems, mutation);
    }
  }

  return nextItems;
}

function applyReplaceFunctionCallMutation(
  items: AgentInputItem[],
  mutation: Extract<SessionHistoryMutation, { type: 'replace_function_call' }>,
): AgentInputItem[] {
  const replacement = structuredClone(mutation.replacement);
  const nextItems: AgentInputItem[] = [];
  let keptReplacement = false;

  for (const item of items) {
    if (item.type === 'function_call' && item.callId === mutation.callId) {
      if (!keptReplacement) {
        nextItems.push(replacement);
        keptReplacement = true;
      }
      continue;
    }

    nextItems.push(item);
  }

  if (!keptReplacement) {
    nextItems.push(replacement);
  }

  return nextItems;
}
