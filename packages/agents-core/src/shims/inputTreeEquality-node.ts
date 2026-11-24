import { types } from 'node:util';
import { Buffer as NodeBuffer } from 'node:buffer';

const lookupGetter = Function.call.bind(
  Reflect.get(Object.prototype, '__lookupGetter__'),
) as (value: object, key: string) => (() => unknown) | undefined;
const initialBufferGetter = Object.getOwnPropertyDescriptor(
  globalThis,
  'Buffer',
)?.get;
const isBuffer = NodeBuffer.isBuffer;
const arrayMethodNames = [
  'entries',
  'map',
  'filter',
  'flatMap',
  'every',
  'constructor',
] as const;
const arrayMethods: unknown[] = [];
const functionToString = Function.prototype.toString;
let startupArrayMethodsAreNative = true;
// Inspect startup methods without invoking wrappers or their conversion hooks.
for (let index = 0; index < arrayMethodNames.length; index++) {
  const name = arrayMethodNames[index]!;
  const method = Object.getOwnPropertyDescriptor(Array.prototype, name)?.value;
  arrayMethods[index] = method;
  const nativeName = name === 'constructor' ? 'Array' : name;
  if (
    typeof method !== 'function' ||
    types.isProxy(method) ||
    Reflect.apply(functionToString, method, []) !==
      `function ${nativeName}() { [native code] }`
  ) {
    startupArrayMethodsAreNative = false;
  }
}

// Bound work before returning to the existing key serializer.
const MAX_COMPARISON_DEPTH = 64;
const MAX_COMPARISON_WORK = 1024 * 1024;

type ComparisonBudget = { remaining: number };

function usesExpectedBuffer(): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  return (
    descriptor !== undefined &&
    ('value' in descriptor
      ? descriptor.value === NodeBuffer
      : descriptor.get === initialBufferGetter &&
        globalThis.Buffer === NodeBuffer)
  );
}

function equalPlainData(
  left: unknown,
  right: unknown,
  depth: number,
  budget: ComparisonBudget,
): boolean {
  budget.remaining -= 32 + (typeof left === 'string' ? left.length : 0);
  if (budget.remaining < 0) return false;
  if (
    left === null ||
    typeof left !== 'object' ||
    right === null ||
    typeof right !== 'object'
  ) {
    return (
      left === right &&
      (left === null ||
        typeof left === 'string' ||
        typeof left === 'boolean' ||
        typeof left === 'undefined' ||
        typeof left === 'number')
    );
  }
  if (
    depth >= MAX_COMPARISON_DEPTH ||
    types.isProxy(left) ||
    types.isProxy(right)
  )
    return false;
  const array = Array.isArray(left);
  if (array !== Array.isArray(right)) return false;
  const prototype = array ? Array.prototype : Object.prototype;
  if (
    Object.getPrototypeOf(left) !== prototype ||
    Object.getPrototypeOf(right) !== prototype ||
    'toJSON' in left ||
    'toJSON' in right
  )
    return false;
  if (
    !array &&
    (types.isBoxedPrimitive(left) ||
      types.isBoxedPrimitive(right) ||
      types.isAnyArrayBuffer(left) ||
      types.isAnyArrayBuffer(right) ||
      types.isArrayBufferView(left) ||
      types.isArrayBufferView(right))
  )
    return false;

  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  // The existing key serializer recognizes Buffer snapshots even through hidden type fields.
  if (
    ('type' in a && (lookupGetter(a, 'type') || a.type === 'Buffer')) ||
    ('type' in b && (lookupGetter(b, 'type') || b.type === 'Buffer'))
  )
    return false;
  const leftKeys = Object.keys(a);
  const rightKeys = Object.keys(b);
  if (
    leftKeys.length !== rightKeys.length ||
    (array &&
      (leftKeys.length !== (left as unknown[]).length ||
        rightKeys.length !== (right as unknown[]).length))
  )
    return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index]!;
    if (
      key !== rightKeys[index] ||
      (array && key !== String(index)) ||
      lookupGetter(a, key) ||
      lookupGetter(b, key)
    )
      return false;
    budget.remaining -= key.length;
    if (
      budget.remaining < 0 ||
      !equalPlainData(a[key], b[key], depth + 1, budget)
    ) {
      return false;
    }
  }
  return true;
}

function isPlainDenseList(value: readonly unknown[]): boolean {
  if (
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return false;
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    names[value.length] !== 'length' ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return false;
  for (let index = 0; index < value.length; index++) {
    if (names[index] !== String(index) || lookupGetter(value, names[index]!)) {
      return false;
    }
  }
  return true;
}

/**
 * Proves positional ownership without invoking the item key serializer's hooks.
 * Other values retain the existing serialized-key and reference matching path.
 */
export function canMatchInputItemsByPosition(
  preparedItems: readonly unknown[],
  processedItems: readonly unknown[],
): boolean {
  if (
    !startupArrayMethodsAreNative ||
    Object.getPrototypeOf(Array.prototype) !== Object.prototype ||
    Object.getPrototypeOf(Object.prototype) !== null ||
    !usesExpectedBuffer() ||
    NodeBuffer.isBuffer !== isBuffer ||
    !isPlainDenseList(preparedItems) ||
    !isPlainDenseList(processedItems) ||
    preparedItems.length !== processedItems.length
  )
    return false;
  for (let index = 0; index < arrayMethodNames.length; index++) {
    if (
      Object.getOwnPropertyDescriptor(Array.prototype, arrayMethodNames[index]!)
        ?.value !== arrayMethods[index]
    ) {
      return false;
    }
  }
  const preparedReferences = new Set<unknown>();
  let allRootsIdentical = true;
  for (let index = 0; index < preparedItems.length; index++) {
    if (
      !equalPlainData(preparedItems[index], processedItems[index], 0, {
        remaining: MAX_COMPARISON_WORK,
      })
    )
      return false;
    allRootsIdentical &&= preparedItems[index] === processedItems[index];
    preparedReferences.add(preparedItems[index]);
  }
  if (allRootsIdentical) return true;
  // Mixed root references must retain their precedence over equal-content matches.
  for (let index = 0; index < processedItems.length; index++) {
    if (preparedReferences.has(processedItems[index])) return false;
  }
  return true;
}
