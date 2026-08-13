import { RunItem } from '../items';
import { UserError } from '../errors';
import { getToolSearchProviderCallId } from '../tooling';
import { AgentInputItem, AgentOutputItem } from '../types';
import * as protocol from '../types/protocol';
import { serializeBinary } from '../utils/binary';
import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationForResult,
  getToolResultCorrelationKey,
  getSimpleToolResultTypeForCall,
  isSimpleToolResultType,
  type ToolResultCorrelation,
} from './toolResultCorrelation';

export type AgentInputItemPool = Map<string, AgentInputItem[]>;

export class CompactionItemValidationError extends UserError {}

// Normalizes user-provided input into the structure the model expects. Strings become user messages,
// arrays are kept as-is so downstream loops can treat both scenarios uniformly.
export function toAgentInputList(
  originalInput: string | AgentInputItem[],
): AgentInputItem[] {
  if (typeof originalInput === 'string') {
    return [{ type: 'message', role: 'user', content: originalInput }];
  }

  return [...originalInput];
}

export function assertValidCompactionItems(
  items: readonly AgentInputItem[],
): void {
  for (const item of items) {
    if (
      item.type === 'compaction' &&
      !protocol.CompactionItem.safeParse(item).success
    ) {
      throw new CompactionItemValidationError(
        'Compaction item missing encrypted_content',
      );
    }
  }
}

export function getAgentInputItemKey(item: AgentInputItem): string {
  return JSON.stringify(item, agentInputSerializationReplacer);
}

export function buildAgentInputPool(
  items: AgentInputItem[],
): AgentInputItemPool {
  const pool: AgentInputItemPool = new Map();
  for (const item of items) {
    const key = getAgentInputItemKey(item);
    const existing = pool.get(key);
    if (existing) {
      existing.push(item);
    } else {
      pool.set(key, [item]);
    }
  }
  return pool;
}

export function takeAgentInputFromPool(
  pool: AgentInputItemPool,
  key: string,
): AgentInputItem | undefined {
  const candidates = pool.get(key);
  if (!candidates || candidates.length === 0) {
    return undefined;
  }
  const [first] = candidates;
  candidates.shift();
  if (candidates.length === 0) {
    pool.delete(key);
  }
  return first;
}

export function removeAgentInputFromPool(
  pool: AgentInputItemPool,
  item: AgentInputItem,
): boolean {
  const key = getAgentInputItemKey(item);
  const candidates = pool.get(key);
  if (!candidates || candidates.length === 0) {
    return false;
  }
  const index = candidates.findIndex((candidate) => candidate === item);
  if (index === -1) {
    return false;
  }
  candidates.splice(index, 1);
  if (candidates.length === 0) {
    pool.delete(key);
  }
  return true;
}

function getAgentInputItemDeduplicationKey(
  item: AgentInputItem,
): string | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const candidate = item as {
    id?: unknown;
    role?: unknown;
    type?: unknown;
  };
  const itemType = candidate.type;
  if (typeof candidate.role === 'string' || itemType === 'message') {
    return undefined;
  }
  if (typeof itemType !== 'string') {
    return undefined;
  }
  if (itemType === 'tool_search_call' || itemType === 'tool_search_output') {
    const callId = getToolSearchProviderCallId(item);
    if (callId) {
      return JSON.stringify(['call', itemType, callId]);
    }
  }

  const callCorrelation = getToolResultCorrelationForCall(item);
  if (callCorrelation && callCorrelation.id.length > 0) {
    return JSON.stringify([
      'call',
      itemType,
      getToolResultCorrelationKey(callCorrelation),
    ]);
  }

  const resultCorrelation = getToolResultCorrelationForResult(item);
  if (resultCorrelation && resultCorrelation.id.length > 0) {
    return JSON.stringify([
      'result',
      itemType,
      getToolResultCorrelationKey(resultCorrelation),
    ]);
  }

  if (typeof candidate.id === 'string' && candidate.id.length > 0) {
    return JSON.stringify(['item', itemType, candidate.id]);
  }

  return undefined;
}

function isCausalPrecursorItem(item: AgentInputItem): boolean {
  if (!item || typeof item !== 'object') {
    return false;
  }
  return (
    item.type === 'tool_search_call' ||
    (item.type === 'hosted_tool_call' &&
      getToolResultCorrelationForResult(item) === undefined) ||
    item.type === 'compaction' ||
    item.type === 'reasoning' ||
    getToolResultCorrelationForCall(item) !== undefined
  );
}

