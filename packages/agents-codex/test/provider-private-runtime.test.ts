import { stat } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { Engine, _ProviderHttpTransports } from '../native/index.js';
import type { NativeProviderRoutes } from '../src/runtime/http-model';
import { NativeProvider } from '../src/runtime/provider';

// Like provider-transport-owner.test.ts, control only the external cleanup calls.
// The real Provider owns the lease, immediate callback and temporary home.
async function retained(useEnvironmentKey = false, supportsWebsockets = false) {
  const provider = new NativeProvider({
    ...(useEnvironmentKey ? {} : { apiKey: 'synthetic' }),
    supportsWebsockets,
  });
  const lease = provider._acquire(undefined, true);
  try {
    const home = await lease.open();
    const engine = {
      _close_report: vi.fn(async (): Promise<string | null> => null),
      _private_reuse_ready: true,
    };
    const carrier = {
      close: vi.fn(async () => {}),
      reuseBinding: () => ({ origin: 'http://127.0.0.1', grant: 'synthetic' }),
    };
    const transports = { close: vi.fn() };
    lease.httpTransports(
      () => transports as unknown as _ProviderHttpTransports,
      engine as unknown as Engine,
    );
    lease.privateRuntime!.bind(
      engine as unknown as Engine,
      carrier as unknown as NativeProviderRoutes,
      transports as unknown as _ProviderHttpTransports,
    );
    return { provider, lease, home, engine, carrier, transports };
  } catch (error) {
    await lease.release();
    await provider.close();
    throw error;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('reuses adjacent WSS owners and retires them on the real idle callback', async () => {
  const fixture = await retained(false, true);
  await using provider = fixture.provider;
  await fixture.lease.privateRuntime!.finish(true, true);
  const adjacent = provider._acquire(undefined, true);
  try {
    expect(adjacent.websocketsAllowed).toBe(true);
    expect(adjacent.privateRuntime!.peek()?.engine).toBe(fixture.engine);
    expect(await adjacent.open()).toEqual(fixture.home);
    expect(fixture.engine._close_report).not.toHaveBeenCalled();
  } finally {
    await adjacent.privateRuntime!.finish(true, true);
  }
  await vi.waitFor(async () => {
    await expect(stat(fixture.home.codex_home)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(1);
  expect(fixture.carrier.close).toHaveBeenCalledTimes(1);
  const fresh = provider._acquire(undefined, true);
  try {
    expect(fresh.privateRuntime?.peek()).toBeUndefined();
    expect((await fresh.open()).codex_home).not.toBe(fixture.home.codex_home);
  } finally {
    await fresh.release();
  }
});

it('discards a default WSS fallback Engine instead of parking it', async () => {
  const fixture = await retained(false, true);
  await using provider = fixture.provider;
  expect(fixture.lease.privateRuntime!.plainOnly).toBe(true);
  expect(fixture.lease.privateRuntime!.refreshWebsocketTrust).toBe(true);
  await fixture.lease.privateRuntime!.finish(true);
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(1);
  expect(fixture.carrier.close).toHaveBeenCalledTimes(1);
  const next = provider._acquire(undefined, true);
  try {
    expect(next.privateRuntime?.peek()).toBeUndefined();
  } finally {
    await next.release();
  }
});

it('cancels pending idle cleanup for a new lease and disposes its home only after that lease', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const fixture = await retained();
  await using provider = fixture.provider;
  await fixture.lease.privateRuntime!.finish(true);
  const next = provider._acquire(undefined, true);
  try {
    expect(await next.open()).toEqual(fixture.home);
    vi.runOnlyPendingTimers();
    expect(fixture.engine._close_report).not.toHaveBeenCalled();
    expect(fixture.lease.privateRuntime!.done).toBe(true);
    await fixture.lease.privateRuntime!.finish(false);
    expect(next.privateRuntime!.peek()?.engine).toBe(fixture.engine);
  } finally {
    await next.privateRuntime!.finish(false);
  }
  await expect(stat(fixture.home.codex_home)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(1);
  expect(fixture.carrier.close).toHaveBeenCalledTimes(1);
});

it('takes independent fresh fallback after idle disposal starts and joins it on Provider.close', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const fixture = await retained();
  let release!: (value: string | null) => void;
  const held = new Promise<string | null>((resolve) => {
    release = resolve;
  });
  fixture.engine._close_report.mockImplementation(() => held);
  await fixture.lease.privateRuntime!.finish(true);
  vi.runOnlyPendingTimers();
  await Promise.resolve();
  const next = fixture.provider._acquire(undefined, true);
  try {
    expect(next.privateRuntime).toBeUndefined();
    expect((await next.open()).codex_home).not.toBe(fixture.home.codex_home);
    await expect(fixture.provider.close()).rejects.toThrow(
      'open or opening sessions',
    );
    await next.release();
    let closed = false;
    const close = fixture.provider.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(null);
    await close;
    expect(closed).toBe(true);
  } finally {
    release(null);
    await next.release();
    await fixture.provider.close();
  }
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(1);
  expect(fixture.transports.close).toHaveBeenCalledTimes(1);
  await expect(stat(fixture.home.codex_home)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('cancels pending expiry when Provider.close owns cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const fixture = await retained();
  await fixture.lease.privateRuntime!.finish(true);
  await fixture.provider.close();
  vi.runOnlyPendingTimers();
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(1);
  expect(fixture.carrier.close).toHaveBeenCalledTimes(1);
  expect(fixture.transports.close).toHaveBeenCalledTimes(1);
});

it('retains an asynchronous cleanup failure for explicit close and retries the incomplete phase', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const fixture = await retained();
  const failure = new Error('held native close failure');
  fixture.engine._close_report.mockRejectedValueOnce(failure);
  await fixture.lease.privateRuntime!.finish(true);
  vi.runOnlyPendingTimers();
  await expect(fixture.provider.close()).rejects.toBe(failure);
  expect(fixture.carrier.close).not.toHaveBeenCalled();
  expect((await stat(fixture.home.codex_home)).isDirectory()).toBe(true);
  await fixture.provider.close();
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(2);
  expect(fixture.carrier.close).toHaveBeenCalledTimes(1);
  expect(fixture.transports.close).toHaveBeenCalledTimes(1);
  await expect(stat(fixture.home.codex_home)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('keeps concurrent leases independent and schedules expiry only after the last lease closes', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const fixture = await retained();
  const sibling = fixture.provider._acquire(undefined, true);
  try {
    expect(sibling.privateRuntime).toBeUndefined();
    expect((await sibling.open()).codex_home).not.toBe(fixture.home.codex_home);
    await fixture.lease.privateRuntime!.finish(true);
    vi.runOnlyPendingTimers();
    expect(fixture.engine._close_report).not.toHaveBeenCalled();
    await sibling.release();
    vi.runOnlyPendingTimers();
    await fixture.provider.close();
  } finally {
    await sibling.release();
    await fixture.provider.close();
  }
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(1);
});

it('retries a failed carrier phase without closing the Engine twice or removing the home early', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const fixture = await retained();
  const failure = new Error('held carrier close failure');
  fixture.carrier.close.mockRejectedValueOnce(failure);
  await fixture.lease.privateRuntime!.finish(true);
  vi.runOnlyPendingTimers();
  await expect(fixture.provider.close()).rejects.toBe(failure);
  expect((await stat(fixture.home.codex_home)).isDirectory()).toBe(true);
  await fixture.provider.close();
  expect(fixture.engine._close_report).toHaveBeenCalledTimes(1);
  expect(fixture.carrier.close).toHaveBeenCalledTimes(2);
  await expect(stat(fixture.home.codex_home)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('admits buffered HTTP providers to private runtime reuse', async () => {
  await using provider = new NativeProvider({
    apiKey: 'synthetic',
    responseMode: 'buffered',
    supportsWebsockets: false,
  });
  const lease = provider._acquire(undefined, true);
  try {
    expect(lease.privateRuntime).toBeDefined();
  } finally {
    await lease.release();
  }
});

it.each([undefined, ''])(
  'falls back to a fresh owner when the environment key is removed (%j)',
  async (missing) => {
    vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-environment');
    const fixture = await retained(true);
    await using provider = fixture.provider;
    await fixture.lease.privateRuntime!.finish(true);
    vi.stubEnv('OPENAI_API_KEY', missing);
    const next = provider._acquire(undefined, true);
    try {
      expect(next.privateRuntime).toBeUndefined();
      expect(next.apiKey).toBe(missing);
      expect((await next.open()).codex_home).not.toBe(fixture.home.codex_home);
      expect(fixture.engine._close_report).not.toHaveBeenCalled();
    } finally {
      await next.release();
    }
  },
);

it('pins the captured environment key for an opening', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-new-environment');
  await using provider = new NativeProvider({ supportsWebsockets: false });
  const lease = provider._acquire({ apiKey: 'synthetic-captured' }, true);
  try {
    expect(lease.apiKey).toBe('synthetic-captured');
    expect(lease.privateRuntime).toBeDefined();
  } finally {
    await lease.privateRuntime!.finish(false);
  }
});
