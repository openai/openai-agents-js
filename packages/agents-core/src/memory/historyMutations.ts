import type { AgentInputItem } from '../types';
import type { SessionHistoryMutation } from './session';

/**
 * Applies persisted-history mutations and returns a new canonical item list.
 */
export function applySessionHistoryMutations(
  items: AgentInputItem[],
  mutations: SessionHistoryMutation[],
): AgentInputItem[] {
  let nextItems = items.map((item) => structuredClone(item));

  for (const mutation of mutations) {
    if (mutation.type === 'replace_function_call') {
      nextItems = applyReplaceFunctionCallMutation(nextItems, mutation);
    }
  }

  return nextItems;
}

function applyReplaceFunctionCallMutation(
  items: AgentInputItem[],
  mutation: Extract<SessionHistoryMutation, { type: 'replace_function_call' }>,
): AgentInputItem[] {
  const replacement = structuredClone(mutation.replacement);
  const nextItems: AgentInputItem[] = [];
  let keptReplacement = false;

  for (const item of items) {
    if (item.type === 'function_call' && item.callId === mutation.callId) {
      if (!keptReplacement) {
        nextItems.push(replacement);
        keptReplacement = true;
      }
      continue;
    }

    nextItems.push(item);
  }

  return nextItems;
}
