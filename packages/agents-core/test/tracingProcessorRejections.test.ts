import { describe, expect, it, vi } from 'vitest';

import coreLogger from '../src/logger';
import type { TracingProcessor } from '../src/tracing/processor';
import type { Span } from '../src/tracing/spans';
import type { Trace } from '../src/tracing/traces';
import {
  setTraceProcessors,
  setTracingDisabled,
  withCustomSpan,
  withTrace,
} from '../src/tracing';

class RejectingSpanProcessor implements TracingProcessor {
  async onTraceStart(_trace: Trace): Promise<void> {}

  async onTraceEnd(_trace: Trace): Promise<void> {}

  onSpanStart(_span: Span<any>): Promise<void> {
    return Promise.reject(new Error('span start failed'));
  }

  onSpanEnd(_span: Span<any>): Promise<void> {
    return Promise.reject(new Error('span end failed'));
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

describe('span tracing processor failures', () => {
  it('contains rejected registered span hooks while the traced operation completes', async () => {
    const errorSpy = vi.spyOn(coreLogger, 'error').mockImplementation(() => {});
    setTracingDisabled(false);
    setTraceProcessors([new RejectingSpanProcessor()]);

    try {
      const result = await withTrace('processor-failure-trace', async () =>
        withCustomSpan(
          async () => 'completed',
          { data: { name: 'processor-failure', data: {} } },
        ),
      );

      expect(result).toBe('completed');
      await vi.waitFor(() => {
        expect(
          errorSpy.mock.calls.some(
            ([message]) =>
              message === 'Tracing processor failed during span start',
          ),
        ).toBe(true);
        expect(
          errorSpy.mock.calls.some(
            ([message]) => message === 'Tracing processor failed during span end',
          ),
        ).toBe(true);
      });
    } finally {
      setTraceProcessors([]);
      setTracingDisabled(true);
      errorSpy.mockRestore();
    }
  });
});
