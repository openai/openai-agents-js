import type { JsonValue } from './binding';

export interface InputText {
  type: 'input_text';
  text: string;
}

/** Inline base64 image; Core owns decoding and model-specific preparation. */
export interface InputImage {
  type: 'input_image';
  image_url: string;
  detail?: 'auto';
}

export interface UserMessage {
  role: 'user';
  content: string | readonly (InputText | InputImage)[];
  type?: 'message';
}

export interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type UserInput = string | UserMessage;

function hasOnly(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Capture and validate the complete input before native admission. */
export function nativeInput(input: UserInput): JsonValue[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Input must be text or a user message');
  if (
    input.role !== 'user' ||
    (input.type !== undefined && input.type !== 'message') ||
    !hasOnly(input, ['role', 'content', 'type'])
  )
    throw new TypeError('Only user messages are supported');
  if (typeof input.content === 'string')
    return [{ type: 'text', text: input.content }];
  if (!Array.isArray(input.content) || input.content.length === 0)
    throw new TypeError(
      'User message content must be text or non-empty content parts',
    );
  return input.content.map((part: InputText | InputImage): JsonValue => {
    if (!part || typeof part !== 'object')
      throw new TypeError(
        'User message parts must be input_text or input_image',
      );
    if (part.type === 'input_text') {
      if (typeof part.text !== 'string' || !hasOnly(part, ['type', 'text']))
        throw new TypeError('input_text requires a text string');
      return { type: 'text', text: part.text };
    }
    if (part.type === 'input_image') {
      if (
        !hasOnly(part, ['type', 'image_url', 'detail']) ||
        (part.detail !== undefined && part.detail !== 'auto') ||
        typeof part.image_url !== 'string' ||
        !/^data:image\/[^,]+;base64,.+$/s.test(part.image_url)
      )
        throw new TypeError(
          'input_image requires a base64 image data URL and default detail',
        );
      return { type: 'image', image_url: part.image_url };
    }
    throw new TypeError('User message parts must be input_text or input_image');
  });
}
