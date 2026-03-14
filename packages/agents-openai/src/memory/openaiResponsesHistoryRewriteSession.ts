import {
  getLogger,
  isOpenAIResponsesCompactionAwareSession,
  MemorySession,
  UserError,
} from '@openai/agents-core';
import type {
  AgentInputItem,
  OpenAIResponsesCompactionArgs,
  OpenAIResponsesCompactionAwareSession,
  OpenAIResponsesCompactionResult,
  Session,
  SessionHistoryMutation,
  SessionHistoryRewriteArgs,
  SessionHistoryRewriteAwareSession,
} from '@openai/agents-core';
import {
  OPENAI_SESSION_API,
  type OpenAISessionApiTagged,
} from './openaiSessionApi';

const logger = getLogger('openai-agents:openai:history-rewrite');

export type OpenAIResponsesHistoryRewriteSessionOptions = {
  /**
   * Session store that receives rewritten local history.
   *
   * Defaults to an in-memory session for demos and tests.
   */
  underlyingSession?: Session & { [OPENAI_SESSION_API]?: 'responses' };
};

/**
 * Session decorator that keeps local Responses-style history canonical after targeted rewrites.
 *
 * This decorator never calls the OpenAI API. It rewrites the underlying local session by applying
 * structured history mutations after the runner persists a turn. Do not use it with
 * `OpenAIConversationsSession`, which owns server-managed history.
 */
export class OpenAIResponsesHistoryRewriteSession
  implements
    SessionHistoryRewriteAwareSession,
    OpenAIResponsesCompactionAwareSession,
    OpenAISessionApiTagged<'responses'>
{
  readonly [OPENAI_SESSION_API] = 'responses' as const;

  private readonly underlyingSession: Session;

  constructor(options: OpenAIResponsesHistoryRewriteSessionOptions = {}) {
    if (isOpenAIConversationsSessionDelegate(options.underlyingSession)) {
      throw new UserError(
        'OpenAIResponsesHistoryRewriteSession does not support OpenAIConversationsSession as an underlying session.',
      );
    }

    this.underlyingSession = options.underlyingSession ?? new MemorySession();
  }

  async getSessionId(): Promise<string> {
    return this.underlyingSession.getSessionId();
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.underlyingSession.getItems(limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.underlyingSession.addItems(items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.underlyingSession.popItem();
  }

  async clearSession(): Promise<void> {
    await this.underlyingSession.clearSession();
  }

  async applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> {
    if (args.mutations.length === 0) {
      return;
    }

    if (isSessionHistoryRewriteDelegate(this.underlyingSession)) {
      await this.underlyingSession.applyHistoryMutations(args);
      return;
    }

    const rewrittenItems = applySessionHistoryMutations(
      await this.underlyingSession.getItems(),
      args.mutations,
    );

    logger.debug('rewrite: replacing session history %o', {
      mutationCount: args.mutations.length,
      outputItemCount: rewrittenItems.length,
    });

    await this.underlyingSession.clearSession();
    if (rewrittenItems.length > 0) {
      await this.underlyingSession.addItems(rewrittenItems);
    }
  }

  async runCompaction(
    args?: OpenAIResponsesCompactionArgs,
  ): Promise<OpenAIResponsesCompactionResult | null> {
    if (!isOpenAIResponsesCompactionAwareSession(this.underlyingSession)) {
      return null;
    }

    return this.underlyingSession.runCompaction(args);
  }
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

  return nextItems;
}
