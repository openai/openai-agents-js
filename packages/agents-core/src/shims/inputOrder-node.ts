import { Buffer } from 'node:buffer';
import { types } from 'node:util';

const descriptor = Reflect.getOwnPropertyDescriptor;
const array = Array.prototype;
const object = Object.prototype;
const realm = globalThis;
const buffer = descriptor(realm, 'Buffer');
const traversalGlobals = [
  'Array',
  'ArrayBuffer',
  'Boolean',
  'Function',
  'JSON',
  'Map',
  'Math',
  'Reflect',
  'Set',
  'String',
  'Symbol',
];
const isBuffer = descriptor(Buffer, 'isBuffer')?.value;
const unavailable = () => true;
const isProxy: (value: unknown) => boolean =
  'value' in object
    ? unavailable
    : (descriptor(types, 'isProxy')?.value ?? unavailable);
const isBoxedPrimitive: (value: unknown) => boolean =
  'value' in object
    ? unavailable
    : (descriptor(types, 'isBoxedPrimitive')?.value ?? unavailable);
// Capture the formatter without reading its inherited .call during a run.
// As with the descriptor reader, use the realm's bootstrap intrinsics only.
function captureFormatter() {
  if ('value' in object) return;
  if (typeof isProxy !== 'function') return;
  const constructor = descriptor(realm, 'Function')?.value;
  if (typeof constructor !== 'function' || isProxy(constructor)) return;
  const prototype = descriptor(constructor, 'prototype')?.value;
  if (typeof prototype !== 'function' || isProxy(prototype)) return;
  const format = descriptor(prototype, 'toString')?.value;
  const call = descriptor(prototype, 'call')?.value;
  const bind = descriptor(prototype, 'bind')?.value;
  if (
    typeof format !== 'function' ||
    isProxy(format) ||
    typeof call !== 'function' ||
    isProxy(call) ||
    typeof bind !== 'function' ||
    isProxy(bind) ||
    descriptor(call, 'bind') ||
    typeof descriptor(call, 'length')?.value !== 'number' ||
    typeof descriptor(call, 'name')?.value !== 'string'
  )
    return;
  const source = call.bind(format) as (fn: object) => string;
  // Bound functions and callable proxies also print as anonymous native
  // functions. Decline ordinary wrappers before passing them any messages.
  const ordinaryPredicate = (fn: unknown) =>
    typeof fn === 'function' &&
    source(fn) === 'function () { [native code] }' &&
    !isProxy(fn) &&
    descriptor(fn, 'name')?.value === '';
  if (!ordinaryPredicate(isProxy) || !ordinaryPredicate(isBoxedPrimitive))
    return;
  return { prototype, format, call, source };
}
const formatter = captureFormatter();
const builtin = (fn: unknown, name: string) =>
  typeof fn === 'function' &&
  !isProxy(fn) &&
  formatter?.source(fn) === `function ${name}() { [native code] }`;

function ordinaryInstanceCheck(constructor: object): boolean {
  let current: object | null = constructor;
  while (current) {
    if (typeof current !== 'function' || isProxy(current)) return false;
    const method = descriptor(current, Symbol.hasInstance);
    if (method) return builtin(method.value, '[Symbol.hasInstance]');
    current = Reflect.getPrototypeOf(current);
  }
  return false;
}

function ordinaryMethods(owner: object, names: string[]): boolean {
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!builtin(descriptor(owner, name)?.value, name)) return false;
  }
  return true;
}

// The original passes iterate maps and arrays, including destructuring entries.
function ordinaryIterator(iterator: object): boolean {
  const prototype = Reflect.getPrototypeOf(iterator);
  if (!prototype || isProxy(prototype)) return false;
  const parent = Reflect.getPrototypeOf(prototype);
  if (
    !parent ||
    isProxy(parent) ||
    Reflect.getPrototypeOf(parent) !== object ||
    'Infinity' in prototype
  )
    return false;
  const next = descriptor(prototype, 'next')?.value;
  return (
    builtin(next, 'next') &&
    // Generator next methods take a value. Calling an async generator's
    // method on this iterator would create a rejected promise.
    descriptor(next, 'length')?.value === 0 &&
    !descriptor(prototype, Symbol.iterator) &&
    builtin(descriptor(parent, Symbol.iterator)?.value, '[Symbol.iterator]') &&
    !('return' in prototype) &&
    Reflect.getPrototypeOf(Reflect.apply(next, iterator, [])) === object
  );
}

// The original mapper fills sparse position arrays and pushes into empty lists.
function hasIndexedProperties(prototype: object): boolean {
  const keys = Reflect.ownKeys(prototype);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key === 'string' && key.length && key[0] >= '0' && key[0] <= '9')
      return true;
  }
  return false;
}

