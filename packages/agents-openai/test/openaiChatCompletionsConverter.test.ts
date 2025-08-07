import { describe, test, expect } from 'vitest';
import {
  convertToolChoice,
  extractAllAssistantContent,
  extractAllUserContent,
  itemsToMessages,
  toolToOpenAI,
  convertHandoffTool,
} from '../src/openaiChatCompletionsConverter';
import { protocol, UserError } from '@openai/agents-core';
import type {
  SerializedFunctionTool,
  SerializedHandoff,
  SerializedTool,
} from '@openai/agents-core/model';

/**
 * Tests around the helpers converting internal protocol structures to the
 * shapes expected by OpenAI's Chat Completions API.
 */
describe('itemsToMessages', () => {
  test('converts built-in file_search_call without throwing', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'hosted_tool_call',
        id: 'call1',
        name: 'file_search_call',
        status: 'completed',
        providerData: { queries: ['foo'] },
      } as protocol.HostedToolCallItem,
    ];

    const messages = itemsToMessages(items);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0]).toHaveProperty('tool_calls');
    const call = (messages[0] as any).tool_calls[0];
    expect(call.id).toBe('call1');
    expect(call.function.name).toBe('file_search_call');
    const args = JSON.parse(call.function.arguments);
    expect(args.queries).toEqual(['foo']);
    expect(args.status).toBe('completed');
  });
});

describe('convertToolChoice', () => {
  test('handles undefined and explicit defaults', () => {
    expect(convertToolChoice(undefined)).toBe(undefined);
    expect(convertToolChoice('auto')).toBe('auto');
    expect(convertToolChoice('required')).toBe('required');
    expect(convertToolChoice('none')).toBe('none');
  });

  test('custom name resolves to function choice', () => {
    expect(convertToolChoice('myFunc')).toEqual({
      type: 'function',
      function: { name: 'myFunc' },
    });
  });
});

describe('content extraction helpers', () => {
  test('extractAllUserContent converts supported entries', () => {
    const userContent: protocol.UserMessageItem['content'] = [
      { type: 'input_text', text: 'u1', providerData: { a: 1 } },
      {
        type: 'input_image',
        image: 'http://img',
        providerData: { image_url: { detail: 'auto' } },
      },
      {
        type: 'audio',
        audio: 'abc',
        providerData: { input_audio: { foo: 'bar' } },
      },
    ];
    const converted = extractAllUserContent(userContent);
    expect(converted).toEqual([
      { type: 'text', text: 'u1', a: 1 },
      { type: 'image_url', image_url: { url: 'http://img', detail: 'auto' } },
      { type: 'input_audio', input_audio: { data: 'abc', foo: 'bar' } },
    ]);
  });

  test('extractAllUserContent throws on unknown entry', () => {
    const bad: any = [{ type: 'bad' }];
    expect(() => extractAllUserContent(bad)).toThrow();
  });

  test('extractAllAssistantContent converts supported entries and ignores images/audio', () => {
    const assistantContent: protocol.AssistantMessageItem['content'] = [
      { type: 'output_text', text: 'hi', providerData: { b: 2 } },
      { type: 'refusal', refusal: 'no', providerData: { c: 3 } },
      { type: 'image', image: 'ignored', providerData: { id: 'x' } },
      { type: 'audio', audio: 'ignored', providerData: { id: 'y' } },
    ];
    const converted = extractAllAssistantContent(assistantContent);
    expect(converted).toEqual([
      { type: 'text', text: 'hi', b: 2 },
      { type: 'refusal', refusal: 'no', c: 3 },
    ]);
  });

  test('extractAllAssistantContent throws on unknown entry', () => {
    const bad: any = [{ type: 'bad' }];
    expect(() => extractAllAssistantContent(bad)).toThrow();
  });
});

describe('itemsToMessages', () => {
  test('string input becomes user message', () => {
    expect(itemsToMessages('hello')).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  test('converts user and assistant messages with content', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' },
          { type: 'input_image', image: 'http://img' },
        ],
      } as protocol.UserMessageItem,
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'there' },
          { type: 'image', image: 'ignored' },
        ],
      } as protocol.AssistantMessageItem,
    ];
    const msgs = itemsToMessages(items);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'http://img' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'there' }] },
    ]);
  });

  test('handles function call and result path', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'function_call',
        id: '1',
        callId: 'call1',
        name: 'f',
        arguments: '{}',
        status: 'in_progress',
      } as protocol.FunctionCallItem,
      {
        type: 'function_call_result',
        id: '2',
        callId: 'call1',
        output: { type: 'text', text: 'res' },
      } as protocol.FunctionCallResultItem,
    ];
    const msgs = itemsToMessages(items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: { name: 'f', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call1', content: 'res' },
    ]);
  });

  test('handles built-in file_search_call and errors on unsupported type', () => {
    const good: protocol.ModelItem[] = [
      {
        type: 'hosted_tool_call',
        id: 'call1',
        name: 'file_search_call',
        status: 'completed',
        providerData: { queries: ['foo'] },
      } as protocol.HostedToolCallItem,
    ];
    const msgs = itemsToMessages(good);
    expect(msgs[0]).toHaveProperty('tool_calls');
    const call = (msgs[0] as any).tool_calls[0];
    expect(call.function.name).toBe('file_search_call');

    const bad: protocol.ModelItem[] = [
      {
        type: 'hosted_tool_call',
        id: 'call1',
        name: 'other',
        providerData: {},
      } as protocol.HostedToolCallItem,
    ];
    expect(() => itemsToMessages(bad)).toThrow(UserError);
  });

  test('converts reasoning items into assistant reasoning', () => {
    const items: protocol.ModelItem[] = [
      {
        type: 'reasoning',
        content: [],
        rawContent: [{ type: 'reasoning_text', text: 'why' }],
      } as protocol.ReasoningItem,
    ];
    const msgs = itemsToMessages(items);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        reasoning: 'why',
      },
    ]);
  });
});

describe('tool helpers', () => {
  test('toolToOpenAI rejects non-function tools', () => {
    const tool: SerializedTool = { type: 'builtin' } as any;
    expect(() => toolToOpenAI(tool)).toThrow();
  });

  test('toolToOpenAI maps function tool correctly', () => {
    const tool: SerializedFunctionTool = {
      type: 'function',
      name: 'do',
      description: 'd',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    };
    expect(toolToOpenAI(tool)).toEqual({
      type: 'function',
      function: {
        name: 'do',
        description: 'd',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      },
    });
  });

  test('convertHandoffTool maps fields correctly', () => {
    const handoff: SerializedHandoff = {
      toolName: 'h',
      toolDescription: 'desc',
      inputJsonSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strictJsonSchema: true,
    };
    expect(convertHandoffTool(handoff)).toEqual({
      type: 'function',
      function: {
        name: 'h',
        description: 'desc',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    });
  });
});
