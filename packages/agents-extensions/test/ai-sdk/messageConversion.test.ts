import { describe, test, expect } from 'vitest';
import { protocol, UserError } from '@openai/agents';
import { itemsToLanguageV2Messages } from '../../src/ai-sdk/index';
import { stubModel } from './fixtures';

describe('itemsToLanguageV2Messages', () => {
  test('converts user text and function call items', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hi',
            providerData: { test: { cacheControl: { type: 'ephemeral' } } },
          },
        ],
      } as any,
      {
        type: 'function_call',
        callId: '1',
        name: 'foo',
        arguments: '{}',
        providerData: { a: 1 },
      } as any,
      {
        type: 'function_call_result',
        callId: '1',
        name: 'foo',
        output: { type: 'text', text: 'out' },
        providerData: { b: 2 },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hi',
            providerOptions: { test: { cacheControl: { type: 'ephemeral' } } },
          },
        ],
        providerOptions: {},
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'foo',
            input: {},
            providerOptions: { a: 1 },
          },
        ],
        providerOptions: { a: 1 },
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'foo',
            output: { type: 'text', value: 'out' },
            providerOptions: { b: 2 },
          },
        ],
        providerOptions: { b: 2 },
      },
    ]);
  });

  test('converts assistant refusals to text content', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'refusal',
            refusal: 'I cannot help with that.',
            providerData: { test: { source: 'refusal' } },
          },
        ],
        providerData: { message: { source: 'assistant' } },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'I cannot help with that.',
            providerOptions: { test: { source: 'refusal' } },
          },
        ],
        providerOptions: { message: { source: 'assistant' } },
      },
    ]);
  });

  test('preserves the order of assistant text and refusal content', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Visible A' },
          { type: 'refusal', refusal: 'Blocked B' },
          { type: 'output_text', text: 'Visible C' },
        ],
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Visible A', providerOptions: {} },
          { type: 'text', text: 'Blocked B', providerOptions: {} },
          { type: 'text', text: 'Visible C', providerOptions: {} },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('preserves qualified names for namespaced function calls', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call',
        callId: '1',
        name: 'lookup_account',
        namespace: 'crm',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: '1',
        name: 'lookup_account',
        output: 'crm result',
      } as any,
      {
        type: 'function_call',
        callId: '2',
        name: 'get_shipping_eta',
        namespace: 'get_shipping_eta',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: '2',
        name: 'get_shipping_eta',
        output: 'eta result',
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'crm.lookup_account',
            input: {},
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'crm.lookup_account',
            output: { type: 'text', value: 'crm result' },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '2',
            toolName: 'get_shipping_eta.get_shipping_eta',
            input: {},
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '2',
            toolName: 'get_shipping_eta.get_shipping_eta',
            output: { type: 'text', value: 'eta result' },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts tool_search items into tool call and tool output messages', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'tool_search_call',
        id: 'ts_call',
        status: 'completed',
        arguments: { paths: ['crm'], query: 'lookup account' },
        providerData: { a: 1 },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: { b: 2 },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'ts_call',
            toolName: 'tool_search',
            input: { paths: ['crm'], query: 'lookup account' },
            providerOptions: { a: 1 },
          },
        ],
        providerOptions: { a: 1 },
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'ts_call',
            toolName: 'tool_search',
            output: {
              type: 'json',
              value: {
                status: 'completed',
                tools: [
                  {
                    type: 'tool_reference',
                    functionName: 'lookup_account',
                    namespace: 'crm',
                  },
                ],
              },
            },
            providerOptions: { b: 2 },
          },
        ],
        providerOptions: { b: 2 },
      },
    ]);
  });

  test('matches tool_search outputs by call_id when they arrive out of order', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'tool_search_call',
        id: 'ts_item_1',
        status: 'completed',
        arguments: { paths: ['crm'], query: 'lookup account' },
        providerData: { call_id: 'call_ts_1' },
      } as any,
      {
        type: 'tool_search_call',
        id: 'ts_item_2',
        status: 'completed',
        arguments: { paths: ['billing'], query: 'lookup invoice' },
        providerData: { call_id: 'call_ts_2' },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_2',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: { call_id: 'call_ts_2' },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_1',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: { call_id: 'call_ts_1' },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_ts_1',
          toolName: 'tool_search',
          input: { paths: ['crm'], query: 'lookup account' },
          providerOptions: { call_id: 'call_ts_1' },
        },
        {
          type: 'tool-call',
          toolCallId: 'call_ts_2',
          toolName: 'tool_search',
          input: { paths: ['billing'], query: 'lookup invoice' },
          providerOptions: { call_id: 'call_ts_2' },
        },
      ],
    });
    expect(msgs[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_ts_2',
          toolName: 'tool_search',
          output: {
            type: 'json',
            value: {
              status: 'completed',
              tools: [
                {
                  type: 'tool_reference',
                  functionName: 'lookup_invoice',
                  namespace: 'billing',
                },
              ],
            },
          },
          providerOptions: { call_id: 'call_ts_2' },
        },
      ],
      providerOptions: { call_id: 'call_ts_2' },
    });
    expect(msgs[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_ts_1',
          toolName: 'tool_search',
          output: {
            type: 'json',
            value: {
              status: 'completed',
              tools: [
                {
                  type: 'tool_reference',
                  functionName: 'lookup_account',
                  namespace: 'crm',
                },
              ],
            },
          },
          providerOptions: { call_id: 'call_ts_1' },
        },
      ],
      providerOptions: { call_id: 'call_ts_1' },
    });
  });

  test('does not let server tool_search outputs without call_id hijack pending client searches', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'tool_search_call',
        id: 'ts_call_client',
        status: 'completed',
        arguments: { paths: ['crm'], query: 'lookup account' },
        providerData: { execution: 'client' },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_server',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: { execution: 'server' },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_client',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: { execution: 'client' },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'ts_call_client',
          toolName: 'tool_search',
        },
      ],
    });
    expect(msgs[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'ts_output_server',
          toolName: 'tool_search',
          output: {
            type: 'json',
            value: {
              status: 'completed',
              tools: [
                {
                  type: 'tool_reference',
                  functionName: 'lookup_invoice',
                  namespace: 'billing',
                },
              ],
            },
          },
          providerOptions: { execution: 'server' },
        },
      ],
      providerOptions: { execution: 'server' },
    });
    expect(msgs[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'ts_call_client',
          toolName: 'tool_search',
          output: {
            type: 'json',
            value: {
              status: 'completed',
              tools: [
                {
                  type: 'tool_reference',
                  functionName: 'lookup_account',
                  namespace: 'crm',
                },
              ],
            },
          },
          providerOptions: { execution: 'client' },
        },
      ],
      providerOptions: { execution: 'client' },
    });
  });

  test('reuses hosted tool_search call ids when server outputs omit call_id', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'tool_search_call',
        id: 'ts_call_server',
        status: 'completed',
        arguments: { paths: ['billing'], query: 'lookup invoice' },
        providerData: {
          execution: 'server',
        },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_server',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: { execution: 'server' },
      } as any,
      {
        type: 'function_call',
        callId: 'weather_1',
        name: 'get_weather',
        arguments: '{"city":"Tokyo"}',
        status: 'completed',
      },
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'ts_call_server',
            toolName: 'tool_search',
            input: { paths: ['billing'], query: 'lookup invoice' },
            providerExecuted: true,
            providerOptions: { execution: 'server' },
          },
          {
            type: 'tool-result',
            toolCallId: 'ts_call_server',
            toolName: 'tool_search',
            output: {
              type: 'json',
              value: [
                {
                  type: 'tool_reference',
                  functionName: 'lookup_invoice',
                  namespace: 'billing',
                },
              ],
            },
            providerOptions: { execution: 'server' },
          },
          {
            type: 'tool-call',
            toolCallId: 'weather_1',
            toolName: 'get_weather',
            input: { city: 'Tokyo' },
            providerOptions: {},
          },
        ],
        providerOptions: { execution: 'server' },
      },
    ]);
  });

  test('preserves reasoning order around provider-executed tool search', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Find a weather tool.' }],
        providerData: { anthropic: { signature: 'sig-before-search' } },
      } as any,
      {
        type: 'tool_search_call',
        callId: 'search_1',
        execution: 'server',
        arguments: { query: 'weather' },
        status: 'completed',
      },
      {
        type: 'tool_search_output',
        callId: 'search_1',
        execution: 'server',
        status: 'completed',
        tools: [{ type: 'tool_reference', toolName: 'get_weather' }],
      },
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Call the weather tool.' }],
        providerData: { anthropic: { signature: 'sig-after-search' } },
      } as any,
      {
        type: 'function_call',
        callId: 'weather_1',
        name: 'get_weather',
        arguments: '{"city":"Tokyo"}',
        status: 'completed',
      },
    ];

    const messages = itemsToLanguageV2Messages(stubModel({}), items);
    const assistantContent = messages.flatMap((message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? message.content
        : [],
    );

    expect(assistantContent.map((part) => part.type)).toEqual([
      'reasoning',
      'tool-call',
      'tool-result',
      'reasoning',
      'tool-call',
    ]);
    expect(assistantContent[0]).toMatchObject({
      providerOptions: { anthropic: { signature: 'sig-before-search' } },
    });
    expect(assistantContent[3]).toMatchObject({
      providerOptions: { anthropic: { signature: 'sig-after-search' } },
    });
  });

  test('orders provider-executed tool searches before pending client calls', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call',
        callId: 'weather_1',
        name: 'get_weather',
        arguments: '{"city":"Tokyo"}',
        status: 'completed',
      },
      {
        type: 'tool_search_call',
        id: 'search_1',
        execution: 'server',
        arguments: { query: 'weather tools' },
        status: 'completed',
      },
      {
        type: 'tool_search_output',
        callId: 'search_1',
        execution: 'server',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            toolName: 'get_forecast',
          },
        ],
      },
      {
        type: 'function_call_result',
        callId: 'weather_1',
        name: 'get_weather',
        status: 'completed',
        output: 'sunny',
      },
    ];

    expect(itemsToLanguageV2Messages(stubModel({}), items)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search_1',
            toolName: 'tool_search',
            input: { query: 'weather tools' },
            providerExecuted: true,
            providerOptions: {},
          },
          {
            type: 'tool-result',
            toolCallId: 'search_1',
            toolName: 'tool_search',
            output: {
              type: 'json',
              value: [
                {
                  type: 'tool_reference',
                  toolName: 'get_forecast',
                },
              ],
            },
            providerOptions: {},
          },
          {
            type: 'tool-call',
            toolCallId: 'weather_1',
            toolName: 'get_weather',
            input: { city: 'Tokyo' },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'weather_1',
            toolName: 'get_weather',
            output: { type: 'text', value: 'sunny' },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('flushes a pending provider-executed tool search before the next user turn', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'first question' }],
      } as any,
      {
        type: 'tool_search_call',
        id: 'search_1',
        execution: 'server',
        arguments: { query: 'site tools' },
        status: 'completed',
      } as any,
      {
        type: 'tool_search_output',
        callId: 'search_1',
        execution: 'server',
        status: 'completed',
        tools: [{ type: 'tool_reference', toolName: 'list_sites' }],
      } as any,
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'follow-up question' }],
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);

    // The provider-executed tool search folds its result into a pending
    // assistant message. It must be flushed BEFORE the follow-up user message,
    // otherwise the prompt ends on an assistant turn and Anthropic rejects it
    // as an unintended assistant-message prefill.
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // The folded server tool-use + its result survive the flush intact.
    expect(msgs[1].content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'search_1',
        toolName: 'tool_search',
        input: { query: 'site tools' },
        providerExecuted: true,
        providerOptions: {},
      },
      {
        type: 'tool-result',
        toolCallId: 'search_1',
        toolName: 'tool_search',
        output: {
          type: 'json',
          value: [{ type: 'tool_reference', toolName: 'list_sites' }],
        },
        providerOptions: {},
      },
    ]);
  });

  test('replays provider-executed tool search errors as error results', () => {
    const errorResult = {
      type: 'tool_search_tool_result_error',
      errorCode: 'invalid_pattern',
    };
    const items: protocol.ModelItem[] = [
      {
        type: 'tool_search_call',
        id: 'search_1',
        execution: 'server',
        arguments: { query: '[' },
        status: 'completed',
      },
      {
        type: 'tool_search_output',
        callId: 'search_1',
        execution: 'server',
        status: 'failed',
        tools: [errorResult],
      },
    ];

    expect(itemsToLanguageV2Messages(stubModel({}), items)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search_1',
            toolName: 'tool_search',
            input: { query: '[' },
            providerExecuted: true,
            providerOptions: {},
          },
          {
            type: 'tool-result',
            toolCallId: 'search_1',
            toolName: 'tool_search',
            output: { type: 'error-json', value: errorResult },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('does not queue hosted tool_search calls as pending client searches', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'tool_search_call',
        id: 'ts_call_server',
        status: 'completed',
        arguments: { paths: ['billing'], query: 'lookup invoice' },
        providerData: {
          call_id: 'ts_call_server',
          execution: 'server',
        },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_server',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: { execution: 'server' },
      } as any,
      {
        type: 'tool_search_call',
        id: 'ts_call_client',
        status: 'completed',
        arguments: { paths: ['crm'], query: 'lookup account' },
        providerData: {
          call_id: 'ts_call_client',
          execution: 'client',
        },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_client',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: { execution: 'client' },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'ts_call_client',
          toolName: 'tool_search',
          output: {
            type: 'json',
            value: {
              status: 'completed',
              tools: [
                {
                  type: 'tool_reference',
                  functionName: 'lookup_account',
                  namespace: 'crm',
                },
              ],
            },
          },
          providerOptions: { execution: 'client' },
        },
      ],
      providerOptions: { execution: 'client' },
    });
  });

  test('treats later tool_search outputs with the same call_id as replacements', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'tool_search_call',
        id: 'ts_item_1',
        status: 'completed',
        arguments: { paths: ['crm'], query: 'lookup account' },
        providerData: { call_id: 'call_ts_1' },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_stale',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account_old',
            namespace: 'crm',
          },
        ],
        providerData: { call_id: 'call_ts_1' },
      } as any,
      {
        type: 'tool_search_output',
        id: 'ts_output_fresh',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: { call_id: 'call_ts_1' },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_ts_1',
            toolName: 'tool_search',
            input: { paths: ['crm'], query: 'lookup account' },
            providerOptions: { call_id: 'call_ts_1' },
          },
        ],
        providerOptions: { call_id: 'call_ts_1' },
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_ts_1',
            toolName: 'tool_search',
            output: {
              type: 'json',
              value: {
                status: 'completed',
                tools: [
                  {
                    type: 'tool_reference',
                    functionName: 'lookup_account',
                    namespace: 'crm',
                  },
                ],
              },
            },
            providerOptions: { call_id: 'call_ts_1' },
          },
        ],
        providerOptions: { call_id: 'call_ts_1' },
      },
    ]);
  });

  test('throws on built-in tool calls', () => {
    const items: protocol.ModelItem[] = [
      { type: 'hosted_tool_call', name: 'search' } as any,
    ];
    expect(() => itemsToLanguageV2Messages(stubModel({}), items)).toThrow();
  });

  test('rejects Programmatic Tool Calling caller history', () => {
    const caller = { type: 'program' as const, callerId: 'call_program' };
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        {
          type: 'function_call',
          callId: 'call_function',
          name: 'lookup',
          arguments: '{}',
          caller,
        },
      ]),
    ).toThrow(/does not support Programmatic Tool Calling history/);
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        {
          type: 'function_call_result',
          callId: 'call_function',
          name: 'lookup',
          status: 'completed',
          output: 'ok',
          caller,
        },
      ]),
    ).toThrow(/does not support Programmatic Tool Calling history/);
  });

  test('throws on computer tool calls and results', () => {
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'computer_call' } as any,
      ]),
    ).toThrow(UserError);
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'computer_call_result' } as any,
      ]),
    ).toThrow(UserError);
  });

  test('throws on shell tool calls and results', () => {
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [{ type: 'shell_call' } as any]),
    ).toThrow(UserError);
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'shell_call_output' } as any,
      ]),
    ).toThrow(UserError);
  });

  test('throws on apply_patch tool calls and results', () => {
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'apply_patch_call' } as any,
      ]),
    ).toThrow(UserError);
    expect(() =>
      itemsToLanguageV2Messages(stubModel({}), [
        { type: 'apply_patch_call_output' } as any,
      ]),
    ).toThrow(UserError);
  });

  test('converts user images, function results and reasoning items', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' },
          { type: 'input_image', image: 'http://x/img' },
        ],
      } as any,
      {
        type: 'function_call',
        callId: '1',
        name: 'do',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: '1',
        name: 'do',
        output: { type: 'text', text: 'out' },
      } as any,
      { type: 'reasoning', content: [{ text: 'why' }] } as any,
    ];
    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi', providerOptions: {} },
          {
            type: 'file',
            data: new URL('http://x/img'),
            mediaType: 'image/*',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'do',
            input: {},
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'do',
            output: { type: 'text', value: 'out' },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'why', providerOptions: {} }],
        providerOptions: {},
      },
    ]);
  });

  test('uses namespace-qualified tool names for result-only function_call_result items', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call_result',
        callId: 'call_1',
        name: 'lookup_account',
        namespace: 'billing',
        output: { type: 'text', text: 'found' },
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'billing.lookup_account',
            output: { type: 'text', value: 'found' },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts user data URL images to raw base64 with specific mediaType', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          { type: 'input_image', image: 'data:image/png;base64,aGVsbG8=' },
        ],
      } as any,
    ];
    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: 'aGVsbG8=',
            mediaType: 'image/png',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts v4 user images to tagged file data', () => {
    const imageUrl = 'https://example.com/image.png';
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          { type: 'input_image', image: 'data:image/png;base64,aGVsbG8=' },
          { type: 'input_image', image: imageUrl },
        ],
      } as any,
    ];
    const msgs = itemsToLanguageV2Messages(
      stubModel({}, { specificationVersion: 'v4' }),
      items,
    );

    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: { type: 'data', data: 'aGVsbG8=' },
            mediaType: 'image/png',
            providerOptions: {},
          },
          {
            type: 'file',
            data: { type: 'url', url: new URL(imageUrl) },
            mediaType: 'image/*',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts structured tool output lists', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call',
        callId: 'tool-1',
        name: 'describe_image',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: 'tool-1',
        name: 'describe_image',
        output: [
          { type: 'input_text', text: 'A scenic view.' },
          {
            type: 'input_image',
            image: 'https://example.com/image.png',
          },
          {
            type: 'input_image',
            image: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'describe_image',
            input: {},
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'describe_image',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'A scenic view.' },
                {
                  type: 'media',
                  data: 'https://example.com/image.png',
                  mediaType: 'image/*',
                },
                {
                  type: 'media',
                  data: 'aGVsbG8=',
                  mediaType: 'image/png',
                },
              ],
            },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts V3 image tool outputs and preserves file IDs', () => {
    const imageUrl =
      'https://images.unsplash.com/photo-1505761671935-60b3a7427bad?auto=format&fit=crop&w=400&q=80';
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call',
        callId: 'tool-1',
        name: 'describe_image',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: 'tool-1',
        name: 'describe_image',
        output: [
          { type: 'input_text', text: 'A scenic view.' },
          {
            type: 'input_image',
            image: imageUrl,
          },
          {
            type: 'input_image',
            image: 'data:image/png;base64,aGVsbG8=',
          },
          {
            type: 'input_image',
            image: { id: 'file_image_123' },
          },
        ],
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(
      stubModel({}, { specificationVersion: 'v3' }),
      items,
    );
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'describe_image',
            input: {},
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'describe_image',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'A scenic view.' },
                {
                  type: 'image-url',
                  url: imageUrl,
                },
                {
                  type: 'image-data',
                  data: 'aGVsbG8=',
                  mediaType: 'image/png',
                },
                {
                  type: 'image-file-id',
                  fileId: 'file_image_123',
                },
              ],
            },
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts v4 image tool outputs to canonical file parts', () => {
    const imageUrl = 'https://example.com/image.png';
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call',
        callId: 'tool-1',
        name: 'describe_image',
        arguments: '{}',
      } as any,
      {
        type: 'function_call_result',
        callId: 'tool-1',
        name: 'describe_image',
        output: [
          { type: 'input_text', text: 'A scenic view.' },
          { type: 'input_image', image: imageUrl },
          {
            type: 'input_image',
            image: 'data:image/png;base64,aGVsbG8=',
          },
          { type: 'input_image', image: { id: 'file_image_123' } },
        ],
      } as any,
    ];

    const msgs = itemsToLanguageV2Messages(
      stubModel(
        {},
        { provider: 'openai.responses', specificationVersion: 'v4' },
      ),
      items,
    );
    expect(msgs[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'describe_image',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'A scenic view.' },
              {
                type: 'file',
                data: { type: 'url', url: new URL(imageUrl) },
                mediaType: 'image',
              },
              {
                type: 'file',
                data: { type: 'data', data: 'aGVsbG8=' },
                mediaType: 'image/png',
              },
              {
                type: 'file',
                data: {
                  type: 'reference',
                  reference: { openai: 'file_image_123' },
                },
                mediaType: 'image',
              },
            ],
          },
          providerOptions: {},
        },
      ],
      providerOptions: {},
    });
  });

  test('handles undefined providerData without throwing', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
        providerData: undefined,
      } as any,
    ];
    expect(() => itemsToLanguageV2Messages(stubModel({}), items)).not.toThrow();
    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', providerOptions: {} }],
        providerOptions: {},
      },
    ]);
  });

  test('throws UserError for unsupported content or unknown item type', () => {
    const bad: protocol.ModelItem[] = [
      { role: 'user', content: [{ type: 'bad' as any }] } as any,
    ];
    expect(() => itemsToLanguageV2Messages(stubModel({}), bad)).toThrow(
      UserError,
    );

    const unknown: protocol.ModelItem[] = [{ type: 'bogus' } as any];
    expect(() => itemsToLanguageV2Messages(stubModel({}), unknown)).toThrow(
      UserError,
    );
  });

  test('converts PDF data URL input_file content and preserves ordering', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'before' },
          {
            type: 'input_file',
            file: 'data:application/pdf;base64,JVBERi0xLjQ=',
            filename: 'document.pdf',
          },
          { type: 'input_text', text: 'after' },
        ],
      } as any,
    ];

    expect(itemsToLanguageV2Messages(stubModel({}), items)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before', providerOptions: {} },
          {
            type: 'file',
            data: 'JVBERi0xLjQ=',
            mediaType: 'application/pdf',
            filename: 'document.pdf',
            providerOptions: {},
          },
          { type: 'text', text: 'after', providerOptions: {} },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts a PDF data URL with a case-variant scheme', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: 'DATA:application/pdf;base64,JVBERi0xLjQ=',
          },
        ],
      } as any,
    ];

    expect(itemsToLanguageV2Messages(stubModel({}), items)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: 'JVBERi0xLjQ=',
            mediaType: 'application/pdf',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts public PDF URL input_file content for AI SDK v4', () => {
    const url = 'https://example.com/document.pdf';
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_file', file: { url }, filename: 'download' }],
      } as any,
    ];

    expect(
      itemsToLanguageV2Messages(
        stubModel({}, { specificationVersion: 'v4' }),
        items,
      ),
    ).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: { type: 'url', url: new URL(url) },
            mediaType: 'application/pdf',
            filename: 'download',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('infers PDF media type from a string URL before its filename', () => {
    const url = 'https://example.com/document.pdf';
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_file', file: url, filename: 'download' }],
      } as any,
    ];

    expect(itemsToLanguageV2Messages(stubModel({}), items)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: new URL(url),
            mediaType: 'application/pdf',
            filename: 'download',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('converts raw base64 input_file content with an explicit media type', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: 'JVBERi0xLjQ=',
            filename: 'document.bin',
            providerData: { mediaType: 'application/pdf' },
          },
        ],
      } as any,
    ];

    expect(
      itemsToLanguageV2Messages(
        stubModel({}, { specificationVersion: 'v3' }),
        items,
      ),
    ).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: 'JVBERi0xLjQ=',
            mediaType: 'application/pdf',
            filename: 'document.bin',
            providerOptions: { mediaType: 'application/pdf' },
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('infers PDF media type for raw base64 from its filename', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: 'JVBERi0xLjQ=',
            filename: 'document.pdf',
          },
        ],
      } as any,
    ];

    expect(itemsToLanguageV2Messages(stubModel({}), items)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: 'JVBERi0xLjQ=',
            mediaType: 'application/pdf',
            filename: 'document.pdf',
            providerOptions: {},
          },
        ],
        providerOptions: {},
      },
    ]);
  });

  test('does not use media type metadata scoped to a different model', () => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: 'JVBERi0xLjQ=',
            providerData: {
              model: 'other:model',
              mediaType: 'application/pdf',
            },
          },
        ],
      } as any,
    ];

    expect(() => itemsToLanguageV2Messages(stubModel({}), items)).toThrow(
      /providerData\.mediaType/,
    );
  });

  test.each([
    {
      name: 'local path',
      file: './document.pdf',
      filename: 'document.pdf',
    },
    {
      name: 'typoed URL',
      file: 'https//example.com/document.pdf',
      providerData: { mediaType: 'application/pdf' },
    },
    {
      name: 'string file ID',
      file: 'file_123',
      filename: 'document.pdf',
    },
    {
      name: 'empty data',
      file: '',
      providerData: { mediaType: 'application/pdf' },
    },
    {
      name: 'invalid base64 length',
      file: 'abcde',
      filename: 'document.pdf',
    },
  ])(
    'rejects invalid raw base64 input_file content: $name',
    ({ file, filename, providerData }) => {
      const items: protocol.ModelItem[] = [
        {
          role: 'user',
          content: [{ type: 'input_file', file, filename, providerData }],
        } as any,
      ];

      expect(() => itemsToLanguageV2Messages(stubModel({}), items)).toThrow(
        /valid non-empty raw base64 data/,
      );
    },
  );

  test.each([
    {
      name: 'OpenAI file ID',
      file: { id: 'file_123' },
      error: /OpenAI file IDs are not supported/,
    },
    {
      name: 'private URL scheme',
      file: 'file:///tmp/document.pdf',
      error: /public HTTP\(S\) URL/,
    },
    {
      name: 'raw data without media type',
      file: 'JVBERi0xLjQ=',
      error: /providerData\.mediaType/,
    },
    {
      name: 'non-base64 data URL',
      file: 'data:application/pdf,document',
      error: /base64 data URL/,
    },
    {
      name: 'data URL with a misleading base64 parameter',
      file: 'data:application/pdf;notbase64,document',
      error: /base64 data URL/,
    },
    {
      name: 'base64 data URL with invalid characters',
      file: 'data:application/pdf;base64,@@@@',
      error: /valid non-empty raw base64 data/,
    },
    {
      name: 'base64 data URL with invalid length',
      file: 'data:application/pdf;base64,abcde',
      error: /valid non-empty raw base64 data/,
    },
    {
      name: 'base64 data URL with empty data',
      file: 'data:application/pdf;base64,',
      error: /valid non-empty raw base64 data/,
    },
  ])('rejects unsupported input_file content: $name', ({ file, error }) => {
    const items: protocol.ModelItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_file', file }],
      } as any,
    ];

    expect(() => itemsToLanguageV2Messages(stubModel({}), items)).toThrow(
      error,
    );
  });

  test('passes through unknown items via providerData', () => {
    const custom = { role: 'system', content: 'x', providerOptions: { a: 1 } };
    const items: protocol.ModelItem[] = [
      { type: 'unknown', providerData: custom } as any,
    ];
    const msgs = itemsToLanguageV2Messages(stubModel({}), items);
    expect(msgs).toEqual([custom]);
  });
});

