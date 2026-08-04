import { UserError } from '../errors';
import {
  isOpenAIResponsesCompactionAwareSession,
  type OpenAIResponsesCompactionArgs,
  type Session,
  type SessionInputCallback,
} from '../memory/session';
import { RunResult, StreamedRunResult } from '../result';
import { RunState } from '../runState';
import {
  RunItem,
  RunToolCallOutputItem,
  wasRunToolCallOutputItemExecuted,
} from '../items';
import { AgentInputItem } from '../types';
import { Usage } from '../usage';
import { encodeUint8ArrayToBase64 } from '../utils/base64';
import { toUint8ArrayFromBinary } from '../utils/binary';
import {
  buildAgentInputPool,
  dropOrphanToolCalls,
  extractOutputItemsFromRunItems,
  toAgentInputList,
  getAgentInputItemKey,
  removeAgentInputFromPool,
  stripReasoningItemIdForPolicy,
  type ReasoningItemIdPolicy,
} from './items';
import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationForResult,
  getToolResultCorrelationKey,
} from './toolResultCorrelation';
import logger from '../logger';
import { getRunStateUsageRecorder } from './usageTracking';

export type PreparedInputWithSessionResult = {
  preparedInput: string | AgentInputItem[];
  sessionItems?: AgentInputItem[];
};

export type SessionPersistenceOptions = {
  runCompaction?: boolean;
  compactionMode?: OpenAIResponsesCompactionArgs['compactionMode'];
  outputBlocked?: boolean;
};

type BlockedToolRecord = Readonly<{
  key: string;
  role: 'call' | 'result';
  terminal: boolean;
}>;

function classifyBlockedToolRecord(
  item: AgentInputItem,
): BlockedToolRecord | undefined {
  const type = (item as { type?: unknown }).type;
  const status = (item as { status?: unknown }).status;
  let role: BlockedToolRecord['role'];
  let terminal: boolean;

  switch (type) {
    case 'program':
      role = 'call';
      terminal = true;
      break;
    case 'function_call':
    case 'shell_call':
      role = 'call';
      terminal = status === undefined || status === 'completed';
      break;
    case 'computer_call':
    case 'apply_patch_call':
      role = 'call';
      terminal = status === 'completed';
      break;
    case 'function_call_result':
    case 'program_output':
      role = 'result';
      terminal = status === 'completed';
      break;
    case 'computer_call_result': {
      role = 'result';
      const providerData = (item as { providerData?: unknown }).providerData;
      const providerStatus =
        providerData && typeof providerData === 'object'
          ? (providerData as { status?: unknown }).status
          : undefined;
      terminal = providerStatus === undefined || providerStatus === 'completed';
      break;
    }
    case 'shell_call_output':
      role = 'result';
      terminal = status === undefined || status === 'completed';
      break;
    case 'apply_patch_call_output':
      role = 'result';
      terminal = status === 'completed' || status === 'failed';
      break;
    default:
      return undefined;
  }

  const correlation =
    role === 'call'
      ? getToolResultCorrelationForCall(item)
      : getToolResultCorrelationForResult(item);
  return correlation
    ? {
        key: getToolResultCorrelationKey(correlation),
        role,
        terminal,
      }
    : undefined;
}

/**
 * Selects the completed tool effects that remain replayable when final output is blocked.
 *
 * Unknown run item types are intentionally excluded until their persistence semantics are
 * classified. Reasoning items are retained only when the next non-reasoning item is a retained
 * tool call.
 */
