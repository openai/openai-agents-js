import { describe, it, expect, vi } from 'vitest';
import { getAllMcpTools, invalidateServerToolsCache } from '../src/mcp';
import { UserError } from '../src/errors';
import { tool, type FunctionTool } from '../src/tool';
import { withTrace } from '../src/tracing';
import { NodeMCPServerStdio } from '../src/shims/mcp-server/node';
import type { CallToolResultContent, MCPServer } from '../src/mcp';
import { RunContext } from '../src/runContext';
import { Agent } from '../src/agent';
import { handoff } from '../src/handoff';
import { z } from 'zod';

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
    _meta?: Record<string, unknown> | null,
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

  it('clears agent-specific cache entries when cache is invalidated', async () => {
    await withTrace('test', async () => {
      const toolsInitial = [
        {
          name: 'foo_initial',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'bar_initial',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
      const toolsUpdated = [
        {
          name: 'foo_updated',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'bar_updated',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const server = new StubServer('server', toolsInitial);
      server.toolFilter = async (ctx: any, tool: any) => {
        if (ctx.agent.name === 'AgentOne') {
          return tool.name.startsWith('foo');
        }
        return tool.name.startsWith('bar');
      };

      const agentOne = new Agent({ name: 'AgentOne' });
      const agentTwo = new Agent({ name: 'AgentTwo' });
      const ctxOne = new RunContext({});
      const ctxTwo = new RunContext({});

      const initialToolsAgentOne = await getAllMcpTools({
        mcpServers: [server],
        runContext: ctxOne,
        agent: agentOne,
      });
      expect(initialToolsAgentOne.map((t: any) => t.name)).toEqual([
        'foo_initial',
      ]);

      const initialToolsAgentTwo = await getAllMcpTools({
        mcpServers: [server],
        runContext: ctxTwo,
        agent: agentTwo,
      });
      expect(initialToolsAgentTwo.map((t: any) => t.name)).toEqual([
        'bar_initial',
      ]);

      server.toolList = toolsUpdated;
      await server.invalidateToolsCache();

      const updatedToolsAgentOne = await getAllMcpTools({
        mcpServers: [server],
        runContext: ctxOne,
        agent: agentOne,
      });
      expect(updatedToolsAgentOne.map((t: any) => t.name)).toEqual([
        'foo_updated',
      ]);

      const updatedToolsAgentTwo = await getAllMcpTools({
        mcpServers: [server],
        runContext: ctxTwo,
        agent: agentTwo,
      });
      expect(updatedToolsAgentTwo.map((t: any) => t.name)).toEqual([
        'bar_updated',
      ]);
    });
  });

  it('invalidates cached tools via invalidateServerToolsCache', async () => {
    await withTrace('test', async () => {
      let tools = [
        {
          name: 'alpha',
          description: '',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];

      const server: MCPServer = {
        name: 'invalidate-server',
        cacheToolsList: true,
        toolFilter: async () => true,
        async connect() {},
        async close() {},
        async listTools() {
          return tools as any;
        },
        async callTool(
          _toolName: string,
          _args: Record<string, unknown> | null,
          _meta?: Record<string, unknown> | null,
        ) {
          return [];
        },
        async invalidateToolsCache() {},
      };

      const agent = new Agent({ name: 'AgentOne' });
      const runContext = new RunContext({});

      const initial = await getAllMcpTools({
        mcpServers: [server],
        runContext,
        agent,
      });
      expect(initial.map((tool) => tool.name)).toEqual(['alpha']);

      tools = [
        {
          name: 'beta',
          description: '',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];

      await invalidateServerToolsCache('invalidate-server');
      const refreshed = await getAllMcpTools({
        mcpServers: [server],
        runContext,
        agent,
      });
      expect(refreshed.map((tool) => tool.name)).toEqual(['beta']);
    });
  });
});

describe('MCP tools static filters', () => {
  it('filters tools using allowed and blocked tool names', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'alpha',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'beta',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'gamma',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const server = new StubServer('server', tools);
      server.toolFilter = {
        allowedToolNames: ['alpha', 'beta'],
        blockedToolNames: ['beta'],
      };

      const result = await getAllMcpTools({
        mcpServers: [server],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'AgentOne' }),
      });

      expect(result.map((tool) => tool.name)).toEqual(['alpha']);
    });
  });
});