/**
 * Deduplicates provider-identified items while preserving causal ordering.
 *
 * The latest payload wins. Calls, compaction, reasoning, and approval requests stay at their
 * earliest occurrence so they cannot move behind a required follower; other identified items
 * stay at their latest occurrence so stale outputs are not moved earlier. Items without stable
 * provider identity, including ordinary messages, remain untouched.
 */
export function deduplicateAgentInputItemsPreferringLatest(
  items: AgentInputItem[],
): AgentInputItem[] {
  const latestByKey = new Map<string, AgentInputItem>();
  const anchorIndexByKey = new Map<string, number>();

  for (const [index, item] of items.entries()) {
    const key = getAgentInputItemDeduplicationKey(item);
    if (!key) {
      continue;
    }
    latestByKey.set(key, item);
    if (!anchorIndexByKey.has(key) || !isCausalPrecursorItem(item)) {
      anchorIndexByKey.set(key, index);
    }
  }

  const deduplicated: AgentInputItem[] = [];
  for (const [index, item] of items.entries()) {
    const key = getAgentInputItemDeduplicationKey(item);
    if (!key) {
      deduplicated.push(item);
    } else if (anchorIndexByKey.get(key) === index) {
      deduplicated.push(latestByKey.get(key) as AgentInputItem);
    }
  }
  return deduplicated;
}

export function agentInputSerializationReplacer(
  _key: string,
  value: unknown,
): unknown {
  const serialized = serializeBinary(value);
  if (serialized) {
    return serialized;
  }

  return value;
}

export type ReasoningItemIdPolicy = 'preserve' | 'omit';

// Keep each model-input normalization stable for one generated item so identity-preserving
// filters can reuse caches across turns without mutating the provider item.
const normalizedOutputItemByRunItem = new WeakMap<
  RunItem,
  Partial<Record<'preserve' | 'omit', AgentInputItem>>
>();

export function invalidateOutputItemNormalization(items: RunItem[]): void {
  for (const item of items) {
    normalizedOutputItemByRunItem.delete(item);
  }
}

function shouldOmitReasoningItemIds(
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): boolean {
  return reasoningItemIdPolicy === 'omit';
}

export function stripReasoningItemIdForPolicy(
  item: AgentInputItem,
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem {
  if (
    !shouldOmitReasoningItemIds(reasoningItemIdPolicy) ||
    !item ||
    typeof item !== 'object' ||
    item.type !== 'reasoning' ||
    !('id' in item)
  ) {
    return item;
  }

  const { id: _id, ...withoutId } = item as Record<string, unknown>;
  return withoutId as AgentInputItem;
}

// Extracts model-ready output items from run items, excluding approval placeholders.
export function extractOutputItemsFromRunItems(
  items: RunItem[],
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem[] {
  return items
    .filter((item) => item.type !== 'tool_approval_item')
    .map((item) => {
      const normalizationKey =
        item.type === 'reasoning_item' &&
        shouldOmitReasoningItemIds(reasoningItemIdPolicy)
          ? 'omit'
          : 'preserve';
      const cached =
        normalizedOutputItemByRunItem.get(item)?.[normalizationKey];
      if (cached) {
        return cached;
      }
      const withoutNullStatusItem = withoutNullStatus(
        item.rawItem as AgentInputItem,
      );
      const normalizedItem =
        normalizationKey === 'omit'
          ? stripReasoningItemIdForPolicy(
              withoutNullStatusItem,
              reasoningItemIdPolicy,
            )
          : withoutNullStatusItem;
      const cachedByPolicy = normalizedOutputItemByRunItem.get(item) ?? {};
      cachedByPolicy[normalizationKey] = normalizedItem;
      normalizedOutputItemByRunItem.set(item, cachedByPolicy);
      return normalizedItem;
    });
}

function withoutNullStatus(item: AgentInputItem): AgentInputItem {
  if (
    !item ||
    typeof item !== 'object' ||
    !('status' in item) ||
    (item as { status?: unknown }).status !== null
  ) {
    return item;
  }

  const { status: _status, ...withoutStatus } = item as Record<string, unknown>;
  return withoutStatus as AgentInputItem;
}

function collectCompletedCallIdsByResultType(
  items: AgentInputItem[],
): Map<string, Set<string>> {
  const completed = new Map<string, Set<string>>();

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const type = (item as { type?: unknown }).type;
    const callId = (item as { callId?: unknown }).callId;
    if (typeof type !== 'string' || typeof callId !== 'string') {
      continue;
    }
    if (!isSimpleToolResultType(type)) {
      continue;
    }
    const existing = completed.get(type);
    if (existing) {
      existing.add(callId);
    } else {
      completed.set(type, new Set([callId]));
    }
  }

  return completed;
}

function collectProgramCallIds(items: AgentInputItem[]): Set<string> {
  const callIds = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== 'object' || item.type !== 'program') {
      continue;
    }
    if (typeof item.callId === 'string') {
      callIds.add(item.callId);
    }
  }

  return callIds;
}

