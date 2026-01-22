import { assistant, system, user, type AgentInputItem } from '@openai/agents';
import type { UIMessage } from 'ai';

type MessageRole = 'system' | 'user' | 'assistant';

type MessageLike = {
  role: MessageRole;
  content?: unknown;
  id?: string;
};

function isMessageItem(
  item: AgentInputItem,
): item is AgentInputItem & MessageLike {
  return (
    typeof item === 'object' &&
    item !== null &&
    'role' in item &&
    typeof (item as { role?: unknown }).role === 'string'
  );
}

type UiMessageLike = UIMessage & { content?: string };

type TextPart = {
  type: 'text';
  text: string;
};

function extractUiMessageText(message: UiMessageLike): string {
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  return '';
}

function extractAgentContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const type = (part as { type?: string }).type;
      if (type === 'input_text' || type === 'output_text') {
        return (part as { text?: string }).text ?? '';
      }
      if (type === 'refusal') {
        return (part as { refusal?: string }).refusal ?? '';
      }
      if (type === 'audio') {
        return (part as { transcript?: string }).transcript ?? '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function toAgentInput(messages: UiMessageLike[]): AgentInputItem[] {
  const input: AgentInputItem[] = [];

  for (const message of messages) {
    const text = extractUiMessageText(message);
    if (!text) {
      continue;
    }

    switch (message.role) {
      case 'system':
        input.push(system(text));
        break;
      case 'assistant':
        input.push(assistant(text));
        break;
      default:
        input.push(user(text));
        break;
    }
  }

  return input;
}

export function toUiMessages(items: AgentInputItem[]): UIMessage[] {
  const messages: UIMessage[] = [];

  for (const item of items) {
    if (!isMessageItem(item)) {
      continue;
    }

    const role = item.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue;
    }

    const text = extractAgentContentText(item.content);
    if (!text) {
      continue;
    }

    const parts: UIMessage['parts'] = [{ type: 'text', text }];
    messages.push({
      id: item.id ?? crypto.randomUUID(),
      role,
      parts,
    });
  }

  return messages;
}
