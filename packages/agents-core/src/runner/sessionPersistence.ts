import { UserError } from '../errors';
import {
  isOpenAIResponsesCompactionAwareSession,
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
  buildAgentInputPool,
  extractOutputItemsFromRunItems,
  toAgentInputList,
  getAgentInputItemKey,
  removeAgentInputFromPool,
} from './items';
import logger from '../logger';

export type PreparedInputWithSessionResult = {
  preparedInput: string | AgentInputItem[];
  sessionItems?: AgentInputItem[];
};

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
): Promise<void> {
  const state = result.state;
  const alreadyPersisted = state._currentTurnPersistedItemCount ?? 0;
  const newRunItems = result.newItems.slice(alreadyPersisted);

  if (process.env.OPENAI_AGENTS__DEBUG_SAVE_SESSION) {
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
): Promise<void> {
  const state = result.state;
  const alreadyPersisted = state._currentTurnPersistedItemCount ?? 0;
  const newRunItems = result.newItems.slice(alreadyPersisted);

  await persistRunItemsToSession({
    session,
    state,
    newRunItems,
    lastResponseId: result.lastResponseId,
    alreadyPersistedCount: alreadyPersisted,
  });
}

export async function prepareInputItemsWithSession(
  input: string | AgentInputItem[],
  session?: Session,
  sessionInputCallback?: SessionInputCallback,
  options?: {
    includeHistoryInPreparedInput?: boolean;
    preserveDroppedNewItems?: boolean;
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

  const history = await session.getItems();
  const newInputItems = toAgentInputList(input);

  if (!sessionInputCallback) {
    return {
      preparedInput: includeHistoryInPreparedInput
        ? [...history, ...newInputItems]
        : newInputItems,
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

  const historyCounts = buildItemFrequencyMap(historySnapshot);
  const newInputCounts = buildItemFrequencyMap(newInputSnapshot);
  const historyRefs = buildAgentInputPool(historySnapshot);
  const newInputRefs = buildAgentInputPool(newInputSnapshot);

  const appended: AgentInputItem[] = [];
  for (const item of combined) {
    const key = getAgentInputItemKey(item);
    if (removeAgentInputFromPool(newInputRefs, item)) {
      decrementCount(newInputCounts, key);
      appended.push(item);
      continue;
    }

    if (removeAgentInputFromPool(historyRefs, item)) {
      decrementCount(historyCounts, key);
      continue;
    }

    const historyRemaining = historyCounts.get(key) ?? 0;
    if (historyRemaining > 0) {
      historyCounts.set(key, historyRemaining - 1);
      continue;
    }

    const newRemaining = newInputCounts.get(key) ?? 0;
    if (newRemaining > 0) {
      newInputCounts.set(key, newRemaining - 1);
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

  return {
    preparedInput: preparedItems,
    sessionItems: appended,
  };
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
  const shouldStripId =
    isProtocolItem && shouldStripIdForType(record.type as string);
  for (const [key, entry] of Object.entries(record)) {
    if (shouldStripId && key === 'id') {
      continue;
    }
    result[key] = stripTransientCallIds(entry);
  }
  return result;
}

function shouldStripIdForType(type: string): boolean {
  switch (type) {
    case 'function_call':
    case 'function_call_result':
      return true;
    default:
      return false;
  }
}

async function persistRunItemsToSession(options: {
  session?: Session;
  state: RunState<any, any>;
  newRunItems: RunItem[];
  extraInputItems?: AgentInputItem[] | undefined;
  lastResponseId?: string;
  alreadyPersistedCount: number;
}): Promise<void> {
  const {
    session,
    state,
    newRunItems,
    extraInputItems = [],
    lastResponseId,
    alreadyPersistedCount,
  } = options;

  if (!session) {
    return;
  }

  const itemsToSave = [
    ...extraInputItems,
    ...extractOutputItemsFromRunItems(newRunItems),
  ];

  if (itemsToSave.length === 0) {
    state._currentTurnPersistedItemCount =
      alreadyPersistedCount + newRunItems.length;
    await runCompactionOnSession(session, lastResponseId, state);
    return;
  }

  const sanitizedItems = normalizeItemsForSessionPersistence(itemsToSave);
  await session.addItems(sanitizedItems);
  await runCompactionOnSession(session, lastResponseId, state);
  state._currentTurnPersistedItemCount =
    alreadyPersistedCount + newRunItems.length;
}

async function runCompactionOnSession(
  session: Session | undefined,
  responseId: string | undefined,
  state: RunState<any, any>,
): Promise<void> {
  if (!isOpenAIResponsesCompactionAwareSession(session)) {
    return;
  }
  const store =
    state._lastModelSettings?.store ?? state._currentAgent.modelSettings?.store;
  const compactionArgs =
    typeof responseId === 'undefined' && typeof store === 'undefined'
      ? undefined
      : {
          ...(typeof responseId === 'undefined' ? {} : { responseId }),
          ...(typeof store === 'undefined' ? {} : { store }),
        };
  const compactionResult = await session.runCompaction(compactionArgs);
  if (!compactionResult) {
    return;
  }
  const usage = compactionResult.usage;
  state._context.usage.add(
    new Usage({
      requests: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      inputTokensDetails: usage.inputTokensDetails,
      outputTokensDetails: usage.outputTokensDetails,
      requestUsageEntries: [usage],
    }),
  );
}

function buildItemFrequencyMap(items: AgentInputItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getAgentInputItemKey(item);
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
