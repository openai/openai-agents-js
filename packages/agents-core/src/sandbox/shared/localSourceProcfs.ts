import { constants, type Dirent } from 'node:fs';
import { readLocalSourceBuffer } from './localSourceBuffer';
import { lstat, open, opendir, readdir, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type {
  NativeSourceDirectory,
  NativeSourceEntry,
} from './localSourceTypes';

// Linux O_PATH retains search-only directories without requiring read access.
const directoryFlags = 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function sourceError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function validateName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0')
  ) {
    throw sourceError('EINVAL', 'Invalid local source entry name');
  }
}

function procPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

async function validateProcfs(handle: FileHandle): Promise<void> {
  try {
    // Root-owned, non-writable ancestors prevent an unprivileged source writer
    // from replacing this path. Mount-namespace administration is trusted.
    for (const path of ['/', '/proc']) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error(`${path} must be a root-owned, non-writable directory`);
      }
    }
    const self = await lstat('/proc/self');
    const descriptors = await lstat('/proc/self/fd');
    if (!self.isSymbolicLink() || !descriptors.isDirectory()) {
      throw new Error('/proc/self/fd is not a process descriptor directory');
    }
    for (const path of ['/proc', '/proc/self/fd']) {
      if ((await statfs(path)).type !== 0x9fa0) {
        throw new Error(`${path} is not procfs`);
      }
    }
    // Dereference the kernel magic link itself, never its printed target.
    // This also checks accessibility before any untrusted source lookup.
    const held = await handle.stat();
    const linked = await stat(procPath(handle));
    if (
      !linked.isDirectory() ||
      held.dev !== linked.dev ||
      held.ino !== linked.ino
    ) {
      throw new Error('/proc/self/fd does not retain the opened directory');
    }
  } catch (cause) {
    throw Object.assign(
      sourceError(
        'ENOTSUP',
        'Linux Node local sources require trusted, accessible /proc/self/fd (procfs)',
      ),
      { cause },
    );
  }
}

class ProcfsSourceDirectory implements NativeSourceDirectory {
  private pending: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(private readonly handle: FileHandle) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(
        sourceError('EBADF', 'Local source directory is closed'),
      );
    }
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  openDirectory(name: string): Promise<NativeSourceDirectory> {
    validateName(name);
    return this.run(async () => {
      const path = `${procPath(this.handle)}/${name}`;
      try {
        return new ProcfsSourceDirectory(await open(path, directoryFlags));
      } catch (error) {
        // Like openat, O_DIRECTORY can report ENOTDIR for symlinks. This
        // improves diagnostics only; a failed open is never retried.
        if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
          try {
            if ((await lstat(path)).isSymbolicLink()) {
              throw sourceError(
                'ELOOP',
                'Local source directory is a symbolic link',
              );
            }
          } catch (diagnostic) {
            if ((diagnostic as NodeJS.ErrnoException).code === 'ELOOP') {
              throw diagnostic;
            }
          }
        }
        throw error;
      }
    });
  }

  async readFile(
    name: string,
    maxBytes?: number,
    prefix?: boolean,
  ): Promise<Uint8Array> {
    validateName(name);
    const file = await this.run(() =>
      open(
        `${procPath(this.handle)}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ),
    );
    // The opened file retains its own authority, so the parent can now close.
    let failed = false;
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        throw sourceError('EINVAL', 'Local source is not a regular file');
      }
      if (maxBytes === undefined) return await file.readFile();
      return await readLocalSourceBuffer(
        info.size,
        async (buffer) =>
          (await file.read(buffer, 0, buffer.length, null)).bytesRead,
        maxBytes,
        prefix,
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (failed) await file.close().catch(() => {});
      else await file.close();
    }
  }

  entries(maxEntries?: number): Promise<NativeSourceEntry[]> {
    return this.run(async () => {
      // Each call starts a fresh enumeration. Retain the handle until the
      // entire promise settles, including Node's lstat fallback for DT_UNKNOWN.
      let entries: Dirent[];
      if (maxEntries === undefined) {
        entries = await readdir(procPath(this.handle), { withFileTypes: true });
      } else {
        entries = [];
        const stream = await opendir(procPath(this.handle));
        for await (const entry of stream) {
          if (entries.length >= maxEntries)
            throw new RangeError('Local source member limit exceeded');
          entries.push(entry);
        }
      }
      return entries.map((entry): NativeSourceEntry => {
        validateName(entry.name);
        return {
          name: entry.name,
          type: entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : entry.isSymbolicLink()
                ? 'symlink'
                : 'other',
        };
      });
    });
  }

  close(): Promise<void> {
    this.closing ??= this.pending.then(() => this.handle.close());
    return this.closing;
  }
}

export async function openProcfsSourceRoot(
  root: string,
): Promise<NativeSourceDirectory> {
  if (
    process.platform !== 'linux' ||
    process.release.name !== 'node' ||
    process.versions.deno ||
    process.versions.bun
  ) {
    throw sourceError(
      'ENOTSUP',
      'Procfs local sources require Linux and Node.js',
    );
  }
  if (root !== '/') {
    throw sourceError('EINVAL', 'Procfs local source root must be /');
  }
  const handle = await open(root, directoryFlags);
  try {
    await validateProcfs(handle);
    return new ProcfsSourceDirectory(handle);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
