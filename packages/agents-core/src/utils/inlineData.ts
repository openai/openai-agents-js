import { encodeUint8ArrayToBase64 } from './base64';

export function getInlineMediaType(
  value: Record<string, unknown>,
): string | undefined {
  if (typeof value.mediaType === 'string' && value.mediaType.length > 0) {
    return value.mediaType;
  }
  if (typeof value.mimeType === 'string' && value.mimeType.length > 0) {
    return value.mimeType;
  }
  return undefined;
}

export function formatInlineData(
  data: string | Uint8Array,
  mediaType?: string,
): string {
  if (typeof data === 'string' && data.startsWith('data:')) {
    return data;
  }
  const base64 =
    typeof data === 'string' ? data : encodeUint8ArrayToBase64(data);
  return mediaType ? `data:${mediaType};base64,${base64}` : base64;
}
