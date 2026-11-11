import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TraceEvent } from '../src/runtime/telemetry';

const native = vi.hoisted(() => ({
  configure_telemetry: vi.fn(async () => {}),
  set_trace_routes: vi.fn(() => 0),
  drain_trace_events: vi.fn(async () =>
    JSON.stringify({ events: [], through_sequence: 0 }),
  ),
  ack_trace_events: vi.fn(),
  force_flush_telemetry: vi.fn(async () =>
    JSON.stringify({ status: 'timeout', barrier: 1 }),
  ),
  shutdown_telemetry: vi.fn(async () => {}),
}));
vi.mock('../src/runtime/binding', () => ({ binding: async () => native }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

async function startDelivery(mode: 'backoff' | 'fetch') {
  const telemetry = await import('../src/runtime/telemetry');
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<Response>();
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((_, init) => {
      const signal = init!.signal!;
      entered.resolve(signal);
      if (mode === 'backoff')
        return Promise.resolve(new Response(null, { status: 503 }));
      signal.addEventListener('abort', () => release.reject(signal.reason), {
        once: true,
      });
      return release.promise;
    });
  const event: TraceEvent = {
    sequence: 1,
    processor_ids: ['host-1'],
    lifecycle: 'end',
    trace_id: 'a'.repeat(32),
    span_id: 'b'.repeat(16),
    parent_span_id: null,
    name: 'fallback export',
    kind: 'custom',
    start_time_unix_nanos: '1700000000000000000',
    end_time_unix_nanos: '1700000001000000000',
    attributes: {},
    outcome: 'ok',
    dropped_attributes_count: 0,
  };
  native.drain_trace_events.mockResolvedValueOnce(
    JSON.stringify({ events: [event], through_sequence: 1 }),
  );
  await telemetry.configure({
    traceProcessors: [
      new telemetry.OpenAITraceExporter({
        apiKey: 'synthetic-fallback-key',
        maxRetries: 1,
        timeoutMs: 1000,
        retryDelayMs: 500,
      }),
    ],
  });
  const signal = await entered.promise;
  // Allow the first response to enter backoff before shutdown.
  await Promise.resolve();
  return { telemetry, request, signal, release };
}

for (const mode of ['backoff', 'fetch'] as const) {
  for (const failed of [false, true]) {
    it(`cancels fallback export ${mode} after terminal shutdown (failed=${failed})`, async () => {
      const { telemetry, request, signal, release } = await startDelivery(mode);
      try {
        if (failed) {
          native.shutdown_telemetry.mockRejectedValueOnce(
            new Error('Telemetry shutdown timed out'),
          );
          await expect(telemetry.shutdown({ timeoutMs: 1 })).rejects.toThrow(
            'Telemetry shutdown timed out',
          );
        } else await telemetry.shutdown({ timeoutMs: 1 });
        expect(signal.aborted).toBe(true);
        await vi.waitFor(() =>
          expect(native.ack_trace_events).toHaveBeenCalledWith(1, 1),
        );
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve(new Response(null, { status: 200 }));
        await telemetry.shutdown();
      }
    });
  }
}

it('preserves fallback delivery through flush timeout and rejected shutdown admission', async () => {
  const { telemetry, request, signal, release } = await startDelivery('fetch');
  try {
    expect((await telemetry.forceFlush({ timeoutMs: 1 })).status).toBe(
      'timeout',
    );
    native.shutdown_telemetry.mockRejectedValueOnce(
      new Error('Configure telemetry successfully before shutdown'),
    );
    await expect(telemetry.shutdown()).rejects.toThrow(
      'Configure telemetry successfully before shutdown',
    );
    expect(signal.aborted).toBe(false);
    release.resolve(new Response(null, { status: 200 }));
    await vi.waitFor(() =>
      expect(native.ack_trace_events).toHaveBeenCalledWith(1, 0),
    );
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(new Response(null, { status: 200 }));
    await telemetry.shutdown();
  }
});
