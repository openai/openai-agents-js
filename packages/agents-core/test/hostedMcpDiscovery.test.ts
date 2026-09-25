import { describe, expect, it } from 'vitest';
import {
  Agent,
  Runner,
  RunContext,
  RunState,
  Usage,
  attachClientToolSearchExecutor,
  hostedMcpTool,
} from '../src';
import { processModelResponseAsync } from '../src/runner/modelOutputs';
import { ScriptedModel, assistantMessage } from '../src/testing';
import type { OutputModelItem } from '../src/types/protocol';

function discoveryResponse() {
  const mcpTool = hostedMcpTool({
    serverLabel: 'records',
    serverUrl: 'https://example.invalid/mcp',
    deferLoading: true,
    requireApproval: 'never',
  });
  const output: OutputModelItem[] = [
    {
      type: 'hosted_tool_call',
      id: 'listing',
      name: 'mcp_list_tools',
      status: 'completed',
      providerData: {
        type: 'mcp_list_tools',
        server_label: 'records',
        tools: [
          {
            name: 'lookup',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      },
    },
    {
      type: 'tool_search_call',
      id: 'search',
      status: 'completed',
      arguments: { paths: ['records'] },
      execution: 'server',
    },
    {
      type: 'tool_search_output',
      id: 'search_output',
      status: 'completed',
      tools: [mcpTool.providerData],
      execution: 'server',
    },
    {
      type: 'hosted_tool_call',
      id: 'call',
      name: 'mcp_call',
      status: 'completed',
      output: 'found',
      providerData: {
        type: 'mcp_call',
        server_label: 'records',
        name: 'lookup',
        arguments: '{}',
      },
    },
    assistantMessage('Done.'),
  ];
  return { mcpTool, output };
}

describe('deferred hosted MCP discovery', () => {
  it.each([false, true])(
    'accepts a listing before search and preserves the completed call (stream: %s)',
    async (stream) => {
      const { mcpTool, output } = discoveryResponse();
      const model = new ScriptedModel([output]);
      const agent = new Agent({
        name: 'Records',
        model,
        tools: [
          mcpTool,
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
      });
      const runner = new Runner({ tracingDisabled: true });
      const result = stream
        ? await runner.run(agent, 'Look up a record.', { stream: true })
        : await runner.run(agent, 'Look up a record.');
      if ('completed' in result) await result.completed;

      expect(result.finalOutput).toBe('Done.');
      expect(result.newItems.map((item) => item.rawItem.id)).toEqual(
        output.map((item) => item.id),
      );
      expect(result.newItems[3].rawItem).toMatchObject({
        name: 'mcp_call',
        output: 'found',
      });
      model.assertComplete();
    },
  );

  it('accepts the listing when processing also executes client tool search', async () => {
    const { mcpTool, output } = discoveryResponse();
    const searchTool = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'client' },
      },
      async () => [],
    );
    const agent = new Agent({ name: 'Records', tools: [mcpTool, searchTool] });
    const result = await processModelResponseAsync(
      {
        output: [
          {
            type: 'tool_search_call',
            callId: 'client_search',
            execution: 'client',
            arguments: { paths: [] },
          },
          ...output,
        ],
        usage: new Usage(),
      },
      agent,
      agent.tools,
      [],
      new RunState(new RunContext(), 'Look up a record.', agent, 1),
    );
    expect(
      result.newItems.slice(-output.length).map((item) => item.rawItem.id),
    ).toEqual(output.map((item) => item.id));
  });
});
