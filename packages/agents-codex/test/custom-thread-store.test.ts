import { describe, expect, it, vi } from 'vitest';
import {
  captureThreadStore,
  reconcileSessionStore,
  type SessionStore,
} from '../src/runtime/custom-thread-store';

import { outputOf, ToolOutput } from '../src/runtime/tools';

const nativeReconcile = vi.hoisted(() =>
  vi.fn(async (_callback: unknown, _payload: string) => {}),
);
vi.mock('../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/binding')>()),
  binding: async () => ({ reconcile_thread_store: nativeReconcile }),
}));

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
    const store: SessionStore = {
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

describe('reconciled tool result normalization', () => {
  const store: SessionStore = {
    acquire: async () => 'owner',
    read: async () => null,
    commit: async () => {},
    release: async () => {},
  };
  it.each([
    'verified text',
    new ToolOutput([{ type: 'inputText', text: 'verified failure' }], false),
    new ToolOutput([
      { type: 'inputText', text: 'caption' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' },
      { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AA==' },
    ]),
  ])('uses the ordinary tool output payload for %j', async (result) => {
    nativeReconcile.mockClear();
    await reconcileSessionStore(store, {
      sessionId: 'session',
      turnId: 'turn',
      callId: 'call',
      result,
    });
    expect(nativeReconcile).toHaveBeenCalledOnce();
    const payload = JSON.parse(nativeReconcile.mock.calls[0]![1] as string);
    expect(payload).toEqual({
      threadId: 'session',
      turnId: 'turn',
      callId: 'call',
      result: outputOf(result),
    });
    expect(payload.result.success).toBe(
      result instanceof ToolOutput ? result.success : true,
    );
  });
  it('rejects malformed ToolOutput before native acquisition like an ordinary callback', async () => {
    nativeReconcile.mockClear();
    const result = new ToolOutput([
      { type: 'inputImage', imageUrl: 7 as unknown as string },
    ]);
    expect(() => outputOf(result)).toThrow();
    await expect(
      reconcileSessionStore(store, {
        sessionId: 'session',
        turnId: 'turn',
        callId: 'call',
        result,
      }),
    ).rejects.toThrow();
    expect(nativeReconcile).not.toHaveBeenCalled();
  });
});
