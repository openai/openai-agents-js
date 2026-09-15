import { describe, expect, it } from 'vitest';
import { Agent, Runner, RunState, hostedMcpTool } from '../src';
import { ScriptedModel } from '../src/testing';

describe('hosted MCP approval snapshots', () => {
  it.each([false, true])(
    'persists tool identity and resumes with current configuration (stream=%s)',
    async (stream) => {
      const savedTool = hostedMcpTool({
        serverLabel: 'lookup',
        serverUrl: 'https://old.example/mcp',
        authorization: 'synthetic-old-authorization',
        headers: { 'X-Test-Token': 'synthetic-old-header' },
        requireApproval: 'always',
      });
      const originalConfiguration = structuredClone(savedTool.providerData);
      const model = new ScriptedModel([
        [
          {
            type: 'hosted_tool_call',
            name: 'mcp_approval_request',
            id: 'approval-1',
            status: 'completed',
            providerData: {
              type: 'mcp_approval_request',
              id: 'approval-1',
              server_label: 'lookup',
              name: 'lookup_record',
              arguments: '{"record":"example"}',
            },
          },
        ],
      ]);
      const agent = new Agent({ name: 'MCP agent', model, tools: [savedTool] });
      const runner = new Runner({ tracingDisabled: true });
      const first = stream
        ? await runner.run(agent, 'Look up a record', { stream: true })
        : await runner.run(agent, 'Look up a record');
      if ('completed' in first) await first.completed;
      expect(first.interruptions).toHaveLength(1);

      const snapshot = first.state.toJSON();
      expect(
        snapshot.lastProcessedResponse?.mcpApprovalRequests?.[0].mcpTool,
      ).toEqual({
        type: 'hosted_tool',
        name: 'hosted_mcp',
        providerData: { type: 'mcp', server_label: 'lookup' },
      });
      for (const serialized of [
        JSON.stringify(snapshot),
        first.state.toString(),
        JSON.stringify(first.state),
      ]) {
        expect(serialized).not.toContain('synthetic-old-');
        expect(serialized).not.toContain('https://old.example/mcp');
      }
      expect(savedTool.providerData).toEqual(originalConfiguration);

      const currentTool = hostedMcpTool({
        serverLabel: 'lookup',
        serverUrl: 'https://current.example/mcp',
        authorization: 'synthetic-current-authorization',
        headers: { 'X-Test-Token': 'synthetic-current-header' },
        requireApproval: 'always',
      });
      const resumedModel = new ScriptedModel([
        [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done' }],
          },
        ],
      ]);
      const currentAgent = new Agent({
        name: 'MCP agent',
        model: resumedModel,
        tools: [currentTool],
      });
      const restored = await RunState.fromString(
        currentAgent,
        first.state.toString(),
      );
      const approval = restored.getInterruptions()[0];
      expect(approval.rawItem).toEqual(first.interruptions[0].rawItem);
      expect(
        restored._lastProcessedResponse?.mcpApprovalRequests[0].mcpTool,
      ).toBe(currentTool);
      restored.approve(approval);
      const resumed = stream
        ? await runner.run(currentAgent, restored, { stream: true })
        : await runner.run(currentAgent, restored);
      if ('completed' in resumed) await resumed.completed;
      expect(resumed.finalOutput).toBe('Done');
      expect(resumedModel.lastCall?.request.tools).toEqual([currentTool]);
      expect(resumedModel.lastCall?.request.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'hosted_tool_call',
            name: 'mcp_approval_response',
            providerData: expect.objectContaining({
              approval_request_id: 'approval-1',
              approve: true,
            }),
          }),
        ]),
      );

      // Older snapshots embedded the complete configured tool record.
      const savedRequest =
        snapshot.lastProcessedResponse?.mcpApprovalRequests?.[0];
      if (!savedRequest)
        throw new Error('Expected a saved MCP approval request');
      savedRequest.mcpTool.providerData = originalConfiguration;
      const legacy = await RunState.fromString(
        currentAgent,
        JSON.stringify(snapshot),
      );
      expect(
        legacy._lastProcessedResponse?.mcpApprovalRequests[0].mcpTool,
      ).toBe(currentTool);
      expect(legacy.toString()).not.toContain('synthetic-');
    },
  );
});
