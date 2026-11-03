import { access } from 'node:fs/promises';
import { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/runtime/public-agent';
import { NativeProvider, type ProviderLease } from '../../src/runtime/provider';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import type { Engine } from '../../src/runtime/binding';

const native = vi.hoisted(() => ({ createEngine: vi.fn() }));
vi.mock('../../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/binding')>()),
  binding: async () => ({
    _packaged_runtime: () => ({}),
    _validate_python_tool_declarations: () => undefined,
    create_engine: native.createEngine,
  }),
}));

const listen = Server.prototype.listen;
const close = Server.prototype.close;
const servers = new Set<Server>();
const leases: ProviderLease[] = [];
const homes: string[] = [];

function provider() {
  const result = new NativeProvider({ apiKey: 'synthetic-test-key' });
  const acquire = result._acquire.bind(result);
  vi.spyOn(result, '_acquire').mockImplementation(() => {
    const lease = acquire();
    leases.push(lease);
    const open = lease.open.bind(lease);
    lease.open = async () => {
      const runtime = await open();
      homes.push(runtime.codex_home);
      return runtime;
    };
    return lease;
  });
  return result;
}

beforeEach(() => {
  vi.restoreAllMocks();
  native.createEngine.mockReset();
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
    this: Server,
    ...args
  ) {
    servers.add(this);
    return Reflect.apply(listen, this, args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Test teardown also drains the listener when a regression assertion fails.
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          close.call(server, () => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  homes.length = 0;
});

describe('real carrier cleanup', () => {
  it('preserves a listen failure and releases the provider home', async () => {
    const original = new Error('loopback listen failed');
    vi.mocked(Server.prototype.listen).mockImplementationOnce(function (
      this: Server,
    ) {
      servers.add(this);
      throw original;
    });
    const connection = provider();
    const agent = new Agent({
      instructions: 'Test cleanup',
      provider: connection,
    });

    await expect(agent.session()).rejects.toBe(original);
    await expect(connection.close()).resolves.toBeUndefined();
    expect(native.createEngine).not.toHaveBeenCalled();
    expect(homes).toHaveLength(1);
    await expect(access(homes[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('joins provider retries after the actual carrier close rejects', async () => {
    const original = new Error('engine binding failed');
    const incomplete = new Error('listener close failed');
    const retryEntered = Promise.withResolvers<void>();
    const retryAllowed = Promise.withResolvers<void>();
    const engineClose = vi.fn().mockResolvedValue(undefined);
    native.createEngine.mockResolvedValue({
      _sentinel_bind: () => {
        throw original;
      },
      close: engineClose,
      _close_report: async () => {
        await engineClose();
        return '';
      },
    });
    const closeSpy = vi
      .spyOn(Server.prototype, 'close')
      .mockImplementationOnce(function (this: Server, callback) {
        queueMicrotask(() => callback?.(incomplete));
        return this;
      })
      .mockImplementationOnce(function (this: Server, callback) {
        retryEntered.resolve();
        void retryAllowed.promise.then(() => close.call(this, callback));
        return this;
      });
    const connection = provider();
    const agent = new Agent({
      instructions: 'Test cleanup',
      provider: connection,
    });
    const failure = await agent.session().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, incomplete]);
    await access(homes[0]);

    const first = connection.close();
    const second = connection.close();
    const results = Promise.allSettled([first, second]);
    try {
      // A failed implementation may reject before it attempts the retry.
      await Promise.race([retryEntered.promise, results]);
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(engineClose).toHaveBeenCalledTimes(1);
      retryAllowed.resolve();
      expect(await results).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      await expect(access(homes[0])).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      retryAllowed.resolve();
      await results;
    }
  });

  it('joins an entered HTTP task before exposing a close failure', async () => {
    const routes = new NativeProviderRoutes();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closeEntered = Promise.withResolvers<void>();
    const incomplete = new Error('listener close failed');
    let origin = '';
    let grant = '';
    await routes.start({}, {});
    routes.bindEngine({
      _sentinel_bind: (url: string, token: string) => {
        origin = url;
        grant = token;
      },
      _sentinel_admit: async () => {
        entered.resolve();
        await release.promise;
        throw new Error('request stopped');
      },
    } as unknown as Engine);
    const request = fetch(`${origin}/p-b3BlbmFp/responses`, {
      method: 'POST',
      headers: { 'x-sdk-sentinel-grant': grant },
      body: JSON.stringify({
        client_metadata: {
          sdk_sentinel_thread: 'test-thread',
          sdk_sentinel_nonce: 'test-nonce',
        },
      }),
    }).catch(() => undefined);
    await Promise.race([
      entered.promise,
      request.then(() => {
        throw new Error('Request ended before admission');
      }),
    ]);
    vi.spyOn(Server.prototype, 'close').mockImplementationOnce(function (
      this: Server,
      callback,
    ) {
      queueMicrotask(() => {
        callback?.(incomplete);
        closeEntered.resolve();
      });
      return this;
    });
    let settled = false;
    const closing = routes.close().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await closeEntered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      expect(await closing).toBe(incomplete);
      await expect(routes.close()).resolves.toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([closing, request]);
    }
  });
});
