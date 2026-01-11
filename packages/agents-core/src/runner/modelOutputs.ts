import { Agent } from '../agent';
import { ModelBehaviorError } from '../errors';
import { Handoff } from '../handoff';
import {
  RunHandoffCallItem,
  RunItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolApprovalItem,
  RunToolCallItem,
} from '../items';
import { ModelResponse } from '../model';
import {
  ApplyPatchTool,
  ComputerTool,
  FunctionTool,
  HostedMCPTool,
  ShellTool,
  Tool,
} from '../tool';
import * as ProviderData from '../types/providerData';
import { addErrorToCurrentSpan } from '../tracing/context';
import type {
  ProcessedResponse,
  ToolRunApplyPatch,
  ToolRunComputer,
  ToolRunFunction,
  ToolRunHandoff,
  ToolRunMCPApprovalRequest,
  ToolRunShell,
} from './types';
import * as protocol from '../types/protocol';

function ensureToolAvailable<T>(
  tool: T | undefined,
  message: string,
  data: Record<string, unknown>,
): T {
  if (!tool) {
    addErrorToCurrentSpan({
      message,
      data,
    });
    throw new ModelBehaviorError(message);
  }
  return tool;
}

function handleToolCallAction<
  TTool extends {
    name: string;
  },
  TAction,
>({
  output,
  tool,
  agent,
  errorMessage,
  errorData,
  items,
  toolsUsed,
  actions,
  buildAction,
}: {
  output: protocol.ToolCallItem;
  tool: TTool | undefined;
  agent: Agent<any, any>;
  errorMessage: string;
  errorData: Record<string, unknown>;
  items: RunItem[];
  toolsUsed: string[];
  actions: TAction[];
  buildAction: (resolvedTool: TTool) => TAction;
}) {
  const resolvedTool = ensureToolAvailable(tool, errorMessage, errorData);
  items.push(new RunToolCallItem(output, agent));
  toolsUsed.push(resolvedTool.name);
  actions.push(buildAction(resolvedTool));
}

function resolveFunctionOrHandoff(
  toolCall: protocol.FunctionCallItem,
  handoffMap: Map<string, Handoff<any, any>>,
  functionMap: Map<string, FunctionTool<any>>,
  agent: Agent<any, any>,
):
  | { type: 'handoff'; handoff: Handoff<any, any> }
  | { type: 'function'; tool: FunctionTool<any> } {
  const handoff = handoffMap.get(toolCall.name);
  if (handoff) {
    return { type: 'handoff', handoff };
  }

  const functionTool = functionMap.get(toolCall.name);
  if (!functionTool) {
    const message = `Tool ${toolCall.name} not found in agent ${agent.name}.`;
    addErrorToCurrentSpan({
      message,
      data: {
        tool_name: toolCall.name,
        agent_name: agent.name,
      },
    });

    throw new ModelBehaviorError(message);
  }
  return { type: 'function', tool: functionTool };
}

/**
 * Walks a raw model response and classifies each item so the runner can schedule follow-up work.
 * Returns both the serializable RunItems (for history/streaming) and the actionable tool metadata.
 */
