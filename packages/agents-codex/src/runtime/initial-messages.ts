import { nativeInput, responseContent, type UserMessage } from './input';

/** Settled assistant text, without caller identity, reasoning or tool work. */
export interface AssistantMessage {
  role: 'assistant';
  content: string;
  type?: 'message';
}
export type InitialMessage = UserMessage | AssistantMessage;

function assertNativeText(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError(
          'initialMessages text must contain valid Unicode scalars',
        );
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(
        'initialMessages text must contain valid Unicode scalars',
      );
    }
  }
}

/** Copy before resources or a possibly overridden session factory. */
export function captureInitialMessages(
  messages: readonly InitialMessage[] | undefined,
  state?: unknown,
  resume?: unknown,
): InitialMessage[] | undefined {
  if (messages === undefined) return undefined;
  if (state != null || resume !== undefined)
    throw new TypeError(
      'initialMessages requires a fresh conversation without state or resume',
    );
  if (!Array.isArray(messages))
    throw new TypeError('initialMessages must be an array of settled messages');
  return messages.map<InitialMessage>((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      throw new TypeError(
        'initialMessages entries must be user or assistant messages',
      );
    if (message.role === 'user') {
      const content = responseContent(nativeInput(message));
      for (const part of content) {
        if (part && typeof part === 'object')
          for (const value of Object.values(part))
            if (typeof value === 'string') assertNativeText(value);
      }
      return {
        role: 'user',
        content,
      } as unknown as UserMessage;
    }
    if (
      message.role !== 'assistant' ||
      typeof message.content !== 'string' ||
      (message.type !== undefined && message.type !== 'message') ||
      Object.getOwnPropertyNames(message).some(
        (key) => !['role', 'content', 'type'].includes(key),
      )
    )
      throw new TypeError(
        'initialMessages accepts only user messages and settled assistant text',
      );
    assertNativeText(message.content);
    return { role: 'assistant', content: message.content };
  });
}
