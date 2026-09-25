import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  getAllMcpTools,
  invalidateServerToolsCache,
  RunContext,
  Runner,
  type MCPServer,
} from '../src';
import type { MCPTool } from '../src/mcp';
import { ScriptedModel } from '../src/testing';

const definitions: MCPTool[] = ['alpha', 'beta', 'gamma'].map((name) => ({
  name,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
}));

function recordingServer(): MCPServer {
  return {
    name: 'static-discovery',
    cacheToolsList: true,
    connect: async () => {},
    close: async () => {},
    listTools: vi.fn(async () => definitions),
    callTool: vi.fn(async () => [{ type: 'text', text: 'recorded' }]),
    invalidateToolsCache: async () => {},
  };
}

const contextCases = [
  { label: 'no context', runContext: undefined, agent: undefined },
  {
    label: 'run context only',
    runContext: new RunContext({}),
    agent: undefined,
  },
  {
    label: 'agent only',
    runContext: undefined,
    agent: new Agent({ name: 'Discovery' }),
  },
  {
    label: 'full context',
    runContext: new RunContext({}),
    agent: new Agent({ name: 'Discovery' }),
  },
];

describe('static MCP discovery filters', () => {
  beforeEach(async () => {
    await invalidateServerToolsCache('static-discovery');
  });

  describe.each(['positional', 'options'] as const)('%s API', (shape) => {
    it.each(contextCases)(
      'applies static policies with $label',
      async ({ runContext, agent }) => {
        const server = recordingServer();
        const discover = () =>
          shape === 'positional'
            ? getAllMcpTools([server], runContext, agent)
            : getAllMcpTools({ mcpServers: [server], runContext, agent });

        server.toolFilter = {
          allowedToolNames: ['alpha', 'beta'],
          blockedToolNames: ['beta'],
        };
        expect((await discover()).map((tool) => tool.name)).toEqual(['alpha']);
        server.toolFilter = { blockedToolNames: ['alpha'] };
        expect((await discover()).map((tool) => tool.name)).toEqual([
          'beta',
          'gamma',
        ]);
        server.toolFilter = { allowedToolNames: ['beta'] };
        expect((await discover()).map((tool) => tool.name)).toEqual(['beta']);
        server.toolFilter = { allowedToolNames: [], blockedToolNames: [] };
        expect((await discover()).map((tool) => tool.name)).toEqual([
          'alpha',
          'beta',
          'gamma',
        ]);
        server.toolFilter = undefined;
        expect((await discover()).map((tool) => tool.name)).toEqual([
          'alpha',
          'beta',
          'gamma',
        ]);
        expect(server.listTools).toHaveBeenCalledTimes(1);
        expect(server.callTool).not.toHaveBeenCalled();
      },
    );
  });

  it('requires full context for callable filters on cached discovery', async () => {
    const server = recordingServer();
    const filter = vi.fn(
      async (_context, tool: MCPTool) => tool.name === 'beta',
    );
    server.toolFilter = filter;
    const discover = (context: (typeof contextCases)[number]) =>
      getAllMcpTools({
        mcpServers: [server],
        runContext: context.runContext,
        agent: context.agent,
        generateMCPToolCacheKey: () => 'static-discovery',
      });
    for (const context of contextCases.slice(0, 3)) {
      expect((await discover(context)).map((tool) => tool.name)).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
    }
    expect(filter).not.toHaveBeenCalled();
    expect((await discover(contextCases[3])).map((tool) => tool.name)).toEqual([
      'beta',
    ]);
    expect(filter).toHaveBeenCalledTimes(3);
    expect(filter).toHaveBeenCalledWith(
      {
        runContext: contextCases[3].runContext,
        agent: contextCases[3].agent,
        serverName: server.name,
      },
      definitions[0],
    );
    expect(server.listTools).toHaveBeenCalledTimes(1);
  });

  it('exposes only permitted prefetched tools to an Agent and Runner', async () => {
    const server = recordingServer();
    server.toolFilter = { allowedToolNames: ['alpha'] };
    const tools = await getAllMcpTools([server]);
    const model = new ScriptedModel([
      [
        {
          type: 'function_call',
          name: 'alpha',
          callId: 'allowed-call',
          arguments: '{}',
          status: 'completed',
          providerData: {},
        },
      ],
    ]);
    const agent = new Agent({
      name: 'Prefetched',
      tools,
      model,
      toolUseBehavior: 'stop_on_first_tool',
    });
    expect(
      (await agent.getAllTools(new RunContext({}))).map((tool) => tool.name),
    ).toEqual(['alpha']);
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      'Use the available tool.',
    );
    expect(result.finalOutput).toBe('{"type":"text","text":"recorded"}');
    expect(model.firstCall?.request.tools.map((tool) => tool.name)).toEqual([
      'alpha',
    ]);
    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(server.callTool).mock.calls[0][0]).toBe('alpha');
  });

  it('does not invoke an excluded prefetched tool requested by a model', async () => {
    const server = recordingServer();
    server.toolFilter = { blockedToolNames: ['beta'] };
    const agent = new Agent({
      name: 'Prefetched',
      tools: await getAllMcpTools({ mcpServers: [server] }),
      model: new ScriptedModel([
        [
          {
            type: 'function_call',
            name: 'beta',
            callId: 'excluded-call',
            arguments: '{}',
            status: 'completed',
            providerData: {},
          },
        ],
      ]),
    });
    await expect(
      new Runner({ tracingDisabled: true }).run(agent, 'Use a tool.'),
    ).rejects.toThrow('Tool beta not found in agent Prefetched.');
    expect(server.callTool).not.toHaveBeenCalled();
  });
});
