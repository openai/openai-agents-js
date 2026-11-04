import type { Part, Task } from '@a2a-js/sdk';
import type { UserInput, InputText, InputImage } from '../runtime/input';
import { A2AError } from './client';

/** Root text and inline image profile. Files and arbitrary URIs fail before native admission. */
export function a2aInput(parts: readonly Part[]): UserInput {
  if (!parts.length) throw new A2AError('unsupported');
  const content: (InputText | InputImage)[] = parts.map((part) => {
    if (part.content?.$case === 'text')
      return { type: 'input_text', text: part.content.value };
    if (
      part.content?.$case === 'raw' &&
      /^image\/(png|jpeg|gif|webp)$/.test(part.mediaType)
    )
      return {
        type: 'input_image',
        image_url: `data:${part.mediaType};base64,${Buffer.from(part.content.value).toString('base64')}`,
      };
    throw new A2AError('unsupported');
  });
  return { role: 'user', content };
}

/** The shared native adapter's one-request A2A data-part profile. */
export function inputProposal(
  task: Task,
):
  | { challenge: string; generation: number; tool: string; arguments: unknown }
  | undefined {
  const parts = task.status?.message?.parts;
  if (parts?.length !== 1 || parts[0].content?.$case !== 'data')
    return undefined;
  const value = parts[0].content.value;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.challenge !== 'string' ||
    !value.challenge ||
    !Number.isSafeInteger(value.generation) ||
    value.generation <= 0 ||
    typeof value.tool !== 'string'
  )
    return undefined;
  return {
    challenge: value.challenge,
    generation: value.generation,
    tool: value.tool,
    arguments: value.arguments,
  };
}
