import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  RunState,
  OutputGuardrailTripwireTriggered,
  hostedMcpTool,
  tool,
  toolNamespace,
} from '../src';
import { ScriptedModel, assistantMessage } from '../src/testing';
import type * as protocol from '../src/types/protocol';

const server = () =>
  hostedMcpTool({
    serverLabel: 'OpenAI_Docs',
    serverUrl: 'https://example.invalid/mcp',
    deferLoading: true,
    requireApproval: 'never',
  });
const searchTool = {
  type: 'hosted_tool',
  name: 'tool_search',
  providerData: { type: 'tool_search' },
} as const;

function discovery(namespace = 'mcp_OpenAI_Docs'): protocol.ModelItem[] {
  return [
    {
      type: 'hosted_tool_call',
      name: 'mcp_list_tools',
      status: 'completed',
      providerData: { type: 'mcp_list_tools', server_label: 'OpenAI_Docs' },
    },
    {
      type: 'tool_search_call',
      id: 'search',
      status: 'completed',
      arguments: { paths: [namespace] },
      providerData: { execution: 'server' },
    },
    {
      type: 'tool_search_output',
      id: 'search_output',
      status: 'completed',
      tools: [
        {
          type: 'namespace',
          name: namespace,
          description: 'Documentation tools',
          tools: [
            {
              type: 'function',
              name: 'search_openai_docs',
              description: 'Search documentation',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
              strict: true,
            },
          ],
        },
      ],
      providerData: { execution: 'server' },
    },
  ];
}

function call(
  name = 'search_openai_docs',
  type = 'mcp_call',
): protocol.HostedToolCallItem {
  return {
    type: 'hosted_tool_call',
    id: 'call_1',
    name: type,
    status: 'completed',
    output: 'Documentation found.',
    providerData: {
      type,
      id: 'call_1',
      server_label: 'OpenAI_Docs',
      name,
      arguments: '{}',
    },
  };
}

const runner = () => new Runner({ tracingDisabled: true });

