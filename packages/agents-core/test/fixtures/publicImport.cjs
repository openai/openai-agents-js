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

async function preserveClonePolicy(format) {
  const { markAsUncloneable } = module.require('node:worker_threads');
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = (input, ...options) => {
    const copy = clone(input, ...options);
    if (copy?.role === 'user') markAsUncloneable(copy);
    return copy;
  };
  const { Agent, Runner } = await importPublicEntry(format);
  const agent = new Agent({
    name: 'Clone policy',
    model: {
      getResponse() {
        throw new Error('Unexpected dispatch');
      },
    },
  });
  const history = Array.from({ length: 40 }, () => ({
    role: 'user',
    content: 'text',
  }));
  await module
    .require('node:assert/strict')
    .rejects(new Runner({ tracingDisabled: true }).run(agent, history), {
      name: 'DataCloneError',
    });
}

async function runCase(scenario, format) {
  if (scenario === 'clone-policy') {
    await preserveClonePolicy(format);
  } else if (scenario === 'buffer-uninitialized') {
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
