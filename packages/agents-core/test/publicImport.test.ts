import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as workers from 'node:worker_threads';
import { expect, it } from 'vitest';

const runNode = promisify(execFile);
// Source-only checks have no built entries; partial builds must still fail.
const built = existsSync(new URL('../dist', import.meta.url));
const builtImport = it.skipIf(!built);
const fixture = fileURLToPath(
  new URL('./fixtures/publicImport.cjs', import.meta.url),
);

async function importPublicEntry(
  scenario:
    | 'buffer-uninitialized'
    | 'buffer-observed'
    | 'util-unrelated'
    | 'clone-policy',
  format: 'cjs' | 'esm',
) {
  const { stdout } = await runNode(
    process.execPath,
    [fixture, scenario, format],
    {
      env: { PATH: process.env.PATH, OPENAI_AGENTS_DISABLE_TRACING: '1' },
      timeout: 30_000,
    },
  );
  expect(stdout.trim()).toBe('imported');
}

it
  .skipIf(!built || !('markAsUncloneable' in workers))
  .each(['cjs', 'esm'] as const)(
  'preserves a clone policy installed before loading %s',
  async (format) => {
    await importPublicEntry('clone-policy', format);
  },
);

builtImport.each(['cjs', 'esm'] as const)(
  'imports the public %s entry before the application initializes its Buffer binding',
  async (format) => {
    await importPublicEntry('buffer-uninitialized', format);
  },
);

builtImport(
  'imports the public ESM entry without reading unrelated util exports',
  async () => {
    await importPublicEntry('util-unrelated', 'esm');
  },
);

builtImport.each(['cjs', 'esm'] as const)(
  'imports the public %s entry without observing the application Buffer binding',
  async (format) => {
    await importPublicEntry('buffer-observed', format);
  },
);
