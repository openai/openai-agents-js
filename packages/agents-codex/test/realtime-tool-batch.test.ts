import { expect, it, vi } from 'vitest';
import { NativeRealtimeToolBatch } from '../src/runtime/realtime-tool-batch';
import type { Turn } from '../src/runtime/session';

it('retains exact batch cancellation for retry without replacing its primary lifecycle error', async () => {
  const original = new Error('native primary');
  const cleanup = new Error('cancel failed');
  const cancel = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(cleanup)
    .mockResolvedValue(undefined);
  const turn = {
    wait: async () => {
      throw original;
    },
    cancel,
  } as unknown as Turn<unknown>;
  const batch = new NativeRealtimeToolBatch('r', ['call'], async () => turn);
  await expect(batch.run()).rejects.toBe(original);
  expect(batch.cleaned).toBe(false);
  await batch.cancel();
  expect(batch.cleaned).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(2);
});
