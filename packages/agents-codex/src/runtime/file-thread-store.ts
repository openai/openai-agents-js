import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionStore } from './custom-thread-store';

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
 * before an operator removes `<sessionId>.lock`. Never remove a live writer's lock.
 */
export function fileSessionStore(directory: string): SessionStore {
  const root = resolve(directory);
  const releases = new Map<string, FileHandle>();
  function paths(sessionId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
      throw new TypeError(
        'Session ID must contain 1–128 letters, digits, _ or -',
      );
    }
    return {
      record: join(root, `${sessionId}.json`),
      lock: join(root, `${sessionId}.lock`),
      owner: join(root, `${sessionId}.lock`, 'owner'),
    };
  }
  async function assertFence(sessionId: string, fence: string): Promise<void> {
    const { owner } = paths(sessionId);
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
  async function readRecord(sessionId: string): Promise<RecordFile | null> {
    let text: string;
    try {
      text = await readFile(paths(sessionId).record, 'utf8');
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
    async acquire(sessionId) {
      const { lock, owner } = paths(sessionId);
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
    async read(sessionId, fence) {
      await assertFence(sessionId, fence);
      return (await readRecord(sessionId))?.snapshot ?? null;
    },
    async commit(sessionId, fence, writeId, expectedRevision, snapshot) {
      await assertFence(sessionId, fence);
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
      const previous = await readRecord(sessionId);
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
      const target = paths(sessionId).record;
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
        await assertFence(sessionId, fence);
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
    async flush(sessionId, fence) {
      await assertFence(sessionId, fence);
      let handle;
      try {
        handle = await open(paths(sessionId).record, 'r');
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
    async release(sessionId, fence) {
      const lease = JSON.stringify([sessionId, fence]);
      let ownedDirectory = releases.get(lease);
      const { owner, lock } = paths(sessionId);
      if (!ownedDirectory) {
        let currentFence: string | undefined;
        try {
          currentFence = await readFile(owner, 'utf8');
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
        }
        if (currentFence !== fence) {
          // Obsolete releases repeat durability without touching a successor.
          await syncDirectory(root);
          return;
        }
        ownedDirectory = await open(lock, 'r');
        try {
          await unlink(owner);
        } catch (error) {
          await ownedDirectory.close();
          throw error;
        }
        // Pin the inode after unlink so a failed rmdir can retry this exact
        // directory without mistaking a replacement for its cleanup owner.
        releases.set(lease, ownedDirectory);
      }
      const owned = await ownedDirectory.stat({ bigint: true });
      let current;
      try {
        current = await lstat(lock, { bigint: true });
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      if (
        current &&
        (!current.isDirectory() ||
          current.dev !== owned.dev ||
          current.ino !== owned.ino)
      ) {
        releases.delete(lease);
        await ownedDirectory.close();
        throw new Error('Thread writer fence is no longer valid');
      }
      if (current) await rmdir(lock);
      // A rejected close still invalidates its fd, so retire ownership first.
      releases.delete(lease);
      await ownedDirectory.close();
      await syncDirectory(root);
    },
  };
}