describe('MCP tools uniqueness', () => {
  it('throws when duplicate tool names are found across servers', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'duplicate',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const serverA = new StubServer('server-a', tools);
      const serverB = new StubServer('server-b', tools);

      await expect(
        getAllMcpTools({
          mcpServers: [serverA, serverB],
          runContext: new RunContext({}),
          agent: new Agent({ name: 'AgentOne' }),
        }),
      ).rejects.toBeInstanceOf(UserError);
    });
  });

  it('prefixes local MCP tool names with server names when requested', async () => {
    await withTrace('test', async () => {
      const serverA = new StubServer('docs', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'fetch',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      const serverB = new StubServer('calendar', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'update',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      serverA.cacheToolsList = false;
      serverB.cacheToolsList = false;

      const tools = await getAllMcpTools({
        mcpServers: [serverA, serverB],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'AgentOne' }),
        includeServerInToolNames: true,
      });

      expect(tools.map((t) => t.name)).toEqual([
        'mcp_docs__search',
        'mcp_docs__fetch',
        'mcp_calendar__search',
        'mcp_calendar__update',
      ]);
    });
  });

  it('sanitizes non-ASCII MCP server and tool names before prefixing', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('天気サーバー', [
        {
          name: '検索',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      server.cacheToolsList = false;

      const tools = await getAllMcpTools({
        mcpServers: [server],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'AgentOne' }),
        includeServerInToolNames: true,
      });

      expect(tools.map((t) => t.name)).toEqual(['mcp_server__tool']);
      expect(tools[0].name.length).toBeLessThanOrEqual(64);
      expect(/^[A-Za-z0-9_-]+$/.test(tools[0].name)).toBe(true);
    });
  });

  it('shortens long prefixed MCP names with deterministic hashes', async () => {
    await withTrace('test', async () => {
      const longServerName = `server_${'a'.repeat(100)}`;
      const longToolName = `tool_${'b'.repeat(100)}`;
      const serverA = new StubServer(longServerName, [
        {
          name: longToolName,
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      const serverB = new StubServer(longServerName, [
        {
          name: longToolName,
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      serverA.cacheToolsList = false;
      serverB.cacheToolsList = false;

      const tools = await getAllMcpTools({
        mcpServers: [serverA, serverB],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'AgentOne' }),
        includeServerInToolNames: true,
      });
      const names = tools.map((t) => t.name);

      expect(new Set(names).size).toBe(2);
      expect(names.every((name) => name.length <= 64)).toBe(true);
      expect(names.every((name) => /^[A-Za-z0-9_-]+$/.test(name))).toBe(true);
    });
  });

  it('allocates normalized MCP tool name collisions stably', async () => {
    async function publicNamesByOriginalTool(
      toolNames: string[],
    ): Promise<Record<string, string>> {
      const server = new StubServer(
        'docs',
        toolNames.map((name) => ({
          name,
          description: '',
          inputSchema: { type: 'object', properties: {} },
        })),
      );
      server.cacheToolsList = false;

      const tools = await getAllMcpTools({
        mcpServers: [server],
        runContext: new RunContext({}),
        agent: new Agent({ name: 'AgentOne' }),
        includeServerInToolNames: true,
      });

      return Object.fromEntries(
        server.toolList.map((mcpTool, index) => {
          const tool = tools[index];
          if (!tool) {
            throw new Error(`Missing function tool at index ${index}`);
          }
          return [String(mcpTool.name), tool.name];
        }),
      );
    }

    await withTrace('test', async () => {
      const firstOrder = await publicNamesByOriginalTool(['search', 'search!']);
      const reversedOrder = await publicNamesByOriginalTool([
        'search!',
        'search',
      ]);

      expect(firstOrder).toEqual(reversedOrder);
      expect(Object.values(firstOrder)).not.toContain('mcp_docs__search');
      expect(new Set(Object.values(firstOrder)).size).toBe(2);
      expect(
        Object.values(firstOrder).every((name) =>
          name.startsWith('mcp_docs__search_'),
        ),
      ).toBe(true);
    });
  });

  it('reserves existing local function tool names when prefixing MCP tools', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('docs', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      server.cacheToolsList = false;
      const reservedTool = tool({
        name: 'mcp_docs__search',
        description: 'Reserved local tool.',
        parameters: z.object({}),
        execute: async () => 'ok',
      });
      const agent = new Agent({
        name: 'AgentOne',
        tools: [reservedTool],
        mcpServers: [server],
        mcpConfig: { includeServerInToolNames: true },
      });

      const tools = await agent.getMcpTools(new RunContext({}));

      expect(tools[0].name).not.toBe('mcp_docs__search');
      expect(tools[0].name.startsWith('mcp_docs__search_')).toBe(true);
      expect(tools[0].name.length).toBeLessThanOrEqual(64);
    });
  });

  it('reserves enabled handoff tool names when prefixing MCP tools', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('calendar', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      server.cacheToolsList = false;
      const handoffAgent = new Agent({ name: 'CalendarAgent' });
      const agent = new Agent({
        name: 'AgentOne',
        handoffs: [
          handoff(handoffAgent, {
            toolNameOverride: 'mcp_calendar__search',
          }),
        ],
        mcpServers: [server],
        mcpConfig: { includeServerInToolNames: true },
      });

      const tools = await agent.getMcpTools(new RunContext({}));

      expect(tools[0].name).not.toBe('mcp_calendar__search');
      expect(tools[0].name.startsWith('mcp_calendar__search_')).toBe(true);
    });
  });

  it('ignores disabled handoff tool names when prefixing MCP tools', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('calendar', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      server.cacheToolsList = false;
      const handoffAgent = new Agent({ name: 'CalendarAgent' });
      const agent = new Agent({
        name: 'AgentOne',
        handoffs: [
          handoff(handoffAgent, {
            toolNameOverride: 'mcp_calendar__search',
            isEnabled: false,
          }),
        ],
        mcpServers: [server],
        mcpConfig: { includeServerInToolNames: true },
      });

      const tools = await agent.getMcpTools(new RunContext({}));

      expect(tools[0].name).toBe('mcp_calendar__search');
    });
  });

  it('uses agent MCP config to force strict MCP tool schemas', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('docs', [
        {
          name: 'search',
          description: '',
          inputSchema: {
            type: 'object',
            properties: { foo: { type: 'string' } },
          },
        },
      ]);
      server.cacheToolsList = false;
      const agent = new Agent({
        name: 'AgentOne',
        mcpServers: [server],
        mcpConfig: { convertSchemasToStrict: true },
      });

      const mcpTools = (await agent.getMcpTools(
        new RunContext({}),
      )) as FunctionTool[];
      const mcpTool = mcpTools[0]!;

      expect(mcpTool.strict).toBe(true);
      expect(mcpTool.parameters.additionalProperties).toBe(false);
      expect(mcpTool.parameters.required).toEqual(['foo']);
    });
  });

  it('uses agent MCP config errorFunction for MCP tool failures', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('docs', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      server.cacheToolsList = false;
      const callTool = vi.fn(async () => {
        throw new Error('boom');
      });
      server.callTool = callTool;
      const errorFunction = vi.fn(() => 'agent failure');
      const agent = new Agent({
        name: 'AgentOne',
        mcpServers: [server],
        mcpConfig: { errorFunction },
      });

      const mcpTools = (await agent.getMcpTools(
        new RunContext({}),
      )) as FunctionTool[];
      const mcpTool = mcpTools[0]!;
      const result = await mcpTool.invoke(new RunContext({}), '{}');

      expect(result).toBe('agent failure');
      expect(errorFunction).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(1);
    });
  });

  it('lets server MCP errorFunction override agent MCP config', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('docs', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      server.cacheToolsList = false;
      server.callTool = vi.fn(async () => {
        throw new Error('boom');
      });
      server.errorFunction = vi.fn(() => 'server failure');
      const agentErrorFunction = vi.fn(() => 'agent failure');
      const agent = new Agent({
        name: 'AgentOne',
        mcpServers: [server],
        mcpConfig: { errorFunction: agentErrorFunction },
      });

      const mcpTools = (await agent.getMcpTools(
        new RunContext({}),
      )) as FunctionTool[];
      const mcpTool = mcpTools[0]!;
      const result = await mcpTool.invoke(new RunContext({}), '{}');

      expect(result).toBe('server failure');
      expect(server.errorFunction).toHaveBeenCalledTimes(1);
      expect(agentErrorFunction).not.toHaveBeenCalled();
    });
  });

  it('rethrows MCP tool failures when agent MCP config errorFunction is null', async () => {
    await withTrace('test', async () => {
      const server = new StubServer('docs', [
        {
          name: 'search',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      server.cacheToolsList = false;
      server.callTool = vi.fn(async () => {
        throw new Error('boom');
      });
      const agent = new Agent({
        name: 'AgentOne',
        mcpServers: [server],
        mcpConfig: { errorFunction: null },
      });

      const mcpTools = (await agent.getMcpTools(
        new RunContext({}),
      )) as FunctionTool[];
      const mcpTool = mcpTools[0]!;

      await expect(mcpTool.invoke(new RunContext({}), '{}')).rejects.toThrow(
        'boom',
      );
    });
  });
});

describe('MCP tools agent-dependent cache behavior', () => {
  it('handles agent-specific callable tool filters without cache leaking between agents', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'foo',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'bar',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      // Callable filter chooses tool availability per agent name
      const filter = async (ctx: any, tool: any) => {
        if (ctx.agent.name === 'AgentOne') {
          return tool.name === 'foo'; // AgentOne: only 'foo' allowed
        } else {
          return tool.name === 'bar'; // AgentTwo: only 'bar' allowed
        }
      };
      const server = new StubServer('shared-server', tools);
      server.toolFilter = filter;

      const agentOne = new Agent({ name: 'AgentOne' });
      const agentTwo = new Agent({ name: 'AgentTwo' });
      const ctxOne = new RunContext({});
      const ctxTwo = new RunContext({});

      // First access by AgentOne (should get only 'foo')
      const result1 = await getAllMcpTools({
        mcpServers: [server],
        runContext: ctxOne,
        agent: agentOne,
      });
      expect(result1.map((t: any) => t.name)).toEqual(['foo']);

      // Second access by AgentTwo (should get only 'bar')
      const result2 = await getAllMcpTools({
        mcpServers: [server],
        runContext: ctxTwo,
        agent: agentTwo,
      });
      expect(result2.map((t: any) => t.name)).toEqual(['bar']);

      // Third access by AgentOne (should still get only 'foo', from cache key)
      const result3 = await getAllMcpTools({
        mcpServers: [server],
        runContext: ctxOne,
        agent: agentOne,
      });
      expect(result3.map((t: any) => t.name)).toEqual(['foo']);
    });
  });
});

