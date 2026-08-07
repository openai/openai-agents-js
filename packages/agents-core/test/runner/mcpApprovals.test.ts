import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent } from '../../src/agent';
import { RunItem, RunToolApprovalItem, RunToolCallItem } from '../../src/items';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import { handleHostedMcpApprovals } from '../../src/runner/mcpApprovals';
import type { ToolRunMCPApprovalRequest } from '../../src/runner/types';
import { hostedMcpTool } from '../../src/tool';
import { getHostedMcpApprovalToolName } from '../../src/toolInvocation';
import type {
  HostedMCPApprovalRequest,
  HostedMCPApprovalResponse,
} from '../../src/types/providerData';
import * as protocol from '../../src/types/protocol';

const TEST_AGENT = new Agent({ name: 'TestAgent', outputType: 'text' });

const buildApprovalRequest = (
  id = 'mcpr_1',
  argsOrServerLabel = '{}',
  toolName?: string,
): ToolRunMCPApprovalRequest => {
  const serverLabel = toolName ? argsOrServerLabel : 'stub';
  const args = toolName ? '{}' : argsOrServerLabel;
  const providerData: HostedMCPApprovalRequest = {
    id,
    name: toolName ?? 'list_files',
    server_label: serverLabel,
    arguments: args,
  };

  const requestItem = new RunToolApprovalItem(
    {
      type: 'hosted_tool_call',
      name: providerData.name,
      id: providerData.id,
      status: 'in_progress',
      providerData,
      caller: { type: 'program', callerId: 'call_prog_1' },
    },
    TEST_AGENT,
  );

  return {
    requestItem,
    mcpTool: hostedMcpTool({
      serverLabel,
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
    approvalRequest.requestItem.rawItem.id = 'raw-request';
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
    expect(raw.providerData).toMatchObject({
      approval_request_id: 'mcpr_1',
      approve: true,
    });
    expect(raw.caller).toEqual({
      type: 'program',
      callerId: 'call_prog_1',
    });
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalKeys.size).toBe(0);
  });

  it('binds callback approval to the exact hosted MCP invocation', async () => {
    const onApproval = vi.fn().mockResolvedValue({ approve: true });
    const approvalRequest = buildApprovalRequest(
      'mcpr_callback_bound',
      '{"path":"safe"}',
    );
    approvalRequest.mcpTool = hostedMcpTool({
      serverLabel: 'stub',
      requireApproval: 'always',
      onApproval,
    });
    const resolveApproval = (rawItem: protocol.HostedToolCallItem) =>
      state._context._resolveToolInvocationApproval(
        TEST_AGENT,
        getHostedMcpApprovalToolName(rawItem.name, rawItem),
        rawItem,
      );

    await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval,
    });
    newItems = [];
    await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval,
    });

    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(newItems).toHaveLength(1);

    const changedRequest = buildApprovalRequest(
      'mcpr_callback_bound',
      '{"path":"changed"}',
    );
    changedRequest.mcpTool = approvalRequest.mcpTool;
    await expect(
      handleHostedMcpApprovals({
        requests: [changedRequest],
        agent: TEST_AGENT,
        state,
        functionResults,
        appendIfNew: (item) => newItems.push(item),
        resolveApproval,
      }),
    ).rejects.toThrow(/reused for a different invocation/);
    expect(onApproval).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'restores committed callback approval suppression from schema %s',
    async (readAsLegacy) => {
      const onApproval = vi.fn().mockResolvedValue({ approve: true });
      const approvalRequest = buildApprovalRequest(
        'mcpr_callback_committed',
        '{"path":"safe"}',
      );
      approvalRequest.mcpTool = hostedMcpTool({
        serverLabel: 'stub',
        requireApproval: 'always',
        onApproval,
      });
      const rawItem = approvalRequest.requestItem
        .rawItem as protocol.HostedToolCallItem;
      const invocation = state._context._validateToolInvocation(
        TEST_AGENT,
        rawItem.name,
        rawItem,
      );
      state._observeToolInvocation(
        TEST_AGENT,
        invocation.callId,
        invocation.fingerprint,
      );

      await handleHostedMcpApprovals({
        requests: [approvalRequest],
        agent: TEST_AGENT,
        state,
        functionResults,
        appendIfNew: (item) => newItems.push(item),
        resolveApproval: (item) =>
          state._context._resolveToolInvocationApproval(
            TEST_AGENT,
            getHostedMcpApprovalToolName(item.name, item),
            item,
          ),
      });
      const providerData = rawItem.providerData as HostedMCPApprovalRequest;
      state._generatedItems.push(
        new RunToolCallItem(
          {
            ...rawItem,
            id: 'mcp-approval-source-item',
            name: 'mcp_approval_request',
            providerData,
          },
          TEST_AGENT,
        ),
        ...newItems,
      );
      state._commitToolInvocations(newItems);
      const serialized = state.toJSON() as any;
      if (readAsLegacy) {
        serialized.$schemaVersion = '1.17';
        delete serialized.context.approvalInvocations;
        delete serialized.completedToolInvocations;
      }

      const restored = await RunState.fromString(
        TEST_AGENT,
        JSON.stringify(serialized),
      );
      expect(
        restored._observeToolInvocation(
          TEST_AGENT,
          invocation.callId,
          invocation.fingerprint,
        ),
      ).toBe(true);
      expect(onApproval).toHaveBeenCalledTimes(1);
    },
  );

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
        state._context._resolveToolInvocationApproval(
          TEST_AGENT,
          getHostedMcpApprovalToolName(rawItem.name, rawItem),
          rawItem,
        ),
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
    expect((response.rawItem as protocol.HostedToolCallItem).caller).toEqual({
      type: 'program',
      callerId: 'call_prog_1',
    });
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalKeys.size).toBe(0);
  });

  it('forwards explicit reject messages into hosted MCP approval responses', async () => {
    const approvalRequest = buildApprovalRequest('mcpr_rejected');
    state.reject(approvalRequest.requestItem, {
      message: 'Denied by policy',
    });

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval: (rawItem) =>
        state._context._getHostedMcpApprovalStatus(rawItem),
    });

    expect(functionResults).toHaveLength(0);
    expect(newItems).toHaveLength(1);
    const response = newItems[0] as RunToolCallItem;
    const providerData = response.rawItem
      .providerData as HostedMCPApprovalResponse;
    expect(providerData).toMatchObject({
      approval_request_id: 'mcpr_rejected',
      approve: false,
      reason: 'Denied by policy',
    });
    expect((response.rawItem as protocol.HostedToolCallItem).caller).toEqual({
      type: 'program',
      callerId: 'call_prog_1',
    });
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalKeys.size).toBe(0);
  });

  it('omits hosted MCP rejection reasons by default', async () => {
    const approvalRequest = buildApprovalRequest('mcpr_rejected_default');
    state.reject(approvalRequest.requestItem);

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval: (rawItem) =>
        state._context._getHostedMcpApprovalStatus(rawItem),
    });

    expect(functionResults).toHaveLength(0);
    expect(newItems).toHaveLength(1);
    const response = newItems[0] as RunToolCallItem;
    const providerData = response.rawItem
      .providerData as HostedMCPApprovalResponse;
    expect(providerData).toMatchObject({
      approval_request_id: 'mcpr_rejected_default',
      approve: false,
    });
    expect(providerData.reason).toBeUndefined();
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalKeys.size).toBe(0);
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
        state._context._getHostedMcpApprovalStatus(rawItem),
    });

    expect(functionResults).toHaveLength(1);
    expect(functionResults[0].type).toBe('hosted_mcp_tool_approval');
    expect(newItems).toContain(approvalRequest.requestItem);
    expect(result.pendingApprovals.has(approvalRequest.requestItem)).toBe(true);
    expect(
      result.pendingApprovalKeys.has(
        JSON.stringify([
          'hosted_mcp_request',
          'stub',
          'list_files',
          'mcpr_pending',
        ]),
      ),
    ).toBe(true);
  });

  it('does not reuse persistent decisions across hosted MCP servers', () => {
    const serverA = buildApprovalRequest(
      'mcpr_server_a',
      'server-a',
      'lookup_account',
    );
    const sameServer = buildApprovalRequest(
      'mcpr_server_a_next',
      'server-a',
      'lookup_account',
    );
    const serverB = buildApprovalRequest(
      'mcpr_server_b',
      'server-b',
      'lookup_account',
    );

    state.approve(serverA.requestItem, { alwaysApprove: true });

    expect(
      state._context._getHostedMcpApprovalStatus(sameServer.requestItem),
    ).toBe(true);
    expect(
      state._context._getHostedMcpApprovalStatus(serverB.requestItem),
    ).toBeUndefined();
  });

  it('uses one canonical request ID for approval lookup and response', async () => {
    const approvalRequest = buildApprovalRequest('provider-request');
    approvalRequest.requestItem.rawItem.id = 'raw-request';
    state.approve(approvalRequest.requestItem);

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval: (rawItem) =>
        state._context._getHostedMcpApprovalStatus(rawItem),
    });

    expect(result.pendingApprovals.size).toBe(0);
    expect(newItems).toHaveLength(1);
    expect(newItems[0].rawItem.providerData).toMatchObject({
      approval_request_id: 'provider-request',
      approve: true,
    });
  });

  it('ignores non-hosted raw items', async () => {
    const result = await handleHostedMcpApprovals({
      requests: [
        {
          requestItem: {
            rawItem: {
              type: 'function_call',
              name: 'list_files',
            },
          },
          mcpTool: hostedMcpTool({
            serverLabel: 'stub',
            requireApproval: 'always',
          }),
        } as any,
      ],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
    });

    expect(functionResults).toHaveLength(0);
    expect(newItems).toHaveLength(0);
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalKeys.size).toBe(0);
  });

  it('ignores hosted approval items that are missing provider data', async () => {
    const approvalRequest = buildApprovalRequest('mcpr_missing_provider_data');
    (
      approvalRequest.requestItem.rawItem as protocol.HostedToolCallItem
    ).providerData = undefined as any;

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
    });

    expect(functionResults).toHaveLength(0);
    expect(newItems).toHaveLength(0);
    expect(result.pendingApprovals.size).toBe(0);
    expect(result.pendingApprovalKeys.size).toBe(0);
  });

  it('treats approval requests without ids as pending without tracking an id', async () => {
    const approvalRequest = buildApprovalRequest('mcpr_missing_id');
    const rawItem = approvalRequest.requestItem
      .rawItem as protocol.HostedToolCallItem;

    rawItem.id = undefined as any;
    (rawItem.providerData as HostedMCPApprovalRequest).id = undefined as any;

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
      resolveApproval: () => false,
    });

    expect(functionResults).toHaveLength(1);
    expect(newItems).toContain(approvalRequest.requestItem);
    expect(result.pendingApprovals.has(approvalRequest.requestItem)).toBe(true);
    expect(result.pendingApprovalKeys.size).toBe(0);
  });

  it('surfaces pending approvals when no resolver is provided', async () => {
    const approvalRequest = buildApprovalRequest('mcpr_no_resolver');

    const result = await handleHostedMcpApprovals({
      requests: [approvalRequest],
      agent: TEST_AGENT,
      state,
      functionResults,
      appendIfNew: (item) => newItems.push(item),
    });

    expect(functionResults).toHaveLength(1);
    expect(newItems).toContain(approvalRequest.requestItem);
    expect(result.pendingApprovals.has(approvalRequest.requestItem)).toBe(true);
    expect(
      result.pendingApprovalKeys.has(
        JSON.stringify([
          'hosted_mcp_request',
          'stub',
          'list_files',
          'mcpr_no_resolver',
        ]),
      ),
    ).toBe(true);
  });
});
