import { OutputGuardrailTripwireTriggered, UserError } from '../errors';
import type { OutputGuardrailResult } from '../guardrail';
import {
  RunHandoffOutputItem,
  RunItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../items';
import {
  getToolCallName,
  getToolCallNamespace,
  getToolCallQualifiedName,
  getFunctionToolLookupKeyForCall,
  matchesFunctionToolName,
} from '../toolIdentity';
import {
  getToolSearchExecution,
  getToolSearchMatchKey,
  getToolSearchOutputReplacementKey,
  getToolSearchProviderCallId,
} from '../tooling';
import { AgentInputItem } from '../types';
import {
  FunctionCallItem as FunctionCallItemSchema,
  FunctionCallResultItem as FunctionCallResultItemSchema,
  type FunctionCallItem,
  type FunctionCallResultItem,
  type ToolSearchOutputItem,
} from '../types/protocol';
import type { RunState } from '../runState';
import type { Session } from '../memory/session';
import { Usage } from '../usage';
import {
  getSerializedOutputGuardrailResults,
  sanitizeBlockedOutputGuardrailResults,
  sanitizeBlockedToolOutputGuardrailResults,
  replaceSanitizedOutputGuardrailMessages,
} from './guardrails';
import { invalidateOutputItemNormalization } from './items';
import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationForResult,
  getToolResultCorrelationKey,
} from './toolResultCorrelation';
import { addLoadedToolNamesFromToolSearchOutput } from './toolSearch';
import { OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT } from './outputGuardrailBlockedMessage';

type BlockedPairKind = 'tool' | 'handoff';

const currentResponseToolOutputGuardrailResultStarts = new WeakMap<
  RunState<any, any>,
  number
>();

export function captureCurrentResponseToolOutputGuardrailResultStart(
  state: RunState<any, any>,
  overwrite: boolean,
): void {
  if (overwrite || !currentResponseToolOutputGuardrailResultStarts.has(state)) {
    currentResponseToolOutputGuardrailResultStarts.set(
      state,
      state._toolOutputGuardrailResults.length,
    );
  }
}

function currentCompletedToolRuns(state: RunState<any, any>) {
  const responseCalls = getResponseOutput(currentResponse(state))?.filter(
    (item): item is FunctionCallItem => item.type === 'function_call',
  );
  const processedRuns = state._lastProcessedResponse?.functions ?? [];
  if (!responseCalls?.length || processedRuns.length < responseCalls.length) {
    return [];
  }
  return processedRuns.slice(-responseCalls.length).filter((run, index) => {
    try {
      return (
        JSON.stringify(buildCanonicalFunctionCall(run.toolCall)) ===
          JSON.stringify(buildCanonicalFunctionCall(responseCalls[index]!)) &&
        state._completedToolInvocationEvidence
          .get(state._currentAgent)
          ?.has(run.toolCall.callId)
      );
    } catch {
      return false;
    }
  });
}

function currentTerminalToolRuns(state: RunState<any, any>) {
  if (state._currentStep?.type !== 'next_step_final_output') {
    return [];
  }
  const behavior = state._currentAgent.toolUseBehavior;
  if (behavior === 'run_llm_again') {
    return [];
  }
  const completedRuns = currentCompletedToolRuns(state);
  if (
    typeof behavior === 'object' &&
    !completedRuns.some((run) =>
      behavior.stopAtToolNames.some((toolName: string) =>
        matchesFunctionToolName(run.tool, toolName),
      ),
    )
  ) {
    return [];
  }
  return completedRuns;
}

export function hasTerminalToolOutputSource(
  state: RunState<any, any>,
): boolean {
  return (
    state._finalOutputSource === 'tool_result' ||
    (state._finalOutputSource === undefined &&
      state._serializedCurrentStep === state._currentStep &&
      currentTerminalToolRuns(state).length > 0)
  );
}

export function sanitizeBlockedTerminalToolOutput(
  state: RunState<any, any>,
  outputGuardrailResultStart: number,
  completedOutputGuardrailTripwireResult:
    OutputGuardrailResult<any, any> | undefined,
  observedOutputGuardrailResults: ReadonlyMap<
    OutputGuardrailResult<any, any>,
    boolean
  >,
  tripwire?: OutputGuardrailTripwireTriggered<any, any>,
  ownedOutputGuardrailResults?: ReadonlySet<OutputGuardrailResult<any, any>>,
  resolveBlockedMessage?: (guardrailName: string) => Promise<string>,
  signal?: AbortSignal,
): false | string | Promise<false | string> {
  if (
    !hasTerminalToolOutputSource(state) ||
    !completedOutputGuardrailTripwireResult
  ) {
    return false;
  }
  redactBlockedResponseToolOutputs(state);
  const sanitizedOutputGuardrailResults = sanitizeBlockedOutputGuardrailResults(
    state,
    outputGuardrailResultStart,
    OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
    observedOutputGuardrailResults,
    tripwire,
    ownedOutputGuardrailResults,
  );
  sanitizeBlockedToolOutputGuardrailResults(
    state,
    currentResponseToolOutputGuardrailResultStarts.get(state) ?? 0,
    OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
  );
  if (!resolveBlockedMessage) {
    return OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT;
  }
  const blockedOutputGuardrailResult = completedOutputGuardrailTripwireResult;
  let guardrailName = 'output_guardrail';
  try {
    const candidate = blockedOutputGuardrailResult.guardrail.name;
    if (typeof candidate === 'string' && candidate.length > 0) {
      guardrailName = candidate;
    }
  } catch {
    // Keep the safe fallback name when caller-owned metadata is unreadable.
  }
  signal?.throwIfAborted();
  return awaitBlockedMessageWithAbort(
    resolveBlockedMessage(guardrailName),
    signal,
  )
    .then((blockedMessage) => {
      signal?.throwIfAborted();
      if (
        typeof blockedMessage !== 'string' ||
        blockedMessage.length === 0 ||
        blockedMessage === OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT
      ) {
        return OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT;
      }
      redactBlockedResponseToolOutputs(state, blockedMessage);
      replaceSanitizedOutputGuardrailMessages(
        state,
        sanitizedOutputGuardrailResults,
        blockedMessage,
        tripwire,
      );
      return blockedMessage;
    })
    .catch(() => {
      signal?.throwIfAborted();
      return OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT;
    });
}

function awaitBlockedMessageWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function shouldDeferInterruptedSessionItems(
  state: RunState<any, any>,
  hasOutputGuardrail: boolean,
): boolean {
  return (
    state._currentStep?.type === 'next_step_interruption' &&
    hasOutputGuardrail &&
    state._currentAgent.toolUseBehavior !== 'run_llm_again' &&
    hasOutputBearingApprovalCheckpoint(state)
  );
}

