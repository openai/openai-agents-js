import { describe, expect, it } from 'vitest';
import { Agent, MemorySession, Runner, hostedMcpTool } from '../src';
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
