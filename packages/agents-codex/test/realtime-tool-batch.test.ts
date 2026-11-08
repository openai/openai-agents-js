import { expect, it, vi } from 'vitest';
import { NativeRealtimeToolBatch } from '../src/runtime/realtime-tool-batch';
import type { Turn } from '../src/runtime/session';

it('waits for its own receipt rather than shared root completion', async () => {
  const root = { wait: vi.fn(), cancel: vi.fn() } as unknown as Turn<unknown>;
  const batch = new NativeRealtimeToolBatch('A', ['a'], async () => root);
  const running = batch.run();
  await vi.waitFor(() => expect(batch.admitted).toBe(true));
  expect(root.wait).not.toHaveBeenCalled();
  batch.complete();
  await running;
  expect(batch.cleaned).toBe(true);
});

it('joins exact native retirement without cancelling the shared root', async () => {
  const root = { wait: vi.fn(), cancel: vi.fn() } as unknown as Turn<unknown>;
  const batch = new NativeRealtimeToolBatch('A', ['a'], async () => root);
  const running = batch.run();
  const stopped = expect(running).rejects.toThrow('stopped');
  await vi.waitFor(() => expect(batch.admitted).toBe(true));
  const cancel = batch.cancel();
  expect(batch.cleaned).toBe(false);
  expect(root.cancel).not.toHaveBeenCalled();
  batch.retiredByCore();
  await cancel;
  await stopped;
  expect(batch.cleaned).toBe(true);
});

it('retains a native primary failure while joining its terminal receipt', async () => {
  const original = new Error('root failed');
  const root = {} as Turn<unknown>;
  const batch = new NativeRealtimeToolBatch('A', ['a'], async () => root);
  const running = batch.run();
  await vi.waitFor(() => expect(batch.admitted).toBe(true));
  batch.fail(original);
  await expect(running).rejects.toBe(original);
  expect(batch.cleaned).toBe(true);
});
