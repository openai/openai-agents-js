import type {
  ChatKitUserMessageInput,
  ChatKitUserMessageItem,
} from '@openai/agents-extensions/chatkit';
import { createId } from './utils';

export function buildUserMessageItem(
  threadId: string,
  input: ChatKitUserMessageInput,
): ChatKitUserMessageItem {
  return {
    type: 'user_message',
    id: createId('message'),
    thread_id: threadId,
    created_at: new Date().toISOString(),
    content: input.content,
    attachments: input.attachments.map((attachment) => ({ id: attachment })),
    quoted_text: input.quoted_text ?? null,
    inference_options: input.inference_options,
  };
}

function formatQuotedText(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function userMessageToText(item: ChatKitUserMessageItem): string {
  const parts = item.content.map((content) => {
    if (content.type === 'input_text') {
      return content.text;
    }
    if (content.type === 'input_tag') {
      return `@${content.text}`;
    }
    return '';
  });
  const base = parts.filter(Boolean).join(' ').trim();
  if (item.quoted_text) {
    const quote = formatQuotedText(item.quoted_text);
    return base ? `${base}\n\n${quote}` : quote;
  }
  return base;
}

export function deriveThreadTitle(
  input: ChatKitUserMessageInput,
): string | null {
  const text = input.content
    .map((content) => {
      if (content.type === 'input_text') {
        return content.text;
      }
      if (content.type === 'input_tag') {
        return `@${content.text}`;
      }
      return '';
    })
    .join(' ')
    .trim();
  if (!text) {
    return null;
  }
  const maxLength = 60;
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
