import { UserError } from '../errors';
import {
  isOpenAIResponsesCompactionAwareSession,
  type OpenAIResponsesCompactionArgs,
  type Session,
  type SessionInputCallback,
} from '../memory/session';
import { RunResult, StreamedRunResult } from '../result';
import { RunState } from '../runState';
import { RunItem } from '../items';
import { AgentInputItem } from '../types';
import { Usage } from '../usage';
import { encodeUint8ArrayToBase64 } from '../utils/base64';
import { toUint8ArrayFromBinary } from '../utils/binary';
import {
  assertValidCompactionItems,
  buildAgentInputPool,
  deduplicateAgentInputItemsPreferringLatest,
  dropOrphanToolCalls,
  extractOutputItemsFromRunItems,
  toAgentInputList,
  getAgentInputItemKey,
  removeAgentInputFromPool,
  stripReasoningItemIdForPolicy,
  trimToLatestCompaction,
  type ReasoningItemIdPolicy,
} from './items';
import logger, { logModelAndToolActionWarning } from '../logger';
import { getRunStateUsageRecorder } from './usageTracking';

export type PreparedInputWithSessionResult = {
  preparedInput: string | AgentInputItem[];
  sessionItems?: AgentInputItem[];
};

export type SessionPersistenceOptions = {
  runCompaction?: boolean;
  compactionMode?: OpenAIResponsesCompactionArgs['compactionMode'];
};

class SessionReconciliationRecoveryError extends Error {
  readonly errors: readonly [unknown, unknown];
  readonly cause: unknown;

  constructor(
    readonly primaryError: unknown,
    readonly rollbackError: unknown,
  ) {
    super(
      'Failed to reconcile legacy compaction session history and restore the previous session contents.',
    );
    this.name = 'SessionReconciliationRecoveryError';
    this.errors = [primaryError, rollbackError];
    this.cause = primaryError;
  }
}

type PersistedInputOccurrence =
  { type: 'owned'; index: number } | { type: 'injected'; item: AgentInputItem };

type PreparedOwnedSource = {
  item: AgentInputItem;
  ownerIndex: number;
};

export type SessionPersistenceTracker = {
  setPreparedItems: (
    items?: AgentInputItem[],
    preparedInput?: string | AgentInputItem[],
  ) => void;
  setPreparedTurnItems: (
    preparedItems: AgentInputItem[],
    processedItems: AgentInputItem[],
  ) => void;
  recordTurnItems: (
    sourceItems: (AgentInputItem | undefined)[],
    filteredItems?: AgentInputItem[],
  ) => void;
  getItemsForPersistence: () => AgentInputItem[] | undefined;
  buildPersistInputOnce: (
    serverManagesConversation: boolean,
  ) => (() => Promise<void>) | undefined;
};

