import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAIConversationsSession } from '../src';

function fixture(
  options: {
    failAt?: number;
    holdFirst?: Promise<void>;
    started?: () => void;
  } = {},
) {
  const stored: any[] = [];
  const batches: any[][] = [];
  const operations: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(new URL(String(url)).pathname).toBe(
      init?.method === 'DELETE'
        ? '/v1/conversations/conv-batching'
        : '/v1/conversations/conv-batching/items',
    );
    if (init?.method === 'POST') {
      const { items } = JSON.parse(init.body as string);
      operations.push('add');
      batches.push(items);
      if (items.length > 20) {
        return Response.json(
          { error: { message: 'At most 20 items per request' } },
          { status: 400 },
        );
      }
      if (batches.length === options.failAt) {
        return Response.json(
          { error: { message: 'Second batch rejected' } },
          { status: 400 },
        );
      }
      if (batches.length === 1) {
        options.started?.();
        await options.holdFirst;
      }
      stored.push(
        ...items.map((item: any, index: number) => ({
          ...item,
          id: `item-${stored.length + index}`,
          type: 'message',
          content:
            typeof item.content === 'string'
              ? [{ type: 'input_text', text: item.content }]
              : item.content,
        })),
      );
    } else if (init?.method === 'DELETE') {
      operations.push('delete');
      return Response.json({ deleted: true });
    }
    return Response.json({ object: 'list', data: stored, has_more: false });
  });
  const client = new OpenAI({
    apiKey: 'synthetic-key',
    baseURL: 'https://provider.invalid/v1',
    fetch,
    maxRetries: 0,
  });
  const session = new OpenAIConversationsSession({
    client,
    conversationId: 'conv-batching',
  });
  return { session, batches, operations, stored };
}

const input = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    role: 'user' as const,
    content: `message-${index}`,
  }));

describe('Conversations request batching', () => {
  it.each([
    [20, [20]],
    [21, [20, 1]],
    [45, [20, 20, 5]],
  ] as const)(
    'persists %i items in bounded ordered requests',
    async (count, sizes) => {
      const { session, batches } = fixture();
      await session.addItems(input(count));
      expect(batches.map((batch) => batch.length)).toEqual(sizes);
      const history = await session.getItems();
      expect(history.map((item: any) => item.content)).toEqual(
        input(count).map((item) => [
          { type: 'input_text', text: item.content },
        ]),
      );
      expect(session.sessionId).toBe('conv-batching');
    },
  );

  it('propagates the failed batch and does not send later items or replay accepted items', async () => {
    const { session, batches, stored } = fixture({ failAt: 2 });
    await expect(session.addItems(input(45))).rejects.toThrow(
      'Second batch rejected',
    );
    expect(batches.map((batch) => batch.length)).toEqual([20, 20]);
    expect(stored).toHaveLength(20);
    expect(stored.map((item) => item.content[0].text)).toEqual(
      input(20).map((item) => item.content),
    );
  });

  it('awaits each batch and keeps clearing behind the complete tracked write', async () => {
    let release!: () => void;
    let started!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { session, batches, operations } = fixture({ holdFirst, started });
    const adding = session.addItems(input(45));
    await firstStarted;
    const clearing = session.clearSession();
    try {
      expect(batches.map((batch) => batch.length)).toEqual([20]);
      expect(operations).toEqual(['add']);
    } finally {
      release();
    }
    await adding;
    await clearing;
    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(operations).toEqual(['add', 'add', 'add', 'delete']);
    expect(session.sessionId).toBeUndefined();
  });
});