export function assertResumedSessionOutputGuardrailSafety(
  state: RunState<any, any>,
  session: Session | undefined,
  hasOutputGuardrail: boolean,
): void {
  if (
    hasOutputGuardrail &&
    state._serializedCurrentStep === state._currentStep &&
    state._currentStep?.type === 'next_step_final_output' &&
    state._finalOutputSource === undefined &&
    currentCompletedToolRuns(state).length > 0 &&
    !hasTerminalToolOutputSource(state)
  ) {
    throw new UserError(
      'Cannot resume this serialized terminal output because terminal tool output provenance could not be verified after the tool behavior changed. Continue the live RunState or start a new run from safe input.',
    );
  }
  const shouldDefer = shouldDeferInterruptedSessionItems(
    state,
    hasOutputGuardrail,
  );
  if (state._serializedCurrentStep !== undefined && shouldDefer) {
    const responseOutput = getResponseOutput(currentResponse(state));
    if (
      session !== undefined ||
      state._toolOutputGuardrailResults.length > 0 ||
      !responseOutput ||
      responseOutput.some((item) => item.type !== 'function_call') ||
      !currentRunItemSelection(state, responseOutput).proven
    ) {
      throw new UserError(
        'Cannot resume this serialized output-bearing approval checkpoint because current-response provenance was not preserved. Start a new run from safe input.',
      );
    }
  }
  if (session === undefined) {
    if (shouldDefer && state._currentTurnPersistedItemCount > 0) {
      state.resetTurnPersistence();
    }
    return;
  }
  if (!shouldDefer || state._currentTurnPersistedItemCount <= 0) {
    return;
  }
  const currentCallIds = new Set(
    (state._lastProcessedResponse?.functions ?? []).map(
      (run) => run.toolCall.callId,
    ),
  );
  const currentStart = state._generatedItems.findIndex(
    (item) =>
      item instanceof RunToolCallItem &&
      item.rawItem.type === 'function_call' &&
      currentCallIds.has(item.rawItem.callId),
  );
  const firstOutputIndex = state._generatedItems.findIndex(
    (item, index) =>
      index >= currentStart && item instanceof RunToolCallOutputItem,
  );
  if (
    currentStart >= 0 &&
    firstOutputIndex === state._currentTurnPersistedItemCount &&
    state._generatedItems
      .slice(currentStart, firstOutputIndex)
      .every(
        (item) =>
          'rawItem' in item &&
          item.rawItem.type === 'function_call' &&
          currentCallIds.has(item.rawItem.callId),
      )
  ) {
    return;
  }
  throw new UserError(
    'Cannot resume an output-bearing approval checkpoint with a Session while output guardrails are enabled because the persisted response ownership cannot be proven. Start a new run from safe input.',
  );
}

type BlockedToolRecord = Readonly<{
  key: string;
  role: 'call' | 'result';
  terminal: boolean;
  kind?: BlockedPairKind;
  committed: boolean;
  programCallerId?: string;
  programOwnerId?: string;
}>;

type BlockedPairMember = Readonly<{
  index: number;
  programCallerId?: string;
  agent: RunToolCallOutputItem['agent'];
}>;

type BlockedToolSearchPair = Readonly<{
  callIndex?: number;
  outputIndex: number;
  output: ToolSearchOutputItem;
  agent: RunToolSearchCallItem['agent'];
  replacementKey?: string;
  valid: boolean;
}>;

export type RunItemPersistencePlan = Readonly<{
  alreadyPersistedCount: number;
  runItemsToPersist: RunItem[];
  runItemsToReplace: RunItem[];
  processedRunItemCount: number;
  deferredRunItemIndexes: number[];
  useHistoryTransaction: boolean;
  transactionKind?: 'blocked_append' | 'accepted_replace';
}>;

const REPLAY_SAFE_HOSTED_TOOL_TYPES = new Set([
  'web_search_call',
  'web_search',
  'file_search_call',
  'file_search',
  'image_generation_call',
  'image_generation',
  'code_interpreter_call',
  'code_interpreter',
  'mcp_call',
  'mcp_list_tools',
]);

function getProgramCallerId(item: AgentInputItem): string | undefined {
  if (!item || typeof item !== 'object' || !('caller' in item)) {
    return undefined;
  }
  const caller = (item as { caller?: unknown }).caller;
  if (!caller || typeof caller !== 'object') {
    return undefined;
  }
  const candidate = caller as { type?: unknown; callerId?: unknown };
  return candidate.type === 'program' && typeof candidate.callerId === 'string'
    ? candidate.callerId
    : undefined;
}

function getProviderStatus(item: AgentInputItem): unknown {
  const providerData = (item as { providerData?: unknown }).providerData;
  return providerData && typeof providerData === 'object'
    ? (providerData as { status?: unknown }).status
    : undefined;
}

function hasOnlyCompletedStatusEvidence(
  itemStatus: unknown,
  providerStatus: unknown,
  allowMissing: boolean,
): boolean {
  if (itemStatus === undefined && providerStatus === undefined) {
    return allowMissing;
  }
  return (
    (itemStatus === undefined || itemStatus === 'completed') &&
    (providerStatus === undefined || providerStatus === 'completed')
  );
}

function supportsLocalExecutionProvenance(
  type: AgentInputItem['type'],
): boolean {
  return (
    type === 'function_call_result' ||
    type === 'shell_call_output' ||
    type === 'computer_call_result' ||
    type === 'apply_patch_call_output'
  );
}

function getBlockedPairKind(
  item: RunItem,
  role: BlockedToolRecord['role'],
): BlockedPairKind | undefined {
  if (role === 'call') {
    if (item.type === 'tool_call_item') {
      return 'tool';
    }
    if (item.type === 'handoff_call_item') {
      return 'handoff';
    }
    return undefined;
  }
  if (item instanceof RunToolCallOutputItem) {
    return 'tool';
  }
  if (item instanceof RunHandoffOutputItem) {
    return 'handoff';
  }
  return undefined;
}

function classifyBlockedToolRecord(
  item: RunItem,
): BlockedToolRecord | undefined {
  const rawItem = (item as { rawItem?: AgentInputItem }).rawItem;
  if (!rawItem) {
    return undefined;
  }
  const type = (rawItem as { type?: unknown }).type;
  const status = (rawItem as { status?: unknown }).status;
  let role: BlockedToolRecord['role'];
  let terminal: boolean;

  switch (type) {
    case 'program':
    case 'function_call':
    case 'shell_call':
    case 'computer_call':
    case 'apply_patch_call':
      role = 'call';
      // A locally executed call can retain an in-progress provider status. The matching result's
      // durable execution provenance is the authoritative side-effect boundary.
      terminal = true;
      break;
    case 'function_call_result':
    case 'program_output':
      role = 'result';
      terminal = status === 'completed';
      break;
    case 'computer_call_result': {
      role = 'result';
      const providerData = (rawItem as { providerData?: unknown }).providerData;
      const providerStatus =
        providerData && typeof providerData === 'object'
          ? (providerData as { status?: unknown }).status
          : undefined;
      terminal = providerStatus === undefined || providerStatus === 'completed';
      break;
    }
    case 'shell_call_output': {
      role = 'result';
      terminal = hasOnlyCompletedStatusEvidence(
        status,
        getProviderStatus(rawItem),
        true,
      );
      break;
    }
    case 'apply_patch_call_output':
      role = 'result';
      terminal = status === 'completed' || status === 'failed';
      break;
    default:
      return undefined;
  }

  const correlation =
    role === 'call'
      ? getToolResultCorrelationForCall(rawItem)
      : getToolResultCorrelationForResult(rawItem);
  const kind = getBlockedPairKind(item, role);
  return correlation
    ? {
        key: getToolResultCorrelationKey(correlation),
        role,
        terminal,
        kind,
        committed:
          kind === 'handoff' ||
          (kind === 'tool' &&
            role === 'result' &&
            supportsLocalExecutionProvenance(type) &&
            (item as RunToolCallOutputItem).executionStatus === 'executed'),
        programCallerId: getProgramCallerId(rawItem),
        programOwnerId:
          type === 'program' &&
          typeof (rawItem as { callId?: unknown }).callId === 'string'
            ? (rawItem as { callId: string }).callId
            : undefined,
      }
    : undefined;
}

