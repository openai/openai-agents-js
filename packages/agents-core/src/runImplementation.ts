import { FunctionCallResultItem } from './types/protocol';
import type {
  ToolCallStructuredOutput,
  ToolOutputFileContent,
  ToolOutputImage,
  ToolOutputText,
} from './types/protocol';
import {
  Agent,
  AgentOutputType,
  ToolsToFinalOutputResult,
  consumeAgentToolRunResult,
} from './agent';
import { ModelBehaviorError, ToolCallError, UserError } from './errors';
import { getTransferMessage, Handoff, HandoffInputData } from './handoff';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from './items';
import logger, { Logger } from './logger';
import { ModelResponse, ModelSettings } from './model';
import {
  ComputerTool,
  FunctionTool,
  Tool,
  FunctionToolResult,
  HostedMCPTool,
} from './tool';
import { AgentInputItem, UnknownContext } from './types';
import { Runner } from './run';
import { RunContext } from './runContext';
import { getLastTextFromOutputMessage } from './utils/messages';
import { withFunctionSpan, withHandoffSpan } from './tracing/createSpans';
import { getSchemaAndParserFromInputType } from './utils/tools';
import { encodeUint8ArrayToBase64 } from './utils/base64';
import {
  isArrayBufferView,
  isNodeBuffer,
  isSerializedBufferSnapshot,
  toSmartString,
} from './utils/smartString';
import { safeExecute } from './utils/safeExecute';
import { addErrorToCurrentSpan } from './tracing/context';
import { RunItemStreamEvent, RunItemStreamEventName } from './events';
import { RunResult, StreamedRunResult } from './result';
import { z } from 'zod';
import * as protocol from './types/protocol';
import { Computer } from './computer';
import { RunState } from './runState';
import { isZodObject } from './utils';
import * as ProviderData from './types/providerData';
import type { Session, SessionInputCallback } from './memory/session';

// Represents a single handoff function call that still needs to be executed after the model turn.
type ToolRunHandoff = {
  toolCall: protocol.FunctionCallItem;
  handoff: Handoff<any, any>;
};

// Captures a function tool invocation emitted by the model along with the concrete tool to run.
type ToolRunFunction<TContext = UnknownContext> = {
  toolCall: protocol.FunctionCallItem;
  tool: FunctionTool<TContext>;
};

// Holds a pending computer-use action so we can dispatch to the configured computer tool.
type ToolRunComputer = {
  toolCall: protocol.ComputerUseCallItem;
  computer: ComputerTool;
};

// Tracks hosted MCP approval requests awaiting either automatic or user-driven authorization.
type ToolRunMCPApprovalRequest = {
  requestItem: RunToolApprovalItem;
  mcpTool: HostedMCPTool;
};

// Aggregates everything the model produced in a single turn. Downstream logic consumes this
// structure to decide which follow-up work (tools, handoffs, MCP approvals, computer calls) must run.
export type ProcessedResponse<TContext = UnknownContext> = {
  newItems: RunItem[];
  handoffs: ToolRunHandoff[];
  functions: ToolRunFunction<TContext>[];
  computerActions: ToolRunComputer[];
  mcpApprovalRequests: ToolRunMCPApprovalRequest[];
  toolsUsed: string[];
  hasToolsOrApprovalsToRun(): boolean;
};

type ApprovalItemLike =
  | RunToolApprovalItem
  | {
      rawItem?: protocol.FunctionCallItem | protocol.HostedToolCallItem;
      agent?: Agent<any, any>;
    };

function isApprovalItemLike(value: unknown): value is ApprovalItemLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (!('rawItem' in value)) {
    return false;
  }

  const rawItem = (value as { rawItem?: unknown }).rawItem;
  if (!rawItem || typeof rawItem !== 'object') {
    return false;
  }

  const itemType = (rawItem as { type?: unknown }).type;
  return itemType === 'function_call' || itemType === 'hosted_tool_call';
}

function getApprovalIdentity(approval: ApprovalItemLike): string | undefined {
  const rawItem = approval.rawItem;
  if (!rawItem) {
    return undefined;
  }

  if (rawItem.type === 'function_call' && rawItem.callId) {
    return `function_call:${rawItem.callId}`;
  }

  if ('callId' in rawItem && rawItem.callId) {
    return `${rawItem.type}:${rawItem.callId}`;
  }

  const id = 'id' in rawItem ? rawItem.id : undefined;
  if (id) {
    return `${rawItem.type}:${id}`;
  }

  const providerData =
    typeof rawItem.providerData === 'object' && rawItem.providerData
      ? (rawItem.providerData as { id?: string })
      : undefined;
  if (providerData?.id) {
    return `${rawItem.type}:provider:${providerData.id}`;
  }

  const agentName =
    'agent' in approval && approval.agent ? approval.agent.name : '';

  try {
    return `${agentName}:${rawItem.type}:${JSON.stringify(rawItem)}`;
  } catch {
    return `${agentName}:${rawItem.type}`;
  }
}

/**
 * @internal
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
  const runMCPApprovalRequests: ToolRunMCPApprovalRequest[] = [];
  const toolsUsed: string[] = [];
  const handoffMap = new Map(handoffs.map((h) => [h.toolName, h]));
  // Resolve tools upfront so we can look up the concrete handler in O(1) while iterating outputs.
  const functionMap = new Map(
    tools.filter((t) => t.type === 'function').map((t) => [t.name, t]),
  );
  const computerTool = tools.find((t) => t.type === 'computer');
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
      items.push(new RunToolCallItem(output, agent));
      toolsUsed.push('computer_use');
      if (!computerTool) {
        addErrorToCurrentSpan({
          message: 'Model produced computer action without a computer tool.',
          data: {
            agent_name: agent.name,
          },
        });
        throw new ModelBehaviorError(
          'Model produced computer action without a computer tool.',
        );
      }
      runComputerActions.push({
        toolCall: output,
        computer: computerTool,
      });
    }

    if (output.type !== 'function_call') {
      continue;
    }

    toolsUsed.push(output.name);

    const handoff = handoffMap.get(output.name);
    if (handoff) {
      items.push(new RunHandoffCallItem(output, agent));
      runHandoffs.push({
        toolCall: output,
        handoff: handoff,
      });
    } else {
      const functionTool = functionMap.get(output.name);
      if (!functionTool) {
        addErrorToCurrentSpan({
          message: `Tool ${output.name} not found in agent ${agent.name}.`,
          data: {
            tool_name: output.name,
            agent_name: agent.name,
          },
        });

        throw new ModelBehaviorError(
          `Tool ${output.name} not found in agent ${agent.name}.`,
        );
      }
      items.push(new RunToolCallItem(output, agent));
      runFunctions.push({
        toolCall: output,
        tool: functionTool,
      });
    }
  }

  return {
    newItems: items,
    handoffs: runHandoffs,
    functions: runFunctions,
    computerActions: runComputerActions,
    mcpApprovalRequests: runMCPApprovalRequests,
    toolsUsed: toolsUsed,
    hasToolsOrApprovalsToRun(): boolean {
      return (
        runHandoffs.length > 0 ||
        runFunctions.length > 0 ||
        runMCPApprovalRequests.length > 0 ||
        runComputerActions.length > 0
      );
    },
  };
}

export const nextStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('next_step_handoff'),
    newAgent: z.any(),
  }),
  z.object({
    type: z.literal('next_step_final_output'),
    output: z.string(),
  }),
  z.object({
    type: z.literal('next_step_run_again'),
  }),
  z.object({
    type: z.literal('next_step_interruption'),
    data: z.record(z.string(), z.any()),
  }),
]);

export type NextStep = z.infer<typeof nextStepSchema>;

/**
 * Internal convenience wrapper that groups the outcome of a single agent turn. It lets the caller
 * update the RunState in one shot and decide which step to execute next.
 */
