import { UserError } from '../../errors';
import type { ToolOutputImage } from '../../types/protocol';

export const MAX_VIEW_IMAGE_BYTES = 10 * 1024 * 1024;

export function assertViewImageByteLength(path: string, byteLength: number) {
  if (byteLength > MAX_VIEW_IMAGE_BYTES) {
    throw new UserError(`Image file exceeds the 10 MB limit: ${path}`);
  }
}

export function imageOutputFromBytes(
  path: string,
  bytes: Uint8Array,
): ToolOutputImage {
  assertViewImageByteLength(path, bytes.byteLength);
  const mediaType = sniffImageMediaType(bytes, path);
  if (!mediaType) {
    throw new UserError(`Unsupported image format for view_image: ${path}`);
  }
  return {
    type: 'image',
    image: {
      data: Uint8Array.from(bytes),
      mediaType,
    },
  };
}

export function sniffImageMediaType(
  bytes: Uint8Array,
  path?: string,
): string | null {
  if (
    matchesBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return 'image/png';
  }
  if (matchesBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (matchesAscii(bytes, 0, 'GIF87a') || matchesAscii(bytes, 0, 'GIF89a')) {
    return 'image/gif';
  }
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP')) {
    return 'image/webp';
  }
  if (matchesAscii(bytes, 0, 'BM')) {
    return 'image/bmp';
  }
  if (
    matchesBytes(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) ||
    matchesBytes(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a]) ||
    matchesBytes(bytes, 0, [0x49, 0x49, 0x2b, 0x00]) ||
    matchesBytes(bytes, 0, [0x4d, 0x4d, 0x00, 0x2b])
  ) {
    return 'image/tiff';
  }
  if (looksLikeSvg(bytes)) {
    return 'image/svg+xml';
  }
  return svgMediaTypeFromPath(path);
}

export async function toUint8Array(
  value:
    | Blob
    | Uint8Array
    | ArrayBuffer
    | ArrayBufferView
    | string
    | null
    | undefined,
): Promise<Uint8Array> {
  if (!value) {
    return new Uint8Array();
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  return Uint8Array.from(value as unknown as ArrayLike<number>);
}

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  expected: string,
): boolean {
  return matchesBytes(
    bytes,
    offset,
    Array.from(expected, (character) => character.charCodeAt(0)),
  );
}

function matchesBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) {
    return false;
  }
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .trimStart()
    .toLowerCase();
  return prefix.startsWith('<svg') || /^<\?xml[\s\S]*<svg/u.test(prefix);
}

function svgMediaTypeFromPath(path?: string): string | null {
  const lowerPath = path?.trim().toLowerCase() ?? '';
  if (lowerPath.endsWith('.svg') || lowerPath.endsWith('.svgz')) {
    return 'image/svg+xml';
  }
  return null;
}