function getBlockedRunItemAgent(item: RunItem): RunToolCallOutputItem['agent'] {
  return item instanceof RunHandoffOutputItem ? item.sourceAgent : item.agent;
}

function isReplaySafeTerminalHostedToolCall(item: RunItem): boolean {
  const rawItem = (item as { rawItem?: AgentInputItem }).rawItem;
  const providerData =
    rawItem?.type === 'hosted_tool_call' &&
    rawItem.providerData &&
    typeof rawItem.providerData === 'object'
      ? (rawItem.providerData as { status?: unknown; type?: unknown })
      : undefined;
  const itemStatus =
    rawItem?.type === 'hosted_tool_call' ? rawItem.status : undefined;
  const providerStatus = providerData?.status;
  if (
    item.type !== 'tool_call_item' ||
    rawItem?.type !== 'hosted_tool_call' ||
    !hasOnlyCompletedStatusEvidence(itemStatus, providerStatus, false)
  ) {
    return false;
  }
  const providerType = providerData?.type;
  if (providerType !== undefined) {
    return (
      typeof providerType === 'string' &&
      REPLAY_SAFE_HOSTED_TOOL_TYPES.has(providerType)
    );
  }
  return REPLAY_SAFE_HOSTED_TOOL_TYPES.has(rawItem.name);
}

function collectBlockedToolSearchPairs(
  items: RunItem[],
): BlockedToolSearchPair[] {
  type ToolSearchCallOccurrence = {
    callIndex: number;
    call: RunToolSearchCallItem;
  };
  const latestCallByAgentAndKey = new Map<
    RunToolSearchCallItem['agent'],
    Map<string, ToolSearchCallOccurrence>
  >();
  const pendingClientCalls = new Map<
    RunToolSearchCallItem['agent'],
    ToolSearchCallOccurrence[]
  >();
  const pendingServerCalls = new Map<
    RunToolSearchCallItem['agent'],
    ToolSearchCallOccurrence[]
  >();
  const pairs: BlockedToolSearchPair[] = [];

  for (const [index, item] of items.entries()) {
    if (item instanceof RunToolSearchCallItem) {
      const key = getToolSearchMatchKey(item.rawItem);
      if (!key) {
        continue;
      }
      const server = getToolSearchExecution(item.rawItem) === 'server';
      const pairKey = `${server ? 'server' : 'client'}:${key}`;
      const occurrence = { callIndex: index, call: item };
      const byKey = latestCallByAgentAndKey.get(item.agent) ?? new Map();
      byKey.set(pairKey, occurrence);
      latestCallByAgentAndKey.set(item.agent, byKey);
      const pending = server ? pendingServerCalls : pendingClientCalls;
      const occurrences = pending.get(item.agent) ?? [];
      occurrences.push(occurrence);
      pending.set(item.agent, occurrences);
      continue;
    }

    if (!(item instanceof RunToolSearchOutputItem)) {
      continue;
    }
    const server = getToolSearchExecution(item.rawItem) === 'server';
    const pending = server ? pendingServerCalls : pendingClientCalls;
    const pendingOccurrences = pending.get(item.agent) ?? [];
    const explicitKey = getToolSearchProviderCallId(item.rawItem);
    const occurrence = explicitKey
      ? latestCallByAgentAndKey
          .get(item.agent)
          ?.get(`${server ? 'server' : 'client'}:${explicitKey}`)
      : pendingOccurrences.shift();
    if (explicitKey && occurrence) {
      const pendingIndex = pendingOccurrences.indexOf(occurrence);
      if (pendingIndex >= 0) {
        pendingOccurrences.splice(pendingIndex, 1);
      }
    }
    pairs.push({
      callIndex: occurrence?.callIndex,
      outputIndex: index,
      output: item.rawItem,
      agent: item.agent,
      replacementKey: getToolSearchOutputReplacementKey(item.rawItem),
      valid:
        occurrence !== undefined &&
        item.rawItem.status === 'completed' &&
        (!server || occurrence.call.rawItem.status === 'completed'),
    });
  }
  return pairs;
}

function toolSearchOutputLoadsRetainedCall(
  output: ToolSearchOutputItem,
  call: AgentInputItem,
): boolean {
  const loadedToolNames = new Set<string>();
  addLoadedToolNamesFromToolSearchOutput(output, loadedToolNames);
  if (call.type === 'function_call') {
    const qualifiedName = getToolCallQualifiedName(call);
    if (qualifiedName && loadedToolNames.has(qualifiedName)) {
      return true;
    }
    const name = getToolCallName(call);
    const namespace = getToolCallNamespace(call);
    return (
      name !== undefined &&
      (!namespace || namespace === name) &&
      loadedToolNames.has(name)
    );
  }

  const providerData =
    call.type === 'hosted_tool_call' &&
    call.providerData &&
    typeof call.providerData === 'object'
      ? (call.providerData as { type?: unknown; server_label?: unknown })
      : undefined;
  return (
    (providerData?.type === 'mcp_call' ||
      providerData?.type === 'mcp_list_tools') &&
    typeof providerData.server_label === 'string' &&
    loadedToolNames.has(providerData.server_label)
  );
}

function isToolSearchDependentRetainedCall(call: AgentInputItem): boolean {
  if (call.type === 'function_call') {
    return true;
  }
  const providerData =
    call.type === 'hosted_tool_call' &&
    call.providerData &&
    typeof call.providerData === 'object'
      ? (call.providerData as { type?: unknown; server_label?: unknown })
      : undefined;
  return (
    (providerData?.type === 'mcp_call' ||
      providerData?.type === 'mcp_list_tools') &&
    typeof providerData.server_label === 'string'
  );
}

/**
 * Selects replay-safe tool effects when an assistant's final output is blocked.
 *
 * Unknown run-item kinds are excluded. Reasoning is retained only when the next non-reasoning
 * item is a retained tool call or one of its required provenance records.
 */