class SingleStepResult {
  constructor(
    /**
     * The input items (i.e., the items before run() was called). May be mutated by handoff input filters.
     */
    public originalInput: string | AgentInputItem[],
    /**
     * The model response for the current step
     */
    public modelResponse: ModelResponse,
    /**
     * The items before the current step was executed
     */
    public preStepItems: RunItem[],
    /**
     * The items after the current step was executed
     */
    public newStepItems: RunItem[],
    /**
     * The next step to execute
     */
    public nextStep: NextStep,
  ) {}

  /**
   * The items generated during the agent run (i.e. everything generated after originalInput)
   */
  get generatedItems(): RunItem[] {
    return this.preStepItems.concat(this.newStepItems);
  }
}

/**
 * @internal
 * Resets the tool choice when the agent is configured to prefer a fresh tool selection after
 * any tool usage. This prevents the provider from reusing stale tool hints across turns.
 */
export function maybeResetToolChoice(
  agent: Agent<any, any>,
  toolUseTracker: AgentToolUseTracker,
  modelSettings: ModelSettings,
) {
  if (agent.resetToolChoice && toolUseTracker.hasUsedTools(agent)) {
    return { ...modelSettings, toolChoice: undefined };
  }
  return modelSettings;
}

/**
 * @internal
 * Continues a turn that was previously interrupted waiting for tool approval. Executes the now
 * approved tools and returns the resulting step transition.
 */
export async function resolveInterruptedTurn<TContext>(
  agent: Agent<TContext, any>,
  originalInput: string | AgentInputItem[],
  originalPreStepItems: RunItem[],
  newResponse: ModelResponse,
  processedResponse: ProcessedResponse,
  runner: Runner,
  state: RunState<TContext, Agent<TContext, any>>,
): Promise<SingleStepResult> {
  // call_ids for function tools
  const functionCallIds = originalPreStepItems
    .filter(
      (item) =>
        item instanceof RunToolApprovalItem &&
        'callId' in item.rawItem &&
        item.rawItem.type === 'function_call',
    )
    .map((item) => (item.rawItem as protocol.FunctionCallItem).callId);

  // We already persisted the turn once when the approval interrupt was raised, so the
  // counter reflects the approval items as "flushed". When we resume the same turn we need
  // to rewind it so the eventual tool output for this call is still written to the session.
  const pendingApprovalItems = state
    .getInterruptions()
    .filter(isApprovalItemLike);

  if (pendingApprovalItems.length > 0) {
    const pendingApprovalIdentities = new Set<string>();
    for (const approval of pendingApprovalItems) {
      const identity = getApprovalIdentity(approval);
      if (identity) {
        pendingApprovalIdentities.add(identity);
      }
    }

    if (pendingApprovalIdentities.size > 0) {
      let rewindCount = 0;
      for (let index = originalPreStepItems.length - 1; index >= 0; index--) {
        const item = originalPreStepItems[index];
        if (!(item instanceof RunToolApprovalItem)) {
          continue;
        }

        const identity = getApprovalIdentity(item);
        if (!identity) {
          continue;
        }

        if (!pendingApprovalIdentities.has(identity)) {
          continue;
        }

        rewindCount++;
        pendingApprovalIdentities.delete(identity);

        if (pendingApprovalIdentities.size === 0) {
          break;
        }
      }

      // Persisting the approval request already advanced the counter once, so undo the increment
      // to make sure we write the final tool output back to the session when the turn resumes.
      if (rewindCount > 0) {
        state._currentTurnPersistedItemCount = Math.max(
          0,
          state._currentTurnPersistedItemCount - rewindCount,
        );
      }
    }
  }
  // Run function tools that require approval after they get their approval results
  const functionToolRuns = processedResponse.functions.filter((run) => {
    return functionCallIds.includes(run.toolCall.callId);
  });

  const functionResults = await executeFunctionToolCalls(
    agent,
    functionToolRuns,
    runner,
    state,
  );

  // There is no built-in HITL approval surface for computer tools today, so every pending action
  // is executed immediately when the turn resumes.
  const computerResults =
    processedResponse.computerActions.length > 0
      ? await executeComputerActions(
          agent,
          processedResponse.computerActions,
          runner,
          state._context,
        )
      : [];

  // When resuming we receive the original RunItem references; suppress duplicates so history and streaming do not double-emit the same items.
  const originalPreStepItemSet = new Set(originalPreStepItems);
  const newItems: RunItem[] = [];
  const newItemsSet = new Set<RunItem>();
  const appendIfNew = (item: RunItem) => {
    if (originalPreStepItemSet.has(item) || newItemsSet.has(item)) {
      return;
    }
    newItems.push(item);
    newItemsSet.add(item);
  };

  for (const result of functionResults) {
    appendIfNew(result.runItem);
  }

  for (const result of computerResults) {
    appendIfNew(result);
  }

  // Run MCP tools that require approval after they get their approval results
  const mcpApprovalRuns = processedResponse.mcpApprovalRequests.filter(
    (run) => {
      return (
        run.requestItem.type === 'tool_approval_item' &&
        run.requestItem.rawItem.type === 'hosted_tool_call' &&
        run.requestItem.rawItem.providerData?.type === 'mcp_approval_request'
      );
    },
  );
  // Hosted MCP approvals may still be waiting on a human decision when the turn resumes.
  const pendingHostedMCPApprovals = new Set<RunToolApprovalItem>();
  const pendingHostedMCPApprovalIds = new Set<string>();
  // Keep track of approvals we still need to surface next turn so HITL flows can resume cleanly.
  for (const run of mcpApprovalRuns) {
    // the approval_request_id "mcpr_123..."
    const approvalRequestId = run.requestItem.rawItem.id!;
    const approved = state._context.isToolApproved({
      // Since this item name must be the same with the one sent from Responses API server
      toolName: run.requestItem.rawItem.name,
      callId: approvalRequestId,
    });
    if (typeof approved !== 'undefined') {
      const providerData: ProviderData.HostedMCPApprovalResponse = {
        approve: approved,
        approval_request_id: approvalRequestId,
        reason: undefined,
      };
      // Tell Responses API server the approval result in the next turn
      const responseItem = new RunToolCallItem(
        {
          type: 'hosted_tool_call',
          name: 'mcp_approval_response',
          providerData,
        },
        agent as Agent<unknown, 'text'>,
      );
      appendIfNew(responseItem);
    } else {
      pendingHostedMCPApprovals.add(run.requestItem);
      pendingHostedMCPApprovalIds.add(approvalRequestId);
      functionResults.push({
        type: 'hosted_mcp_tool_approval',
        tool: run.mcpTool,
        runItem: run.requestItem,
      });
      appendIfNew(run.requestItem);
    }
  }

  // Server-managed conversations rely on preStepItems to re-surface pending approvals.
  // Keep unresolved hosted MCP approvals in place so HITL flows still have something to approve next turn.
  // Drop resolved approval placeholders so they are not replayed on the next turn, but keep
  // pending approvals in place to signal the outstanding work to the UI and session store.
  const preStepItems = originalPreStepItems.filter((item) => {
    if (!(item instanceof RunToolApprovalItem)) {
      return true;
    }

    if (
      item.rawItem.type === 'hosted_tool_call' &&
      item.rawItem.providerData?.type === 'mcp_approval_request'
    ) {
      if (pendingHostedMCPApprovals.has(item)) {
        return true;
      }
      const approvalRequestId = item.rawItem.id;
      if (approvalRequestId) {
        return pendingHostedMCPApprovalIds.has(approvalRequestId);
      }
      return false;
    }

    return false;
  });

  const completedStep = await maybeCompleteTurnFromToolResults({
    agent,
    runner,
    state,
    functionResults,
    originalInput,
    newResponse,
    preStepItems,
    newItems,
  });

  if (completedStep) {
    return completedStep;
  }

  // we only ran new tools and side effects. We need to run the rest of the agent
  return new SingleStepResult(
    originalInput,
    newResponse,
    preStepItems,
    newItems,
    { type: 'next_step_run_again' },
  );
}

