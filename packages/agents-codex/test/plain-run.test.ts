import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeBinding from '../src/runtime/binding';
import type { SessionSetup } from '../src/runtime/agent';
import { EnvironmentAcquisition } from '../src/runtime/environment-source';
import { NativeProviderRoutes } from '../src/runtime/http-model';
import { NativeError, RunCleanupError } from '../src/runtime/native-error';
import { tryOpenPlainRun } from '../src/runtime/plain-run';
import type { ProviderLease } from '../src/runtime/provider';

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

describe('declared input modalities retain ordinary native session opening', () => {
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
