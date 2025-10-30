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

  it('wraps string function_call_output payloads before converting', async () => {
    const convertedItems = [
      {
        id: 'converted-output',
        type: 'function_call_result',
      },
    ];

    convertToOutputItemMock.mockReturnValue(convertedItems as any);

    const items = [
      {
        type: 'function_call_output',
        id: 'resp-fn-output',
        call_id: 'call-1',
        output: 'Tool error message',
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

    expect(convertToOutputItemMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'resp-fn-output',
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Tool error message',
      }),
    ]);
    expect(result).toEqual(convertedItems);
  });

  it('wraps function_call_output structured content arrays before converting', async () => {
    const convertedItems = [
      {
        id: 'converted-output-array',
        type: 'function_call_result',
      },
    ];

    convertToOutputItemMock.mockReturnValue(convertedItems as any);

    const items = [
      {
        type: 'function_call_output',
        id: 'resp-fn-output-array',
        call_id: 'call-2',
        output: [
          {
            type: 'input_text',
            text: 'No customer found',
          },
        ],
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

    expect(convertToOutputItemMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'resp-fn-output-array',
        type: 'function_call_output',
        call_id: 'call-2',
        output: [
          {
            type: 'input_text',
            text: 'No customer found',
          },
        ],
      }),
    ]);
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

  it('preserves inline file data for user inputs', async () => {
    const items = [
      {
        type: 'message',
        role: 'user',
        id: 'user-1',
        content: [
          {
            type: 'input_file',
            file_data: 'data:application/pdf;base64,SGVsbG8=',
            filename: 'inline.pdf',
          },
        ],
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

    expect(result).toEqual([
      {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: 'data:application/pdf;base64,SGVsbG8=',
            filename: 'inline.pdf',
          },
        ],
      },
    ]);
  });

  it('adds items without requesting additional response includes', async () => {
    const createMock = vi.fn();
    const inputItems = [
      {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [],
      },
    ];
    const converted = [
      {
        id: 'payload-user-1',
        type: 'message',
        role: 'user',
        content: [],
      },
    ];

    getInputItemsMock.mockReturnValue(converted as any);

    const session = new OpenAIConversationsSession({
      client: {
        conversations: {
          items: {
            list: vi.fn(),
            create: createMock,
            delete: vi.fn(),
          },
          create: vi.fn(),
          delete: vi.fn(),
        },
      } as any,
      conversationId: 'conv-123',
    });

    await session.addItems(inputItems as any);

    expect(getInputItemsMock).toHaveBeenCalledWith(inputItems);
    expect(createMock).toHaveBeenCalledWith('conv-123', {
      items: converted,
    });
  });
});
