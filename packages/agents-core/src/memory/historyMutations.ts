import type { AgentInputItem } from '../types';
import { UserError } from '../errors';
import type {
  SessionHistoryExpectedFunctionCallMutation,
  SessionHistoryMutation,
} from './session';

const OPTIONAL_FUNCTION_CALL_FIELDS = new Set([
  'id',
  'namespace',
  'status',
  'providerData',
  'caller',
]);

/**
 * Applies persisted-history mutations and returns a new canonical item list.
 */
export function applySessionHistoryMutations(
  items: AgentInputItem[],
  mutations: SessionHistoryMutation[],
): AgentInputItem[] {
  if (mutations.length === 0) {
    return items.map(cloneSessionHistoryValueSafely);
  }
  const normalizedMutations = snapshotSessionHistoryMutations(mutations);

  let itemValues: unknown[];
  try {
    itemValues = readDenseArrayDataValues(items);
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }

  const replacementsByIndex = new Map<
    number,
    Extract<AgentInputItem, { type: 'function_call' }>
  >();
  for (const mutation of normalizedMutations) {
    if (
      mutation.type !== 'replace_function_call' ||
      mutation.expected === undefined
    ) {
      continue;
    }
    const plannedReplacement = planExpectedFunctionCallReplacement(
      itemValues,
      mutation as SessionHistoryExpectedFunctionCallMutation,
    );
    if (!plannedReplacement) {
      continue;
    }
    const existingReplacement = replacementsByIndex.get(
      plannedReplacement.index,
    );
    if (
      existingReplacement &&
      !sessionHistoryItemsMatch(
        existingReplacement,
        plannedReplacement.replacement,
      )
    ) {
      throw new UserError(
        `Session history mutations contain conflicting replacements for call ID ${mutation.callId}.`,
      );
    }
    replacementsByIndex.set(
      plannedReplacement.index,
      plannedReplacement.replacement,
    );
  }

  let nextItems = itemValues.map((item, index) => {
    const replacement = replacementsByIndex.get(index);
    return cloneSessionHistoryValueSafely(replacement ?? item);
  }) as AgentInputItem[];

  for (const mutation of normalizedMutations) {
    if (
      mutation.type === 'replace_function_call' &&
      mutation.expected === undefined
    ) {
      nextItems = applyLegacyReplaceFunctionCallMutation(
        nextItems,
        mutation.callId,
        cloneSessionHistoryValueSafely(mutation.replacement),
      );
    }
  }

  return nextItems;
}

function planExpectedFunctionCallReplacement(
  itemValues: unknown[],
  mutation: SessionHistoryExpectedFunctionCallMutation,
):
  | {
      index: number;
      replacement: Extract<AgentInputItem, { type: 'function_call' }>;
    }
  | undefined {
  const replacement = cloneSessionHistoryValueSafely(mutation.replacement);

  let matchingIndex = -1;
  let replacementAlreadyApplied = false;
  try {
    for (let index = itemValues.length - 1; index >= 0; index -= 1) {
      const item = itemValues[index];
      const candidate = snapshotMatchingFunctionCall(item, mutation.callId);
      if (!candidate) {
        continue;
      }
      if (sessionHistoryItemsMatch(candidate, mutation.expected)) {
        matchingIndex = index;
        break;
      }
      if (sessionHistoryItemsMatch(candidate, replacement)) {
        replacementAlreadyApplied = true;
        break;
      }
    }
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }

  if (replacementAlreadyApplied) {
    return undefined;
  }
  if (matchingIndex < 0) {
    throw new UserError(
      `Session history mutation could not find the expected function call for call ID ${mutation.callId}.`,
    );
  }

  return { index: matchingIndex, replacement };
}