export function processModelResponse<TContext>(
  modelResponse: ModelResponse,
  agent: Agent<any, any>,
  tools: Tool<TContext>[],
  handoffs: Handoff<any, any>[],
): ProcessedResponse<TContext> {
  const items: RunItem[] = [];
  const runHandoffs: ToolRunHandoff[] = [];
  const runFunctions: ToolRunFunction<TContext>[] = [];
  const runComputerActions: ToolRunComputer[] = [];
  const runShellActions: ToolRunShell[] = [];
  const runApplyPatchActions: ToolRunApplyPatch[] = [];
  const runMCPApprovalRequests: ToolRunMCPApprovalRequest[] = [];
  const toolsUsed: string[] = [];
  const handoffMap = new Map(handoffs.map((h) => [h.toolName, h]));
  // Resolve tools upfront so we can look up the concrete handler in O(1) while iterating outputs.
  const functionMap = new Map(
    tools
      .filter((t): t is FunctionTool<TContext> => t.type === 'function')
      .map((t) => [t.name, t]),
  );
  const computerTool = tools.find(
    (t): t is ComputerTool<TContext, any> => t.type === 'computer',
  );
  const shellTool = tools.find((t): t is ShellTool => t.type === 'shell');
  const applyPatchTool = tools.find(
    (t): t is ApplyPatchTool => t.type === 'apply_patch',
  );
  const mcpToolMap = new Map(
    tools
      .filter((t) => t.type === 'hosted_tool' && t.providerData?.type === 'mcp')
      .map((t) => t as HostedMCPTool)
      .map((t) => [t.providerData.server_label, t]),
  );

  for (const output of modelResponse.output) {
    if (output.type === 'message') {
      if (output.role === 'assistant') {
        items.push(new RunMessageOutputItem(output, agent));
      }
    } else if (output.type === 'hosted_tool_call') {
      items.push(new RunToolCallItem(output, agent));
      const toolName = output.name;
      toolsUsed.push(toolName);

      if (
        output.providerData?.type === 'mcp_approval_request' ||
        output.name === 'mcp_approval_request'
      ) {
        // Hosted remote MCP server's approval process
        const providerData =
          output.providerData as ProviderData.HostedMCPApprovalRequest;

        const mcpServerLabel = providerData.server_label;
        const mcpServerTool = mcpToolMap.get(mcpServerLabel);
        if (typeof mcpServerTool === 'undefined') {
          const message = `MCP server (${mcpServerLabel}) not found in Agent (${agent.name})`;
          addErrorToCurrentSpan({
            message,
            data: { mcp_server_label: mcpServerLabel },
          });
          throw new ModelBehaviorError(message);
        }

        // Do this approval later:
        // We support both onApproval callback (like the Python SDK does) and HITL patterns.
        const approvalItem = new RunToolApprovalItem(
          {
            type: 'hosted_tool_call',
            // We must use this name to align with the name sent from the servers
            name: providerData.name,
            id: providerData.id,
            status: 'in_progress',
            providerData,
          },
          agent,
        );
        runMCPApprovalRequests.push({
          requestItem: approvalItem,
          mcpTool: mcpServerTool,
        });
        if (!mcpServerTool.providerData.on_approval) {
          // When onApproval function exists, it confirms the approval right after this.
          // Thus, this approval item must be appended only for the next turn interruption patterns.
          items.push(approvalItem);
        }
      }
    } else if (output.type === 'reasoning') {
      items.push(new RunReasoningItem(output, agent));
    } else if (output.type === 'computer_call') {
      handleToolCallAction({
        output,
        tool: computerTool,
        agent,
        errorMessage: 'Model produced computer action without a computer tool.',
        errorData: { agent_name: agent.name },
        items,
        toolsUsed,
        actions: runComputerActions,
        buildAction: (resolvedTool) => ({
          toolCall: output,
          computer: resolvedTool,
        }),
      });
    } else if (output.type === 'shell_call') {
      handleToolCallAction({
        output,
        tool: shellTool,
        agent,
        errorMessage: 'Model produced shell action without a shell tool.',
        errorData: { agent_name: agent.name },
        items,
        toolsUsed,
        actions: runShellActions,
        buildAction: (resolvedTool) => ({
          toolCall: output,
          shell: resolvedTool,
        }),
      });
    } else if (output.type === 'apply_patch_call') {
      handleToolCallAction({
        output,
        tool: applyPatchTool,
        agent,
        errorMessage:
          'Model produced apply_patch action without an apply_patch tool.',
        errorData: { agent_name: agent.name },
        items,
        toolsUsed,
        actions: runApplyPatchActions,
        buildAction: (resolvedTool) => ({
          toolCall: output,
          applyPatch: resolvedTool,
        }),
      });
    }
    /*
     * Intentionally skip returning here so function_call processing can still
     * run when output.type matches other tool call types.
     */
    if (output.type !== 'function_call') {
      continue;
    }

    toolsUsed.push(output.name);

    const resolved = resolveFunctionOrHandoff(
      output,
      handoffMap,
      functionMap,
      agent,
    );
    if (resolved.type === 'handoff') {
      items.push(new RunHandoffCallItem(output, agent));
      runHandoffs.push({
        toolCall: output,
        handoff: resolved.handoff,
      });
    } else {
      items.push(new RunToolCallItem(output, agent));
      runFunctions.push({
        toolCall: output,
        tool: resolved.tool,
      });
    }
  }

  return {
    newItems: items,
    handoffs: runHandoffs,
    functions: runFunctions,
    computerActions: runComputerActions,
    shellActions: runShellActions,
    applyPatchActions: runApplyPatchActions,
    mcpApprovalRequests: runMCPApprovalRequests,
    toolsUsed: toolsUsed,
    hasToolsOrApprovalsToRun(): boolean {
      return (
        runHandoffs.length > 0 ||
        runFunctions.length > 0 ||
        runMCPApprovalRequests.length > 0 ||
        runComputerActions.length > 0 ||
        runShellActions.length > 0 ||
        runApplyPatchActions.length > 0
      );
    },
  };
}
