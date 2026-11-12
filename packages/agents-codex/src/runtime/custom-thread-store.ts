import { NativeError } from './native-error';
import {
  capturePlanCredential,
  type SignInWithChatGPT,
} from './sign-in-with-chatgpt';
import { outputOf, toolApplicationData, ToolOutput } from './tools';
import { shellOutputSchema, type ShellOutput } from './shell';

/**
 * Preview canonical native storage. Snapshots are opaque, versioned SDK data.
 * The SDK serializes operations within each acquired lease. Direct callers must
 * do the same; overlapping writes and release on one lease are unsupported.
 */
export interface SessionStore {
  /** Acquire exclusive writer ownership before any authoritative read. */
  acquire(sessionId: string): Promise<string>;
  read(sessionId: string, fence: string): Promise<string | null>;
  /** Atomically compare the revision, fence stale writers, and durably commit. */
  commit(
    sessionId: string,
    fence: string,
    writeId: string,
    expectedRevision: number,
    snapshot: string,
  ): Promise<void>;
  /** Optional durability barrier; omitted only when commit itself is fully durable. */
  flush?(sessionId: string, fence: string): Promise<void>;
  /** Release this exact owner; preserve committed history even after failure. */
  release(sessionId: string, fence: string): Promise<void>;
}

/** @internal Capture live application methods, never serialize executable authority. */
export function captureThreadStore(
  store: SessionStore,
): (request: string) => Promise<string> {
  for (const method of ['acquire', 'read', 'commit', 'release'] as const)
    if (typeof store?.[method] !== 'function')
      throw new TypeError(`Session store requires ${method}`);
  const acquire = store.acquire.bind(store);
  const read = store.read.bind(store);
  const commit = store.commit.bind(store);
  const release = store.release.bind(store);
  const flush = store.flush?.bind(store);
  const dispatch = async (request: string): Promise<string> => {
    const op = JSON.parse(request);
    switch (op.operation) {
      case 'acquire':
        return JSON.stringify(await acquire(op.threadId));
      case 'read':
        return JSON.stringify(await read(op.threadId, op.fence));
      case 'commit':
        await commit(
          op.threadId,
          op.fence,
          op.writeId,
          op.expectedRevision,
          op.snapshot,
        );
        return 'null';
      case 'flush':
        await flush?.(op.threadId, op.fence);
        return 'null';
      case 'release':
        await release(op.threadId, op.fence);
        return 'null';
      default:
        throw new TypeError('Unknown canonical storage operation');
    }
  };
  let settled = Promise.resolve();
  return (request) => {
    // A native waiter can be cancelled while its backend Promise still runs.
    // Keep cleanup behind the actual callback settlement, including failures.
    const result = settled.then(() => dispatch(request));
    settled = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/** Retry only an unfinished reconciliation writer release. */
export interface SessionStoreCleanup {
  close(): Promise<void>;
}

class ReconciliationCleanup implements SessionStoreCleanup {
  #owner?: { close(): Promise<void> };
  #pending?: Promise<void>;

  constructor(owner: { close(): Promise<void> }) {
    this.#owner = owner;
  }

  close(): Promise<void> {
    if (this.#pending) return this.#pending;
    if (!this.#owner) return Promise.resolve();
    const owner = this.#owner;
    const pending = owner.close().then(() => {
      this.#owner = undefined;
    });
    this.#pending = pending;
    void pending
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined;
      })
      .catch(() => {});
    return pending;
  }
}

/** An externally verified outcome for an original unresolved native tool call. */
export interface ReconciledToolResult {
  sessionId: string;
  turnId: string;
  callId: string;
  /** Private applicationData is unsupported by store reconciliation. */
  result: string | ToolOutput | ShellOutput;
}
/**
 * Record authoritative external reconciliation while no Session owns this thread.
 * If a NativeError exposes cleanup, await error.cleanup.close() after the backend
 * recovers. Cleanup releases the original writer without repeating its receipt.
 */
export async function reconcileSessionStore(
  store: SessionStore,
  result: ReconciledToolResult,
  options?: { signInWithChatGPT?: SignInWithChatGPT },
): Promise<void> {
  for (const value of [result.sessionId, result.turnId, result.callId])
    if (typeof value !== 'string' || !value)
      throw new TypeError(
        'Reconciliation requires original session, turn, and call identities',
      );
  let value = result.result;
  if (typeof value !== 'string' && !(value instanceof ToolOutput)) {
    const parsed = shellOutputSchema.safeParse(value);
    if (!parsed.success)
      throw new TypeError(
        'Reconciled result must be a string, ToolOutput, or valid ShellOutput',
      );
    value = parsed.data;
  }
  const output = outputOf(value);
  if (toolApplicationData(output) !== undefined)
    throw new TypeError(
      'Store reconciliation does not support applicationData',
    );
  const callback = captureThreadStore(store);
  const source = options?.signInWithChatGPT;
  let planIdentity: string | undefined;
  if (source !== undefined) {
    const getCredential = source?.getCredential;
    if (typeof getCredential !== 'function') {
      throw new TypeError('signInWithChatGPT requires getCredential');
    }
    ({ identity: planIdentity } = await capturePlanCredential(
      getCredential.bind(source),
      new AbortController().signal,
    ));
  }
  const { binding } = await import('./binding');
  const native = await binding();
  const operation = native.reconcile_thread_store(
    callback,
    JSON.stringify({
      threadId: result.sessionId,
      turnId: result.turnId,
      callId: result.callId,
      result: output,
    }),
    planIdentity,
  );
  const cleanup = new ReconciliationCleanup(operation);
  try {
    await operation.run();
  } catch (cause) {
    // Native storage errors already contain fixed, redacted diagnostics.
    const error = new NativeError(
      cause instanceof Error
        ? cause.message
        : 'Canonical storage reconciliation failed',
    );
    error.cleanup = cleanup;
    throw error;
  }
}