export function selectRunItemIndexesForBlockedOutput(
  items: RunItem[],
  unpersistedStartIndex = 0,
): number[] {
  type BlockedPair = {
    valid: boolean;
    kind?: BlockedPairKind;
    calls: BlockedPairMember[];
    results: Array<BlockedPairMember & { committed: boolean }>;
  };
  const pairsByAgent = new Map<
    RunToolCallOutputItem['agent'],
    Map<string, BlockedPair>
  >();
  const programOwnerIndexesByAgent = new Map<
    RunToolCallOutputItem['agent'],
    Map<string, number[]>
  >();
  const standaloneCalls: BlockedPairMember[] = [];
  const toolSearchPairs = collectBlockedToolSearchPairs(items);

  for (const [index, item] of items.entries()) {
    if (isReplaySafeTerminalHostedToolCall(item)) {
      standaloneCalls.push({
        index,
        programCallerId: getProgramCallerId(item.rawItem as AgentInputItem),
        agent: getBlockedRunItemAgent(item),
      });
      continue;
    }
    const record = classifyBlockedToolRecord(item);
    if (!record) {
      continue;
    }
    const itemAgent = getBlockedRunItemAgent(item);
    const pairs = pairsByAgent.get(itemAgent) ?? new Map();
    pairsByAgent.set(itemAgent, pairs);
    let pair = pairs.get(record.key);
    if (!pair) {
      pair = { valid: true, calls: [], results: [] };
      pairs.set(record.key, pair);
    }
    if (
      !record.terminal ||
      !record.kind ||
      (pair.kind !== undefined && pair.kind !== record.kind)
    ) {
      pair.valid = false;
      continue;
    }
    pair.kind = record.kind;
    if (record.programOwnerId !== undefined && record.kind === 'tool') {
      const ownersById = programOwnerIndexesByAgent.get(itemAgent) ?? new Map();
      const ownerIndexes = ownersById.get(record.programOwnerId) ?? [];
      ownerIndexes.push(index);
      ownersById.set(record.programOwnerId, ownerIndexes);
      programOwnerIndexesByAgent.set(itemAgent, ownersById);
    }
    const member = {
      index,
      programCallerId: record.programCallerId,
      agent: itemAgent,
    };
    if (record.role === 'call') {
      pair.calls.push(member);
    } else {
      pair.results.push({ ...member, committed: record.committed });
    }
  }

  const retainedIndexes = new Set<number>();
  const retainedCallIndexes = new Set<number>();
  const directlyRetainedCallIndexes = new Set<number>();
  const retainedResultIndexByCallIndex = new Map<number, number>();
  const programOwnerIndexByCallIndex = new Map<number, number>();
  const retainCallWithProgramOwner = (call: BlockedPairMember): boolean => {
    if (call.programCallerId !== undefined) {
      const ownerIndexes =
        programOwnerIndexesByAgent.get(call.agent)?.get(call.programCallerId) ??
        [];
      if (ownerIndexes.length !== 1 || ownerIndexes[0]! >= call.index) {
        return false;
      }
      retainedIndexes.add(ownerIndexes[0]!);
      retainedCallIndexes.add(ownerIndexes[0]!);
      programOwnerIndexByCallIndex.set(call.index, ownerIndexes[0]!);
    }
    retainedIndexes.add(call.index);
    retainedCallIndexes.add(call.index);
    return true;
  };

  for (const pairs of pairsByAgent.values()) {
    for (const pair of pairs.values()) {
      if (!pair.valid || pair.calls.length !== 1 || pair.results.length !== 1) {
        continue;
      }
      const call = pair.calls[0]!;
      const result = pair.results[0]!;
      if (
        call.index >= result.index ||
        call.programCallerId !== result.programCallerId ||
        (!result.committed && call.index >= unpersistedStartIndex)
      ) {
        continue;
      }
      if (retainCallWithProgramOwner(call)) {
        directlyRetainedCallIndexes.add(call.index);
        retainedIndexes.add(result.index);
        retainedResultIndexByCallIndex.set(call.index, result.index);
      }
    }
  }

  for (const standaloneCall of standaloneCalls) {
    if (retainCallWithProgramOwner(standaloneCall)) {
      directlyRetainedCallIndexes.add(standaloneCall.index);
    }
  }

  for (const retainedCallIndex of [...retainedCallIndexes]) {
    const retainedCall = items[retainedCallIndex] as {
      rawItem?: AgentInputItem;
      agent?: unknown;
    };
    const rawItem = retainedCall.rawItem;
    if (!rawItem || !isToolSearchDependentRetainedCall(rawItem)) {
      continue;
    }
    const precedingOccurrences = toolSearchPairs.filter(
      (pair) =>
        pair.agent === retainedCall.agent &&
        pair.outputIndex < retainedCallIndex,
    );
    const hasMatchingOutput = precedingOccurrences.some((pair) =>
      toolSearchOutputLoadsRetainedCall(pair.output, rawItem),
    );
    if (!hasMatchingOutput) {
      continue;
    }
    const latestByReplacementKey = new Map<string, BlockedToolSearchPair>();
    const additiveOccurrences: BlockedToolSearchPair[] = [];
    for (const occurrence of precedingOccurrences) {
      if (occurrence.replacementKey === undefined) {
        additiveOccurrences.push(occurrence);
      } else {
        latestByReplacementKey.set(occurrence.replacementKey, occurrence);
      }
    }
    const supplier = [
      ...latestByReplacementKey.values(),
      ...additiveOccurrences,
    ]
      .filter(
        (occurrence) =>
          occurrence.valid &&
          occurrence.callIndex !== undefined &&
          toolSearchOutputLoadsRetainedCall(occurrence.output, rawItem),
      )
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .at(-1);
    if (!supplier) {
      retainedIndexes.delete(retainedCallIndex);
      retainedCallIndexes.delete(retainedCallIndex);
      directlyRetainedCallIndexes.delete(retainedCallIndex);
      const resultIndex = retainedResultIndexByCallIndex.get(retainedCallIndex);
      if (resultIndex !== undefined) {
        retainedIndexes.delete(resultIndex);
      }
      continue;
    }
    retainedIndexes.add(supplier.callIndex!);
    retainedIndexes.add(supplier.outputIndex);
    retainedCallIndexes.add(supplier.callIndex!);
  }

  const neededProgramOwnerIndexes = new Set(
    [...programOwnerIndexByCallIndex]
      .filter(([callIndex]) => retainedCallIndexes.has(callIndex))
      .map(([, ownerIndex]) => ownerIndex),
  );
  for (const ownerIndex of programOwnerIndexByCallIndex.values()) {
    if (
      !directlyRetainedCallIndexes.has(ownerIndex) &&
      !neededProgramOwnerIndexes.has(ownerIndex)
    ) {
      retainedIndexes.delete(ownerIndex);
      retainedCallIndexes.delete(ownerIndex);
    }
  }

  if (retainedIndexes.size === 0) {
    return [];
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type !== 'reasoning_item') {
      continue;
    }
    for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
      if (items[nextIndex]?.type === 'reasoning_item') {
        continue;
      }
      if (retainedCallIndexes.has(nextIndex)) {
        retainedIndexes.add(index);
      }
      break;
    }
  }

  return [...retainedIndexes]
    .filter((index) => index >= unpersistedStartIndex)
    .sort((left, right) => left - right);
}

export function hasBlockedOutputExecutionEffect(
  items: RunItem[],
  unpersistedStartIndex = 0,
): boolean {
  return (
    selectRunItemIndexesForBlockedOutput(items, unpersistedStartIndex).length >
      0 ||
    items
      .slice(unpersistedStartIndex)
      .some(
        (item) =>
          item instanceof RunToolCallOutputItem &&
          item.executionStatus === 'executed',
      )
  );
}

