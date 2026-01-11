import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent } from '../../src/agent';
import { RunItem, RunToolApprovalItem, RunToolCallItem } from '../../src/items';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import { handleHostedMcpApprovals } from '../../src/runner/mcpApprovals';
import type { ToolRunMCPApprovalRequest } from '../../src/runner/types';
import { hostedMcpTool } from '../../src/tool';
import type {
  HostedMCPApprovalRequest,
  HostedMCPApprovalResponse,
} from '../../src/types/providerData';
import * as protocol from '../../src/types/protocol';

const TEST_AGENT = new Agent({ name: 'TestAgent', outputType: 'text' });

const buildApprovalRequest = (id = 'mcpr_1'): ToolRunMCPApprovalRequest => {
  const providerData: HostedMCPApprovalRequest = {
    id,
    name: 'list_files',
    server_label: 'stub',
    arguments: '{}',
  };

  const requestItem = new RunToolApprovalItem(
    {
      type: 'hosted_tool_call',
      name: providerData.name,
      id: providerData.id,
      status: 'in_progress',
      providerData,
    },
    TEST_AGENT,
  );

  return {
    requestItem,
    mcpTool: hostedMcpTool({
      serverLabel: 'stub',
      requireApproval: 'always',
    }),
  };
};

describe('handleHostedMcpApprovals', () => {
  let state: RunState<unknown, Agent<any, any>>;
  let newItems: RunItem[];
  let functionResults: any[];

  beforeEach(() => {
    state = new RunState(new RunContext(), 'input', TEST_AGENT, 2);
    newItems = [];
    functionResults = [];
  });

  it('emits approval response when on_approval resolves synchronously', async () => {
    const onApproval = vi
      .fn()
      .mockResolvedValue({ approve: true, reason: 'ok' });
    const approvalRequest = buildApprovalRequest();
    approvalRequest.mcpTool = hostedMcpTool({
      serverLabel: 'stub',
      requireApproval: 'always',
      onApproval,
    });

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
    });

    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(functionResults).toHaveLength(0);
    expect(newItems).toHaveLength(1);
    const response = newItems[0] as RunToolCallItem;
    const raw = response.rawItem as protocol.HostedToolCallItem;
    expect(raw.name).toBe('mcp_approval_response');
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalIds.size).toBe(0);
  });

  it('reuses prior approval decisions from context', async () => {
    const approvalRequest = buildApprovalRequest('mcpr_approved');
    state.approve(approvalRequest.requestItem, { alwaysApprove: true });

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval: (rawItem) =>
        state._context.isToolApproved({
          toolName: rawItem.name,
          callId:
            rawItem.id ??
            (rawItem.providerData as HostedMCPApprovalRequest | undefined)
              ?.id ??
            '',
        }),
    });

    expect(functionResults).toHaveLength(0);
    expect(newItems).toHaveLength(1);
    const response = newItems[0] as RunToolCallItem;
    const providerData = response.rawItem
      .providerData as HostedMCPApprovalResponse;
    expect(providerData).toMatchObject({
      approval_request_id: 'mcpr_approved',
      approve: true,
    });
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalIds.size).toBe(0);
  });

  it('surfaces pending approvals when no decision exists', async () => {
    const approvalRequest = buildApprovalRequest('mcpr_pending');

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval: (rawItem) =>
        state._context.isToolApproved({
          toolName: rawItem.name,
          callId:
            rawItem.id ??
            (rawItem.providerData as HostedMCPApprovalRequest | undefined)
              ?.id ??
            '',
        }),
    });

    expect(functionResults).toHaveLength(1);
    expect(functionResults[0].type).toBe('hosted_mcp_tool_approval');
    expect(newItems).toContain(approvalRequest.requestItem);
    expect(result.pendingApprovals.has(approvalRequest.requestItem)).toBe(true);
    expect(result.pendingApprovalIds.has('mcpr_pending')).toBe(true);
  });
});
