import 'server-only';

import { generateTraceId } from '@openai/agents';
import type {
  ChatKitItemsListParams,
  ChatKitPage,
  ChatKitThread,
  ChatKitThreadItem,
  ChatKitThreadListParams,
  ChatKitThreadMetadata,
} from '@openai/agents-extensions/chatkit';
import { createId } from './utils';

type Order = 'asc' | 'desc';

const DEFAULT_PAGE_SIZE = 20;

function readOrder(value: unknown): Order {
  return value === 'asc' ? 'asc' : 'desc';
}

function readLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function readPageParams(params: Record<string, unknown> | undefined) {
  const limit = readLimit(params?.limit) ?? DEFAULT_PAGE_SIZE;
  const after = typeof params?.after === 'string' ? params.after : null;
  const order = readOrder(params?.order);
  return { limit, after, order };
}

type StoredThread = ChatKitThreadMetadata & {
  items: ChatKitThreadItem[];
  previousResponseId?: string;
  traceId?: string;
};

type ChatKitStoreGlobal = typeof globalThis & {
  __chatKitThreadStore?: Map<string, StoredThread>;
};

const globalStore = globalThis as ChatKitStoreGlobal;
const threadStore =
  globalStore.__chatKitThreadStore ?? new Map<string, StoredThread>();

if (!globalStore.__chatKitThreadStore) {
  globalStore.__chatKitThreadStore = threadStore;
}

export function createThread(options: { id?: string } = {}): StoredThread {
  const id = options.id ?? createId('thread');
  const createdAt = new Date().toISOString();
  const thread: StoredThread = {
    id,
    created_at: createdAt,
    title: null,
    status: { type: 'active' },
    metadata: {},
    items: [],
    traceId: generateTraceId(),
  };
  threadStore.set(id, thread);
  return thread;
}

export function getThread(threadId: string): StoredThread | undefined {
  return threadStore.get(threadId);
}

export function ensureThread(threadId?: string): StoredThread {
  if (threadId) {
    const existing = threadStore.get(threadId);
    if (existing) {
      return existing;
    }
    return createThread({ id: threadId });
  }
  return createThread();
}

export function getPreviousResponseId(threadId: string): string | undefined {
  return threadStore.get(threadId)?.previousResponseId;
}

export function setPreviousResponseId(
  threadId: string,
  previousResponseId?: string,
): void {
  const thread = threadStore.get(threadId);
  if (!thread) {
    return;
  }
  thread.previousResponseId = previousResponseId;
}

export function getTraceId(threadId: string): string | undefined {
  return threadStore.get(threadId)?.traceId;
}

export function ensureTraceId(threadId: string): string {
  const thread = ensureThread(threadId);
  if (!thread.traceId) {
    thread.traceId = generateTraceId();
  }
  return thread.traceId;
}

export function listThreads(
  params?: ChatKitThreadListParams,
): ChatKitPage<ChatKitThreadMetadata> {
  const { limit, after, order } = readPageParams(params);
  const threads = Array.from(threadStore.values());
  threads.sort((a, b) =>
    order === 'asc'
      ? a.created_at.localeCompare(b.created_at)
      : b.created_at.localeCompare(a.created_at),
  );

  let startIndex = 0;
  if (after) {
    const index = threads.findIndex((thread) => thread.id === after);
    if (index >= 0) {
      startIndex = index + 1;
    }
  }

  const page = threads.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < threads.length;
  const nextAfter = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return {
    data: page.map(
      ({ items: _items, previousResponseId: _previousResponseId, ...rest }) =>
        rest,
    ),
    has_more: hasMore,
    after: nextAfter ?? null,
  };
}

export function listItems(
  threadId: string,
  params?: ChatKitItemsListParams,
): ChatKitPage<ChatKitThreadItem> {
  const { limit, after, order } = readPageParams(params);
  const thread = threadStore.get(threadId);
  if (!thread) {
    return { data: [], has_more: false, after: null };
  }

  const items =
    order === 'asc' ? [...thread.items] : [...thread.items].reverse();
  let startIndex = 0;
  if (after) {
    const index = items.findIndex((item) => item.id === after);
    if (index >= 0) {
      startIndex = index + 1;
    }
  }

  const resolvedLimit =
    typeof limit === 'number' && limit > 0 ? limit : items.length;
  const page = items.slice(startIndex, startIndex + resolvedLimit);
  const hasMore = startIndex + resolvedLimit < items.length;
  const nextAfter = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return {
    data: page,
    has_more: hasMore,
    after: nextAfter ?? null,
  };
}

export function toThreadResponse(
  thread: ChatKitThreadMetadata | StoredThread,
): ChatKitThread {
  const items = 'items' in thread ? thread.items : [];
  return {
    id: thread.id,
    created_at: thread.created_at,
    title: thread.title ?? null,
    status: thread.status,
    metadata: thread.metadata,
    items: {
      data: [...items],
      has_more: false,
      after: null,
    },
  };
}

export function updateThreadTitle(
  threadId: string,
  title: string | null,
): ChatKitThreadMetadata | undefined {
  const thread = threadStore.get(threadId);
  if (!thread) {
    return undefined;
  }
  thread.title = title;
  return thread;
}

export function deleteThread(threadId: string): boolean {
  return threadStore.delete(threadId);
}

export function addItem(threadId: string, item: ChatKitThreadItem): void {
  const thread = threadStore.get(threadId);
  if (!thread) {
    return;
  }
  thread.items.push(item);
}

export function replaceItem(threadId: string, item: ChatKitThreadItem): void {
  const thread = threadStore.get(threadId);
  if (!thread) {
    return;
  }
  const index = thread.items.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    thread.items.push(item);
    return;
  }
  thread.items[index] = item;
}

export function removeItem(threadId: string, itemId: string): void {
  const thread = threadStore.get(threadId);
  if (!thread) {
    return;
  }
  thread.items = thread.items.filter((item) => item.id !== itemId);
}