describe('Custom generateMCPToolCacheKey can include runContext in key', () => {
  it('supports fully custom cache key logic, including runContext properties', async () => {
    await withTrace('test', async () => {
      const tools = [
        {
          name: 'foo',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'bar',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
      // Filter that allows a tool based on runContext meta value
      const filter = async (ctx: any, tool: any) => {
        if (ctx.runContext.meta && ctx.runContext.meta.kind === 'fooUser') {
          return tool.name === 'foo';
        } else {
          return tool.name === 'bar';
        }
      };
      const server = new StubServer('custom-key-srv', tools);
      server.toolFilter = filter;
      const agent = new Agent({ name: 'A' });
      // This cache key generator uses both agent name and runContext.meta.kind
      const generateMCPToolCacheKey = ({ server, agent, runContext }: any) =>
        `${server.name}:${agent ? agent.name : ''}:${runContext?.meta?.kind}`;

      // Agent 'A', runContext kind 'fooUser' => should see only 'foo'
      const context1 = new RunContext({});
      (context1 as any).meta = { kind: 'fooUser' };
      const res1 = await getAllMcpTools({
        mcpServers: [server],
        runContext: context1,
        agent,
        generateMCPToolCacheKey,
      });
      expect(res1.map((t: any) => t.name)).toEqual(['foo']);

      // Agent 'A', runContext kind 'barUser' => should see only 'bar'
      const context2 = new RunContext({});
      (context2 as any).meta = { kind: 'barUser' };
      const res2 = await getAllMcpTools({
        mcpServers: [server],
        runContext: context2,
        agent,
        generateMCPToolCacheKey,
      });
      expect(res2.map((t: any) => t.name)).toEqual(['bar']);

      // Agent 'A'/'fooUser' again => should hit the correct cache entry, still see only 'foo'
      const res3 = await getAllMcpTools({
        mcpServers: [server],
        runContext: context1,
        agent,
        generateMCPToolCacheKey,
      });
      expect(res3.map((t: any) => t.name)).toEqual(['foo']);
    });
  });
});

describe('MCP tools without tracing', () => {
  it('lists tools directly when no trace is active', async () => {
    let listCalls = 0;
    const server: MCPServer = {
      name: 'no-trace-server',
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        listCalls += 1;
        return [
          {
            name: 'tool',
            description: '',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ] as any;
      },
      async callTool(
        _toolName: string,
        _args: Record<string, unknown> | null,
        _meta?: Record<string, unknown> | null,
      ) {
        return [];
      },
      async invalidateToolsCache() {},
    };

    const tools = await getAllMcpTools([server]);
    expect(tools.map((tool) => tool.name)).toEqual(['tool']);
    expect(listCalls).toBe(1);
  });
});
