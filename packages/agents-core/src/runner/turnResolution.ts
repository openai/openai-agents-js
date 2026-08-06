import { z } from 'zod';
import { Agent } from '../agent';
import type { Handoff } from '../handoff';
import { ModelBehaviorError, ModelRefusalError } from '../errors';
import {
  RunHandoffCallItem,
  RunItem,
  RunMessageOutputItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '../items';
import logger, { logToolActionWarning } from '../logger';
import { ModelResponse } from '../model';
import type { RunConfig, Runner, ToolErrorFormatter } from '../run';
import { RunState } from '../runState';
import {
  getOutputText,
  getRefusalFromOutputMessage,
  getTextFromOutputMessage,
} from '../utils/messages';
import { safeExecute } from '../utils/safeExecute';
import {
  isDataRedactedError,
  processFinalOutputWithRedaction,
  REDACTED_FINAL_OUTPUT_ERROR_MESSAGE,
} from '../utils/finalOutputError';
import { addErrorToCurrentSpan } from '../tracing/context';
import { NextStep, SingleStepResult, nextStepSchema } from './steps';
import type {
  ProcessedResponse,
  ToolRunApplyPatch,
  ToolRunHandoff,
  ToolRunFunctionNotFound,
  ToolRunShell,
} from './types';
import {
  checkForFinalOutputFromTools,
  executeApplyPatchOperations,
  executeComputerActions,
  executeFunctionToolCalls,
  executeHandoffCalls,
  executeShellActions,
  collectInterruptions,
  getToolCallOutputItem,
} from './toolExecution';
import { getRunStateTurnSpanParent } from './invocationContext';
import { handleHostedMcpApprovals } from './mcpApprovals';
import * as protocol from '../types/protocol';
import { AgentInputItem } from '../types';
import type { FunctionTool, FunctionToolResult, Tool } from '../tool';
import {
  buildFunctionToolLookupMap,
  getFunctionToolStateKey,
  getFunctionToolStateKeyForCall,
  getFunctionToolStateKeyForResolvedCall,
  getFunctionToolStateKeys,
  getToolCallNamespace,
  resolveFunctionToolCall,
  getHostedMcpApprovalRequestIdentity,
  getHostedMcpApprovalRequestKey,
} from '../toolIdentity';
import type { RunErrorData, RunErrorHandlers } from './errorHandlers';
import {
  createRunErrorFinalOutputItem,
  formatRunErrorFinalOutput,
  preserveInvalidFinalOutputRedaction,
  resolveRunErrorHandler,
  validateRunErrorHandlerFinalOutput,
} from './errorHandlers';
import { getTurnInput } from './items';
import {
  buildApplyPatchAbortResult,
  buildFunctionAbortResult,
  buildShellAbortResult,
} from './streamReconciliation';
import { runWithSiblingCancellation } from './siblingCancellation';
import {
  getHandoffToolInvocationName,
  getHostedMcpApprovalToolName,
  getToolInvocationCallId,
  getToolInvocationFingerprint,
  type ApprovalCapableToolCall,
} from '../toolInvocation';

const DEFAULT_TOOL_NOT_FOUND_MESSAGE = (toolName: string) =>
  `Tool '${toolName}' not found.`;

export function preflightModelResponseToolInvocations<TContext>(
  agent: Agent<TContext, any>,
  state: RunState<TContext, Agent<TContext, any>>,
  modelResponse: ModelResponse,
  tools: Tool<TContext>[],
  handoffs: Handoff<any, any>[],
): void {
  const functionMap = buildFunctionToolLookupMap(
    tools.filter(
      (tool): tool is FunctionTool<TContext> => tool.type === 'function',
    ),
  );
  const handoffMap = new Map(
    handoffs.map((handoff) => [handoff.toolName, handoff]),
  );
  const computer = tools.find((tool) => tool.type === 'computer');
  const shell = tools.find((tool) => tool.type === 'shell');
  const applyPatch = tools.find((tool) => tool.type === 'apply_patch');
  const seen = new Map<string, string>();
  const validate = (
    toolName: string | undefined,
    rawItem: ApprovalCapableToolCall,
  ) => {
    if (!toolName) {
      return;
    }
    const { callId, fingerprint } = state._context._validateToolInvocation(
      agent,
      toolName,
      rawItem,
    );
    state._preflightToolInvocation(agent, callId, fingerprint);
    const previous = seen.get(callId);
    if (previous !== undefined && previous !== fingerprint) {
      throw new ModelBehaviorError(
        `Tool call ID ${callId} was reused for different tool invocations in the same model response.`,
        state,
      );
    }
    seen.set(callId, fingerprint);
  };

  for (const output of modelResponse.output) {
    if (output.type === 'function_call') {
      const handoff = !getToolCallNamespace(output)
        ? handoffMap.get(output.name)
        : undefined;
      if (handoff) {
        validate(getHandoffToolInvocationName(handoff.toolName), output);
        continue;
      }
      const resolvedTool = resolveFunctionToolCall(output, functionMap);
      validate(
        resolvedTool
          ? getFunctionToolStateKeyForResolvedCall(output, resolvedTool)
          : getFunctionToolStateKeyForCall(output, output.name),
        output,
      );
      continue;
    }
    if (output.type === 'computer_call') {
      validate(computer?.name ?? 'computer', output);
      continue;
    }
    if (output.type === 'shell_call') {
      validate(shell?.name ?? 'shell', output);
      continue;
    }
    if (output.type === 'apply_patch_call') {
      validate(applyPatch?.name ?? 'apply_patch', output);
      continue;
    }
    if (
      output.type === 'hosted_tool_call' &&
      (output.providerData?.type === 'mcp_approval_request' ||
        output.name === 'mcp_approval_request')
    ) {
      const providerData = output.providerData as
        { name?: unknown } | undefined;
      validate(
        typeof providerData?.name === 'string'
          ? providerData.name
          : output.name,
        output,
      );
    }
  }
}

export function preflightToolInvocations<TContext>(
  agent: Agent<TContext, any>,
  state: RunState<TContext, Agent<TContext, any>>,
  processedResponse: ProcessedResponse<TContext>,
): Set<ApprovalCapableToolCall> {
  const suppressed = new Set<ApprovalCapableToolCall>();
  const seen = new Map<string, string>();
  const observe = (
    toolName: string | undefined,
    rawItem: ApprovalCapableToolCall,
  ) => {
    if (!toolName) {
      return undefined;
    }
    const { callId, fingerprint } = state._context._validateToolInvocation(
      agent,
      toolName,
      rawItem,
    );
    const completed = state._observeToolInvocation(agent, callId, fingerprint);
    const previous = seen.get(callId);
    const shouldSuppress = completed || previous === fingerprint;
    if (shouldSuppress) {
      suppressed.add(rawItem);
    }
    seen.set(callId, fingerprint);
    return { callId, fingerprint, shouldSuppress };
  };

  for (const run of processedResponse.functions ?? []) {
    observe(
      getFunctionToolStateKey(run.tool) ??
        getFunctionToolStateKeyForCall(run.toolCall, run.tool.name),
      run.toolCall,
    );
  }
  for (const run of processedResponse.functionToolsNotFound ?? []) {
    observe(
      getFunctionToolStateKeyForCall(run.toolCall, run.toolName),
      run.toolCall,
    );
  }
  for (const run of processedResponse.computerActions ?? []) {
    observe(run.computer.name, run.toolCall);
  }
  for (const run of processedResponse.shellActions ?? []) {
    observe(run.shell.name, run.toolCall);
  }
  for (const run of processedResponse.applyPatchActions ?? []) {
    observe(run.applyPatch.name, run.toolCall);
  }
  const claimedHostedMcpItems = new Set<ApprovalCapableToolCall>();
  for (const run of processedResponse.mcpApprovalRequests ?? []) {
    const toolName = run.requestItem.name;
    const observation = observe(toolName, run.requestItem.rawItem);
    if (!toolName || !observation) {
      continue;
    }
    const sourceRawItems: ApprovalCapableToolCall[] = [];
    for (const item of processedResponse.newItems) {
      if (
        !(item instanceof RunToolCallItem) ||
        item.rawItem.type !== 'hosted_tool_call'
      ) {
        continue;
      }
      const rawItem = item.rawItem;
      if (claimedHostedMcpItems.has(rawItem)) {
        continue;
      }
      const providerData = rawItem.providerData as
        { type?: unknown; id?: unknown } | undefined;
      const isApprovalRequest =
        providerData?.type === 'mcp_approval_request' ||
        rawItem.name === 'mcp_approval_request';
      const sourceReferenceId =
        typeof providerData?.id === 'string'
          ? providerData.id
          : getToolInvocationCallId(rawItem);
      if (isApprovalRequest && sourceReferenceId === observation.callId) {
        sourceRawItems.push(rawItem);
      }
    }
    if (sourceRawItems.length !== 1) {
      throw new ModelBehaviorError(
        `Hosted MCP approval request ${observation.callId} does not have exactly one source tool invocation.`,
      );
    }
    const sourceRawItem = sourceRawItems[0];
    claimedHostedMcpItems.add(sourceRawItem);
    if (
      getToolInvocationFingerprint(toolName, sourceRawItem) !==
      observation.fingerprint
    ) {
      throw new ModelBehaviorError(
        `Hosted MCP approval request ${observation.callId} does not match its source tool invocation.`,
      );
    }
    if (observation.shouldSuppress) {
      suppressed.add(sourceRawItem);
    }
  }
  for (const run of processedResponse.handoffs ?? []) {
    observe(getHandoffToolInvocationName(run.handoff.toolName), run.toolCall);
  }

  return suppressed;
}

function isSuppressedToolCallItem(
  item: RunItem,
  suppressed: ReadonlySet<ApprovalCapableToolCall>,
): boolean {
  if (
    !(item instanceof RunToolCallItem) &&
    !(item instanceof RunHandoffCallItem) &&
    !(item instanceof RunToolApprovalItem)
  ) {
    return false;
  }
  const rawItem = item.rawItem;
  if (
    rawItem.type !== 'function_call' &&
    rawItem.type !== 'computer_call' &&
    rawItem.type !== 'shell_call' &&
    rawItem.type !== 'apply_patch_call' &&
    rawItem.type !== 'hosted_tool_call'
  ) {
    return false;
  }
  return suppressed.has(rawItem);
}

export function filterSuppressedToolCallItems(
  items: readonly RunItem[],
  suppressed: ReadonlySet<ApprovalCapableToolCall>,
): RunItem[] {
  return items.filter((item) => !isSuppressedToolCallItem(item, suppressed));
}

async function resolveToolNotFoundMessage<TContext>(
  state: RunState<TContext, Agent<TContext, any>>,
  toolRun: ToolRunFunctionNotFound,
  toolErrorFormatter?: ToolErrorFormatter<TContext>,
): Promise<string> {
  const defaultMessage = DEFAULT_TOOL_NOT_FOUND_MESSAGE(toolRun.toolName);
  if (!toolErrorFormatter) {
    return defaultMessage;
  }

  try {
    const formattedMessage = await toolErrorFormatter({
      kind: 'tool_not_found',
      toolType: 'function',
      toolName: toolRun.toolName,
      callId: toolRun.toolCall.callId,
      defaultMessage,
      runContext: state._context,
    });

    if (typeof formattedMessage === 'string') {
      return formattedMessage;
    }
    if (typeof formattedMessage !== 'undefined') {
      logger.warn(
        'toolErrorFormatter returned a non-string value. Falling back to the default tool not found message.',
      );
    }
  } catch (error) {
    logToolActionWarning(
      logger,
      'toolErrorFormatter threw while formatting tool not found:',
      error,
    );
  }

  return defaultMessage;
}

async function buildToolNotFoundOutputItems<TContext>(
  agent: Agent<TContext, any>,
  state: RunState<TContext, Agent<TContext, any>>,
  toolRuns: ToolRunFunctionNotFound[],
  toolErrorFormatter?: ToolErrorFormatter<TContext>,
): Promise<RunToolCallOutputItem[]> {
  const items: RunToolCallOutputItem[] = [];
  for (const toolRun of toolRuns) {
    const message = await resolveToolNotFoundMessage(
      state,
      toolRun,
      toolErrorFormatter,
    );
    items.push(
      new RunToolCallOutputItem(
        getToolCallOutputItem(toolRun.toolCall, message),
        agent,
        message,
      ),
    );
  }
  return items;
}

type ApprovalItemLike =
  | RunToolApprovalItem
  | {
      rawItem?: protocol.FunctionCallItem | protocol.HostedToolCallItem;
      agent?: Agent<any, any>;
    };

const APPROVAL_ITEM_TYPES = [
  'function_call',
  'computer_call',
  'hosted_tool_call',
  'shell_call',
  'apply_patch_call',
] as const;

function isHostedMcpApprovalItem(item: RunToolApprovalItem): boolean {
  return getHostedMcpApprovalRequestIdentity(item) !== undefined;
}

type ApprovalResolution = 'approved' | 'rejected' | 'pending';

function resolveApprovalState(
  item: RunToolApprovalItem,
  state: RunState<any, any>,
  processedResponse: ProcessedResponse<any>,
): ApprovalResolution {
  if (isHostedMcpApprovalItem(item)) {
    return 'pending';
  }

  const rawItem = item.rawItem;
  const toolName =
    item.toolName ??
    ('name' in rawItem && typeof rawItem.name === 'string'
      ? rawItem.name
      : undefined);
  const callId =
    'callId' in rawItem && typeof rawItem.callId === 'string'
      ? rawItem.callId
      : 'id' in rawItem && typeof rawItem.id === 'string'
        ? rawItem.id
        : undefined;

  if (!toolName || !callId) {
    return 'pending';
  }

  let toolNames = [toolName];
  if (rawItem.type === 'function_call') {
    const functionRun =
      item.agent === state._currentAgent
        ? processedResponse.functions.find(
            (run) => run.toolCall.callId === callId,
          )
        : undefined;
    if (functionRun) {
      const stateKey = getFunctionToolStateKey(functionRun.tool);
      toolNames = stateKey ? [stateKey] : toolNames;
    } else {
      const stateKey =
        item.functionToolStateKey ??
        getFunctionToolStateKeyForCall(rawItem, toolName);
      toolNames = stateKey ? [stateKey] : toolNames;
    }
  }

  const approval = toolNames
    .map((candidate) =>
      state._context._resolveToolInvocationApproval(
        item.agent,
        candidate,
        rawItem,
      ),
    )
    .find((decision) => typeof decision !== 'undefined');
  if (approval === true) {
    return 'approved';
  }
  if (approval === false) {
    return 'rejected';
  }
  return 'pending';
}

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

type ApprovalIdentity = {
  agent: Agent<any, any> | undefined;
  value: string;
};

function getApprovalIdentity(
  approval: ApprovalItemLike,
): ApprovalIdentity | undefined {
  const rawItem = approval.rawItem;
  if (!rawItem) {
    return undefined;
  }

  const agent = 'agent' in approval ? approval.agent : undefined;

  if (rawItem.type === 'function_call' && rawItem.callId) {
    return { agent, value: `function_call:${rawItem.callId}` };
  }

  if ('callId' in rawItem && rawItem.callId) {
    return { agent, value: `${rawItem.type}:${rawItem.callId}` };
  }

  const id = 'id' in rawItem ? rawItem.id : undefined;
  if (id) {
    return { agent, value: `${rawItem.type}:${id}` };
  }

  const providerData =
    typeof rawItem.providerData === 'object' && rawItem.providerData
      ? (rawItem.providerData as { id?: string })
      : undefined;
  if (providerData?.id) {
    return { agent, value: `${rawItem.type}:provider:${providerData.id}` };
  }

  const agentName =
    'agent' in approval && approval.agent ? approval.agent.name : '';

  try {
    return {
      agent,
      value: `${agentName}:${rawItem.type}:${JSON.stringify(rawItem)}`,
    };
  } catch {
    return { agent, value: `${agentName}:${rawItem.type}` };
  }
}

type ApprovalIdentityMap = Map<Agent<any, any> | undefined, Set<string>>;

function hasApprovalIdentity(
  identities: ApprovalIdentityMap,
  identity: ApprovalIdentity,
): boolean {
  return identities.get(identity.agent)?.has(identity.value) ?? false;
}

function addApprovalIdentity(
  identities: ApprovalIdentityMap,
  identity: ApprovalIdentity,
): void {
  const values = identities.get(identity.agent) ?? new Set<string>();
  values.add(identity.value);
  identities.set(identity.agent, values);
}

type AppendContext = {
  seenItems: Set<RunItem>;
  seenApprovalIdentities: ApprovalIdentityMap;
};

function buildAppendContext(existingItems: RunItem[]): AppendContext {
  const seenItems = new Set<RunItem>(existingItems);
  const seenApprovalIdentities: ApprovalIdentityMap = new Map();
  for (const item of existingItems) {
    if (item instanceof RunToolApprovalItem) {
      const identity = getApprovalIdentity(item);
      if (identity) {
        addApprovalIdentity(seenApprovalIdentities, identity);
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
      if (hasApprovalIdentity(context.seenApprovalIdentities, identity)) {
        return;
      }
      addApprovalIdentity(context.seenApprovalIdentities, identity);
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
    const callKey = getToolActionKey(rawItem);
    if (callKey) {
      callIds.add(callKey);
    }
  }
  return callIds;
}

function collectCompletedCallIds(
  items: RunItem[],
  type: string,
  agent?: Agent<any, any>,
): Set<string> {
  const completed = new Set<string>();
  for (const item of items) {
    const rawItem = item.rawItem;
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }
    if ((rawItem as { type?: string }).type !== type) {
      continue;
    }
    if (agent && (!('agent' in item) || item.agent !== agent)) {
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
  return actions.filter((action) => {
    const callKey = getToolActionKey(action.toolCall);
    return typeof callKey === 'string' && allowedCallIds.has(callKey);
  });
}

type ToolActionWithCallId = {
  toolCall: { callId?: string; id?: string };
};

type OrderedShellOrApplyPatchAction =
  | { type: 'shell'; action: ToolRunShell }
  | { type: 'apply_patch'; action: ToolRunApplyPatch };

type QueuedActionsByCallId<T> = {
  byCallId: Map<string, T[]>;
  withoutCallId: T[];
};

function filterPendingActions<T extends ToolActionWithCallId>(
  actions: T[],
  options: {
    completedCallIds: Set<string>;
    allowedCallIds?: Set<string>;
  },
): T[] {
  return actions.filter((action) => {
    const callId = action.toolCall.callId;
    const hasCallId = typeof callId === 'string';
    if (options.allowedCallIds && options.allowedCallIds.size > 0) {
      if (!hasCallId || !options.allowedCallIds.has(callId)) {
        return false;
      }
    }

    if (hasCallId && options.completedCallIds.has(callId)) {
      return false;
    }

    return true;
  });
}

function queueActionsByCallId<T extends ToolActionWithCallId>(
  actions: T[],
): QueuedActionsByCallId<T> {
  const queued: QueuedActionsByCallId<T> = {
    byCallId: new Map<string, T[]>(),
    withoutCallId: [],
  };
  for (const action of actions) {
    const callKey = getToolActionKey(action.toolCall);
    if (!callKey) {
      queued.withoutCallId.push(action);
      continue;
    }
    const actionsForCallId = queued.byCallId.get(callKey) ?? [];
    actionsForCallId.push(action);
    queued.byCallId.set(callKey, actionsForCallId);
  }
  return queued;
}

function takeQueuedAction<T>(
  actionsByCallId: Map<string, T[]>,
  callId: string,
): T | undefined {
  const queued = actionsByCallId.get(callId);
  const action = queued?.shift();
  if (!queued || queued.length === 0) {
    actionsByCallId.delete(callId);
  }
  return action;
}

function appendRemainingQueuedActions<T>(
  target: T[],
  actionsByCallId: Map<string, T[]>,
): void {
  for (const queued of actionsByCallId.values()) {
    target.push(...queued);
  }
}

function orderShellAndApplyPatchActions(
  sourceItems: RunItem[],
  shellActions: ToolRunShell[],
  applyPatchActions: ToolRunApplyPatch[],
): OrderedShellOrApplyPatchAction[] {
  const shellActionsByCallId = queueActionsByCallId(shellActions);
  const applyPatchActionsByCallId = queueActionsByCallId(applyPatchActions);
  const orderedActions: OrderedShellOrApplyPatchAction[] = [];

  for (const item of sourceItems) {
    const rawItem = item.rawItem;
    if (rawItem?.type === 'shell_call') {
      const callKey = getToolActionKey(rawItem);
      const action = takeQueuedAction(
        shellActionsByCallId.byCallId,
        callKey ?? '',
      );
      if (action) {
        orderedActions.push({ type: 'shell', action });
      }
      continue;
    }
    if (rawItem?.type === 'apply_patch_call') {
      const callKey = getToolActionKey(rawItem);
      const action = takeQueuedAction(
        applyPatchActionsByCallId.byCallId,
        callKey ?? '',
      );
      if (action) {
        orderedActions.push({ type: 'apply_patch', action });
      }
    }
  }

  const remainingShellActions: ToolRunShell[] = [];
  appendRemainingQueuedActions(
    remainingShellActions,
    shellActionsByCallId.byCallId,
  );
  remainingShellActions.push(...shellActionsByCallId.withoutCallId);
  for (const action of remainingShellActions) {
    orderedActions.push({ type: 'shell', action });
  }

  const remainingApplyPatchActions: ToolRunApplyPatch[] = [];
  appendRemainingQueuedActions(
    remainingApplyPatchActions,
    applyPatchActionsByCallId.byCallId,
  );
  remainingApplyPatchActions.push(...applyPatchActionsByCallId.withoutCallId);
  for (const action of remainingApplyPatchActions) {
    orderedActions.push({ type: 'apply_patch', action });
  }

  return orderedActions;
}

function getToolActionKey(value: {
  callId?: unknown;
  id?: unknown;
}): string | undefined {
  if (typeof value.callId === 'string' && value.callId.length > 0) {
    return value.callId;
  }
  if (typeof value.id === 'string' && value.id.length > 0) {
    return value.id;
  }
  return undefined;
}

async function executeShellAndApplyPatchActionsInOrder<TContext>(args: {
  agent: Agent<TContext, any>;
  sourceItems: RunItem[];
  shellActions: ToolRunShell[];
  applyPatchActions: ToolRunApplyPatch[];
  runner: Runner;
  state: RunState<TContext, Agent<TContext, any>>;
  toolErrorFormatter?: ToolErrorFormatter;
  signal?: AbortSignal;
}): Promise<RunItem[]> {
  const results: RunItem[] = [];
  for (const action of orderShellAndApplyPatchActions(
    args.sourceItems,
    args.shellActions,
    args.applyPatchActions,
  )) {
    if (args.signal?.aborted) {
      const rawItem =
        action.type === 'shell'
          ? buildShellAbortResult(action.action.toolCall)
          : buildApplyPatchAbortResult(action.action.toolCall);
      results.push(new RunToolCallOutputItem(rawItem, args.agent, 'aborted'));
      continue;
    }
    const items =
      action.type === 'shell'
        ? await executeShellActions(
            args.agent,
            [action.action],
            args.runner,
            args.state._context,
            undefined,
            args.toolErrorFormatter,
          )
        : await executeApplyPatchOperations(
            args.agent,
            [action.action],
            args.runner,
            args.state._context,
            undefined,
            args.toolErrorFormatter,
          );
    results.push(...items);
  }
  return results;
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

function buildTurnRunErrorData<TContext, TAgent extends Agent<TContext, any>>(
  state: RunState<TContext, TAgent>,
  agent: TAgent,
  originalInput: string | AgentInputItem[],
  preStepItems: RunItem[],
  newItems: RunItem[],
): RunErrorData<TContext, TAgent> {
  const generatedItems = preStepItems.concat(newItems);
  return {
    input: originalInput,
    newItems: generatedItems,
    history: getTurnInput(
      originalInput,
      generatedItems,
      state._reasoningItemIdPolicy,
    ),
    output: getTurnInput([], generatedItems, state._reasoningItemIdPolicy),
    rawResponses: state._modelResponses,
    lastAgent: agent,
    state,
  };
}

async function resolveInvalidFinalOutput<
  TContext,
  TAgent extends Agent<TContext, any>,
>(args: {
  error: ModelBehaviorError;
  errorHandlers?: RunErrorHandlers<TContext, TAgent>;
  agent: TAgent;
  originalInput: string | AgentInputItem[];
  preStepItems: RunItem[];
  newItems: RunItem[];
  state: RunState<TContext, TAgent>;
}): Promise<string | undefined> {
  return preserveInvalidFinalOutputRedaction(async (redactFromStart) => {
    const handlerResult = await resolveRunErrorHandler({
      error: args.error,
      errorKind: 'invalidFinalOutput',
      errorHandlers: args.errorHandlers,
      context: args.state._context,
      runData: buildTurnRunErrorData(
        args.state,
        args.agent,
        args.originalInput,
        args.preStepItems,
        args.newItems,
      ),
    });
    if (!handlerResult) {
      return undefined;
    }

    const outputText = formatRunErrorFinalOutput(
      args.agent,
      handlerResult.finalOutput,
    );
    validateRunErrorHandlerFinalOutput(
      args.agent,
      outputText,
      true,
      redactFromStart,
    );
    if (handlerResult.includeInHistory !== false) {
      args.newItems.push(createRunErrorFinalOutputItem(args.agent, outputText));
    }
    return outputText;
  }, isDataRedactedError(args.error));
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
  toolErrorFormatter?: ToolErrorFormatter,
  agentToolParentRunConfig?: Partial<RunConfig>,
  signal?: AbortSignal,
): Promise<SingleStepResult> {
  const suppressedToolCalls = preflightToolInvocations(
    agent,
    state,
    processedResponse as ProcessedResponse<TContext>,
  );
  // call_ids for function tools
  const functionCallIds = originalPreStepItems
    .filter(
      (item) =>
        item instanceof RunToolApprovalItem &&
        item.agent === agent &&
        'callId' in item.rawItem &&
        item.rawItem.type === 'function_call',
    )
    .map((item) => (item.rawItem as protocol.FunctionCallItem).callId);

  const completedFunctionCallIds = collectCompletedCallIds(
    originalPreStepItems,
    'function_call_result',
    agent,
  );
  const completedComputerCallIds = collectCompletedCallIds(
    originalPreStepItems,
    'computer_call_result',
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

  const pendingApprovalIdentities: ApprovalIdentityMap = new Map();
  for (const approval of pendingApprovalItems) {
    if (!(approval instanceof RunToolApprovalItem)) {
      continue;
    }
    if (isHostedMcpApprovalItem(approval)) {
      continue;
    }
    const rawItem = approval.rawItem;
    if (
      rawItem.type === 'function_call' &&
      approval.agent === agent &&
      rawItem.callId &&
      completedFunctionCallIds.has(rawItem.callId)
    ) {
      continue;
    }
    if (
      rawItem.type === 'computer_call' &&
      rawItem.callId &&
      completedComputerCallIds.has(rawItem.callId)
    ) {
      continue;
    }
    if (
      rawItem.type === 'shell_call' &&
      rawItem.callId &&
      completedShellCallIds.has(rawItem.callId)
    ) {
      continue;
    }
    if (
      rawItem.type === 'apply_patch_call' &&
      rawItem.callId &&
      completedApplyPatchCallIds.has(rawItem.callId)
    ) {
      continue;
    }
    const identity = getApprovalIdentity(approval);
    if (identity) {
      if (
        resolveApprovalState(approval, state, processedResponse) === 'pending'
      ) {
        addApprovalIdentity(pendingApprovalIdentities, identity);
      }
    }
  }
  // Run function tools that require approval or are resuming a nested agent tool run.
  const functionToolRuns = processedResponse.functions.filter((run) => {
    if (suppressedToolCalls.has(run.toolCall)) {
      return false;
    }
    const callId = run.toolCall.callId;
    if (!callId) {
      return false;
    }
    const isApprovedCall = functionCallIds.includes(callId);
    const isPendingNested = getFunctionToolStateKeys(
      run.tool,
      run.availableFunctionTools ?? [run.tool],
    ).some((stateKey) => state.hasPendingAgentToolRun(stateKey, callId));
    if (!isApprovedCall && !isPendingNested) {
      return false;
    }
    return !completedFunctionCallIds.has(callId);
  });

  const shellRuns = filterPendingActions(
    filterActionsByApproval(
      originalPreStepItems,
      (processedResponse.shellActions ?? []).filter(
        (run) => !suppressedToolCalls.has(run.toolCall),
      ),
      'shell_call',
    ),
    {
      completedCallIds: completedShellCallIds,
    },
  );

  const pendingComputerActions = filterPendingActions(
    filterActionsByApproval(
      originalPreStepItems,
      (processedResponse.computerActions ?? []).filter(
        (run) => !suppressedToolCalls.has(run.toolCall),
      ),
      'computer_call',
    ),
    {
      completedCallIds: completedComputerCallIds,
    },
  );

  const applyPatchRuns = filterPendingActions(
    filterActionsByApproval(
      originalPreStepItems,
      (processedResponse.applyPatchActions ?? []).filter(
        (run) => !suppressedToolCalls.has(run.toolCall),
      ),
      'apply_patch_call',
    ),
    {
      completedCallIds: completedApplyPatchCallIds,
    },
  );

  const functionResults = await executeFunctionToolCalls(
    agent,
    functionToolRuns,
    runner,
    state,
    toolErrorFormatter,
    agentToolParentRunConfig,
    signal,
  );

  // Computer actions may require approval; only pending approved actions are executed on resume.
  const computerResults =
    pendingComputerActions.length > 0
      ? await executeComputerActions(
          agent,
          pendingComputerActions,
          runner,
          state._context,
          undefined,
          toolErrorFormatter,
          signal,
        )
      : [];

  const shellAndApplyPatchResults =
    shellRuns.length > 0 || applyPatchRuns.length > 0
      ? await executeShellAndApplyPatchActionsInOrder({
          agent,
          sourceItems: originalPreStepItems,
          shellActions: shellRuns,
          applyPatchActions: applyPatchRuns,
          runner,
          state,
          toolErrorFormatter,
          signal,
        })
      : [];
  const pendingFunctionToolsNotFound = filterPendingActions(
    (processedResponse.functionToolsNotFound ?? []).filter(
      (run) => !suppressedToolCalls.has(run.toolCall),
    ),
    {
      completedCallIds: completedFunctionCallIds,
    },
  );
  const toolNotFoundResults = await buildToolNotFoundOutputItems(
    agent,
    state,
    pendingFunctionToolsNotFound,
    toolErrorFormatter,
  );

  const newItems: RunItem[] = [];
  const appendContext = buildAppendContext(originalPreStepItems);
  const appendIfNew = (item: RunItem) =>
    appendRunItemIfNew(item, newItems, appendContext);

  for (const result of functionResults) {
    if (
      result.type === 'function_output' &&
      Array.isArray(result.interruptions) &&
      result.interruptions.length > 0
    ) {
      continue;
    }
    appendIfNew(result.runItem);
  }

  for (const result of toolNotFoundResults) {
    appendIfNew(result);
  }

  for (const result of computerResults) {
    appendIfNew(result);
  }

  for (const result of shellAndApplyPatchResults) {
    appendIfNew(result);
  }

  const additionalInterruptions = collectInterruptions(
    [],
    [...computerResults, ...shellAndApplyPatchResults],
  );

  const hostedMcpApprovals = await handleHostedMcpApprovals({
    requests: (processedResponse.mcpApprovalRequests ?? []).filter(
      (run) => !suppressedToolCalls.has(run.requestItem.rawItem),
    ),
    agent,
    state,
    functionResults,
    appendIfNew,
    resolveApproval: (rawItem) => {
      if (!getHostedMcpApprovalRequestIdentity(rawItem)?.requestId) {
        return undefined;
      }
      return state._context._resolveToolInvocationApproval(
        agent,
        getHostedMcpApprovalToolName(rawItem.name, rawItem),
        rawItem,
      );
    },
    resolveRejectionMessage: (rawItem) =>
      state._context._getToolInvocationRejectionMessage(
        agent,
        getHostedMcpApprovalToolName(rawItem.name, rawItem),
        rawItem,
      ),
  });

  // Server-managed conversations rely on preStepItems to re-surface pending approvals.
  // Keep unresolved hosted MCP approvals in place so HITL flows still have something to approve next turn.
  // Drop resolved approval placeholders so they are not replayed on the next turn, but keep
  // pending approvals in place to signal the outstanding work to the UI and session store.
  const preStepItems = originalPreStepItems.filter((item) => {
    if (!(item instanceof RunToolApprovalItem)) {
      return true;
    }

    if (isHostedMcpApprovalItem(item)) {
      if (hostedMcpApprovals.pendingApprovals.has(item)) {
        return true;
      }
      const approvalIdentity = getHostedMcpApprovalRequestIdentity(
        item.rawItem,
      );
      const approvalRequestKey = approvalIdentity
        ? getHostedMcpApprovalRequestKey(approvalIdentity)
        : undefined;
      if (approvalRequestKey) {
        return hostedMcpApprovals.pendingApprovalKeys.has(approvalRequestKey);
      }
      return true;
    }

    // Preserve all other approval items so resumptions can continue to reference the
    // original approval requests (e.g., function/shell/apply_patch) ONLY while they are still pending.
    const identity = getApprovalIdentity(item);
    if (!identity) {
      return true;
    }
    return hasApprovalIdentity(pendingApprovalIdentities, identity);
  });

  const keptApprovalItems = new Set<RunToolApprovalItem>();
  for (const item of preStepItems) {
    if (item instanceof RunToolApprovalItem) {
      keptApprovalItems.add(item);
    }
  }
  let removedApprovalCount = 0;
  for (const item of originalPreStepItems) {
    if (item instanceof RunToolApprovalItem && !keptApprovalItems.has(item)) {
      removedApprovalCount++;
    }
  }
  if (removedApprovalCount > 0) {
    // Persisting the approval request already advanced the counter once, so undo the increment
    // to make sure we write the final tool output back to the session when the turn resumes.
    state.rewindTurnPersistence(removedApprovalCount);
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
export async function resolveTurnAfterModelResponse<
  TContext,
  TAgent extends Agent<TContext, any>,
>(
  agent: TAgent,
  originalInput: string | AgentInputItem[],
  originalPreStepItems: RunItem[],
  newResponse: ModelResponse,
  processedResponse: ProcessedResponse<TContext>,
  runner: Runner,
  state: RunState<TContext, TAgent>,
  toolErrorFormatter?: ToolErrorFormatter,
  agentToolParentRunConfig?: Partial<RunConfig>,
  errorHandlers?: RunErrorHandlers<TContext, TAgent>,
  signal?: AbortSignal,
  preflightedToolCalls?: ReadonlySet<ApprovalCapableToolCall>,
): Promise<SingleStepResult> {
  const suppressedToolCalls =
    preflightedToolCalls ??
    preflightToolInvocations(agent, state, processedResponse);
  // Reuse the same array reference so we can compare object identity when deciding whether to
  // append new items, ensuring we never double-stream existing RunItems.
  const preStepItems = originalPreStepItems;
  const newItems: RunItem[] = [];
  const appendContext = buildAppendContext(originalPreStepItems);
  const appendIfNew = (item: RunItem) =>
    appendRunItemIfNew(item, newItems, appendContext);

  for (const item of processedResponse.newItems) {
    if (isSuppressedToolCallItem(item, suppressedToolCalls)) {
      continue;
    }
    appendIfNew(item);
  }

  // Run function tools and computer actions in parallel; neither depends on the other's side effects.
  // Shell and apply_patch actions both mutate the sandbox filesystem, so preserve model order.
  const runFunctionTools = (
    executionSignal = signal,
    cancelSiblingCategories?: () => void,
  ) =>
    executeFunctionToolCalls(
      agent,
      processedResponse.functions.filter(
        (run) => !suppressedToolCalls.has(run.toolCall),
      ),
      runner,
      state,
      toolErrorFormatter,
      agentToolParentRunConfig,
      executionSignal,
      cancelSiblingCategories,
    );
  const runComputerActions = (
    executionSignal = signal,
    cancelSiblingCategories?: (error?: unknown) => void,
  ) =>
    executeComputerActions(
      agent,
      processedResponse.computerActions.filter(
        (run) => !suppressedToolCalls.has(run.toolCall),
      ),
      runner,
      state._context,
      undefined,
      toolErrorFormatter,
      executionSignal,
      cancelSiblingCategories,
    );
  const [functionResults, computerResults] =
    processedResponse.functions.some(
      (run) => !suppressedToolCalls.has(run.toolCall),
    ) &&
    processedResponse.computerActions.some(
      (run) => !suppressedToolCalls.has(run.toolCall),
    )
      ? await runWithSiblingCancellation(
          [runFunctionTools, runComputerActions],
          signal,
        )
      : await Promise.all([runFunctionTools(), runComputerActions()]);
  const shellAndApplyPatchResults =
    processedResponse.shellActions.some(
      (run) => !suppressedToolCalls.has(run.toolCall),
    ) ||
    processedResponse.applyPatchActions.some(
      (run) => !suppressedToolCalls.has(run.toolCall),
    )
      ? await executeShellAndApplyPatchActionsInOrder({
          agent,
          sourceItems: processedResponse.newItems,
          shellActions: processedResponse.shellActions.filter(
            (run) => !suppressedToolCalls.has(run.toolCall),
          ),
          applyPatchActions: processedResponse.applyPatchActions.filter(
            (run) => !suppressedToolCalls.has(run.toolCall),
          ),
          runner,
          state,
          toolErrorFormatter,
          signal,
        })
      : [];
  const toolNotFoundResults = await buildToolNotFoundOutputItems(
    agent,
    state,
    (processedResponse.functionToolsNotFound ?? []).filter(
      (run) => !suppressedToolCalls.has(run.toolCall),
    ),
    toolErrorFormatter,
  );

  for (const result of functionResults) {
    if (
      result.type === 'function_output' &&
      Array.isArray(result.interruptions) &&
      result.interruptions.length > 0
    ) {
      continue;
    }
    appendIfNew(result.runItem);
  }
  for (const item of toolNotFoundResults) {
    appendIfNew(item);
  }
  for (const item of computerResults) {
    appendIfNew(item);
  }
  for (const item of shellAndApplyPatchResults) {
    appendIfNew(item);
  }

  const additionalInterruptions = collectInterruptions(
    [],
    [...computerResults, ...shellAndApplyPatchResults],
  );

  if (processedResponse.mcpApprovalRequests.length > 0) {
    await handleHostedMcpApprovals({
      requests: processedResponse.mcpApprovalRequests.filter(
        (run) => !suppressedToolCalls.has(run.requestItem.rawItem),
      ),
      agent,
      state,
      functionResults,
      appendIfNew,
      resolveApproval: (rawItem) => {
        if (!getHostedMcpApprovalRequestIdentity(rawItem)?.requestId) {
          return undefined;
        }
        return state._context._resolveToolInvocationApproval(
          agent,
          getHostedMcpApprovalToolName(rawItem.name, rawItem),
          rawItem,
        );
      },
      resolveRejectionMessage: (rawItem) =>
        state._context._getToolInvocationRejectionMessage(
          agent,
          getHostedMcpApprovalToolName(rawItem.name, rawItem),
          rawItem,
        ),
    });
  }

  // process handoffs
  const handoffRuns = processedResponse.handoffs.filter(
    (run) => !suppressedToolCalls.has(run.toolCall),
  );
  if (handoffRuns.length > 0) {
    if (signal?.aborted) {
      for (const { toolCall } of handoffRuns) {
        const rawItem = buildFunctionAbortResult(toolCall);
        appendIfNew(new RunToolCallOutputItem(rawItem, agent, rawItem.output));
      }
    } else {
      return await executeHandoffCalls(
        agent,
        originalInput,
        preStepItems,
        newItems,
        newResponse,
        handoffRuns as ToolRunHandoff[],
        runner,
        state._context,
        getRunStateTurnSpanParent(state) ?? state._currentAgentSpan,
      );
    }
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

  // A model response may split assistant text across multiple messages around
  // non-message output items such as reasoning. Preserve all of that text while
  // retaining the last message's refusal semantics.
  const lastMessageText =
    messageItems.length > 0
      ? getTextFromOutputMessage(messageItems[messageItems.length - 1].rawItem)
      : undefined;
  const potentialFinalOutput =
    typeof lastMessageText === 'undefined'
      ? undefined
      : getOutputText(newResponse) || lastMessageText;

  // Keep looping if any tool output placeholders still require an approval follow-up.
  const hasPendingToolsOrApprovals =
    functionResults.some(
      (result) => result.runItem instanceof RunToolApprovalItem,
    ) || additionalInterruptions.length > 0;

  if (!hasPendingToolsOrApprovals && messageItems.length > 0) {
    const refusal = getRefusalFromOutputMessage(
      messageItems[messageItems.length - 1].rawItem,
    );
    if (refusal && typeof potentialFinalOutput === 'undefined') {
      const refusalError = new ModelRefusalError(refusal, state);
      const handlerResult = await resolveRunErrorHandler({
        error: refusalError,
        errorHandlers,
        context: state._context,
        runData: buildTurnRunErrorData(
          state,
          agent,
          originalInput,
          preStepItems,
          newItems,
        ),
      });
      if (!handlerResult) {
        throw refusalError;
      }

      const outputText = formatRunErrorFinalOutput(
        agent,
        handlerResult.finalOutput,
      );
      validateRunErrorHandlerFinalOutput(agent, outputText);
      if (handlerResult.includeInHistory !== false) {
        newItems.push(createRunErrorFinalOutputItem(agent, outputText));
      }
      return new SingleStepResult(
        originalInput,
        newResponse,
        preStepItems,
        newItems,
        { type: 'next_step_final_output', output: outputText },
        'error_handler',
      );
    }
  }

  const isMissingStructuredFinalOutput =
    agent.outputType !== 'text' && !potentialFinalOutput;

  // Recover missing structured output when configured; otherwise run again.
  if (
    typeof potentialFinalOutput === 'undefined' ||
    isMissingStructuredFinalOutput
  ) {
    if (!hasPendingToolsOrApprovals && isMissingStructuredFinalOutput) {
      const outputError = new ModelBehaviorError(
        'Model returned no final output for the structured output type.',
      );
      const handledOutput = await resolveInvalidFinalOutput({
        error: outputError,
        errorHandlers,
        agent,
        originalInput,
        preStepItems,
        newItems,
        state,
      });
      if (typeof handledOutput !== 'undefined') {
        return new SingleStepResult(
          originalInput,
          newResponse,
          preStepItems,
          newItems,
          { type: 'next_step_final_output', output: handledOutput },
          'error_handler',
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
      const [error] = await safeExecute(() =>
        processFinalOutputWithRedaction(() =>
          agent.processFinalOutput(potentialFinalOutput),
        ),
      );
      if (error) {
        const redacted = isDataRedactedError(error);
        const outputErrorMessage = redacted
          ? error.message
          : formatFinalOutputTypeError(error);
        const includeTraceErrorDetails =
          runner.config.traceIncludeSensitiveData && !redacted;
        addErrorToCurrentSpan({
          message: includeTraceErrorDetails
            ? outputErrorMessage
            : REDACTED_FINAL_OUTPUT_ERROR_MESSAGE,
          data: includeTraceErrorDetails ? { error: String(error) } : {},
        });
        const outputError = redacted
          ? (error as ModelBehaviorError)
          : new ModelBehaviorError(outputErrorMessage);
        const handledOutput = await resolveInvalidFinalOutput({
          error: outputError,
          errorHandlers,
          agent,
          originalInput,
          preStepItems,
          newItems,
          state,
        });
        if (typeof handledOutput === 'undefined') {
          throw outputError;
        }
        return new SingleStepResult(
          originalInput,
          newResponse,
          preStepItems,
          newItems,
          { type: 'next_step_final_output', output: handledOutput },
          'error_handler',
        );
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
    // Intentional: explicit toolUseBehavior finalization (for example stop_on_first_tool) takes precedence even when other provider-managed work is still pending.
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
