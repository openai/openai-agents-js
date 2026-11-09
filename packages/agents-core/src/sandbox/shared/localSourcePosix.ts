import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import koffi from 'koffi';
import type {
  NativeSourceDirectory,
  NativeSourceEntry,
} from './localSourceTypes';

const darwin = process.platform === 'darwin';
if (
  (!darwin && process.platform !== 'linux') ||
  (process.arch !== 'x64' && process.arch !== 'arm64')
) {
  throw new Error(
    `Native local sources do not support ${process.platform}/${process.arch}`,
  );
}

const libc = koffi.load(darwin ? '/usr/lib/libSystem.B.dylib' : null);
// Node, Bun and Deno expose the native platform/architecture flag values.
// Descriptor operations stay in libc; Deno's Node descriptors are virtual.
const openFlags = {
  directory: constants.O_DIRECTORY,
  nofollow: constants.O_NOFOLLOW,
  cloexec: darwin ? 0x1000000 : 0x80000,
  nonblock: constants.O_NONBLOCK,
};
const directoryFlags =
  openFlags.directory | openFlags.nofollow | openFlags.cloexec;
// Retain traverse-only directories without requiring permission to list them.
const traversalFlags = directoryFlags | (darwin ? 0x40000000 : 0x200000);
const open = libc.func('int open(const char *path, int flags)');
const openat = libc.func('int openat(int fd, const char *path, int flags)');
const close = libc.func('int close(int fd)');
const read = libc.func(
  'intptr_t read(int fd, _Out_ uint8_t *buffer, size_t size)',
);
const fdopendir = libc.func('void *fdopendir(int fd)');
const closedir = libc.func('int closedir(void *directory)');
// Darwin x64 retains legacy inode32 symbols alongside the current inode64 ABI.
const inodeSuffix = darwin && process.arch === 'x64' ? '$INODE64' : '';
const readdir = libc.func(`void *readdir${inodeSuffix}(void *directory)`);

const timespec = koffi.struct({ seconds: 'int64_t', nanoseconds: 'int64_t' });
// These are the native 64-bit libc stat layouts, not Node's descriptor ABI.
const statType = koffi.struct(
  darwin
    ? {
        device: 'int32_t',
        mode: 'uint16_t',
        links: 'uint16_t',
        inode: 'uint64_t',
        uid: 'uint32_t',
        gid: 'uint32_t',
        rdevice: 'int32_t',
        atime: timespec,
        mtime: timespec,
        ctime: timespec,
        birthtime: timespec,
        size: 'int64_t',
        blocks: 'int64_t',
        blocksize: 'int32_t',
        flags: 'uint32_t',
        generation: 'uint32_t',
        spare: 'int32_t',
        reserved: koffi.array('int64_t', 2),
      }
    : process.arch === 'x64'
      ? {
          device: 'uint64_t',
          inode: 'uint64_t',
          links: 'uint64_t',
          mode: 'uint32_t',
          uid: 'uint32_t',
          gid: 'uint32_t',
          padding: 'int32_t',
          rdevice: 'uint64_t',
          size: 'int64_t',
          blocksize: 'int64_t',
          blocks: 'int64_t',
          atime: timespec,
          mtime: timespec,
          ctime: timespec,
          reserved: koffi.array('int64_t', 3),
        }
      : {
          device: 'uint64_t',
          inode: 'uint64_t',
          mode: 'uint32_t',
          links: 'uint32_t',
          uid: 'uint32_t',
          gid: 'uint32_t',
          rdevice: 'uint64_t',
          padding: 'uint64_t',
          size: 'int64_t',
          blocksize: 'int32_t',
          padding2: 'int32_t',
          blocks: 'int64_t',
          atime: timespec,
          mtime: timespec,
          ctime: timespec,
          reserved: koffi.array('uint32_t', 2),
        },
);
const fstat = libc.func(`fstat${inodeSuffix}`, 'int', [
  'int',
  koffi.out(koffi.pointer(statType)),
]);
const fstatat = libc.func(`fstatat${inodeSuffix}`, 'int', [
  'int',
  'str',
  koffi.out(koffi.pointer(statType)),
  'int',
]);

function nativeError(operation: string, errno: number): NodeJS.ErrnoException {
  const code =
    Object.entries(koffi.os.errno).find(([, n]) => n === errno)?.[0] ?? 'EIO';
  return Object.assign(new Error(`${operation}: ${code}`), { code, errno });
}

type NativeFunction = ReturnType<typeof libc.func>;

function invoke(
  fn: NativeFunction,
  args: unknown[],
  operation: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (error: Error | null, result: number) => {
      // Koffi restores the worker's errno only for the duration of this callback.
      const errno = koffi.errno();
      if (error) reject(error);
      else if (result < 0) reject(nativeError(operation, errno));
      else resolve(result);
    });
  });
}

function validateName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0')
  ) {
    throw Object.assign(new Error('Invalid local source entry name'), {
      code: 'EINVAL',
    });
  }
}