// Preserve the matching passes when applications intercept traversal or
// the binary checks performed by the key serializer.
function ordinaryTraversal(): boolean {
  if ('value' in object || 'get' in object) return false;
  if (
    !formatter ||
    descriptor(types, 'isProxy')?.value !== isProxy ||
    descriptor(types, 'isBoxedPrimitive')?.value !== isBoxedPrimitive
  )
    return false;
  const objectConstructor = descriptor(object, 'constructor')?.value;
  if (typeof objectConstructor !== 'function' || isProxy(objectConstructor))
    return false;
  const prototypeOf = descriptor(objectConstructor, 'getPrototypeOf')?.value;
  if (!builtin(prototypeOf, 'getPrototypeOf')) return false;
  // Reading a getter here could edit the input or skip an error in the key serializer.
  for (let i = 0; i < traversalGlobals.length; i++) {
    const field = descriptor(realm, traversalGlobals[i]);
    if (
      !field ||
      !('value' in field) ||
      !field.value ||
      (typeof field.value !== 'object' && typeof field.value !== 'function') ||
      isProxy(field.value) ||
      (typeof field.value === 'object' &&
        (prototypeOf(field.value) !== object || 'Infinity' in field.value))
    )
      return false;
  }
  if (
    descriptor(realm, 'globalThis')?.value !== realm ||
    descriptor(Function, 'prototype')?.value !== formatter.prototype ||
    descriptor(formatter.prototype, 'toString')?.value !== formatter.format ||
    descriptor(formatter.prototype, 'call')?.value !== formatter.call
  )
    return false;
  const globalBuffer = descriptor(realm, 'Buffer');
  const arrayBuffer = descriptor(realm, 'ArrayBuffer')?.value;
  const isBufferField = descriptor(Buffer, 'isBuffer');
  if (
    !builtin(descriptor, 'getOwnPropertyDescriptor') ||
    !ordinaryMethods(Reflect, ['ownKeys', 'getPrototypeOf', 'apply']) ||
    !ordinaryMethods(JSON, ['stringify']) ||
    !ordinaryMethods(Math, ['min']) ||
    !builtin(Boolean, 'Boolean') ||
    !builtin(Array, 'Array') ||
    !builtin(descriptor(Array, 'isArray')?.value, 'isArray') ||
    !builtin(String, 'String') ||
    !builtin(Symbol, 'Symbol') ||
    !builtin(Map, 'Map') ||
    !ordinaryMethods(Map.prototype, ['get', 'set', 'has', 'values']) ||
    !builtin(descriptor(Map.prototype, Symbol.iterator)?.value, 'entries') ||
    !builtin(Set, 'Set') ||
    !ordinaryMethods(Set.prototype, ['add', 'has']) ||
    !builtin(descriptor(Set.prototype, Symbol.iterator)?.value, 'values') ||
    !arrayBuffer ||
    !builtin(arrayBuffer, 'ArrayBuffer') ||
    !builtin(descriptor(arrayBuffer, 'isView')?.value, 'isView') ||
    !ordinaryInstanceCheck(arrayBuffer) ||
    !ordinaryInstanceCheck(Buffer) ||
    !globalBuffer ||
    globalBuffer.get !== buffer?.get ||
    realm.Buffer !== Buffer ||
    !isBufferField ||
    !('value' in isBufferField) ||
    isBufferField.value !== isBuffer ||
    !builtin(descriptor(Array, Symbol.species)?.get, 'get [Symbol.species]') ||
    !builtin(descriptor(array, Symbol.iterator)?.value, 'values') ||
    Reflect.getPrototypeOf(array) !== object ||
    Reflect.getPrototypeOf(object) !== null ||
    'validateReplacements' in object ||
    'type' in array ||
    'toJSON' in array
  )
    return false;
  if (
    descriptor(array, 'constructor')?.value !== Array ||
    descriptor(Array, 'prototype')?.value !== array ||
    !ordinaryMethods(array, [
      'entries',
      'map',
      'filter',
      'every',
      'flatMap',
      'slice',
      'push',
      'values',
      'some',
      'shift',
    ]) ||
    hasIndexedProperties(array) ||
    hasIndexedProperties(object)
  )
    return false;

  // A borrowed native method keeps its own realm, even if its visible
  // prototype has changed. Check where the actual methods allocate their
  // results before skipping iterations that could invoke application code.
  // An empty, non-array receiver avoids constructor and species lookups.
  const empty = { __proto__: null, length: 0 };
  const callback = () => false;
  try {
    const map = new Map();
    return (
      Reflect.getPrototypeOf(Reflect.apply(array.map, empty, [callback])) ===
        array &&
      Reflect.getPrototypeOf(Reflect.apply(array.filter, empty, [callback])) ===
        array &&
      Reflect.getPrototypeOf(
        Reflect.apply(array.flatMap, empty, [callback]),
      ) === array &&
      Reflect.getPrototypeOf(Reflect.apply(array.slice, empty, [])) === array &&
      ordinaryIterator(Reflect.apply(array.values, empty, [])) &&
      ordinaryIterator(Reflect.apply(array.entries, empty, [])) &&
      ordinaryIterator(Reflect.apply(array[Symbol.iterator], empty, [])) &&
      ordinaryIterator(map.values()) &&
      ordinaryIterator(map[Symbol.iterator]()) &&
      ordinaryIterator(new Set()[Symbol.iterator]())
    );
  } catch {
    // A native method can synchronously reject an incompatible receiver.
    return false;
  }
}

