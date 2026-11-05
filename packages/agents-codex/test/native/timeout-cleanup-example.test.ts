import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type Session } from '@openai/agents';
import { runWithTimeout } from '../../examples/timeout-cleanup';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Control lifecycle delivery at the example boundary; this does not execute Core.
function ownedSession(holdCleanup = false) {
  const answer = Promise.withResolvers<{ finalOutput: string }>();
  const waiting = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  if (!holdCleanup) cleanup.resolve();
  const work = new AbortController();
  const calls: string[] = [];
  const session = {
    [Symbol.asyncDispose](): Promise<void> {
      return this.close();
    },
    submit: vi.fn(async () => ({
      wait: () => {
        waiting.resolve();
        return answer.promise;
      },
    })),
    close: vi.fn(async () => {
      calls.push('session.close.begin');
      work.abort();
      stopping.resolve();
      await cleanup.promise;
      // A losing result promise may reject while Session cleanup joins it.
      answer.reject(new Error('Owned work stopped'));
      calls.push('session.close.end');
    }),
  };
  vi.spyOn(Agent.prototype, 'session').mockResolvedValue(
    session as unknown as Session,
  );
  const providerClose = vi
    .spyOn(NativeProvider.prototype, 'close')
    .mockImplementation(async () => {
      calls.push('provider.close');
    });
  return {
    answer,
    waiting,
    stopping,
    cleanup,
    work,
    calls,
    session,
    providerClose,
  };
}

function suppressed(error: unknown) {
  expect(error).toHaveProperty('name', 'SuppressedError');
  expect(error).toHaveProperty('error');
  expect(error).toHaveProperty('suppressed');
  return error as { error: unknown; suppressed: unknown };
}

describe('owned Session timeout example without native execution', () => {
  it('returns an early answer only after cleanup and clears the deadline', async () => {
    const owned = ownedSession(true);
    let settled = false;
    const running = runWithTimeout({}, 30).finally(() => {
      settled = true;
    });
    await owned.waiting.promise;
    owned.answer.resolve({ finalOutput: 'Water separates sunlight.' });
    await owned.stopping.promise;
    expect(vi.getTimerCount()).toBe(0);
    expect(settled).toBe(false);
    expect(owned.providerClose).not.toHaveBeenCalled();
    owned.cleanup.resolve();
    await expect(running).resolves.toBe('Water separates sunlight.');
    expect(owned.calls).toEqual([
      'session.close.begin',
      'session.close.end',
      'provider.close',
    ]);
  });

  it('stops owned work on timeout and waits for delayed cleanup', async () => {
    const owned = ownedSession(true);
    let settled = false;
    const running = runWithTimeout({}, 30);
    const outcome = running.then(
      () => {
        throw new Error('Timed-out example unexpectedly succeeded');
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await owned.waiting.promise;
    expect(owned.work.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    await owned.stopping.promise;
    expect(owned.work.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(owned.providerClose).not.toHaveBeenCalled();
    owned.cleanup.resolve();
    expect(await outcome).toEqual(new Error('Result wait exceeded 30 ms.'));
    expect(owned.calls).toEqual([
      'session.close.begin',
      'session.close.end',
      'provider.close',
    ]);
  });

  it.each([undefined, null, false, 0, '', new Error('Result failed')])(
    'preserves an early result failure %s and clears its timer',
    async (failure) => {
      const owned = ownedSession();
      const outcome = runWithTimeout({}, 30).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await owned.waiting.promise;
      owned.answer.reject(failure);
      expect(await outcome).toEqual({ ok: false, error: failure });
      expect(vi.getTimerCount()).toBe(0);
      expect(owned.calls.at(-1)).toBe('provider.close');
    },
  );

  it('retains timeout, Session cleanup and provider cleanup failures in order', async () => {
    const owned = ownedSession();
    const sessionFailure = new Error('Session cleanup failed');
    const providerFailure = new Error('Provider cleanup failed');
    const close = owned.session.close.getMockImplementation()!;
    owned.session.close.mockImplementationOnce(async () => {
      await close();
      throw sessionFailure;
    });
    owned.providerClose.mockImplementationOnce(async () => {
      owned.calls.push('provider.close');
      throw providerFailure;
    });
    const outcome = runWithTimeout({}, 30).catch((error: unknown) => error);
    await owned.waiting.promise;
    await vi.advanceTimersByTimeAsync(30);
    const providerError = suppressed(await outcome);
    expect(providerError.error).toBe(providerFailure);
    const sessionError = suppressed(providerError.suppressed);
    expect(sessionError.error).toBe(sessionFailure);
    expect(sessionError.suppressed).toEqual(
      new Error('Result wait exceeded 30 ms.'),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(owned.calls).toEqual([
      'session.close.begin',
      'session.close.end',
      'provider.close',
    ]);
  });
});
