import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSessionStore } from '../src/runtime/file-thread-store';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rmdir: vi.fn(actual.rmdir) };
});

const execute = promisify(execFile);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agents-thread-store-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('fileSessionStore', () => {
  it('persists opaque snapshots and revisions across adapter instances', async () => {
    const first = fileSessionStore(directory);
    const fence = await first.acquire('thread-1');
    expect(await first.read('thread-1', fence)).toBeNull();
    const snapshot = JSON.stringify({ revision: 1, native: { opaque: true } });
    await first.commit('thread-1', fence, 'write-1', 0, snapshot);
    await first.release('thread-1', fence);
    const next = fileSessionStore(directory);
    const nextFence = await next.acquire('thread-1');
    expect(await next.read('thread-1', nextFence)).toBe(snapshot);
    await next.commit(
      'thread-1',
      nextFence,
      'write-2',
      1,
      'next opaque snapshot',
    );
    await next.release('thread-1', nextFence);
    expect(
      JSON.parse(await readFile(join(directory, 'thread-1.json'), 'utf8')),
    ).toEqual({
      revision: 2,
      writeId: 'write-2',
      snapshot: 'next opaque snapshot',
    });
  });

  it('rejects competing writers and stale fences after explicit recovery', async () => {
    const first = fileSessionStore(directory);
    const oldFence = await first.acquire('thread');
    const second = fileSessionStore(directory);
    await expect(second.acquire('thread')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    // Stand in for an operator who has stopped and joined a crashed owner.
    await rm(join(directory, 'thread.lock'), { recursive: true });
    const fence = await second.acquire('thread');
    expect(fence).not.toBe(oldFence);
    await expect(first.read('thread', oldFence)).rejects.toThrow('fence');
    await expect(
      first.commit('thread', oldFence, 'old', 0, '{}'),
    ).rejects.toThrow('fence');
    await expect(first.release('thread', oldFence)).rejects.toThrow('fence');
    await second.commit('thread', fence, 'new', 0, '{}');
    await second.release('thread', fence);
  });

  it('rejects stale revisions without changing the accepted snapshot', async () => {
    const store = fileSessionStore(directory);
    const fence = await store.acquire('thread');
    await store.commit('thread', fence, 'one', 0, 'first');
    await expect(
      store.commit('thread', fence, 'two', 0, 'second'),
    ).rejects.toThrow('revision conflict');
    expect(await store.read('thread', fence)).toBe('first');
    await store.release('thread', fence);
  });

  it('reconciles a lost acknowledgement without writing a second revision', async () => {
    const store = fileSessionStore(directory);
    const fence = await store.acquire('thread');
    // The application loses the result after the actual durable write succeeds.
    const loseAcknowledgement = async () => {
      await store.commit('thread', fence, 'logical-write', 0, 'accepted');
      throw new Error('connection lost after commit');
    };
    await expect(loseAcknowledgement()).rejects.toThrow('connection lost');
    const retry = fileSessionStore(directory);
    await retry.commit('thread', fence, 'logical-write', 0, 'accepted');
    await expect(
      retry.commit('thread', fence, 'logical-write', 0, 'different'),
    ).rejects.toThrow('reused');
    await expect(
      retry.commit('thread', fence, 'logical-write', 1, 'accepted'),
    ).rejects.toThrow('reused');
    await retry.commit('thread', fence, 'next-write', 1, 'next');
    await retry.release('thread', fence);
  });

  it('reopens the saved snapshot in a fresh Node process', async () => {
    const store = fileSessionStore(directory);
    const fence = await store.acquire('thread');
    await store.commit('thread', fence, 'one', 0, 'saved in parent');
    await store.release('thread', fence);
    const source = fileURLToPath(
      new URL('../src/runtime/file-thread-store.ts', import.meta.url),
    );
    const program = `
      const { fileSessionStore } = require(${JSON.stringify(source)});
      (async () => {
        const store = fileSessionStore(${JSON.stringify(directory)});
        const fence = await store.acquire('thread');
        const snapshot = await store.read('thread', fence);
        await store.commit('thread', fence, 'two', 1, 'saved in child');
        await store.release('thread', fence);
        process.stdout.write(snapshot);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = await execute(
      process.execPath,
      ['--import', 'tsx', '-e', program],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      },
    );
    expect(child.stdout).toBe('saved in parent');
    const reopened = fileSessionStore(directory);
    const newFence = await reopened.acquire('thread');
    expect(await reopened.read('thread', newFence)).toBe('saved in child');
    await reopened.release('thread', newFence);
  });

  it('retains an acknowledged commit and lock after the writer is killed', async () => {
    const source = fileURLToPath(
      new URL('../src/runtime/file-thread-store.ts', import.meta.url),
    );
    const program = `
      const { fileSessionStore } = require(${JSON.stringify(source)});
      (async () => {
        const store = fileSessionStore(${JSON.stringify(directory)});
        const fence = await store.acquire('thread');
        await store.commit('thread', fence, 'one', 0, 'saved before crash');
        process.kill(process.pid, 'SIGKILL');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    await expect(
      execute(process.execPath, ['--import', 'tsx', '-e', program], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      }),
    ).rejects.toMatchObject({ signal: 'SIGKILL' });
    const reopened = fileSessionStore(directory);
    await expect(reopened.acquire('thread')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    // execFile has joined the dead process, so explicit lock recovery is safe.
    await rm(join(directory, 'thread.lock'), { recursive: true });
    const fence = await reopened.acquire('thread');
    expect(await reopened.read('thread', fence)).toBe('saved before crash');
    await reopened.release('thread', fence);
  });

  it('cleans an unissued lease after owner creation fails and retains the error', async () => {
    const store = fileSessionStore(directory);
    const failure = new Error('owner write denied');
    vi.mocked(fs.open).mockRejectedValueOnce(failure);
    await expect(store.acquire('thread')).rejects.toBe(failure);
    const fence = await store.acquire('thread');
    await store.flush!('thread', fence);
    await store.commit('thread', fence, 'one', 0, 'snapshot');
    await store.flush!('thread', fence);
    await expect(store.flush!('thread', 'wrong')).rejects.toThrow('fence');
    await store.release('thread', fence);
  });

  it('retries a release barrier without touching a successor after unlock', async () => {
    const store = fileSessionStore(directory);
    const fence = await store.acquire('thread');
    const failure = new Error('release directory sync failed');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === directory) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
        vi.mocked(fs.open).mockImplementation(actual.open);
      }
      return handle;
    });
    await expect(store.release('thread', fence)).rejects.toBe(failure);
    const successor = fileSessionStore(directory);
    const nextFence = await successor.acquire('thread');
    await store.release('thread', fence);
    await successor.commit(
      'thread',
      nextFence,
      'successor',
      0,
      'successor owns this',
    );
    expect(await successor.read('thread', nextFence)).toBe(
      'successor owns this',
    );
    await successor.release('thread', nextFence);
  });

  it('retries a lost release acknowledgement without deleting a successor lock', async () => {
    const store = fileSessionStore(directory);
    const fence = await store.acquire('thread');
    const loseAcknowledgement = async () => {
      await store.release('thread', fence);
      throw new Error('release acknowledgement lost');
    };
    await expect(loseAcknowledgement()).rejects.toThrow('acknowledgement lost');
    const successor = fileSessionStore(directory);
    const nextFence = await successor.acquire('thread');
    await store.release('thread', fence);
    await expect(store.release('thread', 'never-issued')).rejects.toThrow(
      'fence',
    );
    await successor.commit(
      'thread',
      nextFence,
      'successor',
      0,
      'still owns this',
    );
    expect(await successor.read('thread', nextFence)).toBe('still owns this');
    await successor.release('thread', nextFence);
  });

  it('retries an empty lock removal after owner unlink succeeds', async () => {
    const store = fileSessionStore(directory);
    const fence = await store.acquire('thread');
    await store.commit('thread', fence, 'one', 0, 'retained snapshot');
    const failure = Object.assign(new Error('lock removal temporarily busy'), {
      code: 'EBUSY',
    });
    vi.mocked(fs.rmdir).mockRejectedValueOnce(failure);
    await expect(store.release('thread', fence)).rejects.toBe(failure);
    await expect(
      readFile(join(directory, 'thread.lock', 'owner')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await store.release('thread', fence);
    const successor = fileSessionStore(directory);
    const nextFence = await successor.acquire('thread');
    expect(await successor.read('thread', nextFence)).toBe('retained snapshot');
    await successor.release('thread', nextFence);
  });

  it.each(['empty directory', 'successor lease'] as const)(
    'does not remove a replacement %s after partial unlock',
    async (replacement) => {
      const store = fileSessionStore(directory);
      const fence = await store.acquire('thread');
      vi.mocked(fs.rmdir).mockRejectedValueOnce(
        new Error('transient removal failure'),
      );
      await expect(store.release('thread', fence)).rejects.toThrow(
        'transient removal failure',
      );
      // Simulate explicit recovery after the old writer was stopped and joined.
      await rm(join(directory, 'thread.lock'), { recursive: true });
      const successor = fileSessionStore(directory);
      const nextFence =
        replacement === 'successor lease'
          ? await successor.acquire('thread')
          : undefined;
      if (replacement === 'empty directory')
        await fs.mkdir(join(directory, 'thread.lock'));
      await expect(store.release('thread', fence)).rejects.toThrow('fence');
      expect(
        (await fs.stat(join(directory, 'thread.lock'))).isDirectory(),
      ).toBe(true);
      if (nextFence) {
        await successor.commit(
          'thread',
          nextFence,
          'one',
          0,
          'successor snapshot',
        );
        expect(await successor.read('thread', nextFence)).toBe(
          'successor snapshot',
        );
        await successor.release('thread', nextFence);
      }
    },
  );

  it('leaves partial release failure for explicit recovery without deleting unknown files', async () => {
    const store = fileSessionStore(directory);
    const fence = await store.acquire('thread');
    await writeFile(
      join(directory, 'thread.lock', 'unexpected'),
      'preserve evidence',
    );
    await expect(store.release('thread', fence)).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    });
    await expect(store.release('thread', fence)).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    });
    await expect(
      fileSessionStore(directory).acquire('thread'),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(
      await readFile(join(directory, 'thread.lock', 'unexpected'), 'utf8'),
    ).toBe('preserve evidence');
    await rm(join(directory, 'thread.lock', 'unexpected'));
    await store.release('thread', fence);
  });

  it('keeps corrupt records and rejects path traversal', async () => {
    const store = fileSessionStore(directory);
    for (const id of [
      '',
      '../outside',
      '/absolute',
      'a/b',
      'a\\b',
      '.',
      'x'.repeat(129),
    ]) {
      await expect(store.acquire(id)).rejects.toThrow('Session ID');
    }
    const fence = await store.acquire('thread');
    await writeFile(join(directory, 'thread.json'), '{broken');
    await expect(store.read('thread', fence)).rejects.toThrow();
    await expect(
      store.commit('thread', fence, 'write', 0, '{}'),
    ).rejects.toThrow();
    expect(await readFile(join(directory, 'thread.json'), 'utf8')).toBe(
      '{broken',
    );
    await store.release('thread', fence);
  });
});
