import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  getToolChoice,
  converTool,
  getInputItems,
  convertToOutputItem,
} from '../src/openaiResponsesModel';
import { UserError } from '@openai/agents-core';

describe('getToolChoice', () => {
  it('returns default choices', () => {
    expect(getToolChoice('auto')).toBe('auto');
    expect(getToolChoice('required')).toBe('required');
    expect(getToolChoice('none')).toBe('none');
  });

  it('handles hosted tool choices', () => {
    expect(getToolChoice('file_search')).toEqual({ type: 'file_search' });
    expect(getToolChoice('web_search')).toEqual({
      type: 'web_search',
    });
    expect(getToolChoice('web_search_preview')).toEqual({
      type: 'web_search_preview',
    });
    expect(getToolChoice('computer_use_preview')).toEqual({
      type: 'computer_use_preview',
    });
  });

  it('supports arbitrary function names', () => {
    expect(getToolChoice('my_func')).toEqual({
      type: 'function',
      name: 'my_func',
    });
  });

  it('returns undefined when omitted', () => {
    expect(getToolChoice(undefined)).toBeUndefined();
  });
});

describe('converTool', () => {
  it('converts function tools', () => {
    const t = converTool({
      type: 'function',
      name: 'f',
      description: 'd',
      parameters: {},
    } as any);
    expect(t.tool).toEqual({
      type: 'function',
      name: 'f',
      description: 'd',
      parameters: {},
      strict: undefined,
    });
  });

  it('converts computer tools', () => {
    const t = converTool({
      type: 'computer',
      environment: 'mac',
      dimensions: [100, 200],
    } as any);
    expect(t.tool).toEqual({
      type: 'computer_use_preview',
      environment: 'mac',
      display_width: 100,
      display_height: 200,
    });
  });

  it('converts builtin tools', () => {
    const web = converTool({
      type: 'hosted_tool',
      providerData: {
        type: 'web_search',
        user_location: {},
        search_context_size: 'low',
      },
    } as any);
    expect(web.tool).toEqual({
      type: 'web_search',
      user_location: {},
      search_context_size: 'low',
    });

    const file = converTool({
      type: 'hosted_tool',
      providerData: {
        type: 'file_search',
        vector_store_ids: ['v'],
        max_num_results: 5,
        include_search_results: true,
      },
    } as any);
    expect(file.tool).toEqual({
      type: 'file_search',
      vector_store_ids: ['v'],
      max_num_results: 5,
      ranking_options: undefined,
      filters: undefined,
    });
    expect(file.include).toEqual(['file_search_call.results']);

    const code = converTool({
      type: 'hosted_tool',
      providerData: { type: 'code_interpreter', container: 'python' },
    } as any);
    expect(code.tool).toEqual({
      type: 'code_interpreter',
      container: 'python',
    });

    const img = converTool({
      type: 'hosted_tool',
      providerData: { type: 'image_generation', background: 'auto' },
    } as any);
    expect(img.tool).toEqual({
      type: 'image_generation',
      background: 'auto',
      input_image_mask: undefined,
      model: undefined,
      moderation: undefined,
      output_compression: undefined,
      output_format: undefined,
      partial_images: undefined,
      quality: undefined,
      size: undefined,
    });

    const custom = converTool({
      type: 'hosted_tool',
      providerData: {
        type: 'mcp',
        server_label: 'deepwiki',
        server_url: 'https://mcp.deepwiki.com/mcp',
        require_approval: 'never',
      },
    } as any);

    expect(custom.tool).toEqual({
      type: 'mcp',
      server_label: 'deepwiki',
      server_url: 'https://mcp.deepwiki.com/mcp',
      require_approval: 'never',
    });
  });

  it('throws on unsupported tool', () => {
    expect(() => converTool({ type: 'other' } as any)).toThrow();
  });
});

