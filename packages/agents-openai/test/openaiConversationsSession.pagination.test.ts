import { ConversationCursorPage } from 'openai/core/pagination';
import { describe, expect, it, vi } from 'vitest';
import { OpenAIConversationsSession } from '../src';

function userMessage(id: number) {
  return {
    id: `user-${id}`,
    type: 'message' as const,
    role: 'user' as const,
    content: [{ type: 'input_text' as const, text: `message ${id}` }],
  };
}

describe('OpenAIConversationsSession pagination', () => {
  it('caps provider pages at 100 while keeping the total history limit local', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      userMessage(199 - index),
    );
    const secondPage = Array.from({ length: 100 }, (_, index) =>
      userMessage(99 - index),
    );
    const nextPageQueries: Array<Record<string, unknown>> = [];
    const paginationClient: any = {};
    paginationClient.requestAPIList = vi.fn(
      async (_Page: unknown, options: any) => {
        nextPageQueries.push(options.query);
        return new ConversationCursorPage(
          paginationClient,
          new Response(),
          {
            data: secondPage,
            has_more: false,
            last_id: 'user-0',
          },
          options,
        );
      },
    );

    const list = vi.fn((_conversationId: string, query: any) =>
      new ConversationCursorPage(
        paginationClient,
        new Response(),
        {
          data: firstPage,
          has_more: true,
          last_id: 'user-100',
        },
        {
          method: 'get',
          path: '/conversations/conv-123/items',
          query,
        } as any,
      ),
    );
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

    const result = await session.getItems(150);

    expect(list).toHaveBeenCalledWith('conv-123', {
      limit: 100,
      order: 'desc',
    });
    expect(paginationClient.requestAPIList).toHaveBeenCalledTimes(1);
    expect(nextPageQueries).toEqual([
      { limit: 100, order: 'desc', after: 'user-100' },
    ]);
    expect(result).toHaveLength(150);
    expect(result[0]?.id).toBe('user-50');
    expect(result[result.length - 1]?.id).toBe('user-199');
  });
});
