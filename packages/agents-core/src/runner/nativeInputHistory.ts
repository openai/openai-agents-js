import type { AgentInputItem } from '../types';
import type { FilterApplicationResult } from './conversation';

/** Opaque ownership token; its primitive snapshot stays in a private WeakMap. */
declare const snapshotBrand: unique symbol;
export type InputSnapshot = { readonly [snapshotBrand]: true };

export type SimpleInput = Pick<
  FilterApplicationResult,
  | 'modelInput'
  | 'sourceItems'
  | 'sourceMatchKinds'
  | 'filterApplied'
  | 'preserveInputIdentity'
> & { snapshot: InputSnapshot };

export interface NativeHistoryBindings {
  sameShape(baseline: unknown, candidate: unknown): boolean;
  classify(value: unknown, ...anchors: unknown[]): number;
  isProxy(value: unknown): boolean;
  markAsUncloneable(value: object): void;
  installSaved(owner: object, key: string, read: () => unknown): boolean;
  isLazyEnvelope(owner: object, key: string): boolean;
  cloneEnvelope(owner: object): object | undefined;
  NodeBuffer: typeof import('node:buffer').Buffer;
}

export interface InputHistoryAccelerator {
  cloneOriginal<T extends string | AgentInputItem[]>(input: T): T;
  captureInitial(
    items: AgentInputItem[],
    original: AgentInputItem[],
  ): InputSnapshot | undefined;
  simpleInput(
    items: AgentInputItem[],
    instructions: string | undefined,
    initial: InputSnapshot,
    original: AgentInputItem[],
  ): SimpleInput | undefined;
  align(
    original: AgentInputItem[],
    count: number,
    prepared: AgentInputItem[],
    processed: AgentInputItem[],
  ): AgentInputItem[] | undefined;
  validateIdentity(
    prepared: AgentInputItem[],
    source: (AgentInputItem | undefined)[],
  ): boolean;
  materialize(snapshot: InputSnapshot): AgentInputItem[];
  installSaved(
    owner: object,
    key: string,
    snapshot: InputSnapshot,
    read?: () => AgentInputItem[],
  ): boolean;
  installEnvelope(
    owner: object,
    key: string,
    read: () => unknown,
  ): (() => boolean) | undefined;
}

const messageLayouts = [
  'role-content',
  'role-content-status',
  'role-status-content',
  'type-role-content',
  'type-role-content-status',
  'type-role-content-provider',
  'type-role-content-status-provider',
] as const;
type MessageLayout = (typeof messageLayouts)[number];
type PartLayout =
  'string' | 'type-text' | 'text-type' | 'type-text-annotations';
interface Layout<T> {
  anchor: object;
  firstKey: string | undefined;
  kind: T;
  hasStatus: boolean;
}
interface TextFields {
  message: MessageLayout;
  part: PartLayout;
  role: 'user' | 'assistant' | 'system';
  text: string;
}
type PlainRecord = Record<string, unknown>;
type Rows = TextFields[];
const maxItemSize = 1024 * 1024;
const maxOriginalSize = 16 * maxItemSize;

