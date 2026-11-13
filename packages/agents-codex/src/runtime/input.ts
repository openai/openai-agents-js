import {
  copyJsonValue,
  checkEncodedCapacity,
  type JsonValue,
  type JsonObject,
} from './binding';
import {
  captureAudio,
  captureFile,
  captureImage,
  mediaRecord,
  MAX_AUDIO_INPUT_BYTES,
  type AudioInputBudget,
} from './media';
import type { FileReference, ImageDetail, NativeToolContent } from './media';

interface CacheablePart {
  readonly promptCacheBreakpoint?: Readonly<{ mode: 'explicit' }>;
}

export function capturePromptCacheBreakpoint(
  value: unknown,
): Readonly<{ mode: 'explicit' }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('promptCacheBreakpoint requires mode explicit');
  const captured = mediaRecord(value);
  if (Object.keys(captured).length !== 1 || captured.mode !== 'explicit')
    throw new TypeError('promptCacheBreakpoint requires mode explicit');
  return Object.freeze({ mode: 'explicit' });
}

export interface InputText extends CacheablePart {
  type: 'input_text';
  text: string;
}
/** Core-owned audio reference; no local file or transport access. */
export interface InputAudio extends CacheablePart {
  type: 'input_audio';
  audio_url: string;
}
/** URL/data URL image. Core owns current-model preparation. */
export interface InputImage extends CacheablePart {
  type: 'input_image';
  image_url: string;
  detail?: ImageDetail | null;
}
/** An opaque provider image ID, never a host path. */
export interface InputImageFile extends CacheablePart {
  type: 'input_image';
  file_id: string;
  detail?: ImageDetail | null;
}
export type InputFile = { type: 'input_file' } & FileReference & CacheablePart;
export interface UserMessage {
  role: 'user';
  content:
    | string
    | readonly (
        InputText | InputImage | InputImageFile | InputFile | InputAudio
      )[];
  type?: 'message';
}
export interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}
export type UserInput = string | UserMessage;

/** Capture complete ordered input before native admission. */
export function nativeInput(
  input: UserInput,
  audioBudget: AudioInputBudget = { remaining: MAX_AUDIO_INPUT_BYTES },
): JsonValue[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  const captured = mediaRecord(input);
  if (
    captured.role !== 'user' ||
    (captured.type !== undefined && captured.type !== 'message') ||
    Object.keys(captured).some(
      (key) => !['role', 'content', 'type'].includes(key),
    )
  )
    throw new TypeError('Only user messages are supported');
  const content = captured.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content) || !content.length)
    throw new TypeError(
      'User message content must be text or non-empty content parts',
    );
  return content.map((value): JsonValue => {
    const part = mediaRecord(value);
    const kind = part.type;
    delete part.type;
    const breakpoint = Object.hasOwn(part, 'promptCacheBreakpoint')
      ? capturePromptCacheBreakpoint(part.promptCacheBreakpoint)
      : undefined;
    delete part.promptCacheBreakpoint;
    const cache =
      breakpoint === undefined ? {} : { prompt_cache_breakpoint: breakpoint };
    if (kind === 'input_text') {
      if (Object.keys(part).length !== 1 || typeof part.text !== 'string')
        throw new TypeError('input_text requires a text string');
      return copyJsonValue({ type: 'text', text: part.text, ...cache });
    }
    if (kind === 'input_audio')
      return copyJsonValue({
        type: 'audio',
        ...captureAudio(part, audioBudget),
        ...cache,
      });
    if (kind === 'input_image')
      return copyJsonValue({ type: 'image', ...captureImage(part), ...cache });
    if (kind === 'input_file')
      return copyJsonValue({ type: 'file', ...captureFile(part), ...cache });
    throw new TypeError('Unsupported user content type');
  });
}

/** Internal data projection after capture/native decoding; no validation, IDs, policy or I/O. */
export function responseContent(
  parts: readonly (JsonValue | NativeToolContent)[],
): JsonValue[] {
  const tags: Record<string, string> = {
    text: 'input_text',
    image: 'input_image',
    file: 'input_file',
    audio: 'input_audio',
    inputText: 'input_text',
    inputImage: 'input_image',
    inputFile: 'input_file',
    inputAudio: 'input_audio',
  };
  return parts.map((value): JsonValue => {
    const part = mediaRecord(value);
    const kind = part.type;
    delete part.type;
    if (typeof kind !== 'string' || !Object.hasOwn(tags, kind))
      throw new TypeError('Unsupported captured content');
    const content =
      kind === 'inputImage'
        ? Object.fromEntries(
            Object.entries(part).map(([key, item]) => [
              key === 'imageUrl'
                ? 'image_url'
                : key === 'fileId'
                  ? 'file_id'
                  : key,
              item,
            ]),
          )
        : kind === 'inputAudio'
          ? Object.fromEntries(
              Object.entries(part).map(([key, item]) => [
                key === 'audioUrl' ? 'audio_url' : key,
                item,
              ]),
            )
          : part;
    const tag = tags[kind];
    const fields: Record<string, readonly string[]> = {
      input_text: ['text'],
      input_audio: ['audio_url'],
      input_image: ['image_url', 'file_id', 'detail'],
      input_file: ['file_id', 'file_data', 'file_url', 'filename'],
    };
    return {
      type: tag,
      ...Object.fromEntries(
        Object.entries(content).filter(
          ([key]) =>
            key === 'prompt_cache_breakpoint' || fields[tag].includes(key),
        ),
      ),
    } as JsonValue;
  });
}

export type { ImageDetail } from './media';

/** Root guardrail projection only; the original Core records remain unchanged. */
export function stagedGuardrailInput(items: readonly JsonObject[]): UserInput {
  const content: JsonValue[] = [];
  for (const item of items) {
    if (
      item.type !== 'message' ||
      item.role !== 'user' ||
      !Array.isArray(item.content) ||
      !item.content.every(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          ['input_text', 'input_image', 'input_file', 'input_audio'].includes(
            String(part.type),
          ),
      )
    )
      return JSON.stringify(items);
    content.push(
      ...item.content.map((part) => {
        const captured = part as JsonObject;
        if (!Object.hasOwn(captured, 'prompt_cache_breakpoint')) return part;
        const { prompt_cache_breakpoint, ...body } = captured;
        return {
          ...body,
          promptCacheBreakpoint: copyJsonValue(prompt_cache_breakpoint),
        };
      }),
    );
  }
  return {
    type: 'message',
    role: 'user',
    content: copyJsonValue(content) as unknown as UserMessage['content'],
  };
}

/** Reuse the operation audio allowance across the canonical staged containers. */
export function validateStagedInputAudio(items: readonly JsonObject[]): void {
  for (const item of items) {
    const parts =
      item.type === 'message'
        ? item.content
        : item.type === 'function_call_output' ||
            item.type === 'custom_tool_call_output'
          ? item.output
          : undefined;
    if (
      Array.isArray(parts) &&
      parts.some(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          part.type === 'input_audio',
      )
    ) {
      checkEncodedCapacity(items, MAX_AUDIO_INPUT_BYTES);
      return;
    }
  }
}
