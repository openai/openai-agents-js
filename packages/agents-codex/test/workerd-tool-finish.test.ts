import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { finishFixture } from './fixtures/worker-tool-finish';
const path = new URL('../native/codex-turn-control.wasm', import.meta.url);
let control: WebAssembly.Module;
beforeAll(async () => {
  if (existsSync(path)) control = new WebAssembly.Module(await readFile(path));
});
it
  .skipIf(!existsSync(path))
  .each([
    'single',
    'ordered',
    'cold',
    'guard',
    'invalid',
    'changed',
    'claimed',
    'two',
    'tampered',
    'array',
    'model-array',
  ] as const)('settles native Worker finishTurn: %s', async (mode) => {
  expect((await finishFixture(control, mode)).requests).toBe(1);
});
