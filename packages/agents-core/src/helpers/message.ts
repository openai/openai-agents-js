import {
  AssistantContent,
  AssistantMessageItem,
  SystemMessageItem,
  UserContent,
  UserMessageItem,
} from '../types/protocol';

/**
 * Creates a user message entry
 *
 * @param input The input message from the user.
 * @param options Any additional options that will be directly passed to the model.
 * @returns A message entry.
 */
export function user(
  input: string | UserContent[],
  options?: Record<string, any>,
): UserMessageItem {
  return {
    type: 'message',
    role: 'user',
    content:
      typeof input === 'string'
        ? [
            {
              type: 'input_text',
              text: input,
            },
          ]
        : input,
    providerData: options,
  };
}

/**
 * Creates a system message entry
 *
 * @param input The system prompt.
 * @param options Any additional options that will be directly passed to the model.
 * @returns A message entry.
 */
export function system(
  input: string,
  options?: Record<string, any>,
): SystemMessageItem {
  return {
    type: 'message',
    role: 'system',
    content: input,
    providerData: options,
  };
}

/**
 * Creates an assistant message entry for example for multi-shot prompting
 *
 * @param content The assistant response.
 * @param options Any additional options that will be directly passed to the model.
 * @returns A message entry.
 */
export function assistant(
  content: string | AssistantContent[],
  options?: Record<string, any>,
): AssistantMessageItem {
  return {
    type: 'message',
    role: 'assistant',
    content:
      typeof content === 'string'
        ? [
            {
              type: 'output_text',
              text: content,
            },
          ]
        : content,
    status: 'completed',
    providerData: options,
  };
}
