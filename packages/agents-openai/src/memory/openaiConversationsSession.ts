import OpenAI from 'openai';
import type { AgentInputItem, Session } from '@openai/agents-core';
import { getDefaultOpenAIClient, getDefaultOpenAIKey } from '../defaults';
import { convertToOutputItem, getInputItems } from '../openaiResponsesModel';
import { protocol } from '@openai/agents-core';

export type OpenAIConversationsSessionOptions = {
  conversationId?: string;
  client?: OpenAI;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
};

function resolveClient(options: OpenAIConversationsSessionOptions): OpenAI {
  if (options.client) {
    return options.client;
  }

  return (
    getDefaultOpenAIClient() ??
    new OpenAI({
      apiKey: options.apiKey ?? getDefaultOpenAIKey(),
      baseURL: options.baseURL,
      organization: options.organization,
      project: options.project,
    })
  );
}

export async function startOpenAIConversationsSession(
  client?: OpenAI,
): Promise<string> {
  const resolvedClient = client ?? resolveClient({});
  const response = await resolvedClient.conversations.create({ items: [] });
  return response.id;
}

export class OpenAIConversationsSession implements Session {
  #client: OpenAI;
  #conversationId?: string;

  constructor(options: OpenAIConversationsSessionOptions = {}) {
    this.#client = resolveClient(options);
    this.#conversationId = options.conversationId;
  }

  get sessionId(): string | undefined {
    return this.#conversationId;
  }

  async getSessionId(): Promise<string> {
    if (!this.#conversationId) {
      this.#conversationId = await startOpenAIConversationsSession(
        this.#client,
      );
    }

    return this.#conversationId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const conversationId = await this.getSessionId();
    const items: AgentInputItem[] = [];

    const iterator = this.#client.conversations.items.list(
      conversationId,
      limit ? { limit, order: 'desc' as const } : { order: 'asc' as const },
    );
    for await (const item of iterator) {
      if (item.type === 'message' && item.role === 'user') {
        items.push({
          id: item.id,
          type: 'message',
          role: 'user',
          content: item.content
            .map((c) => {
              if (c.type === 'input_text') {
                return { type: 'input_text', text: c.text };
              } else if (c.type === 'input_image') {
                if (c.image_url) {
                  return { type: 'input_image', image: c.image_url };
                } else if (c.file_id) {
                  return { type: 'input_image', image: { id: c.file_id } };
                }
              } else if (c.type === 'input_file') {
                if (c.file_url) {
                  return { type: 'input_file', file: c.file_url };
                } else if (c.file_id) {
                  return { type: 'input_file', file: { id: c.file_id } };
                }
              }
              // Add more content types here when they're added
              return null;
            })
            .filter((c) => c !== null) as protocol.UserContent[],
        });
      } else {
        items.push(
          ...convertToOutputItem([item as OpenAI.Responses.ResponseOutputItem]),
        );
      }
      if (limit && items.length >= limit) {
        break;
      }
    }
    if (limit) {
      items.reverse();
    }
    return items;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) {
      return;
    }

    const conversationId = await this.getSessionId();
    await this.#client.conversations.items.create(conversationId, {
      items: getInputItems(items),
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const conversationId = await this.getSessionId();
    const [latest] = await this.getItems(1);
    if (!latest) {
      return undefined;
    }

    const itemId = (latest as { id?: string }).id;
    if (itemId) {
      await this.#client.conversations.items.delete(itemId, {
        conversation_id: conversationId,
      });
    }

    return latest;
  }

  async clearSession(): Promise<void> {
    if (!this.#conversationId) {
      return;
    }

    await this.#client.conversations.delete(this.#conversationId);
    this.#conversationId = undefined;
  }
}
