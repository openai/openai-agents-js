import { Buffer, constants } from 'node:buffer';

const CHUNK_BYTES = 64 * 1024;

/** Read an acquired file without retaining a second copy of its known contents. */
export async function readLocalSourceBuffer(
  size: number | bigint | undefined,
  read: (buffer: Buffer) => Promise<number>,
): Promise<Uint8Array> {
  // Node's fs.readFile uses a signed 32-bit I/O length ceiling even on runtimes
  // whose Buffer API supports larger allocations. Preserve that source limit.
  const maxLength =
    process.release.name === 'node' &&
    !process.versions.bun &&
    !process.versions.deno
      ? Math.min(constants.MAX_LENGTH, 0x7fffffff)
      : constants.MAX_LENGTH;
  if (
    size !== undefined &&
    (size < 0 ||
      size > maxLength ||
      (typeof size === 'number' && !Number.isSafeInteger(size)))
  ) {
    throw Object.assign(new RangeError('Local source file is too large'), {
      code: 'ERR_FS_FILE_TOO_LARGE',
    });
  }
  async function next(buffer: Buffer) {
    const count = await read(buffer);
    if (!Number.isInteger(count) || count < 0 || count > buffer.length) {
      throw Object.assign(new Error('Invalid native source read length'), {
        code: 'EIO',
      });
    }
    return count;
  }
  if (size !== undefined && size > 0) {
    const buffer = Buffer.allocUnsafe(Number(size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = await next(
        buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, buffer.length)),
      );
      if (count === 0) break;
      offset += count;
    }
    // Match readFile's initial-size behavior: ignore later growth, and never
    // return uninitialized bytes if the file shrinks during the read.
    return buffer.subarray(0, offset);
  }
  // Regular pseudo-files can report zero size or reject SEEK_END. Like
  // FileHandle.readFile, those require streaming until the acquired file's EOF.
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const count = await next(buffer);
    if (count === 0) return Buffer.concat(chunks, total);
    if (total + count > constants.MAX_LENGTH) {
      throw Object.assign(new RangeError('Local source file is too large'), {
        code: 'ERR_FS_FILE_TOO_LARGE',
      });
    }
    chunks.push(buffer.subarray(0, count));
    total += count;
  }
}
