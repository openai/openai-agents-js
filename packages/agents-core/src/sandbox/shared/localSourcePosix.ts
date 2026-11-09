import { Buffer } from 'node:buffer';
import koffi from 'koffi';
import type {
  NativeSourceDirectory,
  NativeSourceEntry,
} from './localSourceTypes';

const darwin = process.platform === 'darwin';

function nativeOpenFlags() {
  // These values cross directly into libc. Compatibility shims are not an ABI
  // authority: Deno 2.3.5 reports Darwin flags even when running on Linux.
  if (darwin && (process.arch === 'x64' || process.arch === 'arm64')) {
    return { directory: 0x100000, nofollow: 0x100, nonblock: 0x4 };
  }
  if (process.platform === 'linux') {
    switch (process.arch) {
      // ARM and PowerPC retain their architecture-specific Linux UAPI bits.
      case 'arm':
      case 'arm64':
      case 'ppc64':
        return { directory: 0x4000, nofollow: 0x8000, nonblock: 0x800 };
      // These ABIs use asm-generic/fcntl.h without these flag overrides.
      case 'x64':
      case 'ia32':
      case 'riscv64':
      case 'loong64':
        return { directory: 0x10000, nofollow: 0x20000, nonblock: 0x800 };
    }
  }
  throw new Error(
    `Native local sources do not support ${process.platform}/${process.arch}`,
  );
}

const libc = koffi.load(darwin ? '/usr/lib/libSystem.B.dylib' : null);
// Descriptor operations stay in libc; Deno's Node descriptors are virtual.
const openFlags = {
  ...nativeOpenFlags(),
  cloexec: darwin ? 0x1000000 : 0x80000,
};
const directoryFlags =
  openFlags.directory | openFlags.nofollow | openFlags.cloexec;
// Linux O_PATH and macOS 13+ O_SEARCH do not require directory read access.
// macOS 11/12 ignore O_SEARCH and require readable ancestor directories.
const traversalFlags = directoryFlags | (darwin ? 0x40000000 : 0x200000);
const open = libc.func('int open(const char *path, int flags)');
const openat = libc.func('int openat(int fd, const char *path, int flags)');
const close = libc.func('int close(int fd)');
const read = libc.func(
  'intptr_t read(int fd, _Out_ uint8_t *buffer, size_t size)',
);
// Darwin x64 retains legacy inode32 symbols. The stream constructor, reader and
// metadata functions must all select the current inode64 ABI.
const inodeSuffix = darwin && process.arch === 'x64' ? '$INODE64' : '';
const fdopendir = libc.func(`fdopendir${inodeSuffix}`, 'void *', ['int']);
const closedir = libc.func('int closedir(void *directory)');
const readdir = darwin
  ? libc.func(`readdir${inodeSuffix}`, 'void *', ['void *'])
  : (() => {
      try {
        // glibc's large-file ABI preserves inode/offset widths on 32-bit CPUs.
        return libc.func('void *readdir64(void *directory)');
      } catch {
        // musl already uses 64-bit inode/offset fields and removed this alias.
        return libc.func('void *readdir(void *directory)');
      }
    })();

const timespec = koffi.struct({ seconds: 'int64_t', nanoseconds: 'int64_t' });
// Darwin's inode64 layout is shared by both supported CPUs.
const darwinStatType = koffi.struct({
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
});

function bindMetadata(statName: string, statAtName: string, version?: number) {
  const prefix = version === undefined ? [] : ['int'];
  const output = koffi.out(koffi.pointer(darwin ? darwinStatType : 'uint8_t'));
  return {
    stat: libc.func(statName, 'int', [...prefix, 'int', output]),
    statAt: libc.func(statAtName, 'int', [
      ...prefix,
      'int',
      'str',
      output,
      'int',
    ]),
    version,
  };
}

const metadata = (() => {
  if (darwin)
    return bindMetadata(`fstat${inodeSuffix}`, `fstatat${inodeSuffix}`);
  const candidates: [string, string, number?][] = [];
  if (process.arch === 'arm' || process.arch === 'ia32') {
    // Preserve large timestamps on the 32-bit glibc and musl time64 ABIs.
    candidates.push(
      ['__fstat64_time64', '__fstatat64_time64'],
      ['__fstat_time64', '__fstatat_time64'],
    );
  }
  candidates.push(
    ['fstat64', 'fstatat64'],
    // Before glibc 2.33 these public functions were inline versioned calls.
    [
      '__fxstat64',
      '__fxstatat64',
      process.arch === 'x64'
        ? 1
        : process.arch === 'arm' || process.arch === 'ia32'
          ? 3
          : 0,
    ],
    ['fstat', 'fstatat'],
  );
  for (const candidate of candidates) {
    try {
      return bindMetadata(...candidate);
    } catch {
      // Symbol availability differs between glibc releases and musl.
    }
  }
  throw new Error('Native local sources require POSIX stat functions');
})();

