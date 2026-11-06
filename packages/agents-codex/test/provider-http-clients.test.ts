import { expect, it, vi } from 'vitest';
import type { SharedHttpClients } from '../native/index.js';
import { NativeProvider } from '../src/runtime/provider';

function owner() {
  return { close: vi.fn(async () => {}) } satisfies SharedHttpClients;
}

it('coalesces owner creation, rejects close with active leases, and closes once', async () => {
  const provider = new NativeProvider({ apiKey: 'fixture' });
  const a = provider._acquire();
  const b = provider._acquire();
  const resource = owner();
  const pending = Promise.withResolvers<SharedHttpClients>();
  const create = vi.fn(() => pending.promise);
  const first = a.httpClients(create);
  const second = b.httpClients(create);
  expect(first).toBe(second);
  expect(create).toHaveBeenCalledTimes(1);
  await expect(provider.close()).rejects.toThrow('open or opening sessions');
  pending.resolve(resource);
  expect(await first).toBe(resource);
  await a.release();
  await b.release();
  await provider.close();
  await provider.close();
  expect(resource.close).toHaveBeenCalledTimes(1);
});

it('joins pending creation and closes its result before provider close settles', async () => {
  const provider = new NativeProvider({ apiKey: 'fixture' });
  const lease = provider._acquire();
  const pending = Promise.withResolvers<SharedHttpClients>();
  const created = lease.httpClients(() => pending.promise);
  await lease.release();
  let settled = false;
  const closing = provider.close().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  const resource = owner();
  pending.resolve(resource);
  await created;
  await closing;
  expect(resource.close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(true);
  expect(() => provider._acquire()).toThrow('closed');
});

it('retries failed native owner creation instead of retaining a rejected Promise', async () => {
  const provider = new NativeProvider({ apiKey: 'fixture' });
  const first = provider._acquire();
  await expect(
    first.httpClients(async () => {
      throw new Error('create failed');
    }),
  ).rejects.toThrow('create failed');
  await first.release();
  const second = provider._acquire();
  const resource = owner();
  expect(await second.httpClients(async () => resource)).toBe(resource);
  await second.release();
  await provider.close();
  expect(resource.close).toHaveBeenCalledTimes(1);
});

it('retains the owner when failed-opening cleanup needs retry', async () => {
  const provider = new NativeProvider({ apiKey: 'fixture' });
  const lease = provider._acquire();
  const resource = owner();
  await lease.httpClients(async () => resource);
  let fail = true;
  lease.retainOpeningCleanup(async () => {
    if (fail) throw new Error('cleanup failed');
    await lease.release();
  });
  await expect(
    lease.failOpening(new Error('opening failed'), false),
  ).rejects.toThrow('opening failed');
  await expect(provider.close()).rejects.toThrow('cleanup failed');
  expect(resource.close).not.toHaveBeenCalled();
  fail = false;
  await provider.close();
  expect(resource.close).toHaveBeenCalledTimes(1);
});
