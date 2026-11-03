import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { Environment } from '../../src/runtime/environment';
import {
  acquireEnvironment,
  releaseEnvironmentBeforeProvider,
  type EnvironmentLease,
} from '../../src/runtime/environment-source';

function environment() {
  return new Environment({ url: 'wss://executor.invalid', cwd: '/workspace' });
}

describe('application Environment source ownership', () => {
  it('keeps factory context local and restores resource scope for one joined disposal', async () => {
    const scope = new AsyncLocalStorage<string>();
    const finish = Promise.withResolvers<void>();
    const seen: string[] = [];
    await scope.run('application', async () => {
      const owner = await acquireEnvironment(async () => {
        expect(scope.getStore()).toBe('application');
        scope.enterWith('resource');
        await Promise.resolve();
        return Environment.lease(environment(), async () => {
          seen.push(scope.getStore()!);
          await finish.promise;
          seen.push(scope.getStore()!);
        });
      });
      expect(scope.getStore()).toBe('application');
      const first = owner.dispose();
      const second = owner.dispose();
      expect(second).toBe(first);
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).toEqual(['resource']);
      finish.resolve();
      await first;
      expect(scope.getStore()).toBe('application');
      expect(seen).toEqual(['resource', 'resource']);
    });
  });

  it('rejects foreign and reused leases, but allows fresh leases from one source', async () => {
    const dispose = vi.fn();
    const lease = Environment.lease(environment(), dispose);
    const owner = await acquireEnvironment(async () => lease);
    await expect(lease.close()).rejects.toThrow('Session owns');
    await expect(acquireEnvironment(async () => lease)).rejects.toThrow(
      'claimed',
    );
    await owner.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(acquireEnvironment(async () => lease)).rejects.toThrow(
      'claimed',
    );
    await expect(
      acquireEnvironment(
        async () => ({ environment: environment() }) as EnvironmentLease,
      ),
    ).rejects.toThrow('Environment.lease');
    const source = async () => Environment.lease(environment(), dispose);
    const first = await acquireEnvironment(source);
    const second = await acquireEnvironment(source);
    await Promise.all([first.dispose(), second.dispose()]);
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it('pre-abort prevents source acquisition', async () => {
    const reason = new Error('opening cancelled');
    const source = vi.fn(async () =>
      Environment.lease(environment(), () => {}),
    );
    await expect(
      acquireEnvironment(source, AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(source).not.toHaveBeenCalled();
  });

  it('preserves a distinct source rollback failure after acquisition cancellation', async () => {
    const entered = Promise.withResolvers<void>();
    const rollbackStarted = Promise.withResolvers<void>();
    const finishRollback = Promise.withResolvers<void>();
    const caller = new AbortController();
    const callerReason = new Error('caller cancelled acquisition');
    const rollbackFailure = new Error('source rollback failed independently');
    const observed = acquireEnvironment(async ({ signal }) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      rollbackStarted.resolve();
      await finishRollback.promise;
      throw rollbackFailure;
    }, caller.signal).catch((error) => error);
    await entered.promise;
    caller.abort(callerReason);
    await rollbackStarted.promise;
    finishRollback.resolve();
    expect(await observed).toBe(rollbackFailure);
  });

  it('joins a late acquisition and its disposal after caller cancellation', async () => {
    const ready = Promise.withResolvers<void>();
    const finishEntry = Promise.withResolvers<void>();
    const finishExit = Promise.withResolvers<void>();
    const controller = new AbortController();
    const dispose = vi.fn(async () => {
      await finishExit.promise;
    });
    const opening = acquireEnvironment(async ({ signal }) => {
      ready.resolve();
      await finishEntry.promise;
      expect(signal.aborted).toBe(true);
      return Environment.lease(environment(), dispose);
    }, controller.signal);
    await ready.promise;
    const reason = new Error('cancel acquisition');
    controller.abort(reason);
    let settled = false;
    const observed = opening.catch((error) => {
      settled = true;
      return error;
    });
    expect(settled).toBe(false);
    finishEntry.resolve();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    finishExit.resolve();
    expect(await observed).toBe(reason);
  });

  it('detaches the opening signal but keeps independent source interruption', async () => {
    const caller = new AbortController();
    const source = new AbortController();
    const close = vi.fn(async () => {});
    const owner = await acquireEnvironment(
      async () => Environment.lease(environment(), () => {}, source.signal),
      caller.signal,
    );
    owner.attachSession({ close });
    owner.opened();
    caller.abort(new Error('opening signal ended'));
    expect(close).not.toHaveBeenCalled();
    source.abort(new Error('source ended'));
    expect(close).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });

  it('does not replay a rejected disposer and still releases the provider', async () => {
    const failure = new Error('source disposal failed');
    const dispose = vi.fn(async () => {
      throw failure;
    });
    const owner = await acquireEnvironment(async () =>
      Environment.lease(environment(), dispose),
    );
    const release = vi.fn(async () => {});
    await expect(releaseEnvironmentBeforeProvider(owner, release)).rejects.toBe(
      failure,
    );
    await expect(owner.dispose()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('installs the cleanup guard inside the captured resource scope', async () => {
    const scope = new AsyncLocalStorage<string>();
    const seen: string[] = [];
    const owner = await acquireEnvironment(async () =>
      scope.run('resource', async () =>
        Environment.lease(environment(), () => {
          seen.push(scope.getStore()!);
        }),
      ),
    );
    await owner.dispose(async (callback) => {
      seen.push(scope.getStore()!);
      await scope.run('guard', callback);
    });
    expect(seen).toEqual(['resource', 'guard']);
  });
});
