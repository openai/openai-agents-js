import { Buffer } from 'node:buffer';
import koffi from 'koffi';
import { readLocalSourceBuffer } from './localSourceBuffer';
import { callLocalSourceNative } from './localSourceNativeCall';
import type {
  NativeSourceDirectory,
  NativeSourceEntry,
} from './localSourceTypes';

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_DEVICE = 0x40;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const CHUNK_BYTES = 64 * 1024;

function sourceError(
  code: string,
  syscall: string,
  nativeCode?: number,
): Error {
  return Object.assign(new Error(`${code}: ${syscall}`), {
    code,
    syscall,
    ...(nativeCode === undefined ? {} : { errno: nativeCode }),
  });
}

function windowsError(code: number, syscall: string): Error {
  const names: Record<number, string> = {
    1: 'ENOSYS',
    2: 'ENOENT',
    3: 'ENOENT',
    5: 'EACCES',
    6: 'EBADF',
    8: 'ENOMEM',
    14: 'ENOMEM',
    15: 'ENOENT',
    17: 'EXDEV',
    19: 'EROFS',
    20: 'ENODEV',
    21: 'EBUSY',
    32: 'EBUSY',
    33: 'EBUSY',
    50: 'ENOTSUP',
    80: 'EEXIST',
    87: 'EINVAL',
    109: 'EPIPE',
    112: 'ENOSPC',
    123: 'EINVAL',
    145: 'ENOTEMPTY',
    183: 'EEXIST',
    206: 'ENAMETOOLONG',
    267: 'ENOTDIR',
    995: 'ECANCELED',
    1314: 'EPERM',
    1920: 'ELOOP',
    4392: 'ELOOP',
    4393: 'ELOOP',
  };
  return sourceError(names[code] ?? 'EIO', syscall, code);
}

function validateName(name: string): void {
  // NtCreateFile receives exactly one component. In particular, ':' would
  // select an alternate data stream and '\\' would introduce another lookup.
  if (!name || name === '.' || name === '..' || /[\\/\0:]/u.test(name)) {
    throw sourceError('EINVAL', 'open local source component');
  }
  if (Buffer.byteLength(name, 'utf16le') > 0xfffc) {
    throw sourceError('ENAMETOOLONG', 'open local source component');
  }
}

