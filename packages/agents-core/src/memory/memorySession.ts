import { randomUUID } from '@openai/agents-core/_shims';

import type { AgentInputItem } from '../types';
import type {
  SessionHistoryExpectedRewriteAwareSession,
  SessionHistoryRewriteArgs,
  SessionHistoryTransaction,
  SessionHistoryTransactionArgs,
  SessionHistoryTransactionAwareSession,
} from './session';
import { applySessionHistoryMutations } from './historyMutations';
import { UserError } from '../errors';
import { logger, Logger } from '../logger';
import { ModelItem } from '../types/protocol';

export type MemorySessionOptions = {
  sessionId?: string;
  initialItems?: AgentInputItem[];
  logger?: Logger;
};

/**
 * Simple in-memory session store intended for demos or tests. Not recommended for production use.
 */
export class MemorySession
  implements
    SessionHistoryExpectedRewriteAwareSession,
    SessionHistoryTransactionAwareSession
{
  readonly supportsExpectedHistoryMutations = true;

  private readonly sessionId: string;
  private readonly logger: Logger;

  private items: AgentInputItem[];
  private appliedHistoryTransactions = new Map<
    string,
    SessionHistoryTransaction
  >();

  constructor(options: MemorySessionOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.items = options.initialItems
      ? options.initialItems.map(cloneAgentItem)
      : [];
    this.logger = options.logger ?? logger;
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit === undefined) {
      const cloned = this.items.map(cloneAgentItem);
      if (!this.logger.dontLogModelData && !this.logger.dontLogToolData) {
        this.logger.debug(
          `Getting items from memory session (${this.sessionId}): ${JSON.stringify(cloned)}`,
        );
      }
      return cloned;
    }
    if (limit <= 0) {
      return [];
    }
    const start = Math.max(this.items.length - limit, 0);
    const items = this.items.slice(start).map(cloneAgentItem);
    if (!this.logger.dontLogModelData && !this.logger.dontLogToolData) {
      this.logger.debug(
        `Getting items from memory session (${this.sessionId}): ${JSON.stringify(items)}`,
      );
    }
    return items;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const cloned = items.map(cloneAgentItem);
    if (!this.logger.dontLogModelData && !this.logger.dontLogToolData) {
      this.logger.debug(
        `Adding items to memory session (${this.sessionId}): ${JSON.stringify(cloned)}`,
      );
    }
    this.items = [...this.items, ...cloned];
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.items.length === 0) {
      return undefined;
    }
    const item = this.items[this.items.length - 1];
    const cloned = cloneAgentItem(item);
    if (!this.logger.dontLogModelData && !this.logger.dontLogToolData) {
      this.logger.debug(
        `Popping item from memory session (${this.sessionId}): ${JSON.stringify(cloned)}`,
      );
    }
    this.items = this.items.slice(0, -1);
    return cloned;
  }

  async clearSession(): Promise<void> {
    this.logger.debug(`Clearing memory session (${this.sessionId})`);
    this.items = [];
    this.appliedHistoryTransactions = new Map();
  }

  async applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> {
    if (args.mutations.length === 0) {
      return;
    }
    this.items = applySessionHistoryMutations(this.items, args.mutations);
  }

  async applyHistoryTransaction(
    args: SessionHistoryTransactionArgs,
  ): Promise<void> {
    const { operationId, transaction } = snapshotHistoryTransactionArgs(args);
    const existing = this.appliedHistoryTransactions.get(operationId);
    if (existing) {
      if (!structurallyEqual(existing, transaction)) {
        throw new UserError(
          'Session history operation was already applied with a different transaction.',
        );
      }
      return;
    }

    let nextItems: AgentInputItem[];
    if (transaction.type === 'append_items') {
      nextItems = [...this.items, ...transaction.items.map(cloneAgentItem)];
    } else {
      const { expectedSuffix, replacement } = transaction;
      const suffixStart = this.items.length - expectedSuffix.length;
      const actualSuffix = suffixStart < 0 ? [] : this.items.slice(suffixStart);
      const actualSuffixSnapshot = trySnapshotAgentItems(actualSuffix);
      if (
        suffixStart < 0 ||
        !actualSuffixSnapshot ||
        !structurallyEqual(actualSuffixSnapshot, expectedSuffix)
      ) {
        throw new UserError(
          'Session history suffix no longer matches the transaction precondition.',
        );
      }
      nextItems = [
        ...this.items.slice(0, suffixStart),
        ...replacement.map(cloneAgentItem),
      ];
    }

    const nextTransactions = new Map(this.appliedHistoryTransactions);
    nextTransactions.set(operationId, transaction);
    this.items = nextItems;
    this.appliedHistoryTransactions = nextTransactions;
  }
}

