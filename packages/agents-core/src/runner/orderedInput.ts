import { matchingRuntime } from '@openai/agents-core/_shims';
import type { AgentInputItem } from '../types';
import type { MessageItem } from '../types/protocol';
import type { FilterApplicationResult } from './conversation';

type Runtime = NonNullable<ReturnType<typeof matchingRuntime>>;

function ordinaryArray(items: unknown[], runtime: Runtime): boolean {
  return (
    !runtime.isProxy(items) &&
    Array.isArray(items) &&
    Object.getPrototypeOf(items) === Array.prototype &&
    !['constructor', 'map', 'entries', 'flatMap', Symbol.iterator].some((key) =>
      Object.prototype.hasOwnProperty.call(items, key),
    )
  );
}

export function canCopyMessages(items: unknown[]): boolean {
  const runtime = matchingRuntime();
  return !!runtime && ordinaryArray(items, runtime);
}

function dense(items: unknown[], runtime: Runtime): boolean {
  if (!ordinaryArray(items, runtime)) return false;
  for (let i = 0; i < items.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(items, i);
    if (!entry || !('value' in entry)) return false;
  }
  return true;
}

// Compare only shallow text data. Reading descriptors preserves the original
// serializer's first read of each accessor, including hidden type and toJSON.
function sameText(
  a: unknown,
  b: unknown,
  runtime: Runtime,
  depth: number,
): boolean {
  if (typeof a === 'string') return a.length <= 65536 && a === b;
  if (
    depth > 3 ||
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    runtime.isProxy(a) ||
    runtime.isProxy(b)
  )
    return false;
  const list = Array.isArray(a);
  const prototype = list ? Array.prototype : Object.prototype;
  if (
    list !== Array.isArray(b) ||
    Object.getPrototypeOf(a) !== prototype ||
    Object.getPrototypeOf(b) !== prototype ||
    'Infinity' in a ||
    'Infinity' in b ||
    'toJSON' in a ||
    'toJSON' in b ||
    runtime.isBoxedPrimitive(a) ||
    runtime.isBoxedPrimitive(b) ||
    ArrayBuffer.isView(a) ||
    ArrayBuffer.isView(b)
  )
    return false;
  if (list && Array.isArray(b)) {
    if ('type' in a || 'type' in b || a.length !== b.length || a.length > 1)
      return false;
    if (!a.length) return true;
    const left = Object.getOwnPropertyDescriptor(a, 0);
    const right = Object.getOwnPropertyDescriptor(b, 0);
    return (
      !!left &&
      !!right &&
      'value' in left &&
      'value' in right &&
      sameText(left.value, right.value, runtime, depth + 1)
    );
  }
  const first = Object.keys(a);
  const second = Object.keys(b);
  if (first.length !== second.length || first.length > 4) return false;
  let hasType = false;
  for (let i = 0; i < first.length; i++) {
    const key = first[i];
    if (key !== second[i] || key.length > 32) return false;
    const left = Object.getOwnPropertyDescriptor(a, key);
    const right = Object.getOwnPropertyDescriptor(b, key);
    if (!left || !right || !('value' in left) || !('value' in right))
      return false;
    if (key === 'type') {
      if (left.value === 'Buffer') return false;
      hasType = true;
    }
    if (!sameText(left.value, right.value, runtime, depth + 1)) return false;
  }
  return hasType || (!('type' in a) && !('type' in b));
}

export function matchesOrderedInput(
  original: AgentInputItem[],
  prepared: AgentInputItem[],
  processed: AgentInputItem[],
  positions: { preparedIndex: number; ownerIndex: number }[],
): boolean {
  // On short inputs the existing lookup costs less than checking traversal.
  if (positions.length < 32) return false;
  const runtime = matchingRuntime();
  if (
    !runtime ||
    !dense(original, runtime) ||
    !dense(prepared, runtime) ||
    !dense(processed, runtime) ||
    !dense(positions, runtime) ||
    prepared.length !== original.length ||
    processed.length !== original.length ||
    positions.length !== original.length
  )
    return false;
  // A reused root takes precedence over an equal clone from another position.
  const references = new Set(original);
  for (let i = 0; i < prepared.length; i++) {
    const position = positions[i];
    if (
      !position ||
      typeof position !== 'object' ||
      runtime.isProxy(position) ||
      Object.getPrototypeOf(position) !== Object.prototype ||
      'Infinity' in position ||
      Object.getOwnPropertyDescriptor(position, 'preparedIndex')?.value !== i ||
      Object.getOwnPropertyDescriptor(position, 'ownerIndex')?.value !== i ||
      prepared[i] !== processed[i] ||
      references.has(prepared[i]) ||
      !sameText(original[i], prepared[i], runtime, 0)
    )
      return false;
  }
  return true;
}

