import { AsyncLocalStorage } from 'node:async_hooks';
import type OpenAI from 'openai';
import type { JsonObject } from './binding';
import { openOwnedHistorySession, type Agent } from './public-agent';
import { nativeInput, type UserInput } from './input';
import { RunCleanupError } from './native-error';
import { Session, type Completed } from './session';

/** An uncertain append, retaining public items for explicit reconciliation. */
export class ConversationsWriteError extends Error {
  result?: Completed<unknown>;
  constructor(
    readonly conversationId: string,
    readonly items: readonly JsonObject[],
    readonly acknowledged: number,
    cause: unknown,
  ) {
    super(
      `Conversation append failed; reconcile remote history before retrying (${acknowledged} items acknowledged)`,
      { cause },
    );
  }
}

/** Ordered API-item history for native Sessions.
 * One instance has been serializing operations; external writers have been
 * requiring application coordination. The supplied client has been retaining
 * ownership. Model requests have been using full native replay, without wire
 * conversation or previous-response identifiers. Manual checkpoint recovery,
 * cancellation and remote replacement have been remaining outside this bridge.
 */
export class ConversationsHistory {
  readonly #client: OpenAI;
  #conversationId?: string;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #operation = new AsyncLocalStorage<{ active: boolean }>();
  #activeSession?: Session<unknown, unknown>;

  constructor(client: OpenAI, options: { conversationId?: string } = {}) {
    this.#client = client;
    this.#conversationId = options.conversationId;
  }