export function buildRunItemPersistencePlan(options: {
  items: RunItem[];
  alreadyPersistedCount: number;
  currentDeferredIndexes: Iterable<number>;
  outputBlocked: boolean;
  canUseHistoryTransactions: boolean;
  blockedSnapshot?: Readonly<{
    items: RunItem[];
    startIndex: number;
    alreadyPersistedCount: number;
  }>;
}): RunItemPersistencePlan {
  const {
    items,
    alreadyPersistedCount,
    currentDeferredIndexes,
    outputBlocked,
    canUseHistoryTransactions,
    blockedSnapshot,
  } = options;
  const newRunItemIndexes = Array.from(
    { length: Math.max(0, items.length - alreadyPersistedCount) },
    (_value, offset) => alreadyPersistedCount + offset,
  );

  if (outputBlocked) {
    if (blockedSnapshot) {
      const snapshotPersistedCount = canUseHistoryTransactions
        ? alreadyPersistedCount
        : blockedSnapshot.alreadyPersistedCount;
      const persistedSnapshotItems = Math.max(
        0,
        snapshotPersistedCount - blockedSnapshot.startIndex,
      );
      return {
        alreadyPersistedCount: snapshotPersistedCount,
        runItemsToPersist: blockedSnapshot.items.slice(persistedSnapshotItems),
        runItemsToReplace: [],
        processedRunItemCount: newRunItemIndexes.length,
        deferredRunItemIndexes: [],
        useHistoryTransaction: canUseHistoryTransactions,
        transactionKind: 'blocked_append',
      };
    }
    if (!canUseHistoryTransactions) {
      return {
        alreadyPersistedCount,
        runItemsToPersist: [],
        runItemsToReplace: [],
        processedRunItemCount: 0,
        deferredRunItemIndexes: [],
        useHistoryTransaction: false,
      };
    }
    const retainedIndexes = selectRunItemIndexesForBlockedOutput(
      items,
      alreadyPersistedCount,
    );
    if (retainedIndexes.length === 0) {
      return {
        alreadyPersistedCount,
        runItemsToPersist: [],
        runItemsToReplace: [],
        processedRunItemCount: 0,
        deferredRunItemIndexes: [],
        useHistoryTransaction: false,
      };
    }
    const retainedIndexSet = new Set(retainedIndexes);
    const deferredRunItemIndexes = [
      ...new Set([
        ...currentDeferredIndexes,
        ...newRunItemIndexes.filter((index) => !retainedIndexSet.has(index)),
      ]),
    ]
      .filter((index) => index < items.length)
      .sort((left, right) => left - right);
    return {
      alreadyPersistedCount,
      runItemsToPersist: retainedIndexes.map((index) => items[index]!),
      runItemsToReplace: [],
      processedRunItemCount: newRunItemIndexes.length,
      deferredRunItemIndexes,
      useHistoryTransaction: true,
      transactionKind: 'blocked_append',
    };
  }

  const deferredIndexes = [...currentDeferredIndexes]
    .filter((index) => index < items.length)
    .sort((left, right) => left - right);
  if (deferredIndexes.length === 0) {
    return {
      alreadyPersistedCount,
      runItemsToPersist: items.slice(alreadyPersistedCount),
      runItemsToReplace: [],
      processedRunItemCount: newRunItemIndexes.length,
      deferredRunItemIndexes: [],
      useHistoryTransaction: false,
    };
  }
  if (!canUseHistoryTransactions) {
    throw new UserError(
      'Cannot persist accepted output from this RunState because its blocked output was saved by a transaction-aware session. Resume with the same transaction-aware session.',
    );
  }

  const firstDeferredIndex = deferredIndexes[0]!;
  const deferredIndexSet = new Set(deferredIndexes);
  const processedEndIndex = Math.min(alreadyPersistedCount, items.length);
  const runItemsToReplace: RunItem[] = [];
  for (let index = firstDeferredIndex; index < processedEndIndex; index += 1) {
    if (!deferredIndexSet.has(index)) {
      runItemsToReplace.push(items[index]!);
    }
  }
  let replacementStartIndex = firstDeferredIndex;
  if (runItemsToReplace.length === 0) {
    const anchorIndex = firstDeferredIndex - 1;
    if (anchorIndex < 0) {
      throw new UserError(
        'Cannot persist accepted output because the blocked session suffix has no retained anchor.',
      );
    }
    runItemsToReplace.push(items[anchorIndex]!);
    replacementStartIndex = anchorIndex;
  }
  return {
    alreadyPersistedCount,
    runItemsToPersist: items.slice(replacementStartIndex),
    runItemsToReplace,
    processedRunItemCount: newRunItemIndexes.length,
    deferredRunItemIndexes: [],
    useHistoryTransaction: true,
    transactionKind: 'accepted_replace',
  };
}

type BlockedModelResponse = NonNullable<
  RunState<any, any>['_lastTurnResponse']
>;

function optionalField<K extends PropertyKey, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function buildCanonicalFunctionCall(rawItem: AgentInputItem): FunctionCallItem {
  const parsed = FunctionCallItemSchema.parse(rawItem);
  return FunctionCallItemSchema.parse({
    type: 'function_call',
    name: parsed.name,
    ...optionalField('namespace', parsed.namespace),
    callId: parsed.callId,
    arguments: parsed.arguments,
    ...optionalField('id', parsed.id),
    ...optionalField('status', parsed.status),
    ...optionalField('caller', parsed.caller),
  });
}

export function buildBlockedToolOutputRawItem(
  rawItem: AgentInputItem,
  blockedMessage = OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
): FunctionCallResultItem {
  const parsed = FunctionCallResultItemSchema.parse(rawItem);
  return FunctionCallResultItemSchema.parse({
    type: 'function_call_result',
    name: parsed.name,
    ...optionalField('namespace', parsed.namespace),
    callId: parsed.callId,
    output: blockedMessage,
    ...optionalField('id', parsed.id),
    ...optionalField('status', parsed.status),
  });
}

function getResponseOutput(
  response: BlockedModelResponse | undefined,
): AgentInputItem[] | undefined {
  if (!response) return [];
  try {
    return Array.isArray(response.output)
      ? (response.output.slice() as AgentInputItem[])
      : undefined;
  } catch {
    return undefined;
  }
}

