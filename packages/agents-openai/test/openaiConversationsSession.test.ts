import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { OpenAIConversationsSessionOptions } from '../src';

const { convertToOutputItemMock, getInputItemsMock } = vi.hoisted(() => ({
  convertToOutputItemMock: vi.fn(),
  getInputItemsMock: vi.fn(),
}));

vi.mock('../src/openaiResponsesModel', () => ({
  convertToOutputItem: convertToOutputItemMock,
  getInputItems: getInputItemsMock,
}));

import { OpenAIConversationsSession } from '../src';

const createSession = (options: OpenAIConversationsSessionOptions) =>
  new OpenAIConversationsSession(options);

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

    const session = createSession({
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

    const session = createSession({
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

    const session = createSession({
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

    const session = createSession({
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

    const session = createSession({
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

    const session = createSession({
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
        providerData: { model: 'some-model', extra: 'keep-me' },
      },
    ];
    const converted = [
      {
        id: 'payload-user-1',
        type: 'message',
        role: 'user',
        content: [],
        // model should be stripped, but other providerData should stay if present
        providerData: { extra: 'keep-me' },
      },
    ];

    getInputItemsMock.mockReturnValue(converted as any);

    const session = createSession({
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

    expect(getInputItemsMock).toHaveBeenCalledWith(
      inputItems.map((item) => {
        const { providerData, ...rest } = item as any;
        if (rest.providerData) {
          const { model: _model, ...pdRest } = rest.providerData as any;
          rest.providerData = Object.keys(pdRest).length ? pdRest : undefined;
        } else if (providerData) {
          const { model: _model, ...pdRest } = providerData as any;
          rest.providerData = Object.keys(pdRest).length ? pdRest : undefined;
        }
        return rest;
      }),
    );
    expect(createMock).toHaveBeenCalledWith('conv-123', {
      items: converted,
    });
  });

  it('keeps providerData for hosted tool calls', async () => {
    const createMock = vi.fn();
    const inputItems = [
      {
        id: 'call-1',
        type: 'function_call',
        name: 'search',
        callId: 'call-1',
        arguments: '{}',
        providerData: {
          type: 'web_search',
          user_location: 'JP',
          model: 'some-model',
        },
      },
    ];
    const converted = [
      {
        id: 'call-1',
        type: 'function_call',
        name: 'search',
        call_id: 'call-1',
        arguments: '{}',
        providerData: { type: 'web_search', user_location: 'JP' },
      },
    ];

    getInputItemsMock.mockReturnValue(converted as any);

    const session = createSession({
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

    expect(getInputItemsMock).toHaveBeenCalledWith(
      inputItems.map((item) => {
        const { providerData, ...rest } = item as any;
        const { model: _model, ...pdRest } = providerData;
        return { ...rest, providerData: pdRest };
      }),
    );
    expect(createMock).toHaveBeenCalledWith('conv-123', {
      items: converted,
    });
  });

  it('handles a conversation lifecycle across list, add, pop, and clear', async () => {
    convertToOutputItemMock.mockReturnValueOnce([
      {
        id: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    ] as any);
    convertToOutputItemMock.mockReturnValueOnce([
      {
        id: 'assistant-2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'newest' }],
      },
      {
        id: 'assistant-3',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'newest-2' }],
      },
    ] as any);
    getInputItemsMock.mockReturnValueOnce([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'follow-up' }],
      },
    ] as any);

    const list = vi.fn((_conversationId: string, options: any) => {
      if (options.order === 'asc') {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              id: 'user-1',
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'hi' },
                { type: 'input_image', image_url: 'https://example.com/image' },
                { type: 'input_file', file_id: 'file_123', filename: 'a.txt' },
              ],
            } as any;
            yield {
              id: 'resp-1',
              type: 'message',
              role: 'assistant',
              content: [],
            } as any;
          },
        };
      }

      return {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'resp-2',
            type: 'message',
            role: 'assistant',
            content: [],
          } as any;
        },
      };
    });
    const createItems = vi.fn();
    const deleteItem = vi.fn();
    const createConversation = vi.fn().mockResolvedValue({ id: 'conv-new' });
    const deleteConversation = vi.fn();

    const session = createSession({
      client: {
        conversations: {
          items: {
            list,
            create: createItems,
            delete: deleteItem,
          },
          create: createConversation,
          delete: deleteConversation,
        },
      } as any,
    });

    const items = await session.getItems();

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('conv-new', { order: 'asc' });
    expect(items).toEqual([
      {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' },
          { type: 'input_image', image: 'https://example.com/image' },
          { type: 'input_file', file: { id: 'file_123' }, filename: 'a.txt' },
        ],
      },
      {
        id: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    ]);

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'follow-up' }],
      },
    ] as any);
    expect(getInputItemsMock).toHaveBeenCalled();
    expect(createItems).toHaveBeenCalledWith('conv-new', {
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'follow-up' }],
        },
      ],
    });

    const popped = await session.popItem();
    expect(list).toHaveBeenCalledWith('conv-new', { limit: 1, order: 'desc' });
    expect(deleteItem).toHaveBeenCalledWith('assistant-3', {
      conversation_id: 'conv-new',
    });
    expect(popped?.id).toBe('assistant-3');

    await session.clearSession();
    expect(deleteConversation).toHaveBeenCalledWith('conv-new');
  });
});
