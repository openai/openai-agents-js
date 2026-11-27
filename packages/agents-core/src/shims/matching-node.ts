import process from 'node:process';

type Runtime = {
  isProxy: (value: unknown) => boolean;
  isBoxedPrimitive: (value: unknown) => boolean;
};

const descriptor = Reflect.getOwnPropertyDescriptor;
const parent = Reflect.getPrototypeOf;
const apply = Reflect.apply;
const format = Function.prototype.toString;
const object = Object.prototype;
const array = Array.prototype;
const functions = Function.prototype;
const realm = globalThis;

function value(owner: object, key: PropertyKey) {
  return descriptor(owner, key)?.value;
}

function source(fn: unknown): string {
  return typeof fn === 'function' ? apply(format, fn, []) : '';
}

function native(fn: unknown, name: string): boolean {
  return (
    typeof fn === 'function' &&
    source(fn) === `function ${name}() { [native code] }` &&
    parent(fn) === functions &&
    value(fn, 'name') === name
  );
}

function methods(owner: object, names: string[]): boolean {
  for (let i = 0; i < names.length; i++) {
    if (!native(value(owner, names[i]), names[i])) return false;
  }
  return true;
}

let proxyDetector: Runtime['isProxy'] | undefined;

// A forwarding proxy for Node's anonymous detector has the same function
// spelling and name. Check the detector independently before the first call.
function classifiers(util: typeof import('node:util')): Runtime | undefined {
  const types = value(util, 'types');
  if (!types || typeof types !== 'object') return;
  const isProxy = value(types, 'isProxy');
  const isBoxedPrimitive = value(types, 'isBoxedPrimitive');
  if (!proxyDetector) {
    const inspect = value(util, 'inspect');
    if (
      !native(isProxy, '') ||
      Symbol.toStringTag in isProxy ||
      !source(inspect).startsWith('function inspect(value, opts) {') ||
      inspect(isProxy, {
        showProxy: true,
        customInspect: false,
        getters: false,
        colors: false,
        depth: -1,
      }) !== '[Function (anonymous)]'
    )
      return;
    proxyDetector = isProxy;
  }
  if (
    proxyDetector !== isProxy ||
    isProxy(isBoxedPrimitive) ||
    !native(isBoxedPrimitive, '')
  )
    return;
  return { isProxy, isBoxedPrimitive };
}

// The binary-aware serializer reads the global binding on each visit.
// Only Node's ordinary lazy getter or a data property can be skipped.
function ordinaryBinaryChecks(
  runtime: Runtime,
  module: typeof import('node:buffer'),
) {
  const field = descriptor(realm, 'Buffer');
  if (!field || '_Buffer' in realm) return false;
  if (
    !('value' in field) &&
    (source(field.get) !== 'get() {\n      return _Buffer;\n    }' ||
      source(field.set) !== 'set(value) {\n      _Buffer = value;\n    }')
  )
    return false;
  const buffer = 'value' in field ? field.value : apply(field.get!, realm, []);
  if (
    typeof buffer !== 'function' ||
    runtime.isProxy(buffer) ||
    value(module, 'Buffer') !== buffer ||
    parent(buffer) !== Uint8Array ||
    source(value(buffer, 'isBuffer')) !==
      'function isBuffer(b) {\n  return b instanceof Buffer;\n}'
  )
    return false;
  const prototype = value(buffer, 'prototype');
  if (
    !prototype ||
    typeof prototype !== 'object' ||
    runtime.isProxy(prototype) ||
    parent(prototype) !== Uint8Array.prototype ||
    value(prototype, 'constructor') !== buffer
  )
    return false;
  // instanceof can consult an inherited Symbol.hasInstance on either constructor.
  for (const ctor of [ArrayBuffer, buffer]) {
    let owner: object | null = ctor;
    while (owner !== functions) {
      if (
        !owner ||
        runtime.isProxy(owner) ||
        descriptor(owner, Symbol.hasInstance)
      )
        return false;
      owner = parent(owner);
    }
  }
  return native(value(functions, Symbol.hasInstance), '[Symbol.hasInstance]');
}

function ordinaryIterator(iterator: object, runtime: Runtime) {
  const owner = parent(iterator);
  if (
    !owner ||
    runtime.isProxy(owner) ||
    !native(value(owner, 'next'), 'next') ||
    descriptor(owner, Symbol.iterator) ||
    'return' in owner
  )
    return false;
  const shared = parent(owner);
  return (
    !!shared &&
    !runtime.isProxy(shared) &&
    parent(shared) === object &&
    native(value(shared, Symbol.iterator), '[Symbol.iterator]')
  );
}

