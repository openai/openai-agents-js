import { assistant, system, user, type AgentInputItem } from '@openai/agents';
import type { UIMessage } from 'ai';

type MessageLike = UIMessage & { content?: string };

type TextPart = {
  type: 'text';
  text: string;
};

function extractText(message: MessageLike): string {
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

export function toAgentInput(messages: MessageLike[]): AgentInputItem[] {
  const input: AgentInputItem[] = [];

  for (const message of messages) {
    const text = extractText(message);
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