function isPendingHostedShellCall(item: AgentInputItem): boolean {
  if (!item || typeof item !== 'object' || item.type !== 'shell_call') {
    return false;
  }

  const status = (item as { status?: unknown }).status;
  return status === undefined || status === 'in_progress';
}

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

function getProgramOwnedCorrelationKey(
  programCallId: string,
  correlation: ToolResultCorrelation | undefined,
): string | undefined {
  return correlation
    ? JSON.stringify([programCallId, getToolResultCorrelationKey(correlation)])
    : undefined;
}

function collectProgramOwnedCallKeys(items: AgentInputItem[]): Set<string> {
  const callKeys = new Set<string>();

  for (const item of items) {
    const programCallId = getProgramCallerId(item);
    if (!programCallId) {
      continue;
    }
    const key = getProgramOwnedCorrelationKey(
      programCallId,
      getToolResultCorrelationForCall(item),
    );
    if (key) {
      callKeys.add(key);
    }
  }

  return callKeys;
}

function hasRetainedProgramOwnedItem(
  items: AgentInputItem[],
  programCallId: string,
  pruningIndexes?: Set<number>,
): boolean {
  const retainedCallKeys = new Set<string>();
  const retainedResultKeys = new Set<string>();

  for (const [index, item] of items.entries()) {
    if (getProgramCallerId(item) !== programCallId) {
      continue;
    }

    const result = getToolResultCorrelationForResult(item);
    if (
      !(pruningIndexes?.has(index) ?? false) &&
      (isPendingHostedShellCall(item) ||
        (item &&
          typeof item === 'object' &&
          item.type === 'hosted_tool_call' &&
          !result))
    ) {
      return true;
    }

    const call = getToolResultCorrelationForCall(item);
    if (call) {
      retainedCallKeys.add(getToolResultCorrelationKey(call));
    }
    if (result) {
      retainedResultKeys.add(getToolResultCorrelationKey(result));
    }
  }

  return [...retainedCallKeys].some((key) => retainedResultKeys.has(key));
}

export function dropOrphanToolCalls(
  items: AgentInputItem[],
  options?: { pruningIndexes?: Set<number> },
): AgentInputItem[] {
  const pruningIndexes = options?.pruningIndexes;
  const completedByResultType = collectCompletedCallIdsByResultType(items);
  const programCallIds = collectProgramCallIds(items);
  const programOwnedCallKeys = collectProgramOwnedCallKeys(items);
  const droppedIndexes = new Set<number>();
  const activeProgramCallIds = new Set<string>();
  const orphanProgramCallIds = new Set<string>();

  for (const [index, item] of items.entries()) {
    if (pruningIndexes && !pruningIndexes.has(index)) {
      continue;
    }
    if (!item || typeof item !== 'object' || item.type !== 'program') {
      continue;
    }
    if (
      completedByResultType.get('program_output')?.has(item.callId) ??
      false
    ) {
      continue;
    }

    const hasRetainedOwnedItem = hasRetainedProgramOwnedItem(
      items,
      item.callId,
      pruningIndexes,
    );
    if (hasRetainedOwnedItem) {
      activeProgramCallIds.add(item.callId);
    } else {
      orphanProgramCallIds.add(item.callId);
    }
  }

  const filtered = items.filter((item, index) => {
    if (!item || typeof item !== 'object') {
      return true;
    }
    const programCallerId = getProgramCallerId(item);
    if (programCallerId) {
      if (
        !programCallIds.has(programCallerId) ||
        orphanProgramCallIds.has(programCallerId)
      ) {
        droppedIndexes.add(index);
        return false;
      }
      const resultKey = getProgramOwnedCorrelationKey(
        programCallerId,
        getToolResultCorrelationForResult(item),
      );
      if (resultKey && !programOwnedCallKeys.has(resultKey)) {
        droppedIndexes.add(index);
        return false;
      }
    }
    if (pruningIndexes && !pruningIndexes.has(index)) {
      return true;
    }
    const type = (item as { type?: unknown }).type;
    const callId = (item as { callId?: unknown }).callId;
    if (typeof type !== 'string' || typeof callId !== 'string') {
      return true;
    }
    if (type === 'program_output' && !programCallIds.has(callId)) {
      droppedIndexes.add(index);
      return false;
    }
    const resultType = getSimpleToolResultTypeForCall(type);
    if (!resultType) {
      return true;
    }
    if (isPendingHostedShellCall(item)) {
      return true;
    }
    if (type === 'program' && activeProgramCallIds.has(callId)) {
      return true;
    }
    if (completedByResultType.get(resultType)?.has(callId) ?? false) {
      return true;
    }
    droppedIndexes.add(index);
    return false;
  });

  if (droppedIndexes.size === 0) {
    return filtered;
  }

  return dropReasoningItemsPrecedingDroppedCalls(
    items,
    droppedIndexes,
    pruningIndexes,
  );
}