// Fall back when an application can observe skipped reads, collection
// writes, or the publication of array elements through a custom species.
function ordinaryTraversal(runtime: Runtime) {
  const globals = [
    'Array',
    'ArrayBuffer',
    'Boolean',
    'Function',
    'JSON',
    'Map',
    'Math',
    'Object',
    'Reflect',
    'Set',
    'Symbol',
    'Uint8Array',
    'WeakMap',
  ];
  for (let i = 0; i < globals.length; i++) {
    const target = value(realm, globals[i]);
    if (
      !target ||
      runtime.isProxy(target) ||
      (typeof target === 'object' &&
        (parent(target) !== object || 'Infinity' in target)) ||
      (typeof target !== 'object' && typeof target !== 'function')
    )
      return false;
  }
  if (
    value(realm, 'globalThis') !== realm ||
    value(functions, 'toString') !== format ||
    !methods(functions, ['call', 'bind']) ||
    !methods(Reflect, [
      'apply',
      'ownKeys',
      'getPrototypeOf',
      'getOwnPropertyDescriptor',
    ]) ||
    !methods(Math, ['min']) ||
    !native(Array, 'Array') ||
    !native(Object, 'Object') ||
    !native(Symbol, 'Symbol') ||
    Object.prototype !== object ||
    Array.prototype !== array ||
    parent(array) !== object ||
    parent(object) !== null ||
    value(array, 'constructor') !== Array ||
    !native(descriptor(Array, Symbol.species)?.get, 'get [Symbol.species]') ||
    !native(Map, 'Map') ||
    !native(Set, 'Set') ||
    !native(WeakMap, 'WeakMap') ||
    !native(Boolean, 'Boolean') ||
    !native(ArrayBuffer, 'ArrayBuffer') ||
    !methods(Object, [
      'keys',
      'entries',
      'getPrototypeOf',
      'getOwnPropertyDescriptor',
    ]) ||
    !methods(object, ['hasOwnProperty']) ||
    !methods(Array, ['isArray']) ||
    !methods(array, [
      'entries',
      'values',
      'map',
      'filter',
      'flatMap',
      'every',
      'some',
      'includes',
      'slice',
      'push',
      'shift',
    ]) ||
    !methods(Map.prototype, ['entries', 'get', 'has', 'set', 'values']) ||
    !methods(Set.prototype, ['add', 'has', 'values']) ||
    !methods(WeakMap.prototype, ['get', 'set']) ||
    !methods(JSON, ['stringify']) ||
    !methods(ArrayBuffer, ['isView']) ||
    value(array, Symbol.iterator) !== array.values ||
    value(Map.prototype, Symbol.iterator) !== Map.prototype.entries ||
    value(Set.prototype, Symbol.iterator) !== Set.prototype.values
  )
    return false;
  if (
    !ordinaryIterator([].values(), runtime) ||
    !ordinaryIterator(new Map().entries(), runtime) ||
    !ordinaryIterator(new Set().values(), runtime)
  )
    return false;
  for (const owner of [array, object]) {
    for (const key of Reflect.ownKeys(owner)) {
      if (typeof key === 'string' && key[0] >= '0' && key[0] <= '9')
        return false;
    }
  }
  // Some foreign allocators have been given a local Function prototype.
  for (const name of ['map', 'flatMap', 'filter', 'slice']) {
    if (
      parent(apply(value(array, name), { length: 0 }, [() => false])) !== array
    )
      return false;
  }
  return ![
    'then',
    'type',
    'toJSON',
    'role',
    'content',
    'status',
    'text',
    'annotations',
    'mediaType',
    'providerData',
    'validateReplacements',
  ].some((key) => key in array);
}

// These Node wrappers are written in JavaScript. Unknown implementations,
// including changes in Node itself, take the regular matching and copy paths.
export function matchingRuntime(): Runtime | undefined {
  if ('value' in object || 'get' in object) return;
  const load = value(process, 'getBuiltinModule');
  if (
    !source(load).endsWith(
      '  return normalizedId ? require(normalizedId) : undefined;\n}',
    )
  )
    return;
  // Loading the CommonJS value on demand avoids reading unrelated ESM exports.
  const runtime = classifiers(load('node:util'));
  if (
    !runtime ||
    !ordinaryTraversal(runtime) ||
    !ordinaryBinaryChecks(runtime, load('node:buffer'))
  )
    return;
  // A replacement can expose or mark its copies before the next native capture.
  const clone = source(value(realm, 'structuredClone'));
  if (
    !clone.startsWith('function structuredClone(value, options) {') ||
    !clone.endsWith(
      '  const serializedData = nativeStructuredClone(value, idlOptions);\n  return serializedData;\n}',
    )
  )
    return;
  return runtime;
}
