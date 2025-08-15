import { describe, it, expect } from 'vitest';
import { getAllMcpTools } from '../src/mcp';
import type { FunctionTool } from '../src/tool';
import { withTrace } from '../src/tracing';
import { NodeMCPServerStdio } from '../src/shims/mcp-server/node';
import type { CallToolResultContent } from '../src/mcp';
import { RunContext } from '../src/runContext';
import { Agent } from '../src/agent';

class StubServer extends NodeMCPServerStdio {
  public toolList: any[];
  constructor(name: string, tools: any[]) {
    super({ command: 'noop', name });
    this.toolList = tools;
    this.cacheToolsList = true;
  }
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async listTools(): Promise<any[]> {
    if (this.cacheToolsList && !this._cacheDirty && this._toolsList) {
      return this._toolsList;
    }
    this._cacheDirty = false;
    this._toolsList = this.toolList;
    return this.toolList;
  }
  async callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    return [];
  }
}

describe('MCP tools cache invalidation', () => {
  it('fetches fresh tools after cache invalidation', async () => {
    await withTrace('test', async () => {
      const toolsA = [
        {
          name: 'a',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
      const toolsB = [
        {
          name: 'b',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
      const server = new StubServer('server', toolsA);

      let tools = await getAllMcpTools({
        mcpServers: [server],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'test' }),
      });
      expect(tools.map((t) => t.name)).toEqual(['a']);

      server.toolList = toolsB;
      tools = await getAllMcpTools({
        mcpServers: [server],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'test' }),
      });
      expect(tools.map((t) => t.name)).toEqual(['a']);

      await server.invalidateToolsCache();
      tools = await getAllMcpTools({
        mcpServers: [server],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'test' }),
      });
      expect(tools.map((t) => t.name)).toEqual(['b']);
    });
  });

  it('binds cached tools to the current server instance', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'a',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const serverA = new StubServer('server', tools);
      await getAllMcpTools({
        mcpServers: [serverA],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'test' }),
      });

      const serverB = new StubServer('server', tools);
      let called = false;
      (serverB as any).callTool = async () => {
        called = true;
        return [];
      };

      const cachedTools = (await getAllMcpTools({
        mcpServers: [serverB],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'test' }),
      })) as FunctionTool[];
      await cachedTools[0].invoke({} as any, '{}');

      expect(called).toBe(true);
    });
  });
});
