import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  getToolChoice,
  converTool,
  getInputItems,
  convertToOutputItem,
} from '../src/openaiResponsesModel';
import { UserError } from '@openai/agents-core';
import logger from '../src/logger';

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
    expect(getToolChoice('shell')).toEqual({ type: 'shell' });
    expect(getToolChoice('apply_patch')).toEqual({ type: 'apply_patch' });
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

  it('converts shell tools', () => {
    const t = converTool({ type: 'shell', name: 'shell' } as any);
    expect(t.tool).toEqual({ type: 'shell' });
  });

  it('converts apply_patch tools', () => {
    const t = converTool({ type: 'apply_patch', name: 'apply_patch' } as any);
    expect(t.tool).toEqual({ type: 'apply_patch' });
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

    const always = converTool({
      type: 'hosted_tool',
      providerData: {
        type: 'mcp',
        server_label: 'always',
        server_url: 'https://mcp.example.com',
        require_approval: 'always',
      },
    } as any);

    expect(always.tool).toMatchObject({
      type: 'mcp',
      server_label: 'always',
      require_approval: 'always',
    });

    const scoped = converTool({
      type: 'hosted_tool',
      providerData: {
        type: 'mcp',
        server_label: 'scoped',
        server_url: 'https://mcp.example.com',
        require_approval: {
          never: { tool_names: ['alpha'] },
          always: { tool_names: ['beta'] },
        },
      },
    } as any);

    expect(scoped.tool).toMatchObject({
      type: 'mcp',
      server_label: 'scoped',
      require_approval: {
        never: { tool_names: ['alpha'] },
        always: { tool_names: ['beta'] },
      },
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
      {
        type: 'shell_call',
        id: 'sh1',
        callId: 's1',
        status: 'completed',
        action: {
          commands: ['echo hi'],
          timeoutMs: 10,
          maxOutputLength: 5,
        },
      },
      {
        type: 'shell_call_output',
        id: 'sh2',
        callId: 's1',
        output: [
          {
            stdout: 'hi',
            stderr: '',
            outcome: { type: 'exit', exitCode: 0 },
          },
        ],
      },
      {
        type: 'apply_patch_call',
        id: 'ap1',
        callId: 'p1',
        status: 'completed',
        operation: { type: 'delete_file', path: 'tmp.txt' },
      },
      {
        type: 'apply_patch_call_output',
        id: 'ap2',
        callId: 'p1',
        status: 'failed',
        output: 'conflict',
      },
      { type: 'reasoning', id: 'r1', content: [{ text: 'why' }] },
    ] as any);

    expect(items[0]).toEqual({ id: 'u1', role: 'user', content: 'hi' });
    expect(items.some((entry) => entry.type === 'function_call')).toBe(true);
    expect(items.some((entry) => entry.type === 'function_call_output')).toBe(
      true,
    );
    expect(items.some((entry) => entry.type === 'computer_call')).toBe(true);
    expect(items.some((entry) => entry.type === 'computer_call_output')).toBe(
      true,
    );
    const shellCall = items.find((entry) => entry.type === 'shell_call') as any;
    expect(shellCall).toMatchObject({
      type: 'shell_call',
      call_id: 's1',
      action: { commands: ['echo hi'], timeout_ms: 10, max_output_length: 5 },
    });
    const shellCallOutput = items.find(
      (entry) => entry.type === 'shell_call_output',
    ) as any;
    expect(shellCallOutput).toMatchObject({
      type: 'shell_call_output',
      id: 'sh2',
      call_id: 's1',
      output: [
        {
          stdout: 'hi',
          stderr: '',
          outcome: { type: 'exit', exit_code: 0 },
        },
      ],
    });
    const applyPatchCall = items.find(
      (entry) => entry.type === 'apply_patch_call',
    ) as any;
    expect(applyPatchCall).toMatchObject({
      type: 'apply_patch_call',
      call_id: 'p1',
      operation: { type: 'delete_file', path: 'tmp.txt' },
    });
    const applyPatchCallOutput = items.find(
      (entry) => entry.type === 'apply_patch_call_output',
    ) as any;
    expect(applyPatchCallOutput).toMatchObject({
      type: 'apply_patch_call_output',
      call_id: 'p1',
      status: 'failed',
    });
    expect(items.some((entry) => entry.type === 'reasoning')).toBe(true);
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

  it('handles string and fallback outputs for function_call_result', () => {
    const items = getInputItems([
      { type: 'function_call_result', callId: 'str', output: 'ok' },
      { type: 'function_call_result', callId: 'num', output: 42 },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'str',
      output: 'ok',
    });
    expect(items[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'num',
      output: '42',
    });
  });

  it('converts message content arrays for user and assistant roles', () => {
    const items = getInputItems([
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          {
            type: 'input_image',
            image: 'https://example.com/user.png',
          },
          {
            type: 'input_image',
            image: { id: 'file_img' },
            detail: 'high',
          },
          {
            type: 'input_file',
            file: 'data:text/plain;base64,Zm9v',
            filename: 'foo.txt',
          },
          {
            type: 'input_file',
            file: { id: 'file_doc' },
          },
          {
            type: 'input_file',
            file: { url: 'https://example.com/doc.txt' },
          },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: 'done' },
          { type: 'refusal', refusal: 'nope' },
        ],
      },
      {
        id: 's1',
        role: 'system',
        content: 'system',
      },
    ] as any);

    const user = items.find((entry) => (entry as any).role === 'user') as any;
    expect(user.content).toEqual([
      { type: 'input_text', text: 'hello' },
      {
        type: 'input_image',
        image_url: 'https://example.com/user.png',
        detail: 'auto',
      },
      { type: 'input_image', file_id: 'file_img', detail: 'high' },
      {
        type: 'input_file',
        file_data: 'data:text/plain;base64,Zm9v',
        filename: 'foo.txt',
      },
      { type: 'input_file', file_id: 'file_doc' },
      { type: 'input_file', file_url: 'https://example.com/doc.txt' },
    ]);

    const assistant = items.find(
      (entry) =>
        (entry as any).type === 'message' &&
        (entry as any).role === 'assistant',
    ) as any;
    expect(assistant.content).toEqual([
      { type: 'output_text', text: 'done', annotations: [] },
      { type: 'refusal', refusal: 'nope' },
    ]);

    const system = items.find(
      (entry) => (entry as any).role === 'system',
    ) as any;
    expect(system).toMatchObject({
      id: 's1',
      role: 'system',
      content: 'system',
    });
  });

  it('rejects unsupported string file inputs in messages', () => {
    expect(() =>
      getInputItems([
        {
          role: 'user',
          content: [{ type: 'input_file', file: 'file_123' }],
        },
      ] as any),
    ).toThrow(UserError);
  });

  it('converts legacy input_image fields in structured outputs', () => {
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'legacy-images',
        output: [
          { type: 'input_image', imageUrl: 'https://example.com/legacy.png' },
          { type: 'input_image', fileId: 'file_legacy' },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'legacy-images',
      output: [
        { type: 'input_image', image_url: 'https://example.com/legacy.png' },
        { type: 'input_image', file_id: 'file_legacy' },
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

  it('treats raw base64 input_file strings as inline data', () => {
    const base64 = Buffer.from('raw-inline').toString('base64');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'raw-base64',
        output: [
          {
            type: 'input_file',
            file: base64,
            filename: 'inline.txt',
          },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'raw-base64',
      output: [
        {
          type: 'input_file',
          file_data: base64,
          filename: 'inline.txt',
        },
      ],
    });
  });

  it('treats non-http input_file strings as file URLs', () => {
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'file-url',
        output: [
          {
            type: 'input_file',
            file: 'file://local/path.txt',
          },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file-url',
      output: [
        {
          type: 'input_file',
          file_url: 'file://local/path.txt',
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

  it('converts legacy image output variations for functions', () => {
    const base64 = Buffer.from('img-data').toString('base64');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'img1',
        output: { type: 'image', image: { url: 'https://example.com/a.png' } },
      },
      {
        type: 'function_call_result',
        callId: 'img2',
        output: {
          type: 'image',
          image: { data: base64, mediaType: 'image/png' },
        },
      },
      {
        type: 'function_call_result',
        callId: 'img3',
        output: { type: 'image', image: { id: 'file_123' } },
      },
      {
        type: 'function_call_result',
        callId: 'img4',
        output: { type: 'image', imageUrl: 'https://example.com/legacy.png' },
      },
      {
        type: 'function_call_result',
        callId: 'img5',
        output: { type: 'image', fileId: 'file_999' },
      },
      {
        type: 'function_call_result',
        callId: 'img6',
        output: { type: 'image', data: base64 },
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img1',
      output: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
    });
    expect(items[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img2',
      output: [
        { type: 'input_image', image_url: `data:image/png;base64,${base64}` },
      ],
    });
    expect(items[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img3',
      output: [{ type: 'input_image', file_id: 'file_123' }],
    });
    expect(items[3]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img4',
      output: [
        { type: 'input_image', image_url: 'https://example.com/legacy.png' },
      ],
    });
    expect(items[4]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img5',
      output: [{ type: 'input_image', file_id: 'file_999' }],
    });
    expect(items[5]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img6',
      output: [{ type: 'input_image', image_url: base64 }],
    });
  });

  it('converts legacy image outputs with details and binary data', () => {
    const bytes = Buffer.from('binary-image');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'img7',
        output: {
          type: 'image',
          detail: 'high',
          image: { fileId: 'file_nested' },
          providerData: { note: 'meta' },
        },
      },
      {
        type: 'function_call_result',
        callId: 'img8',
        output: {
          type: 'image',
          data: new Uint8Array(bytes),
        },
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img7',
      output: [{ type: 'input_image', file_id: 'file_nested', detail: 'high' }],
    });
    expect(items[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'img8',
      output: [{ type: 'input_image', image_url: bytes.toString('base64') }],
    });
  });

  it('converts legacy file output variations for functions', () => {
    const base64 = Buffer.from('file-data').toString('base64');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'file1',
        output: {
          type: 'file',
          file: 'https://example.com/file.txt',
        },
      },
      {
        type: 'function_call_result',
        callId: 'file2',
        output: {
          type: 'file',
          file: { url: 'https://example.com/other.txt', filename: 'other.txt' },
        },
      },
      {
        type: 'function_call_result',
        callId: 'file3',
        output: { type: 'file', id: 'file_abc', filename: 'legacy.txt' },
      },
      {
        type: 'function_call_result',
        callId: 'file4',
        output: {
          type: 'file',
          fileData: base64,
          mediaType: 'text/plain',
          filename: 'legacy-data.txt',
        },
      },
      {
        type: 'function_call_result',
        callId: 'file5',
        output: {
          type: 'file',
          fileUrl: 'https://example.com/legacy-url.txt',
        },
      },
      {
        type: 'function_call_result',
        callId: 'file6',
        output: {
          type: 'file',
          fileData: new Uint8Array(Buffer.from('binary-data')),
          mediaType: 'application/octet-stream',
        },
      },
      {
        type: 'function_call_result',
        callId: 'file7',
        output: {
          type: 'file',
          fileId: 'file_legacy_id',
        },
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file1',
      output: [
        { type: 'input_file', file_url: 'https://example.com/file.txt' },
      ],
    });
    expect(items[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file2',
      output: [
        {
          type: 'input_file',
          file_url: 'https://example.com/other.txt',
          filename: 'other.txt',
        },
      ],
    });
    expect(items[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file3',
      output: [
        { type: 'input_file', file_id: 'file_abc', filename: 'legacy.txt' },
      ],
    });
    expect(items[3]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file4',
      output: [
        {
          type: 'input_file',
          file_data: `data:text/plain;base64,${base64}`,
          filename: 'legacy-data.txt',
        },
      ],
    });
    expect(items[4]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file5',
      output: [
        {
          type: 'input_file',
          file_url: 'https://example.com/legacy-url.txt',
        },
      ],
    });
    expect(items[5]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file6',
      output: [
        {
          type: 'input_file',
          file_data: `data:application/octet-stream;base64,${Buffer.from(
            'binary-data',
          ).toString('base64')}`,
        },
      ],
    });
    expect(items[6]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file7',
      output: [
        {
          type: 'input_file',
          file_id: 'file_legacy_id',
        },
      ],
    });
  });

  it('converts file outputs with inline data objects and ids', () => {
    const bytes = Buffer.from('inline-data');
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'file8',
        output: {
          type: 'file',
          file: {
            data: bytes.toString('base64'),
            mediaType: 'text/plain',
            filename: 'inline.txt',
          },
        },
      },
      {
        type: 'function_call_result',
        callId: 'file9',
        output: {
          type: 'file',
          file: {
            data: new Uint8Array(bytes),
            mediaType: 'application/octet-stream',
          },
          providerData: { note: 'meta' },
        },
      },
      {
        type: 'function_call_result',
        callId: 'file10',
        output: {
          type: 'file',
          file: { fileId: 'file_nested' },
        },
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file8',
      output: [
        {
          type: 'input_file',
          file_data: `data:text/plain;base64,${bytes.toString('base64')}`,
          filename: 'inline.txt',
        },
      ],
    });
    expect(items[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file9',
      output: [
        {
          type: 'input_file',
          file_data: `data:application/octet-stream;base64,${bytes.toString(
            'base64',
          )}`,
        },
      ],
    });
    expect(items[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'file10',
      output: [{ type: 'input_file', file_id: 'file_nested' }],
    });
  });

  it('converts structured input_file outputs with file objects and legacy fields', () => {
    const items = getInputItems([
      {
        type: 'function_call_result',
        callId: 'structured-files',
        output: [
          { type: 'input_file', file: { id: 'file_obj' } },
          {
            type: 'input_file',
            file: { url: 'https://example.com/file.txt' },
          },
          {
            type: 'input_file',
            fileData: 'Zm9v',
            fileUrl: 'https://example.com/legacy.txt',
            fileId: 'file_legacy',
            filename: 'legacy.txt',
          },
        ],
      },
    ] as any);

    expect(items[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'structured-files',
      output: [
        { type: 'input_file', file_id: 'file_obj' },
        {
          type: 'input_file',
          file_url: 'https://example.com/file.txt',
        },
        {
          type: 'input_file',
          file_data: 'Zm9v',
          file_url: 'https://example.com/legacy.txt',
          file_id: 'file_legacy',
          filename: 'legacy.txt',
        },
      ],
    });
  });

  it('throws on unsupported structured output types', () => {
    expect(() =>
      getInputItems([
        {
          type: 'function_call_result',
          callId: 'unsupported',
          output: [{ type: 'input_audio', data: '...' }],
        },
      ] as any),
    ).toThrow(UserError);
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

  it('converts input_image file_id outputs into protocol images', () => {
    const out = convertToOutputItem([
      {
        type: 'function_call_output',
        id: 'out-2b',
        call_id: 'call-2b',
        output: [{ type: 'input_image', file_id: 'file_abc' }],
      } as any,
    ]);

    expect(out[0]).toMatchObject({
      type: 'function_call_result',
      callId: 'call-2b',
      output: [{ type: 'input_image', image: { id: 'file_abc' } }],
    });
  });

  it('drops invalid input_image items from function_call_output results', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const out = convertToOutputItem([
      {
        type: 'function_call_output',
        id: 'out-3',
        call_id: 'call-3',
        output: [{ type: 'input_image' }, { type: 'input_text', text: 'ok' }],
      } as any,
    ]);

    expect(out[0]).toMatchObject({
      type: 'function_call_result',
      callId: 'call-3',
      output: [{ type: 'input_text', text: 'ok' }],
    });
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('converts file_data and file_id outputs into protocol input_file payloads', () => {
    const out = convertToOutputItem([
      {
        type: 'function_call_output',
        id: 'out-4',
        call_id: 'call-4',
        output: [
          {
            type: 'input_file',
            file_data: 'data:text/plain;base64,Zm9v',
            filename: 'foo.txt',
          },
          { type: 'input_file', file_id: 'file_123' },
        ],
      } as any,
    ]);

    expect(out[0]).toMatchObject({
      type: 'function_call_result',
      callId: 'call-4',
      output: [
        {
          type: 'input_file',
          file: 'data:text/plain;base64,Zm9v',
          filename: 'foo.txt',
        },
        { type: 'input_file', file: { id: 'file_123' } },
      ],
    });
  });

  it('coerces non-array function_call_output outputs to empty strings', () => {
    const out = convertToOutputItem([
      {
        type: 'function_call_output',
        id: 'out-5',
        call_id: 'call-5',
        output: { foo: 'bar' },
      } as any,
    ]);

    expect(out[0]).toMatchObject({
      type: 'function_call_result',
      callId: 'call-5',
      output: '',
    });
  });

  it('converts shell and apply_patch tool items', () => {
    const out = convertToOutputItem([
      {
        type: 'shell_call',
        id: 'sh1',
        call_id: 's1',
        status: 'completed',
        action: { commands: ['echo hi'], timeout_ms: 15, max_output_length: 3 },
      } as any,
      {
        type: 'shell_call_output',
        id: 'sh2',
        call_id: 's1',
        output: [
          {
            stdout: 'hi',
            stderr: '',
            outcome: { type: 'exit', exit_code: 0 },
          },
        ],
      } as any,
      {
        type: 'apply_patch_call',
        id: 'ap1',
        call_id: 'p1',
        status: 'in_progress',
        operation: { type: 'delete_file', path: 'tmp.txt' },
      } as any,
      {
        type: 'apply_patch_call_output',
        id: 'ap2',
        call_id: 'p1',
        status: 'failed',
        output: 'conflict',
      } as any,
    ]);

    expect(out[0]).toMatchObject({
      type: 'shell_call',
      callId: 's1',
      action: { commands: ['echo hi'], timeoutMs: 15, maxOutputLength: 3 },
    });
    expect(out[1]).toMatchObject({
      type: 'shell_call_output',
      callId: 's1',
      output: [
        {
          stdout: 'hi',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
    });
    expect(out[2]).toMatchObject({
      type: 'apply_patch_call',
      callId: 'p1',
      operation: { type: 'delete_file', path: 'tmp.txt' },
    });
    expect(out[3]).toMatchObject({
      type: 'apply_patch_call_output',
      callId: 'p1',
      status: 'failed',
      output: 'conflict',
    });
  });
});