function dropReasoningItemsPrecedingDroppedCalls(
  items: AgentInputItem[],
  droppedIndexes: Set<number>,
  pruningIndexes?: Set<number>,
): AgentInputItem[] {
  const dropReasoning = new Set<number>();

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (pruningIndexes && !pruningIndexes.has(index)) {
      continue;
    }
    const item = items[index];
    if (
      !item ||
      typeof item !== 'object' ||
      (item as { type?: unknown }).type !== 'reasoning' ||
      droppedIndexes.has(index)
    ) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
      if (dropReasoning.has(nextIndex)) {
        continue;
      }
      const nextItem = items[nextIndex];
      if (
        nextItem &&
        typeof nextItem === 'object' &&
        (nextItem as { type?: unknown }).type === 'reasoning'
      ) {
        continue;
      }
      if (droppedIndexes.has(nextIndex)) {
        dropReasoning.add(index);
      }
      break;
    }
  }

  const excluded = new Set([...droppedIndexes, ...dropReasoning]);
  return items.filter((_item, index) => !excluded.has(index));
}

export function prepareModelInputItems(
  originalInput: string | AgentInputItem[],
  generatedItems: RunItem[],
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem[] {
  const callerItems = toAgentInputList(originalInput);
  const preparedGeneratedItems = getContinuationOutputItems(
    generatedItems,
    reasoningItemIdPolicy,
  );
  return trimToLatestCompaction([...callerItems, ...preparedGeneratedItems]);
}

function getContinuationOutputItems(
  generatedItems: RunItem[],
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem[] {
  const generatedOutputItems = trimToLatestCompaction(
    extractOutputItemsFromRunItems(generatedItems, reasoningItemIdPolicy),
  );
  return dropOrphanToolCalls(generatedOutputItems);
}

/**
 * Extracts generated output without including input admitted while resuming a run.
 */
export function getRunOutput(
  generatedItems: RunItem[],
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentOutputItem[] {
  return getContinuationOutputItems(
    generatedItems.filter((item) => item.type !== 'input_item'),
    reasoningItemIdPolicy,
  );
}

/**
 * Constructs the model input array for the current turn by combining the original turn input with
 * any new run items (excluding tool approval placeholders). This helps ensure that repeated calls
 * to the Responses API only send newly generated content.
 *
 * See: https://platform.openai.com/docs/guides/conversation-state?api-mode=responses.
 */
export function getTurnInput(
  originalInput: string | AgentInputItem[],
  generatedItems: RunItem[],
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem[] {
  const outputItems = getContinuationOutputItems(
    generatedItems,
    reasoningItemIdPolicy,
  );
  return trimToLatestCompaction([
    ...toAgentInputList(originalInput),
    ...outputItems,
  ]);
}

export function trimToLatestCompaction(
  items: AgentInputItem[],
): AgentInputItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === 'compaction') {
      return items.slice(index);
    }
  }
  return items;
}
