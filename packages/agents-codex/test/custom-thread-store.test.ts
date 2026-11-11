import { describe, expect, it, vi } from 'vitest';
import {
  captureThreadStore,
  reconcileSessionStore,
  type SessionStore,
} from '../src/runtime/custom-thread-store';

import { outputOf, ToolOutput } from '../src/runtime/tools';
import { NativeError } from '../src/runtime/native-error';

const nativeReconcile = vi.hoisted(() =>
  vi.fn((_callback: unknown, _payload: string) => ({
    run: async () => {},
    close: async () => {},
  })),
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
  it.each([false, true])(
    'rejects private application data before reconciliation effects, credential=%s',
    async (withCredential) => {
      nativeReconcile.mockClear();
      const credential = vi.fn();
      await expect(
        reconcileSessionStore(
          store,
          {
            sessionId: 'session',
            turnId: 'turn',
            callId: 'call',
            result: new ToolOutput(
              [{ type: 'inputText', text: 'verified' }],
              true,
              { ticket: 'private-reconciliation' },
            ),
          },
          withCredential
            ? { signInWithChatGPT: { getCredential: credential } }
            : undefined,
        ),
      ).rejects.toThrow('applicationData');
      expect(credential).not.toHaveBeenCalled();
      expect(nativeReconcile).not.toHaveBeenCalled();
    },
  );
  it('joins cleanup retries without repeating reconciliation', async () => {
    const started = deferred();
    const finish = deferred();
    let attempts = 0;
    const run = vi.fn(async () => {
      throw new Error('canonical storage release failed');
    });
    const close = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        started.resolve();
        await finish.promise;
        throw new Error('canonical storage release failed');
      }
    });
    nativeReconcile.mockReturnValueOnce({ run, close });
    const error = await reconcileSessionStore(store, {
      sessionId: 'session',
      turnId: 'turn',
      callId: 'call',
      result: 'verified',
    }).catch((error: unknown) => error);
    if (!(error instanceof NativeError) || !error.cleanup)
      throw new Error('Expected storage cleanup');
    const first = error.cleanup.close();
    const second = error.cleanup.close();
    await started.promise;
    expect(close).toHaveBeenCalledOnce();
    finish.resolve();
    const failed = await Promise.allSettled([first, second]);
    expect(failed.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    await error.cleanup.close();
    await error.cleanup.close();
    expect(close).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
  });
  it.each([
    'verified text',
    new ToolOutput([{ type: 'inputText', text: 'empty data' }], true, {}),
    new ToolOutput([{ type: 'inputText', text: 'null data' }], true, null),
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
