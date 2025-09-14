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
    expect(out).toEqual([{ type: 'text', text: 'hello' }, { foo: 1 }]);
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
    expect(out).toEqual({ foo: 1 });
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
    expect(out).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { foo: 1 },
    ]);
  });
});
