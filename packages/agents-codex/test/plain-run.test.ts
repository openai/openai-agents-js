import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeBinding from '../src/runtime/binding';
import type { SessionSetup } from '../src/runtime/agent';
import { EnvironmentAcquisition } from '../src/runtime/environment-source';
import { NativeProviderRoutes } from '../src/runtime/http-model';
import { NativeError, RunCleanupError } from '../src/runtime/native-error';
import { tryOpenPlainRun } from '../src/runtime/plain-run';
import type { ProviderLease } from '../src/runtime/provider';
import type {
  PrivateKernel,
  PrivateRuntimeBorrow,
} from '../src/runtime/private-engine-reuse';

afterEach(() => vi.restoreAllMocks());

function prepared() {
  const request = {
    cancel: vi.fn(),
    wait: vi.fn().mockResolvedValue(
      JSON.stringify({
        sessionId: 'session',
        turnId: 'turn',
        submissionId: 'submission',
        finalOutput: 'answer',
        events: [],
        usage: null,
        error: null,
      }),
    ),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const engine = {
    _plain_run_supported: vi.fn().mockResolvedValue(true),
    _plain_run: vi.fn().mockResolvedValue(request),
    _close_report: vi.fn().mockResolvedValue(null),
    _private_reuse_ready: false,
  };
  vi.spyOn(nativeBinding, 'binding').mockResolvedValue({
    _packaged_runtime: () => ({}),
    create_engine: vi.fn().mockResolvedValue(engine),
    _create_provider_http_transports: vi.fn(),
  } as never);
  vi.spyOn(NativeProviderRoutes.prototype, 'start').mockResolvedValue(
    {} as never,
  );
  vi.spyOn(NativeProviderRoutes.prototype, 'bindEngine').mockImplementation(
    () => {},
  );
  const closeCarrier = vi
    .spyOn(NativeProviderRoutes.prototype, 'close')
    .mockResolvedValue(undefined);
  let openingCleanup: (() => Promise<void>) | undefined;
  const release = vi.fn().mockResolvedValue(undefined);
  const lease: ProviderLease = {
    apiKey: 'fixture-key',
    config: {},
    websocketsAllowed: false,
    failedOpeningCleanup: undefined,
    httpTransports: () => undefined,
    open: vi.fn(),
    release,
    retainOpeningCleanup: (cleanup) => {
      const previous = openingCleanup;
      openingCleanup = cleanup;
      return previous;
    },
    openingSucceeded: () => {
      openingCleanup = undefined;
    },
    failOpening: async (error) => {
      throw error;
    },
  };
  const setup: SessionSetup = {
    name: 'plain',
    instructions: 'Respond plainly',
    model: 'gpt-4.1-mini',
    tools: [],
    config: {},
    runtime: {},
    threadOptions: {},
    apiKey: 'fixture-key',
  };
  return { request, engine, lease, setup, release, closeCarrier };
}

describe('plain owned-run cleanup', () => {
  it('successful wait: synchronous stop after joined completion', async () => {
    const p = prepared();
    const entered = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const result = p.request.wait.getMockImplementation()!;
    p.request.wait.mockImplementation(async () => {
      entered.resolve();
      await joined.promise;
      return result();
    });
    const owner = await tryOpenPlainRun(p.setup, {}, p.lease, 'input');
    p.lease.openingSucceeded();
    const run = owner!.run();
    await entered.promise;
    expect(p.request.cancel).not.toHaveBeenCalled();
    expect(p.request.close).not.toHaveBeenCalled();
    expect(p.release).not.toHaveBeenCalled();
    joined.resolve();
    const completed = await run;
    expect(completed.finalOutput).toBe('answer');
    expect(p.request.wait).toHaveBeenCalledTimes(1);
    expect(p.request.cancel).toHaveBeenCalledTimes(1);
    expect(p.request.close).not.toHaveBeenCalled();
    expect(p.engine._close_report).toHaveBeenCalledTimes(1);
    expect(p.closeCarrier).toHaveBeenCalledTimes(1);
    expect(p.release).toHaveBeenCalledTimes(1);
    expect(await owner!.run()).toBe(completed);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
    expect(p.request.cancel).toHaveBeenCalledTimes(1);
  });

  it('reports completed Engine retirement once after successful output', async () => {
    const p = prepared();
    p.engine._close_report.mockResolvedValue('native retirement diagnostic');
    const owner = await tryOpenPlainRun(p.setup, {}, p.lease, 'input');
    p.lease.openingSucceeded();
    const failure = await owner!.run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeError);
    expect(failure).not.toBeInstanceOf(RunCleanupError);
    expect((failure as Error).message).toBe('native retirement diagnostic');
    expect(p.release).toHaveBeenCalledTimes(1);
    expect(p.closeCarrier).toHaveBeenCalledTimes(1);
    expect(await owner!.run().catch((error: unknown) => error)).toBe(failure);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
    expect(p.engine._close_report).toHaveBeenCalledTimes(1);
  });

  it('consumes a completed Engine report during model-error cleanup', async () => {
    const p = prepared();
    const primary = new NativeError('model failed');
    p.request.wait.mockRejectedValue(primary);
    p.engine._close_report.mockResolvedValue('native retirement diagnostic');
    const owner = await tryOpenPlainRun(p.setup, {}, p.lease, 'input');
    p.lease.openingSucceeded();
    const failure = (await owner!
      .run()
      .catch((error: unknown) => error)) as RunCleanupError;
    expect(failure).toBeInstanceOf(RunCleanupError);
    expect(failure.cause).toBe(primary);
    expect(failure.errors[0]).toBe(primary);
    expect(failure.errors[1]).toBeInstanceOf(NativeError);
    expect(failure.errors[1].message).toBe('native retirement diagnostic');
    await failure.cleanup.close();
    await failure.cleanup.close();
    expect(p.request.wait).toHaveBeenCalledTimes(1);
    expect(p.request.close).toHaveBeenCalledTimes(1);
    expect(p.engine._close_report).toHaveBeenCalledTimes(1);
    expect(p.closeCarrier).toHaveBeenCalledTimes(1);
    expect(p.release).toHaveBeenCalledTimes(1);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
  });

  it('keeps failed environment disposal sticky after native retirement', async () => {
    const p = prepared();
    const disposal = new Error('environment disposal failed');
    const environmentOwner = new EnvironmentAcquisition(
      undefined,
      new AbortController(),
      () => {},
    );
    const dispose = vi
      .spyOn(environmentOwner, 'dispose')
      .mockRejectedValue(disposal);
    const owner = await tryOpenPlainRun(
      p.setup,
      { environmentOwner },
      p.lease,
      'input',
    );
    p.lease.openingSucceeded();
    const failure = (await owner!
      .run()
      .catch((error: unknown) => error)) as RunCleanupError;
    expect(failure).toBeInstanceOf(RunCleanupError);
    expect(failure.cause).toBe(disposal);
    await expect(failure.cleanup.close()).rejects.toBe(disposal);
    await expect(failure.cleanup.close()).rejects.toBe(disposal);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(p.release).toHaveBeenCalledTimes(1);
    expect(p.request.cancel).toHaveBeenCalledTimes(1);
    expect(p.request.close).not.toHaveBeenCalled();
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
  });

  it('retains the exact failed request owner for cleanup retry without redispatch', async () => {
    const p = prepared();
    const primary = new NativeError('model failed');
    const cleanup = new Error('request close failed');
    p.request.wait.mockRejectedValue(primary);
    p.request.close.mockRejectedValueOnce(cleanup);
    const owner = await tryOpenPlainRun(p.setup, {}, p.lease, 'input');
    p.lease.openingSucceeded();
    const failure = await owner!.run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunCleanupError);
    const error = failure as RunCleanupError;
    expect(error.cause).toBe(primary);
    expect(error.errors).toEqual([primary, cleanup]);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
    expect(p.request.wait).toHaveBeenCalledTimes(1);
    expect(p.release).not.toHaveBeenCalled();
    expect(p.engine._close_report).not.toHaveBeenCalled();
    await error.cleanup.close();
    expect(p.request.close).toHaveBeenCalledTimes(2);
    expect(p.request.wait).toHaveBeenCalledTimes(1);
    expect(p.engine._close_report).toHaveBeenCalledTimes(1);
    expect(p.closeCarrier).toHaveBeenCalledTimes(1);
    expect(p.release).toHaveBeenCalledTimes(1);
    await error.cleanup.close();
    expect(p.request.close).toHaveBeenCalledTimes(2);
    expect(p.release).toHaveBeenCalledTimes(1);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
  });

  it('successful wait: stop failure with asynchronous close retry', async () => {
    const p = prepared();
    const first = new Error('success stop');
    const second = new Error('cleanup close');
    p.request.cancel.mockImplementationOnce(() => {
      throw first;
    });
    p.request.close.mockRejectedValueOnce(second);
    const owner = await tryOpenPlainRun(p.setup, {}, p.lease, 'input');
    p.lease.openingSucceeded();
    const failure = (await owner!
      .run()
      .catch((error: unknown) => error)) as RunCleanupError;
    expect(failure).toBeInstanceOf(RunCleanupError);
    expect(failure.cause).toBe(first);
    expect(failure.errors).toEqual([first, second]);
    expect(p.release).not.toHaveBeenCalled();
    await failure.cleanup.close();
    expect(p.request.close).toHaveBeenCalledTimes(2);
    expect(p.request.wait).toHaveBeenCalledTimes(1);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
    expect(p.release).toHaveBeenCalledTimes(1);
  });

  it('preserves a caller abort arriving during joined cleanup', async () => {
    const p = prepared();
    const entered = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<null>();
    p.engine._close_report.mockImplementationOnce(() => {
      entered.resolve();
      return joined.promise;
    });
    const controller = new AbortController();
    const reason = new Error('cancelled while closing');
    const owner = await tryOpenPlainRun(
      p.setup,
      {},
      p.lease,
      'input',
      controller.signal,
    );
    p.lease.openingSucceeded();
    const result = owner!.run();
    const observed = result.catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    joined.resolve(null);
    expect(await observed).toBe(reason);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
    expect(p.request.cancel).toHaveBeenCalledTimes(1);
    expect(p.request.close).not.toHaveBeenCalled();
    expect(p.closeCarrier).toHaveBeenCalledTimes(1);
    expect(p.release).toHaveBeenCalledTimes(1);
  });
});