  get conversationId(): string | undefined {
    return this.#conversationId;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    this.#activeSession?._checkHistoryOperation();
    if (this.#operation.getStore()?.active)
      throw new Error('Cannot reenter an active history operation');
    const token = { active: true };
    const invoke = () =>
      this.#operation.run(token, async () => {
        try {
          return await operation();
        } finally {
          token.active = false;
          this.#operation.disable();
        }
      });
    const pending = this.#tail.then(invoke, invoke);
    this.#tail = pending.catch(() => undefined);
    return pending;
  }

  async #id(): Promise<string> {
    if (this.#conversationId === undefined) {
      const created = await this.#client.conversations.create(
        { items: [] },
        { maxRetries: 0 },
      );
      this.#conversationId = created.id;
    }
    return this.#conversationId;
  }

  getConversationId(): Promise<string> {
    return this.#serial(() => this.#id());
  }

  async #getItems(limit?: number, forRun = false): Promise<JsonObject[]> {
    const conversationId = await this.#id();
    if (limit === 0) return [];
    const items: JsonObject[] = [];
    let bytes = 2;
    for await (const item of this.#client.conversations.items.list(
      conversationId,
      {
        order: limit === undefined ? 'asc' : 'desc',
        ...(forRun ? { limit: 100 } : {}),
        include: [
          'reasoning.encrypted_content',
          'message.input_image.image_url',
          'computer_call_output.output.image_url',
        ],
      },
    )) {
      if (forRun) {
        if (items.length >= 4096)
          throw new RangeError('Conversation import exceeds 4096 records');
        bytes +=
          Buffer.byteLength(JSON.stringify(item), 'utf8') +
          (items.length ? 1 : 0);
        if (bytes > 8 * 1024 * 1024)
          throw new RangeError('Conversation import exceeds 8 MiB');
      }
      items.push(structuredClone(item) as unknown as JsonObject);
      if (limit !== undefined && items.length === limit) break;
    }
    return limit === undefined ? items : items.reverse();
  }

  getItems(limit?: number): Promise<JsonObject[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      return Promise.reject(
        new TypeError('limit must be a nonnegative integer or undefined'),
      );
    return this.#serial(() => this.#getItems(limit));
  }

  /** Ordered chunks of at most 20 items; preceding successful chunks remain saved. */
  addItems(items: readonly JsonObject[]): Promise<void> {
    const captured = structuredClone(items);
    return this.#serial(() => this.#addItems(captured));
  }

  async #addItems(captured: readonly JsonObject[]): Promise<void> {
    if (captured.length === 0) return;
    const conversationId = await this.#id();
    let acknowledged = 0;
    try {
      for (let offset = 0; offset < captured.length; offset += 20) {
        const chunk = captured.slice(offset, offset + 20);
        await this.#client.conversations.items.create(
          conversationId,
          { items: chunk as unknown as OpenAI.Responses.ResponseInputItem[] },
          { maxRetries: 0 },
        );
        acknowledged += chunk.length;
      }
    } catch (cause) {
      throw new ConversationsWriteError(
        conversationId,
        captured,
        acknowledged,
        cause,
      );
    }
  }

  async #appendNativeSuffix(
    session: Pick<Session, 'historySnapshot'>,
    start: number,
  ): Promise<void> {
    const final = await session.historySnapshot();
    const appended = final.items
      .slice(start)
      .filter(
        (item) =>
          item.type !== 'message' ||
          !['developer', 'system'].includes(String(item.role)),
      );
    await this.#addItems(appended as JsonObject[]);
  }

  /** One native Session imports history and appends accepted public originals. */
  run<Context, Output>(
    agent: Agent<Context, Output>,
    input: UserInput,
    ...options: Parameters<Agent<Context, Output>['session']>
  ): Promise<Completed<Output>> {
    const supplied = { ...options[0] };
    const capturedInput = structuredClone(input);
    const preparedInput = nativeInput(capturedInput);
    if (
      ['state', 'resume', 'storage', 'initialMessages'].some(
        (key) => (supplied as Record<string, unknown>)[key] !== undefined,
      )
    )
      throw new TypeError(
        'Conversations history requires a fresh native Session history owner',
      );
    return this.#serial(async () => {
      const items = await this.#getItems(undefined, true);
      const session = await openOwnedHistorySession(
        agent,
        preparedInput,
        ...([supplied] as Parameters<Agent<Context, Output>['session']>),
      );
      this.#activeSession = session as Session<unknown, unknown>;
      let result: Completed<Output> | undefined;
      const closeOwned = async (failure?: { error: unknown }) => {
        try {
          await session.close();
        } catch (cleanupError) {
          const error = new RunCleanupError(
            failure ? [failure.error, cleanupError] : [cleanupError],
            'Conversations run cleanup is incomplete; retry cleanup.close without repeating the run',
            () => session.close(),
            { cause: failure ? failure.error : cleanupError },
          );
          if (result !== undefined) error.result = result;
          throw error;
        }
      };
      try {
        try {
          const before = await session.historySnapshot();
          if (items.length)
            await session.transactHistory({
              expectedRevision: before.revision,
              keep: 0,
              items,
            });
          const loaded = await session.historySnapshot();
          try {
            await session._run(
              preparedInput,
              undefined,
              undefined,
              undefined,
              capturedInput,
            );
            result = await session.wait();
          } catch (error) {
            try {
              await this.#appendNativeSuffix(session, loaded.total);
            } catch (writeError) {
              throw new AggregateError(
                [error, writeError],
                'Native run and Conversations history append failed',
                { cause: error },
              );
            }
            throw error;
          }
          try {
            await this.#appendNativeSuffix(session, loaded.total);
          } catch (error) {
            if (error instanceof ConversationsWriteError) error.result = result;
            throw error;
          }
        } catch (error) {
          await closeOwned({ error });
          throw error;
        }
        await closeOwned();
        return result;
      } finally {
        this.#activeSession = undefined;
      }
    });
  }

  popItem(): Promise<JsonObject | undefined> {
    return this.#serial(async () => {
      const [latest] = await this.#getItems(1);
      if (!latest) return undefined;
      if (typeof latest.id !== 'string')
        throw new TypeError('Conversation item has no provider ID');
      await this.#client.conversations.items.delete(
        latest.id,
        { conversation_id: await this.#id() },
        { maxRetries: 0 },
      );
      return latest;
    });
  }

  clear(): Promise<void> {
    return this.#serial(async () => {
      if (this.#conversationId === undefined) return;
      await this.#client.conversations.delete(this.#conversationId, {
        maxRetries: 0,
      });
      this.#conversationId = undefined;
    });
  }
}
