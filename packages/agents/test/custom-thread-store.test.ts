import { describe, expect, it } from 'vitest';
import {
  captureThreadStore,
  type CanonicalThreadStore,
} from '../src/runtime/custom-thread-store';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('canonical storage callback ownership', () => {
  it('holds release behind a commit even when the native waiter is abandoned', async () => {
    const started = deferred();
    const finish = deferred();
    const events: string[] = [];
    const store: CanonicalThreadStore = {
      acquire: async () => 'owner',
      read: async () => null,
      commit: async () => {
        events.push('commit started');
        started.resolve();
        await finish.promise;
        events.push('commit settled');
      },
      release: async () => {
        events.push('released');
      },
    };
    const callback = captureThreadStore(store);
    // Dropping a native future does not cancel the JavaScript backend Promise.
    const abandoned = callback(
      JSON.stringify({
        operation: 'commit',
        threadId: 'thread',
        fence: 'owner',
        writeId: 'one',
        expectedRevision: 0,
        snapshot: 'saved',
      }),
    );
    await started.promise;
    const closing = callback(
      JSON.stringify({
        operation: 'release',
        threadId: 'thread',
        fence: 'owner',
      }),
    );
    await Promise.resolve();
    expect(events).toEqual(['commit started']);
    finish.resolve();
    await Promise.all([abandoned, closing]);
    expect(events).toEqual(['commit started', 'commit settled', 'released']);
  });

  it('reports a failed commit and still allows its queued owner cleanup', async () => {
    const failure = new Error('failed durable commit');
    const events: string[] = [];
    const callback = captureThreadStore({
      acquire: async () => 'owner',
      read: async () => null,
      commit: async () => {
        events.push('failed commit');
        throw failure;
      },
      release: async () => {
        events.push('released');
      },
    });
    const committed = callback(
      JSON.stringify({
        operation: 'commit',
        threadId: 'thread',
        fence: 'owner',
        writeId: 'one',
        expectedRevision: 0,
        snapshot: 'saved',
      }),
    );
    const closed = callback(
      JSON.stringify({
        operation: 'release',
        threadId: 'thread',
        fence: 'owner',
      }),
    );
    await expect(committed).rejects.toBe(failure);
    await expect(closed).resolves.toBe('null');
    expect(events).toEqual(['failed commit', 'released']);
  });
});
