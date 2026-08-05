import { UserError } from '../errors';
import {
  RunHandoffOutputItem,
  RunItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../items';
import {
  getToolCallName,
  getToolCallNamespace,
  getToolCallQualifiedName,
} from '../toolIdentity';
import {
  getToolSearchExecution,
  getToolSearchMatchKey,
  getToolSearchOutputReplacementKey,
  getToolSearchProviderCallId,
} from '../tooling';
import { AgentInputItem } from '../types';
import type { ToolSearchOutputItem } from '../types/protocol';
import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationForResult,
  getToolResultCorrelationKey,
} from './toolResultCorrelation';
import { addLoadedToolNamesFromToolSearchOutput } from './toolSearch';

type BlockedPairKind = 'tool' | 'handoff';

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
}): RunItemPersistencePlan {
  const {
    items,
    alreadyPersistedCount,
    currentDeferredIndexes,
    outputBlocked,
    canUseHistoryTransactions,
  } = options;
  const newRunItemIndexes = Array.from(
    { length: Math.max(0, items.length - alreadyPersistedCount) },
    (_value, offset) => alreadyPersistedCount + offset,
  );

  if (outputBlocked) {
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