function retained(concurrent = false) {
  const p = prepared();
  p.engine._private_reuse_ready = true;
  const transports = {} as never;
  const carrier = new NativeProviderRoutes();
  vi.spyOn(carrier, 'reuseBinding').mockReturnValue({
    origin: 'http://fixture',
    grant: 'fixture',
  });
  const fresh = (): PrivateKernel => ({
    engine: p.engine as never,
    carrier,
    transports,
    home: { codex_home: '/fixture', cwd: '/fixture/workspace' },
    apiKey: 'fixture-key',
    phase: 'engine',
  });
  let entry: PrivateKernel | undefined = fresh();
  const finish = vi.fn(async (keep: boolean) => {
    if (!keep) entry = undefined;
  });
  const borrow: PrivateRuntimeBorrow = {
    get concurrent() {
      return concurrent;
    },
    get done() {
      return entry === undefined;
    },
    peek: () => entry,
    bind: () => {
      entry = fresh();
    },
    reset: vi.fn(),
    finish,
  };
  const lease: ProviderLease = {
    ...p.lease,
    privateRuntime: borrow,
    httpTransports: () => transports,
  };
  const run = async (setup = p.setup) => {
    const owner = await tryOpenPlainRun(setup, {}, lease, 'input');
    lease.openingSucceeded();
    return owner!.run();
  };
  return {
    ...p,
    lease,
    run,
    finish,
    enableConcurrency: () => {
      concurrent = true;
    },
    replaceEntry: () => {
      entry = fresh();
    },
  };
}