export function createInputHistoryAccelerator(
  bindings: NativeHistoryBindings,
): InputHistoryAccelerator | undefined {
  const {
    sameShape,
    classify,
    isProxy,
    markAsUncloneable,
    NodeBuffer,
    installSaved: nativeInstallSaved,
    isLazyEnvelope: nativeIsLazyEnvelope,
    cloneEnvelope: nativeCloneEnvelope,
  } = bindings;
  const defineOwn = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const ownNames = Object.getOwnPropertyNames;
  const prototype = Object.getPrototypeOf;
  const apply = Reflect.apply;
  const functionText = Function.prototype.toString;
  const hasOwn = Object.prototype.hasOwnProperty;
  const arrayPrototype = Array.prototype;
  const objectPrototype = Object.prototype;
  const NativeArray = Array;
  const NativeSet = Set;
  const NativeWeakMap = WeakMap;
  const setPrototype = Set.prototype;
  const setAdd = setPrototype.add;
  const setHas = setPrototype.has;
  const setSize = descriptor(setPrototype, 'size')?.get;
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const nativeClone = globalThis.structuredClone;
  const isBuffer = NodeBuffer.isBuffer;
  const bufferGetter = descriptor(globalThis, 'Buffer')?.get;
  const fields = [
    'role',
    'content',
    'status',
    'id',
    'type',
    'annotations',
    'logprobs',
    'providerData',
    'text',
    'phase',
    'mediaType',
    'then',
    'toJSON',
  ];
  const lifetimeChecks: [object, PropertyKey, unknown][] = [
    [globalThis, 'Object', Object],
    [globalThis, 'Array', Array],
    [globalThis, 'Map', Map],
    [globalThis, 'Set', Set],
    [globalThis, 'WeakMap', WeakMap],
    [globalThis, 'Promise', Promise],
    [globalThis, 'Reflect', Reflect],
    [globalThis, 'Symbol', Symbol],
    [Object, 'getOwnPropertyDescriptor', descriptor],
    [Object, 'getOwnPropertyNames', ownNames],
    [Object, 'getPrototypeOf', prototype],
    [Object, 'defineProperty', defineOwn],
    [Object, 'keys', Object.keys],
    [Object, 'create', Object.create],
    [Reflect, 'apply', apply],
    [Object.prototype, 'hasOwnProperty', hasOwn],
    [Map.prototype, 'get', Map.prototype.get],
    [Map.prototype, 'set', Map.prototype.set],
    [WeakMap.prototype, 'get', weakGet],
    [WeakMap.prototype, 'set', weakSet],
    [WeakMap.prototype, 'delete', WeakMap.prototype.delete],
  ];
  const methodNames: PropertyKey[] = [
    'entries',
    'fill',
    'some',
    'map',
    'filter',
    'flatMap',
    'every',
    'push',
    'slice',
    'values',
    'includes',
    Symbol.iterator,
    'constructor',
  ];
  const methods: [PropertyKey, unknown][] = [];
  for (let i = 0; i < methodNames.length; i++) {
    const key = methodNames[i];
    const value = descriptor(arrayPrototype, key)?.value;
    const name =
      typeof key === 'symbol'
        ? 'values'
        : key === 'constructor'
          ? 'Array'
          : key;
    if (
      typeof value !== 'function' ||
      apply(functionText, value, []) !== `function ${name}() { [native code] }`
    )
      return;
    methods[i] = [key, value];
  }
  const iteratorPrototype = prototype([][Symbol.iterator]());
  const iteratorNext = descriptor(iteratorPrototype, 'next')?.value;
  const species = descriptor(NativeArray, Symbol.species)?.get;
  if (
    !setSize ||
    !species ||
    typeof iteratorNext !== 'function' ||
    apply(functionText, species, []) !==
      'function get [Symbol.species]() { [native code] }' ||
    apply(functionText, iteratorNext, []) !==
      'function next() { [native code] }' ||
    apply(functionText, setAdd, []) !== 'function add() { [native code] }' ||
    apply(functionText, setHas, []) !== 'function has() { [native code] }' ||
    apply(functionText, setSize, []) !== 'function get size() { [native code] }'
  )
    return;

  function append<T>(items: T[], value: T): void {
    const attributes = {
      __proto__: null,
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    };
    defineOwn(items, items.length, attributes);
  }
  function hasIndexedProperty(owner: object): boolean {
    const keys = ownNames(owner);
    for (let i = 0; i < keys.length; i++) {
      const first = keys[i][0];
      if (first >= '0' && first <= '9') return true;
    }
    return false;
  }
  function directWritesSafe(): boolean {
    return (
      prototype(arrayPrototype) === objectPrototype &&
      prototype(objectPrototype) === null &&
      !hasIndexedProperty(arrayPrototype) &&
      !hasIndexedProperty(objectPrototype)
    );
  }
  function ordinaryRealm(): boolean {
    for (let i = 0; i < lifetimeChecks.length; i++) {
      const check = lifetimeChecks[i];
      const current = descriptor(check[0], check[1]);
      if (
        !current ||
        !apply(hasOwn, current, ['value']) ||
        current.value !== check[2]
      )
        return false;
    }
    if (
      descriptor(setPrototype, 'add')?.value !== setAdd ||
      descriptor(setPrototype, 'has')?.value !== setHas ||
      descriptor(setPrototype, 'size')?.get !== setSize ||
      !directWritesSafe() ||
      descriptor(objectPrototype, 'constructor')?.value !== Object ||
      descriptor(Promise.prototype, 'constructor')?.value !== Promise ||
      descriptor(NativeArray, Symbol.species)?.get !== species ||
      descriptor(iteratorPrototype, 'next')?.value !== iteratorNext ||
      descriptor(globalThis, 'structuredClone')?.value !== nativeClone
    )
      return false;
    for (let i = 0; i < fields.length; i++)
      if (fields[i] in arrayPrototype) return false;
    const buffer = descriptor(globalThis, 'Buffer');
    if (
      !buffer ||
      ('value' in buffer
        ? buffer.value !== NodeBuffer
        : !bufferGetter ||
          buffer.get !== bufferGetter ||
          globalThis.Buffer !== NodeBuffer) ||
      descriptor(NodeBuffer, 'isBuffer')?.value !== isBuffer
    )
      return false;
    for (let i = 0; i < methods.length; i++)
      if (descriptor(arrayPrototype, methods[i][0])?.value !== methods[i][1])
        return false;
    return true;
  }

  if (!ordinaryRealm()) return;

  const messages: Layout<MessageLayout>[] = [];
  const parts: Layout<PartLayout>[] = [];
  const arrays: Layout<'array'>[] = [];
  function register<T>(table: Layout<T>[], make: () => object, kind: T): void {
    const anchor = make(),
      marked = make();
    if (!sameShape(anchor, marked)) return;
    for (let i = 0; i < table.length; i++)
      if (sameShape(table[i].anchor, anchor)) return;
    markAsUncloneable(marked);
    if (sameShape(anchor, marked)) return;
    const keys = Object.keys(anchor);
    if (table !== (arrays as unknown))
      for (let i = 0; i < keys.length; i++)
        (anchor as PlainRecord)[keys[i]] = undefined;
    if (!sameShape(anchor, make())) return;
    table.push({
      anchor,
      firstKey: keys[0],
      kind,
      hasStatus: keys.includes('status'),
    });
  }
  function add<T>(table: Layout<T>[], make: () => object, kind: T): void {
    register(table, make, kind);
    register(table, () => ({ ...make() }), kind);
    register(table, () => nativeClone(make()), kind);
  }
  for (const message of messageLayouts) {
    add(
      messages,
      () =>
        decode({
          message,
          part: message === 'role-content' ? 'string' : 'type-text',
          role: 'user',
          text: '',
        }),
      message,
    );
  }
  // Spreading user input before adding status can use another V8 layout.
  add(
    messages,
    () => ({ ...{ role: '', content: '' }, status: '', content: [] }),
    'role-content-status',
  );
  add(parts, () => ({ type: '', text: '' }), 'type-text');
  add(parts, () => ({ text: '', type: '' }), 'text-type');
  add(
    parts,
    () => ({ type: '', text: '', annotations: [] }),
    'type-text-annotations',
  );
  register(arrays, () => [], 'array');
  register(arrays, () => [{}], 'array');
  register(arrays, () => new NativeArray(1), 'array');
  register(arrays, () => nativeClone([{}]), 'array');
  if (!arrays.length || messages.length < 4 || parts.length < 4) return;
  const arrayAnchors = arrays.map((layout) => layout.anchor);
  function list(value: unknown): value is unknown[] {
    return (
      classify(
        value,
        arrayAnchors[0],
        arrayAnchors[1],
        arrayAnchors[2],
        arrayAnchors[3],
        arrayAnchors[4],
      ) >= 0
    );
  }
  function recordLayout<T>(
    value: unknown,
    layouts: Layout<T>[],
  ): Layout<T> | undefined {
    let index = classify(
      value,
      layouts[0]?.anchor,
      layouts[1]?.anchor,
      layouts[2]?.anchor,
      layouts[3]?.anchor,
    );
    if (index < 0) {
      for (index = 4; index < layouts.length; index++)
        if (sameShape(layouts[index].anchor, value)) break;
      if (index === layouts.length) return;
      const hit = layouts[index];
      for (let i = index; i > 0; i--) layouts[i] = layouts[i - 1];
      layouts[0] = hit;
      index = 0;
    }
    const layout = layouts[index];
    // Indexed properties can change without changing the named-property shape.
    for (const key in value as object) {
      if (key !== layout.firstKey) return;
      break;
    }
    return layout;
  }
  function scratch(): TextFields {
    return {
      message: 'role-content',
      part: 'string',
      role: 'user',
      text: '',
    };
  }
  function readText(
    value: unknown,
    output: TextFields,
    leaves?: Set<object>,
  ): boolean {
    const layout = recordLayout(value, messages);
    if (!layout) return false;
    const message = value as PlainRecord;
    if (
      (message.role !== 'user' &&
        message.role !== 'assistant' &&
        message.role !== 'system') ||
      (layout.hasStatus && message.status !== 'completed')
    )
      return false;
    if (
      layout.kind !== 'role-content' &&
      layout.kind !== 'role-content-status' &&
      layout.kind !== 'role-status-content' &&
      (message.type !== 'message' || message.providerData !== undefined)
    )
      return false;
    let leaf: object = message;
    let text = message.content,
      partKind: PartLayout = 'string';
    if (typeof text !== 'string') {
      if (!list(text) || text.length !== 1) return false;
      const part = text[0] as PlainRecord;
      const partLayout = recordLayout(part, parts);
      if (
        !partLayout ||
        typeof part.text !== 'string' ||
        part.type !==
          (message.role === 'assistant' ? 'output_text' : 'input_text')
      )
        return false;
      leaf = part;
      if (partLayout.kind === 'type-text-annotations') {
        if (!list(part.annotations) || part.annotations.length !== 0)
          return false;
        leaf = part.annotations;
      }
      partKind = partLayout.kind;
      text = part.text;
    }
    if (typeof text !== 'string') return false;
    if (text.length + 160 > maxItemSize) return false;
    leaves?.add(leaf);
    output.message = layout.kind;
    output.part = partKind;
    output.role = message.role;
    output.text = text;
    return true;
  }
  function matches(a: TextFields, b: TextFields): boolean {
    return (
      a.message === b.message &&
      a.part === b.part &&
      a.role === b.role &&
      a.text === b.text
    );
  }
  function decode(fields: TextFields): AgentInputItem {
    const { message, part, role, text } = fields;
    const type = role === 'assistant' ? 'output_text' : 'input_text';
    const status = 'completed';
    const content =
      part === 'string'
        ? text
        : part === 'type-text'
          ? [{ type, text }]
          : part === 'text-type'
            ? [{ text, type }]
            : [{ type, text, annotations: [] }];
    // These layouts preserve input values and property order; protocol validation
    // stays with the existing runner rather than this internal copier.
    switch (message) {
      case 'role-content':
        return { role, content } as AgentInputItem;
      case 'role-content-status':
        return { role, content, status } as AgentInputItem;
      case 'role-status-content':
        return { role, status, content } as AgentInputItem;
      case 'type-role-content':
        return { type: 'message', role, content } as AgentInputItem;
      case 'type-role-content-status':
        return { type: 'message', role, content, status } as AgentInputItem;
      case 'type-role-content-provider':
        return {
          type: 'message',
          role,
          content,
          providerData: undefined,
        } as AgentInputItem;
      case 'type-role-content-status-provider':
        return {
          type: 'message',
          role,
          content,
          status,
          providerData: undefined,
        } as AgentInputItem;
    }
  }
  function textList(items: unknown): items is AgentInputItem[] {
    return ordinaryRealm() && list(items) && items.length <= 32768;
  }
  const snapshots = new NativeWeakMap<InputSnapshot, Rows>();
  function seal(rows: Rows): InputSnapshot {
    const token = {} as InputSnapshot;
    apply(weakSet, snapshots, [token, rows]);
    return token;
  }
  function privateRows(snapshot: InputSnapshot): Rows | undefined {
    return apply(weakGet, snapshots, [snapshot]);
  }
  function captureInitial(
    items: AgentInputItem[],
    original: AgentInputItem[],
  ): InputSnapshot | undefined {
    if (!textList(items) || !list(original) || original.length !== items.length)
      return;
    const rows: Rows = [];
    for (let i = 0; i < items.length; i++) {
      const row = scratch();
      if (original[i] !== items[i] || !readText(items[i], row)) return;
      rows[i] = row;
    }
    return seal(rows);
  }
  function cloneOriginal<T extends string | AgentInputItem[]>(input: T): T {
    if (!textList(input)) return structuredClone(input);
    const fields = scratch(),
      output: AgentInputItem[] = [];
    // Each accepted graph is a single chain. If two chains share a
    // node, they also share their last object. Honor aliases by using
    // structuredClone for the entire input when a leaf occurs twice.
    const leaves = new NativeSet<object>();
    let size = 0;
    for (let i = 0; i < input.length; i++) {
      if (!readText(input[i], fields, leaves)) return structuredClone(input);
      size += 160 + fields.text.length;
      if (size > maxOriginalSize) return structuredClone(input);
      output[i] = decode(fields);
    }
    return leaves.size === input.length
      ? (output as T)
      : structuredClone(input);
  }
  function simpleInput(
    items: AgentInputItem[],
    instructions: string | undefined,
    initial: InputSnapshot,
    original: AgentInputItem[],
  ): SimpleInput | undefined {
    if (!textList(items) || !list(original) || original.length !== items.length)
      return;
    const initialRows = privateRows(initial);
    if (!initialRows || initialRows.length !== items.length) return;
    let rows = initialRows;
    const input: AgentInputItem[] = [];
    let fields = scratch();
    for (let i = 0; i < items.length; i++) {
      if (original[i] !== items[i] || !readText(items[i], fields)) return;
      input[i] = decode(fields);
      if (!matches(initialRows[i], fields)) {
        if (rows === initialRows) rows = rows.slice();
        rows[i] = fields;
        fields = scratch();
      }
    }
    return {
      modelInput: { input, instructions },
      sourceItems: items.slice(),
      sourceMatchKinds: new NativeArray(items.length).fill('identity'),
      filterApplied: false,
      preserveInputIdentity: false,
      snapshot: rows === initialRows ? initial : seal(rows),
    };
  }
  function align(
    original: AgentInputItem[],
    count: number,
    prepared: AgentInputItem[],
    processed: AgentInputItem[],
  ): AgentInputItem[] | undefined {
    if (
      !count ||
      !textList(original) ||
      !list(prepared) ||
      !list(processed) ||
      original.length !== count ||
      prepared.length !== count ||
      processed.length !== count
    )
      return;
    const before = scratch(),
      fields = scratch();
    for (let i = 0; i < count; i++) {
      if (processed[i] !== prepared[i] || !readText(original[i], before))
        return;
      if (!readText(prepared[i], fields) || !matches(before, fields)) return;
    }
    const originals = new NativeSet(original);
    for (let i = 0; i < count; i++) if (originals.has(prepared[i])) return;
    return processed.slice();
  }
  function validateIdentity(
    prepared: AgentInputItem[],
    source: (AgentInputItem | undefined)[],
  ): boolean {
    if (
      !ordinaryRealm() ||
      !list(prepared) ||
      !list(source) ||
      prepared.length !== source.length
    )
      return false;
    for (let i = 0; i < prepared.length; i++)
      if (!prepared[i] || prepared[i] !== source[i]) return false;
    return true;
  }
  function materialize(snapshot: InputSnapshot): AgentInputItem[] {
    const rows = privateRows(snapshot);
    if (!rows) throw new TypeError('Unknown input snapshot');
    const safe = !directWritesSafe(),
      output: AgentInputItem[] = [];
    for (let offset = 0; offset < rows.length; offset++) {
      const item = decode(rows[offset]);
      if (safe) append(output, item);
      else output[offset] = item;
    }
    return output;
  }
  function writableField(owner: object, key: string): boolean {
    const current = descriptor(owner, key);
    return (
      !!current &&
      !!current.writable &&
      !!current.enumerable &&
      !!current.configurable &&
      apply(hasOwn, current, ['value'])
    );
  }
  function installSaved(
    owner: object,
    key: string,
    snapshot: InputSnapshot,
    read?: () => AgentInputItem[],
  ): boolean {
    if (
      !ordinaryRealm() ||
      isProxy(owner) ||
      !writableField(owner, key) ||
      !privateRows(snapshot)
    )
      return false;
    return nativeInstallSaved(
      owner,
      key,
      read ?? (() => materialize(snapshot)),
    );
  }
  function installEnvelope(
    owner: object,
    key: string,
    read: () => unknown,
  ): (() => boolean) | undefined {
    if (
      !ordinaryRealm() ||
      isProxy(owner) ||
      !writableField(owner, key) ||
      !nativeInstallSaved(owner, key, read)
    )
      return;
    const exemplar = nativeCloneEnvelope(owner),
      marked = nativeCloneEnvelope(owner);
    if (!exemplar || !marked || !sameShape(exemplar, owner)) return;
    markAsUncloneable(marked);
    if (sameShape(exemplar, marked)) return;
    return () =>
      !isProxy(owner) &&
      sameShape(exemplar, owner) &&
      nativeIsLazyEnvelope(owner, key);
  }
  return {
    cloneOriginal,
    captureInitial,
    simpleInput,
    align,
    validateIdentity,
    materialize,
    installSaved,
    installEnvelope,
  };
}
