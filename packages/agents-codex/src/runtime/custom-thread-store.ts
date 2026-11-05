import { outputOf, ToolOutput } from './tools';

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

/** An externally verified outcome for an original unresolved native tool call. */
export interface ReconciledToolResult {
  sessionId: string;
  turnId: string;
  callId: string;
  result: string | ToolOutput;
}
/** Record authoritative external reconciliation while no Session owns this thread. */
export async function reconcileSessionStore(
  store: SessionStore,
  result: ReconciledToolResult,
): Promise<void> {
  for (const value of [result.sessionId, result.turnId, result.callId])
    if (typeof value !== 'string' || !value)
      throw new TypeError(
        'Reconciliation requires original session, turn, and call identities',
      );
  if (
    typeof result.result !== 'string' &&
    !(result.result instanceof ToolOutput)
  )
    throw new TypeError('Reconciled result must be a string or ToolOutput');
  const output = outputOf(result.result);
  const { binding } = await import('./binding');
  const native = await binding();
  await native.reconcile_thread_store(
    captureThreadStore(store),
    JSON.stringify({
      threadId: result.sessionId,
      turnId: result.turnId,
      callId: result.callId,
      result: output,
    }),
  );
}
