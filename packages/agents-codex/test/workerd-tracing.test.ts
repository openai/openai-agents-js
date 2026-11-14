import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { workerTracingFixture } from './fixtures/worker-tracing';

const asset = new URL('../native/codex-turn-control.wasm', import.meta.url);

it.skipIf(!existsSync(asset))(
  'owns native Worker trace scopes, bounded export and concurrent flush barriers',
  async () => {
    const control = new WebAssembly.Module(await readFile(asset));
    const result = await workerTracingFixture(() => control);
    expect(result.fullEvents).toBe(4);
    expect(result.boundedEvents).toBe(4);
    expect(result.concurrentEvents).toBe(8);
    expect(result.cancellationEnds).toBe(2);
    expect(result.barrier).toBe(1);
    expect(result.droppedRecords).toBeGreaterThan(0);
    expect(result.failedDeliveries).toBe(2);
  },
  30_000,
);
