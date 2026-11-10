import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, _ProviderHttpTransports } from '../native/index.js';
import {
  NativeProvider,
  type NativeProviderOptions,
} from '../src/runtime/provider';
import { NativeRuntime } from '../src/runtime/native-runtime';

const engine = {} as Engine;

afterEach(() => vi.unstubAllEnvs());

describe('NativeRuntime ownership', () => {
  it('closes with unused Providers and rejects their first use without leaving a lease', async () => {
    const owner = new NativeRuntime();
    const provider = new NativeProvider({
      runtime: owner,
      apiKey: 'synthetic',
    });
    await owner[Symbol.asyncDispose]();
    await owner.close();
    expect(() => provider._acquire()).toThrow('NativeRuntime is closed');
    await provider.close();
    expect(() => new NativeProvider({ runtime: owner })).toThrow('closed');
  });

  it('does not borrow when a subclass constructor throws after super', async () => {
    const owner = new NativeRuntime();
    class FailingProvider extends NativeProvider {
      constructor() {
        super({ runtime: owner, apiKey: 'synthetic' });
        throw new Error('subclass construction failed');
      }
    }
    expect(() => new FailingProvider()).toThrow('subclass construction failed');
    await owner.close();
  });

  it.each<NativeProviderOptions>([
    { supportsWebsockets: true },
    { modelBackend: { complete: vi.fn() } },
    {
      chatGPT: {
        accountId: 'synthetic-account',
        accessToken: 'synthetic-token',
      },
    },
    { codexLogin: {} },
    { signInWithChatGPT: { getCredential: vi.fn() } },
  ])(
    'rejects unsupported inference options before borrowing: %j',
    async (options) => {
      const owner = new NativeRuntime();
      expect(() => new NativeProvider({ ...options, runtime: owner })).toThrow(
        TypeError,
      );
      await owner.close();
    },
  );

  it('resolves ambient keys at acquisition and leaves missing-key admission retryable', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    await using owner = new NativeRuntime();
    await using provider = new NativeProvider({ runtime: owner });
    expect(() => provider._acquire()).toThrow('effective API key');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-first');
    const first = provider._acquire();
    expect(first.apiKey).toBe('synthetic-first');
    expect(first.websocketsAllowed).toBe(false);
    await first.release();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-second');
    const second = provider._acquire();
    expect(second.apiKey).toBe('synthetic-second');
    await second.release();
    // A successfully used Provider keeps its borrow even with no active leases.
    await expect(owner.close()).rejects.toThrow('borrowing Providers');
    await provider.close();
    await owner.close();
  });

  it('creates one shared holder lazily and retains it through independent Provider closes', async () => {
    const owner = new NativeRuntime();
    const first = new NativeProvider({
      runtime: owner,
      apiKey: 'synthetic-first',
    });
    const second = new NativeProvider({
      runtime: owner,
      apiKey: 'synthetic-second',
    });
    const close = vi.fn();
    const holder = { close } as unknown as _ProviderHttpTransports;
    const create = vi.fn(() => holder);
    const a = first._acquire();
    const b = second._acquire();
    try {
      expect(create).not.toHaveBeenCalled();
      expect(a.httpTransports(create, engine)).toBe(holder);
      expect(b.httpTransports(create, engine)).toBe(holder);
      expect(create).toHaveBeenCalledTimes(1);
      await expect(owner.close()).rejects.toThrow('borrowing Providers');
      await a.release();
      await first.close();
      expect(close).not.toHaveBeenCalled();
      expect(b.httpTransports(create, engine)).toBe(holder);
      await b.release();
      await expect(owner.close()).rejects.toThrow('borrowing Providers');
      await second.close();
      expect(close).not.toHaveBeenCalled();
      await owner.close();
      await owner.close();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await a.release();
      await b.release();
      await first.close();
      await second.close();
      await owner.close();
    }
  });

  it('allows another Provider to retry failed native holder creation', async () => {
    await using owner = new NativeRuntime();
    await using first = new NativeProvider({
      runtime: owner,
      apiKey: 'synthetic',
    });
    await using second = new NativeProvider({
      runtime: owner,
      apiKey: 'synthetic',
    });
    const holder = { close: vi.fn() } as unknown as _ProviderHttpTransports;
    const create = vi
      .fn<() => _ProviderHttpTransports>()
      .mockImplementationOnce(() => {
        throw new Error('allocation failed');
      })
      .mockReturnValue(holder);
    const a = first._acquire();
    const b = second._acquire();
    try {
      expect(() => a.httpTransports(create, engine)).toThrow(
        'allocation failed',
      );
      expect(b.httpTransports(create, engine)).toBe(holder);
      expect(a.httpTransports(create, engine)).toBe(holder);
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      await a.release();
      await b.release();
    }
  });

  it('retains its borrow until failed-opening cleanup succeeds on a close retry', async () => {
    await using owner = new NativeRuntime();
    await using provider = new NativeProvider({
      runtime: owner,
      apiKey: 'synthetic',
    });
    const lease = provider._acquire();
    let attempts = 0;
    const release = lease.retainOpeningCleanup(async () => {
      if (attempts++ < 2) throw new Error('cleanup failed');
      await release!();
    });
    await expect(
      lease.failOpening(new Error('opening failed')),
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(provider.close()).rejects.toThrow(
      'NativeProvider cleanup failed',
    );
    await expect(owner.close()).rejects.toThrow('borrowing Providers');
    await provider.close();
    expect(attempts).toBe(3);
    await owner.close();
  });
});