function createBindings() {
  const nt = koffi.load('ntdll.dll');
  const kernel = koffi.load('kernel32.dll');
  const unicodeString = koffi.struct({
    Length: 'uint16_t',
    MaximumLength: 'uint16_t',
    Buffer: 'void *',
  });
  const objectAttributes = koffi.struct({
    Length: 'uint32_t',
    RootDirectory: 'void *',
    ObjectName: koffi.pointer(unicodeString),
    Attributes: 'uint32_t',
    SecurityDescriptor: 'void *',
    SecurityQualityOfService: 'void *',
  });
  const ioStatusBlock = koffi.struct({
    // The first member is the pointer-sized union { NTSTATUS Status; PVOID Pointer; }.
    Status: 'uintptr_t',
    Information: 'uintptr_t',
  });

  // Windows LLP64 ABI: UNICODE_STRING / OBJECT_ATTRIBUTES / IO_STATUS_BLOCK
  // are 16/48/16 bytes on x64 and arm64, and 8/24/8 on x86. Koffi supplies
  // native pointer alignment; assert sizes AND pointer offsets before any call.
  // https://learn.microsoft.com/windows/win32/api/ntdef/ns-ntdef-_unicode_string
  // https://learn.microsoft.com/windows/win32/api/ntdef/ns-ntdef-_object_attributes
  // https://learn.microsoft.com/windows-hardware/drivers/ddi/wdm/ns-wdm-_io_status_block
  const pointerBytes = koffi.sizeof('void *');
  if (
    ![4, 8].includes(pointerBytes) ||
    koffi.sizeof(unicodeString) !== pointerBytes * 2 ||
    koffi.offsetof(unicodeString, 'Buffer') !== pointerBytes ||
    koffi.sizeof(objectAttributes) !== pointerBytes * 6 ||
    koffi.offsetof(objectAttributes, 'RootDirectory') !== pointerBytes ||
    koffi.offsetof(objectAttributes, 'ObjectName') !== pointerBytes * 2 ||
    koffi.offsetof(objectAttributes, 'SecurityDescriptor') !==
      pointerBytes * 4 ||
    koffi.sizeof(ioStatusBlock) !== pointerBytes * 2 ||
    koffi.offsetof(ioStatusBlock, 'Information') !== pointerBytes
  ) {
    throw sourceError('ENOTSUP', 'Windows local source ABI');
  }

  const ntCreateFile = nt.func('__stdcall', 'NtCreateFile', 'int32_t', [
    koffi.out(koffi.pointer('void *')),
    'uint32_t',
    koffi.pointer(objectAttributes),
    koffi.out(koffi.pointer(ioStatusBlock)),
    'void *',
    'uint32_t',
    'uint32_t',
    'uint32_t',
    'uint32_t',
    'void *',
    'uint32_t',
  ]);
  const statusToError = nt.func(
    'uint32_t __stdcall RtlNtStatusToDosError(int32_t status)',
  );
  const queryInfo = nt.func('__stdcall', 'NtQueryInformationFile', 'int32_t', [
    'void *',
    koffi.out(koffi.pointer(ioStatusBlock)),
    koffi.out('void *'),
    'uint32_t',
    'int32_t',
  ]);
  const queryDirectory = nt.func(
    '__stdcall',
    'NtQueryDirectoryFile',
    'int32_t',
    [
      'void *',
      'void *',
      'void *',
      'void *',
      koffi.out(koffi.pointer(ioStatusBlock)),
      koffi.out('void *'),
      'uint32_t',
      'int32_t',
      'uint8_t',
      'void *',
      'uint8_t',
    ],
  );
  const getFileType = kernel.func(
    'uint32_t __stdcall GetFileType(void *handle)',
  );
  const readFile = nt.func('__stdcall', 'NtReadFile', 'int32_t', [
    'void *',
    'void *',
    'void *',
    'void *',
    koffi.out(koffi.pointer(ioStatusBlock)),
    koffi.out('void *'),
    'uint32_t',
    'void *',
    'void *',
  ]);
  const closeHandle = nt.func('int32_t __stdcall NtClose(void *handle)');

  async function call(fn: typeof closeHandle, args: unknown[]) {
    const { value } = await callLocalSourceNative<number>(fn, args);
    // Every acquired handle uses FILE_SYNCHRONOUS_IO_NONALERT. The I/O manager
    // completes the operation before the worker returns, including its outputs.
    if (value === 0x103)
      throw sourceError('EIO', 'unexpected pending source I/O');
    return value;
  }

  function checkStatus(status: number, operation: string): void {
    if (status < 0) throw windowsError(statusToError(status), operation);
  }

  function bytesWritten(
    status: { Information?: number | bigint },
    size: number,
  ) {
    const bytes = Number(status.Information);
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > size) {
      throw sourceError('EIO', 'invalid Windows I/O length');
    }
    return bytes;
  }

  async function open(
    parent: unknown,
    name: string,
    directory: boolean,
    enumerate = false,
  ) {
    const encoded = Buffer.from(`${name}\0`, 'utf16le');
    const out: unknown[] = [null];
    const attributes = {
      Length: koffi.sizeof(objectAttributes),
      RootDirectory: parent,
      ObjectName: {
        Length: encoded.length - 2,
        MaximumLength: encoded.length,
        Buffer: encoded,
      },
      Attributes: 0x40, // OBJ_CASE_INSENSITIVE; no inheritance or privilege bypass.
      SecurityDescriptor: null,
      SecurityQualityOfService: null,
    };
    // RootDirectory + a SINGLE component binds lookup to the retained parent.
    // FILE_OPEN_REPARSE_POINT opens the reparse object itself; reject it below.
    // No DIRECTORY/NON_DIRECTORY option: inspect reparse attributes before type.
    // https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntcreatefile
    const status = await call(ntCreateFile, [
      out,
      // Ancestors only need traversal, not permission to list their contents.
      // Source directories explicitly request LIST_DIRECTORY; files request READ_DATA.
      0x100080 | (directory ? 0x20 | (enumerate ? 1 : 0) : 1),
      attributes,
      {},
      null,
      0,
      7, // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
      1, // FILE_OPEN: never create or truncate.
      0x200020, // FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
      null,
      0,
    ]);
    checkStatus(status, 'NtCreateFile');
    const handle = out[0];
    try {
      await checkType(handle, directory);
      return handle;
    } catch (error) {
      await close(handle).catch(() => {});
      throw error;
    }
  }

  async function checkType(handle: unknown, directory: boolean): Promise<void> {
    const info = Buffer.alloc(8); // FILE_ATTRIBUTE_TAG_INFORMATION: two DWORDs.
    checkStatus(
      await call(queryInfo, [handle, {}, info, info.length, 35]),
      'NtQueryInformationFile attributes',
    );
    const attributes = info.readUInt32LE(0);
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      throw sourceError('ELOOP', 'open local source reparse point');
    }
    const { value: type } = await callLocalSourceNative<number>(getFileType, [
      handle,
    ]);
    if (type === 0) {
      // GetLastError is thread-local and cannot be retrieved after this worker
      // call. Unknown type and query failure both reject the source safely.
      throw sourceError('EIO', 'GetFileType');
    }
    if (type !== 1 || attributes & FILE_ATTRIBUTE_DEVICE) {
      throw sourceError('EINVAL', 'open non-disk local source');
    }
    if (Boolean(attributes & FILE_ATTRIBUTE_DIRECTORY) !== directory) {
      throw sourceError(directory ? 'ENOTDIR' : 'EISDIR', 'open local source');
    }
  }

  async function close(handle: unknown): Promise<void> {
    checkStatus(await call(closeHandle, [handle]), 'NtClose');
  }

  async function read(handle: unknown, maxBytes?: number): Promise<Uint8Array> {
    await checkType(handle, false);
    const info = Buffer.alloc(24); // FILE_STANDARD_INFORMATION; EndOfFile at 8.
    checkStatus(
      await call(queryInfo, [handle, {}, info, info.length, 5]),
      'NtQueryInformationFile size',
    );
    return readLocalSourceBuffer(
      info.readBigInt64LE(8),
      async (buffer) => {
        const output: { Information?: number | bigint } = {};
        const status = await call(readFile, [
          handle,
          null,
          null,
          null,
          output,
          buffer,
          buffer.length,
          null,
          null,
        ]);
        if (status >>> 0 === 0xc0000011) return 0; // STATUS_END_OF_FILE
        checkStatus(status, 'NtReadFile');
        return bytesWritten(output, buffer.length);
      },
      maxBytes,
    );
  }

  async function entries(
    handle: unknown,
    maxEntries?: number,
  ): Promise<NativeSourceEntry[]> {
    await checkType(handle, true);
    const result: NativeSourceEntry[] = [];
    let restart = true;
    let capacity = CHUNK_BYTES;
    for (;;) {
      const buffer = Buffer.alloc(capacity);
      const output: { Information?: number | bigint } = {};
      const status = await call(queryDirectory, [
        handle,
        null,
        null,
        null,
        output,
        buffer,
        buffer.length,
        37,
        0,
        null,
        restart ? 1 : 0,
      ]);
      if (status >>> 0 === 0x80000006) return result; // STATUS_NO_MORE_FILES
      const overflow = status >>> 0 === 0x80000005;
      if (!overflow) checkStatus(status, 'NtQueryDirectoryFile');
      const bytes = overflow ? 0 : bytesWritten(output, buffer.length);
      if (overflow || bytes === 0) {
        if (capacity >= CHUNK_BYTES * 2) {
          throw sourceError('EIO', 'Windows directory record exceeds buffer');
        }
        capacity *= 2;
        if (overflow) {
          // A first-call overflow can contain a truncated record. Restart with
          // room for the complete record, never parse or silently skip it.
          restart = true;
          result.length = 0;
        }
        continue;
      }
      restart = false;
      // FILE_ID_BOTH_DIR_INFO has no pointers. Windows SDK's 8-byte alignment
      // places FileAttributes at 56, FileNameLength at 60, FileId at 96 and
      // FileName at 104 on x86, x64 and arm64 (including ShortName padding).
      // https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info
      let offset = 0;
      for (;;) {
        if (offset + 104 > bytes) {
          throw sourceError('EIO', 'invalid Windows directory record');
        }
        const next = buffer.readUInt32LE(offset);
        const attributes = buffer.readUInt32LE(offset + 56);
        const length = buffer.readUInt32LE(offset + 60);
        const end = offset + 104 + length;
        if (
          length % 2 !== 0 ||
          end > bytes ||
          (next !== 0 &&
            (next % 8 !== 0 || next < 104 + length || offset + next >= bytes))
        ) {
          throw sourceError('EIO', 'invalid Windows directory record');
        }
        const name = buffer.toString('utf16le', offset + 104, end);
        if (name !== '.' && name !== '..') {
          validateName(name);
          if (maxEntries !== undefined && result.length >= maxEntries)
            throw new RangeError('Local source member limit exceeded');
          result.push({
            name,
            type:
              attributes & FILE_ATTRIBUTE_REPARSE_POINT
                ? 'symlink'
                : attributes & FILE_ATTRIBUTE_DEVICE
                  ? 'other'
                  : attributes & FILE_ATTRIBUTE_DIRECTORY
                    ? 'directory'
                    : 'file',
          });
        }
        if (next === 0) break;
        offset += next;
      }
    }
  }

  return { open, close, read, entries };
}

