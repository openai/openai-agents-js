import { describe, expect, it, vi } from 'vitest';

import { mcpToFunctionTool, MCPServer } from '../src/mcp';
import { RunContext } from '../src/runContext';
import { withTrace } from '../src/tracing';
import { withCustomSpan } from '../src/tracing/createSpans';
import { getCurrentSpan } from '../src/tracing';

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

  it('forces strict schemas when convertSchemasToStrict is true', () => {
    const server: MCPServer = {
      name: 'strict-server',
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
          additionalProperties: true,
        },
      } as any,
      server,
      true,
    );

    expect(strictTool.strict).toBe(true);
    expect(strictTool.parameters.additionalProperties).toBe(false);
    expect(strictTool.parameters.required).toEqual([]);
  });

  it('annotates the current span when invoking the tool', async () => {
    const server: MCPServer = {
      name: 'annotated',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async (_toolName, args) => [
        { type: 'text', text: JSON.stringify(args) },
      ],
      invalidateToolsCache: async () => {},
    };

    const tool = mcpToFunctionTool(
      {
        name: 'annotated',
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

    await withTrace('mcp-span', async () => {
      await withCustomSpan(
        async () => {
          const runContext = new RunContext({});
          const result = await tool.invoke(
            runContext,
            JSON.stringify({ foo: 'bar' }),
          );
          expect(result).toEqual({ type: 'text', text: '{"foo":"bar"}' });
          expect(getCurrentSpan()?.spanData.mcp_data).toEqual({
            server: 'annotated',
          });
        },
        { data: { name: 'span' } },
      );
    });
  });
});
