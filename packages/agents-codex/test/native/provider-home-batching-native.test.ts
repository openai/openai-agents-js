import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { binding } from '../../src/runtime/binding';
import { NativeProvider } from '../../src/runtime/provider';

it('joins the real asynchronous native helper through its provider lease', async () => {
  const native = await binding();
  const remove = native._try_remove_empty_provider_home;
  expect(typeof remove).toBe('function');
  if (typeof remove !== 'function')
    throw new Error('Native provider-home cleanup export is missing');
  const cleanup = vi.fn(remove);
  const provider = new NativeProvider({ apiKey: 'fixture' });
  const lease = provider._acquire(undefined, cleanup);
  let home: string | undefined;
  try {
    home = (await lease.open()).codex_home;
    await lease.release();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(home);
    await expect(cleanup.mock.results[0]!.value).resolves.toBe(true);
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    try {
      await lease.release();
    } finally {
      try {
        await provider.close();
      } finally {
        if (home) await rm(home, { recursive: true, force: true });
      }
    }
  }
});

it('reports a missing path for the Node force-removal fallback', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'provider-native-missing-'));
  try {
    const native = await binding();
    const remove = native._try_remove_empty_provider_home;
    if (typeof remove !== 'function')
      throw new Error('Native provider-home cleanup export is missing');
    await expect(remove(join(outer, 'missing'))).resolves.toBe(false);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});