describe('Extended thinking / Reasoning support', () => {
  describe('Round-trip conversion (ReasoningItem to AI SDK and back)', () => {
    test('preserves signature in providerData through itemsToLanguageV2Messages', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'My reasoning process...' }],
          providerData: { anthropic: { signature: 'preserved_sig_456' } },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(stubModel({}), items);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'My reasoning process...',
            providerOptions: { anthropic: { signature: 'preserved_sig_456' } },
          },
        ],
        providerOptions: { anthropic: { signature: 'preserved_sig_456' } },
      });
    });

    test('does not duplicate signed reasoning across parallel tool calls', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Plan both calls.' }],
          providerData: { anthropic: { signature: 'sig_parallel' } },
        } as any,
        {
          type: 'function_call',
          callId: 'call_1',
          name: 'search',
          arguments: '{}',
        } as any,
        {
          type: 'function_call',
          callId: 'call_2',
          name: 'search',
          arguments: '{}',
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(stubModel({}), items);

      expect(msgs).toHaveLength(2);
      const reasoningAssistant = msgs[0];
      const toolAssistant = msgs[1];
      if (
        reasoningAssistant.role !== 'assistant' ||
        toolAssistant.role !== 'assistant'
      ) {
        throw new Error('Expected assistant messages');
      }
      const reasoningParts = [
        ...reasoningAssistant.content,
        ...toolAssistant.content,
      ].filter((part) => part.type === 'reasoning');
      expect(reasoningParts).toHaveLength(1);
      expect(reasoningAssistant.content).toEqual([
        {
          type: 'reasoning',
          text: 'Plan both calls.',
          providerOptions: { anthropic: { signature: 'sig_parallel' } },
        },
      ]);
      expect(toolAssistant.content).toEqual([
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'search',
          input: {},
          providerOptions: {},
        },
        {
          type: 'tool-call',
          toolCallId: 'call_2',
          toolName: 'search',
          input: {},
          providerOptions: {},
        },
      ]);
    });

    test('omits providerOptions when providerData model does not match target model', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'function_call',
          callId: 'c1',
          name: 'foo',
          arguments: '{}',
          providerData: { model: 'anthropic:claude-3' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'google', modelId: 'gemini-2.0-pro' }),
        items,
      );
      expect(msgs).toHaveLength(1);
      const assistant = msgs[0];
      if (assistant.role !== 'assistant') {
        throw new Error('Expected assistant message');
      }
      expect((assistant as any).content[0].providerOptions).toEqual({});
    });

    test('preserves Gemini thoughtSignature in providerOptions when model matches', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'function_call',
          callId: 'c1',
          name: 'foo',
          arguments: '{}',
          providerData: {
            model: 'google:gemini-2.0-pro',
            google: { thoughtSignature: 'sig-123' },
          },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'google', modelId: 'gemini-2.0-pro' }),
        items,
      );
      const assistant = msgs[0] as any;
      expect(assistant.content[0].providerOptions).toMatchObject({
        google: { thoughtSignature: 'sig-123' },
      });
    });

    test('bundles reasoning with tool call for DeepSeek Reasoner', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Internal chain.' }],
          providerData: {
            model: 'deepseek:deepseek-reasoner',
            deepseek: { signature: 'sig' },
          },
        } as any,
        {
          type: 'function_call',
          callId: 'c1',
          name: 'foo',
          arguments: '{}',
          providerData: {
            model: 'deepseek:deepseek-reasoner',
            deepseek: { signature: 'sig' },
          },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-reasoner' }),
        items,
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Internal chain.',
              providerOptions: { deepseek: { signature: 'sig' } },
            },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'foo',
              input: {},
              providerOptions: { deepseek: { signature: 'sig' } },
            },
          ],
          providerOptions: { deepseek: { signature: 'sig' } },
        },
      ]);
    });

    test('bundles reasoning with tool call when DeepSeek thinking mode is enabled', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Thinking...' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c2',
          name: 'bar',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Thinking...',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c2',
              toolName: 'bar',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('bundles reasoning when DeepSeek thinking flag is a string', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Thinking as a flag.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-string',
          name: 'flagged',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: 'enabled' } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Thinking as a flag.',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c-string',
              toolName: 'flagged',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('bundles reasoning when DeepSeek thinking is nested', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Nested thinking.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-nested',
          name: 'nested',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { deepseek: { thinking: { type: 'enabled' } } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Nested thinking.',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c-nested',
              toolName: 'nested',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('bundles reasoning when DeepSeek thinking lives under providerOptions', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [
            {
              type: 'input_text',
              text: 'Provider options thinking.',
            },
          ],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-provider-options',
          name: 'viaOptions',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        {
          providerData: {
            providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
          },
        },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Provider options thinking.',
              providerOptions: {},
            },
            {
              type: 'tool-call',
              toolCallId: 'c-provider-options',
              toolName: 'viaOptions',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('emits pending DeepSeek reasoning with assistant text when no tool call follows', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Thinking in order.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Here is the reply.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Thinking in order.',
              providerOptions: {},
            },
            {
              type: 'text',
              text: 'Here is the reply.',
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('emits pending DeepSeek reasoning before tool calls when assistant text precedes tools', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Initial reasoning.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Responding first.' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-before-tools',
          name: 'afterMessage',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Initial reasoning.',
              providerOptions: {},
            },
            {
              type: 'text',
              text: 'Responding first.',
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c-before-tools',
              toolName: 'afterMessage',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('does not bundle reasoning when DeepSeek thinking is disabled', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Disabled thinking' }],
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
        {
          type: 'function_call',
          callId: 'c-off',
          name: 'offTool',
          arguments: '{}',
          providerData: { model: 'deepseek:deepseek-chat' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'deepseek', modelId: 'deepseek-chat' }),
        items,
        { providerData: { deepseek: { thinking: { type: 'disabled' } } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Disabled thinking',
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c-off',
              toolName: 'offTool',
              input: {},
              providerOptions: {},
            },
          ],
          providerOptions: {},
        },
      ]);
    });

    test('does not bundle reasoning for non-DeepSeek models even when thinking is set', () => {
      const items: protocol.ModelItem[] = [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Other chain' }],
          providerData: { vendor: 'other' },
        } as any,
        {
          type: 'function_call',
          callId: 'c3',
          name: 'baz',
          arguments: '{}',
          providerData: { vendor: 'other' },
        } as any,
      ];

      const msgs = itemsToLanguageV2Messages(
        stubModel({}, { provider: 'other', modelId: 'some-reasoner' }),
        items,
        { providerData: { thinking: { type: 'enabled' } } },
      );

      expect(msgs).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Other chain',
              providerOptions: { vendor: 'other' },
            },
          ],
          providerOptions: { vendor: 'other' },
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c3',
              toolName: 'baz',
              input: {},
              providerOptions: { vendor: 'other' },
            },
          ],
          providerOptions: { vendor: 'other' },
        },
      ]);
    });
  });
});
