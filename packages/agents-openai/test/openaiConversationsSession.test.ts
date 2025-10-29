import { describe, expect, it, beforeEach, vi } from 'vitest';

const { convertToOutputItemMock, getInputItemsMock } = vi.hoisted(() => ({
  convertToOutputItemMock: vi.fn(),
  getInputItemsMock: vi.fn(),
}));

vi.mock('../src/openaiResponsesModel', () => ({
  convertToOutputItem: convertToOutputItemMock,
  getInputItems: getInputItemsMock,
}));

import { OpenAIConversationsSession } from '../src/memory/openaiConversationsSession';

describe('OpenAIConversationsSession', () => {
  beforeEach(() => {
    convertToOutputItemMock.mockReset();
    getInputItemsMock.mockReset();
  });

  it('converts response items using their output payload', async () => {
    const responseOutput = [
      {
        id: 'resp-1-msg-1',
        type: 'message',
        role: 'assistant',
        content: [],
      },
    ];
    const convertedItems = [
      {
        id: 'converted-1',
        type: 'message',
        role: 'assistant',
        content: [],
      },
    ];

    convertToOutputItemMock.mockReturnValue(convertedItems as any);

    const items = [
      {
        type: 'response',
        id: 'resp-1',
        output: responseOutput,
      },
    ];

    const list = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const item of items) {
          yield item as any;
        }
      },
    }));

    const session = new OpenAIConversationsSession({
      client: {
        conversations: {
          items: {
            list,
            create: vi.fn(),
            delete: vi.fn(),
          },
          create: vi.fn(),
          delete: vi.fn(),
        },
      } as any,
      conversationId: 'conv-123',
    });

    const result = await session.getItems();

    expect(list).toHaveBeenCalledWith('conv-123', { order: 'asc' });
    expect(convertToOutputItemMock).toHaveBeenCalledWith(responseOutput);
    expect(result).toEqual(convertedItems);
  });

  it('enforces the item limit after converting response items', async () => {
    convertToOutputItemMock.mockImplementation((raw) => {
      const id = raw[0]?.id ?? 'response';
      return [
        {
          id: `${id}-msg-1`,
          type: 'message',
          role: 'assistant',
          content: [],
        },
        {
          id: `${id}-msg-2`,
          type: 'message',
          role: 'assistant',
          content: [],
        },
        {
          id: `${id}-msg-3`,
          type: 'message',
          role: 'assistant',
          content: [],
        },
      ] as any;
    });

    const items = [
      {
        type: 'message',
        role: 'assistant',
        id: 'resp-1',
        content: [],
      },
      {
        type: 'message',
        role: 'assistant',
        id: 'resp-0',
        content: [],
      },
    ];

    const list = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const item of items) {
          yield item as any;
        }
      },
    }));

    const session = new OpenAIConversationsSession({
      client: {
        conversations: {
          items: {
            list,
            create: vi.fn(),
            delete: vi.fn(),
          },
          create: vi.fn(),
          delete: vi.fn(),
        },
      } as any,
      conversationId: 'conv-123',
    });

    const result = await session.getItems(2);

    expect(list).toHaveBeenCalledWith('conv-123', { limit: 2, order: 'desc' });
    expect(convertToOutputItemMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result.map((item: any) => item.id)).toEqual([
      'resp-1-msg-2',
      'resp-1-msg-3',
    ]);
  });

  it('popItem deletes the newest converted item', async () => {
    convertToOutputItemMock.mockReturnValue([
      {
        id: 'resp-1-msg-1',
        type: 'message',
        role: 'assistant',
        content: [],
      },
      {
        id: 'resp-1-msg-2',
        type: 'message',
        role: 'assistant',
        content: [],
      },
      {
        id: 'resp-1-msg-3',
        type: 'message',
        role: 'assistant',
        content: [],
      },
    ] as any);

    const items = [
      {
        type: 'message',
        role: 'assistant',
        id: 'resp-1',
        content: [],
      },
    ];

    const list = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const item of items) {
          yield item as any;
        }
      },
    }));

    const deleteMock = vi.fn();

    const session = new OpenAIConversationsSession({
      client: {
        conversations: {
          items: {
            list,
            create: vi.fn(),
            delete: deleteMock,
          },
          create: vi.fn(),
          delete: vi.fn(),
        },
      } as any,
      conversationId: 'conv-123',
    });

    const popped = await session.popItem();

    expect(list).toHaveBeenCalledWith('conv-123', { limit: 1, order: 'desc' });
    expect(deleteMock).toHaveBeenCalledWith('resp-1-msg-3', {
      conversation_id: 'conv-123',
    });
    expect(popped?.id).toBe('resp-1-msg-3');
  });
});
