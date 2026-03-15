import { RunItem } from '../items';
import { AgentInputItem } from '../types';
import { serializeBinary } from '../utils/binary';

export type AgentInputItemPool = Map<string, AgentInputItem[]>;

const TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE = {
  function_call: 'function_call_result',
  computer_call: 'computer_call_result',
  shell_call: 'shell_call_output',
  apply_patch_call: 'apply_patch_call_output',
} as const;

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

// Extracts model-ready output items from run items, excluding approval placeholders.
export function extractOutputItemsFromRunItems(
  items: RunItem[],
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem[] {
  const omitReasoningItemIds = shouldOmitReasoningItemIds(
    reasoningItemIdPolicy,
  );
  return items
    .filter((item) => item.type !== 'tool_approval_item')
    .map((item) => {
      const rawItem = item.rawItem as AgentInputItem;
      if (!omitReasoningItemIds || item.type !== 'reasoning_item') {
        return rawItem;
      }
      if (!rawItem || typeof rawItem !== 'object' || !('id' in rawItem)) {
        return rawItem;
      }
      const { id: _id, ...withoutId } = rawItem as Record<string, unknown>;
      return withoutId as AgentInputItem;
    });
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

  return items.filter((item, index) => {
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
    return completedByResultType.get(resultType)?.has(callId) ?? false;
  });
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
  return [...callerItems, ...preparedGeneratedItems];
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
  return [...toAgentInputList(originalInput), ...outputItems];
}