class PosixSourceDirectory implements NativeSourceDirectory {
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly fd: number) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(() => {
      if (this.closed) throw nativeError('directory', koffi.os.errno.EBADF);
      return operation();
    });
    this.pending = next.catch(() => {});
    return next;
  }

  openDirectory(name: string): Promise<NativeSourceDirectory> {
    validateName(name);
    return this.run(async () => {
      try {
        return new PosixSourceDirectory(
          await invoke(
            openat,
            [this.fd, name, traversalFlags],
            'openat directory',
          ),
        );
      } catch (error) {
        // O_DIRECTORY can report ENOTDIR rather than ELOOP for a symlink.
        // This lookup only improves the diagnostic; no failed open is retried.
        if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
          const stat: { mode?: number } = {};
          try {
            await invoke(
              fstatat,
              [this.fd, name, stat, darwin ? 0x20 : 0x100],
              'fstatat',
            );
          } catch {
            throw error;
          }
          if (((stat.mode ?? 0) & 0xf000) === 0xa000) {
            throw nativeError('openat directory', koffi.os.errno.ELOOP);
          }
        }
        throw error;
      }
    });
  }

  async readFile(name: string): Promise<Uint8Array> {
    validateName(name);
    const fd = await this.run(() =>
      invoke(
        openat,
        [
          this.fd,
          name,
          openFlags.nofollow | openFlags.cloexec | openFlags.nonblock,
        ],
        'openat file',
      ),
    );
    let contents: Uint8Array;
    try {
      const stat: { mode?: number } = {};
      await invoke(fstat, [fd, stat], 'fstat');
      if (((stat.mode ?? 0) & 0xf000) !== 0x8000) {
        throw Object.assign(new Error('Local source is not a regular file'), {
          code: 'EINVAL',
        });
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let length: number;
        try {
          length = await invoke(read, [fd, buffer, buffer.length], 'read');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
          throw error;
        }
        if (length === 0) break;
        chunks.push(buffer.subarray(0, length));
        total += length;
      }
      contents = Buffer.concat(chunks, total);
    } catch (error) {
      await invoke(close, [fd], 'close').catch(() => {});
      throw error;
    }
    // Never retry close: on Linux an EINTR may already have released the fd.
    await invoke(close, [fd], 'close');
    return contents;
  }

  entries(): Promise<NativeSourceEntry[]> {
    return this.run(async () => {
      // The literal '.' reopens the held directory, never an untrusted path.
      // A fresh read handle also gives each enumeration its own stream offset.
      const duplicate = await invoke(
        openat,
        [this.fd, '.', directoryFlags],
        'openat enumeration',
      );
      const directory = fdopendir(duplicate);
      if (!directory) {
        const error = nativeError('fdopendir', koffi.errno());
        await invoke(close, [duplicate], 'close').catch(() => {});
        throw error;
      }
      const result: NativeSourceEntry[] = [];
      try {
        for (;;) {
          // Decode before another call on this DIR can invalidate its storage.
          // Clearing errno synchronously distinguishes end-of-stream from error.
          koffi.errno(0);
          const entry = readdir(directory);
          const errno = koffi.errno();
          if (!entry) {
            if (errno) throw nativeError('readdir', errno);
            break;
          }
          const recordLength = koffi.decode(entry, 16, 'uint16_t') as number;
          const nameOffset = darwin ? 21 : 19;
          if (
            recordLength <= nameOffset ||
            recordLength > (darwin ? 1048 : 280)
          ) {
            throw nativeError('readdir record', koffi.os.errno.EIO);
          }
          const bytes = Buffer.from(
            koffi.decode(entry, 'uint8_t', recordLength),
          );
          const end = bytes.indexOf(0, nameOffset);
          if (end === -1) throw nativeError('readdir name', koffi.os.errno.EIO);
          const name = bytes.toString('utf8', nameOffset, end);
          if (name === '.' || name === '..') continue;
          validateName(name);
          let type = bytes[darwin ? 20 : 18];
          if (type === 0) {
            // Some filesystems do not supply d_type. This metadata lookup does
            // not follow symlinks, and actual reads still reopen with O_NOFOLLOW.
            const stat: { mode?: number } = {};
            await invoke(
              fstatat,
              [this.fd, name, stat, darwin ? 0x20 : 0x100],
              'fstatat',
            );
            const mode = (stat.mode ?? 0) & 0xf000;
            type =
              mode === 0x4000
                ? 4
                : mode === 0x8000
                  ? 8
                  : mode === 0xa000
                    ? 10
                    : 0;
          }
          result.push({
            name,
            type:
              type === 4
                ? 'directory'
                : type === 8
                  ? 'file'
                  : type === 10
                    ? 'symlink'
                    : 'other',
          });
        }
      } catch (error) {
        closedir(directory);
        throw error;
      }
      if (closedir(directory) < 0) throw nativeError('closedir', koffi.errno());
      return result;
    });
  }

  close(): Promise<void> {
    const next = this.pending.then(async () => {
      if (this.closed) return;
      this.closed = true;
      await invoke(close, [this.fd], 'close');
    });
    this.pending = next.catch(() => {});
    return next;
  }
}

export async function openPosixSourceRoot(
  root: string,
): Promise<NativeSourceDirectory> {
  if (root !== '/') {
    throw Object.assign(new Error('POSIX local source root must be /'), {
      code: 'EINVAL',
    });
  }
  return new PosixSourceDirectory(
    await invoke(open, [root, traversalFlags], 'open root'),
  );
}
