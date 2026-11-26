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
// Capture the formatter without reading its inherited .call during a run.
// As with the descriptor reader, use the realm's bootstrap intrinsics only.
function captureFormatter() {
  if ('value' in object) return;
  const isProxy = descriptor(types, 'isProxy')?.value;
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
  return {
    prototype,
    format,
    call,
    source: call.bind(format) as (fn: object) => string,
  };
}
const formatter = captureFormatter();
const builtin = (fn: unknown, name: string) =>
  typeof fn === 'function' &&
  !types.isProxy(fn) &&
  formatter?.source(fn) === `function ${name}() { [native code] }`;

function ordinaryInstanceCheck(constructor: object): boolean {
  let current: object | null = constructor;
  while (current) {
    if (types.isProxy(current)) return false;
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
  if (!prototype || types.isProxy(prototype)) return false;
  const parent = Reflect.getPrototypeOf(prototype);
  return (
    !!parent &&
    !types.isProxy(parent) &&
    Reflect.getPrototypeOf(parent) === object &&
    builtin(descriptor(prototype, 'next')?.value, 'next') &&
    !descriptor(prototype, Symbol.iterator) &&
    builtin(descriptor(parent, Symbol.iterator)?.value, '[Symbol.iterator]') &&
    !('return' in prototype)
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
    typeof descriptor(types, 'isProxy')?.value !== 'function' ||
    typeof descriptor(types, 'isBoxedPrimitive')?.value !== 'function'
  )
    return false;
  // Reading a getter here could edit the input or skip an error in the key serializer.
  for (let i = 0; i < traversalGlobals.length; i++) {
    const field = descriptor(realm, traversalGlobals[i]);
    if (
      !field ||
      !('value' in field) ||
      !field.value ||
      (typeof field.value !== 'object' && typeof field.value !== 'function') ||
      types.isProxy(field.value)
    )
      return false;
  }
  if (
    descriptor(realm, 'globalThis')?.value !== realm ||
    !formatter ||
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
    !ordinaryMethods(Reflect, ['ownKeys', 'getPrototypeOf']) ||
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
    !builtin(descriptor(array, 'constructor')?.value, 'Array') ||
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
    hasIndexedProperties(object) ||
    !ordinaryIterator(array.values()) ||
    !ordinaryIterator(new Map().values()) ||
    !ordinaryIterator(new Set()[Symbol.iterator]())
  )
    return false;
  return true;
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
  if (
    !b ||
    typeof b !== 'object' ||
    depth === 8 ||
    types.isProxy(a) ||
    types.isProxy(b)
  )
    return false;
  const list = Array.isArray(a);
  if (
    list !== Array.isArray(b) ||
    Reflect.getPrototypeOf(a) !== (list ? array : object) ||
    Reflect.getPrototypeOf(b) !== (list ? array : object) ||
    'toJSON' in a ||
    'toJSON' in b ||
    types.isBoxedPrimitive(a) ||
    types.isBoxedPrimitive(b) ||
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
): boolean {
  if (
    !ordinaryTraversal() ||
    types.isProxy(original) ||
    types.isProxy(prepared) ||
    types.isProxy(processed) ||
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
  const references = new Set();
  for (let i = 0; i < original.length; i++) references.add(original[i]);
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
