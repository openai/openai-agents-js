import { Buffer } from 'node:buffer';
import { types } from 'node:util';

const descriptor = Reflect.getOwnPropertyDescriptor;
const array = Array.prototype;
const object = Object.prototype;
const buffer = descriptor(globalThis, 'Buffer');
const isBuffer = descriptor(Buffer, 'isBuffer')?.value;
const builtin = (fn: unknown, name: string) =>
  typeof fn === 'function' &&
  !types.isProxy(fn) &&
  Function.prototype.toString.call(fn) ===
    `function ${name}() { [native code] }`;

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

// Preserve the matching passes when applications intercept traversal or
// the binary checks performed by the key serializer.
function ordinaryTraversal(): boolean {
  if ('value' in object || 'get' in object) return false;
  const globalBuffer = descriptor(globalThis, 'Buffer');
  const arrayBuffer = descriptor(globalThis, 'ArrayBuffer')?.value;
  const isBufferField = descriptor(Buffer, 'isBuffer');
  if (
    !builtin(descriptor, 'getOwnPropertyDescriptor') ||
    !builtin(Reflect.ownKeys, 'ownKeys') ||
    !builtin(Reflect.getPrototypeOf, 'getPrototypeOf') ||
    !builtin(JSON.stringify, 'stringify') ||
    !builtin(descriptor(Array, 'isArray')?.value, 'isArray') ||
    !arrayBuffer ||
    !builtin(arrayBuffer, 'ArrayBuffer') ||
    !builtin(descriptor(arrayBuffer, 'isView')?.value, 'isView') ||
    !ordinaryInstanceCheck(arrayBuffer) ||
    !ordinaryInstanceCheck(Buffer) ||
    !globalBuffer ||
    globalBuffer.get !== buffer?.get ||
    globalThis.Buffer !== Buffer ||
    !isBufferField ||
    !('value' in isBufferField) ||
    isBufferField.value !== isBuffer ||
    !builtin(descriptor(Array, Symbol.species)?.get, 'get [Symbol.species]') ||
    !builtin(descriptor(array, Symbol.iterator)?.value, 'values') ||
    Reflect.getPrototypeOf(array) !== object ||
    Reflect.getPrototypeOf(object) !== null ||
    'type' in array ||
    'toJSON' in array
  )
    return false;
  for (const name of [
    'entries',
    'map',
    'filter',
    'every',
    'flatMap',
    'slice',
    'push',
    'values',
    'constructor',
  ]) {
    if (
      !builtin(
        descriptor(array, name)?.value,
        name === 'constructor' ? 'Array' : name,
      )
    )
      return false;
  }
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
  const references = new Set(original);
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