function applyLegacyReplaceFunctionCallMutation(
  items: AgentInputItem[],
  callId: string,
  replacement: Extract<AgentInputItem, { type: 'function_call' }>,
): AgentInputItem[] {
  const nextItems: AgentInputItem[] = [];
  let keptReplacement = false;

  for (const item of items) {
    if (item.type === 'function_call' && item.callId === callId) {
      if (!keptReplacement) {
        nextItems.push(replacement);
        keptReplacement = true;
      }
      continue;
    }
    nextItems.push(cloneSessionHistoryValueSafely(item));
  }

  return nextItems;
}

export function sessionHistoryItemsMatch(
  actual: AgentInputItem,
  expected: AgentInputItem,
): boolean {
  try {
    return (
      JSON.stringify(sortSessionHistoryValue(actual, new WeakSet(), true)) ===
      JSON.stringify(sortSessionHistoryValue(expected, new WeakSet(), true))
    );
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

export function sessionHistoryValuesMatch(
  actual: unknown,
  expected: unknown,
): boolean {
  try {
    return (
      JSON.stringify(sortSessionHistoryValue(actual)) ===
      JSON.stringify(sortSessionHistoryValue(expected))
    );
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

export function snapshotSessionHistoryValue<T>(value: T): T {
  try {
    return sortSessionHistoryValue(value) as T;
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

export function snapshotSessionHistoryItem<T extends AgentInputItem>(
  value: T,
): T {
  try {
    return sortSessionHistoryValue(value, new WeakSet(), true) as T;
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

export function snapshotSessionHistoryFunctionCallCandidates(
  value: unknown,
  callId: string,
): Array<Extract<AgentInputItem, { type: 'function_call' }>> {
  try {
    const candidates: Array<
      Extract<AgentInputItem, { type: 'function_call' }>
    > = [];
    for (const item of readDenseArrayDataValues(value)) {
      const snapshot = snapshotMatchingFunctionCall(item, callId);
      if (snapshot) {
        candidates.push(snapshot);
      }
    }
    return candidates;
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

export function snapshotSingleSessionHistoryFunctionCall(
  value: unknown,
): Extract<AgentInputItem, { type: 'function_call' }> {
  try {
    const values = readDenseArrayDataValues(value);
    if (values.length !== 1) {
      throw new TypeError(
        'Exactly one function-call history item is required.',
      );
    }
    const snapshot = sortSessionHistoryValue(values[0], new WeakSet(), true);
    if (!isFunctionCallSnapshot(snapshot)) {
      throw new TypeError('Invalid function-call history item.');
    }
    return snapshot;
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

function cloneSessionHistoryValueSafely<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

export function snapshotSessionHistoryMutations(
  mutations: SessionHistoryMutation[],
): SessionHistoryMutation[] {
  try {
    return mutations.map((mutation) => {
      const descriptors = Object.getOwnPropertyDescriptors(mutation);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
        if (descriptor.enumerable && !('value' in descriptor)) {
          throw new TypeError(
            'Accessor-backed session history mutation is unsupported.',
          );
        }
      }

      const type = readMutationDataProperty(descriptors, 'type');
      const callId = readMutationDataProperty(descriptors, 'callId');
      const replacement = readMutationDataProperty(descriptors, 'replacement');
      const expectedDescriptor = descriptors.expected;
      if (
        type !== 'replace_function_call' ||
        typeof callId !== 'string' ||
        replacement === undefined ||
        (expectedDescriptor !== undefined && !('value' in expectedDescriptor))
      ) {
        throw new TypeError('Invalid session history mutation.');
      }

      const expected = expectedDescriptor?.value;
      if (expected === undefined) {
        return {
          type,
          callId,
          replacement: replacement as Extract<
            AgentInputItem,
            { type: 'function_call' }
          >,
        };
      }

      const expectedSnapshot = sortSessionHistoryValue(
        expected,
        new WeakSet(),
        true,
      );
      const replacementSnapshot = sortSessionHistoryValue(
        replacement,
        new WeakSet(),
        true,
      );
      if (
        !isFunctionCallSnapshot(expectedSnapshot) ||
        !isFunctionCallSnapshot(replacementSnapshot)
      ) {
        throw new TypeError('Invalid expected-bearing history mutation.');
      }
      return {
        type,
        callId,
        expected: expectedSnapshot,
        replacement: replacementSnapshot,
      };
    });
  } catch {
    throw new UserError('Session history items could not be compared safely.');
  }
}

function readMutationDataProperty(
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !('value' in descriptor)) {
    throw new TypeError('Invalid session history mutation.');
  }
  return descriptor.value;
}

function snapshotMatchingFunctionCall(
  value: unknown,
  callId: string,
): Extract<AgentInputItem, { type: 'function_call' }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const typeDescriptor = descriptors.type;
  if (!typeDescriptor || !('value' in typeDescriptor)) {
    throw new TypeError('Invalid session history item type.');
  }
  if (typeDescriptor.value !== 'function_call') {
    return undefined;
  }
  const callIdDescriptor = descriptors.callId;
  if (
    !callIdDescriptor ||
    !('value' in callIdDescriptor) ||
    typeof callIdDescriptor.value !== 'string'
  ) {
    throw new TypeError('Invalid function-call history call ID.');
  }
  if (callIdDescriptor.value !== callId) {
    return undefined;
  }
  const snapshot = sortSessionHistoryValue(value, new WeakSet(), true);
  if (!isFunctionCallSnapshot(snapshot)) {
    throw new TypeError('Invalid function-call history item.');
  }
  return snapshot;
}

function readDenseArrayDataValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Session history items must be an array.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const values: unknown[] = new Array(value.length);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    if (key === 'length' || !descriptor.enumerable) {
      continue;
    }
    if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
      throw new TypeError(
        'Enumerable array properties are unsupported in session history.',
      );
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(
        'Sparse or accessor-backed session history arrays are unsupported.',
      );
    }
    values[index] = descriptor.value;
  }
  return values;
}

function sortSessionHistoryValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
  normalizeFunctionCallItem = false,
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError('Lossy session history number.');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Unsupported session history value.');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic session history value.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return readDenseArrayDataValues(value).map((entry) =>
        sortSessionHistoryValue(entry, ancestors, normalizeFunctionCallItem),
      );
    }
    if (!isPlainObject(value)) {
      throw new TypeError('Unsupported session history object.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const isFunctionCall =
      normalizeFunctionCallItem && isFunctionCallDescriptorMap(descriptors);
    const entries: Array<[string, unknown]> = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (!descriptor.enumerable) {
        continue;
      }
      if (typeof key !== 'string') {
        throw new TypeError(
          'Enumerable symbol properties are unsupported in session history.',
        );
      }
      if (!('value' in descriptor)) {
        throw new TypeError('Accessor-backed session history is unsupported.');
      }
      if (
        isFunctionCall &&
        OPTIONAL_FUNCTION_CALL_FIELDS.has(key) &&
        descriptor.value === undefined
      ) {
        continue;
      }
      entries.push([
        key,
        sortSessionHistoryValue(descriptor.value, ancestors, false),
      ]);
    }
    entries.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function isFunctionCallDescriptorMap(
  descriptors: PropertyDescriptorMap,
): boolean {
  return (
    hasStringDataProperty(descriptors, 'type', 'function_call') &&
    hasStringDataProperty(descriptors, 'callId') &&
    hasStringDataProperty(descriptors, 'name') &&
    hasStringDataProperty(descriptors, 'arguments')
  );
}

function hasStringDataProperty(
  descriptors: PropertyDescriptorMap,
  key: string,
  expected?: string,
): boolean {
  const descriptor = descriptors[key];
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    typeof descriptor.value === 'string' &&
    (expected === undefined || descriptor.value === expected)
  );
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFunctionCallSnapshot(
  value: unknown,
): value is Extract<AgentInputItem, { type: 'function_call' }> {
  return (
    isPlainObject(value) &&
    value.type === 'function_call' &&
    typeof value.callId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.arguments === 'string'
  );
}