function dense(list: unknown[]): boolean {
  if (
    Reflect.getPrototypeOf(list) !== array ||
    Reflect.ownKeys(list).length !== list.length + 1
  )
    return false;
  for (let i = 0; i < list.length; i++) {
    const field = descriptor(list, i);
    if (!field || !('value' in field)) return false;
  }
  return true;
}

// Only compare simple data the key serializer would traverse without hooks.
// Bound both recursion and work on repeated subtrees. Fallback also preserves
// errors on cyclic values and BigInt, Buffer snapshots, and custom toJSON.
function equalData(
  a: unknown,
  b: unknown,
  depth: number,
  budget: { left: number },
): boolean {
  budget.left -= typeof a === 'string' ? a.length + 1 : 16;
  if (budget.left < 0) return false;
  if (!a || typeof a !== 'object') {
    return (
      a === b &&
      typeof a !== 'bigint' &&
      typeof a !== 'function' &&
      typeof a !== 'symbol'
    );
  }
  if (!b || typeof b !== 'object' || depth === 8 || isProxy(a) || isProxy(b))
    return false;
  const list = Array.isArray(a);
  // Node VM globals have been retaining a non-configurable Infinity despite ordinary
  // proxy/prototype checks. After those exclusions, `in` has been avoiding sandbox Proxy
  // traps and enumeration. Ordinary records with this field have been falling back.
  if (
    list !== Array.isArray(b) ||
    Reflect.getPrototypeOf(a) !== (list ? array : object) ||
    Reflect.getPrototypeOf(b) !== (list ? array : object) ||
    'Infinity' in a ||
    'Infinity' in b ||
    'toJSON' in a ||
    'toJSON' in b ||
    isBoxedPrimitive(a) ||
    isBoxedPrimitive(b) ||
    ArrayBuffer.isView(a) ||
    ArrayBuffer.isView(b)
  )
    return false;
  const ak = Reflect.ownKeys(a);
  const bk = Reflect.ownKeys(b);
  if (ak.length !== bk.length || ak.length > budget.left) return false;
  const count = ak.length - (list ? 1 : 0);
  if (list && (a.length !== count || (b as unknown[]).length !== count))
    return false;
  for (let i = 0; i < count; i++) {
    const key = ak[i];
    if (typeof key !== 'string' || key !== bk[i] || (list && key !== String(i)))
      return false;
    budget.left -= key.length;
    const left = descriptor(a, key);
    const right = descriptor(b, key);
    if (
      !left?.enumerable ||
      !right?.enumerable ||
      !('value' in left) ||
      !('value' in right) ||
      (key === 'type' && left.value === 'Buffer') ||
      !equalData(left.value, right.value, depth + 1, budget)
    )
      return false;
  }
  return true;
}

/** All three lists must preserve order. A reused root takes priority over an equal clone. */
export function matchesOwnedHistory(
  original: unknown[],
  prepared: unknown[],
  processed: unknown[],
  positions?: unknown[],
): boolean {
  if (
    !ordinaryTraversal() ||
    isProxy(original) ||
    isProxy(prepared) ||
    isProxy(processed) ||
    !Array.isArray(original) ||
    !Array.isArray(prepared) ||
    !Array.isArray(processed) ||
    original.length !== prepared.length ||
    processed.length !== prepared.length ||
    !dense(original) ||
    !dense(prepared) ||
    !dense(processed)
  )
    return false;
  // Array hooks can retain the positions while the tracker builds them.
  // Keep the original mapping if reading a position or mapping the list can run user code.
  if (
    positions !== undefined &&
    (isProxy(positions) ||
      !Array.isArray(positions) ||
      positions.length !== original.length ||
      !dense(positions))
  )
    return false;
  const references = new Set();
  for (let i = 0; i < original.length; i++) {
    if (positions !== undefined) {
      const position = positions[i];
      if (
        !position ||
        typeof position !== 'object' ||
        isProxy(position) ||
        Reflect.getPrototypeOf(position) !== object ||
        'Infinity' in position ||
        descriptor(position, 'preparedIndex')?.value !== i ||
        descriptor(position, 'ownerIndex')?.value !== i
      )
        return false;
    }
    references.add(original[i]);
  }
  for (let i = 0; i < original.length; i++) {
    const item = prepared[i];
    if (
      processed[i] !== item ||
      references.has(item) ||
      !equalData(original[i], item, 0, { left: 65536 })
    )
      return false;
  }
  return true;
}
