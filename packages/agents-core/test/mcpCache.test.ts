import { describe, it, expect } from 'vitest';
import { getAllMcpTools } from '../src/mcp';
import { withTrace } from '../src/tracing';
import { NodeMCPServerStdio } from '../src/shims/mcp-server/node';
import type { CallToolResultContent } from '../src/mcp';

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

      let tools = await getAllMcpTools([server]);
      expect(tools.map((t) => t.name)).toEqual(['a']);

      server.toolList = toolsB;
      tools = await getAllMcpTools([server]);
      expect(tools.map((t) => t.name)).toEqual(['a']);

      server.invalidateToolsCache();
      tools = await getAllMcpTools([server]);
      expect(tools.map((t) => t.name)).toEqual(['b']);
    });
  });
});
