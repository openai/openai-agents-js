import { RunItem } from '../items';
import { AgentInputItem } from '../types';
import * as protocol from '../types/protocol';
import { serializeBinary } from '../utils/binary';
import { getToolSearchOutputReplacementKey } from '../utils';

export type AgentInputItemPool = Map<string, AgentInputItem[]>;

const TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE = {
  function_call: 'function_call_result',
  computer_call: 'computer_call_result',
  shell_call: 'shell_call_output',
  apply_patch_call: 'apply_patch_call_output',
} as const;

const COMPACTION_TOOL_SEARCH_STATE_KEY = '__openai_agents_tool_search_state';

type CompactionToolSearchStateEntry = {
  agentName?: string;
  output: protocol.ToolSearchOutputItem;
};

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
      const rawItem = withoutNullStatus(item.rawItem as AgentInputItem);
      if (item.type !== 'reasoning_item') {
        return rawItem;
      }
      return stripReasoningItemIdForPolicy(rawItem, reasoningItemIdPolicy);
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
    if (
      !Object.values(TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE).includes(type as any)
    ) {
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

function isPendingHostedShellCall(item: AgentInputItem): boolean {
  if (!item || typeof item !== 'object' || item.type !== 'shell_call') {
    return false;
  }

  const status = (item as { status?: unknown }).status;
  return status === undefined || status === 'in_progress';
}

export function dropOrphanToolCalls(
  items: AgentInputItem[],
  options?: { pruningIndexes?: Set<number> },
): AgentInputItem[] {
  const pruningIndexes = options?.pruningIndexes;
  const completedByResultType = collectCompletedCallIdsByResultType(items);
  const droppedIndexes = new Set<number>();

  const filtered = items.filter((item, index) => {
    if (pruningIndexes && !pruningIndexes.has(index)) {
      return true;
    }
    if (!item || typeof item !== 'object') {
      return true;
    }
    const type = (item as { type?: unknown }).type;
    const callId = (item as { callId?: unknown }).callId;
    if (typeof type !== 'string' || typeof callId !== 'string') {
      return true;
    }
    const resultType =
      TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE[
        type as keyof typeof TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE
      ];
    if (!resultType) {
      return true;
    }
    if (isPendingHostedShellCall(item)) {
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
  return combineWithGeneratedCompaction(
    callerItems,
    preparedGeneratedItems,
    generatedItems,
  );
}

function getContinuationOutputItems(
  generatedItems: RunItem[],
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem[] {
  const generatedOutputItems = extractOutputItemsFromRunItems(
    generatedItems,
    reasoningItemIdPolicy,
  );
  return dropOrphanToolCalls(generatedOutputItems);
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
  return combineWithGeneratedCompaction(
    toAgentInputList(originalInput),
    outputItems,
    generatedItems,
  );
}

export function combineWithGeneratedCompaction(
  callerItems: AgentInputItem[],
  generatedItems: AgentInputItem[],
  generatedRunItems: RunItem[],
): AgentInputItem[] {
  for (let index = generatedItems.length - 1; index >= 0; index -= 1) {
    if (generatedItems[index]?.type === 'compaction') {
      const compactedItems = generatedItems.slice(index);
      const toolSearchState = compactToolSearchStateEntries([
        ...collectToolSearchStateFromInputItems(callerItems),
        ...collectToolSearchStateFromRunItems(generatedRunItems),
      ]);
      if (toolSearchState.length === 0) {
        return compactedItems;
      }

      const compaction = compactedItems[0] as protocol.CompactionItem;
      return [
        {
          ...compaction,
          providerData: {
            ...compaction.providerData,
            [COMPACTION_TOOL_SEARCH_STATE_KEY]: toolSearchState,
          },
        },
        ...compactedItems.slice(1),
      ];
    }
  }
  return [...callerItems, ...generatedItems];
}

export function getCompactionToolSearchOutputs(
  item: AgentInputItem,
  agentName: string,
): protocol.ToolSearchOutputItem[] {
  if (item.type !== 'compaction') {
    return [];
  }

  return getCompactionToolSearchStateEntries(item)
    .filter(
      (entry) => entry.agentName === undefined || entry.agentName === agentName,
    )
    .map((entry) => entry.output);
}

function collectToolSearchStateFromInputItems(
  items: AgentInputItem[],
): CompactionToolSearchStateEntry[] {
  const entries: CompactionToolSearchStateEntry[] = [];
  for (const item of items) {
    if (item.type === 'tool_search_output') {
      entries.push({ output: item });
    } else if (item.type === 'compaction') {
      replaceWithCompactionToolSearchState(entries, item);
    }
  }
  return entries;
}

function collectToolSearchStateFromRunItems(
  items: RunItem[],
): CompactionToolSearchStateEntry[] {
  const entries: CompactionToolSearchStateEntry[] = [];
  let latestCompactionIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === 'compaction_item') {
      latestCompactionIndex = index;
      break;
    }
  }

  for (const item of items.slice(0, latestCompactionIndex + 1)) {
    if (item.type === 'tool_search_output_item') {
      entries.push({
        agentName: item.agent.name,
        output: item.rawItem,
      });
    } else if (item.type === 'compaction_item') {
      replaceWithCompactionToolSearchState(entries, item.rawItem);
    }
  }
  return entries;
}

function replaceWithCompactionToolSearchState(
  entries: CompactionToolSearchStateEntry[],
  item: protocol.CompactionItem,
): void {
  const compactedEntries = getCompactionToolSearchStateEntries(item);
  if (compactedEntries.length === 0) {
    return;
  }
  entries.splice(0, entries.length, ...compactedEntries);
}

function getCompactionToolSearchStateEntries(
  item: protocol.CompactionItem,
): CompactionToolSearchStateEntry[] {
  const storedState = item.providerData?.[COMPACTION_TOOL_SEARCH_STATE_KEY];
  if (!Array.isArray(storedState)) {
    return [];
  }

  const entries: CompactionToolSearchStateEntry[] = [];
  for (const value of storedState) {
    if (!value || typeof value !== 'object' || !('output' in value)) {
      continue;
    }
    const agentName = (value as { agentName?: unknown }).agentName;
    if (agentName !== undefined && typeof agentName !== 'string') {
      continue;
    }
    const parsedOutput = protocol.ToolSearchOutputItem.safeParse(
      (value as { output: unknown }).output,
    );
    if (!parsedOutput.success) {
      continue;
    }
    entries.push({
      ...(agentName === undefined ? {} : { agentName }),
      output: parsedOutput.data,
    });
  }
  return entries;
}

function compactToolSearchStateEntries(
  entries: CompactionToolSearchStateEntry[],
): CompactionToolSearchStateEntry[] {
  const compacted: Array<CompactionToolSearchStateEntry | undefined> = [];
  const replacementIndexes = new Map<string, number>();

  for (const entry of entries) {
    const replacementKey = getToolSearchOutputReplacementKey(entry.output);
    if (replacementKey) {
      const scopedKey = JSON.stringify([
        entry.agentName ?? null,
        replacementKey,
      ]);
      const previousIndex = replacementIndexes.get(scopedKey);
      if (previousIndex !== undefined) {
        compacted[previousIndex] = undefined;
      }
      replacementIndexes.set(scopedKey, compacted.length);
    }
    compacted.push(entry);
  }

  return compacted.filter(
    (entry): entry is CompactionToolSearchStateEntry => entry !== undefined,
  );
}