describe('namespace-shaped hosted MCP discovery', () => {
  it.each([false, true])(
    'accepts a discovered tool on the next MemorySession turn (stream: %s)',
    async (stream) => {
      const model = new ScriptedModel([
        [...discovery(), assistantMessage('Tools loaded.')],
        [call(), assistantMessage('Done.')],
      ]);
      const agent = new Agent({
        name: 'Docs',
        model,
        tools: [server(), searchTool],
      });
      const session = new MemorySession();
      expect(
        (await runner().run(agent, 'Discover tools.', { session })).finalOutput,
      ).toBe('Tools loaded.');
      const result = stream
        ? await runner().run(agent, 'Search docs.', { session, stream: true })
        : await runner().run(agent, 'Search docs.', { session });
      if ('completed' in result) await result.completed;
      expect(result.finalOutput).toBe('Done.');
      expect(
        (await session.getItems()).some(
          (item) =>
            item.type === 'hosted_tool_call' &&
            item.providerData?.type === 'mcp_call',
        ),
      ).toBe(true);
      model.assertComplete();
    },
  );

  it.each([
    ['mcp_OpenAI_Docs_other', 'search_openai_docs'],
    ['OpenAI_Docs', 'search_openai_docs'],
    ['mcp_OpenAI_Docs', 'fetch_openai_doc'],
  ])(
    'rejects undiscovered calls after loading %s / %s',
    async (namespace, name) => {
      const model = new ScriptedModel([
        [...discovery(namespace), assistantMessage('Tools loaded.')],
        [call(name), assistantMessage('Done.')],
      ]);
      const agent = new Agent({
        name: 'Docs',
        model,
        tools: [server(), searchTool],
      });
      const session = new MemorySession();
      await runner().run(agent, 'Discover tools.', { session });
      await expect(
        runner().run(agent, 'Search docs.', { session }),
      ).rejects.toThrow(
        /deferred MCP call OpenAI_Docs before it was loaded via tool_search/,
      );
      model.assertComplete();
    },
  );

  it.each([
    ['client', false, true],
    ['client', true, true],
    ['server', false, true],
    ['server', true, true],
    ['server', false, false],
    ['server', false, true, true],
    ['server', true, true, true],
  ] as const)(
    'keeps %s user namespace discovery out of hosted MCP loading (stream: %s, enabled: %s, remove local: %s)',
    async (execution, stream, enabled, removeLocal: boolean = false) => {
      const execute = vi.fn(async () => 'local result');
      const localTools = toolNamespace({
        name: 'mcp_OpenAI_Docs',
        description: 'Local documentation',
        tools: [
          tool({
            name: 'search_openai_docs',
            description: 'Local search',
            parameters: z.object({}),
            deferLoading: true,
            isEnabled: enabled,
            execute,
          }),
        ],
      });
      const localCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'search_openai_docs',
        namespace: 'mcp_OpenAI_Docs',
        callId: 'local',
        arguments: '{}',
      };
      const serverDiscovery = discovery().slice(1);
      // A provider/model cannot supply the SDK's historical classification.
      Object.assign(serverDiscovery[1], {
        toolSearchMcpToolNames: ['mcp_OpenAI_Docs.search_openai_docs'],
      });
      const model = new ScriptedModel([
        ...(execution === 'client'
          ? [
              [
                {
                  type: 'tool_search_call',
                  callId: 'search',
                  execution: 'client',
                  arguments: { paths: ['mcp_OpenAI_Docs'] },
                } as protocol.ToolSearchCallItem,
              ],
              [localCall],
            ]
          : [[...serverDiscovery, ...(enabled ? [localCall] : [])]]),
        [assistantMessage('Local tool called.')],
        [call(), assistantMessage('Done.')],
      ]);
      const agent = new Agent({
        name: 'Docs',
        model,
        tools: [
          ...localTools,
          server(),
          { ...searchTool, providerData: { type: 'tool_search', execution } },
        ],
      });
      const session = new MemorySession();
      await runner().run(agent, 'Use local docs.', { session });
      expect(execute).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (removeLocal) {
        agent.tools = agent.tools.filter((tool) => tool.type !== 'function');
      }
      const runHosted = async () => {
        if (stream) {
          const result = await runner().run(agent, 'Use hosted docs.', {
            session,
            stream: true,
          });
          await result.completed;
        } else {
          await runner().run(agent, 'Use hosted docs.', { session });
        }
      };
      await expect(runHosted()).rejects.toThrow(
        /before it was loaded via tool_search/,
      );
      model.assertComplete();
    },
  );

  it('keeps deferred top-level self-namespace discovery local after session reuse', async () => {
    const execute = vi.fn(async () => 'local');
    const local = tool({
      name: 'mcp_inventory',
      description: 'Local inventory',
      parameters: z.object({}),
      deferLoading: true,
      execute,
    });
    const model = new ScriptedModel([
      [
        {
          type: 'tool_search_output',
          execution: 'server',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'mcp_inventory',
              namespace: 'mcp_inventory',
            },
          ],
        },
        {
          type: 'function_call',
          name: 'mcp_inventory',
          namespace: 'mcp_inventory',
          callId: 'local',
          arguments: '{}',
        },
      ],
      [assistantMessage('Local completed.')],
      [
        {
          type: 'hosted_tool_call',
          name: 'mcp_call',
          providerData: {
            type: 'mcp_call',
            server_label: 'inventory',
            name: 'mcp_inventory',
            arguments: '{}',
          },
        },
      ],
    ]);
    const agent = new Agent({
      name: 'Inventory',
      model,
      tools: [
        local,
        searchTool,
        hostedMcpTool({
          serverLabel: 'inventory',
          serverUrl: 'https://example.invalid/mcp',
          deferLoading: true,
          requireApproval: 'never',
        }),
      ],
    });
    const session = new MemorySession();
    await runner().run(agent, 'Use local inventory.', { session });
    expect(execute).toHaveBeenCalledOnce();
    agent.tools = agent.tools.filter((tool) => tool !== local);
    await expect(
      runner().run(agent, 'Use hosted inventory.', { session }),
    ).rejects.toThrow(/before it was loaded via tool_search/);
    model.assertComplete();
  });

  it.each(['recorded', 'collision', 'legacy'] as const)(
    'preserves %s namespace provenance through RunState resume',
    async (mode) => {
      const confirm = tool({
        name: 'confirm',
        description: 'Confirm continuation',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'confirmed',
      });
      const localTools =
        mode === 'collision'
          ? toolNamespace({
              name: 'mcp_OpenAI_Docs',
              description: 'Local documentation',
              tools: [
                tool({
                  name: 'search_openai_docs',
                  description: 'Local search',
                  parameters: z.object({}),
                  deferLoading: true,
                  execute: async () => 'local',
                }),
              ],
            })
          : [];
      const agent = new Agent({
        name: 'Docs',
        tools: [server(), searchTool, confirm, ...localTools],
        model: new ScriptedModel([
          [
            ...discovery().slice(1),
            {
              type: 'function_call',
              name: 'confirm',
              callId: 'confirm',
              arguments: '{}',
            },
          ],
        ]),
      });
      const paused = await runner().run(agent, 'Discover tools and confirm.');
      const serialized = JSON.parse(await paused.state.toString());
      if (mode === 'legacy') {
        serialized.$schemaVersion = '1.21';
        // Old writers omitted provenance from both generated and processed items.
        const removeProvenance = (value: any): void => {
          if (!value || typeof value !== 'object') return;
          delete value.toolSearchMcpToolNames;
          for (const child of Object.values(value)) removeProvenance(child);
        };
        removeProvenance(serialized);
      }
      const replacement = new Agent({
        name: 'Docs',
        tools: [server(), searchTool, confirm],
        model: new ScriptedModel([[call(), assistantMessage('Done.')]]),
      });
      const restored = await RunState.fromString(
        replacement,
        JSON.stringify(serialized),
      );
      restored.approve(restored.getInterruptions()[0]);
      const result = runner().run(replacement, restored);
      if (mode === 'recorded') {
        expect((await result).finalOutput).toBe('Done.');
      } else {
        await expect(result).rejects.toThrow(
          /before it was loaded via tool_search/,
        );
      }
    },
  );

  it('requires rediscovery for older namespace-only session history', async () => {
    const model = new ScriptedModel([
      [...discovery(), assistantMessage('Tools loaded.')],
      [call(), assistantMessage('Done.')],
    ]);
    const agent = new Agent({
      name: 'Docs',
      model,
      tools: [server(), searchTool],
    });
    const result = await runner().run(agent, 'Discover tools.');
    const olderHistory = JSON.parse(JSON.stringify(result.history));
    for (const item of olderHistory) delete item.toolSearchMcpToolNames;
    const session = new MemorySession();
    await session.addItems(olderHistory);
    await expect(
      runner().run(agent, 'Use hosted docs.', { session }),
    ).rejects.toThrow(/before it was loaded via tool_search/);
  });

  it('accepts explicit MCP discovery despite a colliding user namespace', async () => {
    const mcp = server();
    const model = new ScriptedModel([
      [
        {
          type: 'tool_search_call',
          callId: 'search',
          execution: 'client',
          arguments: { paths: ['OpenAI_Docs'] },
        },
      ],
      [call(), assistantMessage('Done.')],
    ]);
    const agent = new Agent({
      name: 'Docs',
      model,
      tools: [
        mcp,
        ...toolNamespace({
          name: 'mcp_OpenAI_Docs',
          description: 'Local docs',
          tools: [
            tool({
              name: 'search_openai_docs',
              description: 'Local search',
              parameters: z.object({}),
              deferLoading: true,
              execute: async () => 'local',
            }),
          ],
        }),
        {
          ...searchTool,
          providerData: { type: 'tool_search', execution: 'client' },
        },
      ],
    });
    expect((await runner().run(agent, 'Load hosted docs.')).finalOutput).toBe(
      'Done.',
    );
    model.assertComplete();
  });

  it('retains explicit MCP discovery across blocked output with a disabled collision', async () => {
    const mcp = server();
    const search = discovery().slice(1);
    (search[1] as protocol.ToolSearchOutputItem).tools = [mcp.providerData];
    const model = new ScriptedModel([
      [...search, call(), assistantMessage('Blocked.')],
      [call(), assistantMessage('Done.')],
    ]);
    const agent = new Agent({
      name: 'Docs',
      model,
      tools: [
        mcp,
        searchTool,
        ...toolNamespace({
          name: 'mcp_OpenAI_Docs',
          description: 'Local docs',
          tools: [
            tool({
              name: 'search_openai_docs',
              description: 'Local search',
              parameters: z.object({}),
              isEnabled: false,
              execute: async () => 'local',
            }),
          ],
        }),
      ],
      outputGuardrails: [
        {
          name: 'block',
          execute: async () => ({ tripwireTriggered: true, outputInfo: {} }),
        },
      ],
    });
    const session = new MemorySession();
    await expect(runner().run(agent, 'Search.', { session })).rejects.toThrow(
      OutputGuardrailTripwireTriggered,
    );
    expect(
      (await session.getItems()).find((i) => i.type === 'tool_search_output'),
    ).toMatchObject({ tools: [{ type: 'mcp', server_label: 'OpenAI_Docs' }] });
    agent.outputGuardrails = [];
    expect(
      (await runner().run(agent, 'Search again.', { session })).finalOutput,
    ).toBe('Done.');
    model.assertComplete();
  });

  it('does not confuse a bare user function with an MCP descriptor', async () => {
    const agent = new Agent({
      name: 'Docs',
      tools: [
        server(),
        tool({
          name: 'OpenAI_Docs',
          description: 'Local lookup',
          parameters: z.object({}),
          deferLoading: true,
          execute: async () => 'local',
        }),
        {
          ...searchTool,
          providerData: { type: 'tool_search', execution: 'server' },
        },
      ],
    });
    // Hosted search can return a bare function with the same name as a server label.
    agent.model = new ScriptedModel([
      [
        {
          type: 'tool_search_output',
          id: 'search',
          status: 'completed',
          execution: 'server',
          tools: [{ type: 'function', name: 'OpenAI_Docs' }],
        },
        call(),
      ],
    ]);
    await expect(runner().run(agent, 'Search.')).rejects.toThrow(
      /before it was loaded via tool_search/,
    );
  });

  it('still enforces caller restrictions after namespace discovery', async () => {
    const mcp = server();
    mcp.providerData.allowed_callers = ['programmatic'];
    const model = new ScriptedModel([
      [...discovery().slice(1), call(), assistantMessage('Done.')],
    ]);
    const agent = new Agent({ name: 'Docs', model, tools: [mcp, searchTool] });
    await expect(runner().run(agent, 'Search docs.')).rejects.toThrow(
      /caller direct/,
    );
  });

  it('preserves approval interruptions after namespace discovery', async () => {
    const mcp = server();
    mcp.providerData.require_approval = 'always';
    const model = new ScriptedModel([
      [...discovery(), call('search_openai_docs', 'mcp_approval_request')],
    ]);
    const agent = new Agent({ name: 'Docs', model, tools: [mcp, searchTool] });
    const result = await runner().run(agent, 'Search docs.');
    expect(result.interruptions).toHaveLength(1);
    expect(result.interruptions[0].rawItem).toMatchObject({
      providerData: { server_label: 'OpenAI_Docs', name: 'search_openai_docs' },
    });
  });
});
