import { matchingRuntime } from '@openai/agents-core/_shims';
import { user, assistant, system } from '../helpers/message';
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
    if (
      !(i in items) ||
      runtime.lookupGetter.call(items, i) ||
      items[i] === undefined
    )
      return false;
  }
  return true;
}

// A native batch visits shared children only once. Decline objects that
// could run application code while another occurrence is being copied.
function isTextRecord(
  value: unknown,
  runtime: Runtime,
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !runtime.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !('Infinity' in value) &&
    !Array.isArray(value) &&
    !runtime.isMap(value) &&
    !runtime.isSet(value) &&
    !runtime.isNativeError(value) &&
    !Object.getOwnPropertySymbols(value).length
  );
}

function hasTextFields(
  value: object,
  runtime: Runtime,
  keys: string[],
): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    if (actual[i] !== keys[i] || runtime.lookupGetter.call(value, keys[i]))
      return false;
  }
  return true;
}

function isTextList(
  value: unknown,
  runtime: Runtime,
  size: number,
): value is unknown[] {
  if (
    runtime.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== size ||
    Object.getOwnPropertySymbols(value).length
  )
    return false;
  const keys = Object.keys(value);
  return (
    keys.length === size &&
    (!size || (keys[0] === '0' && !runtime.lookupGetter.call(value, 0)))
  );
}

type WriteText = (text: string) => MessageItem;
function annotatedPart(text: string) {
  return { type: 'output_text' as const, text, annotations: [] };
}

// These layouts differ in both field order and own undefined metadata.
const plain = {
  keys: ['role', 'content'],
  replyKeys: ['role', 'content', 'status'],
  user: (content: string): MessageItem => ({ role: 'user', content }),
  system: (content: string): MessageItem => ({ role: 'system', content }),
  assistant: (text: string): MessageItem => ({
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    status: 'completed',
  }),
  annotated: (text: string): MessageItem => ({
    role: 'assistant',
    content: [annotatedPart(text)],
    status: 'completed',
  }),
};
const helpers = {
  keys: ['type', 'role', 'content', 'providerData'],
  replyKeys: ['type', 'role', 'content', 'status', 'providerData'],
  user,
  system,
  assistant,
  annotated: (text: string): MessageItem =>
    helpers.assistant([annotatedPart(text)]),
};
const textKeys = ['type', 'text'];
const annotatedKeys = ['type', 'text', 'annotations'];

function textFormat(item: unknown, runtime: Runtime): WriteText | undefined {
  if (!isTextRecord(item, runtime)) return;
  const helper = 'type' in item;
  const reply = 'status' in item;
  const layout = helper ? helpers : plain;
  const keys = reply ? layout.replyKeys : layout.keys;
  if (
    !hasTextFields(item, runtime, keys) ||
    (helper && (item.type !== 'message' || item.providerData !== undefined))
  )
    return;
  if (typeof item.content === 'string' && !reply) {
    if (item.role === 'system') return layout.system;
    if (item.role === 'user' && !helper) return plain.user;
  }
  if (!isTextList(item.content, runtime, 1)) return;
  const part = item.content[0];
  if (!isTextRecord(part, runtime)) return;
  const annotated = 'annotations' in part;
  if (
    !hasTextFields(part, runtime, annotated ? annotatedKeys : textKeys) ||
    typeof part.text !== 'string'
  )
    return;
  if (!reply) {
    if (
      helper &&
      item.role === 'user' &&
      part.type === 'input_text' &&
      !annotated
    )
      return helpers.user;
    return;
  }
  if (
    item.role !== 'assistant' ||
    item.status !== 'completed' ||
    part.type !== 'output_text'
  )
    return;
  if (!annotated) return layout.assistant;
  if (isTextList(part.annotations, runtime, 0)) return layout.annotated;
}

function messageReader(formats: WriteText[], texts: string[]) {
  // Keep only immutable text. Recovery uses the current capture's allocator
  // and creates independent, writable objects for every occurrence.
  const from = Array.from;
  const range = { __proto__: null, length: texts.length };
  return () => from(range, (_, index) => formats[index](texts[index]));
}

export function captureTextHistory(
  items: AgentInputItem[],
  original?: AgentInputItem[],
) {
  if (original && original.length < 32) return;
  const runtime = matchingRuntime();
  if (
    !runtime ||
    runtime.isProxy(items) ||
    !Array.isArray(items) ||
    items.length < 32 ||
    items.length > 32768 ||
    !dense(items, runtime)
  )
    return;
  const sources = original ?? [...items];
  if (sources.length !== items.length) return;
  const formats: WriteText[] = [];
  const texts: string[] = [];
  // Bound the temporary native graph. Oversized histories use individual copies.
  let textBudget = 8 * 1024 * 1024;
  for (let index = 0; index < sources.length; index++) {
    const item = sources[index];
    if (item !== items[index]) return;
    const write = textFormat(item, runtime);
    if (!write || !('role' in item)) return;
    formats.push(write);
    const content = item.content;
    if (typeof content === 'string') texts.push(content);
    else if ('text' in content[0]) texts.push(content[0].text);
    else return;
    textBudget -= texts[index].length;
    if (textBudget < 0) return;
  }
  // Validate the live native clone policy at each boundary. Built-ins with
  // ordinary prototypes can still serialize as a different kind of value.
  const copies = structuredClone(sources);
  if (!Array.isArray(copies)) return;
  for (let i = 0; i < copies.length; i++) {
    const item = copies[i];
    if (Object.getPrototypeOf(item) !== Object.prototype || !('role' in item))
      return;
    if (typeof item.content === 'string') {
      if (item.content !== texts[i]) return;
    } else {
      const part = item.content[0];
      if (
        !part ||
        Object.getPrototypeOf(part) !== Object.prototype ||
        !('text' in part) ||
        part.text !== texts[i]
      )
        return;
    }
  }
  return { sources, read: messageReader(formats, texts) };
}