/**
 * @internal
 * Executes every follow-up action the model requested (function tools, computer actions, MCP flows),
 * appends their outputs to the run history, and determines the next step for the agent loop.
 */
export async function resolveTurnAfterModelResponse<TContext>(
  agent: Agent<TContext, any>,
  originalInput: string | AgentInputItem[],
  originalPreStepItems: RunItem[],
  newResponse: ModelResponse,
  processedResponse: ProcessedResponse<TContext>,
  runner: Runner,
  state: RunState<TContext, Agent<TContext, any>>,
): Promise<SingleStepResult> {
  // Reuse the same array reference so we can compare object identity when deciding whether to
  // append new items, ensuring we never double-stream existing RunItems.
  const preStepItems = originalPreStepItems;
  const seenItems = new Set<RunItem>(originalPreStepItems);
  const newItems: RunItem[] = [];
  const appendIfNew = (item: RunItem) => {
    if (seenItems.has(item)) {
      return;
    }
    newItems.push(item);
    seenItems.add(item);
  };

  for (const item of processedResponse.newItems) {
    appendIfNew(item);
  }

  // Run function tools and computer actions in parallel; neither depends on the other's side effects.
  const [functionResults, computerResults] = await Promise.all([
    executeFunctionToolCalls(
      agent,
      processedResponse.functions as ToolRunFunction<unknown>[],
      runner,
      state,
    ),
    executeComputerActions(
      agent,
      processedResponse.computerActions,
      runner,
      state._context,
    ),
  ]);

  for (const result of functionResults) {
    appendIfNew(result.runItem);
  }
  for (const item of computerResults) {
    appendIfNew(item);
  }

  // run hosted MCP approval requests
  if (processedResponse.mcpApprovalRequests.length > 0) {
    for (const approvalRequest of processedResponse.mcpApprovalRequests) {
      const toolData = approvalRequest.mcpTool
        .providerData as ProviderData.HostedMCPTool<TContext>;
      const requestData = approvalRequest.requestItem.rawItem
        .providerData as ProviderData.HostedMCPApprovalRequest;
      if (toolData.on_approval) {
        // synchronously handle the approval process here
        const approvalResult = await toolData.on_approval(
          state._context,
          approvalRequest.requestItem,
        );
        const approvalResponseData: ProviderData.HostedMCPApprovalResponse = {
          approve: approvalResult.approve,
          approval_request_id: requestData.id,
          reason: approvalResult.reason,
        };
        newItems.push(
          new RunToolCallItem(
            {
              type: 'hosted_tool_call',
              name: 'mcp_approval_response',
              providerData: approvalResponseData,
            },
            agent as Agent<unknown, 'text'>,
          ),
        );
      } else {
        // receive a user's approval on the next turn
        newItems.push(approvalRequest.requestItem);
        const approvalItem = {
          type: 'hosted_mcp_tool_approval' as const,
          tool: approvalRequest.mcpTool,
          runItem: new RunToolApprovalItem(
            {
              type: 'hosted_tool_call',
              name: requestData.name,
              id: requestData.id,
              arguments: requestData.arguments,
              status: 'in_progress',
              providerData: requestData,
            },
            agent,
          ),
        };
        functionResults.push(approvalItem);
        // newItems.push(approvalItem.runItem);
      }
    }
  }

  // process handoffs
  if (processedResponse.handoffs.length > 0) {
    return await executeHandoffCalls(
      agent,
      originalInput,
      preStepItems,
      newItems,
      newResponse,
      processedResponse.handoffs,
      runner,
      state._context,
    );
  }

  const completedStep = await maybeCompleteTurnFromToolResults({
    agent,
    runner,
    state,
    functionResults,
    originalInput,
    newResponse,
    preStepItems,
    newItems,
  });

  if (completedStep) {
    return completedStep;
  }

  // If the model issued any tool calls or handoffs in this turn,
  // we must NOT treat any assistant message in the same turn as the final output.
  // We should run the loop again so the model can see the tool results and respond.
  const hadToolCallsOrActions =
    (processedResponse.functions?.length ?? 0) > 0 ||
    (processedResponse.computerActions?.length ?? 0) > 0 ||
    (processedResponse.mcpApprovalRequests?.length ?? 0) > 0 ||
    (processedResponse.handoffs?.length ?? 0) > 0;
  if (hadToolCallsOrActions) {
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      { type: 'next_step_run_again' },
    );
  }
  // No tool calls/actions in this turn; safe to consider a plain assistant message as final.
  const messageItems = newItems.filter(
    (item) => item instanceof RunMessageOutputItem,
  );

  // we will use the last content output as the final output
  const potentialFinalOutput =
    messageItems.length > 0
      ? getLastTextFromOutputMessage(
          messageItems[messageItems.length - 1].rawItem,
        )
      : undefined;

  // if there is no output we just run again
  if (typeof potentialFinalOutput === 'undefined') {
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      { type: 'next_step_run_again' },
    );
  }

  // Keep looping if any tool output placeholders still require an approval follow-up.
  const hasPendingToolsOrApprovals = functionResults.some(
    (result) => result.runItem instanceof RunToolApprovalItem,
  );

  if (!hasPendingToolsOrApprovals) {
    if (agent.outputType === 'text') {
      return new SingleStepResult(
        originalInput,
        newResponse,
        preStepItems,
        newItems,
        {
          type: 'next_step_final_output',
          output: potentialFinalOutput,
        },
      );
    }

    if (agent.outputType !== 'text' && potentialFinalOutput) {
      // Structured output schema => always leads to a final output if we have text.
      const { parser } = getSchemaAndParserFromInputType(
        agent.outputType,
        'final_output',
      );
      const [error] = await safeExecute(() => parser(potentialFinalOutput));
      if (error) {
        addErrorToCurrentSpan({
          message: 'Invalid output type',
          data: {
            error: String(error),
          },
        });
        throw new ModelBehaviorError('Invalid output type');
      }

      return new SingleStepResult(
        originalInput,
        newResponse,
        preStepItems,
        newItems,
        { type: 'next_step_final_output', output: potentialFinalOutput },
      );
    }
  }

  return new SingleStepResult(
    originalInput,
    newResponse,
    preStepItems,
    newItems,
    { type: 'next_step_run_again' },
  );
}

type TurnFinalizationParams<TContext> = {
  agent: Agent<TContext, any>;
  runner: Runner;
  state: RunState<TContext, Agent<TContext, any>>;
  functionResults: FunctionToolResult[];
  originalInput: string | AgentInputItem[];
  newResponse: ModelResponse;
  preStepItems: RunItem[];
  newItems: RunItem[];
};

// Consolidates the logic that determines whether tool results yielded a final answer,
// triggered an interruption, or require the agent loop to continue running.
async function maybeCompleteTurnFromToolResults<TContext>({
  agent,
  runner,
  state,
  functionResults,
  originalInput,
  newResponse,
  preStepItems,
  newItems,
}: TurnFinalizationParams<TContext>): Promise<SingleStepResult | null> {
  const toolOutcome = await checkForFinalOutputFromTools(
    agent,
    functionResults,
    state,
  );

  if (toolOutcome.isFinalOutput) {
    runner.emit('agent_end', state._context, agent, toolOutcome.finalOutput);
    agent.emit('agent_end', state._context, toolOutcome.finalOutput);

    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      {
        type: 'next_step_final_output',
        output: toolOutcome.finalOutput,
      },
    );
  }

  if (toolOutcome.isInterrupted) {
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      {
        type: 'next_step_interruption',
        data: {
          interruptions: toolOutcome.interruptions,
        },
      },
    );
  }

  return null;
}

/**
 * @internal
 * Normalizes tool outputs once so downstream code works with fully structured protocol items.
 * Doing this here keeps API surface stable even when providers add new shapes.
 */
