/* global require, module, __dirname, process */
'use strict';
// Loading worker_threads can iterate arrays during its own initialization.
// Reject a wrapped/accessor iterator before loading optional native support.
function hasNativeArrayIterator() {
  const descriptor = Object.getOwnPropertyDescriptor(
    Array.prototype,
    Symbol.iterator,
  );
  return (
    descriptor !== undefined &&
    Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
    typeof descriptor.value === 'function' &&
    Reflect.apply(Function.prototype.toString, descriptor.value, []) ===
      'function values() { [native code] }'
  );
}
function standardDataMethod(owner, key) {
  const desc = Object.getOwnPropertyDescriptor(owner, key);
  return (
    !!desc &&
    typeof desc.value === 'function' &&
    Reflect.apply(Function.prototype.toString, desc.value, []) ===
      'function ' + key + '() { [native code] }'
  );
}
let bindings;
try {
  const abi = process.versions.modules;
  if (
    process.release.name === 'node' &&
    process.platform === 'linux' &&
    process.arch === 'x64' &&
    (abi === '127' || abi === '137') &&
    process.config.variables.v8_enable_pointer_compression === 0 &&
    process.config.variables.v8_enable_sandbox === 0 &&
    standardDataMethod(WeakMap.prototype, 'get') &&
    standardDataMethod(WeakMap.prototype, 'set') &&
    standardDataMethod(Object, 'getPrototypeOf') &&
    standardDataMethod(Object, 'getOwnPropertyNames') &&
    standardDataMethod(Map.prototype, 'set') &&
    standardDataMethod(Map.prototype, 'get') &&
    standardDataMethod(Set.prototype, 'add') &&
    standardDataMethod(Set.prototype, 'has') &&
    standardDataMethod(WeakMap.prototype, 'delete') &&
    standardDataMethod(Object.prototype, 'hasOwnProperty') &&
    standardDataMethod(Object, 'keys') &&
    standardDataMethod(Object, 'defineProperty') &&
    standardDataMethod(Object, 'create') &&
    standardDataMethod(Object, 'getOwnPropertyDescriptor') &&
    standardDataMethod(Reflect, 'apply') &&
    standardDataMethod(Function.prototype, 'toString') &&
    hasNativeArrayIterator()
  ) {
    const loadOptional = require;
    const addonPath = loadOptional('node:path').resolve(
      __dirname,
      '../dist/native/linux-x64-' + abi + '.node',
    );
    const addon = loadOptional(addonPath);
    const cloneDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'structuredClone',
    );
    if (
      !cloneDescriptor ||
      !addon.stockClone(
        cloneDescriptor.value,
        Object.getOwnPropertyDescriptor(process, 'nextTick')?.value,
        Object.getOwnPropertyDescriptor(
          loadOptional('node:timers'),
          'setTimeout',
        )?.value,
      )
    )
      throw new Error('Use standard history handling');
    const { markAsUncloneable } = loadOptional('node:worker_threads');
    const { Buffer: NodeBuffer } = loadOptional('node:buffer');
    const plain = { role: 'user', content: 'negative control' };
    const marked = { role: 'user', content: 'negative control' };
    if (!addon.sameShape(plain, marked))
      throw new Error('Use standard history handling');
    markAsUncloneable(marked);
    if (addon.sameShape(plain, marked))
      throw new Error('Use standard history handling');
    let rejected = false;
    try {
      cloneDescriptor.value(marked);
    } catch (error) {
      rejected = error?.name === 'DataCloneError';
    }
    if (!rejected) throw new Error('Use standard history handling');
    if (
      typeof addon.sameShape === 'function' &&
      typeof addon.classify === 'function' &&
      typeof markAsUncloneable === 'function'
    ) {
      bindings = {
        installSaved: addon.installSaved,
        isLazyEnvelope: addon.isLazyEnvelope,
        cloneEnvelope: addon.cloneEnvelope,
        isProxy: loadOptional('node:util').types.isProxy,
        sameShape: addon.sameShape,
        classify: addon.classify,
        markAsUncloneable,
        NodeBuffer,
      };
    }
  }
} catch {
  // Missing, incompatible or failing optional native code leaves the baseline active.
}
module.exports = bindings;
