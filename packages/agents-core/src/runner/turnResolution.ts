import { z } from 'zod';
import { Agent } from '../agent';
import { ModelBehaviorError } from '../errors';
import {
  RunItem,
  RunMessageOutputItem,
  RunToolApprovalItem,
  RunToolCallItem,
} from '../items';
import { ModelResponse } from '../model';
import type { Runner } from '../run';
import { RunState } from '../runState';
import { getLastTextFromOutputMessage } from '../utils/messages';
import { getSchemaAndParserFromInputType } from '../utils/tools';
import { safeExecute } from '../utils/safeExecute';
import { addErrorToCurrentSpan } from '../tracing/context';
import { NextStep, SingleStepResult, nextStepSchema } from './steps';
import type { ProcessedResponse, ToolRunHandoff } from './types';
import {
  checkForFinalOutputFromTools,
  executeApplyPatchOperations,
  executeComputerActions,
  executeFunctionToolCalls,
  executeHandoffCalls,
  executeShellActions,
  collectInterruptions,
} from './toolExecution';
import * as ProviderData from '../types/providerData';
import * as protocol from '../types/protocol';
import { AgentInputItem } from '../types';
import type { FunctionToolResult } from '../tool';

type ApprovalItemLike =
  | RunToolApprovalItem
  | {
      rawItem?: protocol.FunctionCallItem | protocol.HostedToolCallItem;
      agent?: Agent<any, any>;
    };

const APPROVAL_ITEM_TYPES = [
  'function_call',
  'hosted_tool_call',
  'shell_call',
  'apply_patch_call',
] as const;

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
  return APPROVAL_ITEM_TYPES.includes(
    itemType as (typeof APPROVAL_ITEM_TYPES)[number],
  );
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

type AppendContext = {
  seenItems: Set<RunItem>;
  seenApprovalIdentities: Set<string>;
};

function buildAppendContext(existingItems: RunItem[]): AppendContext {
  const seenItems = new Set<RunItem>(existingItems);
  const seenApprovalIdentities = new Set<string>();
  for (const item of existingItems) {
    if (item instanceof RunToolApprovalItem) {
      const identity = getApprovalIdentity(item);
      if (identity) {
        seenApprovalIdentities.add(identity);
      }
    }
  }
  return { seenItems, seenApprovalIdentities };
}

function appendRunItemIfNew(
  item: RunItem,
  target: RunItem[],
  context: AppendContext,
) {
  if (context.seenItems.has(item)) {
    return;
  }
  if (item instanceof RunToolApprovalItem) {
    const identity = getApprovalIdentity(item);
    if (identity) {
      if (context.seenApprovalIdentities.has(identity)) {
        return;
      }
      context.seenApprovalIdentities.add(identity);
    }
  }
  context.seenItems.add(item);
  target.push(item);
}

function buildApprovedCallIdSet(
  items: RunItem[],
  type: (typeof APPROVAL_ITEM_TYPES)[number],
): Set<string> {
  const callIds = new Set<string>();
  for (const item of items) {
    if (!(item instanceof RunToolApprovalItem)) {
      continue;
    }
    const rawItem = item.rawItem;
    if (!rawItem || rawItem.type !== type) {
      continue;
    }
    if ('callId' in rawItem && rawItem.callId) {
      callIds.add(rawItem.callId);
    } else if ('id' in rawItem && rawItem.id) {
      callIds.add(rawItem.id);
    }
  }
  return callIds;
}

function collectCompletedCallIds(items: RunItem[], type: string): Set<string> {
  const completed = new Set<string>();
  for (const item of items) {
    const rawItem = item.rawItem;
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }
    if ((rawItem as { type?: string }).type !== type) {
      continue;
    }
    const callId = (rawItem as { callId?: unknown }).callId;
    if (typeof callId === 'string') {
      completed.add(callId);
    }
  }
  return completed;
}

function filterActionsByApproval<T extends { toolCall: { callId?: string } }>(
  preStepItems: RunItem[],
  actions: T[],
  type: (typeof APPROVAL_ITEM_TYPES)[number],
): T[] {
  const allowedCallIds = buildApprovedCallIdSet(preStepItems, type);
  if (allowedCallIds.size === 0) {
    return [];
  }
  return actions.filter(
    (action) =>
      typeof action.toolCall.callId === 'string' &&
      allowedCallIds.has(action.toolCall.callId),
  );
}

