import { describe, expect, it, vi } from 'vitest';

import { mcpToFunctionTool, MCPServer } from '../src/mcp';
import type { MCPToolMetaContext } from '../src/mcpUtil';
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

  it('uses structured MCP output only when explicitly enabled', async () => {
    const callTool = vi.fn(async () => [
      { type: 'text', text: 'legacy output' },
    ]);
    const callToolResult = vi.fn(async () => ({
      content: [{ type: 'text', text: 'legacy output' }],
      structuredContent: { answer: 42 },
    }));
    const server: MCPServer = {
      name: 'structured-output-server',
      cacheToolsList: false,
      useStructuredContent: true,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      callToolResult,
      invalidateToolsCache: async () => {},
    };
    const tool = mcpToFunctionTool(
      {
        name: 'structured',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    await expect(tool.invoke(new RunContext({}), '{}')).resolves.toBe(
      '{"answer":42}',
    );
    expect(callToolResult).toHaveBeenCalledWith('structured', {});
    expect(callTool).not.toHaveBeenCalled();
  });

  it('keeps using legacy content output by default', async () => {
    const callTool = vi.fn(async () => [
      { type: 'text', text: 'legacy output' },
    ]);
    const callToolResult = vi.fn(async () => ({
      content: [{ type: 'text', text: 'legacy output' }],
      structuredContent: { answer: 42 },
    }));
    const server: MCPServer = {
      name: 'legacy-output-server',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      callToolResult,
      invalidateToolsCache: async () => {},
    };
    const tool = mcpToFunctionTool(
      {
        name: 'legacy',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    await expect(tool.invoke(new RunContext({}), '{}')).resolves.toEqual({
      type: 'text',
      text: 'legacy output',
    });
    expect(callTool).toHaveBeenCalledWith('legacy', {});
    expect(callToolResult).not.toHaveBeenCalled();
  });

  it('uses an empty structured MCP output when explicitly enabled', async () => {
    const callToolResult = vi.fn(async () => ({
      content: [{ type: 'text', text: 'legacy output' }],
      structuredContent: {},
    }));
    const server: MCPServer = {
      name: 'empty-structured-output-server',
      cacheToolsList: false,
      useStructuredContent: true,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [{ type: 'text', text: 'legacy output' }],
      callToolResult,
      invalidateToolsCache: async () => {},
    };
    const tool = mcpToFunctionTool(
      {
        name: 'empty_structured',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    await expect(tool.invoke(new RunContext({}), '{}')).resolves.toBe('{}');
  });

  it('preserves MCP error content when structured output is enabled', async () => {
    const callToolResult = vi.fn(async () => ({
      content: [{ type: 'text', text: 'tool error details' }],
      structuredContent: { answer: 42 },
      isError: true,
    }));
    const server: MCPServer = {
      name: 'structured-error-server',
      cacheToolsList: false,
      useStructuredContent: true,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [{ type: 'text', text: 'legacy output' }],
      callToolResult,
      invalidateToolsCache: async () => {},
    };
    const tool = mcpToFunctionTool(
      {
        name: 'structured_error',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    await expect(tool.invoke(new RunContext({}), '{}')).resolves.toEqual({
      type: 'text',
      text: 'tool error details',
    });
  });

  it('falls back to legacy content when a custom server has no full-result method', async () => {
    const callTool = vi.fn(async () => [
      { type: 'text', text: 'legacy output' },
    ]);
    const server: MCPServer = {
      name: 'legacy-custom-server',
      cacheToolsList: false,
      useStructuredContent: true,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };
    const tool = mcpToFunctionTool(
      {
        name: 'legacy_custom',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    await expect(tool.invoke(new RunContext({}), '{}')).resolves.toEqual({
      type: 'text',
      text: 'legacy output',
    });
    expect(callTool).toHaveBeenCalledWith('legacy_custom', {});
  });

  it('resolves and passes MCP tool metadata', async () => {
    const callTool = vi.fn(
      async (
        _toolName: string,
        _args: Record<string, unknown> | null,
        _meta?: Record<string, unknown> | null,
      ) => [{ type: 'text', text: 'ok' }],
    );

    const toolMetaResolver = vi.fn((context) => {
      return {
        request_id: (context.runContext as RunContext<{ requestId: string }>)
          .context.requestId,
        locale: 'ja',
      };
    });

    const server: MCPServer = {
      name: 'stub',
      cacheToolsList: false,
      toolMetaResolver,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };

    const tool = mcpToFunctionTool(
      {
        name: 'meta',
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

    const runContext = new RunContext({ requestId: 'req-123' });
    await tool.invoke(runContext, JSON.stringify({ foo: 'bar' }));

    expect(callTool).toHaveBeenCalledWith(
      'meta',
      { foo: 'bar' },
      { request_id: 'req-123', locale: 'ja' },
    );
    expect(toolMetaResolver).toHaveBeenCalledTimes(1);
    const metaContext = toolMetaResolver.mock.calls[0][0];
    expect(metaContext.runContext).toBe(runContext);
    expect(metaContext.serverName).toBe('stub');
    expect(metaContext.toolName).toBe('meta');
    expect(metaContext.arguments).toEqual({ foo: 'bar' });
  });

  it('can expose an override name while invoking the original MCP tool name', async () => {
    const callTool = vi.fn(
      async (
        _toolName: string,
        _args: Record<string, unknown> | null,
        _meta?: Record<string, unknown> | null,
      ) => [{ type: 'text', text: 'ok' }],
    );

    const toolMetaResolver = vi.fn((_context: MCPToolMetaContext) => ({
      request_id: 'req-123',
    }));

    const server: MCPServer = {
      name: 'docs',
      cacheToolsList: false,
      toolMetaResolver,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };

    const tool = mcpToFunctionTool(
      {
        name: 'search',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
      { toolNameOverride: 'mcp_docs__search' },
    );

    expect(tool.name).toBe('mcp_docs__search');
    await tool.invoke(new RunContext({}), '{}');

    expect(callTool).toHaveBeenCalledWith(
      'search',
      {},
      { request_id: 'req-123' },
    );
    expect(toolMetaResolver.mock.calls[0][0].toolName).toBe('search');
  });

  it('uses server errorFunction for tool failures', async () => {
    const errorFunction = vi.fn(
      ({
        context: _context,
        error: _error,
      }: {
        context: RunContext;
        error: Error | unknown;
      }) => 'custom failure',
    );
    const callTool = vi.fn(async () => {
      throw new Error('boom');
    });

    const server: MCPServer = {
      name: 'error-server',
      cacheToolsList: false,
      errorFunction,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };

    const tool = mcpToFunctionTool(
      {
        name: 'explode',
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
    const result = await tool.invoke(
      runContext,
      JSON.stringify({ foo: 'bar' }),
    );

    expect(result).toBe('custom failure');
    expect(errorFunction).toHaveBeenCalledTimes(1);
    const [errorArgs] = errorFunction.mock.calls[0];
    expect(errorArgs.context).toBe(runContext);
    expect(errorArgs.error).toBeInstanceOf(Error);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('normalizes AbortError-like MCP failures into the default tool error', async () => {
    const callTool = vi.fn(async () => {
      throw new DOMException('synthetic abort', 'AbortError');
    });

    const server: MCPServer = {
      name: 'abort-server',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };

    const tool = mcpToFunctionTool(
      {
        name: 'abort_tool',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    const result = await tool.invoke(new RunContext({}), '{}');

    expect(result).toBe(
      'An error occurred while running the tool. Please try again. Error: AbortError: synthetic abort',
    );
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('rethrows tool failures when server errorFunction is null', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('boom');
    });

    const server: MCPServer = {
      name: 'error-server-null',
      cacheToolsList: false,
      errorFunction: null,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };

    const tool = mcpToFunctionTool(
      {
        name: 'explode',
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
    await expect(
      tool.invoke(runContext, JSON.stringify({ foo: 'bar' })),
    ).rejects.toThrow('boom');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('still rethrows AbortError-like MCP failures when server errorFunction is null', async () => {
    const callTool = vi.fn(async () => {
      throw new DOMException('synthetic abort', 'AbortError');
    });

    const server: MCPServer = {
      name: 'abort-server-null',
      cacheToolsList: false,
      errorFunction: null,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };

    const tool = mcpToFunctionTool(
      {
        name: 'abort_tool',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      server,
      false,
    );

    await expect(tool.invoke(new RunContext({}), '{}')).rejects.toMatchObject({
      name: 'AbortError',
      message: 'synthetic abort',
    });
    expect(callTool).toHaveBeenCalledTimes(1);
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
    expect(strictTool.parameters.required).toEqual(['foo']);
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
