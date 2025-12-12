import OpenAI from 'openai';
import { getLogger, MemorySession, UserError } from '@openai/agents-core';
import type {
  AgentInputItem,
  OpenAIResponsesCompactionArgs,
  OpenAIResponsesCompactionAwareSession as OpenAIResponsesCompactionSessionLike,
  Session,
} from '@openai/agents-core';
import { DEFAULT_OPENAI_MODEL, getDefaultOpenAIClient } from '../defaults';
import {
  OPENAI_SESSION_API,
  type OpenAISessionApiTagged,
} from './openaiSessionApi';

const DEFAULT_COMPACTION_THRESHOLD = 10;
const logger = getLogger('openai-agents:openai:compaction');

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
   * This must not be an `OpenAIConversationsSession`, because compaction relies on the Responses
   * API `previous_response_id` flow.
   *
   * Defaults to an in-memory session for demos.
   */
  underlyingSession?: Session & { [OPENAI_SESSION_API]?: 'responses' };
  /**
   * Compaction threshold based on the number of compaction items currently stored in the
   * underlying session. Defaults to 10.
   *
   * This is a heuristic intended to avoid calling `responses.compact` too frequently in small demos.
   * Tune this based on your latency/cost budget and how quickly your session grows.
   *
   * The default counter excludes user messages and `compaction` items, so tool calls, assistant
   * messages, and other non-user items contribute to the threshold by default.
   */
  compactionThreshold?: number;
  /**
   * The OpenAI model to use for `responses.compact`.
   *
   * Defaults to `DEFAULT_OPENAI_MODEL`. The value must resemble an OpenAI model name (for example
   * `gpt-*`, `o*`, or a fine-tuned `ft:gpt-*` identifier), otherwise the constructor throws.
   */
  model?: OpenAI.ResponsesModel;
  /**
   * Returns the number of items that should contribute to the compaction threshold.
   *
   * This function is used to decide when to call `responses.compact`, and it is also used to keep
   * an incremental count as new items are appended to the underlying session.
   *
   * Defaults to counting every stored item except `compaction` items and user messages.
   */
  countCompactionItems?: (items: AgentInputItem[]) => number;
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
    OpenAISessionApiTagged<'responses'>
{
  readonly [OPENAI_SESSION_API] = 'responses' as const;

  private readonly client: OpenAI;
  private readonly underlyingSession: Session;
  private readonly compactionThreshold: number;
  private readonly model: OpenAI.ResponsesModel;
  private responseId?: string;
  private readonly countCompactionItems: (items: AgentInputItem[]) => number;
  private compactionCandidateCount: number | undefined;

  constructor(options: OpenAIResponsesCompactionSessionOptions) {
    this.client = resolveClient(options);
    if (isOpenAIConversationsSessionDelegate(options.underlyingSession)) {
      throw new UserError(
        'OpenAIResponsesCompactionSession does not support OpenAIConversationsSession as an underlying session.',
      );
    }
    this.underlyingSession = options.underlyingSession ?? new MemorySession();
    this.compactionThreshold =
      options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
    const model = (options.model ?? DEFAULT_OPENAI_MODEL).trim();

    assertSupportedOpenAIResponsesCompactionModel(model);
    this.model = model;

    this.countCompactionItems =
      options.countCompactionItems ?? defaultCountCompactionItems;
    this.compactionCandidateCount = undefined;
  }

  async runCompaction(args: OpenAIResponsesCompactionArgs) {
    this.responseId = args.responseId ?? undefined;

    if (!this.responseId) {
      logger.debug('skip: missing responseId');
      return;
    }

    const candidateCount = await this.ensureCandidateCountInitialized();
    if (candidateCount < this.compactionThreshold) {
      logger.debug('skip: below threshold %o', {
        responseId: this.responseId,
        candidateCount,
        threshold: this.compactionThreshold,
      });
      return;
    }

    logger.debug('compact: start %o', {
      responseId: this.responseId,
      model: this.model,
      candidateCount,
      threshold: this.compactionThreshold,
    });

    const compacted = await this.client.responses.compact({
      previous_response_id: this.responseId,
      model: this.model,
    });

    await this.underlyingSession.clearSession();
    const outputItems = (compacted.output ?? []) as AgentInputItem[];
    if (outputItems.length > 0) {
      await this.underlyingSession.addItems(outputItems);
    }
    this.compactionCandidateCount = this.countCompactionItems(outputItems);

    logger.debug('compact: done %o', {
      responseId: this.responseId,
      outputItemCount: outputItems.length,
      candidateCount: this.compactionCandidateCount,
    });
  }

  async getSessionId(): Promise<string> {
    return this.underlyingSession.getSessionId();
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.underlyingSession.getItems(limit);
  }

  async addItems(items: AgentInputItem[]) {
    if (items.length === 0) {
      return;
    }

    await this.underlyingSession.addItems(items);
    if (this.compactionCandidateCount !== undefined) {
      this.compactionCandidateCount += this.countCompactionItems(items);
    }
  }

  async popItem() {
    const popped = await this.underlyingSession.popItem();
    if (!popped) {
      return popped;
    }
    if (this.compactionCandidateCount !== undefined) {
      this.compactionCandidateCount = Math.max(
        0,
        this.compactionCandidateCount - this.countCompactionItems([popped]),
      );
    }
    return popped;
  }

  async clearSession() {
    await this.underlyingSession.clearSession();
    this.compactionCandidateCount = 0;
  }

  private async ensureCandidateCountInitialized(): Promise<number> {
    if (this.compactionCandidateCount !== undefined) {
      logger.debug('candidates: cached %o', {
        candidateCount: this.compactionCandidateCount,
      });
      return this.compactionCandidateCount;
    }
    const history = await this.underlyingSession.getItems();
    this.compactionCandidateCount = this.countCompactionItems(history);
    logger.debug('candidates: initialized %o', {
      historyLength: history.length,
      candidateCount: this.compactionCandidateCount,
    });
    return this.compactionCandidateCount;
  }
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

function defaultCountCompactionItems(items: AgentInputItem[]): number {
  return items.filter((item) => {
    if (item.type === 'compaction') {
      return false;
    }
    return !(item.type === 'message' && item.role === 'user');
  }).length;
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