// Called on fresh native copies. Other fields, including provider metadata,
// need normal deduplication, binary handling and independent native copies.
function isTextMessage(item: AgentInputItem): item is MessageItem {
  if (
    !item ||
    Object.getPrototypeOf(item) !== Object.prototype ||
    !('role' in item) ||
    !('content' in item) ||
    Object.keys(item).some(
      (key) => !['role', 'content', 'type', 'status'].includes(key),
    )
  )
    return false;
  if (item.type !== undefined && item.type !== 'message') return false;
  if ('status' in item && typeof item.status !== 'string') return false;
  if (typeof item.content === 'string')
    return item.role === 'user' || item.role === 'system';
  if (item.role !== 'assistant' && item.role !== 'user') return false;
  const content = item.content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    Object.keys(content).length !== 1 ||
    !(0 in content)
  )
    return false;
  const part = content[0];
  if (
    !part ||
    Object.getPrototypeOf(part) !== Object.prototype ||
    (part.type !== 'output_text' && part.type !== 'input_text') ||
    typeof part.text !== 'string' ||
    Object.keys(part).some(
      (key) => !['type', 'text', 'annotations'].includes(key),
    )
  )
    return false;
  return (
    !('annotations' in part) ||
    (Array.isArray(part.annotations) &&
      part.annotations.length === 0 &&
      Object.keys(part.annotations).length === 0)
  );
}

export function copyText(item: MessageItem): MessageItem {
  if (typeof item.content === 'string') return { ...item };
  const part = { ...item.content[0] };
  if (
    'annotations' in part &&
    Object.prototype.hasOwnProperty.call(part, 'annotations')
  ) {
    part.annotations = [];
  }
  return { ...item, content: [part] } as MessageItem;
}

export type OrderedInput = {
  unobserved?: (result: FilterApplicationResult) => MessageItem[] | undefined;
};

export function prepareTextInput(
  ordered: OrderedInput,
  input: AgentInputItem[],
  originals: WeakMap<object, AgentInputItem>,
  instructions: string | undefined,
): FilterApplicationResult | undefined {
  if (!canCopyMessages(input)) return;
  const saved: MessageItem[] = [];
  for (const item of input) {
    if (!isTextMessage(item)) return;
    saved.push(copyText(item));
  }
  let visible: AgentInputItem[] = saved;
  let unobserved: MessageItem[] | undefined = saved;
  // Promise observers can edit or mark these items before the runner resumes.
  // Any such read restores the regular per-item native capture.
  const result: FilterApplicationResult = {
    modelInput: { input, instructions },
    sourceItems: input.map((item) => originals.get(item)),
    get persistedItems() {
      unobserved = undefined;
      return visible;
    },
    set persistedItems(items) {
      unobserved = undefined;
      visible = items;
    },
    sourceMatchKinds: input.map(() => 'identity'),
    filterApplied: false,
    preserveInputIdentity: false,
  };
  const getter = Object.getOwnPropertyDescriptor(result, 'persistedItems')!.get;
  ordered.unobserved = (received) => {
    if (
      unobserved &&
      received === result &&
      Object.getOwnPropertyDescriptor(result, 'persistedItems')?.get === getter
    )
      return unobserved;
  };
  return result;
}

export function matchesSources(
  prepared: { item: AgentInputItem; ownerIndex: number }[],
  sources: (AgentInputItem | undefined)[],
): boolean {
  const runtime = matchingRuntime();
  return (
    !!runtime &&
    dense(sources, runtime) &&
    prepared.length === sources.length &&
    prepared.every(
      ({ item, ownerIndex }, index) =>
        ownerIndex === index && sources[index] === item,
    )
  );
}
