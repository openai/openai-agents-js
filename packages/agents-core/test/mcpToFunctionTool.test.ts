import { describe, expect, it, vi } from 'vitest';

import { mcpToFunctionTool, MCPServer } from '../src/mcp';
import { RunContext } from '../src/runContext';

describe('mcpToFunctionTool', () => {
  it('builds strict and non-strict tools based on schema settings', () => {
    const server: MCPServer = {
      name: 'stub',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [],
      invalidateToolsCache: async () => {},
    };

    const strictTool = mcpToFunctionTool(
      {
        name: 'strict',
        description: '',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: [],
          additionalProperties: true,
        },
      } as any,
      server,
      false,
    );

    expect(strictTool.strict).toBe(true);
    expect(strictTool.parameters.additionalProperties).toBe(false);

    const nonStrictTool = mcpToFunctionTool(
      {
        name: 'non-strict',
        description: '',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    expect(nonStrictTool.strict).toBe(false);
    expect(nonStrictTool.parameters.additionalProperties).toBe(true);
  });

  it('invokes MCP tools and returns single or multiple outputs', async () => {
    const callTool = vi.fn(
      async (toolName: string, args: Record<string, unknown> | null) => {
        if (toolName === 'single') {
          return [{ type: 'text', text: `ok:${String(args?.foo)}` }];
        }
        return [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ];
      },
    );

    const server: MCPServer = {
      name: 'stub',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };

    const single = mcpToFunctionTool(
      {
        name: 'single',
        description: '',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    const multi = mcpToFunctionTool(
      {
        name: 'multi',
        description: '',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    const runContext = new RunContext({});
    const singleResult = await single.invoke(
      runContext,
      JSON.stringify({ foo: 'bar' }),
    );
    expect(callTool).toHaveBeenCalledWith('single', { foo: 'bar' });
    expect(singleResult).toEqual({ type: 'text', text: 'ok:bar' });

    const multiResult = await multi.invoke(
      runContext,
      JSON.stringify({ foo: 'bar' }),
    );
    expect(callTool).toHaveBeenCalledWith('multi', { foo: 'bar' });
    expect(multiResult).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });
});
