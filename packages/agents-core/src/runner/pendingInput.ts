import { UserError } from '../errors';
import { RunInputItem } from '../items';
import { RunState } from '../runState';
import type { AgentInputItem } from '../types';
import { getAgentInputItemKey } from './items';
import { mapOwnedInputItemsAfterContextProcessing } from './sessionPersistence';

type PendingInputPreparation = {
  turnInput: AgentInputItem[];
  sourceItems: (AgentInputItem | undefined)[];
  persistedItems: AgentInputItem[];
  sourceMatchKinds: Array<'identity' | 'content' | 'fallback' | 'injected'>;
};

/**
 * Resolves which staged occurrences reached the model after filtering.
 */
export function selectPendingInputForAdmission(
  pendingItems: RunInputItem[],
  preparation: PendingInputPreparation,
): RunInputItem[] {
  if (pendingItems.length === 0) {
    return [];
  }

  const pendingByRawItem = new Map<object, RunInputItem>();
  for (const item of pendingItems) {
    pendingByRawItem.set(item.rawItem, item);
  }

  for (const [index, sourceItem] of preparation.sourceItems.entries()) {
    if (
      sourceItem &&
      pendingByRawItem.has(sourceItem) &&
      preparation.sourceMatchKinds[index] === 'fallback'
    ) {
      throw new UserError(
        'callModelInputFilter cannot safely associate a reconstructed item with pending RunState input. Preserve the input item object, return an unchanged copy, or omit the pending item.',
      );
    }
  }

  const pendingKeys = new Set(
    pendingItems.map((item) => getAgentInputItemKey(item.rawItem)),
  );
  for (const key of pendingKeys) {
    const candidates = preparation.turnInput.filter(
      (item) => getAgentInputItemKey(item) === key,
    );
    const reconstructedMatches = preparation.sourceItems.flatMap(
      (sourceItem, index) =>
        sourceItem &&
        getAgentInputItemKey(sourceItem) === key &&
        preparation.sourceMatchKinds[index] === 'content'
          ? [sourceItem]
          : [],
    );
    const hasPendingCandidate = candidates.some((candidate) =>
      pendingByRawItem.has(candidate),
    );
    const hasNonPendingCandidate = candidates.some(
      (candidate) => !pendingByRawItem.has(candidate),
    );
    if (
      reconstructedMatches.length > 0 &&
      reconstructedMatches.length < candidates.length &&
      hasPendingCandidate &&
      hasNonPendingCandidate
    ) {
      throw new UserError(
        'callModelInputFilter cannot safely associate a reconstructed item with pending RunState input. Preserve the input item object, return an unchanged copy, or omit the pending item.',
      );
    }
  }

  const admitted: RunInputItem[] = [];
  const acceptedIds = new Set<string>();
  for (const [index, sourceItem] of preparation.sourceItems.entries()) {
    if (!sourceItem) {
      continue;
    }
    const pendingItem = pendingByRawItem.get(sourceItem);
    if (!pendingItem || acceptedIds.has(pendingItem.inputId)) {
      continue;
    }
    const persistedItem = preparation.persistedItems[index];
    if (!persistedItem) {
      continue;
    }
    acceptedIds.add(pendingItem.inputId);
    admitted.push(
      new RunInputItem(
        structuredClone(persistedItem),
        pendingItem.agent,
        pendingItem.inputId,
      ),
    );
  }
  return admitted;
}

/**
 * Preserves staged occurrence identity through sandbox capability processing.
 */
export function mapPendingInputAfterContextProcessing(
  pendingItems: RunInputItem[],
  preparedItems: AgentInputItem[],
  processedItems: AgentInputItem[],
): RunInputItem[] {
  if (pendingItems.length === 0 || preparedItems === processedItems) {
    return pendingItems;
  }
  return mapOwnedInputItemsAfterContextProcessing(
    preparedItems,
    processedItems,
    pendingItems.map((item) => item.rawItem),
  ).map(({ item, ownerIndex }) => {
    const pendingItem = pendingItems[ownerIndex]!;
    return new RunInputItem(item, pendingItem.agent, pendingItem.inputId);
  });
}

/**
 * Commits accepted occurrences to RunState and leaves omitted occurrences pending.
 */
export function commitPendingInput(
  state: RunState<any, any>,
  preparedItems: RunInputItem[],
  admittedItems: RunInputItem[],
  sourceItems: AgentInputItem[],
): void {
  if (preparedItems.length === 0) {
    return;
  }
  const admittedIds = new Set(admittedItems.map((item) => item.inputId));
  const sourceItemSet = new Set(sourceItems);
  const preparedQueueIsIntact = sourceItems.every(
    (item, index) => state._pendingInput[index] === item,
  );
  const newlyStagedItems = preparedQueueIsIntact
    ? state._pendingInput.slice(sourceItems.length)
    : state._pendingInput.filter((item) => !sourceItemSet.has(item));
  state._generatedItems.push(...admittedItems);
  state._pendingInput = [
    ...(preparedQueueIsIntact
      ? preparedItems
          .filter((item) => !admittedIds.has(item.inputId))
          .map((item) => structuredClone(item.rawItem))
      : []),
    ...structuredClone(newlyStagedItems),
  ];
}

/**
 * Returns whether a committed input occurrence still belongs to the unpersisted
 * suffix for the current local-session turn.
 */
export function hasUnpersistedRunInput(state: RunState<any, any>): boolean {
  return state._generatedItems
    .slice(state._currentTurnPersistedItemCount)
    .some((item) => item instanceof RunInputItem);
}