function selectRunItemIndexesForBlockedOutput(
  items: RunItem[],
  unpersistedStartIndex = 0,
): number[] {
  const pairs = new Map<
    string,
    {
      valid: boolean;
      callIndexes: number[];
      results: Array<{ index: number; executed: boolean }>;
    }
  >();

  for (const [index, item] of items.entries()) {
    const rawItem = (item as { rawItem?: AgentInputItem }).rawItem;
    if (!rawItem) {
      continue;
    }
    const record = classifyBlockedToolRecord(rawItem);
    if (!record) {
      continue;
    }
    let pair = pairs.get(record.key);
    if (!pair) {
      pair = { valid: true, callIndexes: [], results: [] };
      pairs.set(record.key, pair);
    }
    const wrapperMatchesRole =
      (record.role === 'call' && item.type === 'tool_call_item') ||
      (record.role === 'result' && item instanceof RunToolCallOutputItem);
    if (!record.terminal || !wrapperMatchesRole) {
      pair.valid = false;
      continue;
    }
    if (record.role === 'call') {
      pair.callIndexes.push(index);
    } else {
      pair.results.push({
        index,
        executed: wasRunToolCallOutputItemExecuted(
          item as RunToolCallOutputItem,
        ),
      });
    }
  }

  const retainedIndexes = new Set<number>();
  const retainedCallIndexes = new Set<number>();
  for (const pair of pairs.values()) {
    if (
      pair.valid &&
      pair.callIndexes.length === 1 &&
      pair.results.length === 1 &&
      pair.callIndexes[0] < pair.results[0].index &&
      (pair.results[0].executed || pair.callIndexes[0] < unpersistedStartIndex)
    ) {
      retainedCallIndexes.add(pair.callIndexes[0]);
      retainedIndexes.add(pair.callIndexes[0]);
      retainedIndexes.add(pair.results[0].index);
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

export function selectRunItemsForBlockedOutput(
  items: RunItem[],
  unpersistedStartIndex = 0,
): RunItem[] {
  return selectRunItemIndexesForBlockedOutput(items, unpersistedStartIndex).map(
    (index) => items[index]!,
  );
}

function buildRunItemPersistencePlan(
  state: RunState<any, any>,
  items: RunItem[],
  outputBlocked: boolean,
  deferBlockedItemsForResume: boolean,
): {
  alreadyPersistedCount: number;
  runItemsToPersist: RunItem[];
  processedRunItemCount: number;
  deferredRunItemIndexes: number[];
  clearDeferredRunItemIndexes: boolean;
} {
  const alreadyPersistedCount = state._currentTurnPersistedItemCount ?? 0;
  const newRunItemIndexes = Array.from(
    { length: Math.max(0, items.length - alreadyPersistedCount) },
    (_value, offset) => alreadyPersistedCount + offset,
  );

  if (outputBlocked) {
    const retainedIndexes = selectRunItemIndexesForBlockedOutput(
      items,
      alreadyPersistedCount,
    );
    const retainedIndexSet = new Set(retainedIndexes);
    return {
      alreadyPersistedCount,
      runItemsToPersist: retainedIndexes.map((index) => items[index]!),
      processedRunItemCount: newRunItemIndexes.length,
      deferredRunItemIndexes: deferBlockedItemsForResume
        ? newRunItemIndexes.filter((index) => !retainedIndexSet.has(index))
        : [],
      clearDeferredRunItemIndexes: !deferBlockedItemsForResume,
    };
  }

  const deferredIndexes = [...state._currentTurnDeferredSessionItemIndexes]
    .filter((index) => index < items.length)
    .sort((left, right) => left - right);
  if (deferredIndexes.length > 0) {
    const deferredIndexSet = new Set(deferredIndexes);
    const processedEndIndex = Math.min(alreadyPersistedCount, items.length);
    const firstDeferredIndex = deferredIndexes[0]!;
    for (
      let index = firstDeferredIndex;
      index < processedEndIndex;
      index += 1
    ) {
      if (!deferredIndexSet.has(index)) {
        throw new UserError(
          'Cannot persist accepted output from this resumed RunState without reordering session history because blocked output preceded committed tool records. Start a new run with the existing session instead of resuming this state.',
        );
      }
    }
  }

  const indexesToPersist = new Set(deferredIndexes);
  for (const index of newRunItemIndexes) {
    indexesToPersist.add(index);
  }

  return {
    alreadyPersistedCount,
    runItemsToPersist: [...indexesToPersist]
      .sort((left, right) => left - right)
      .map((index) => items[index]!),
    processedRunItemCount: newRunItemIndexes.length,
    deferredRunItemIndexes: [],
    clearDeferredRunItemIndexes: true,
  };
}

export type SessionPersistenceTracker = {
  setPreparedItems: (items?: AgentInputItem[]) => void;
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
    private pendingWriteCounts: Map<string, number> | undefined;
    private persistedInput = false;

    constructor() {
      this.session = options.session;
      this.hasCallModelInputFilter = options.hasCallModelInputFilter;
      this.persistInput = options.persistInput;
      this.originalSnapshot = options.resumingFromState ? [] : undefined;
      this.filteredSnapshot = undefined;
      this.pendingWriteCounts = options.resumingFromState
        ? new Map()
        : undefined;
    }

    setPreparedItems = (items?: AgentInputItem[]) => {
      const sessionItems = items ?? [];
      this.originalSnapshot = sessionItems.map((item) => structuredClone(item));
      this.pendingWriteCounts = new Map();
      for (const item of sessionItems) {
        const key = getAgentInputItemKey(item);
        this.pendingWriteCounts.set(
          key,
          (this.pendingWriteCounts.get(key) ?? 0) + 1,
        );
      }
    };

    recordTurnItems = (
      sourceItems: (AgentInputItem | undefined)[],
      filteredItems?: AgentInputItem[],
    ) => {
      const pendingCounts = this.pendingWriteCounts;
      if (filteredItems !== undefined) {
        if (!pendingCounts) {
          this.filteredSnapshot = cloneItems(filteredItems);
          return;
        }
        const nextSnapshot = collectPersistableFilteredItems({
          pendingCounts,
          sourceItems,
          filteredItems,
          existingSnapshot: this.filteredSnapshot,
        });
        if (nextSnapshot !== undefined) {
          this.filteredSnapshot = nextSnapshot;
        }
        return;
      }

      this.filteredSnapshot = buildSnapshotForUnfilteredItems({
        pendingCounts,
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

function buildSourceOccurrenceCounts(
  sourceItems: (AgentInputItem | undefined)[],
) {
  const sourceOccurrenceCounts = new WeakMap<AgentInputItem, number>();
  for (const source of sourceItems) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const nextCount = (sourceOccurrenceCounts.get(source) ?? 0) + 1;
    sourceOccurrenceCounts.set(source, nextCount);
  }
  return sourceOccurrenceCounts;
}

function collectPersistableFilteredItems(options: {
  pendingCounts: Map<string, number>;
  sourceItems: (AgentInputItem | undefined)[];
  filteredItems: AgentInputItem[];
  existingSnapshot: AgentInputItem[] | undefined;
}): AgentInputItem[] | undefined {
  const { pendingCounts, sourceItems, filteredItems, existingSnapshot } =
    options;
  const persistableItems: AgentInputItem[] = [];
  const sourceOccurrenceCounts = buildSourceOccurrenceCounts(sourceItems);
  const consumeAnyPendingWriteSlot = () => {
    for (const [key, remaining] of pendingCounts) {
      if (remaining > 0) {
        pendingCounts.set(key, remaining - 1);
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < filteredItems.length; i++) {
    const filteredItem = filteredItems[i];
    if (!filteredItem) {
      continue;
    }
    let allocated = false;
    const source = sourceItems[i];
    if (source && typeof source === 'object') {
      const pendingOccurrences = (sourceOccurrenceCounts.get(source) ?? 0) - 1;
      sourceOccurrenceCounts.set(source, pendingOccurrences);
      if (pendingOccurrences > 0) {
        continue;
      }
      const sourceKey = getAgentInputItemKey(source);
      const remaining = pendingCounts.get(sourceKey) ?? 0;
      if (remaining > 0) {
        pendingCounts.set(sourceKey, remaining - 1);
        persistableItems.push(structuredClone(filteredItem));
        allocated = true;
        continue;
      }
    }
    const filteredKey = getAgentInputItemKey(filteredItem);
    const filteredRemaining = pendingCounts.get(filteredKey) ?? 0;
    if (filteredRemaining > 0) {
      pendingCounts.set(filteredKey, filteredRemaining - 1);
      persistableItems.push(structuredClone(filteredItem));
      allocated = true;
      continue;
    }
    if (!source && consumeAnyPendingWriteSlot()) {
      persistableItems.push(structuredClone(filteredItem));
      allocated = true;
    }
    if (!allocated && !source && existingSnapshot === undefined) {
      persistableItems.push(structuredClone(filteredItem));
    }
  }
  if (persistableItems.length > 0 || existingSnapshot === undefined) {
    return persistableItems;
  }
  return existingSnapshot;
}

function buildSnapshotForUnfilteredItems(options: {
  pendingCounts: Map<string, number> | undefined;
  sourceItems: (AgentInputItem | undefined)[];
  existingSnapshot: AgentInputItem[] | undefined;
}): AgentInputItem[] {
  const { pendingCounts, sourceItems, existingSnapshot } = options;
  if (!pendingCounts) {
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
  for (const item of sourceItems) {
    if (!item) {
      continue;
    }
    const key = getAgentInputItemKey(item);
    const remaining = pendingCounts.get(key) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    pendingCounts.set(key, remaining - 1);
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
  const persistencePlan = buildRunItemPersistencePlan(
    state,
    result.newItems,
    options.outputBlocked === true,
    // Non-streamed tripwires retain the final step, so the same RunState can later
    // accept and persist the withheld output without rerunning committed tools.
    true,
  );

  if (
    typeof process !== 'undefined' &&
    process.env?.OPENAI_AGENTS__DEBUG_SAVE_SESSION
  ) {
    console.debug(
      'saveToSession:newRunItems',
      persistencePlan.runItemsToPersist.map((item) => item.type),
    );
  }

  await persistRunItemsToSession({
    session,
    state,
    newRunItems: persistencePlan.runItemsToPersist,
    processedRunItemCount: persistencePlan.processedRunItemCount,
    deferredRunItemIndexes: persistencePlan.deferredRunItemIndexes,
    clearDeferredRunItemIndexes: persistencePlan.clearDeferredRunItemIndexes,
    extraInputItems: sessionInputItems,
    lastResponseId: options.outputBlocked ? undefined : result.lastResponseId,
    alreadyPersistedCount: persistencePlan.alreadyPersistedCount,
    runCompaction: options.runCompaction ?? true,
    compactionMode: options.outputBlocked ? 'input' : options.compactionMode,
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
  await session.addItems(sanitizedInput);
}

export async function saveStreamResultToSession(
  session: Session | undefined,
  result: StreamedRunResult<any, any>,
  options: SessionPersistenceOptions = {},
): Promise<void> {
  const state = result.state;
  const persistencePlan = buildRunItemPersistencePlan(
    state,
    result.newItems,
    options.outputBlocked === true,
    // Streaming tripwires retain a durable final checkpoint for RunState resume,
    // while StreamedRunResult keeps the rejected output hidden from callers.
    true,
  );

  await persistRunItemsToSession({
    session,
    state,
    newRunItems: persistencePlan.runItemsToPersist,
    processedRunItemCount: persistencePlan.processedRunItemCount,
    deferredRunItemIndexes: persistencePlan.deferredRunItemIndexes,
    clearDeferredRunItemIndexes: persistencePlan.clearDeferredRunItemIndexes,
    lastResponseId: options.outputBlocked ? undefined : result.lastResponseId,
    alreadyPersistedCount: persistencePlan.alreadyPersistedCount,
    runCompaction: options.runCompaction ?? true,
    compactionMode: options.outputBlocked ? 'input' : options.compactionMode,
  });
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

  const history = await session.getItems();
  const newInputItems = toAgentInputList(input);

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
  return items.map((item) =>
    sanitizeValueForSession(stripTransientCallIds(item)),
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
  processedRunItemCount: number;
  deferredRunItemIndexes: number[];
  clearDeferredRunItemIndexes: boolean;
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
    processedRunItemCount,
    deferredRunItemIndexes,
    clearDeferredRunItemIndexes,
    extraInputItems = [],
    lastResponseId,
    alreadyPersistedCount,
    runCompaction,
    compactionMode,
  } = options;

  if (!session) {
    return;
  }

  const itemsToSave = [
    ...extraInputItems,
    ...extractOutputItemsFromRunItems(
      newRunItems,
      session.preserveReasoningItemIdsForPersistence?.() === true
        ? undefined
        : state._reasoningItemIdPolicy,
    ),
  ];

  const commitPersistenceState = () => {
    if (clearDeferredRunItemIndexes) {
      state._currentTurnDeferredSessionItemIndexes.clear();
    }
    for (const index of deferredRunItemIndexes) {
      state._currentTurnDeferredSessionItemIndexes.add(index);
    }
    state._currentTurnPersistedItemCount =
      alreadyPersistedCount + processedRunItemCount;
  };

  if (itemsToSave.length === 0) {
    commitPersistenceState();
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
  await session.addItems(sanitizedItems);
  commitPersistenceState();
  if (runCompaction) {
    await runCompactionOnSession(
      session,
      lastResponseId,
      state,
      compactionMode,
    );
  }
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