export function getToolCallOutputItem(
  toolCall: protocol.FunctionCallItem,
  output: string | unknown,
): FunctionCallResultItem {
  const maybeStructuredOutputs = normalizeStructuredToolOutputs(output);

  if (maybeStructuredOutputs) {
    const structuredItems = maybeStructuredOutputs.map(
      convertStructuredToolOutputToInputItem,
    );

    return {
      type: 'function_call_result',
      name: toolCall.name,
      callId: toolCall.callId,
      status: 'completed',
      output: structuredItems,
    };
  }

  return {
    type: 'function_call_result',
    name: toolCall.name,
    callId: toolCall.callId,
    status: 'completed',
    output: {
      type: 'text',
      text: toSmartString(output),
    },
  };
}

function normalizeFileValue(
  value: Record<string, any>,
): FileReferenceValue | null {
  const directFile = value.file;
  if (typeof directFile === 'string' && directFile.length > 0) {
    return directFile;
  }

  const normalizedObject = normalizeFileObjectCandidate(directFile);
  if (normalizedObject) {
    return normalizedObject;
  }

  const legacyValue = normalizeLegacyFileValue(value);
  if (legacyValue) {
    return legacyValue;
  }

  return null;
}

function normalizeFileObjectCandidate(
  value: unknown,
): FileReferenceValue | null {
  if (!isRecord(value)) {
    return null;
  }

  if ('data' in value && value.data !== undefined) {
    const dataValue = value.data;
    const hasStringData = typeof dataValue === 'string' && dataValue.length > 0;
    const hasBinaryData =
      dataValue instanceof Uint8Array && dataValue.length > 0;
    if (!hasStringData && !hasBinaryData) {
      return null;
    }

    if (
      !isNonEmptyString(value.mediaType) ||
      !isNonEmptyString(value.filename)
    ) {
      return null;
    }

    return {
      data:
        typeof dataValue === 'string' ? dataValue : new Uint8Array(dataValue),
      mediaType: value.mediaType,
      filename: value.filename,
    };
  }

  if (isNonEmptyString(value.url)) {
    const result: { url: string; filename?: string } = { url: value.url };
    if (isNonEmptyString(value.filename)) {
      result.filename = value.filename;
    }
    return result;
  }

  const referencedId =
    (isNonEmptyString(value.id) && value.id) ||
    (isNonEmptyString(value.fileId) && (value.fileId as string));
  if (referencedId) {
    const result: { id: string; filename?: string } = { id: referencedId };
    if (isNonEmptyString(value.filename)) {
      result.filename = value.filename;
    }
    return result;
  }

  return null;
}

