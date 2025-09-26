import { describe, it, expect } from 'vitest';
import { mcpToFunctionTool } from '../src/mcp';
import { NodeMCPServerStdio } from '../src/shims/mcp-server/node';
import type { CallToolResult } from '../src/mcp';

class StubServer extends NodeMCPServerStdio {
  public toolList: any[];
  constructor(name: string, tools: any[], useStructuredContent?: boolean) {
    super({ command: 'noop', name, useStructuredContent });
    this.toolList = tools;
    this.cacheToolsList = false;
  }
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async listTools(): Promise<any[]> {
    this._toolsList = this.toolList;
    return this.toolList;
  }
  async callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResult> {
    // default gets overridden in tests via monkey patching
    return { content: [] } as CallToolResult;
  }
}

describe('MCP structuredContent handling', () => {
  it('omits structuredContent by default and returns single item object', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      false,
    );
    // Patch callTool to return one content and structuredContent
    (server as any).callTool = async () => ({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { foo: 1 },
    });

    const tool = mcpToFunctionTool(
      {
        name: 't',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );

    const out = await tool.invoke({} as any, '{}');
    // when not using structured content, return the single content object
    expect(out).toEqual({ type: 'text', text: 'hello' });
  });

  it('includes structuredContent when enabled: single content -> array with structuredContent appended', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      true,
    );
    (server as any).callTool = async () => ({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { foo: 1 },
    });

    const tool = mcpToFunctionTool(
      {
        name: 't',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );

    const out = await tool.invoke({} as any, '{}');
    expect(out).toEqual(JSON.stringify([{ type: 'text', text: 'hello' }, { foo: 1 }]));
  });

  it('includes structuredContent when enabled: no content -> structuredContent only', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      true,
    );
    (server as any).callTool = async () => ({
      content: [],
      structuredContent: { foo: 1 },
    });

    const tool = mcpToFunctionTool(
      {
        name: 't',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );

    const out = await tool.invoke({} as any, '{}');
    expect(out).toEqual(JSON.stringify({ foo: 1 }));
  });

  it('includes structuredContent when enabled: multiple contents -> array with structuredContent appended', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      true,
    );
    (server as any).callTool = async () => ({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      structuredContent: { foo: 1 },
    });

    const tool = mcpToFunctionTool(
      {
        name: 't',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );

    const out = await tool.invoke({} as any, '{}');
    expect(out).toEqual(JSON.stringify([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { foo: 1 },
    ]));
  });

  it('preserves falsy structuredContent values when enabled', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      true,
    );

    // Test different falsy values
    const falsyValues = [0, false, '', null];
    
    for (const falsyValue of falsyValues) {
      // Test with single content + falsy structuredContent
      (server as any).callTool = async () => ({
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: falsyValue,
      });

      const tool = mcpToFunctionTool(
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        server,
        false,
      );

      const out = await tool.invoke({} as any, '{}');
      expect(out).toEqual(JSON.stringify([{ type: 'text', text: 'hello' }, falsyValue]));
    }

    // Test with no content + falsy structuredContent
    for (const falsyValue of falsyValues) {
      (server as any).callTool = async () => ({
        content: [],
        structuredContent: falsyValue,
      });

      const tool = mcpToFunctionTool(
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        server,
        false,
      );

      const out = await tool.invoke({} as any, '{}');
      expect(out).toEqual(JSON.stringify(falsyValue));
    }
  });

  it('handles undefined structuredContent gracefully', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      true, // useStructuredContent enabled
    );

    // Test with structuredContent explicitly undefined
    (server as any).callTool = async () => ({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: undefined,
    });

    const tool = mcpToFunctionTool(
      {
        name: 't',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );

    const out = await tool.invoke({} as any, '{}');
    // Should return just the content item since structuredContent is undefined
    expect(out).toEqual({ type: 'text', text: 'hello' });
  });

  it('handles mixed scenarios with some tools having structured content', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      true,
    );

    // First call: has structured content
    (server as any).callTool = async () => ({
      content: [{ type: 'text', text: 'with-structured' }],
      structuredContent: { data: 'structured' },
    });

    const tool = mcpToFunctionTool(
      {
        name: 't',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );

    let out = await tool.invoke({} as any, '{}');
    expect(out).toEqual(JSON.stringify([
      { type: 'text', text: 'with-structured' },
      { data: 'structured' },
    ]));

    // Second call: no structured content
    (server as any).callTool = async () => ({
      content: [{ type: 'text', text: 'without-structured' }],
    });

    out = await tool.invoke({} as any, '{}');
    // Should return just the content item when no structuredContent property
    expect(out).toEqual({ type: 'text', text: 'without-structured' });
  });

  it('handles empty content with useStructuredContent disabled', async () => {
    const server = new StubServer(
      's',
      [
        {
          name: 't',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      false, // useStructuredContent disabled
    );

    // Tool returns empty content and structured content
    (server as any).callTool = async () => ({
      content: [],
      structuredContent: { important: 'data' },
    });

    const tool = mcpToFunctionTool(
      {
        name: 't',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      server,
      false,
    );

    const out = await tool.invoke({} as any, '{}');
    // Should return empty array, ignoring structured content when disabled
    expect(out).toEqual([]);
  });
});
