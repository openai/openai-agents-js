import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { beforeAll, expect, it, vi } from 'vitest';
import { providerMetadataFixture } from './fixtures/worker-provider-metadata';
const path = new URL('../native/codex-turn-control.wasm', import.meta.url);
let control: WebAssembly.Module;
beforeAll(async () => {
  if (existsSync(path)) control = new WebAssembly.Module(await readFile(path));
});
it.skipIf(!existsSync(path)).each(['buffered', 'streamed'] as const)(
  'retains private %s continuation through tools and completed restore',
  async (mode) => {
    for (const foreign of [false, true])
      expect(
        await providerMetadataFixture(control, mode, foreign),
      ).toMatchObject({
        effects: 1,
        requests: 3,
        privateCheckpoint: true,
        privateObserver: false,
        foreign,
      });
  },
);

it.skipIf(!existsSync(path))(
  'observes AI SDK streaming without a global Buffer',
  async () => {
    vi.stubGlobal('Buffer', undefined);
    try {
      expect(await providerMetadataFixture(control, 'streamed')).toMatchObject({
        effects: 1,
        requests: 3,
        privateObserver: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
