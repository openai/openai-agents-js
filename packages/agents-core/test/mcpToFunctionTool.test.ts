import { describe, expect, it, vi } from 'vitest';

import { mcpToFunctionTool, MCPServer } from '../src/mcp';
import type { MCPToolMetaContext } from '../src/mcpUtil';
import { RunContext } from '../src/runContext';
import { sanitizeMcpTransportError } from '../src/mcpLogging';
import { withTrace } from '../src/tracing';
import { withCustomSpan } from '../src/tracing/createSpans';
import { getCurrentSpan } from '../src/tracing';

function convertExpectingStrictFallback(
  convert: () => ReturnType<typeof mcpToFunctionTool>,
): ReturnType<typeof mcpToFunctionTool> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const functionTool = convert();
    expect(warn).toHaveBeenCalledWith(
      'Error converting MCP schema to strict mode:',
      expect.anything(),
    );
    return functionTool;
  } finally {
    warn.mockRestore();
  }
}

describe('mcpToFunctionTool', () => {
  it('preserves non-strict behavior when schema conversion is disabled', () => {
    const server: MCPServer = {
      name: 'stub',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [],
      invalidateToolsCache: async () => {},
    };

    const explicitlyOpenTool = convertExpectingStrictFallback(() =>
      mcpToFunctionTool(
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
      ),
    );

    expect(explicitlyOpenTool.strict).toBe(false);
    expect(explicitlyOpenTool.parameters.additionalProperties).toBe(true);

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

  it('forwards the tool-call abort signal to MCP calls', async () => {
    const callTool = vi.fn(async () => [
      { type: 'text', text: 'legacy output' },
    ]);
    const server: MCPServer = {
      name: 'signal-server',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool,
      invalidateToolsCache: async () => {},
    };
    const tool = mcpToFunctionTool(
      {
        name: 'signal_tool',
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
    const controller = new AbortController();

    await tool.invoke(new RunContext({}), '{}', {
      signal: controller.signal,
    });

    expect(callTool).toHaveBeenCalledWith('signal_tool', {}, undefined, {
      signal: controller.signal,
    });
  });

  it('forwards the tool-call abort signal to full-result MCP calls', async () => {
    const callToolResult = vi.fn(async () => ({
      content: [{ type: 'text', text: 'legacy output' }],
      structuredContent: { answer: 42 },
    }));
    const server: MCPServer = {
      name: 'full-result-signal-server',
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
        name: 'full_result_signal_tool',
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
    const controller = new AbortController();

    await tool.invoke(new RunContext({}), '{}', {
      signal: controller.signal,
    });

    expect(callToolResult).toHaveBeenCalledWith(
      'full_result_signal_tool',
      {},
      undefined,
      { signal: controller.signal },
    );
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
    const endpoint = new URL(
      'https://example.test/mcp?token=META_QUERY#META_FRAGMENT',
    );
    endpoint.username = 'META_USER';
    endpoint.password = 'META_PASSWORD';
    const rawServerName = `streamable-http: ${endpoint.toString()}`;
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
      name: rawServerName,
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
    expect(metaContext.serverName).toBe(rawServerName);
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

  it('keeps URL credentials out of the default model-visible MCP error', async () => {
    const endpointUrl = new URL(
      'https://example.test:8443/mcp?token=ERROR_QUERY#ERROR_FRAGMENT',
    );
    endpointUrl.username = 'ERROR_USER';
    endpointUrl.password = 'ERROR_PASSWORD';
    const endpoint = endpointUrl.toString();
    const server: MCPServer = {
      name: `streamable-http: ${endpoint}`,
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => {
        throw sanitizeMcpTransportError(
          new Error(`request failed for ${endpoint}`),
          endpoint,
          'streamable HTTP tool call',
        );
      },
      invalidateToolsCache: async () => {},
    };
    const tool = mcpToFunctionTool(
      {
        name: 'safe_error',
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

    expect(result).toContain('https://example.test:8443/mcp');
    for (const secret of [
      'ERROR_USER',
      'ERROR_PASSWORD',
      'ERROR_QUERY',
      'ERROR_FRAGMENT',
    ]) {
      expect(result).not.toContain(secret);
    }
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
        },
      } as any,
      server,
      true,
    );

    expect(strictTool.strict).toBe(true);
    expect(strictTool.parameters.additionalProperties).toBe(false);
    expect(strictTool.parameters.required).toEqual(['foo']);
  });

  it.each([
    ['properties omitted', { type: 'object' }],
    ['empty properties', { type: 'object', properties: {} }],
    [
      'explicitly open with declared properties',
      {
        type: 'object',
        properties: { known: { type: 'string' } },
        additionalProperties: true,
      },
    ],
    [
      'schema-valued additional properties',
      {
        type: 'object',
        properties: {},
        additionalProperties: { type: 'string' },
      },
    ],
  ])('falls back for free-form root schemas: %s', (_name, inputSchema) => {
    const server: MCPServer = {
      name: 'free-form-root-server',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [],
      invalidateToolsCache: async () => {},
    };
    const inputSchemaRecord = inputSchema as Record<string, any>;
    const originalSchema = structuredClone(inputSchema);

    const functionTool = convertExpectingStrictFallback(() =>
      mcpToFunctionTool(
        {
          name: 'free_form_root',
          description: '',
          inputSchema,
        } as any,
        server,
        true,
      ),
    );

    expect(functionTool.strict).toBe(false);
    expect(functionTool.parameters).toEqual({
      ...inputSchema,
      type: 'object',
      properties: inputSchemaRecord.properties ?? {},
      required: [],
      additionalProperties:
        'additionalProperties' in inputSchema
          ? inputSchemaRecord.additionalProperties
          : true,
    });
    expect(inputSchema).toEqual(originalSchema);
  });

  it.each([
    [
      'object property',
      {
        type: 'object',
        properties: {
          payload: { type: 'object', properties: {} },
        },
        required: ['payload'],
        additionalProperties: false,
      },
    ],
    [
      'array item',
      {
        type: 'object',
        properties: {
          payload: {
            type: 'array',
            items: { type: 'object' },
          },
        },
        required: ['payload'],
        additionalProperties: false,
      },
    ],
  ])('preserves nested free-form schemas: %s', (_name, inputSchema) => {
    const server: MCPServer = {
      name: 'free-form-nested-server',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [],
      invalidateToolsCache: async () => {},
    };
    const originalSchema = structuredClone(inputSchema);

    const functionTool = convertExpectingStrictFallback(() =>
      mcpToFunctionTool(
        {
          name: 'free_form_nested',
          description: '',
          inputSchema,
        } as any,
        server,
        true,
      ),
    );

    expect(functionTool.strict).toBe(false);
    expect(functionTool.parameters).toEqual(originalSchema);
    expect(inputSchema).toEqual(originalSchema);
  });

  it.each([
    ['empty input schema', {}],
    [
      'explicitly closed empty object',
      { type: 'object', additionalProperties: false },
    ],
    [
      'declared property',
      {
        type: 'object',
        properties: { value: { type: 'string' } },
      },
    ],
  ])('keeps strict-compatible MCP schemas strict: %s', (_name, inputSchema) => {
    const server: MCPServer = {
      name: 'strict-compatible-server',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [],
      invalidateToolsCache: async () => {},
    };
    const inputSchemaRecord = inputSchema as Record<string, any>;

    const functionTool = mcpToFunctionTool(
      {
        name: 'strict_compatible',
        description: '',
        inputSchema,
      } as any,
      server,
      true,
    );

    expect(functionTool.strict).toBe(true);
    expect(functionTool.parameters.additionalProperties).toBe(false);
    expect(functionTool.parameters.required).toEqual(
      Object.keys(inputSchemaRecord.properties ?? {}),
    );
  });

  it('annotates the current span when invoking the tool', async () => {
    const endpoint = new URL(
      'https://example.test:8443/mcp?token=SPAN_QUERY#SPAN_FRAGMENT',
    );
    endpoint.username = 'SPAN_USER';
    endpoint.password = 'SPAN_PASSWORD';
    const rawServerName = `streamable-http: ${endpoint.toString()}`;
    const server: MCPServer = {
      name: rawServerName,
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
            server: 'streamable-http: https://example.test:8443/mcp',
          });
          expect(server.name).toBe(rawServerName);
        },
        { data: { name: 'span' } },
      );
    });
  });
});
