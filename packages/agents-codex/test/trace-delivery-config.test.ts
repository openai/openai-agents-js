import { expect, it, vi } from 'vitest';
import { telemetry, type TraceDeliveryConfig } from '../src';

const configureNative = vi.hoisted(() =>
  vi.fn(async (_encoded: string) => undefined),
);
vi.mock('../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/binding')>()),
  binding: async () => ({ configure_telemetry: configureNative }),
}));

it('captures queue and scheduling settings before native initialization', async () => {
  const delivery = {
    maxQueueSize: 2,
    maxQueueBytes: 8192,
    maxBatchSize: 8,
    scheduleDelayMs: 100,
    exportTriggerRatio: 0.5,
  };
  const pending = telemetry.configure({ traceDelivery: delivery });
  delivery.maxBatchSize = 99;
  await pending;
  expect(
    JSON.parse(configureNative.mock.calls.at(-1)![0])['sdk.trace_delivery'],
  ).toEqual({
    max_queue_size: 2,
    max_queue_bytes: 8192,
    max_batch_size: 8,
    schedule_delay_ms: 100,
    export_trigger_ratio: 0.5,
  });
});

it.each([
  ['maxQueueSize', 0],
  ['maxQueueSize', true],
  ['maxQueueSize', 2 ** 32],
  ['maxQueueBytes', -1],
  ['maxBatchSize', 1.5],
  ['scheduleDelayMs', -1],
  ['exportTriggerRatio', Number.NaN],
  ['exportTriggerRatio', Number.POSITIVE_INFINITY],
  ['exportTriggerRatio', -0.1],
  ['exportTriggerRatio', 1.1],
  ['exportTriggerRatio', true],
])('rejects invalid %s before native initialization', async (field, value) => {
  const calls = configureNative.mock.calls.length;
  await expect(
    telemetry.configure({
      traceDelivery: { [field as string]: value } as TraceDeliveryConfig,
    }),
  ).rejects.toThrow(`traceDelivery ${field}`);
  expect(configureNative.mock.calls).toHaveLength(calls);
});