export function createSessionPersistenceTracker(options: {
  session?: Session;
  hasCallModelInputFilter: boolean;
  persistInput?: typeof saveStreamInputToSession;
  resumingFromState?: boolean;
}): SessionPersistenceTracker | undefined {
  const { session } = options;
  if (!session) {
    return undefined;
  }

  class SessionPersistenceTrackerImpl implements SessionPersistenceTracker {
    private readonly session?: Session;
    private readonly hasCallModelInputFilter: boolean;
    private readonly persistInput?: typeof saveStreamInputToSession;
    private originalSnapshot: AgentInputItem[] | undefined;
    private filteredSnapshot: AgentInputItem[] | undefined;
    private preparedSources: PreparedOwnedSource[] | undefined;
    private preparedSourceIndexes: number[] | undefined;
    private ownedFilteredItems = new Map<number, AgentInputItem>();
    private persistedInputOrder: PersistedInputOccurrence[] = [];
    private persistedInput = false;

    constructor() {
      this.session = options.session;
      this.hasCallModelInputFilter = options.hasCallModelInputFilter;
      this.persistInput = options.persistInput;
      this.originalSnapshot = options.resumingFromState ? [] : undefined;
      this.filteredSnapshot = undefined;
      this.preparedSources = options.resumingFromState ? [] : undefined;
      this.preparedSourceIndexes = options.resumingFromState ? [] : undefined;
    }

    setPreparedItems = (
      items?: AgentInputItem[],
      preparedInput?: string | AgentInputItem[],
    ) => {
      const sessionItems = items ?? [];
      this.originalSnapshot = cloneItems(
        deduplicateAgentInputItemsPreferringLatest(sessionItems),
      );
      if (Array.isArray(preparedInput)) {
        this.preparedSources = undefined;
        this.preparedSourceIndexes = findOwnedItemIndexes(
          preparedInput,
          sessionItems,
        );
      } else {
        this.preparedSources = sessionItems.map((item, ownerIndex) => ({
          item,
          ownerIndex,
        }));
        this.preparedSourceIndexes = undefined;
      }
      this.ownedFilteredItems.clear();
      this.persistedInputOrder = [];
    };

    setPreparedTurnItems = (
      preparedItems: AgentInputItem[],
      processedItems: AgentInputItem[],
    ) => {
      if (!this.preparedSourceIndexes) {
        return;
      }
      this.preparedSources = mapPreparedSourcesAfterContextProcessing(
        preparedItems,
        processedItems,
        this.preparedSourceIndexes,
      );
    };

    recordTurnItems = (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => {
      if (filteredItems !== undefined) {
        if (!this.preparedSources) {
          this.filteredSnapshot = cloneItems(filteredItems);
          return;
        }
        const next = reconcilePersistableFilteredItems({
          preparedSources: this.preparedSources,
          sourceItems,
          filteredItems,
          ownedFilteredItems: this.ownedFilteredItems,
          persistedInputOrder: this.persistedInputOrder,
        });
        this.ownedFilteredItems = next.ownedFilteredItems;
        this.persistedInputOrder = next.persistedInputOrder;
        this.filteredSnapshot = next.filteredSnapshot;
        return;
      }

      this.filteredSnapshot = buildSnapshotForUnfilteredItems({
        preparedSourceCounts: this.preparedSources
          ? countItemReferences(
              this.preparedSources.map((source) => source.item),
            )
          : undefined,
        sourceItems,
        existingSnapshot: this.filteredSnapshot,
      });
    };

    getItemsForPersistence = () => {
      if (this.filteredSnapshot !== undefined) {
        return this.filteredSnapshot;
      }
      if (this.hasCallModelInputFilter) {
        return undefined;
      }
      return this.originalSnapshot;
    };

    buildPersistInputOnce = (serverManagesConversation: boolean) => {
      if (!this.session || serverManagesConversation) {
        return undefined;
      }
      const persistInput = this.persistInput ?? saveStreamInputToSession;
      return async () => {
        if (this.persistedInput) {
          return;
        }
        const itemsToPersist = this.getItemsForPersistence();
        if (!itemsToPersist || itemsToPersist.length === 0) {
          return;
        }
        this.persistedInput = true;
        await persistInput(this.session, itemsToPersist);
      };
    };
  }

  return new SessionPersistenceTrackerImpl();
}

function cloneItems(items: AgentInputItem[]): AgentInputItem[] {
  return items.map((item) => structuredClone(item));
}

function countItemReferences(
  items: AgentInputItem[],
): Map<AgentInputItem, number> {
  const counts = new Map<AgentInputItem, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function findOwnedItemIndexes(
  preparedInput: AgentInputItem[],
  ownedItems: AgentInputItem[],
): number[] {
  const remaining = countItemReferences(ownedItems);
  const indexes: number[] = [];
  for (const [index, item] of preparedInput.entries()) {
    const count = remaining.get(item) ?? 0;
    if (count <= 0) {
      continue;
    }
    indexes.push(index);
    remaining.set(item, count - 1);
  }
  return indexes;
}

function mapPreparedSourcesAfterContextProcessing(
  preparedItems: AgentInputItem[],
  processedItems: AgentInputItem[],
  preparedSourceIndexes: number[],
): PreparedOwnedSource[] {
  const ownerIndexByPreparedIndex = new Map(
    preparedSourceIndexes.map((preparedIndex, ownerIndex) => [
      preparedIndex,
      ownerIndex,
    ]),
  );
  const preparedIndexesByReference = new Map<AgentInputItem, number[]>();
  const preparedIndexesByKey = new Map<string, number[]>();
  for (const [index, item] of preparedItems.entries()) {
    const referenceIndexes = preparedIndexesByReference.get(item) ?? [];
    referenceIndexes.push(index);
    preparedIndexesByReference.set(item, referenceIndexes);

    const key = getAgentInputItemKey(item);
    const keyIndexes = preparedIndexesByKey.get(key) ?? [];
    keyIndexes.push(index);
    preparedIndexesByKey.set(key, keyIndexes);
  }

  const mappedPreparedIndexes = new Array<number | undefined>(
    processedItems.length,
  );
  const usedPreparedIndexes = new Set<number>();
  const ambiguousKeys = new Set<string>();
  const ambiguousProcessedIndexes = new Set<number>();

  const mapOccurrences = <T>(
    processedIndexesByIdentity: Map<T, number[]>,
    preparedIndexesByIdentity: Map<T, number[]>,
  ) => {
    for (const [identity, processedIndexes] of processedIndexesByIdentity) {
      const availablePreparedIndexes = (
        preparedIndexesByIdentity.get(identity) ?? []
      ).filter((index) => !usedPreparedIndexes.has(index));
      const availableProcessedIndexes = processedIndexes.filter(
        (index) => mappedPreparedIndexes[index] === undefined,
      );

      for (
        let index = 0;
        index <
        Math.min(
          availableProcessedIndexes.length,
          availablePreparedIndexes.length,
        );
        index++
      ) {
        const processedIndex = availableProcessedIndexes[index];
        const preparedIndex = availablePreparedIndexes[index];
        if (processedIndex === undefined || preparedIndex === undefined) {
          continue;
        }
        mappedPreparedIndexes[processedIndex] = preparedIndex;
        usedPreparedIndexes.add(preparedIndex);
      }
    }
  };

  const processedIndexesByReference = new Map<AgentInputItem, number[]>();
  for (const [index, item] of processedItems.entries()) {
    const indexes = processedIndexesByReference.get(item) ?? [];
    indexes.push(index);
    processedIndexesByReference.set(item, indexes);
  }
  mapOccurrences(processedIndexesByReference, preparedIndexesByReference);
  const referenceMappedPreparedIndexes = new Set(usedPreparedIndexes);
  for (const [item, processedIndexes] of processedIndexesByReference) {
    const preparedIndexes = preparedIndexesByReference.get(item);
    if (preparedIndexes === undefined) {
      continue;
    }
    const preparedCount = preparedIndexes.length;
    for (const processedIndex of processedIndexes.slice(preparedCount)) {
      ambiguousKeys.add(getAgentInputItemKey(item));
      ambiguousProcessedIndexes.add(processedIndex);
    }
  }

  const processedIndexesByKey = new Map<string, number[]>();
  for (const [index, item] of processedItems.entries()) {
    if (
      mappedPreparedIndexes[index] !== undefined ||
      ambiguousProcessedIndexes.has(index)
    ) {
      continue;
    }
    const key = getAgentInputItemKey(item);
    const indexes = processedIndexesByKey.get(key) ?? [];
    indexes.push(index);
    processedIndexesByKey.set(key, indexes);
  }
  const availablePreparedCountByKey = new Map<string, number>();
  for (const [key, indexes] of preparedIndexesByKey) {
    availablePreparedCountByKey.set(
      key,
      indexes.filter((index) => !usedPreparedIndexes.has(index)).length,
    );
  }
  for (const [key, indexes] of processedIndexesByKey) {
    const availablePreparedCount = availablePreparedCountByKey.get(key) ?? 0;
    if (
      preparedIndexesByKey.has(key) &&
      indexes.length > availablePreparedCount
    ) {
      ambiguousKeys.add(key);
      indexes.forEach((index) => ambiguousProcessedIndexes.add(index));
    }
  }

  // Reserve unchanged positional clones before matching equal-content occurrences globally.
  // Otherwise, an earlier removed occurrence can steal a later clone's prepared position and
  // cause an injected replacement to inherit the clone's Session ownership. Equal-sized key
  // groups retain forward occurrence matching because unrelated insertions may shift the group.
  for (const [index, item] of processedItems.entries()) {
    const preparedItem = preparedItems[index];
    const key = getAgentInputItemKey(item);
    if (
      mappedPreparedIndexes[index] !== undefined ||
      ambiguousProcessedIndexes.has(index) ||
      preparedItem === undefined ||
      usedPreparedIndexes.has(index) ||
      key !== getAgentInputItemKey(preparedItem) ||
      (processedIndexesByKey.get(key)?.length ?? 0) >=
        (availablePreparedCountByKey.get(key) ?? 0)
    ) {
      continue;
    }
    mappedPreparedIndexes[index] = index;
    usedPreparedIndexes.add(index);
  }

  // Public capabilities may return clones. Resolve remaining occurrences against the complete
  // prepared sequence so callback reordering and equal-content history retain their ownership.
  const matchableProcessedIndexesByKey = new Map(
    [...processedIndexesByKey].filter(([, indexes]) =>
      indexes.every((index) => !ambiguousProcessedIndexes.has(index)),
    ),
  );
  mapOccurrences(matchableProcessedIndexesByKey, preparedIndexesByKey);

  const remainingProcessedIndexes = processedItems
    .map((_, index) => index)
    .filter(
      (index) =>
        mappedPreparedIndexes[index] === undefined &&
        !ambiguousProcessedIndexes.has(index),
    );
  const remainingPreparedIndexes = preparedItems
    .map((_, index) => index)
    .filter(
      (index) =>
        !usedPreparedIndexes.has(index) &&
        !ambiguousKeys.has(getAgentInputItemKey(preparedItems[index]!)),
    );

  // Preserve the explicitly supported whole-context single-item rewrite. Once any surrounding
  // occurrence exists, an unmatched item could instead be a deletion plus an injection, so leave
  // it unowned rather than assigning Session provenance from matching residual cardinality alone.
  if (
    preparedItems.length === 1 &&
    processedItems.length === 1 &&
    remainingProcessedIndexes.length === 1 &&
    remainingPreparedIndexes.length === 1
  ) {
    const processedIndex = remainingProcessedIndexes[0];
    const preparedIndex = remainingPreparedIndexes[0];
    if (processedIndex !== undefined && preparedIndex !== undefined) {
      mappedPreparedIndexes[processedIndex] = preparedIndex;
      usedPreparedIndexes.add(preparedIndex);
    }
  }

  const hasUnmatchedProcessedItem = remainingProcessedIndexes.some(
    (index) => mappedPreparedIndexes[index] === undefined,
  );
  const hasUnmatchedOwnedItem = remainingPreparedIndexes.some(
    (index) =>
      !usedPreparedIndexes.has(index) && ownerIndexByPreparedIndex.has(index),
  );
  const hasUnprovenOwnedClone = [...preparedIndexesByKey.values()].some(
    (indexes) =>
      indexes.some((index) => ownerIndexByPreparedIndex.has(index)) &&
      indexes.some((index) => !ownerIndexByPreparedIndex.has(index)) &&
      indexes.some(
        (index) =>
          ownerIndexByPreparedIndex.has(index) &&
          usedPreparedIndexes.has(index) &&
          !referenceMappedPreparedIndexes.has(index),
      ) &&
      indexes.some((index) => !usedPreparedIndexes.has(index)),
  );
  if (
    hasUnmatchedProcessedItem &&
    (hasUnmatchedOwnedItem || hasUnprovenOwnedClone)
  ) {
    throw new UserError(
      'Capability.processContext() cannot replace Session-owned input without preserving its identity. Use callModelInputFilter for persistence-aware input replacement.',
    );
  }

  return processedItems.flatMap((item, index) => {
    const preparedIndex = mappedPreparedIndexes[index];
    const ownerIndex =
      preparedIndex === undefined
        ? undefined
        : ownerIndexByPreparedIndex.get(preparedIndex);
    return ownerIndex === undefined ? [] : [{ item, ownerIndex }];
  });
}

function reconcilePersistableFilteredItems(options: {
  preparedSources: PreparedOwnedSource[];
  sourceItems: (AgentInputItem | undefined)[];
  filteredItems: AgentInputItem[];
  ownedFilteredItems: Map<number, AgentInputItem>;
  persistedInputOrder: PersistedInputOccurrence[];
}): {
  ownedFilteredItems: Map<number, AgentInputItem>;
  persistedInputOrder: PersistedInputOccurrence[];
  filteredSnapshot: AgentInputItem[];
} {
  const {
    preparedSources,
    sourceItems,
    filteredItems,
    ownedFilteredItems,
    persistedInputOrder,
  } = options;
  const sourceOwnerIndexes = new Map<AgentInputItem, number[]>();
  for (const source of preparedSources) {
    const ownerIndexes = sourceOwnerIndexes.get(source.item) ?? [];
    ownerIndexes.push(source.ownerIndex);
    sourceOwnerIndexes.set(source.item, ownerIndexes);
  }
  const sourceOccurrences = new Map<AgentInputItem, number>();
  const representedOwnedIndexes = new Set<number>();
  const currentOrder: PersistedInputOccurrence[] = [];
  const nextOwnedFilteredItems = new Map(ownedFilteredItems);

  for (let i = 0; i < filteredItems.length; i++) {
    const filteredItem = filteredItems[i];
    if (!filteredItem) {
      continue;
    }
    const source = sourceItems[i];
    if (source && typeof source === 'object') {
      const occurrence = sourceOccurrences.get(source) ?? 0;
      sourceOccurrences.set(source, occurrence + 1);
      const ownedIndex = sourceOwnerIndexes.get(source)?.[occurrence];
      if (ownedIndex !== undefined) {
        representedOwnedIndexes.add(ownedIndex);
        nextOwnedFilteredItems.set(ownedIndex, structuredClone(filteredItem));
        currentOrder.push({ type: 'owned', index: ownedIndex });
      }
      continue;
    }
    // Items without a source were injected by the callback. Preserve them without attempting
    // content-based identity matching, which could collapse ordinary messages.
    currentOrder.push({
      type: 'injected',
      item: structuredClone(filteredItem),
    });
  }

  const nextPersistedInputOrder = persistedInputOrder.filter(
    (occurrence) =>
      occurrence.type === 'owned' &&
      !representedOwnedIndexes.has(occurrence.index),
  );
  nextPersistedInputOrder.push(...currentOrder);

  return {
    ownedFilteredItems: nextOwnedFilteredItems,
    persistedInputOrder: nextPersistedInputOrder,
    filteredSnapshot: nextPersistedInputOrder.flatMap((occurrence) => {
      if (occurrence.type === 'injected') {
        return [structuredClone(occurrence.item)];
      }
      const item = nextOwnedFilteredItems.get(occurrence.index);
      return item ? [structuredClone(item)] : [];
    }),
  };
}

function buildSnapshotForUnfilteredItems(options: {
  preparedSourceCounts: Map<AgentInputItem, number> | undefined;
  sourceItems: (AgentInputItem | undefined)[];
  existingSnapshot: AgentInputItem[] | undefined;
}): AgentInputItem[] {
  const { preparedSourceCounts, sourceItems, existingSnapshot } = options;
  if (!preparedSourceCounts) {
    const filtered = sourceItems
      .filter((item): item is AgentInputItem => Boolean(item))
      .map((item) => structuredClone(item));
    return filtered.length > 0
      ? filtered
      : existingSnapshot === undefined
        ? []
        : existingSnapshot;
  }

  const filtered: AgentInputItem[] = [];
  const includedSourceCounts = new Map<AgentInputItem, number>();
  for (const item of sourceItems) {
    if (!item) {
      continue;
    }
    const preparedOccurrences = preparedSourceCounts.get(item) ?? 0;
    const includedOccurrences = includedSourceCounts.get(item) ?? 0;
    if (includedOccurrences >= preparedOccurrences) {
      continue;
    }
    includedSourceCounts.set(item, includedOccurrences + 1);
    filtered.push(structuredClone(item));
  }
  if (filtered.length > 0) {
    return filtered;
  }
  return existingSnapshot === undefined ? [] : existingSnapshot;
}

export async function saveToSession(
  session: Session | undefined,
  sessionInputItems: AgentInputItem[] | undefined,
  result: RunResult<any, any>,
  options: SessionPersistenceOptions = {},
): Promise<void> {
  const state = result.state;
  const alreadyPersisted = state._currentTurnPersistedItemCount ?? 0;
  const newRunItems = result.newItems.slice(alreadyPersisted);

  if (
    typeof process !== 'undefined' &&
    process.env?.OPENAI_AGENTS__DEBUG_SAVE_SESSION
  ) {
    console.debug(
      'saveToSession:newRunItems',
      newRunItems.map((item) => item.type),
    );
  }

  await persistRunItemsToSession({
    session,
    state,
    newRunItems,
    extraInputItems: sessionInputItems,
    lastResponseId: result.lastResponseId,
    alreadyPersistedCount: alreadyPersisted,
    runCompaction: options.runCompaction ?? true,
    compactionMode: options.compactionMode,
  });
}

export async function saveStreamInputToSession(
  session: Session | undefined,
  sessionInputItems: AgentInputItem[] | undefined,
): Promise<void> {
  if (!session) {
    return;
  }
  if (!sessionInputItems || sessionInputItems.length === 0) {
    return;
  }
  const sanitizedInput = normalizeItemsForSessionPersistence(sessionInputItems);
  const compactedInput = trimToLatestCompaction(sanitizedInput);
  assertPersistableCompactionBoundary(compactedInput);
  if (compactedInput[0]?.type === 'compaction') {
    const previousItems = await session.getItems();
    await replaceSessionItemsWithRecovery(
      session,
      previousItems,
      compactedInput,
    );
    return;
  }
  await session.addItems(sanitizedInput);
}

export async function saveStreamResultToSession(
  session: Session | undefined,
  result: StreamedRunResult<any, any>,
  options: SessionPersistenceOptions = {},
  sessionInputItems?: AgentInputItem[],
): Promise<void> {
  const state = result.state;
  const alreadyPersisted = state._currentTurnPersistedItemCount ?? 0;
  const newRunItems = result.newItems.slice(alreadyPersisted);

  await persistRunItemsToSession({
    session,
    state,
    newRunItems,
    extraInputItems: sessionInputItems,
    lastResponseId: result.lastResponseId,
    alreadyPersistedCount: alreadyPersisted,
    runCompaction: options.runCompaction ?? true,
    compactionMode: options.compactionMode,
  });
}

export async function reconcileLegacyCompactionSessionBeforeResume(
  session: Session | undefined,
  state: RunState<any, any>,
): Promise<void> {
  const pendingLegacyItems = state._pendingLegacyCompactionSessionItems;
  if (pendingLegacyItems === undefined) {
    return;
  }
  const normalizedPendingItems =
    normalizeItemsForSessionPersistence(pendingLegacyItems);
  assertPersistableCompactionBoundary(normalizedPendingItems);
  assertPendingLegacyCompactionItemsMatchState(
    state,
    normalizedPendingItems,
    undefined,
  );
  if (!session) {
    throwLegacyCompactionReconciliationError();
  }

  const reasoningItemIdPolicy =
    session.preserveReasoningItemIdsForPersistence?.() === true
      ? undefined
      : state._reasoningItemIdPolicy;
  const sanitizedPendingItems = normalizeItemsForSessionPersistence(
    pendingLegacyItems.map((item) =>
      stripReasoningItemIdForPolicy(item, reasoningItemIdPolicy),
    ),
  );
  assertPendingLegacyCompactionItemsMatchState(
    state,
    sanitizedPendingItems,
    reasoningItemIdPolicy,
  );
  await reconcileLegacyCompactionSessionItems(session, sanitizedPendingItems);
  state._pendingLegacyCompactionSessionItems = undefined;
}

function assertPendingLegacyCompactionItemsMatchState(
  state: RunState<any, any>,
  pendingItems: AgentInputItem[],
  reasoningItemIdPolicy: ReasoningItemIdPolicy | undefined,
): void {
  if (pendingItems.length < 2 || pendingItems[0]?.type !== 'compaction') {
    throwLegacyCompactionReconciliationError();
  }

  const persistedItemCount = state._currentTurnPersistedItemCount;
  if (
    !Number.isInteger(persistedItemCount) ||
    persistedItemCount < 1 ||
    persistedItemCount > state._generatedItems.length
  ) {
    throwLegacyCompactionReconciliationError();
  }

  let matchingCandidates = 0;
  for (let index = 0; index < persistedItemCount; index += 1) {
    if (state._generatedItems[index]?.type !== 'compaction_item') {
      continue;
    }
    const candidateItems = normalizeItemsForSessionPersistence(
      extractOutputItemsFromRunItems(
        state._generatedItems.slice(index, persistedItemCount),
        reasoningItemIdPolicy,
      ),
    );
    if (
      candidateItems.length > 1 &&
      agentItemRangeMatches(candidateItems, pendingItems, 0) &&
      candidateItems.length === pendingItems.length
    ) {
      matchingCandidates += 1;
    }
  }

  if (matchingCandidates !== 1) {
    throwLegacyCompactionReconciliationError();
  }
}

export async function prepareInputItemsWithSession(
  input: string | AgentInputItem[],
  session?: Session,
  sessionInputCallback?: SessionInputCallback,
  options?: {
    includeHistoryInPreparedInput?: boolean;
    preserveDroppedNewItems?: boolean;
    reasoningItemIdPolicy?: ReasoningItemIdPolicy;
  },
): Promise<PreparedInputWithSessionResult> {
  const newInputItems = toAgentInputList(input);
  assertValidCompactionItems(newInputItems);
  if (!session) {
    return {
      preparedInput: input,
      sessionItems: undefined,
    };
  }

  const includeHistoryInPreparedInput =
    options?.includeHistoryInPreparedInput ?? true;
  const preserveDroppedNewItems = options?.preserveDroppedNewItems ?? false;
  const reasoningItemIdPolicy = options?.reasoningItemIdPolicy;

  const history = trimToLatestCompaction(await session.getItems());
  assertPersistableCompactionBoundary(history);
  if (!sessionInputCallback) {
    const historyForModelInput = history.map((item) =>
      prepareHistoryItemForModelInput(session, item, reasoningItemIdPolicy),
    );
    const preparedInput = includeHistoryInPreparedInput
      ? dropOrphanToolCalls([...historyForModelInput, ...newInputItems], {
          pruningIndexes: new Set(history.map((_, index) => index)),
        })
      : newInputItems;
    return {
      preparedInput,
      sessionItems: newInputItems,
    };
  }

  const historySnapshot = history.slice();
  const newInputSnapshot = newInputItems.slice();

  const combined = await sessionInputCallback(history, newInputItems);
  if (!Array.isArray(combined)) {
    throw new UserError(
      'Session input callback must return an array of AgentInputItem objects.',
    );
  }
  assertValidCompactionItems(combined);

  const historyCounts = buildItemFrequencyMap(historySnapshot, {
    session,
    prepareForModelInput: true,
    reasoningItemIdPolicy,
  });
  const newInputCounts = buildItemFrequencyMap(newInputSnapshot);
  const historyRefs = buildAgentInputPool(historySnapshot);
  const newInputRefs = buildAgentInputPool(newInputSnapshot);
  const historyIndexes = new Set<number>();

  const appended: AgentInputItem[] = [];
  for (const [index, item] of combined.entries()) {
    const historyKey = getHistoryItemModelInputKey(
      session,
      item,
      reasoningItemIdPolicy,
    );
    const newInputKey = getAgentInputItemKey(item);
    if (removeAgentInputFromPool(newInputRefs, item)) {
      decrementCount(newInputCounts, newInputKey);
      appended.push(item);
      continue;
    }

    if (removeAgentInputFromPool(historyRefs, item)) {
      decrementCount(historyCounts, historyKey);
      historyIndexes.add(index);
      continue;
    }

    const historyRemaining = historyCounts.get(historyKey) ?? 0;
    if (historyRemaining > 0) {
      historyCounts.set(historyKey, historyRemaining - 1);
      historyIndexes.add(index);
      continue;
    }

    const newRemaining = newInputCounts.get(newInputKey) ?? 0;
    if (newRemaining > 0) {
      newInputCounts.set(newInputKey, newRemaining - 1);
      appended.push(item);
      continue;
    }

    appended.push(item);
  }

  const preparedItems = includeHistoryInPreparedInput
    ? combined
    : appended.length > 0
      ? appended
      : preserveDroppedNewItems
        ? newInputSnapshot
        : [];

  if (
    preserveDroppedNewItems &&
    appended.length === 0 &&
    newInputSnapshot.length > 0
  ) {
    // In server-managed conversations we cannot drop the turn delta; restore it and warn callers.
    logger.warn(
      'sessionInputCallback dropped all new inputs in a server-managed conversation; original turn inputs were restored to avoid losing the API delta. Keep at least one new item or omit conversationId if you intended to drop them.',
    );
  }

  const prunedPreparedItems = includeHistoryInPreparedInput
    ? dropOrphanToolCalls(
        prepareHistoryItemsForModelInput(
          session,
          preparedItems,
          historyIndexes,
          reasoningItemIdPolicy,
        ),
        { pruningIndexes: historyIndexes },
      )
    : preparedItems;

  return {
    preparedInput: prunedPreparedItems,
    sessionItems: appended,
  };
}

function prepareHistoryItemsForModelInput(
  session: Session,
  items: AgentInputItem[],
  historyIndexes: Set<number>,
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem[] {
  if (historyIndexes.size === 0) {
    return items;
  }
  return items.map((item, index) =>
    historyIndexes.has(index)
      ? prepareHistoryItemForModelInput(session, item, reasoningItemIdPolicy)
      : item,
  );
}

function prepareHistoryItemForModelInput(
  session: Session,
  item: AgentInputItem,
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): AgentInputItem {
  const prepared = session.prepareHistoryItemForModelInput?.(item) ?? item;
  return stripReasoningItemIdForPolicy(prepared, reasoningItemIdPolicy);
}

function getHistoryItemModelInputKey(
  session: Session,
  item: AgentInputItem,
  reasoningItemIdPolicy?: ReasoningItemIdPolicy,
): string {
  return getAgentInputItemKey(
    prepareHistoryItemForModelInput(session, item, reasoningItemIdPolicy),
  );
}

function normalizeItemsForSessionPersistence(
  items: AgentInputItem[],
): AgentInputItem[] {
  return deduplicateAgentInputItemsPreferringLatest(
    items.map((item) => sanitizeValueForSession(stripTransientCallIds(item))),
  );
}

type SessionBinaryContext = {
  mediaType?: string;
};

function sanitizeValueForSession(
  value: AgentInputItem,
  context?: SessionBinaryContext,
): AgentInputItem;
function sanitizeValueForSession(
  value: unknown,
  context?: SessionBinaryContext,
): unknown;
function sanitizeValueForSession(
  value: unknown,
  context: SessionBinaryContext = {},
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const binary = toUint8ArrayFromBinary(value);
  if (binary) {
    return toDataUrlFromBytes(binary, context.mediaType);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValueForSession(entry, context));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  const mediaType =
    typeof record.mediaType === 'string' && record.mediaType.length > 0
      ? (record.mediaType as string)
      : context.mediaType;

  for (const [key, entry] of Object.entries(record)) {
    const nextContext =
      key === 'data' || key === 'fileData' ? { mediaType } : context;
    result[key] = sanitizeValueForSession(entry, nextContext);
  }

  return result;
}

function toDataUrlFromBytes(bytes: Uint8Array, mediaType?: string): string {
  const base64 = encodeUint8ArrayToBase64(bytes);
  const type =
    mediaType && !mediaType.startsWith('data:') ? mediaType : 'text/plain';
  return `data:${type};base64,${base64}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripTransientCallIds(value: AgentInputItem): AgentInputItem;
function stripTransientCallIds(value: unknown): unknown;
function stripTransientCallIds(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripTransientCallIds(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const isProtocolItem =
    typeof record.type === 'string' && record.type.length > 0;
  const shouldStripId = isProtocolItem && shouldStripIdForProtocolItem(record);
  for (const [key, entry] of Object.entries(record)) {
    if (shouldStripId && key === 'id') {
      continue;
    }
    result[key] = stripTransientCallIds(entry);
  }
  return result;
}

function shouldStripIdForProtocolItem(
  record: Record<string, unknown>,
): boolean {
  switch (record.type) {
    case 'function_call':
    case 'function_call_result':
      return true;
    case 'tool_search_call':
    case 'tool_search_output':
      return hasToolSearchCallId(record);
    default:
      return false;
  }
}

function hasToolSearchCallId(record: Record<string, unknown>): boolean {
  const topLevelCallId = record.call_id ?? record.callId;
  if (typeof topLevelCallId === 'string' && topLevelCallId.length > 0) {
    return true;
  }

  const providerData = isPlainObject(record.providerData)
    ? (record.providerData as Record<string, unknown>)
    : undefined;
  const providerCallId = providerData?.call_id ?? providerData?.callId;
  return typeof providerCallId === 'string' && providerCallId.length > 0;
}

async function persistRunItemsToSession(options: {
  session?: Session;
  state: RunState<any, any>;
  newRunItems: RunItem[];
  extraInputItems?: AgentInputItem[] | undefined;
  lastResponseId?: string;
  alreadyPersistedCount: number;
  runCompaction: boolean;
  compactionMode?: OpenAIResponsesCompactionArgs['compactionMode'];
}): Promise<void> {
  const {
    session,
    state,
    newRunItems,
    extraInputItems = [],
    lastResponseId,
    alreadyPersistedCount,
    runCompaction,
    compactionMode,
  } = options;

  if (!session) {
    return;
  }

  await reconcileLegacyCompactionSessionBeforeResume(session, state);

  const reasoningItemIdPolicy =
    session.preserveReasoningItemIdsForPersistence?.() === true
      ? undefined
      : state._reasoningItemIdPolicy;
  const itemsToSave = [
    ...extraInputItems,
    ...extractOutputItemsFromRunItems(newRunItems, reasoningItemIdPolicy),
  ];

  if (itemsToSave.length === 0) {
    state._currentTurnPersistedItemCount =
      alreadyPersistedCount + newRunItems.length;
    if (runCompaction) {
      await runCompactionOnSession(
        session,
        lastResponseId,
        state,
        compactionMode,
      );
    }
    return;
  }

  const sanitizedItems = normalizeItemsForSessionPersistence(itemsToSave);
  const compactedItems = trimToLatestCompaction(sanitizedItems);
  assertPersistableCompactionBoundary(compactedItems);
  if (compactedItems[0]?.type === 'compaction') {
    const previousItems = await session.getItems();
    await replaceSessionItemsWithRecovery(
      session,
      previousItems,
      compactedItems,
    );
  } else {
    await session.addItems(sanitizedItems);
  }
  state._currentTurnPersistedItemCount =
    alreadyPersistedCount + newRunItems.length;
  if (runCompaction) {
    await runCompactionOnSession(
      session,
      lastResponseId,
      state,
      compactionMode,
    );
  }
}

async function reconcileLegacyCompactionSessionItems(
  session: Session,
  pendingItems: AgentInputItem[],
): Promise<void> {
  if (pendingItems.length === 0 || pendingItems[0]?.type !== 'compaction') {
    throwLegacyCompactionReconciliationError();
  }
  assertPersistableCompactionBoundary(pendingItems);

  const previousItems = await session.getItems();
  assertValidCompactionItems(trimToLatestCompaction(previousItems));
  const comparablePreviousItems =
    session.prepareHistoryItemsForPersistenceComparison?.(previousItems) ??
    previousItems;
  const comparablePendingItems =
    session.prepareHistoryItemsForPersistenceComparison?.(pendingItems) ??
    pendingItems;
  const compactedComparablePreviousItems = trimToLatestCompaction(
    comparablePreviousItems,
  );
  if (
    compactedComparablePreviousItems.length === comparablePendingItems.length &&
    agentItemRangeMatches(
      compactedComparablePreviousItems,
      comparablePendingItems,
      0,
    )
  ) {
    return;
  }

  const previouslyPersistedSuffix = comparablePendingItems.slice(1);
  if (
    !agentItemRangeMatches(
      comparablePreviousItems,
      previouslyPersistedSuffix,
      comparablePreviousItems.length - previouslyPersistedSuffix.length,
    )
  ) {
    throwLegacyCompactionReconciliationError();
  }

  await replaceSessionItemsWithRecovery(session, previousItems, pendingItems);
}

function assertPersistableCompactionBoundary(items: AgentInputItem[]): void {
  assertValidCompactionItems(items);
}

function agentItemRangeMatches(
  items: AgentInputItem[],
  expected: AgentInputItem[],
  start: number,
): boolean {
  if (start < 0 || start + expected.length > items.length) {
    return false;
  }
  return expected.every(
    (item, offset) =>
      getSessionReconciliationItemKey(items[start + offset]) ===
      getSessionReconciliationItemKey(item),
  );
}

function getSessionReconciliationItemKey(item: AgentInputItem): string {
  return JSON.stringify(sortSessionReconciliationValue(item));
}

function sortSessionReconciliationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortSessionReconciliationValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortSessionReconciliationValue(value[key])]),
  );
}

function throwLegacyCompactionReconciliationError(): never {
  throw new UserError(
    'Run state cannot safely reconcile its restored compaction item with session history.',
  );
}

async function replaceSessionItemsWithRecovery(
  session: Session,
  previousItems: AgentInputItem[],
  replacementItems: AgentInputItem[],
): Promise<void> {
  assertValidCompactionItems(trimToLatestCompaction(previousItems));
  assertValidCompactionItems(trimToLatestCompaction(replacementItems));
  if (
    replacementItems[0]?.type === 'compaction' &&
    session.replaceHistoryWithCompaction
  ) {
    const comparablePreviousItems =
      session.prepareHistoryItemsForPersistenceComparison?.(previousItems) ??
      previousItems;
    const comparableReplacementItems =
      session.prepareHistoryItemsForPersistenceComparison?.(replacementItems) ??
      replacementItems;
    const compactedPreviousItems = trimToLatestCompaction(
      comparablePreviousItems,
    );
    if (
      compactedPreviousItems.length === comparableReplacementItems.length &&
      agentItemRangeMatches(
        compactedPreviousItems,
        comparableReplacementItems,
        0,
      )
    ) {
      return;
    }
    await session.replaceHistoryWithCompaction(replacementItems);
    return;
  }

  try {
    await session.clearSession();
    if (replacementItems.length > 0) {
      await session.addItems(replacementItems);
    }
  } catch (error) {
    await restoreSessionItemsAfterFailedReplacement(
      session,
      previousItems,
      error,
    );
    throw error;
  }
}

async function restoreSessionItemsAfterFailedReplacement(
  session: Session,
  previousItems: AgentInputItem[],
  replacementError: unknown,
): Promise<void> {
  try {
    const currentItems = await session.getItems();
    if (
      currentItems.length === previousItems.length &&
      agentItemRangeMatches(currentItems, previousItems, 0)
    ) {
      return;
    }
  } catch (inspectionError) {
    logModelAndToolActionWarning(
      logger,
      'Failed to inspect session history after compaction replacement failed.',
      inspectionError,
    );
  }

  try {
    await session.clearSession();
    if (previousItems.length > 0) {
      await session.addItems(previousItems);
    }
  } catch (restoreError) {
    logModelAndToolActionWarning(
      logger,
      'Failed to restore session history after compaction replacement failed.',
      restoreError,
    );
    throw new SessionReconciliationRecoveryError(
      replacementError,
      restoreError,
    );
  }

  logModelAndToolActionWarning(
    logger,
    'Restored session history after compaction replacement failed.',
    replacementError,
  );
}

async function runCompactionOnSession(
  session: Session | undefined,
  responseId: string | undefined,
  state: RunState<any, any>,
  compactionMode?: OpenAIResponsesCompactionArgs['compactionMode'],
): Promise<void> {
  if (!isOpenAIResponsesCompactionAwareSession(session)) {
    return;
  }
  const store =
    state._lastModelSettings?.store ?? state._currentAgent.modelSettings?.store;
  const compactionArgs =
    typeof responseId === 'undefined' &&
    typeof store === 'undefined' &&
    typeof compactionMode === 'undefined'
      ? undefined
      : {
          ...(typeof responseId === 'undefined' ? {} : { responseId }),
          ...(typeof store === 'undefined' ? {} : { store }),
          ...(typeof compactionMode === 'undefined' ? {} : { compactionMode }),
        };
  const compactionResult = await session.runCompaction(compactionArgs);
  if (!compactionResult) {
    return;
  }
  const usage = compactionResult.usage;
  const usageIncrement = new Usage({
    requests: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: usage.inputTokensDetails,
    outputTokensDetails: usage.outputTokensDetails,
    requestUsageEntries: [usage],
  });
  state._context.usage.add(usageIncrement);
  getRunStateUsageRecorder(state)?.(usageIncrement);
}

function buildItemFrequencyMap(
  items: AgentInputItem[],
  options?: {
    session?: Session;
    prepareForModelInput?: boolean;
    reasoningItemIdPolicy?: ReasoningItemIdPolicy;
  },
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key =
      options?.prepareForModelInput && options.session
        ? getHistoryItemModelInputKey(
            options.session,
            item,
            options.reasoningItemIdPolicy,
          )
        : getAgentInputItemKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function decrementCount(map: Map<string, number>, key: string) {
  const remaining = (map.get(key) ?? 0) - 1;
  if (remaining <= 0) {
    map.delete(key);
  } else {
    map.set(key, remaining);
  }
}