// This fixture isolates native admission; the native suite uses a real Provider.
describe('plain entry admission', () => {
  it('admits identical retained calls once and readmits a replacement entry', async () => {
    const p = retained();
    expect((await p.run()).finalOutput).toBe('answer');
    expect((await p.run()).finalOutput).toBe('answer');
    expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(1);
    expect(p.engine._plain_run).toHaveBeenCalledTimes(2);
    p.replaceEntry();
    await p.run();
    expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(2);
  });

  it.each(['config', 'runtime', 'model'] as const)(
    'readmits a changed %s key without caching rejection',
    async (field) => {
      const p = retained();
      await p.run();
      const changed = {
        ...p.setup,
        ...(field === 'model'
          ? { model: 'gpt-5' }
          : field === 'config'
            ? { config: { model_reasoning_summary: 'auto' } }
            : { runtime: { strict_config: true } }),
      };
      p.engine._plain_run_supported.mockResolvedValueOnce(false);
      expect(
        await tryOpenPlainRun(changed, {}, p.lease, 'input'),
      ).toBeUndefined();
      expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(2);
      await p.run();
      expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(3);
    },
  );

  it('checks current readiness before a cached hit and readmits after invalidation', async () => {
    const p = retained();
    await p.run();
    p.engine._private_reuse_ready = false;
    expect(
      await tryOpenPlainRun(p.setup, {}, p.lease, 'input'),
    ).toBeUndefined();
    expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
    p.engine._private_reuse_ready = true;
    await p.run();
    expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(2);
  });

  it('evicts a failed entry and admits again on the next opening', async () => {
    const p = retained();
    await p.run();
    const failure = new NativeError('request validation failed');
    p.request.wait.mockRejectedValueOnce(failure);
    await expect(p.run()).rejects.toBe(failure);
    expect(p.finish).toHaveBeenLastCalledWith(false, true);
    await p.run();
    expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(2);
  });
  it.each(['config', 'runtime', 'model', 'apiKey'] as const)(
    'keeps a concurrent entry immutable on a changed %s key',
    async (field) => {
      const p = retained();
      await p.run();
      p.enableConcurrency();
      const entry = p.lease.privateRuntime!.peek()!;
      const admission = entry.plainAdmission;
      const changed = {
        ...p.setup,
        ...(field === 'model'
          ? { model: 'gpt-5' }
          : field === 'config'
            ? { config: { model_reasoning_summary: 'auto' } }
            : field === 'apiKey'
              ? { apiKey: 'another-key' }
              : { runtime: { strict_config: true } }),
      };
      expect(
        await tryOpenPlainRun(changed, {}, p.lease, 'input'),
      ).toBeUndefined();
      expect(entry.plainAdmission).toBe(admission);
      expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(1);
      await p.run();
      expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(1);
      expect(p.engine._plain_run).toHaveBeenCalledTimes(2);
    },
  );
});