describe('getInputItems', () => {
  it('converts messages and tool calls/results', () => {
    const items = getInputItems([
      { role: 'user', content: 'hi', id: 'u1' },
      {
        type: 'function_call',
        id: 'f1',
        name: 'fn',
        callId: 'c1',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_result',
        id: 'fr1',
        callId: 'c1',
        output: { type: 'text', text: 'ok' },
      },
      {
        type: 'computer_call',
        id: 'cc1',
        callId: 'c2',
        action: 'open',
        status: 'completed',
      },
      {
        type: 'computer_call_result',
        id: 'cr1',
        callId: 'c2',
        output: { data: 'img' },
      },
      { type: 'reasoning', id: 'r1', content: [{ text: 'why' }] },
    ] as any);

    expect(items[0]).toEqual({ id: 'u1', role: 'user', content: 'hi' });
    expect(items[1]).toMatchObject({ type: 'function_call', name: 'fn' });
    expect(items[2]).toMatchObject({
      type: 'function_call_output',
      output: 'ok',
    });
    expect(items[3]).toMatchObject({ type: 'computer_call', action: 'open' });
    expect(items[4]).toMatchObject({ type: 'computer_call_output' });
    expect(items[5]).toMatchObject({ type: 'reasoning' });
  });

  it('converts structured tool outputs into input items', () => {
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'c2',
        output: [
          { type: 'input_text', text: 'hello' },
          {
            type: 'input_image',
            image: 'https://example.com/img.png',
            detail: 'auto',
          },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'c2',
      output: [
        { type: 'input_text', text: 'hello' },
        {
          type: 'input_image',
          image_url: 'https://example.com/img.png',
          detail: 'auto',
        },
      ],
    });
  });

  it('passes through unknown image detail values', () => {
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'c3',
        output: [
          {
            type: 'input_image',
            image: 'https://example.com/custom.png',
            detail: 'creative+1',
          },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'c3',
      output: [
        {
          type: 'input_image',
          image_url: 'https://example.com/custom.png',
          detail: 'creative+1',
        },
      ],
    });
  });

  it('converts structured image outputs with file ids', () => {
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'c4',
        output: [
          {
            type: 'input_image',
            image: { id: 'file_abc' },
          },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'c4',
      output: [
        {
          type: 'input_image',
          file_id: 'file_abc',
        },
      ],
    });
  });

  it('converts ToolOutputImage data from Uint8Array', () => {
    const bytes = Buffer.from('ai-image');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'c5',
        output: {
          type: 'image',
          image: {
            data: new Uint8Array(bytes),
            mediaType: 'image/png',
          },
        },
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'c5',
      output: [
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${bytes.toString('base64')}`,
        },
      ],
    });
  });

  it('preserves filenames for inline input_file data', () => {
    const base64 = Buffer.from('file-payload').toString('base64');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'c6',
        output: [
          {
            type: 'input_file',
            file: `data:application/pdf;base64,${base64}`,
            filename: 'system-card.pdf',
          },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'c6',
      output: [
        {
          type: 'input_file',
          file_data: `data:application/pdf;base64,${base64}`,
          filename: 'system-card.pdf',
        },
      ],
    });
  });

  it('preserves filenames for legacy ToolOutputFileContent values', () => {
    const bytes = Buffer.from('legacy file data');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'c7',
        output: {
          type: 'file',
          file: {
            data: new Uint8Array(bytes),
            mediaType: 'application/pdf',
            filename: 'legacy.pdf',
          },
        },
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'c7',
      output: [
        {
          type: 'input_file',
          file_data: `data:application/pdf;base64,${bytes.toString('base64')}`,
          filename: 'legacy.pdf',
        },
      ],
    });
  });

  it('converts built-in tool calls', () => {
    const web = getInputItems([
      {
        type: 'hosted_tool_call',
        id: 'w',
        status: 'completed',
        providerData: { type: 'web_search' },
      },
    ] as any);
    expect(web[0]).toMatchObject({ type: 'web_search_call' });

    const webCall = getInputItems([
      {
        type: 'hosted_tool_call',
        id: 'w',
        status: 'completed',
        providerData: { type: 'web_search_call' },
      },
    ] as any);
    expect(webCall[0]).toMatchObject({ type: 'web_search_call' });

    const file = getInputItems([
      {
        type: 'hosted_tool_call',
        id: 'f',
        status: 'completed',
        providerData: { type: 'file_search', queries: [] },
      },
    ] as any);
    expect(file[0]).toMatchObject({ type: 'file_search_call', queries: [] });

    const ci = getInputItems([
      {
        type: 'hosted_tool_call',
        id: 'c',
        status: 'completed',
        providerData: { type: 'code_interpreter', code: 'print()' },
      },
    ] as any);
    expect(ci[0]).toMatchObject({
      type: 'code_interpreter_call',
      code: 'print()',
    });

    const img = getInputItems([
      {
        type: 'hosted_tool_call',
        id: 'i',
        status: 'completed',
        providerData: { type: 'image_generation', result: 'img' },
      },
    ] as any);
    expect(img[0]).toMatchObject({
      type: 'image_generation_call',
      result: 'img',
    });
  });

  it('converts legacy tool outputs for functions', () => {
    const items = getInputItems([
      {
        type: 'function_call_result',
        id: 'f',
        callId: 'c',
        output: { type: 'image', image: 'https://example.com/tool.png' },
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'c',
      output: [
        {
          type: 'input_image',
          image_url: 'https://example.com/tool.png',
        },
      ],
    });
  });

  it('errors on unsupported built-in tool', () => {
    expect(() =>
      getInputItems([
        {
          type: 'hosted_tool_call',
          id: 'b',
          providerData: { type: 'other' },
        },
      ] as any),
    ).toThrow(UserError);
  });
});

describe('convertToOutputItem', () => {
  it('converts output items', () => {
    const out = convertToOutputItem([
      {
        type: 'message',
        id: 'm',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }],
        status: 'completed',
      },
      {
        type: 'function_call',
        id: 'f',
        call_id: 'c',
        name: 'fn',
        arguments: '{}',
        status: 'completed',
      },
      { type: 'web_search_call', id: 'w', status: 'completed' },
      {
        type: 'computer_call',
        id: 'cc',
        call_id: 'x',
        action: 'open',
        status: 'completed',
        pending_safety_checks: [],
      },
    ] as any);
    expect(out[0]).toMatchObject({ type: 'message', role: 'assistant' });
    expect(out[1]).toMatchObject({ type: 'function_call', name: 'fn' });
    expect(out[2]).toMatchObject({
      type: 'hosted_tool_call',
      name: 'web_search_call',
    });
    expect(out[3]).toMatchObject({ type: 'computer_call' });
  });

  it('rejects unknown message content', () => {
    expect(() =>
      convertToOutputItem([
        {
          type: 'message',
          id: 'm',
          role: 'assistant',
          content: [{ type: 'other' }],
          status: 'completed',
        },
      ] as any),
    ).toThrow();
  });

  it('converts function_call_output items into function_call_result entries', () => {
    const out = convertToOutputItem([
      {
        type: 'function_call_output',
        id: 'out-1',
        call_id: 'call-1',
        name: 'lookup',
        output: 'done',
      } as any,
    ]);

    expect(out[0]).toMatchObject({
      type: 'function_call_result',
      id: 'out-1',
      callId: 'call-1',
      name: 'lookup',
      output: 'done',
      status: 'completed',
    });
  });

  it('converts structured function_call_output payloads into structured outputs', () => {
    const out = convertToOutputItem([
      {
        type: 'function_call_output',
        id: 'out-2',
        call_id: 'call-2',
        function_name: 'search',
        status: 'in_progress',
        output: [
          { type: 'input_text', text: 'hello' },
          {
            type: 'input_image',
            image_url: 'https://example.com/img.png',
            detail: 'high',
          },
          {
            type: 'input_file',
            file_url: 'https://example.com/file.txt',
            filename: 'file.txt',
          },
        ],
      } as any,
    ]);

    expect(out[0]).toMatchObject({
      type: 'function_call_result',
      callId: 'call-2',
      name: 'search',
      status: 'in_progress',
      output: [
        { type: 'input_text', text: 'hello' },
        {
          type: 'input_image',
          image: 'https://example.com/img.png',
          detail: 'high',
        },
        {
          type: 'input_file',
          file: { url: 'https://example.com/file.txt' },
          filename: 'file.txt',
        },
      ],
    });
  });
});
