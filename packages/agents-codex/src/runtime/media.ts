/** Capture provider-owned media data; never fetch, upload or open a host path. */
import { Buffer } from 'node:buffer';

export type ImageDetail = 'auto' | 'low' | 'high' | 'original';
export type ImageReference = (
  | { image_url: string; file_id?: never }
  | { file_id: string; image_url?: never }
) & { detail?: ImageDetail | null };
export type FileReference = (
  | { file_id: string; file_data?: never; file_url?: never }
  | { file_data: string; file_id?: never; file_url?: never }
  | { file_url: string; file_id?: never; file_data?: never }
) & { filename?: string | null };

export type NativeToolContent =
  | { type: 'inputText'; text: string }
  | ({ type: 'inputImage'; detail?: ImageDetail | null } & (
      | { imageUrl: string; fileId?: never }
      | { fileId: string; imageUrl?: never }
    ))
  | ({ type: 'inputFile' } & FileReference)
  | { type: 'inputAudio'; audioUrl: string };

export function mediaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Media content must be an object');
  return { ...value };
}

function only(data: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(data).some((key) => !keys.includes(key)))
    throw new TypeError('Unsupported media field');
}

function source(value: unknown, file = false): string {
  if (typeof value !== 'string' || !value || (file && !value.trim()))
    throw new TypeError('Media source must be a nonempty string');
  return value;
}

function url(value: string, schemes: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Media URL must be absolute');
  }
  if (!schemes.includes(parsed.protocol) || !parsed.hostname)
    throw new TypeError('Unsupported media URL scheme');
}

// Reuse the native model WebSocket request ceiling before receipt encoding.
export const MAX_AUDIO_INPUT_BYTES = 64 * 1024 * 1024;
export interface AudioInputBudget {
  remaining: number;
}

export function captureAudio(
  value: unknown,
  budget: AudioInputBudget = { remaining: MAX_AUDIO_INPUT_BYTES },
): { audio_url: string } {
  const data = mediaRecord(value);
  only(data, ['audio_url']);
  const audio = source(data.audio_url);
  // Reserve the canonical single-part input envelope as well as the source.
  let bytes = '[{"type":"audio","audio_url":""}]'.length;
  if (audio.length > budget.remaining - bytes)
    throw new RangeError('Audio input exceeds the native request capacity');
  // Bound quoting scratch space; never encode the complete untrusted reference.
  for (let start = 0; start < audio.length;) {
    let end = Math.min(start + 32_768, audio.length);
    const last = audio.charCodeAt(end - 1);
    if (end < audio.length && last >= 0xd800 && last <= 0xdbff) end--;
    bytes +=
      Buffer.byteLength(JSON.stringify(audio.slice(start, end)), 'utf8') - 2;
    if (bytes > budget.remaining)
      throw new RangeError('Audio input exceeds the native request capacity');
    start = end;
  }
  budget.remaining -= bytes;
  return { audio_url: audio };
}

/** Split admitted inline audio without fetching, decoding or sniffing its content. */
export function inlineAudioSource(value: unknown): {
  data: string;
  mediaType: string;
} {
  const reference = source(value);
  const comma = reference.indexOf(',');
  const header = reference.slice(0, comma);
  if (
    comma < 0 ||
    comma === reference.length - 1 ||
    !header.toLowerCase().startsWith('data:audio/') ||
    !header.toLowerCase().endsWith(';base64')
  )
    throw new TypeError('Audio projection requires an inline audio data URL');
  return { mediaType: header.slice(5, -7), data: reference.slice(comma + 1) };
}

