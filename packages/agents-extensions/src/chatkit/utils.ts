import type { ResponseStreamEvent } from '@openai/agents';

let idCounter = 0;
export function createId(prefix: string): string {
  const randomUUID =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : undefined;
  if (randomUUID) {
    return `${prefix}-${randomUUID}`;
  }
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

export function normalizeCreatedAt(createdAt?: string | Date): string {
  if (!createdAt) {
    return new Date().toISOString();
  }
  if (typeof createdAt === 'string') {
    return createdAt;
  }
  return createdAt.toISOString();
}

export function resolveEventSource<T>(
  source:
    | AsyncIterable<T>
    | ReadableStream<T>
    | { toStream: () => ReadableStream<T> },
): AsyncIterable<T> {
  if (typeof (source as { toStream?: unknown }).toStream === 'function') {
    return (source as { toStream: () => ReadableStream<T> }).toStream();
  }
  return source as AsyncIterable<T>;
}

export function readItemId(raw: any): string | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.item_id === 'string') {
    return raw.item_id;
  }
  if (typeof raw.itemId === 'string') {
    return raw.itemId;
  }
  return null;
}

export function readContentIndex(raw: any): number | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.content_index === 'number') {
    return raw.content_index;
  }
  if (typeof raw.contentIndex === 'number') {
    return raw.contentIndex;
  }
  return null;
}

export function readSummaryIndex(raw: any): number | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.summary_index === 'number') {
    return raw.summary_index;
  }
  if (typeof raw.summaryIndex === 'number') {
    return raw.summaryIndex;
  }
  return null;
}

export function readDelta(raw: any): string | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.delta === 'string') {
    return raw.delta;
  }
  return null;
}

export function readText(raw: any): string | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.text === 'string') {
    return raw.text;
  }
  return null;
}

export function unwrapModelEvent(data: ResponseStreamEvent): any | null {
  if (data.type !== 'model') {
    return null;
  }
  const event = (data as { event?: unknown }).event;
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (typeof (event as { type?: unknown }).type !== 'string') {
    return null;
  }
  return event;
}
