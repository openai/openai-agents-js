import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type Session } from '@openai/agents';
import { runQuestionSession } from '../../../../examples/codex/native-questions';
import {
  catalogCases,
  evaluateCatalogCase,
} from '../../../../examples/codex/evaluate-catalog';
import { superviseArtifact } from '../../../../examples/codex/supervised-worker/worker';
import { searchProject } from '../../../../examples/codex/project-search';
import { readLocalStorage } from '../../../../examples/codex/local-storage-mount';
import { runWithTrace } from '../../../../examples/codex/native-trace-context';
import { runWithTimeout } from '../../../../examples/codex/timeout-cleanup';
import { BorrowedPeer } from './fixtures/borrowed-mcp';

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

// Overflow must fail at the example boundary before any SDK work starts.
describe('configurable example timer limits', () => {
  it.each([2_147_483_648, Number.MAX_SAFE_INTEGER])(
    'rejects an overflowing result deadline of %s before opening a Session',
    async (timeoutMs) => {
      const owned = ownedSession();
      await expect(runWithTimeout({}, timeoutMs)).rejects.toThrow(
        'timeoutMs must be at most 2147483647.',
      );
      expect(owned.session.submit).not.toHaveBeenCalled();
      expect(Agent.prototype.session).not.toHaveBeenCalled();
      expect(owned.providerClose).not.toHaveBeenCalled();
    },
  );

  it.each([0.5, 2_147_483_647])(
    'preserves a supported result deadline of %s',
    async (timeoutMs) => {
      const owned = ownedSession();
      const running = runWithTimeout({}, timeoutMs);
      await owned.waiting.promise;
      owned.answer.resolve({ finalOutput: 'answer' });
      await expect(running).resolves.toBe('answer');
      expect(owned.calls).toEqual([
        'session.close.begin',
        'session.close.end',
        'provider.close',
      ]);
    },
  );
});

describe('question, catalog and worker timer admission', () => {
  it('rejects an overflowing question deadline before opening a Session', async () => {
    const session = vi.spyOn(Agent.prototype, 'session');
    await expect(
      runQuestionSession(
        new Agent({ instructions: 'Answer briefly.' }),
        'question',
        {
          collectForm: vi.fn(),
          decideURL: vi.fn(),
          collectProof: vi.fn(),
        },
        2_147_483_648,
      ),
    ).rejects.toThrow('timeoutMs must be positive and at most 2147483647.');
    expect(session).not.toHaveBeenCalled();
  });

  it('records an invalid catalog deadline as a runtime failure before opening a Session', async () => {
    const session = vi
      .spyOn(Agent.prototype, 'session')
      .mockRejectedValue(new Error('Unexpected work'));
    const result = await evaluateCatalogCase(
      new NativeProvider(),
      catalogCases[0],
      2_147_483_648,
    );
    expect(result).toEqual({
      id: 'known',
      completed: false,
      answer: null,
      calls: [],
      failure: 'runtime',
    });
    expect(session).not.toHaveBeenCalled();
  });

  it.each(['startupMs', 'turnMs'] as const)(
    'rejects an overflowing worker %s before opening a Session',
    async (name) => {
      const session = vi.spyOn(Agent.prototype, 'session');
      const options = {
        directory: '/unused-worker-directory',
        provider: { apiKey: 'synthetic-test' },
        model: 'fixture',
        reports: { name: 'reports', server: new BorrowedPeer() },
        task: 'Draft a release note.',
        [name]: 2_147_483_648,
      };
      await expect(superviseArtifact(options)).rejects.toThrow(
        `${name} must be an integer from 0 through 2147483647.`,
      );
      expect(session).not.toHaveBeenCalled();
    },
  );
});

describe('helper-owned providers', () => {
  it('keeps the search provider open until the result settles', async () => {
    const completed =
      Promise.withResolvers<Awaited<ReturnType<Agent['run']>>>();
    const run = vi
      .spyOn(Agent.prototype, 'run')
      .mockReturnValue(completed.promise);
    const close = vi
      .spyOn(NativeProvider.prototype, 'close')
      .mockResolvedValue();
    const running = searchProject('/application/project');
    expect(run).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    const result = { finalOutput: 'project/config.ts:1' } as Awaited<
      ReturnType<Agent['run']>
    >;
    completed.resolve(result);
    await expect(running).resolves.toBe(result);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(
    (
      [
        [
          'storage',
          (directory: string) =>
            readLocalStorage(
              join(directory, 'project'),
              join(directory, 'storage'),
            ),
        ],
        [
          'trace',
          () =>
            runWithTrace({
              traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
            }),
        ],
      ] as const
    ).filter(([name]) => name !== 'storage' || process.platform === 'linux'),
  )('closes the %s helper Session before its provider', async (_, run) => {
    const directory = await mkdtemp(join(tmpdir(), 'guidance-provider-'));
    try {
      await mkdir(join(directory, 'project'));
      await mkdir(join(directory, 'storage'));
      const owned = ownedSession();
      const running = run(directory);
      await owned.waiting.promise;
      owned.answer.resolve({ finalOutput: 'answer' });
      await expect(running).resolves.toBe('answer');
      expect(owned.calls).toEqual([
        'session.close.begin',
        'session.close.end',
        'provider.close',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
