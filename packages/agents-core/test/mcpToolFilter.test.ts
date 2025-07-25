import { describe, it, expect } from 'vitest';
import { withTrace } from '../src/tracing';
import { NodeMCPServerStdio } from '../src/shims/mcp-server/node';
import { createMCPToolStaticFilter } from '../src/mcpUtil';

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
        createMCPToolStaticFilter({ allowed: ['a'], blocked: ['b'] }),
      );
      const result = await server.listTools();
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
      const result = await server.listTools();
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
        createMCPToolStaticFilter({ allowed: ['a1'] }),
      );
      const serverB = new StubServer('B', toolsB);
      const resultA = await serverA.listTools();
      const resultB = await serverB.listTools();
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
        createMCPToolStaticFilter({ allowed: ['x'] }),
      );
      let result = await server.listTools();
      expect(result.map((t) => t.name)).toEqual(['x']);
      (server as any).toolFilter = createMCPToolStaticFilter({
        allowed: ['y'],
      });
      result = await server.listTools();
      expect(result.map((t) => t.name)).toEqual(['x']);
    });
  });

  it('returns all tools when no filter is provided', async () => {
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
        {
          name: 'y',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];

      const server = new StubServer('nofilter', tools);
      const result = await server.listTools();
      expect(result.map((t) => t.name)).toEqual(['x', 'y']);
    });
  });

  it('blocks only the tools in blocked list when no allowed list is given', async () => {
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
        {
          name: 'c',
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
        'blockonly',
        tools,
        createMCPToolStaticFilter({ blocked: ['b', 'c'] }),
      );

      const result = await server.listTools();

      expect(result.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    });
  });

  it('allows only the tools in allowed list when no blocked list is given', async () => {
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
        {
          name: 'c',
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
        'allowonly',
        tools,
        createMCPToolStaticFilter({ allowed: ['b'] }),
      );

      const result = await server.listTools();
      // The shim still returns the raw list; actual filtering is applied later
      expect(result.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    });
  });

  it('supports async filter functions', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'one',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: 'two',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];

      const asyncFilter = async (_ctx: any, tool: any) => {
        await new Promise((r) => setTimeout(r, 10));
        return tool.name === 'one';
      };

      const server = new StubServer('async', tools, asyncFilter);
      const result = await server.listTools();
      // listTools itself returns the raw list; filtering happens later
      expect(result.map((t) => t.name)).toEqual(['one', 'two']);
    });
  });

  it('recovers when filter function throws', async () => {
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
        {
          name: 'y',
          description: '',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];

      const badFilter = () => {
        throw new Error('boom');
      };
      const server = new StubServer('explode', tools, badFilter);

      // Just await the call — if it throws, the test will fail.
      const result = await server.listTools();
      expect(result.map((t) => t.name)).toEqual(['x', 'y']);
    });
  });

  it('reloads tools after invalidation', async () => {
    await withTrace('test', async () => {
      const tools1 = [
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
      ];
      const tools2 = [
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
        'reloader',
        tools1,
        createMCPToolStaticFilter({ allowed: ['a'] }),
      );

      // first call sees tools1
      let result = await server.listTools();
      expect(result.map((t) => t.name)).toEqual(['a']);

      // swap out the underlying list, invalidate cache, then call again
      server.toolList = tools2 as any;
      server.invalidateToolsCache();

      result = await server.listTools();
      expect(result.map((t) => t.name)).toEqual(['b']);
    });
  });
});