function copyResponseString(
  response: BlockedModelResponse,
  key: 'responseId' | 'requestId',
): string | undefined {
  try {
    const value = response[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function cloneBlockedResponse(
  response: BlockedModelResponse,
  output: AgentInputItem[],
): BlockedModelResponse {
  let usage = new Usage();
  try {
    usage = new Usage(response.usage);
  } catch {
    // Usage is not replay authority. Keep the replacement data-free.
  }
  return {
    usage,
    output,
    ...optionalField('responseId', copyResponseString(response, 'responseId')),
    ...optionalField('requestId', copyResponseString(response, 'requestId')),
  };
}

function currentResponse(
  state: RunState<any, any>,
): BlockedModelResponse | undefined {
  return state._lastTurnResponse;
}

function functionCallKey(item: AgentInputItem): string | undefined {
  if (item?.type !== 'function_call') return undefined;
  try {
    const parsed = FunctionCallItemSchema.parse(item);
    const toolKey = getFunctionToolLookupKeyForCall(parsed);
    return toolKey ? JSON.stringify([toolKey, parsed.callId]) : undefined;
  } catch {
    return undefined;
  }
}

function functionResultKey(item: AgentInputItem): string | undefined {
  if (item?.type !== 'function_call_result') return undefined;
  try {
    const parsed = FunctionCallResultItemSchema.parse(item);
    const toolKey = getFunctionToolLookupKeyForCall(parsed);
    return toolKey ? JSON.stringify([toolKey, parsed.callId]) : undefined;
  } catch {
    return undefined;
  }
}

type CurrentRunItemSelection = Readonly<{
  primary: RunItem[];
  aliases: RunItem[];
  proven: boolean;
}>;

function functionRunItemSignature(item: RunItem): string | undefined {
  try {
    if (
      item instanceof RunToolCallItem &&
      item.rawItem.type === 'function_call'
    ) {
      return JSON.stringify(buildCanonicalFunctionCall(item.rawItem));
    }
    if (
      item instanceof RunToolCallOutputItem &&
      item.rawItem.type === 'function_call_result'
    ) {
      const parsed = FunctionCallResultItemSchema.parse(item.rawItem);
      return JSON.stringify({
        type: parsed.type,
        name: parsed.name,
        ...optionalField('namespace', parsed.namespace),
        callId: parsed.callId,
        output: parsed.output,
        ...optionalField('id', parsed.id),
        ...optionalField('status', parsed.status),
      });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function functionRunItemSequenceIsPrefix(
  items: readonly RunItem[],
  prefix: readonly RunItem[],
): boolean {
  return (
    prefix.length <= items.length &&
    prefix.every((item, index) => {
      const signature = functionRunItemSignature(item);
      return (
        signature !== undefined &&
        signature === functionRunItemSignature(items[index]!)
      );
    })
  );
}

function boundedCurrentFunctionResponseStart(
  generated: readonly RunItem[],
  responseOutput: readonly AgentInputItem[],
): number | undefined {
  const responseKeys = responseOutput.map(functionCallKey);
  if (
    responseKeys.length === 0 ||
    responseKeys.some((key) => key === undefined)
  ) {
    return undefined;
  }
  const start = generated.length - responseKeys.length * 2;
  if (start < 0) return undefined;
  const suffix = generated.slice(start);
  const calls = suffix.filter(
    (item): item is RunToolCallItem =>
      item instanceof RunToolCallItem && item.rawItem.type === 'function_call',
  );
  const results = suffix.filter(
    (item): item is RunToolCallOutputItem =>
      item instanceof RunToolCallOutputItem &&
      item.rawItem.type === 'function_call_result',
  );
  if (
    calls.length !== responseKeys.length ||
    results.length !== responseKeys.length ||
    calls.some(
      (item, index) => functionCallKey(item.rawItem) !== responseKeys[index],
    ) ||
    results.some(
      (item, index) => functionResultKey(item.rawItem) !== responseKeys[index],
    )
  ) {
    return undefined;
  }
  return start;
}

function currentRunItemSelection(
  state: RunState<any, any>,
  responseOutput: AgentInputItem[],
): CurrentRunItemSelection {
  const generated = state._generatedItems.slice();
  const responseObjects = new Set(responseOutput);
  const processed = state._lastProcessedResponse?.newItems ?? [];
  const ownsResponseItem = (item: RunItem): boolean => {
    try {
      return (
        'rawItem' in item && responseObjects.has(item.rawItem as AgentInputItem)
      );
    } catch {
      return false;
    }
  };
  const processedOwnsResponse = processed.some(ownsResponseItem);
  const processedItems = new Set(processed);
  const processedOwnerStart = generated.findIndex((item) =>
    processedItems.has(item),
  );
  const completedInvocationOwners = new Set(
    (state._lastProcessedResponse?.functions ?? []).flatMap(
      (run) =>
        state._completedToolInvocationEvidence
          .get(state._currentAgent)
          ?.get(run.toolCall.callId)?.items ?? [],
    ),
  );
  const completedInvocationOwnerStart = generated.findIndex((item) =>
    completedInvocationOwners.has(item),
  );
  const boundedCurrentStart = boundedCurrentFunctionResponseStart(
    generated,
    responseOutput,
  );
  let start = generated.findIndex(ownsResponseItem);
  if (
    start < 0 &&
    boundedCurrentStart !== undefined &&
    (processedOwnerStart >= boundedCurrentStart ||
      completedInvocationOwnerStart >= boundedCurrentStart)
  ) {
    start = boundedCurrentStart;
  }
  if (start >= 0) {
    const primary = generated.slice(start);
    const aliases = [...primary];
    const currentProcessedCalls = new Set(
      (state._lastProcessedResponse?.functions ?? []).map(
        (run) => run.toolCall,
      ),
    );
    let currentProcessedStart = processed.findIndex(ownsResponseItem);
    if (currentProcessedStart < 0) {
      currentProcessedStart = processed.findIndex((item) =>
        primary.includes(item),
      );
    }
    if (currentProcessedStart < 0) {
      currentProcessedStart = processed.findIndex(
        (item) =>
          item instanceof RunToolCallItem &&
          item.rawItem.type === 'function_call' &&
          currentProcessedCalls.has(item.rawItem),
      );
    }
    if (
      currentProcessedStart >= 0 &&
      (processedOwnsResponse ||
        processedOwnerStart >= start ||
        completedInvocationOwnerStart >= start)
    ) {
      for (const item of processed.slice(currentProcessedStart)) {
        if (!aliases.includes(item)) aliases.push(item);
      }
    }
    return { primary, aliases, proven: true };
  }

  if (
    state._currentStep?.type === 'next_step_interruption' &&
    processed.length > 0 &&
    processed.length === responseOutput.length &&
    processed.length * 2 <= generated.length &&
    processed.every(
      (item, index) =>
        item instanceof RunToolCallItem &&
        item.rawItem.type === 'function_call' &&
        functionCallKey(item.rawItem) ===
          functionCallKey(responseOutput[index]!),
    )
  ) {
    const interruptionCount = state._currentStep.data.interruptions.length;
    const currentSuffix = generated.slice(-processed.length * 2);
    const callItems = currentSuffix.slice(0, processed.length);
    const outcomeItems = currentSuffix.slice(processed.length);
    const responseKeys = new Set(responseOutput.map(functionCallKey));
    const outcomeKeys = new Set<string>();
    let approvalCount = 0;
    const outcomesAreBounded = outcomeItems.every((item) => {
      if (item.type === 'tool_approval_item') {
        if (!('rawItem' in item) || item.rawItem.type !== 'function_call') {
          return false;
        }
        approvalCount += 1;
        const key = functionCallKey(item.rawItem);
        if (!key || !responseKeys.has(key) || outcomeKeys.has(key))
          return false;
        outcomeKeys.add(key);
        return true;
      }
      if (
        !(item instanceof RunToolCallOutputItem) ||
        item.rawItem.type !== 'function_call_result'
      ) {
        return false;
      }
      const key = functionResultKey(item.rawItem);
      if (!key || !responseKeys.has(key) || outcomeKeys.has(key)) return false;
      outcomeKeys.add(key);
      return true;
    });
    if (
      responseKeys.size === responseOutput.length &&
      outcomeKeys.size === responseOutput.length &&
      approvalCount === interruptionCount &&
      outcomesAreBounded &&
      functionRunItemSequenceIsPrefix(callItems, processed)
    ) {
      return {
        primary: currentSuffix,
        aliases: [...currentSuffix, ...processed],
        proven: true,
      };
    }
  }

  if (state._currentTurnBlockedSessionStartIndex !== undefined) {
    const blockedStart = Math.min(
      state._currentTurnBlockedSessionStartIndex,
      generated.length,
    );
    return {
      primary: generated.slice(blockedStart),
      aliases: generated.slice(blockedStart),
      proven: true,
    };
  }

  const fallbackStart = Math.min(
    state._currentTurnPersistedItemCount,
    generated.length,
  );
  const fallback = generated.slice(fallbackStart);
  return { primary: fallback, aliases: fallback, proven: false };
}

type CurrentFunctionPairPlan = Readonly<{
  responseOutput: FunctionCallItem[];
  replacements: ReadonlyMap<RunItem, RunItem>;
  sanitizedItems: RunItem[];
}>;

function buildCurrentFunctionPairPlan(
  state: RunState<any, any>,
  responseOutput: AgentInputItem[],
  selection: CurrentRunItemSelection,
  blockedMessage = OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
): CurrentFunctionPairPlan | undefined {
  if (!selection.proven) return undefined;

  try {
    const canonicalResponse = responseOutput.map(buildCanonicalFunctionCall);
    const responseKeys = canonicalResponse.map((item) => {
      const key = functionCallKey(item);
      if (!key) throw new Error();
      return key;
    });
    if (
      responseKeys.length === 0 ||
      new Set(responseKeys).size !== responseKeys.length
    ) {
      return undefined;
    }

    const callKeys: string[] = [];
    const resultKeys: string[] = [];
    const callIndexes = new Map<string, number>();
    const resultIndexes = new Map<string, number>();
    const sanitizedItems: RunItem[] = [];
    for (const [index, item] of selection.primary.entries()) {
      if (
        item instanceof RunToolCallItem &&
        item.rawItem.type === 'function_call'
      ) {
        const key = functionCallKey(item.rawItem);
        if (!key || callIndexes.has(key)) return undefined;
        callKeys.push(key);
        callIndexes.set(key, index);
        sanitizedItems.push(
          new RunToolCallItem(
            buildCanonicalFunctionCall(item.rawItem),
            item.agent,
          ),
        );
        continue;
      }
      if (
        item instanceof RunToolCallOutputItem &&
        item.rawItem.type === 'function_call_result'
      ) {
        const key = functionResultKey(item.rawItem);
        if (!key || resultIndexes.has(key)) return undefined;
        resultKeys.push(key);
        resultIndexes.set(key, index);
        sanitizedItems.push(
          new RunToolCallOutputItem(
            buildBlockedToolOutputRawItem(item.rawItem, blockedMessage),
            item.agent,
            blockedMessage,
            undefined,
            item.executionStatus,
          ),
        );
        continue;
      }
      return undefined;
    }

    if (
      callKeys.length !== responseKeys.length ||
      resultKeys.length !== responseKeys.length ||
      callKeys.some((key, index) => key !== responseKeys[index]) ||
      resultKeys.some((key, index) => key !== responseKeys[index]) ||
      responseKeys.some(
        (key) =>
          callIndexes.get(key) === undefined ||
          resultIndexes.get(key) === undefined ||
          callIndexes.get(key)! >= resultIndexes.get(key)!,
      )
    ) {
      return undefined;
    }

    const replacements = new Map<RunItem, RunItem>();
    for (const [index, item] of selection.primary.entries()) {
      replacements.set(item, sanitizedItems[index]!);
    }
    const processed = state._lastProcessedResponse?.newItems ?? [];
    const aliases = new Set(selection.aliases);
    let currentProcessedStart = processed.findIndex((item) =>
      aliases.has(item),
    );
    if (
      currentProcessedStart < 0 &&
      state._serializedCurrentStep !== undefined &&
      state._serializedCurrentStep === state._currentStep &&
      functionRunItemSequenceIsPrefix(selection.primary, processed)
    ) {
      currentProcessedStart = 0;
      for (const item of processed) aliases.add(item);
    }
    if (currentProcessedStart >= 0) {
      const currentProcessed = processed.slice(currentProcessedStart);
      if (
        currentProcessed.some((item) => !aliases.has(item)) ||
        !functionRunItemSequenceIsPrefix(selection.primary, currentProcessed)
      ) {
        return undefined;
      }
      for (const [index, item] of currentProcessed.entries()) {
        if (replacements.has(item)) continue;
        const replacement = sanitizedItems[index]!;
        if (
          replacement instanceof RunToolCallItem &&
          item instanceof RunToolCallItem
        ) {
          replacements.set(
            item,
            new RunToolCallItem(replacement.rawItem, item.agent),
          );
        } else if (
          replacement instanceof RunToolCallOutputItem &&
          item instanceof RunToolCallOutputItem
        ) {
          replacements.set(
            item,
            new RunToolCallOutputItem(
              replacement.rawItem,
              item.agent,
              blockedMessage,
              undefined,
              replacement.executionStatus,
            ),
          );
        } else {
          return undefined;
        }
      }
    }
    return {
      responseOutput: sanitizedItems.flatMap((item): FunctionCallItem[] =>
        item instanceof RunToolCallItem && item.rawItem.type === 'function_call'
          ? [item.rawItem]
          : [],
      ),
      replacements,
      sanitizedItems,
    };
  } catch {
    return undefined;
  }
}

function replaceRunItems(
  state: RunState<any, any>,
  replacements: ReadonlyMap<RunItem, RunItem | undefined>,
  responseOutput: AgentInputItem[] | undefined,
  canonicalResponseOutput: FunctionCallItem[],
): void {
  const rawReplacements = new Map<AgentInputItem, AgentInputItem | undefined>();
  for (const [item, replacement] of replacements) {
    if ('rawItem' in item) {
      rawReplacements.set(
        item.rawItem as AgentInputItem,
        replacement && 'rawItem' in replacement
          ? (replacement.rawItem as AgentInputItem)
          : undefined,
      );
    }
  }
  for (const [index, item] of (responseOutput ?? []).entries()) {
    rawReplacements.set(item, canonicalResponseOutput[index]);
  }
  const replace = (items: RunItem[]): RunItem[] =>
    items.flatMap((item) => {
      if (!replacements.has(item)) return [item];
      const replacement = replacements.get(item);
      return replacement ? [replacement] : [];
    });
  state._generatedItems = replace(state._generatedItems);
  if (state._lastProcessedResponse) {
    const processed = state._lastProcessedResponse;
    processed.newItems = replace(processed.newItems);
    const replaceToolActions = <T extends { toolCall: AgentInputItem }>(
      actions: T[] | undefined,
      allowRestoredCurrentPosition = false,
    ): T[] | undefined =>
      actions?.flatMap((action, index) => {
        const currentIndex =
          index - (actions.length - canonicalResponseOutput.length);
        if (
          !rawReplacements.has(action.toolCall) &&
          allowRestoredCurrentPosition &&
          state._serializedCurrentStep !== undefined &&
          state._serializedCurrentStep === state._currentStep &&
          action.toolCall.type === 'function_call' &&
          currentIndex >= 0 &&
          canonicalResponseOutput[currentIndex] &&
          JSON.stringify(buildCanonicalFunctionCall(action.toolCall)) ===
            JSON.stringify(canonicalResponseOutput[currentIndex])
        ) {
          rawReplacements.set(
            action.toolCall,
            canonicalResponseOutput[currentIndex],
          );
        }
        if (!rawReplacements.has(action.toolCall)) return [action];
        const replacement = rawReplacements.get(action.toolCall);
        if (!replacement || replacement.type !== action.toolCall.type)
          return [];
        action.toolCall = replacement;
        return [action];
      });
    if (processed.functions) {
      processed.functions = replaceToolActions(processed.functions, true)!;
    }
    if (processed.handoffs) {
      processed.handoffs = replaceToolActions(processed.handoffs)!;
    }
    if (processed.functionToolsNotFound) {
      processed.functionToolsNotFound = replaceToolActions(
        processed.functionToolsNotFound,
      );
    }
    if (processed.computerActions) {
      processed.computerActions = replaceToolActions(
        processed.computerActions,
      )!;
    }
    if (processed.shellActions) {
      processed.shellActions = replaceToolActions(processed.shellActions)!;
    }
    if (processed.applyPatchActions) {
      processed.applyPatchActions = replaceToolActions(
        processed.applyPatchActions,
      )!;
    }
  }
  for (const [agent, invocations] of state._completedToolInvocationEvidence) {
    for (const [callId, evidence] of invocations) {
      const items = replace(evidence.items);
      if (items.length !== 2) {
        invocations.delete(callId);
        state._completedToolInvocations.get(agent)?.delete(callId);
      } else {
        evidence.items = items as [RunItem, RunItem];
      }
    }
  }
}

function replaceCurrentResponse(
  state: RunState<any, any>,
  response: BlockedModelResponse,
  output: AgentInputItem[],
): void {
  const replacement = cloneBlockedResponse(response, output);
  let replacedResponse = false;
  state._modelResponses = state._modelResponses.map((candidate) => {
    if (candidate !== response) return candidate;
    replacedResponse = true;
    return replacement;
  });
  if (
    !replacedResponse &&
    state._serializedCurrentStep !== undefined &&
    state._serializedCurrentStep === state._currentStep &&
    state._modelResponses.length > 0
  ) {
    const archivedResponse = state._modelResponses.at(-1);
    try {
      if (
        archivedResponse &&
        JSON.stringify(getResponseOutput(archivedResponse)) ===
          JSON.stringify(getResponseOutput(response))
      ) {
        state._modelResponses[state._modelResponses.length - 1] = replacement;
      }
    } catch {
      // An unrelated or unreadable archived response is not current ownership.
    }
  }
  if (state._lastTurnResponse === response)
    state._lastTurnResponse = replacement;
}

function markBlockedState(
  state: RunState<any, any>,
  blockedMessage: string,
): void {
  if (state._currentStep?.type === 'next_step_final_output') {
    state._currentStep.output = blockedMessage;
  }
  invalidateOutputItemNormalization(state._generatedItems);
  if (state._lastProcessedResponse) {
    invalidateOutputItemNormalization(state._lastProcessedResponse.newItems);
  }
}

/** Replaces a rejected function response with allowlisted replay-safe values. */
export function redactBlockedResponseToolOutputs(
  state: RunState<any, any>,
  blockedMessage = OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
): boolean {
  const response = currentResponse(state);
  const responseOutput = getResponseOutput(response);
  const selection = currentRunItemSelection(state, responseOutput ?? []);
  const plan =
    response && responseOutput
      ? buildCurrentFunctionPairPlan(
          state,
          responseOutput,
          selection,
          blockedMessage,
        )
      : undefined;

  if (!plan) {
    const replacements = new Map<RunItem, RunItem | undefined>();
    for (const item of selection.aliases) replacements.set(item, undefined);
    replaceRunItems(state, replacements, responseOutput, []);
    if (response) replaceCurrentResponse(state, response, []);
    markBlockedState(state, blockedMessage);
    return selection.aliases.length > 0 || response !== undefined;
  }

  replaceRunItems(
    state,
    plan.replacements,
    responseOutput,
    plan.responseOutput,
  );
  replaceCurrentResponse(state, response!, plan.responseOutput);
  markBlockedState(state, blockedMessage);
  return plan.replacements.size > 0 || plan.responseOutput.length > 0;
}

export function getBlockedOutputSessionSnapshotRunItems(
  state: RunState<any, any>,
): RunItem[] {
  const responseOutput = getResponseOutput(currentResponse(state));
  if (!responseOutput) return [];
  const selection = currentRunItemSelection(state, responseOutput);
  const blockedMessage =
    state._currentStep?.type === 'next_step_final_output' &&
    typeof state._currentStep.output === 'string' &&
    state._currentStep.output.length > 0
      ? state._currentStep.output
      : OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT;
  const plan = buildCurrentFunctionPairPlan(
    state,
    responseOutput,
    selection,
    blockedMessage,
  );
  return plan?.sanitizedItems ?? [];
}

export function isCanonicalBlockedOutputPayload(item: AgentInputItem): boolean {
  return isCanonicalBlockedOutputPayloadForMessage(
    item,
    OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
  );
}

function isCanonicalBlockedOutputPayloadForMessage(
  item: AgentInputItem,
  blockedMessage: string,
): boolean {
  if (item?.type !== 'function_call_result') return false;
  try {
    return (
      JSON.stringify(item) ===
      JSON.stringify(buildBlockedToolOutputRawItem(item, blockedMessage))
    );
  } catch {
    return false;
  }
}

/** Returns a custom blocked message only when the restored response owns its canonical payload. */
function getCanonicalSerializedOutputGuardrailBlockedMessage(
  state: RunState<any, any>,
): string | undefined {
  if (
    state._serializedCurrentStep !== state._currentStep ||
    state._currentStep?.type !== 'next_step_final_output' ||
    typeof state._currentStep.output !== 'string' ||
    state._currentStep.output.length === 0 ||
    state._currentStep.output === OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT
  ) {
    return undefined;
  }

  const blockedMessage = state._currentStep.output;
  const responseOutput = getResponseOutput(currentResponse(state));
  if (!responseOutput) return undefined;
  const selection = currentRunItemSelection(state, responseOutput);
  const plan = buildCurrentFunctionPairPlan(
    state,
    responseOutput,
    selection,
    blockedMessage,
  );
  if (
    !plan ||
    JSON.stringify(responseOutput) !== JSON.stringify(plan.responseOutput)
  ) {
    return undefined;
  }

  for (const [item, canonicalItem] of plan.replacements) {
    if (
      item instanceof RunToolCallItem &&
      canonicalItem instanceof RunToolCallItem
    ) {
      if (
        JSON.stringify(item.rawItem) !== JSON.stringify(canonicalItem.rawItem)
      ) {
        return undefined;
      }
      continue;
    }
    if (
      item instanceof RunToolCallOutputItem &&
      canonicalItem instanceof RunToolCallOutputItem
    ) {
      if (
        item.output !== blockedMessage ||
        item.customData !== undefined ||
        !isCanonicalBlockedOutputPayloadForMessage(item.rawItem, blockedMessage)
      ) {
        return undefined;
      }
      continue;
    }
    return undefined;
  }

  return blockedMessage;
}

/** Neutralizes a canonical restored placeholder without trusting serialized guardrail identity. */
export function normalizeSerializedOutputGuardrailBlockedMessage(
  state: RunState<any, any>,
): void {
  const blockedMessage =
    getCanonicalSerializedOutputGuardrailBlockedMessage(state);
  if (
    !blockedMessage ||
    !state._outputGuardrailResults.some(
      (result) =>
        result.agent === state._currentAgent &&
        result.agentOutput === blockedMessage &&
        result.output.tripwireTriggered === true &&
        result.output.outputInfo === undefined,
    )
  ) {
    return;
  }
  const ownedResults = getSerializedOutputGuardrailResults(
    state,
    blockedMessage,
  );
  // A saved verdict only identifies data to neutralize; current guards must rerun.
  redactBlockedResponseToolOutputs(state);
  replaceSanitizedOutputGuardrailMessages(
    state,
    ownedResults,
    OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
  );
}

export function hasOutputBearingApprovalCheckpoint(
  state: RunState<any, any>,
): boolean {
  const responseOutput = getResponseOutput(currentResponse(state));
  if (!responseOutput) return true;
  if (responseOutput.some((item) => item.type !== 'function_call')) return true;
  const selection = currentRunItemSelection(state, responseOutput);
  if (!selection.proven) return true;
  return selection.primary.some(
    (item) =>
      item instanceof RunToolCallOutputItem ||
      (item instanceof RunToolCallItem &&
        item.rawItem.type === 'hosted_tool_call'),
  );
}
