import { RunItem } from '../items';
import { AgentInputItem } from '../types';
import { serializeBinary } from '../utils/binary';

export type AgentInputItemPool = Map<string, AgentInputItem[]>;

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

// Extracts model-ready output items from run items, excluding approval placeholders.
export function extractOutputItemsFromRunItems(
  items: RunItem[],
): AgentInputItem[] {
  return items
    .filter((item) => item.type !== 'tool_approval_item')
    .map((item) => item.rawItem as AgentInputItem);
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
): AgentInputItem[] {
  const outputItems = extractOutputItemsFromRunItems(generatedItems);
  return [...toAgentInputList(originalInput), ...outputItems];
}
