import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const runNode = promisify(execFile);
// Source-only checks have no built entries; partial builds must still fail.
const builtImport = it.skipIf(!existsSync(new URL('../dist', import.meta.url)));

async function importPublicEntry(
  format: 'cjs' | 'esm',
  setup: string,
  after = '',
) {
  const entry = fileURLToPath(
    new URL(
      `../dist/index.${format === 'esm' ? 'mjs' : 'js'}`,
      import.meta.url,
    ),
  );
  const load =
    format === 'esm'
      ? `await import(${JSON.stringify(pathToFileURL(entry).href)})`
      : `require(${JSON.stringify(entry)})`;
  const { stdout } = await runNode(
    process.execPath,
    [
      '--eval',
      `(async () => { ${setup}\n${load}; ${after}
console.log('imported'); })().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    {
      env: { PATH: process.env.PATH, OPENAI_AGENTS_DISABLE_TRACING: '1' },
      timeout: 30_000,
    },
  );
  expect(stdout.trim()).toBe('imported');
}

builtImport.each(['cjs', 'esm'] as const)(
  'imports the public %s entry before the application initializes its Buffer binding',
  async (format) => {
    const setup = `
const { Buffer: NativeBuffer } = require('node:buffer');
Object.defineProperty(globalThis, 'Buffer', {
  configurable: true,
  get() {
      return _Buffer;
    }
});
// This declaration stays uninitialized until the public import has settled.
`;
    await importPublicEntry(format, setup, 'let _Buffer = NativeBuffer;');
  },
);

builtImport(
  'imports the public ESM entry without reading unrelated util exports',
  async () => {
    await importPublicEntry(
      'esm',
      `
Object.defineProperty(require('node:util'), 'styleText', {
  configurable: true,
  enumerable: true,
  get() { throw Error('Unrelated util.styleText getter'); }
});`,
    );
  },
);

builtImport.each(['cjs', 'esm'] as const)(
  'imports the public %s entry without observing the application Buffer binding',
  async (format) => {
    await importPublicEntry(
      format,
      `
const { Buffer: NativeBuffer } = require('node:buffer');
let reads = 0;
Object.defineProperty(globalThis, '_Buffer', {
  configurable: true,
  get() { reads++; return NativeBuffer; }
});
Object.defineProperty(globalThis, 'Buffer', {
  configurable: true,
  get() {
      return _Buffer;
    }
});`,
      `if (reads !== 0) throw Error('Import observed the application Buffer binding');`,
    );
  },
);
