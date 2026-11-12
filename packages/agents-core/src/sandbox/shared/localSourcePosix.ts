import { Buffer } from 'node:buffer';
import koffi from 'koffi';
import { readLocalSourceBuffer } from './localSourceBuffer';
import { callLocalSourceNative } from './localSourceNativeCall';
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
const fdopendir = darwin
  ? libc.func(`fdopendir${inodeSuffix}`, 'void *', ['int'])
  : undefined;
const closedir = darwin
  ? libc.func('int closedir(void *directory)')
  : undefined;
const readdir = darwin
  ? libc.func(`readdir_r${inodeSuffix}`, 'int', [
      'void *',
      koffi.out('void *'),
      koffi.out(koffi.pointer('void *')),
    ])
  : undefined;

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
    statName,
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

const seek = (() => {
  if (!darwin) {
    try {
      return libc.func('int64_t lseek64(int fd, int64_t offset, int whence)');
    } catch {
      // musl 1.2.4 removed this alias; its off_t is still 64-bit on every CPU.
      // A bare 32-bit glibc lseek would have a different ABI.
      if (
        (process.arch === 'arm' || process.arch === 'ia32') &&
        metadata.statName !== '__fstat_time64'
      )
        throw new Error('No native 64-bit seek ABI');
    }
  }
  return libc.func('int64_t lseek(int fd, int64_t offset, int whence)');
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
const getdentsSyscalls: Partial<Record<NodeJS.Architecture, number>> = {
  x64: 217,
  arm64: 61,
  arm: 217,
  ia32: 220,
  ppc64: 202,
  riscv64: 61,
  loong64: 61,
};
const getdents = darwin
  ? undefined
  : libc.func('syscall', 'long', [
      'long',
      'long',
      koffi.out('void *'),
      'unsigned long',
      'long',
      'long',
      'long',
    ]);

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
    // All arguments use native-width integer/pointer registers; fixed signatures
    // allow Koffi workers without its synchronous-only variadic-call path.
    const number = statxSyscalls[process.arch];
    if (number === undefined) throw new Error('Unknown Linux statx syscall');
    syscall ??= libc.func('syscall', 'long', [
      'long',
      'long',
      'str',
      'long',
      'unsigned long',
      koffi.out('void *'),
      'long',
    ]);
    await invoke(
      syscall,
      [number, fd, name ?? '', flags, 1, output, 0],
      'statx',
    );
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

async function invoke<T extends number | bigint = number>(
  fn: NativeFunction,
  args: unknown[],
  operation: string,
): Promise<T> {
  const { value, errno } = await callLocalSourceNative<T>(fn, args);
  if (value < 0) throw nativeError(operation, errno);
  return value;
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

  async readFile(name: string, maxBytes?: number): Promise<Uint8Array> {
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
      let size: number | bigint | undefined;
      try {
        size = await invoke<number | bigint>(seek, [fd, 0, 2], 'lseek size');
      } catch {
        // Regular pseudo-files may reject SEEK_END. Their acquired handle can
        // still be read to EOF without inventing a size or changing authority.
      }
      if (size !== undefined) await invoke(seek, [fd, 0, 0], 'lseek rewind');
      contents = await readLocalSourceBuffer(
        size,
        async (buffer) => {
          for (;;) {
            try {
              return await invoke(read, [fd, buffer, buffer.length], 'read');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EINTR')
                throw error;
            }
          }
        },
        maxBytes,
      );
    } catch (error) {
      await invoke(close, [fd], 'close').catch(() => {});
      throw error;
    }
    // Never retry close: on Linux an EINTR may already have released the fd.
    await invoke(close, [fd], 'close');
    return contents;
  }

  entries(maxEntries?: number): Promise<NativeSourceEntry[]> {
    return this.run(async () => {
      // The literal '.' reopens the held directory, never an untrusted path.
      // A fresh read handle also gives each enumeration its own stream offset.
      const duplicate = await invoke(
        openat,
        [this.fd, '.', directoryFlags],
        'openat enumeration',
      );
      const result: NativeSourceEntry[] = [];
      const append = async (bytes: Buffer, offset: number) => {
        const recordLength = koffi.decode(
          bytes,
          offset + 16,
          'uint16_t',
        ) as number;
        const nameOffset = offset + (darwin ? 21 : 19);
        if (
          recordLength <= nameOffset - offset ||
          offset + recordLength > bytes.length
        ) {
          throw nativeError('directory record', koffi.os.errno.EIO);
        }
        const inode = koffi.decode(bytes, offset, 'uint64_t');
        if (inode === 0 || inode === 0n) return recordLength;
        const end = bytes.indexOf(0, nameOffset);
        if (end < 0 || end >= offset + recordLength) {
          throw nativeError('directory name', koffi.os.errno.EIO);
        }
        const name = bytes.toString('utf8', nameOffset, end);
        if (name === '.' || name === '..') return recordLength;
        validateName(name);
        let type = bytes[offset + (darwin ? 20 : 18)];
        if (type === 0) {
          // d_type may be unavailable. This lookup never follows a symlink;
          // actual acquisition separately uses the retained handle + nofollow.
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
        if (maxEntries !== undefined && result.length >= maxEntries)
          throw new RangeError('Local source member limit exceeded');
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
        return recordLength;
      };
      if (fdopendir && readdir && closedir) {
        const { value: directory, errno } =
          await callLocalSourceNative<unknown>(fdopendir, [duplicate]);
        if (!directory) {
          await invoke(close, [duplicate], 'close').catch(() => {});
          throw nativeError('fdopendir', errno);
        }
        try {
          // Apple's public readdir_r handles errno and libc's union/whiteout
          // filtering on the worker. Its copy length uses uint16 d_namlen:
          // align4(21 + 65535 + 1) = 65560, independent of NAME_MAX.
          const buffer = Buffer.alloc(65560);
          for (;;) {
            const output: unknown[] = [null];
            const { value: status } = await callLocalSourceNative<number>(
              readdir,
              [directory, buffer, output],
            );
            if (status !== 0) throw nativeError('readdir_r', status);
            if (!output[0]) break;
            await append(buffer, 0);
          }
        } catch (error) {
          await invoke(closedir, [directory], 'closedir').catch(() => {});
          throw error;
        }
        await invoke(closedir, [directory], 'closedir');
        return result;
      }
      try {
        const number = getdentsSyscalls[process.arch];
        if (!getdents || number === undefined)
          throw nativeError('getdents64 ABI', koffi.os.errno.ENOSYS);
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          let length: number;
          try {
            length = Number(
              await invoke(
                getdents,
                [number, duplicate, buffer, buffer.length, 0, 0, 0],
                'getdents64',
              ),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
            throw error;
          }
          if (length === 0) break;
          if (!Number.isInteger(length) || length < 0 || length > buffer.length)
            throw nativeError('getdents64 length', koffi.os.errno.EIO);
          const bytes = buffer.subarray(0, length);
          for (let offset = 0; offset < length;) {
            if (offset + 19 >= length)
              throw nativeError('getdents64 record', koffi.os.errno.EIO);
            offset += await append(bytes, offset);
          }
        }
      } catch (error) {
        await invoke(close, [duplicate], 'close').catch(() => {});
        throw error;
      }
      await invoke(close, [duplicate], 'close');
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
