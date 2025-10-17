import { describe, test, expect } from 'vitest';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import type { MCPServer } from '../src/mcp';

describe('MCP Tools without Trace Context', () => {
  test('should fetch MCP tools without requiring a trace context', async () => {
    // Create a mock MCP server
    const mockMcpServer: MCPServer = {
      name: 'test-mcp-server',
      cacheToolsList: false,
      async connect() {
        return;
      },
      async close() {
        return;
      },
      async listTools() {
        return [
          {
            name: 'test_tool',
            description: 'A test tool',
            inputSchema: {
              type: 'object' as const,
              properties: {
                input: { type: 'string' },
              },
              required: [],
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return [{ type: 'text', text: 'test result' }];
      },
      async invalidateToolsCache() {
        return;
      },
    };

    // Create an agent with MCP server (no trace context)
    const agent = new Agent({
      name: 'test-agent',
      instructions: 'Test agent',
      mcpServers: [mockMcpServer],
    });

    // Create a run context without a trace
    const context = new RunContext({});

    // This should not throw "No existing trace found" error
    const mcpTools = await agent.getMcpTools(context);

    expect(mcpTools).toBeDefined();
    expect(mcpTools.length).toBe(1);
    expect(mcpTools[0].name).toBe('test_tool');
  });

  test('should get all tools including MCP tools without trace context', async () => {
    const mockMcpServer: MCPServer = {
      name: 'test-mcp-server',
      cacheToolsList: false,
      async connect() {
        return;
      },
      async close() {
        return;
      },
      async listTools() {
        return [
          {
            name: 'mcp_tool',
            description: 'An MCP tool',
            inputSchema: {
              type: 'object' as const,
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return [{ type: 'text', text: 'result' }];
      },
      async invalidateToolsCache() {
        return;
      },
    };

    const agent = new Agent({
      name: 'test-agent',
      instructions: 'Test agent',
      mcpServers: [mockMcpServer],
      tools: [],
    });

    const context = new RunContext({});

    // This should work without throwing an error
    const allTools = await agent.getAllTools(context);

    expect(allTools).toBeDefined();
    expect(allTools.length).toBe(1);
    expect(allTools[0].name).toBe('mcp_tool');
  });
});
