import { describe, it, expect } from 'vitest';
import { withTrace } from '../src/tracing';
import { NodeMCPServerStdio } from '../src/shims/mcp-server/node';
import { createStaticToolFilter } from '../src/mcpUtil';
import { getAllMcpTools } from '../src/mcp';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';

class StubServer extends NodeMCPServerStdio {
  public toolList: any[];
  constructor(name: string, tools: any[], filter?: any) {
    super({ command: 'noop', name, toolFilter: filter, cacheToolsList: true });
    this.toolList = tools;
    this.session = {
      listTools: async () => ({ tools: this.toolList }),
      callTool: async () => [],
      close: async () => {},
    } as any;
    this._cacheDirty = true;
  }
  async connect() {}
  async close() {}
}

describe('MCP tool filtering', () => {
  it('static allow/block lists', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'a',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: 'b',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      const server = new StubServer(
        's',
        tools,
        createStaticToolFilter({ allowed: ['a'], blocked: ['b'] }),
      );
      const agent = new Agent({
        name: 'agent',
        instructions: '',
        model: '',
        modelSettings: {},
        tools: [],
        mcpServers: [],
      });
      const runContext = new RunContext();
      const result = await server.listTools(runContext, agent);
      expect(result.map((t) => t.name)).toEqual(['a', 'b']);
    });
  });

  it('callable filter functions', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'good',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: 'bad',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      const filter = (_ctx: any, tool: any) => tool.name !== 'bad';
      const server = new StubServer('s', tools, filter);
      const agent = new Agent({
        name: 'agent',
        instructions: '',
        model: '',
        modelSettings: {},
        tools: [],
        mcpServers: [],
      });
      const runContext = new RunContext();
      const result = await server.listTools(runContext, agent);
      expect(result.map((t) => t.name)).toEqual(['good', 'bad']);
    });
  });

  it('hierarchy across multiple servers', async () => {
    await withTrace('test', async () => {
      const toolsA = [
        {
          name: 'a1',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: 'a2',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      const toolsB = [
        {
          name: 'b1',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      const serverA = new StubServer(
        'A',
        toolsA,
        createStaticToolFilter({ allowed: ['a1'] }),
      );
      const serverB = new StubServer('B', toolsB);
      const agent = new Agent({
        name: 'agent',
        instructions: '',
        model: '',
        modelSettings: {},
        tools: [],
        mcpServers: [],
      });
      const runContext = new RunContext();
      const resultA = await serverA.listTools(runContext, agent);
      const resultB = await serverB.listTools(runContext, agent);
      expect(resultA.map((t) => t.name)).toEqual(['a1', 'a2']);
      expect(resultB.map((t) => t.name)).toEqual(['b1']);
    });
  });

  it('cache interaction with filtering', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'x',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      const server = new StubServer(
        'cache',
        tools,
        createStaticToolFilter({ allowed: ['x'] }),
      );
      const agent = new Agent({
        name: 'agent',
        instructions: '',
        model: '',
        modelSettings: {},
        tools: [],
        mcpServers: [],
      });
      const runContext = new RunContext();
      let result = await server.listTools(runContext, agent);
      expect(result.map((t) => t.name)).toEqual(['x']);
      (server as any).toolFilter = createStaticToolFilter({ allowed: ['y'] });
      result = await server.listTools(runContext, agent);
      expect(result.map((t) => t.name)).toEqual(['x']);
    });
  });

  it('applies filter in getAllMcpTools', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'allow',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: 'block',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      const server = new StubServer(
        'filter',
        tools,
        createStaticToolFilter({ allowed: ['allow'] }),
      );
      const agent = new Agent({
        name: 'agent',
        instructions: '',
        model: '',
        modelSettings: {},
        tools: [],
        mcpServers: [server],
      });
      const runContext = new RunContext();
      const result = await getAllMcpTools([server], false, runContext, agent);
      expect(result.map((t) => t.name)).toEqual(['allow']);
    });
  });
});
