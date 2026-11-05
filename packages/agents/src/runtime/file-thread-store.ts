import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CanonicalThreadStore } from './custom-thread-store';

interface RecordFile {
  revision: number;
  writeId: string;
  snapshot: string;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Reference store for a trusted, application-owned local filesystem directory.
 * Serialize operations within each acquired lease. The filesystem must support
 * atomic rename and file/directory fsync. Network filesystems are unsupported.
 * A crashed writer leaves its lock: stop and confirm the old process is dead
 * before an operator removes `<threadId>.lock`. Never remove a live writer's lock.
 */
export function fileThreadStore(directory: string): CanonicalThreadStore {
  const root = resolve(directory);
  const released = new Set<string>();
  function paths(threadId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(threadId)) {
      throw new TypeError(
        'Thread ID must contain 1–128 letters, digits, _ or -',
      );
    }
    return {
      record: join(root, `${threadId}.json`),
      lock: join(root, `${threadId}.lock`),
      owner: join(root, `${threadId}.lock`, 'owner'),
    };
  }
  async function assertFence(threadId: string, fence: string): Promise<void> {
    const { owner } = paths(threadId);
    let actual: string;
    try {
      actual = await readFile(owner, 'utf8');
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      throw new Error('Thread writer fence is no longer valid', {
        cause: error,
      });
    }
    if (actual !== fence)
      throw new Error('Thread writer fence is no longer valid');
  }
  async function readRecord(threadId: string): Promise<RecordFile | null> {
    let text: string;
    try {
      text = await readFile(paths(threadId).record, 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    }
    const record = JSON.parse(text) as RecordFile;
    if (
      !record ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      typeof record.writeId !== 'string' ||
      typeof record.snapshot !== 'string'
    ) {
      throw new Error('Invalid thread store record');
    }
    return record;
  }
  return {
    async acquire(threadId) {
      const { lock, owner } = paths(threadId);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(lock, { mode: 0o700 });
      const fence = randomUUID();
      try {
        const handle = await open(owner, 'wx', 0o600);
        try {
          await handle.writeFile(fence, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(lock);
        await syncDirectory(root);
        return fence;
      } catch (error) {
        // This call created the lock and has not returned its ownership token.
        try {
          await rm(lock, { recursive: true });
          await syncDirectory(root);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Thread acquire and cleanup failed',
          );
        }
        throw error;
      }
    },
    async read(threadId, fence) {
      await assertFence(threadId, fence);
      return (await readRecord(threadId))?.snapshot ?? null;
    },
    async commit(threadId, fence, writeId, expectedRevision, snapshot) {
      await assertFence(threadId, fence);
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision >= Number.MAX_SAFE_INTEGER ||
        typeof writeId !== 'string' ||
        !writeId ||
        typeof snapshot !== 'string'
      ) {
        throw new TypeError('Invalid thread commit');
      }
      const previous = await readRecord(threadId);
      if (previous?.writeId === writeId) {
        if (
          previous.snapshot !== snapshot ||
          previous.revision !== expectedRevision + 1
        ) {
          throw new Error(
            'Write ID was reused with different content or revision',
          );
        }
        // A prior attempt may have renamed the record and lost its acknowledgement.
        await syncDirectory(root);
        return;
      }
      if ((previous?.revision ?? 0) !== expectedRevision) {
        throw new Error('Thread revision conflict');
      }
      const target = paths(threadId).record;
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              revision: expectedRevision + 1,
              writeId,
              snapshot,
            }),
            'utf8',
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await assertFence(threadId, fence);
        await rename(temporary, target);
        await syncDirectory(root);
      } catch (error) {
        try {
          await rm(temporary, { force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Thread commit and cleanup failed',
          );
        }
        throw error;
      }
    },
    async flush(threadId, fence) {
      await assertFence(threadId, fence);
      let handle;
      try {
        handle = await open(paths(threadId).record, 'r');
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      if (handle) {
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(root);
    },
    async release(threadId, fence) {
      const lease = JSON.stringify([threadId, fence]);
      if (released.has(lease)) {
        // Retry only the barrier, even when a successor now owns the lock path.
        await syncDirectory(root);
        return;
      }
      await assertFence(threadId, fence);
      const { owner, lock } = paths(threadId);
      await unlink(owner);
      await rmdir(lock);
      // Record the physical unlock before a failed barrier can lose its result.
      released.add(lease);
      await syncDirectory(root);
    },
  };
}
