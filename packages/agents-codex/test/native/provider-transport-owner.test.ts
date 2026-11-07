import { expect, it } from 'vitest';
import type { Engine, _ProviderHttpTransports } from '../../native/index.js';
import { NativeProvider } from '../../src/runtime/provider';

const engine = {} as Engine;

it('shares an empty owner while leases close independently, then releases it once', async () => {
  const provider = new NativeProvider({ apiKey: 'synthetic' });
  const first = provider._acquire();
  const second = provider._acquire();
  let created = 0;
  let closed = 0;
  const owner = {
    close: () => {
      closed++;
    },
  } as _ProviderHttpTransports;
  const create = () => {
    created++;
    return owner;
  };
  try {
    const results = await Promise.all([
      Promise.resolve().then(() => first.httpTransports(create, engine)),
      Promise.resolve().then(() => second.httpTransports(create, engine)),
    ]);
    expect(results).toEqual([owner, owner]);
    expect(created).toBe(1);
    await expect(provider.close()).rejects.toThrow('open or opening sessions');
    expect(closed).toBe(0);
    await first.release();
    expect(closed).toBe(0);
    expect(() => first.httpTransports(create, engine)).toThrow('closed');
    await expect(provider.close()).rejects.toThrow('open or opening sessions');
    await second.release();
    await provider.close();
    await provider.close();
    expect(closed).toBe(1);
    expect(() => first.httpTransports(create, engine)).toThrow('closed');
  } finally {
    await first.release();
    await second.release();
    await provider.close();
  }
});

it('allows another opening to retry after synchronous owner allocation fails', async () => {
  const provider = new NativeProvider({ apiKey: 'synthetic' });
  const first = provider._acquire();
  const second = provider._acquire();
  let calls = 0;
  let closed = 0;
  const owner = {
    close: () => {
      closed++;
    },
  } as _ProviderHttpTransports;
  const create = () => {
    if (++calls === 1) throw new Error('allocation failed');
    return owner;
  };
  try {
    expect(() => first.httpTransports(create, engine)).toThrow(
      'allocation failed',
    );
    expect(second.httpTransports(create, engine)).toBe(owner);
    expect(calls).toBe(2);
    expect(closed).toBe(0);
  } finally {
    await first.release();
    await second.release();
    await provider.close();
  }
  expect(closed).toBe(1);
});
