import { getClientToolSearchExecutor } from '@openai/agents-core';
import { describe, it, expect } from 'vitest';
import {
  codeInterpreterTool,
  fileSearchTool,
  imageGenerationTool,
  toolSearchTool,
  webSearchTool,
} from '../src/tools';

describe('Tool', () => {
  it('webSearchTool', () => {
    const t = webSearchTool({
      userLocation: { type: 'approximate', city: 'Tokyo' },
    });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('web_search');
  });

  it('webSearchTool preserves explicit false external web access', () => {
    const t = webSearchTool({
      externalWebAccess: false,
    });
    expect(t).toMatchObject({
      type: 'hosted_tool',
      name: 'web_search',
      providerData: {
        type: 'web_search',
        name: 'web_search',
        search_context_size: 'medium',
        external_web_access: false,
      },
    });
  });

  it('fileSearchTool', () => {
    const t = fileSearchTool(['test'], {});
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('file_search');

    const t2 = fileSearchTool('test', {});
    expect(t2).toBeDefined();
    expect(t2.type).toBe('hosted_tool');
    expect(t2.name).toBe('file_search');
  });

  it('codeInterpreterTool preserves include outputs option', () => {
    const t = codeInterpreterTool({ includeOutputs: true });
    expect(t).toMatchObject({
      type: 'hosted_tool',
      name: 'code_interpreter',
      providerData: {
        type: 'code_interpreter',
        name: 'code_interpreter',
        container: { type: 'auto' },
        include_outputs: true,
      },
    });
  });

  it('imageGenerationTool with gpt-image-1', () => {
    const t = imageGenerationTool({ model: 'gpt-image-1' });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBe('gpt-image-1');
  });

  it('imageGenerationTool with gpt-image-1-mini', () => {
    const t = imageGenerationTool({ model: 'gpt-image-1-mini' });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBe('gpt-image-1-mini');
  });

  it('imageGenerationTool with gpt-image-1.5', () => {
    const t = imageGenerationTool({ model: 'gpt-image-1.5' });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBe('gpt-image-1.5');
  });

  it('imageGenerationTool without model', () => {
    const t = imageGenerationTool();
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBeUndefined();
  });

  it('toolSearchTool', () => {
    const t = toolSearchTool();
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('tool_search');
    expect(t.providerData).toEqual({
      type: 'tool_search',
      name: 'tool_search',
      execution: undefined,
      description: undefined,
      parameters: undefined,
    });
  });

  it('toolSearchTool supports client execution options', () => {
    const t = toolSearchTool({
      execution: 'client',
      description: 'Search local deferred tools.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    });
    expect(t).toMatchObject({
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: {
        type: 'tool_search',
        execution: 'client',
        description: 'Search local deferred tools.',
        parameters: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    });
  });

  it('toolSearchTool attaches client execute handlers', () => {
    const execute = async () => null;
    const t = toolSearchTool({
      execution: 'client',
      execute,
    });

    expect(getClientToolSearchExecutor(t)).toBe(execute);
  });

  it('toolSearchTool rejects execute without client execution', () => {
    expect(() =>
      toolSearchTool({
        execute: async () => null,
      }),
    ).toThrow(
      'toolSearchTool() only supports execute when execution is "client".',
    );
  });

  it('toolSearchTool rejects custom names', () => {
    expect(() =>
      toolSearchTool({
        name: 'client_search' as 'tool_search',
      }),
    ).toThrow(
      'toolSearchTool() only supports the canonical built-in name "tool_search".',
    );
  });
});
