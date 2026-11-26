/* global module:readonly, _Buffer:readonly */

async function importPublicEntry(format) {
  if (format === 'cjs') return module.require('../../dist/index.js');
  if (format === 'esm') return import('../../dist/index.mjs');
  throw new Error('Unknown public import format');
}

async function importBeforeBufferInitialization(format) {
  const { Buffer: NativeBuffer } = module.require('node:buffer');
  Object.defineProperty(globalThis, 'Buffer', {
    configurable: true,
    get() {
      return _Buffer;
    },
  });
  await importPublicEntry(format);
  // This binding stays uninitialized until the public import has settled.
  let _Buffer = NativeBuffer;
}

async function importWithoutBufferReads(format) {
  const { Buffer: NativeBuffer } = module.require('node:buffer');
  let reads = 0;
  Object.defineProperty(globalThis, '_Buffer', {
    configurable: true,
    get() {
      reads++;
      return NativeBuffer;
    },
  });
  Object.defineProperty(globalThis, 'Buffer', {
    configurable: true,
    get() {
      return _Buffer;
    },
  });
  await importPublicEntry(format);
  if (reads !== 0)
    throw new Error('Import observed the application Buffer binding');
}

async function runCase(scenario, format) {
  if (scenario === 'buffer-uninitialized') {
    await importBeforeBufferInitialization(format);
  } else if (scenario === 'buffer-observed') {
    await importWithoutBufferReads(format);
  } else if (scenario === 'util-unrelated' && format === 'esm') {
    Object.defineProperty(module.require('node:util'), 'styleText', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('Unrelated util.styleText getter');
      },
    });
    await importPublicEntry('esm');
  } else {
    throw new Error('Unknown public import case');
  }
}

const [scenario, format] = globalThis.process.argv.slice(2);
runCase(scenario, format).then(
  () => globalThis.console.log('imported'),
  (error) => {
    globalThis.console.error(error);
    globalThis.process.exitCode = 1;
  },
);
