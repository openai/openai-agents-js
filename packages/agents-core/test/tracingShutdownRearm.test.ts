import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchTraceProcessor, Trace, type TracingExporter } from '../src';

describe('BatchTraceProcessor timed shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-arm the scheduled export loop after shutdown returns', async () => {
    vi.useFakeTimers();
    let markExportStarted!: () => void;
    let releaseExport!: () => void;
    const exportStarted = new Promise<void>((resolve) => {
      markExportStarted = resolve;
    });
    const exportGate = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    const exporter: TracingExporter = {
      export: async () => {
        markExportStarted();
        await exportGate;
      },
    };
    const processor = new BatchTraceProcessor(exporter, {
      scheduleDelay: 10,
      maxQueueSize: 10,
      maxBatchSize: 10,
    });

    await processor.onTraceStart(new Trace({ name: 'pending' }));
    vi.advanceTimersByTime(10);
    await exportStarted;

    const shutdown = processor.shutdown(5);
    await vi.advanceTimersByTimeAsync(5);
    await shutdown;
    expect(vi.getTimerCount()).toBe(0);

    releaseExport();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows an explicit restart after shutdown', async () => {
    vi.useFakeTimers();
    const exportCalls: number[] = [];
    const exporter: TracingExporter = {
      export: async (items) => {
        exportCalls.push(items.length);
      },
    };
    const processor = new BatchTraceProcessor(exporter, {
      scheduleDelay: 10,
      maxQueueSize: 10,
      maxBatchSize: 10,
    });

    await processor.shutdown();
    processor.start();
    await processor.onTraceStart(new Trace({ name: 'after-restart' }));
    await vi.advanceTimersByTimeAsync(10);

    expect(exportCalls).toEqual([1]);
    await processor.shutdown();
  });
});