const statx = (() => {
  if (darwin) return undefined;
  try {
    return libc.func(
      'int statx(int fd, const char *path, int flags, unsigned int mask, _Out_ uint8_t *buffer)',
    );
  } catch {
    // Available since glibc 2.28 and musl 1.2.5, not our minimum libc floor.
    return undefined;
  }
})();

const statxSyscalls: Partial<Record<NodeJS.Architecture, number>> = {
  x64: 332,
  arm64: 291,
  arm: 397,
  ia32: 383,
  ppc64: 383,
  riscv64: 291,
  loong64: 291,
};
let syscall: ReturnType<typeof libc.func> | undefined;

async function statxMode(
  fd: number,
  name: string | undefined,
  output: Buffer,
  raw = false,
): Promise<number> {
  // AT_EMPTY_PATH binds an already-open file; AT_SYMLINK_NOFOLLOW binds names.
  // DONT_SYNC is sufficient because the inode's file type cannot change.
  const flags = 0x100 | 0x4000 | (name === undefined ? 0x1000 : 0);
  if (!raw && statx) {
    await invoke(statx, [fd, name ?? '', flags, 1, output], 'statx');
  } else {
    // Legacy 32-bit libc can overflow on timestamps beyond 2038 even when the
    // kernel supports statx. Koffi variadic calls are synchronous, so this
    // bounded metadata recovery is used only after that overflow, not reads.
    const number = statxSyscalls[process.arch];
    if (number === undefined) throw new Error('Unknown Linux statx syscall');
    syscall ??= libc.func('long syscall(long number, ...)');
    const result = syscall(
      number,
      'long',
      fd,
      'str',
      name ?? '',
      'long',
      flags,
      'unsigned long',
      1,
      'void *',
      output,
      'long',
      0,
    );
    const errno = koffi.errno();
    if (result < 0) throw nativeError('statx', errno);
  }
  if (((koffi.decode(output, 0, 'uint32_t') as number) & 1) === 0) {
    throw nativeError('statx mode', koffi.os.errno.EIO);
  }
  return koffi.decode(output, 28, 'uint16_t') as number;
}

async function statMode(fd: number, name?: string): Promise<number> {
  // Only the mode prefix is decoded. All audited Linux stat64/time64 outputs
  // fit in 256 bytes (largest: ARM musl time64, 152 bytes). Their mode is at
  // byte 24 on x64/ppc64le and byte 16 on arm64/arm/ia32/riscv64/loong64.
  // This avoids depending on libc-specific trailing timestamps and padding.
  const output: Buffer | { mode?: number } = darwin ? {} : Buffer.alloc(256);
  if (Buffer.isBuffer(output) && statx) {
    try {
      return await statxMode(fd, name, output);
    } catch (error) {
      // Match libuv's fallbacks for old kernels, seccomp and DVS filesystems.
      if (
        !['EINVAL', 'EPERM', 'ENOSYS', 'EOPNOTSUPP'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        throw error;
      }
    }
  }
  const args =
    name === undefined
      ? [fd, output]
      : [fd, name, output, darwin ? 0x20 : 0x100];
  if (metadata.version !== undefined) args.unshift(metadata.version);
  try {
    await invoke(
      name === undefined ? metadata.stat : metadata.statAt,
      args,
      name === undefined ? 'fstat' : 'fstatat',
    );
  } catch (error) {
    if (
      Buffer.isBuffer(output) &&
      (error as NodeJS.ErrnoException).code === 'EOVERFLOW'
    ) {
      try {
        return await statxMode(fd, name, output, true);
      } catch (recoveryError) {
        if (
          ['EINVAL', 'EPERM', 'ENOSYS', 'EOPNOTSUPP'].includes(
            (recoveryError as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          throw error;
        }
        throw recoveryError;
      }
    }
    throw error;
  }
  return Buffer.isBuffer(output)
    ? (koffi.decode(
        output,
        process.arch === 'x64' || process.arch === 'ppc64' ? 24 : 16,
        'uint32_t',
      ) as number)
    : (output.mode ?? 0);
}

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
          let mode: number;
          try {
            mode = await statMode(this.fd, name);
          } catch {
            throw error;
          }
          if ((mode & 0xf000) === 0xa000) {
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
      if (((await statMode(fd)) & 0xf000) !== 0x8000) {
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
            const mode = (await statMode(this.fd, name)) & 0xf000;
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
