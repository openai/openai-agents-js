import OpenAI from 'openai';
import type { AgentInputItem, Session } from '@openai/agents-core';
import { getDefaultOpenAIClient, getDefaultOpenAIKey } from '../defaults';
import { convertToOutputItem, getInputItems } from '../openaiResponsesModel';
import { protocol } from '@openai/agents-core';
import type { ConversationItem as APIConversationItem } from 'openai/resources/conversations/items';
import type { Message as APIConversationMessage } from 'openai/resources/conversations/conversations';
import {
  OPENAI_SESSION_API,
  type OpenAISessionApiTagged,
} from './openaiSessionApi';

export type OpenAIConversationsSessionOptions = {
  conversationId?: string;
  client?: OpenAI;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
};

export async function startOpenAIConversationsSession(
  client?: OpenAI,
): Promise<string> {
  const resolvedClient = client ?? resolveClient({});
  const response = await resolvedClient.conversations.create({ items: [] });
  return response.id;
}

export class OpenAIConversationsSession
  implements Session, OpenAISessionApiTagged<'conversations'>
{
  // Marks this session as backed by the Conversations API so Responses-only integrations can reject it.
  readonly [OPENAI_SESSION_API] = 'conversations' as const;

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
    // Convert each API item into the Agent SDK's input shape. Some API payloads expand into multiple items.
    const toAgentItems = (item: APIConversationItem): AgentInputItem[] => {
      if (item.type === 'message' && item.role === 'user') {
        const message = item as APIConversationMessage;
        return [
          {
            id: item.id,
            type: 'message',
            role: 'user',
            content: (message.content ?? [])
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
                  if (c.file_data) {
                    const fileItem: protocol.InputFile = {
                      type: 'input_file',
                      file: c.file_data,
                    };
                    if (c.filename) {
                      fileItem.filename = c.filename;
                    }
                    return fileItem;
                  }
                  if (c.file_url) {
                    const fileItem: protocol.InputFile = {
                      type: 'input_file',
                      file: c.file_url,
                    };
                    if (c.filename) {
                      fileItem.filename = c.filename;
                    }
                    return fileItem;
                  } else if (c.file_id) {
                    const fileItem: protocol.InputFile = {
                      type: 'input_file',
                      file: { id: c.file_id },
                    };
                    if (c.filename) {
                      fileItem.filename = c.filename;
                    }
                    return fileItem;
                  }
                }
                // Add more content types here when they're added
                return null;
              })
              .filter((c) => c !== null) as protocol.UserContent[],
          },
        ];
      }

      const outputItems = (item as APIConversationItem & { output?: unknown })
        .output;

      if (isResponseOutputItemArray(outputItems)) {
        return convertToOutputItem(outputItems);
      }

      return convertToOutputItem([item as OpenAI.Responses.ResponseOutputItem]);
    };

    if (limit === undefined) {
      const items: AgentInputItem[] = [];
      const iterator = this.#client.conversations.items.list(conversationId, {
        order: 'asc' as const,
      });
      for await (const item of iterator) {
        items.push(...toAgentItems(item));
      }
      return items;
    }

    if (limit <= 0) {
      return [];
    }

    const itemGroups: AgentInputItem[][] = [];
    let total = 0;
    const iterator = this.#client.conversations.items.list(conversationId, {
      limit,
      order: 'desc' as const,
    });

    for await (const item of iterator) {
      const group = toAgentItems(item);
      if (!group.length) {
        continue;
      }

      itemGroups.push(group);
      total += group.length;

      if (total >= limit) {
        break;
      }
    }

    // Iterate in reverse because the API returned items in descending order.
    const orderedItems: AgentInputItem[] = [];
    for (let index = itemGroups.length - 1; index >= 0; index -= 1) {
      orderedItems.push(...itemGroups[index]);
    }

    if (orderedItems.length > limit) {
      orderedItems.splice(0, orderedItems.length - limit);
    }

    return orderedItems;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) {
      return;
    }

    const conversationId = await this.getSessionId();
    const sanitizedItems = stripIdsAndProviderData(items);
    await this.#client.conversations.items.create(conversationId, {
      items: getInputItems(sanitizedItems),
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

// --------------------------------------------------------------
//  Internals
// --------------------------------------------------------------

function stripIdsAndProviderData(items: AgentInputItem[]): AgentInputItem[] {
  return items.map((item) => {
    if (Array.isArray(item) || item === null || typeof item !== 'object') {
      return item;
    }
    // Conversations API rejects unknown top-level fields (e.g., model merged from providerData).
    // Only strip providerData.model from message-like items; keep IDs intact for tool linkage.
    const rest = { ...(item as Record<string, unknown>) };
    const providerData = (item as { providerData?: unknown }).providerData;

    if (
      providerData &&
      typeof providerData === 'object' &&
      !Array.isArray(providerData)
    ) {
      const pdObj = providerData as Record<string, unknown>;
      const { model: _model, ...pdRest } = pdObj;
      (rest as Record<string, unknown>).providerData =
        Object.keys(pdRest).length > 0 ? pdRest : undefined;
    }
    return rest as AgentInputItem;
  });
}

const INPUT_CONTENT_TYPES = new Set([
  'input_text',
  'input_image',
  'input_file',
  'input_audio',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Treats a value as ResponseOutputItem[] only when each entry resembles an output item rather than raw input content.
function isResponseOutputItemArray(
  value: unknown,
): value is OpenAI.Responses.ResponseOutputItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  return value.every((entry) => {
    if (!isObject(entry)) {
      return false;
    }
    const type = (entry as { type?: unknown }).type;
    if (typeof type !== 'string') {
      return false;
    }

    if (INPUT_CONTENT_TYPES.has(type)) {
      return false;
    }

    // Fallback: pre-emptively exclude future input_* variants so they never masquerade as response outputs.
    return !type.startsWith('input_');
  });
}

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
