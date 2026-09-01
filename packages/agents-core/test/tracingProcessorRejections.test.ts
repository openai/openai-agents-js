import { describe, expect, it, vi } from 'vitest';

import coreLogger from '../src/logger';
import { Span, type CustomSpanData } from '../src/tracing/spans';
import type { TracingProcessor } from '../src/tracing/processor';
import type { Trace } from '../src/tracing/traces';

function handledRejection(error: Error): Promise<void> {
  const promise = Promise.reject(error);
  void promise.catch(() => {});
  return promise;
}

class RejectingSpanProcessor implements TracingProcessor {
  async onTraceStart(_trace: Trace): Promise<void> {}

  async onTraceEnd(_trace: Trace): Promise<void> {}

  onSpanStart(): Promise<void> {
    return handledRejection(new Error('span start failed'));
  }

  onSpanEnd(): Promise<void> {
    return handledRejection(new Error('span end failed'));
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

describe('span tracing processor failures', () => {
  it('handles rejected async span lifecycle hooks without unhandled rejections', async () => {
    const errorSpy = vi.spyOn(coreLogger, 'error').mockImplementation(() => {});
    const data: CustomSpanData = {
      type: 'custom',
      name: 'processor-failure',
      data: {},
    };
    const span = new Span(
      {
        traceId: 'trace_processor_failure',
        data,
      },
      new RejectingSpanProcessor(),
    );

    expect(() => span.start()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(() => span.end()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      errorSpy.mock.calls.some(
        ([message]) => message === 'Tracing processor failed during span start',
      ),
    ).toBe(true);
    expect(
      errorSpy.mock.calls.some(
        ([message]) => message === 'Tracing processor failed during span end',
      ),
    ).toBe(true);

    errorSpy.mockRestore();
  });
});
