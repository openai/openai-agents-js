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
import type { OpenAIClient } from '../openaiClient';

export type OpenAIConversationsSessionOptions = {
  conversationId?: string;
  client?: OpenAIClient;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
};

export async function startOpenAIConversationsSession(
  client?: OpenAIClient,
): Promise<string> {
  const resolvedClient = client ? (client as OpenAI) : resolveClient({});
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
  #conversationIdOperation: Promise<void> = Promise.resolve();
  #activeItemOperations = new Set<Promise<void>>();

  constructor(options: OpenAIConversationsSessionOptions = {}) {
    this.#client = resolveClient(options);
    this.#conversationId = options.conversationId;
  }

  get sessionId(): string | undefined {
    return this.#conversationId;
  }

  async getSessionId(): Promise<string> {
    return this.#runConversationIdOperation(() => this.#getSessionId());
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.#runItemOperation((conversationId) =>
      this.#getItems(conversationId, limit),
    );
  }

  async #getItems(
    conversationId: string,
    limit?: number,
  ): Promise<AgentInputItem[]> {
    // Convert each API item into the Agent SDK's input shape. Some API payloads expand into multiple items.
    const toAgentItems = (item: APIConversationItem): AgentInputItem[] => {
      if (item.type === 'message' && item.role === 'system') {
        const message = item as APIConversationMessage;
        return [
          {
            id: item.id,
            type: 'message',
            role: 'system',
            content: normalizeSystemMessageContent(message.content),
          },
        ];
      }

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

  prepareHistoryItemForModelInput(item: AgentInputItem): AgentInputItem {
    return stripAssistantReplayMetadata(item);
  }

  prepareHistoryItemsForPersistenceComparison(
    items: AgentInputItem[],
  ): AgentInputItem[] {
    return normalizeItemsForConversationPersistence(
      items,
    ) as unknown as AgentInputItem[];
  }

  preserveReasoningItemIdsForPersistence(): boolean {
    return true;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) {
      return;
    }

    await this.#runItemOperation(async (conversationId) => {
      const sanitizedItems = normalizeItemsForConversationPersistence(items);
      if (!sanitizedItems.length) {
        return;
      }
      await this.#client.conversations.items.create(conversationId, {
        items: sanitizedItems,
      });
    });
  }

  async replaceHistoryWithCompaction(items: AgentInputItem[]): Promise<void> {
    await this.addItems(items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.#runItemOperation(async (conversationId) => {
      const [latest] = await this.#getItems(conversationId, 1);
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
    });
  }

  async clearSession(): Promise<void> {
    await this.#runConversationIdOperation(async () => {
      if (!this.#conversationId) {
        return;
      }

      await Promise.all(this.#activeItemOperations);
      await this.#client.conversations.delete(this.#conversationId);
      this.#conversationId = undefined;
    });
  }

  async #getSessionId(): Promise<string> {
    if (!this.#conversationId) {
      this.#conversationId = await startOpenAIConversationsSession(
        this.#client,
      );
    }

    return this.#conversationId;
  }

  async #runItemOperation<T>(
    operation: (conversationId: string) => Promise<T>,
  ): Promise<T> {
    let resolveOperation!: () => void;
    const operationFinished = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const conversationId = await this.#runConversationIdOperation(async () => {
      const conversationId = await this.#getSessionId();
      this.#activeItemOperations.add(operationFinished);
      return conversationId;
    });

    try {
      return await operation(conversationId);
    } finally {
      this.#activeItemOperations.delete(operationFinished);
      resolveOperation();
    }
  }

  #runConversationIdOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#conversationIdOperation.then(operation);
    this.#conversationIdOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// --------------------------------------------------------------
//  Internals
// --------------------------------------------------------------

function normalizeItemsForConversationPersistence(
  items: AgentInputItem[],
): OpenAI.Responses.ResponseInputItem[] {
  const normalizedItems = stripProviderModelForConversationPersistence(items);
  return stripConversationPersistenceMetadata(getInputItems(normalizedItems));
}

function stripProviderModelForConversationPersistence(
  items: AgentInputItem[],
): AgentInputItem[] {
  return items.map((item) => {
    if (Array.isArray(item) || item === null || typeof item !== 'object') {
      return item;
    }
    // Conversations API rejects unknown top-level fields (e.g., model merged from providerData).
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

function normalizeSystemMessageContent(
  content: APIConversationMessage['content'],
): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) =>
      item.type === 'input_text' || item.type === 'text' ? item.text : null,
    )
    .filter((item): item is string => item !== null)
    .join('\n');
}

const CONVERSATION_ITEM_TYPES_WITH_PRESERVED_IDS = new Set([
  'reasoning',
  'program',
  'program_output',
]);

function stripConversationPersistenceMetadata(
  items: OpenAI.Responses.ResponseInputItem[],
): OpenAI.Responses.ResponseInputItem[] {
  return items.flatMap((item) => {
    if (Array.isArray(item) || item === null || typeof item !== 'object') {
      return [item];
    }
    const record = item as unknown as Record<string, unknown>;
    if (isUnpersistableReasoningItem(record)) {
      return [];
    }
    const {
      providerData: _providerData,
      provider_data: _provider_data,
      ...rest
    } = record;
    if (
      typeof rest.type !== 'string' ||
      !CONVERSATION_ITEM_TYPES_WITH_PRESERVED_IDS.has(rest.type)
    ) {
      delete rest.id;
    }
    return [rest as unknown as OpenAI.Responses.ResponseInputItem];
  });
}

function isUnpersistableReasoningItem(item: Record<string, unknown>): boolean {
  return (
    item.type === 'reasoning' &&
    typeof item.id !== 'string' &&
    typeof item.encrypted_content !== 'string'
  );
}

function stripAssistantReplayMetadata(item: AgentInputItem): AgentInputItem {
  if (Array.isArray(item) || item === null || typeof item !== 'object') {
    return item;
  }

  const record = item as Record<string, unknown>;
  if (record.type !== 'message' || record.role !== 'assistant') {
    return item;
  }

  const {
    id: _id,
    providerData,
    provider_data: _provider_data,
    ...rest
  } = record;
  if (
    typeof rest.phase === 'undefined' &&
    providerData &&
    typeof providerData === 'object' &&
    !Array.isArray(providerData) &&
    typeof (providerData as Record<string, unknown>).phase !== 'undefined'
  ) {
    rest.phase = (providerData as Record<string, unknown>).phase;
  }
  return rest as AgentInputItem;
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
    return options.client as OpenAI;
  }

  return (
    (getDefaultOpenAIClient() as OpenAI | undefined) ??
    new OpenAI({
      apiKey: options.apiKey ?? getDefaultOpenAIKey(),
      baseURL: options.baseURL,
      organization: options.organization,
      project: options.project,
    })
  );
}