export function captureImage(value: unknown): ImageReference {
  const data = mediaRecord(value);
  only(data, ['image_url', 'file_id', 'detail']);
  const keys = ['image_url', 'file_id'].filter((key) =>
    Object.hasOwn(data, key),
  );
  if (keys.length !== 1)
    throw new TypeError('Image requires exactly one image_url or file_id');
  const key = keys[0];
  const captured = source(data[key]);
  if (key === 'image_url') {
    if (captured.startsWith('data:image/')) {
      if (!/^data:image\/[^,]+;base64,.+$/s.test(captured))
        throw new TypeError('Inline image requires a base64 image data URL');
    } else url(captured, ['http:', 'https:']);
  }
  const detail = data.detail;
  if (
    detail != null &&
    (typeof detail !== 'string' ||
      !['auto', 'low', 'high', 'original'].includes(detail))
  )
    throw new TypeError('Unsupported image detail');
  const reference =
    key === 'image_url' ? { image_url: captured } : { file_id: captured };
  return detail == null
    ? reference
    : { ...reference, detail: detail as ImageDetail };
}

export function captureFile(value: unknown): FileReference {
  const data = mediaRecord(value);
  only(data, ['file_id', 'file_data', 'file_url', 'filename']);
  const keys = ['file_id', 'file_data', 'file_url'].filter((key) =>
    Object.hasOwn(data, key),
  );
  if (keys.length !== 1)
    throw new TypeError(
      'File requires exactly one file_id, file_data or file_url',
    );
  const key = keys[0];
  const captured = source(data[key], true);
  if (key === 'file_url') url(captured, ['https:']);
  if (key === 'file_data') {
    let payloadStart = 0;
    if (captured.slice(0, 5).toLowerCase() === 'data:') {
      const comma = captured.indexOf(',');
      if (
        comma < 12 ||
        captured.slice(comma - 7, comma).toLowerCase() !== ';base64'
      )
        throw new TypeError('File data must contain base64 data');
      payloadStart = comma + 1;
    }
    if (payloadStart === captured.length)
      throw new TypeError('File data must contain canonical base64 data');
    // Four-character alignment preserves the existing canonical padded/unpadded contract.
    // Keep decode/re-encode allocations bounded independently of descriptor size.
    const chunkSize = 32_768;
    for (
      let start = payloadStart;
      start < captured.length;
      start += chunkSize
    ) {
      const end = Math.min(start + chunkSize, captured.length);
      const chunk = captured.slice(start, end);
      const canonical = Buffer.from(chunk, 'base64').toString('base64');
      if (
        (end < captured.length && chunk.endsWith('=')) ||
        (chunk !== canonical && chunk !== canonical.replace(/=+$/, ''))
      )
        throw new TypeError('File data must contain canonical base64 data');
    }
  }
  const filename = data.filename;
  if (filename != null && typeof filename !== 'string')
    throw new TypeError('File filename must be a string');
  const reference =
    key === 'file_id'
      ? { file_id: captured }
      : key === 'file_data'
        ? { file_data: captured }
        : { file_url: captured };
  return filename == null ? reference : { ...reference, filename };
}

export function captureToolPart(value: unknown): NativeToolContent {
  const part = mediaRecord(value);
  const kind = part.type;
  delete part.type;
  if (kind === 'inputImage') {
    only(part, ['imageUrl', 'fileId', 'detail']);
    const image = captureImage(
      Object.fromEntries(
        Object.entries(part).map(([key, item]) => [
          key === 'imageUrl' ? 'image_url' : key === 'fileId' ? 'file_id' : key,
          item,
        ]),
      ),
    );
    const native: Extract<NativeToolContent, { type: 'inputImage' }> =
      typeof image.image_url === 'string'
        ? { type: kind, imageUrl: image.image_url }
        : { type: kind, fileId: source(image.file_id) };
    return image.detail == null ? native : { ...native, detail: image.detail };
  }
  if (kind === 'inputFile') return { type: kind, ...captureFile(part) };
  if (
    kind === 'inputText' &&
    Object.keys(part).length === 1 &&
    typeof part.text === 'string'
  )
    return { type: kind, text: part.text };
  if (
    kind === 'inputAudio' &&
    Object.keys(part).length === 1 &&
    typeof part.audioUrl === 'string'
  )
    return { type: kind, audioUrl: part.audioUrl };
  throw new TypeError('Unsupported tool content');
}