function normalizeLegacyFileValue(
  value: Record<string, any>,
): FileReferenceValue | null {
  const filename =
    typeof value.filename === 'string' && value.filename.length > 0
      ? value.filename
      : undefined;
  const mediaType =
    typeof value.mediaType === 'string' && value.mediaType.length > 0
      ? value.mediaType
      : undefined;

  if (typeof value.fileData === 'string' && value.fileData.length > 0) {
    if (!mediaType || !filename) {
      return null;
    }
    return { data: value.fileData, mediaType, filename };
  }

  if (value.fileData instanceof Uint8Array && value.fileData.length > 0) {
    if (!mediaType || !filename) {
      return null;
    }
    return { data: new Uint8Array(value.fileData), mediaType, filename };
  }

  if (typeof value.fileUrl === 'string' && value.fileUrl.length > 0) {
    const result: { url: string; filename?: string } = { url: value.fileUrl };
    if (filename) {
      result.filename = filename;
    }
    return result;
  }

  if (typeof value.fileId === 'string' && value.fileId.length > 0) {
    const result: { id: string; filename?: string } = { id: value.fileId };
    if (filename) {
      result.filename = filename;
    }
    return result;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toInlineImageString(
  data: string | Uint8Array,
  mediaType?: string,
): string {
  if (typeof data === 'string') {
    if (mediaType && !data.startsWith('data:')) {
      return asDataUrl(data, mediaType);
    }
    return data;
  }
  const base64 = encodeUint8ArrayToBase64(data);
  return asDataUrl(base64, mediaType);
}

function asDataUrl(base64: string, mediaType?: string): string {
  return mediaType ? `data:${mediaType};base64,${base64}` : base64;
}

/**
 * @internal
 * Runs every function tool call requested by the model and returns their outputs alongside
 * the `RunItem` instances that should be appended to history.
 */
export async function executeFunctionToolCalls<TContext = UnknownContext>(
  agent: Agent<any, any>,
  toolRuns: ToolRunFunction<unknown>[],
  runner: Runner,
  state: RunState<TContext, Agent<any, any>>,
): Promise<FunctionToolResult[]> {
  async function runSingleTool(toolRun: ToolRunFunction<unknown>) {
    let parsedArgs: any = toolRun.toolCall.arguments;
    if (toolRun.tool.parameters) {
      if (isZodObject(toolRun.tool.parameters)) {
        parsedArgs = toolRun.tool.parameters.parse(parsedArgs);
      } else {
        parsedArgs = JSON.parse(parsedArgs);
      }
    }
    // Some tools require a human or policy check before execution; defer until approval is recorded.
    const needsApproval = await toolRun.tool.needsApproval(
      state._context,
      parsedArgs,
      toolRun.toolCall.callId,
    );

    if (needsApproval) {
      const approval = state._context.isToolApproved({
        toolName: toolRun.tool.name,
        callId: toolRun.toolCall.callId,
      });

      if (approval === false) {
        // rejected
        return withFunctionSpan(
          async (span) => {
            const response = 'Tool execution was not approved.';

            span.setError({
              message: response,
              data: {
                tool_name: toolRun.tool.name,
                error: `Tool execution for ${toolRun.toolCall.callId} was manually rejected by user.`,
              },
            });

            span.spanData.output = response;
            return {
              type: 'function_output' as const,
              tool: toolRun.tool,
              output: response,
              runItem: new RunToolCallOutputItem(
                getToolCallOutputItem(toolRun.toolCall, response),
                agent,
                response,
              ),
            };
          },
          {
            data: {
              name: toolRun.tool.name,
            },
          },
        );
      }

      if (approval !== true) {
        // this approval process needs to be done in the next turn
        return {
          type: 'function_approval' as const,
          tool: toolRun.tool,
          runItem: new RunToolApprovalItem(toolRun.toolCall, agent),
        };
      }
    }

    return withFunctionSpan(
      async (span) => {
        if (runner.config.traceIncludeSensitiveData) {
          span.spanData.input = toolRun.toolCall.arguments;
        }

        try {
          runner.emit('agent_tool_start', state._context, agent, toolRun.tool, {
            toolCall: toolRun.toolCall,
          });
          agent.emit('agent_tool_start', state._context, toolRun.tool, {
            toolCall: toolRun.toolCall,
          });
          const toolOutput = await toolRun.tool.invoke(
            state._context,
            toolRun.toolCall.arguments,
            { toolCall: toolRun.toolCall },
          );
          // Use string data for tracing and event emitter
          const stringResult = toSmartString(toolOutput);

          runner.emit(
            'agent_tool_end',
            state._context,
            agent,
            toolRun.tool,
            stringResult,
            { toolCall: toolRun.toolCall },
          );
          agent.emit(
            'agent_tool_end',
            state._context,
            toolRun.tool,
            stringResult,
            { toolCall: toolRun.toolCall },
          );

          if (runner.config.traceIncludeSensitiveData) {
            span.spanData.output = stringResult;
          }

          const functionResult: FunctionToolResult = {
            type: 'function_output' as const,
            tool: toolRun.tool,
            output: toolOutput,
            runItem: new RunToolCallOutputItem(
              getToolCallOutputItem(toolRun.toolCall, toolOutput),
              agent,
              toolOutput,
            ),
          };

          const nestedRunResult = consumeAgentToolRunResult(toolRun.toolCall);
          if (nestedRunResult) {
            functionResult.agentRunResult = nestedRunResult;
            const nestedInterruptions = nestedRunResult.interruptions;
            if (nestedInterruptions.length > 0) {
              functionResult.interruptions = nestedInterruptions;
            }
          }

          return functionResult;
        } catch (error) {
          span.setError({
            message: 'Error running tool',
            data: {
              tool_name: toolRun.tool.name,
              error: String(error),
            },
          });
          throw error;
        }
      },
      {
        data: {
          name: toolRun.tool.name,
        },
      },
    );
  }

  try {
    const results = await Promise.all(toolRuns.map(runSingleTool));
    return results;
  } catch (e: unknown) {
    throw new ToolCallError(
      `Failed to run function tools: ${e}`,
      e as Error,
      state,
    );
  }
}

/**
 * @internal
 */
// Internal helper: dispatch a computer action and return a screenshot (sync/async)
async function _runComputerActionAndScreenshot(
  computer: Computer,
  toolCall: protocol.ComputerUseCallItem,
): Promise<string> {
  const action = toolCall.action;
  let screenshot: string | undefined;
  // Dispatch based on action type string (assume action.type exists)
  switch (action.type) {
    case 'click':
      await computer.click(action.x, action.y, action.button);
      break;
    case 'double_click':
      await computer.doubleClick(action.x, action.y);
      break;
    case 'drag':
      await computer.drag(action.path.map((p: any) => [p.x, p.y]));
      break;
    case 'keypress':
      await computer.keypress(action.keys);
      break;
    case 'move':
      await computer.move(action.x, action.y);
      break;
    case 'screenshot':
      screenshot = await computer.screenshot();
      break;
    case 'scroll':
      await computer.scroll(
        action.x,
        action.y,
        action.scroll_x,
        action.scroll_y,
      );
      break;
    case 'type':
      await computer.type(action.text);
      break;
    case 'wait':
      await computer.wait();
      break;
    default:
      action satisfies never; // ensures that we handle every action we know of
      // Unknown action, just take screenshot
      break;
  }
  if (typeof screenshot !== 'undefined') {
    return screenshot;
  }
  // Always return screenshot as base64 string
  if (typeof computer.screenshot === 'function') {
    screenshot = await computer.screenshot();
    if (typeof screenshot !== 'undefined') {
      return screenshot;
    }
  }
  throw new Error('Computer does not implement screenshot()');
}

/**
 * @internal
 * Executes any computer-use actions emitted by the model and returns the resulting items so the
 * run history reflects the computer session.
 */
export async function executeComputerActions(
  agent: Agent<any, any>,
  actions: ToolRunComputer[],
  runner: Runner,
  runContext: RunContext,
  customLogger: Logger | undefined = undefined,
): Promise<RunItem[]> {
  const _logger = customLogger ?? logger;
  const results: RunItem[] = [];
  for (const action of actions) {
    const computer = action.computer.computer;
    const toolCall = action.toolCall;

    // Hooks: on_tool_start (global + agent)
    runner.emit('agent_tool_start', runContext, agent, action.computer, {
      toolCall,
    });
    if (typeof agent.emit === 'function') {
      agent.emit('agent_tool_start', runContext, action.computer, { toolCall });
    }

    // Run the action and get screenshot
    let output: string;
    try {
      output = await _runComputerActionAndScreenshot(computer, toolCall);
    } catch (err) {
      _logger.error('Failed to execute computer action:', err);
      output = '';
    }

    // Hooks: on_tool_end (global + agent)
    runner.emit('agent_tool_end', runContext, agent, action.computer, output, {
      toolCall,
    });
    if (typeof agent.emit === 'function') {
      agent.emit('agent_tool_end', runContext, action.computer, output, {
        toolCall,
      });
    }

    // Return the screenshot as a data URL when available; fall back to an empty string on failures.
    const imageUrl = output ? `data:image/png;base64,${output}` : '';
    const rawItem: protocol.ComputerCallResultItem = {
      type: 'computer_call_result',
      callId: toolCall.callId,
      output: { type: 'computer_screenshot', data: imageUrl },
    };
    results.push(new RunToolCallOutputItem(rawItem, agent, imageUrl));
  }
  return results;
}

/**
 * @internal
 * Drives handoff calls by invoking the downstream agent and capturing any generated items so
 * the current agent can continue with the new context.
 */
export async function executeHandoffCalls<
  TContext,
  TOutput extends AgentOutputType,
>(
  agent: Agent<TContext, TOutput>,
  originalInput: string | AgentInputItem[],
  preStepItems: RunItem[],
  newStepItems: RunItem[],
  newResponse: ModelResponse,
  runHandoffs: ToolRunHandoff[],
  runner: Runner,
  runContext: RunContext<TContext>,
): Promise<SingleStepResult> {
  newStepItems = [...newStepItems];

  if (runHandoffs.length === 0) {
    logger.warn(
      'Incorrectly called executeHandoffCalls with no handoffs. This should not happen. Moving on.',
    );
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newStepItems,
      { type: 'next_step_run_again' },
    );
  }

  if (runHandoffs.length > 1) {
    // multiple handoffs. Ignoring all but the first one by adding reject responses for those
    const outputMessage = 'Multiple handoffs detected, ignoring this one.';
    for (let i = 1; i < runHandoffs.length; i++) {
      newStepItems.push(
        new RunToolCallOutputItem(
          getToolCallOutputItem(runHandoffs[i].toolCall, outputMessage),
          agent,
          outputMessage,
        ),
      );
    }
  }

  const actualHandoff = runHandoffs[0];

  return withHandoffSpan(
    async (handoffSpan) => {
      const handoff = actualHandoff.handoff;

      const newAgent = await handoff.onInvokeHandoff(
        runContext,
        actualHandoff.toolCall.arguments,
      );

      handoffSpan.spanData.to_agent = newAgent.name;

      if (runHandoffs.length > 1) {
        const requestedAgents = runHandoffs.map((h) => h.handoff.agentName);
        handoffSpan.setError({
          message: 'Multiple handoffs requested',
          data: {
            requested_agents: requestedAgents,
          },
        });
      }

      newStepItems.push(
        new RunHandoffOutputItem(
          getToolCallOutputItem(
            actualHandoff.toolCall,
            getTransferMessage(newAgent),
          ),
          agent,
          newAgent,
        ),
      );

      runner.emit('agent_handoff', runContext, agent, newAgent);
      agent.emit('agent_handoff', runContext, newAgent);

      const inputFilter =
        handoff.inputFilter ?? runner.config.handoffInputFilter;
      if (inputFilter) {
        logger.debug('Filtering inputs for handoff');

        if (typeof inputFilter !== 'function') {
          handoffSpan.setError({
            message: 'Invalid input filter',
            data: {
              details: 'not callable',
            },
          });
        }

        const handoffInputData: HandoffInputData = {
          inputHistory: Array.isArray(originalInput)
            ? [...originalInput]
            : originalInput,
          preHandoffItems: [...preStepItems],
          newItems: [...newStepItems],
          runContext,
        };

        const filtered = inputFilter(handoffInputData);

        originalInput = filtered.inputHistory;
        preStepItems = filtered.preHandoffItems;
        newStepItems = filtered.newItems;
      }

      return new SingleStepResult(
        originalInput,
        newResponse,
        preStepItems,
        newStepItems,
        { type: 'next_step_handoff', newAgent },
      );
    },
    {
      data: {
        from_agent: agent.name,
      },
    },
  );
}

const NOT_FINAL_OUTPUT: ToolsToFinalOutputResult = {
  isFinalOutput: false,
  isInterrupted: undefined,
};

/**
 * @internal
 * Determines whether tool executions produced a final agent output, triggered an interruption,
 * or whether the agent loop should continue collecting more responses.
 */
export async function checkForFinalOutputFromTools<
  TContext,
  TOutput extends AgentOutputType,
>(
  agent: Agent<TContext, TOutput>,
  toolResults: FunctionToolResult[],
  state: RunState<TContext, Agent<TContext, TOutput>>,
): Promise<ToolsToFinalOutputResult> {
  if (toolResults.length === 0) {
    return NOT_FINAL_OUTPUT;
  }

  const interruptions: RunToolApprovalItem[] = [];
  for (const result of toolResults) {
    if (result.runItem instanceof RunToolApprovalItem) {
      interruptions.push(result.runItem);
    }

    if (result.type === 'function_output') {
      if (Array.isArray(result.interruptions)) {
        interruptions.push(...result.interruptions);
      } else if (result.agentRunResult) {
        const nestedInterruptions = result.agentRunResult.interruptions;
        if (nestedInterruptions.length > 0) {
          interruptions.push(...nestedInterruptions);
        }
      }
    }
  }

  if (interruptions.length > 0) {
    return {
      isFinalOutput: false,
      isInterrupted: true,
      interruptions,
    };
  }

  if (agent.toolUseBehavior === 'run_llm_again') {
    return NOT_FINAL_OUTPUT;
  }

  const firstToolResult = toolResults[0];
  if (agent.toolUseBehavior === 'stop_on_first_tool') {
    if (firstToolResult?.type === 'function_output') {
      const stringOutput = toSmartString(firstToolResult.output);
      return {
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: stringOutput,
      };
    }
    return NOT_FINAL_OUTPUT;
  }

  const toolUseBehavior = agent.toolUseBehavior;
  if (typeof toolUseBehavior === 'object') {
    const stoppingTool = toolResults.find((r) =>
      toolUseBehavior.stopAtToolNames.includes(r.tool.name),
    );
    if (stoppingTool?.type === 'function_output') {
      const stringOutput = toSmartString(stoppingTool.output);
      return {
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: stringOutput,
      };
    }
    return NOT_FINAL_OUTPUT;
  }

  if (typeof toolUseBehavior === 'function') {
    return toolUseBehavior(state._context, toolResults);
  }

  throw new UserError(`Invalid toolUseBehavior: ${toolUseBehavior}`, state);
}

function getRunItemStreamEventName(
  item: RunItem,
): RunItemStreamEventName | undefined {
  if (item instanceof RunMessageOutputItem) {
    return 'message_output_created';
  }
  if (item instanceof RunHandoffCallItem) {
    return 'handoff_requested';
  }
  if (item instanceof RunHandoffOutputItem) {
    return 'handoff_occurred';
  }
  if (item instanceof RunToolCallItem) {
    return 'tool_called';
  }
  if (item instanceof RunToolCallOutputItem) {
    return 'tool_output';
  }
  if (item instanceof RunReasoningItem) {
    return 'reasoning_item_created';
  }
  if (item instanceof RunToolApprovalItem) {
    return 'tool_approval_requested';
  }
  return undefined;
}

function enqueueRunItemStreamEvent(
  result: StreamedRunResult<any, any>,
  item: RunItem,
): void {
  const itemName = getRunItemStreamEventName(item);
  if (!itemName) {
    logger.warn('Unknown item type: ', item);
    return;
  }
  result._addItem(new RunItemStreamEvent(itemName, item));
}

export function streamStepItemsToRunResult(
  result: StreamedRunResult<any, any>,
  items: RunItem[],
): void {
  // Preserve the order in which items were generated by enqueueing each one
  // immediately on the streamed result.
  for (const item of items) {
    enqueueRunItemStreamEvent(result, item);
  }
}

export function addStepToRunResult(
  result: StreamedRunResult<any, any>,
  step: SingleStepResult,
  options?: { skipItems?: Set<RunItem> },
): void {
  // skipItems contains run items that were already streamed so we avoid
  // enqueueing duplicate events for the same instance.
  const skippedItems = options?.skipItems;
  for (const item of step.newStepItems) {
    if (skippedItems?.has(item)) {
      continue;
    }
    enqueueRunItemStreamEvent(result, item);
  }
}

export class AgentToolUseTracker {
  #agentToTools = new Map<Agent<any, any>, string[]>();

  addToolUse(agent: Agent<any, any>, toolNames: string[]): void {
    this.#agentToTools.set(agent, toolNames);
  }

  hasUsedTools(agent: Agent<any, any>): boolean {
    return this.#agentToTools.has(agent);
  }

  toJSON(): Record<string, string[]> {
    return Object.fromEntries(
      Array.from(this.#agentToTools.entries()).map(([agent, toolNames]) => {
        return [agent.name, toolNames];
      }),
    );
  }
}

