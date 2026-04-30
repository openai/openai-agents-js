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
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    (bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
    (bytes[0] === 0x4d &&
      bytes[1] === 0x4d &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x2a)
  ) {
    return 'image/tiff';
  }
  if (looksLikeSvg(bytes)) {
    return 'image/svg+xml';
  }
  return mediaTypeFromPath(path);
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

function looksLikeSvg(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .trimStart()
    .toLowerCase();
  return prefix.startsWith('<svg') || /^<\?xml[\s\S]*<svg/u.test(prefix);
}

function mediaTypeFromPath(path?: string): string | null {
  const lowerPath = path?.trim().toLowerCase() ?? '';
  if (lowerPath.endsWith('.png')) {
    return 'image/png';
  }
  if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerPath.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lowerPath.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lowerPath.endsWith('.bmp')) {
    return 'image/bmp';
  }
  if (lowerPath.endsWith('.tif') || lowerPath.endsWith('.tiff')) {
    return 'image/tiff';
  }
  if (lowerPath.endsWith('.svg') || lowerPath.endsWith('.svgz')) {
    return 'image/svg+xml';
  }
  return null;
}