// Compare only shallow text data. Checking accessors preserves the original
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
    return (
      0 in a &&
      0 in b &&
      !runtime.lookupGetter.call(a, 0) &&
      !runtime.lookupGetter.call(b, 0) &&
      sameText(a[0], b[0], runtime, depth + 1)
    );
  }
  const first = Object.keys(a);
  const second = Object.keys(b);
  if (first.length !== second.length || first.length > (depth ? 4 : 5))
    return false;
  let hasType = false;
  for (let i = 0; i < first.length; i++) {
    const key = first[i];
    if (key !== second[i] || key.length > 32) return false;
    if (runtime.lookupGetter.call(a, key) || runtime.lookupGetter.call(b, key))
      return false;
    const left = (a as Record<string, unknown>)[key];
    const right = (b as Record<string, unknown>)[key];
    // The message helpers include this field even without provider metadata.
    if (key === 'providerData' && left === undefined && right === undefined)
      continue;
    if (key === 'type') {
      if (left === 'Buffer') return false;
      hasType = true;
    }
    if (!sameText(left, right, runtime, depth + 1)) return false;
  }
  return hasType || (!('type' in a) && !('type' in b));
}

export function matchesOrderedInput(
  original: AgentInputItem[],
  prepared: AgentInputItem[],
  processed: AgentInputItem[],
  positions: { preparedIndex: number; ownerIndex: number }[] | number,
): boolean {
  // On short inputs the existing lookup costs less than checking traversal.
  const count = typeof positions === 'number' ? positions : positions.length;
  if (count < 32) return false;
  const runtime = matchingRuntime();
  if (
    !runtime ||
    !dense(original, runtime) ||
    !dense(prepared, runtime) ||
    (prepared !== processed && !dense(processed, runtime)) ||
    (typeof positions !== 'number' && !dense(positions, runtime)) ||
    prepared.length !== original.length ||
    processed.length !== original.length ||
    count !== original.length
  )
    return false;
  // A reused root takes precedence over an equal clone from another position.
  const references = new Set(original);
  for (let i = 0; i < prepared.length; i++) {
    if (typeof positions !== 'number') {
      const position = positions[i];
      if (
        !position ||
        typeof position !== 'object' ||
        runtime.isProxy(position) ||
        Object.getPrototypeOf(position) !== Object.prototype ||
        'Infinity' in position ||
        Object.getOwnPropertyDescriptor(position, 'preparedIndex')?.value !==
          i ||
        Object.getOwnPropertyDescriptor(position, 'ownerIndex')?.value !== i
      )
        return false;
    }
    if (prepared[i] !== processed[i] || references.has(prepared[i]))
      return false;
    if (!sameText(original[i], prepared[i], runtime, 0)) return false;
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
    Object.keys(item).some((key) =>
      key === 'providerData'
        ? item.providerData !== undefined
        : !['role', 'content', 'type', 'status'].includes(key),
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

export type OrderedSnapshot = {
  length: number;
  read: () => MessageItem[];
  restore?: () => MessageItem[];
};

export type OrderedInput = {
  unobserved?: (result: FilterApplicationResult) => OrderedSnapshot | undefined;
};

export function prepareTextInput(
  ordered: OrderedInput,
  input: AgentInputItem[],
  originals: WeakMap<object, AgentInputItem> | AgentInputItem[],
  instructions: string | undefined,
  restore?: () => MessageItem[],
): FilterApplicationResult | undefined {
  if (!canCopyMessages(input)) return;
  let saved: MessageItem[] | undefined;
  if (!restore) {
    saved = [];
    for (const item of input) {
      if (!isTextMessage(item)) return;
      saved.push(copyText(item));
    }
  }
  // The two preparation stages see the same writable array. Recovery uses
  // restore separately so edits to this array can't change its snapshot.
  const read = () => (saved ??= restore!());
  let visible: () => AgentInputItem[] = read;
  let unobserved: OrderedSnapshot | undefined = {
    length: input.length,
    read,
    restore,
  };
  // Promise observers can edit or mark these items before the runner resumes.
  // Any such read restores the regular per-item native capture.
  const result: FilterApplicationResult = {
    modelInput: { input, instructions },
    sourceItems: Array.isArray(originals)
      ? originals
      : input.map((item) => originals.get(item)),
    get persistedItems() {
      unobserved = undefined;
      return visible();
    },
    set persistedItems(items) {
      unobserved = undefined;
      visible = () => items;
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
  prepared: AgentInputItem[],
  sources: (AgentInputItem | undefined)[],
): boolean {
  const runtime = matchingRuntime();
  return (
    !!runtime &&
    dense(sources, runtime) &&
    prepared.length === sources.length &&
    prepared.every((item, index) => sources[index] === item)
  );
}
