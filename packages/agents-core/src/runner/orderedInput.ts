/// <reference lib="es2021.weakref" />
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
  proof?: RecordProof,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (!proof) {
    if (
      runtime.isProxy(value) ||
      Array.isArray(value) ||
      runtime.isBoxedPrimitive(value) ||
      ArrayBuffer.isView(value)
    )
      return false;
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      !('Infinity' in value) &&
      !('toJSON' in value)
    );
  }
  if (!proof.known?.has(value)) {
    proof.known = undefined;
    if (
      runtime.isProxy(value) ||
      Array.isArray(value) ||
      runtime.isMap(value) ||
      runtime.isSet(value) ||
      runtime.isNativeError(value)
    )
      return false;
  }
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    !('Infinity' in value) &&
    (!!proof.known || !Object.getOwnPropertySymbols(value).length)
  );
}

function hasTextFields(
  value: object,
  runtime: Runtime,
  keys: string[],
): boolean {
  let index = 0;
  for (const key in value) {
    if (key !== keys[index++] || runtime.lookupGetter.call(value, key))
      return false;
  }
  return index === keys.length;
}

function isTextList(
  value: unknown,
  runtime: Runtime,
  size: number,
  proof?: RecordProof,
): value is unknown[] {
  if (
    runtime.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== size
  )
    return false;
  if (!proof)
    return (
      !('type' in value || 'Infinity' in value || 'toJSON' in value) &&
      (!size || (0 in value && !runtime.lookupGetter.call(value, 0)))
    );
  let count = 0;
  for (const key in value) {
    if (key !== '0' || runtime.lookupGetter.call(value, 0)) return false;
    count++;
  }
  return count === size;
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

type RecordProof = { known: WeakSet<object> | undefined };
let records: WeakMap<object, WeakRef<WeakSet<object>> | undefined> | undefined;

function remember(key: object, items: AgentInputItem[]) {
  const group: object[] = [...items];
  for (const item of items) {
    if ('content' in item && typeof item.content !== 'string')
      group.push(item.content[0]);
  }
  (records ??= new WeakMap()).set(key, new WeakRef(new WeakSet(group)));
}

function takeRecords(key: object): WeakSet<object> | undefined {
  const known = records?.get(key)?.deref();
  if (known) records?.set(key, undefined);
  return known;
}

export function captureStateInput(input: string | AgentInputItem[]) {
  if (records && typeof input !== 'string') {
    const state = captureTextHistory(input, input, true)?.read();
    if (state) {
      remember(state[0], state);
      return state;
    }
  }
  return structuredClone(input);
}

function textFormat(
  item: unknown,
  runtime: Runtime,
  proof?: RecordProof,
): WriteText | undefined {
  if (!isTextRecord(item, runtime, proof)) return;
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
  if (!isTextList(item.content, runtime, 1, proof)) return;
  const part = item.content[0];
  if (!isTextRecord(part, runtime, proof)) return;
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
  if (isTextList(part.annotations, runtime, 0, proof)) return layout.annotated;
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
  stateCapture = false,
) {
  if (!stateCapture && original && original.length < 32) return;
  const runtime = matchingRuntime();
  if (
    !runtime ||
    runtime.isProxy(items) ||
    !Array.isArray(items) ||
    items.length < 32 ||
    items.length > 32768
  )
    return;
  const proof: RecordProof = {
    known: stateCapture ? takeRecords(items) : undefined,
  };
  if (stateCapture && !proof.known) return;
  if (!dense(items, runtime)) return;
  const sources = original ?? [...items];
  if (sources.length !== items.length) return;
  if (!original) proof.known = takeRecords(sources[0]);
  if (stateCapture) {
    const keys = Object.keys(items);
    if (
      keys.length !== items.length ||
      keys[keys.length - 1] !== '' + (items.length - 1)
    )
      return;
  }
  // Supported layouts have one acyclic path. Unique terminals keep every
  // projected path independent; shared leaves need the native graph copy.
  const terminals = stateCapture ? new Set<unknown>() : undefined;
  const formats: WriteText[] = [];
  const texts: string[] = [];
  // Bound the temporary native graph. Oversized histories use individual copies.
  let textBudget = 8 * 1024 * 1024;
  for (let index = 0; index < sources.length; index++) {
    const item = sources[index];
    if (item !== items[index]) return;
    const write = textFormat(item, runtime, proof);
    if (!write || !('role' in item)) return;
    formats.push(write);
    const content = item.content;
    if (terminals) {
      const last =
        typeof content === 'string'
          ? item
          : 'annotations' in content[0]
            ? content[0].annotations
            : content[0];
      if (!proof.known || terminals.has(last)) return;
      terminals.add(last);
    }
    if (typeof content === 'string') texts.push(content);
    else if ('text' in content[0]) texts.push(content[0].text);
    else return;
    textBudget -= texts[index].length;
    if (textBudget < 0) return;
  }
  // Serialize the known graph before stopping, so late clone marks still throw.
  if (proof.known) {
    const checked = {};
    try {
      structuredClone({
        sources,
        get checked() {
          throw checked;
        },
      });
    } catch (error) {
      if (error !== checked) throw error;
      return { sources, read: messageReader(formats, texts) };
    }
  }
  const copies = structuredClone(sources);
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
  if (original) remember(items, sources);
  return { sources, read: messageReader(formats, texts) };
}

// Check the usual field lists without allocating keys. Unconventional records
// use their own ordered keys; hidden lookups retain native collection behavior.
function sameFields(
  a: unknown,
  b: unknown,
  runtime: Runtime,
  depth: number,
): boolean {
  if (typeof a === 'string') return a.length <= 65536 && a === b;
  if (depth > 3 || !a || typeof a !== 'object' || runtime.isProxy(a))
    return false;
  if (Array.isArray(a)) {
    const size = a.length;
    return (
      size <= 1 &&
      isTextList(a, runtime, size) &&
      isTextList(b, runtime, size) &&
      (!size || sameFields(a[0], b[0], runtime, depth + 1))
    );
  }
  if (!isTextRecord(a, runtime) || !isTextRecord(b, runtime)) return false;
  const layout = 'type' in a ? helpers : plain;
  let keys =
    depth === 0
      ? 'status' in a
        ? layout.replyKeys
        : layout.keys
      : 'annotations' in a
        ? annotatedKeys
        : textKeys;
  if (!hasTextFields(a, runtime, keys)) {
    keys = Object.keys(a);
    if (keys.length > (depth ? 4 : 5) || !hasTextFields(a, runtime, keys))
      return false;
  }
  if (!hasTextFields(b, runtime, keys)) return false;
  if (!keys.includes('type') && ('type' in a || 'type' in b)) return false;
  for (const key of keys) {
    if (key.length > 32) return false;
    const left = a[key],
      right = b[key];
    if (key === 'providerData' && left === undefined && right === undefined)
      continue;
    if (key === 'type' && left === 'Buffer') return false;
    if (!sameFields(left, right, runtime, depth + 1)) return false;
  }
  return true;
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
    if (!sameFields(original[i], prepared[i], runtime, 0)) return false;
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