describe('declared input modalities retain ordinary native session opening', () => {
  it.each(['audio', 'text', 'clear'] as const)(
    '%s bypasses a retained plain admission',
    async (selection) => {
      const p = retained();
      await p.run();
      expect(p.lease.privateRuntime?.peek()?.plainAdmission).toBeDefined();
      const acquisitions = vi.mocked(nativeBinding.binding).mock.calls.length;
      const owner = await tryOpenPlainRun(
        p.setup,
        {
          initialModelSettings: {
            inputModalities:
              selection === 'clear'
                ? null
                : selection === 'audio'
                  ? ['text', 'audio']
                  : ['text'],
          },
        },
        p.lease,
        'input',
      );
      expect(owner).toBeUndefined();
      expect(nativeBinding.binding).toHaveBeenCalledTimes(acquisitions);
      expect(p.engine._plain_run).toHaveBeenCalledTimes(1);
      expect(p.engine._plain_run_supported).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['audio', 'text', 'clear'] as const)(
    '%s does not acquire the private plain-run owner',
    async (selection) => {
      const p = prepared();
      const result = await tryOpenPlainRun(
        p.setup,
        {
          initialModelSettings: {
            inputModalities:
              selection === 'clear'
                ? null
                : selection === 'audio'
                  ? ['text', 'audio']
                  : ['text'],
          },
        },
        p.lease,
        'input',
      );
      expect(result).toBeUndefined();
      expect(nativeBinding.binding).not.toHaveBeenCalled();
      expect(p.engine._plain_run).not.toHaveBeenCalled();
      expect(p.release).not.toHaveBeenCalled();
    },
  );
});
