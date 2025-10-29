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
      'resp-1-msg-1',
    ]);
  });
});