describe('NativeRuntime private plain kernel handoff', () => {
  function provider(runtime: NativeRuntime) {
    return new NativeProvider({
      runtime,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
  }
  function kernel() {
    const closeEngine = vi.fn(async () => null);
    const engine = {
      _private_reuse_ready: true,
      _close_report: closeEngine,
    } as unknown as Engine;
    const closeCarrier = vi.fn(async () => {});
    const carrier = {
      close: closeCarrier,
      reuseBinding: () => ({ origin: 'synthetic', grant: 'synthetic' }),
    } as unknown as import('../src/runtime/http-model').NativeProviderRoutes;
    const closeHolder = vi.fn();
    const holder = { close: closeHolder } as unknown as _ProviderHttpTransports;
    return { engine, carrier, holder, closeEngine, closeCarrier, closeHolder };
  }

  it('keeps the parked kernel across Provider close and a macrotask, with token-bound stale controls', async () => {
    const owner = new NativeRuntime();
    const first = provider(owner);
    const a = first._acquire(undefined, true);
    const k = kernel();
    await a.open();
    a.httpTransports(() => k.holder, k.engine);
    a.privateRuntime!.bind(k.engine, k.carrier, k.holder);
    await a.privateRuntime!.finish(true, true);
    await first.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = provider(owner);
    const b = second._acquire(undefined, true);
    try {
      expect(b.privateRuntime!.peek()?.engine).toBe(k.engine);
      b.httpTransports(() => k.holder, k.engine);
      await a.release();
      await a.privateRuntime!.finish(false);
      await first.close();
      expect(b.privateRuntime!.peek()?.engine).toBe(k.engine);
      await expect(a.privateRuntime!.reset()).rejects.toThrow('closed');
      await expect(owner.close()).rejects.toThrow('borrowing Providers');
      expect(k.closeEngine).not.toHaveBeenCalled();
      await b.privateRuntime!.finish(true, true);
      await second.close();
      expect(k.closeEngine).not.toHaveBeenCalled();
      await owner.close();
      expect(k.closeEngine).toHaveBeenCalledTimes(1);
      expect(k.closeCarrier).toHaveBeenCalledTimes(1);
      expect(k.closeHolder).toHaveBeenCalledTimes(1);
    } finally {
      await b.privateRuntime!.finish(false);
      await second.close();
      await first.close();
      await owner.close();
    }
  });

  it('uses no shared private slot for busy or ordinary leases', async () => {
    await using owner = new NativeRuntime();
    await using first = provider(owner);
    await using second = provider(owner);
    const a = first._acquire(undefined, true);
    const busy = second._acquire(undefined, true);
    const ordinary = second._acquire();
    try {
      expect(a.privateRuntime).toBeDefined();
      expect(busy.privateRuntime).toBeUndefined();
      expect(ordinary.privateRuntime).toBeUndefined();
    } finally {
      await ordinary.release();
      await busy.release();
      await a.privateRuntime!.finish(false);
    }
  });

  it('never parks a kernel completed through the ordinary Session path', async () => {
    await using owner = new NativeRuntime();
    await using first = provider(owner);
    const a = first._acquire(undefined, true);
    const k = kernel();
    await a.open();
    a.httpTransports(() => k.holder, k.engine);
    a.privateRuntime!.bind(k.engine, k.carrier, k.holder);
    await a.privateRuntime!.finish(true);
    expect(k.closeEngine).toHaveBeenCalledTimes(1);
    await first.close();
    await using second = provider(owner);
    const b = second._acquire(undefined, true);
    expect(b.privateRuntime!.peek()).toBeUndefined();
    await b.privateRuntime!.finish(false);
  });

  it.each(['engine', 'carrier', 'holder'] as const)(
    'retains phased owner cleanup after %s failure and rejects acquisition while closing',
    async (phase) => {
      const owner = new NativeRuntime();
      const first = provider(owner);
      const unused = provider(owner);
      const a = first._acquire(undefined, true);
      const k = kernel();
      if (phase === 'engine')
        k.closeEngine.mockRejectedValueOnce(new Error('retryable final close'));
      if (phase === 'carrier')
        k.closeCarrier.mockRejectedValueOnce(
          new Error('retryable final close'),
        );
      if (phase === 'holder')
        k.closeHolder.mockImplementationOnce(() => {
          throw new Error('retryable final close');
        });
      await a.open();
      a.httpTransports(() => k.holder, k.engine);
      a.privateRuntime!.bind(k.engine, k.carrier, k.holder);
      await a.privateRuntime!.finish(true, true);
      await first.close();
      await expect(owner.close()).rejects.toThrow('retryable final close');
      expect(() => unused._acquire()).toThrow('closed or closing');
      expect(k.closeEngine).toHaveBeenCalledTimes(1);
      expect(k.closeCarrier).toHaveBeenCalledTimes(phase === 'engine' ? 0 : 1);
      expect(k.closeHolder).toHaveBeenCalledTimes(phase === 'holder' ? 1 : 0);
      await owner.close();
      expect(k.closeEngine).toHaveBeenCalledTimes(phase === 'engine' ? 2 : 1);
      expect(k.closeCarrier).toHaveBeenCalledTimes(phase === 'carrier' ? 2 : 1);
      expect(k.closeHolder).toHaveBeenCalledTimes(phase === 'holder' ? 2 : 1);
      await unused.close();
    },
  );
  it('claims owner closing synchronously and joins concurrent close calls', async () => {
    const owner = new NativeRuntime();
    const first = provider(owner);
    const unused = provider(owner);
    const a = first._acquire(undefined, true);
    const k = kernel();
    const gate = Promise.withResolvers<null>();
    k.closeEngine.mockImplementationOnce(() => gate.promise);
    await a.open();
    a.httpTransports(() => k.holder, k.engine);
    a.privateRuntime!.bind(k.engine, k.carrier, k.holder);
    await a.privateRuntime!.finish(true, true);
    await first.close();
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    expect(() => unused._acquire()).toThrow('closed or closing');
    expect(k.closeHolder).not.toHaveBeenCalled();
    gate.resolve(null);
    await closing;
    expect(k.closeEngine).toHaveBeenCalledTimes(1);
    expect(k.closeHolder).toHaveBeenCalledTimes(1);
    await unused.close();
  });
  it('keeps a failed shared reservation unavailable until Provider cleanup retry joins', async () => {
    await using owner = new NativeRuntime();
    await using first = provider(owner);
    const a = first._acquire(undefined, true);
    const k = kernel();
    k.closeEngine
      .mockRejectedValueOnce(new Error('first close failure'))
      .mockRejectedValueOnce(new Error('retry close failure'));
    await a.open();
    a.httpTransports(() => k.holder, k.engine);
    a.privateRuntime!.bind(k.engine, k.carrier, k.holder);
    await expect(
      a.failOpening(new Error('opening failure')),
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(first.close()).rejects.toThrow(
      'NativeProvider cleanup failed',
    );
    await using second = provider(owner);
    const b = second._acquire(undefined, true);
    expect(b.privateRuntime).toBeUndefined();
    await b.release();
    await second.close();
    await expect(owner.close()).rejects.toThrow('borrowing Providers');
    await first.close();
    expect(k.closeEngine).toHaveBeenCalledTimes(3);
    expect(k.closeCarrier).toHaveBeenCalledTimes(1);
    await owner.close();
    expect(k.closeHolder).toHaveBeenCalledTimes(1);
  });
});
