import { describe, expect, it, vi } from 'vitest';

import coreLogger from '../src/logger';
import {
  MultiTracingProcessor,
  type TracingProcessor,
} from '../src/tracing/processor';
import type { Span } from '../src/tracing/spans';
import { Trace } from '../src/tracing/traces';

function handledRejection(error: Error): Promise<void> {
  const promise = Promise.reject(error);
  void promise.catch(() => {});
  return promise;
}

class BaseProcessor implements TracingProcessor {
  tracesStarted: Trace[] = [];

  async onTraceStart(trace: Trace): Promise<void> {
    this.tracesStarted.push(trace);
  }

  async onTraceEnd(_trace: Trace): Promise<void> {}

  async onSpanStart(_span: Span<any>): Promise<void> {}

  async onSpanEnd(_span: Span<any>): Promise<void> {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

class RejectingShutdownProcessor extends BaseProcessor {
  shutdown(): Promise<void> {
    return handledRejection(new Error('shutdown failed'));
  }
}

describe('tracing processor replacement failures', () => {
  it('handles rejected old-processor shutdowns while installing replacements', async () => {
    const errorSpy = vi.spyOn(coreLogger, 'error').mockImplementation(() => {});
    const multiProcessor = new MultiTracingProcessor();
    const oldProcessor = new RejectingShutdownProcessor();
    const replacement = new BaseProcessor();
    multiProcessor.addTraceProcessor(oldProcessor);

    expect(() => multiProcessor.setProcessors([replacement])).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      errorSpy.mock.calls.some(
        ([message]) =>
          message === 'Error shutting down replaced tracing processor',
      ),
    ).toBe(true);

    const trace = new Trace({ name: 'replacement-check' }, replacement);
    await multiProcessor.onTraceStart(trace);
    expect(replacement.tracesStarted).toEqual([trace]);

    errorSpy.mockRestore();
  });
});
