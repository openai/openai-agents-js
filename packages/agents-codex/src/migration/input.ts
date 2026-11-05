import type { AgentInputItem } from '@openai/agents-core/types';
import {
  nativeInput,
  type InputImage,
  type InputText,
  type UserInput,
  type UserMessage,
} from '../runtime/input';

function hasOnly(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Validate syntax; Core owns image decoding and preparation. */
export function inlineImageURL(value: unknown): string {
  const match =
    typeof value === 'string'
      ? /^data:image\/[^,]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
      : null;
  if (
    !match ||
    Buffer.from(match[1]!, 'base64').toString('base64') !== match[1]
  )
    throw new TypeError('Migration requires an inline base64 image data URL');
  return value as string;
}

/** Snapshot the supported fresh SDK input before any resource work. */
export function captureInput(
  input: string | readonly AgentInputItem[],
): UserInput {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input) || input.length !== 1)
    throw new TypeError('Migration requires one fresh SDK user message');
  const source = input[0];
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !('role' in source) ||
    source.role !== 'user' ||
    (source.type !== undefined && source.type !== 'message') ||
    !hasOnly(source, ['type', 'role', 'content'])
  )
    throw new TypeError(
      'Migration requires a fresh user message without metadata or references',
    );
  let content: UserMessage['content'];
  if (typeof source.content === 'string') content = source.content;
  else {
    if (!Array.isArray(source.content) || source.content.length === 0)
      throw new TypeError('Migration requires nonempty user content parts');
    const parts: (InputText | InputImage)[] = [];
    for (let index = 0; index < source.content.length; index++) {
      const part = source.content[index];
      if (!part || typeof part !== 'object' || Array.isArray(part))
        throw new TypeError('Migration requires user text or inline images');
      if (part.type === 'input_text' && hasOnly(part, ['type', 'text']))
        parts.push({ type: 'input_text', text: part.text });
      else if (
        part.type === 'input_image' &&
        hasOnly(part, ['type', 'image', 'detail']) &&
        (part.detail === undefined || part.detail === 'auto')
      )
        parts.push({
          type: 'input_image',
          image_url: inlineImageURL(part.image),
          ...(part.detail === undefined ? {} : { detail: part.detail }),
        });
      else
        throw new TypeError(
          'Migration requires user text or default inline images',
        );
    }
    content = parts;
  }
  const captured: UserMessage = { type: 'message', role: 'user', content };
  nativeInput(captured);
  return captured;
}

/** Derive a native carrier from admitted SDK input, separate from Model history. */
export function nativeCarrier(
  input: string | readonly AgentInputItem[],
): UserInput {
  if (typeof input === 'string') return input;
  const last = input.at(-1);
  // The Model bridge replaces this control seed; it is never caller history.
  if (!last || !('role' in last) || last.role !== 'user') return '';
  const content =
    typeof last.content === 'string'
      ? last.content
      : last.content.map((part) => {
          if (part.type === 'input_text')
            return { type: 'input_text' as const, text: part.text };
          if (part.type === 'input_image')
            return {
              type: 'input_image' as const,
              image: part.image,
              ...(part.detail === undefined ? {} : { detail: part.detail }),
            };
          throw new TypeError('Migration requires user text or inline images');
        });
  return captureInput([{ role: 'user', content }]);
}

/** Derive SDK guard input from the validated snapshot, never the caller's data. */
export function sdkInput(captured: UserInput): string | AgentInputItem[] {
  if (typeof captured === 'string') return captured;
  return [
    {
      type: 'message',
      role: 'user',
      content:
        typeof captured.content === 'string'
          ? captured.content
          : captured.content.map((part) =>
              part.type === 'input_text'
                ? { type: 'input_text' as const, text: part.text }
                : {
                    type: 'input_image' as const,
                    image: part.image_url,
                    ...(part.detail === undefined
                      ? {}
                      : { detail: part.detail }),
                  },
            ),
    },
  ];
}

/** Lifecycle and history consumers always receive an SDK item array. */
export function sdkInputItems(captured: UserInput): AgentInputItem[] {
  const input = sdkInput(captured);
  return typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : input;
}