function cloneAgentItem<T extends AgentInputItem>(item: T): T {
  return structuredClone(item);
}

function snapshotHistoryTransactionArgs(
  args: SessionHistoryTransactionArgs,
): SessionHistoryTransactionArgs {
  let operationId: unknown;
  let transaction: unknown;
  try {
    if (!args || typeof args !== 'object') {
      throw new Error('Missing transaction arguments.');
    }
    operationId = Reflect.get(args, 'operationId');
    transaction = Reflect.get(args, 'transaction');
  } catch {
    throw new UserError('Session history transaction arguments are invalid.');
  }
  if (typeof operationId !== 'string' || !operationId.trim()) {
    throw new UserError(
      'Session history transaction operationId must be a non-empty string.',
    );
  }
  if (!transaction || typeof transaction !== 'object') {
    throw new UserError('Session history transaction must be an object.');
  }
  return {
    operationId,
    transaction: snapshotHistoryTransaction(transaction),
  };
}

function snapshotHistoryTransaction(
  transaction: object,
): SessionHistoryTransaction {
  let snapshot: unknown;
  try {
    snapshot = snapshotSupportedValue(transaction);
    structuredClone(transaction);
  } catch {
    throw new UserError(
      'Session history transaction items contain invalid or unsupported data.',
    );
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new UserError('Session history transaction must be an object.');
  }
  const record = snapshot as Record<string, unknown>;
  if (record.type === 'append_items') {
    if (
      Object.keys(record).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(record, 'type') ||
      !Object.prototype.hasOwnProperty.call(record, 'items') ||
      !Array.isArray(record.items)
    ) {
      throw new UserError(
        'Session history append transaction fields are invalid.',
      );
    }
    try {
      return {
        type: record.type,
        items: snapshotAgentItems(record.items),
      };
    } catch {
      throw new UserError(
        'Session history transaction items contain invalid or unsupported data.',
      );
    }
  }
  if (record.type !== 'replace_suffix') {
    throw new UserError('Unsupported session history transaction type.');
  }
  if (
    Object.keys(record).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(record, 'type') ||
    !Object.prototype.hasOwnProperty.call(record, 'expectedSuffix') ||
    !Object.prototype.hasOwnProperty.call(record, 'replacement') ||
    !Array.isArray(record.expectedSuffix) ||
    !Array.isArray(record.replacement)
  ) {
    throw new UserError(
      'Session history suffix transaction fields are invalid.',
    );
  }
  try {
    return {
      type: record.type,
      expectedSuffix: snapshotAgentItems(record.expectedSuffix),
      replacement: snapshotAgentItems(record.replacement),
    };
  } catch {
    throw new UserError(
      'Session history transaction items contain invalid or unsupported data.',
    );
  }
}

function snapshotAgentItems(items: AgentInputItem[]): AgentInputItem[] {
  const snapshots = snapshotSupportedValue(items) as AgentInputItem[];
  return snapshots.map((snapshot) => {
    if (!ModelItem.safeParse(snapshot).success) {
      throw new Error('Invalid session history item.');
    }
    return snapshot;
  });
}

function trySnapshotAgentItems(
  items: AgentInputItem[],
): AgentInputItem[] | undefined {
  try {
    return snapshotAgentItems(items);
  } catch {
    return undefined;
  }
}

function snapshotSupportedValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error('Unsupported session history value.');
  }
  if (value instanceof Uint8Array) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length ||
      keys.some(
        (key) =>
          typeof key !== 'string' || !isArrayIndexForLength(key, value.length),
      )
    ) {
      throw new Error('Unsupported session history binary property.');
    }
    return new Uint8Array(value);
  }
  if (ancestors.has(value)) {
    throw new Error('Cyclic session history value.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !('value' in lengthDescriptor)) {
        throw new Error('Unsupported session history array.');
      }
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(value);
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        keys.length !== length + 1 ||
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && !isArrayIndexForLength(key, length)),
        )
      ) {
        throw new Error('Unsupported session history array.');
      }
      const snapshot = new Array<unknown>(length);
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('Unsupported session history array item.');
        }
        snapshot[index] = snapshotSupportedValue(descriptor.value, ancestors);
      }
      return snapshot;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Unsupported session history object.');
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new Error('Unsupported session history property.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error('Unsupported session history property.');
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: snapshotSupportedValue(descriptor.value, ancestors),
        writable: true,
      });
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

function isArrayIndexForLength(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => structurallyEqual(entry, right[index]))
    );
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return (
      left instanceof Uint8Array &&
      right instanceof Uint8Array &&
      left.length === right.length &&
      left.every((byte, index) => byte === right[index])
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  if (
    Object.getPrototypeOf(left) !== Object.prototype ||
    Object.getPrototypeOf(right) !== Object.prototype
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