function rewindTurnPersistenceForPendingApprovals<TContext>(
  originalPreStepItems: RunItem[],
  state: RunState<TContext, Agent<TContext, any>>,
) {
  const pendingApprovalItems = state
    .getInterruptions()
    .filter(isApprovalItemLike);

  if (pendingApprovalItems.length === 0) {
    return;
  }

  const pendingApprovalIdentities = new Set<string>();
  for (const approval of pendingApprovalItems) {
    const identity = getApprovalIdentity(approval);
    if (identity) {
      pendingApprovalIdentities.add(identity);
    }
  }

  if (pendingApprovalIdentities.size === 0) {
    return;
  }

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

  if (rewindCount > 0) {
    state._currentTurnPersistedItemCount = Math.max(
      0,
      state._currentTurnPersistedItemCount - rewindCount,
    );
  }
}

function truncateForDeveloper(message: string, maxLength = 160): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return 'Schema validation failed.';
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function formatFinalOutputTypeError(error: unknown): string {
  // Surface structured output validation hints without echoing potentially large or sensitive payloads.
  try {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      if (issue) {
        const issuePathParts = Array.isArray(issue.path) ? issue.path : [];
        const issuePath =
          issuePathParts.length > 0
            ? issuePathParts.map((part) => String(part)).join('.')
            : '(root)';
        const message = truncateForDeveloper(issue.message ?? '');
        return `Invalid output type: final assistant output failed schema validation at "${issuePath}" (${message}).`;
      }
      return 'Invalid output type: final assistant output failed schema validation.';
    }

    if (error instanceof Error && error.message) {
      return `Invalid output type: ${truncateForDeveloper(error.message)}`;
    }
  } catch {
    // Swallow formatting errors so we can return a generic message below.
  }

  return 'Invalid output type: final assistant output did not match the expected schema.';
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

  const completedFunctionCallIds = collectCompletedCallIds(
    originalPreStepItems,
    'function_call_result',
  );
  const completedShellCallIds = collectCompletedCallIds(
    originalPreStepItems,
    'shell_call_output',
  );
  const completedApplyPatchCallIds = collectCompletedCallIds(
    originalPreStepItems,
    'apply_patch_call_output',
  );

  // We already persisted the turn once when the approval interrupt was raised, so the
  // counter reflects the approval items as "flushed". When we resume the same turn we need
  // to rewind it so the eventual tool output for this call is still written to the session.
  const pendingApprovalItems = state
    .getInterruptions()
    .filter(isApprovalItemLike);
  if (pendingApprovalItems.length > 0) {
    // Persisting the approval request already advanced the counter once, so undo the increment
    // to make sure we write the final tool output back to the session when the turn resumes.
    rewindTurnPersistenceForPendingApprovals(originalPreStepItems, state);
  }

  const pendingApprovalIdentities = new Set<string>();
  for (const approval of pendingApprovalItems) {
    const identity = getApprovalIdentity(approval);
    if (identity) {
      pendingApprovalIdentities.add(identity);
    }
  }
  // Run function tools that require approval after they get their approval results
  const functionToolRuns = processedResponse.functions.filter((run) => {
    const callId = run.toolCall.callId;
    if (!functionCallIds.includes(callId)) {
      return false;
    }
    return !completedFunctionCallIds.has(callId);
  });

  const shellRuns = filterActionsByApproval(
    originalPreStepItems,
    processedResponse.shellActions,
    'shell_call',
  ).filter((run) => !completedShellCallIds.has(run.toolCall.callId ?? ''));

  const previouslyCompletedComputerCallIds = collectCompletedCallIds(
    originalPreStepItems,
    'computer_call_result',
  );
  const pendingComputerActions = processedResponse.computerActions.filter(
    (action) =>
      !previouslyCompletedComputerCallIds.has(action.toolCall.callId ?? ''),
  );

  const applyPatchRuns = filterActionsByApproval(
    originalPreStepItems,
    processedResponse.applyPatchActions,
    'apply_patch_call',
  ).filter((run) => !completedApplyPatchCallIds.has(run.toolCall.callId ?? ''));

  const functionResults = await executeFunctionToolCalls(
    agent,
    functionToolRuns,
    runner,
    state,
  );

  // There is no built-in HITL approval surface for computer tools today, so every pending action
  // is executed immediately when the turn resumes.
  const computerResults =
    pendingComputerActions.length > 0
      ? await executeComputerActions(
          agent,
          pendingComputerActions,
          runner,
          state._context,
        )
      : [];

  const shellResults =
    shellRuns.length > 0
      ? await executeShellActions(agent, shellRuns, runner, state._context)
      : [];

  const applyPatchResults =
    applyPatchRuns.length > 0
      ? await executeApplyPatchOperations(
          agent,
          applyPatchRuns,
          runner,
          state._context,
        )
      : [];

  const newItems: RunItem[] = [];
  const appendContext = buildAppendContext(originalPreStepItems);
  const appendIfNew = (item: RunItem) =>
    appendRunItemIfNew(item, newItems, appendContext);

  for (const result of functionResults) {
    appendIfNew(result.runItem);
  }

  for (const result of computerResults) {
    appendIfNew(result);
  }

  for (const result of shellResults) {
    appendIfNew(result);
  }

  for (const result of applyPatchResults) {
    appendIfNew(result);
  }

  const additionalInterruptions = collectInterruptions(
    [],
    [...shellResults, ...applyPatchResults],
  );

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
    const rawItem = run.requestItem.rawItem;
    if (rawItem.type !== 'hosted_tool_call') {
      continue;
    }
    const approvalRequestId = rawItem.id!;
    const approved = state._context.isToolApproved({
      // Since this item name must be the same with the one sent from Responses API server
      toolName: rawItem.name,
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

    // Preserve all other approval items so resumptions can continue to reference the
    // original approval requests (e.g., function/shell/apply_patch) ONLY while they are still pending.
    const identity = getApprovalIdentity(item);
    if (!identity) {
      return false;
    }
    return pendingApprovalIdentities.has(identity);
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
    additionalInterruptions,
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
  const newItems: RunItem[] = [];
  const appendContext = buildAppendContext(originalPreStepItems);
  const appendIfNew = (item: RunItem) =>
    appendRunItemIfNew(item, newItems, appendContext);

  for (const item of processedResponse.newItems) {
    appendIfNew(item);
  }

  // Run function tools and computer actions in parallel; neither depends on the other's side effects.
  const [functionResults, computerResults, shellResults, applyPatchResults] =
    await Promise.all([
      executeFunctionToolCalls(
        agent,
        processedResponse.functions,
        runner,
        state,
      ),
      executeComputerActions(
        agent,
        processedResponse.computerActions,
        runner,
        state._context,
      ),
      executeShellActions(
        agent,
        processedResponse.shellActions,
        runner,
        state._context,
      ),
      executeApplyPatchOperations(
        agent,
        processedResponse.applyPatchActions,
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
  for (const item of shellResults) {
    appendIfNew(item);
  }
  for (const item of applyPatchResults) {
    appendIfNew(item);
  }

  const additionalInterruptions = collectInterruptions(
    [],
    [...shellResults, ...applyPatchResults],
  );

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
      processedResponse.handoffs as ToolRunHandoff[],
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
    additionalInterruptions,
  });

  if (completedStep) {
    return completedStep;
  }

  // If the model issued any tool calls or handoffs in this turn,
  // we must NOT treat any assistant message in the same turn as the final output.
  // We should run the loop again so the model can see the tool results and respond.
  if (processedResponse.hasToolsOrApprovalsToRun()) {
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
  const hasPendingToolsOrApprovals =
    functionResults.some(
      (result) => result.runItem instanceof RunToolApprovalItem,
    ) || additionalInterruptions.length > 0;

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
        const outputErrorMessage = formatFinalOutputTypeError(error);
        addErrorToCurrentSpan({
          message: outputErrorMessage,
          data: {
            error: String(error),
          },
        });
        throw new ModelBehaviorError(outputErrorMessage);
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
  functionResults: FunctionToolResult<TContext>[];
  originalInput: string | AgentInputItem[];
  newResponse: ModelResponse;
  preStepItems: RunItem[];
  newItems: RunItem[];
  additionalInterruptions?: RunToolApprovalItem[];
};

// Consolidates the logic that determines whether tool results yielded a final answer,
// triggered an interruption, or require the agent loop to continue running.
async function maybeCompleteTurnFromToolResults<TContext>({
  agent,
  runner: _runner,
  state,
  functionResults,
  originalInput,
  newResponse,
  preStepItems,
  newItems,
  additionalInterruptions = [],
}: TurnFinalizationParams<TContext>): Promise<SingleStepResult | null> {
  const toolOutcome = await checkForFinalOutputFromTools(
    agent,
    functionResults,
    state,
    additionalInterruptions,
  );

  if (toolOutcome.isFinalOutput) {
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

export { nextStepSchema };
export type { NextStep };
