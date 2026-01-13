import { Agent } from '../agent';
import { RunItem, RunToolApprovalItem, RunToolCallItem } from '../items';
import { RunState } from '../runState';
import { FunctionToolResult } from '../tool';
import * as ProviderData from '../types/providerData';
import * as protocol from '../types/protocol';
import type { ToolRunMCPApprovalRequest } from './types';

type ResolveApproval = (
  rawItem: protocol.HostedToolCallItem,
) => boolean | undefined;

type HandleHostedMcpApprovalsParams<TContext> = {
  requests: ToolRunMCPApprovalRequest[];
  agent: Agent<TContext, any>;
  state: RunState<TContext, Agent<TContext, any>>;
  functionResults: FunctionToolResult<TContext>[];
  appendIfNew: (item: RunItem) => void;
  resolveApproval?: ResolveApproval;
};

export type HandleHostedMcpApprovalsResult = {
  pendingApprovals: Set<RunToolApprovalItem>;
  pendingApprovalIds: Set<string>;
};

/**
 * Normalizes hosted MCP approval flows so streaming and non-streaming loops share identical
 * behavior. Handles synchronous approvals, previously decided approvals, and pending approvals.
 */
export async function handleHostedMcpApprovals<TContext>({
  requests,
  agent,
  state,
  functionResults,
  appendIfNew,
  resolveApproval,
}: HandleHostedMcpApprovalsParams<TContext>): Promise<HandleHostedMcpApprovalsResult> {
  const pendingApprovals = new Set<RunToolApprovalItem>();
  const pendingApprovalIds = new Set<string>();

  for (const approvalRequest of requests) {
    const rawItem = approvalRequest.requestItem.rawItem;
    if (rawItem.type !== 'hosted_tool_call') {
      continue;
    }

    const providerData = rawItem.providerData as
      | ProviderData.HostedMCPApprovalRequest
      | undefined;
    if (!providerData) {
      continue;
    }

    const toolData = approvalRequest.mcpTool.providerData as
      | ProviderData.HostedMCPTool<TContext>
      | undefined;
    const approvalRequestId = rawItem.id ?? providerData.id;

    if (toolData?.on_approval) {
      const approvalResult = await toolData.on_approval(
        state._context,
        approvalRequest.requestItem,
      );
      const approvalResponseData: ProviderData.HostedMCPApprovalResponse = {
        approve: approvalResult.approve,
        approval_request_id: approvalRequestId ?? providerData.id,
        reason: approvalResult.reason,
      };
      appendIfNew(
        new RunToolCallItem(
          {
            type: 'hosted_tool_call',
            name: 'mcp_approval_response',
            providerData: approvalResponseData,
          },
          agent as Agent<unknown, 'text'>,
        ),
      );
      continue;
    }

    const approvalDecision =
      typeof resolveApproval === 'function'
        ? resolveApproval(rawItem)
        : undefined;
    if (typeof approvalDecision !== 'undefined' && approvalRequestId) {
      const approvalResponseData: ProviderData.HostedMCPApprovalResponse = {
        approve: approvalDecision,
        approval_request_id: approvalRequestId,
        reason: undefined,
      };
      appendIfNew(
        new RunToolCallItem(
          {
            type: 'hosted_tool_call',
            name: 'mcp_approval_response',
            providerData: approvalResponseData,
          },
          agent as Agent<unknown, 'text'>,
        ),
      );
      continue;
    }

    functionResults.push({
      type: 'hosted_mcp_tool_approval',
      tool: approvalRequest.mcpTool,
      runItem: approvalRequest.requestItem,
    });
    appendIfNew(approvalRequest.requestItem);

    pendingApprovals.add(approvalRequest.requestItem);
    if (approvalRequestId) {
      pendingApprovalIds.add(approvalRequestId);
    }
  }

  return { pendingApprovals, pendingApprovalIds };
}
