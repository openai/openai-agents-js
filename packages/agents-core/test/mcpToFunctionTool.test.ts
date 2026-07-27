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

  it('passes the tool call signal to MCP calls', async () => {
    const callTool = vi.fn(async () => [{ type: 'text', text: 'legacy' }]);
    const callToolResult = vi.fn(async () => ({
      content: [{ type: 'text', text: 'structured' }],
      structuredContent: { answer: 42 },
    }));
    const signal = new AbortController().signal;
    const legacyTool = mcpToFunctionTool(
      {
        name: 'legacy_signal',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      {
        name: 'legacy-signal-server',
        cacheToolsList: false,
        connect: async () => {},
        close: async () => {},
        listTools: async () => [],
        callTool,
        invalidateToolsCache: async () => {},
      },
      false,
    );
    const structuredTool = mcpToFunctionTool(
      {
        name: 'structured_signal',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      {
        name: 'structured-signal-server',
        cacheToolsList: false,
        useStructuredContent: true,
        connect: async () => {},
        close: async () => {},
        listTools: async () => [],
        callTool,
        callToolResult,
        invalidateToolsCache: async () => {},
      },
      false,
    );

    await legacyTool.invoke(new RunContext({}), '{}', { signal });
    await structuredTool.invoke(new RunContext({}), '{}', { signal });

    expect(callTool).toHaveBeenCalledWith('legacy_signal', {}, undefined, {
      signal,
    });
    expect(callToolResult).toHaveBeenCalledWith(
      'structured_signal',
      {},
      undefined,
      { signal },
    );
  });

  it('preserves MCP call arity when no signal is present', async () => {
    const callTool = vi.fn(async () => [{ type: 'text', text: 'ok' }]);
    const tool = mcpToFunctionTool(
      {
        name: 'no_signal',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      {
        name: 'no-signal-server',
        cacheToolsList: false,
        connect: async () => {},
        close: async () => {},
        listTools: async () => [],
        callTool,
        invalidateToolsCache: async () => {},
      },
      false,
    );

    await tool.invoke(new RunContext({}), '{}');

    expect(callTool.mock.calls[0]).toEqual(['no_signal', {}]);
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

    const result = await tool.invoke(new RunContext({}), '{}', {
      signal: new AbortController().signal,
    });

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

  it('normalizes an SDK rejection as cancellation when the signal is aborted', async () => {
    const mcpError = Object.assign(
      new Error('MCP error -32001: Request cancelled'),
      { code: -32001 },
    );
    let requestStarted!: () => void;
    const requestStartedPromise = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const callTool = vi.fn(
      (
        _name: string,
        _args: unknown,
        _meta?: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        requestStarted();
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(mcpError), {
            once: true,
          });
        });
      },
    );
    const tool = mcpToFunctionTool(
      {
        name: 'cancelling_tool',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      {
        name: 'cancelling-server',
        cacheToolsList: false,
        connect: async () => {},
        close: async () => {},
        listTools: async () => [],
        callTool: callTool as any,
        invalidateToolsCache: async () => {},
      },
      false,
    );
    const controller = new AbortController();
    const reason = new Error('user aborted');

    const invocation = tool.invoke(new RunContext({}), '{}', {
      signal: controller.signal,
    } as any);
    const outcome = invocation.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error) => ({ kind: 'rejected' as const, error }),
    );
    await requestStartedPromise;
    controller.abort(reason);

    expect(await outcome).toEqual({ kind: 'rejected', error: reason });
  });

  it('keeps non-cancellation SDK errors on the normal error path', async () => {
    const serverError = Object.assign(new Error('MCP error -32603: boom'), {
      code: -32603,
    });
    const tool = mcpToFunctionTool(
      {
        name: 'failing_tool',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      } as any,
      {
        name: 'failing-server',
        cacheToolsList: false,
        connect: async () => {},
        close: async () => {},
        listTools: async () => [],
        callTool: async () => {
          throw serverError;
        },
        invalidateToolsCache: async () => {},
      },
      false,
    );

    const result = await tool.invoke(new RunContext({}), '{}');

    expect(String(result)).toContain('An error occurred');
  });
});