/**
 * @internal
 * Convert a user-provided input into a list of input items.
 */
export function toInputItemList(
  input: string | AgentInputItem[],
): AgentInputItem[] {
  if (typeof input === 'string') {
    return [
      {
        type: 'message',
        role: 'user',
        content: input,
      },
    ];
  }
  return [...input];
}

/**
 * @internal
 * Extract model output items from run items, excluding tool approval items.
 */
export function extractOutputItemsFromRunItems(
  items: RunItem[],
): AgentInputItem[] {
  return items
    .filter((item) => item.type !== 'tool_approval_item')
    .map((item) => item.rawItem as AgentInputItem);
}

// Carries metadata while recursively sanitizing nested payloads so binary blobs can share the
// appropriate media type when converted into durable data URLs.
type SessionBinaryContext = {
  mediaType?: string;
};

function normalizeItemsForSessionPersistence(
  items: AgentInputItem[],
): AgentInputItem[] {
  // Persisted sessions must avoid raw binary so we convert every item into a JSON-safe shape before writing to storage.
  return items.map((item) =>
    sanitizeValueForSession(stripTransientCallIds(item)),
  );
}

function sanitizeValueForSession(
  value: AgentInputItem,
  context?: SessionBinaryContext,
): AgentInputItem;
// Nested fields such as providerData may hold arbitrary shapes, so we keep an unknown-based overload for recursive traversal.
function sanitizeValueForSession(
  value: unknown,
  context?: SessionBinaryContext,
): unknown;
function sanitizeValueForSession(
  value: unknown,
  context: SessionBinaryContext = {},
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Convert supported binary payloads into ArrayBuffer views before serialization.
  const binary = toUint8ArrayIfBinary(value);
  if (binary) {
    return toDataUrlFromBytes(binary, context.mediaType);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValueForSession(entry, context));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  const mediaType =
    typeof record.mediaType === 'string' && record.mediaType.length > 0
      ? (record.mediaType as string)
      : context.mediaType;

  for (const [key, entry] of Object.entries(record)) {
    // Propagate explicit media type only when walking into binary payload containers.
    const nextContext =
      key === 'data' || key === 'fileData' ? { mediaType } : context;
    result[key] = sanitizeValueForSession(entry, nextContext);
  }

  return result;
}