let bindings: ReturnType<typeof createBindings> | undefined;

function directoryHandle(
  native: ReturnType<typeof createBindings>,
  handle: unknown,
): NativeSourceDirectory {
  // Serialize each handle's enumeration cursor and retain it until in-flight
  // opens/reads finish. Different directory handles can operate concurrently.
  let pending: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closing)
      return Promise.reject(sourceError('EBADF', 'local source directory'));
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  return {
    openDirectory(name, enumerate = false) {
      return run(async () => {
        validateName(name);
        return directoryHandle(
          native,
          await native.open(handle, name, true, enumerate),
        );
      });
    },
    async readFile(name, maxBytes) {
      const file = await run(async () => {
        validateName(name);
        return native.open(handle, name, false);
      });
      // Once opened, the child owns its independent handle. Release the parent
      // queue so configured concurrent file reads remain concurrent.
      let bytes: Uint8Array;
      try {
        bytes = await native.read(file, maxBytes);
      } catch (error) {
        try {
          await native.close(file);
        } catch {
          // Preserve the read error if cleanup also fails.
        }
        throw error;
      }
      await native.close(file);
      return bytes;
    },
    entries(maxEntries) {
      return run(() => native.entries(handle, maxEntries));
    },
    close() {
      closing ??= pending.then(() => native.close(handle));
      return closing;
    },
  };
}

export async function openWindowsSourceRoot(
  root: string,
  enumerate = false,
): Promise<NativeSourceDirectory> {
  if (!/^[A-Za-z]:\\$/u.test(root)) {
    throw sourceError('EINVAL', 'open Windows local source drive root');
  }
  bindings ??= createBindings();
  // Only the validated drive root uses an absolute NT name. All untrusted
  // descendants are resolved by single-component opens against held handles.
  return directoryHandle(
    bindings,
    await bindings.open(null, `\\??\\${root}`, true, enumerate),
  );
}