function toUint8ArrayIfBinary(value: unknown): Uint8Array | undefined {
  // Normalize the diverse binary containers we may receive into a shared Uint8Array view.
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (isArrayBufferView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (isNodeBuffer(value)) {
    const view = value as Uint8Array;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (isSerializedBufferSnapshot(value)) {
    const snapshot = value as { data: number[] };
    return Uint8Array.from(snapshot.data);
  }
  return undefined;
}

function toDataUrlFromBytes(bytes: Uint8Array, mediaType?: string): string {
  // Convert binary payloads into a durable data URL so session files remain self-contained.
  const base64 = encodeUint8ArrayToBase64(bytes);
  // Note that OpenAI Responses API never accepts application/octet-stream as a media type,
  // so we fall back to text/plain; that said, tools are supposed to return a valid media type when this utility is used.
  const type =
    mediaType && !mediaType.startsWith('data:') ? mediaType : 'text/plain';
  return `data:${type};base64,${base64}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Drop IDs from transient function call items (fc_***) so replayed histories do not reuse generated IDs.
function stripTransientCallIds(value: AgentInputItem): AgentInputItem;
function stripTransientCallIds(value: unknown): unknown;
function stripTransientCallIds(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripTransientCallIds(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const isProtocolItem =
    typeof record.type === 'string' && record.type.length > 0;
  const shouldStripId =
    isProtocolItem && shouldStripIdForType(record.type as string);
  for (const [key, entry] of Object.entries(record)) {
    if (shouldStripId && key === 'id') {
      continue;
    }
    result[key] = stripTransientCallIds(entry);
  }
  return result;
}

function shouldStripIdForType(type: string): boolean {
  switch (type) {
    case 'function_call':
    case 'function_call_result':
      return true;
    default:
      return false;
  }
}

/**
 * @internal
 * Persist full turn (input + outputs) for non-streaming runs.
 */
// Persists the combination of user inputs (possibly filtered) and model outputs for a completed turn.
export async function saveToSession(
  session: Session | undefined,
  sessionInputItems: AgentInputItem[] | undefined,
  result: RunResult<any, any>,
): Promise<void> {
  if (!session) {
    return;
  }
  const inputItems = sessionInputItems ?? [];
  const state = result.state;
  const alreadyPersisted = state._currentTurnPersistedItemCount ?? 0;
  // Persist only the portion of _generatedItems that has not yet been stored for this turn.
  const newRunItems = result.newItems.slice(alreadyPersisted);
  if (process.env.OPENAI_AGENTS__DEBUG_SAVE_SESSION) {
    console.debug(
      'saveToSession:newRunItems',
      newRunItems.map((item) => item.type),
    );
  }
  const outputItems = extractOutputItemsFromRunItems(newRunItems);
  const itemsToSave = [...inputItems, ...outputItems];
  if (itemsToSave.length === 0) {
    state._currentTurnPersistedItemCount =
      alreadyPersisted + newRunItems.length;
    return;
  }
  const sanitizedItems = normalizeItemsForSessionPersistence(itemsToSave);
  await session.addItems(sanitizedItems);
  state._currentTurnPersistedItemCount = alreadyPersisted + newRunItems.length;
}

/**
 * @internal
 * Persist only the user input for streaming runs at start.
 */
// For streaming runs we persist user input as soon as it is sent so reconnections can resume.
export async function saveStreamInputToSession(
  session: Session | undefined,
  sessionInputItems: AgentInputItem[] | undefined,
): Promise<void> {
  if (!session) {
    return;
  }
  if (!sessionInputItems || sessionInputItems.length === 0) {
    return;
  }
  const sanitizedInput = normalizeItemsForSessionPersistence(sessionInputItems);
  await session.addItems(sanitizedInput);
}

/**
 * @internal
 * Persist only the model outputs for streaming runs at the end of a turn.
 */
// Complements saveStreamInputToSession by recording the streaming outputs at the end of the turn.
export async function saveStreamResultToSession(
  session: Session | undefined,
  result: StreamedRunResult<any, any>,
): Promise<void> {
  if (!session) {
    return;
  }
  const state = result.state;
  const alreadyPersisted = state._currentTurnPersistedItemCount ?? 0;
  const newRunItems = result.newItems.slice(alreadyPersisted);
  const itemsToSave = extractOutputItemsFromRunItems(newRunItems);
  if (itemsToSave.length === 0) {
    state._currentTurnPersistedItemCount =
      alreadyPersisted + newRunItems.length;
    return;
  }
  const sanitizedItems = normalizeItemsForSessionPersistence(itemsToSave);
  await session.addItems(sanitizedItems);
  state._currentTurnPersistedItemCount = alreadyPersisted + newRunItems.length;
}

/**
 * @internal
 * If a session is provided, expands the input with session history; otherwise returns the input.
 */
export type PreparedInputWithSessionResult = {
  preparedInput: string | AgentInputItem[];
  sessionItems?: AgentInputItem[];
};

export async function prepareInputItemsWithSession(
  input: string | AgentInputItem[],
  session?: Session,
  sessionInputCallback?: SessionInputCallback,
  options?: {
    /**
     * When true (default), the returned `preparedInput` includes both the persisted session history
     * and the new turn items. Set to false when upstream code already provides history to the model
     * (e.g. server-managed conversations) to avoid sending duplicated messages each turn.
     */
    includeHistoryInPreparedInput?: boolean;
    /**
     * When true, ensures new turn inputs are still provided to the model even if the session input
     * callback drops them from persistence (used for server-managed conversations that redact
     * writes).
     */
    preserveDroppedNewItems?: boolean;
  },
): Promise<PreparedInputWithSessionResult> {
  if (!session) {
    return {
      preparedInput: input,
      sessionItems: undefined,
    };
  }

  const includeHistoryInPreparedInput =
    options?.includeHistoryInPreparedInput ?? true;
  const preserveDroppedNewItems = options?.preserveDroppedNewItems ?? false;

  const history = await session.getItems();
  const newInputItems = Array.isArray(input)
    ? [...input]
    : toInputItemList(input);

  if (!sessionInputCallback) {
    return {
      preparedInput: includeHistoryInPreparedInput
        ? [...history, ...newInputItems]
        : newInputItems,
      sessionItems: newInputItems,
    };
  }

  // Capture snapshots before invoking the callback so we can reason about the original state even
  // if the callback mutates the history array in-place.
  const historySnapshot = history.slice();
  const newInputSnapshot = newInputItems.slice();

  // Delegate history reconciliation to the user-supplied callback. It must return a concrete list
  // to keep downstream model requests well-typed.
  const combined = await sessionInputCallback(history, newInputItems);
  if (!Array.isArray(combined)) {
    throw new UserError(
      'Session input callback must return an array of AgentInputItem objects.',
    );
  }

  const historyCounts = buildItemFrequencyMap(historySnapshot);
  const newInputCounts = buildItemFrequencyMap(newInputSnapshot);
  const historyRefs = buildItemReferenceMap(historySnapshot);
  const newInputRefs = buildItemReferenceMap(newInputSnapshot);

  const appended: AgentInputItem[] = [];
  for (const item of combined) {
    const key = sessionItemKey(item);
    if (consumeReference(newInputRefs, key, item)) {
      decrementCount(newInputCounts, key);
      appended.push(item);
      continue;
    }

    // Prioritize exact history matches before payload-based counts so callbacks that surface
    // history ahead of identical new inputs keep previously persisted items out of the new queue.
    if (consumeReference(historyRefs, key, item)) {
      decrementCount(historyCounts, key);
      continue;
    }

    const historyRemaining = historyCounts.get(key) ?? 0;
    if (historyRemaining > 0) {
      historyCounts.set(key, historyRemaining - 1);
      continue;
    }

    const newRemaining = newInputCounts.get(key) ?? 0;
    if (newRemaining > 0) {
      newInputCounts.set(key, newRemaining - 1);
      appended.push(item);
      continue;
    }

    appended.push(item);
  }

  // Preserve redacted inputs for model delivery when requested (e.g. server-managed histories).
  const preparedItems = includeHistoryInPreparedInput
    ? combined
    : appended.length > 0
      ? appended
      : preserveDroppedNewItems
        ? newInputSnapshot
        : [];

  return {
    preparedInput: preparedItems,
    // Respect callbacks that intentionally drop the latest inputs (e.g. to redact sensitive
    // values) by persisting only the items they kept in the combined array.
    sessionItems: appended,
  };
}

// Internal helpers kept near the end so the main execution path reads top-to-bottom.
type StructuredToolOutput =
  | ToolOutputText
  | ToolOutputImage
  | ToolOutputFileContent;

/**
 * Accepts whatever the tool returned and attempts to coerce it into the structured protocol
 * shapes we expose to downstream model adapters (input_text/input_image/input_file). Tools are
 * allowed to return either a single structured object or an array of them; anything else falls
 * back to the legacy string pipeline.
 */
function normalizeStructuredToolOutputs(
  output: unknown,
): StructuredToolOutput[] | null {
  if (Array.isArray(output)) {
    const structured: StructuredToolOutput[] = [];
    for (const item of output) {
      const normalized = normalizeStructuredToolOutput(item);
      if (!normalized) {
        return null;
      }
      structured.push(normalized);
    }
    return structured;
  }
  const normalized = normalizeStructuredToolOutput(output);
  return normalized ? [normalized] : null;
}

/**
 * Best-effort normalization of a single tool output item. If the object already matches the
 * protocol shape we simply cast it; otherwise we copy the recognised fields into the canonical
 * structure. Returning null lets the caller know we should revert to plain-string handling.
 */
function normalizeStructuredToolOutput(
  value: unknown,
): StructuredToolOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value.type;
  if (type === 'text' && typeof value.text === 'string') {
    const output: ToolOutputText = { type: 'text', text: value.text };
    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  if (type === 'image') {
    const output: ToolOutputImage = { type: 'image' };

    let imageString: string | undefined;
    let imageFileId: string | undefined;
    const fallbackImageMediaType = isNonEmptyString((value as any).mediaType)
      ? (value as any).mediaType
      : undefined;

    const imageField = value.image;
    if (typeof imageField === 'string' && imageField.length > 0) {
      imageString = imageField;
    } else if (isRecord(imageField)) {
      const imageObj = imageField as Record<string, any>;
      const inlineMediaType = isNonEmptyString(imageObj.mediaType)
        ? imageObj.mediaType
        : fallbackImageMediaType;
      if (isNonEmptyString(imageObj.url)) {
        imageString = imageObj.url;
      } else if (isNonEmptyString(imageObj.data)) {
        imageString = toInlineImageString(imageObj.data, inlineMediaType);
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        imageString = toInlineImageString(imageObj.data, inlineMediaType);
      }

      if (!imageString) {
        const candidateId =
          (isNonEmptyString(imageObj.fileId) && imageObj.fileId) ||
          (isNonEmptyString(imageObj.id) && imageObj.id) ||
          undefined;
        if (candidateId) {
          imageFileId = candidateId;
        }
      }
    }

    if (
      !imageString &&
      typeof value.imageUrl === 'string' &&
      value.imageUrl.length > 0
    ) {
      imageString = value.imageUrl;
    }
    if (
      !imageFileId &&
      typeof value.fileId === 'string' &&
      value.fileId.length > 0
    ) {
      imageFileId = value.fileId;
    }

    if (
      !imageString &&
      typeof value.data === 'string' &&
      value.data.length > 0
    ) {
      imageString = fallbackImageMediaType
        ? toInlineImageString(value.data, fallbackImageMediaType)
        : value.data;
    } else if (
      !imageString &&
      value.data instanceof Uint8Array &&
      value.data.length > 0
    ) {
      imageString = toInlineImageString(value.data, fallbackImageMediaType);
    }
    if (typeof value.detail === 'string' && value.detail.length > 0) {
      output.detail = value.detail;
    }

    if (imageString) {
      output.image = imageString;
    } else if (imageFileId) {
      output.image = { fileId: imageFileId };
    } else {
      return null;
    }

    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  if (type === 'file') {
    const fileValue = normalizeFileValue(value);
    if (!fileValue) {
      return null;
    }

    const output: ToolOutputFileContent = { type: 'file', file: fileValue };

    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  return null;
}

/**
 * Translates the normalized tool output into the protocol `input_*` items. This is the last hop
 * before we hand the data to model-specific adapters, so we generate the exact schema expected by
 * the protocol definitions.
 */
function convertStructuredToolOutputToInputItem(
  output: StructuredToolOutput,
): ToolCallStructuredOutput {
  if (output.type === 'text') {
    const result: protocol.InputText = {
      type: 'input_text',
      text: output.text,
    };
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }
  if (output.type === 'image') {
    const result: protocol.InputImage = { type: 'input_image' };
    if (typeof output.detail === 'string' && output.detail.length > 0) {
      result.detail = output.detail;
    }
    if (typeof output.image === 'string' && output.image.length > 0) {
      result.image = output.image;
    } else if (isRecord(output.image)) {
      const imageObj = output.image as Record<string, any>;
      const inlineMediaType = isNonEmptyString(imageObj.mediaType)
        ? imageObj.mediaType
        : undefined;
      if (isNonEmptyString(imageObj.url)) {
        result.image = imageObj.url;
      } else if (isNonEmptyString(imageObj.data)) {
        result.image =
          inlineMediaType && !imageObj.data.startsWith('data:')
            ? asDataUrl(imageObj.data, inlineMediaType)
            : imageObj.data;
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        const base64 = encodeUint8ArrayToBase64(imageObj.data);
        result.image = asDataUrl(base64, inlineMediaType);
      } else {
        const referencedId =
          (isNonEmptyString(imageObj.fileId) && imageObj.fileId) ||
          (isNonEmptyString(imageObj.id) && imageObj.id) ||
          undefined;
        if (referencedId) {
          result.image = { id: referencedId };
        }
      }
    }
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }

  if (output.type === 'file') {
    const result: protocol.InputFile = { type: 'input_file' };
    const fileValue = output.file;
    if (typeof fileValue === 'string') {
      result.file = fileValue;
    } else if (fileValue && typeof fileValue === 'object') {
      const record = fileValue as Record<string, any>;
      if ('data' in record && record.data) {
        const mediaType = record.mediaType ?? 'text/plain';
        if (typeof record.data === 'string') {
          result.file = asDataUrl(record.data, mediaType);
        } else {
          const base64 = encodeUint8ArrayToBase64(record.data);
          result.file = asDataUrl(base64, mediaType);
        }
      } else if (typeof record.url === 'string' && record.url.length > 0) {
        result.file = { url: record.url };
      } else {
        const referencedId =
          (typeof record.id === 'string' &&
            record.id.length > 0 &&
            record.id) ||
          (typeof record.fileId === 'string' && record.fileId.length > 0
            ? record.fileId
            : undefined);
        if (referencedId) {
          result.file = { id: referencedId };
        }
      }

      if (typeof record.filename === 'string' && record.filename.length > 0) {
        result.filename = record.filename;
      }
    }
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }
  const exhaustiveCheck: never = output;
  return exhaustiveCheck;
}

type FileReferenceValue = ToolOutputFileContent['file'];

function buildItemFrequencyMap(items: AgentInputItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = sessionItemKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildItemReferenceMap(
  items: AgentInputItem[],
): Map<string, AgentInputItem[]> {
  const refs = new Map<string, AgentInputItem[]>();
  for (const item of items) {
    const key = sessionItemKey(item);
    const list = refs.get(key);
    if (list) {
      list.push(item);
    } else {
      refs.set(key, [item]);
    }
  }
  return refs;
}

function consumeReference(
  refs: Map<string, AgentInputItem[]>,
  key: string,
  target: AgentInputItem,
): boolean {
  const candidates = refs.get(key);
  if (!candidates || candidates.length === 0) {
    return false;
  }
  const index = candidates.findIndex((candidate) => candidate === target);
  if (index === -1) {
    return false;
  }
  candidates.splice(index, 1);
  if (candidates.length === 0) {
    refs.delete(key);
  }
  return true;
}

function decrementCount(map: Map<string, number>, key: string) {
  const remaining = (map.get(key) ?? 0) - 1;
  if (remaining <= 0) {
    map.delete(key);
  } else {
    map.set(key, remaining);
  }
}

function sessionItemKey(item: AgentInputItem): string {
  return JSON.stringify(item, sessionSerializationReplacer);
}

function sessionSerializationReplacer(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return {
      __type: 'ArrayBuffer',
      data: encodeUint8ArrayToBase64(new Uint8Array(value)),
    };
  }

  if (isArrayBufferView(value)) {
    const view = value as ArrayBufferView;
    return {
      __type: view.constructor.name,
      data: encodeUint8ArrayToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }

  if (isNodeBuffer(value)) {
    const view = value as Uint8Array;
    return {
      __type: 'Buffer',
      data: encodeUint8ArrayToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }

  if (isSerializedBufferSnapshot(value)) {
    return {
      __type: 'Buffer',
      data: encodeUint8ArrayToBase64(Uint8Array.from(value.data)),
    };
  }

  return value;
}
