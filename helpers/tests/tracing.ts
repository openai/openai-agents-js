import {
  setTraceProcessors,
  setTracingDisabled,
  type SpanData,
  type TracingProcessor,
} from '@openai/agents-core';

/** Tracks whether test work is executing inside a selected Agents span type. */
export function createTracingContextProbe(spanType: SpanData['type']) {
  let active = false;
  const processor: TracingProcessor = {
    async onTraceStart() {},
    async onTraceEnd() {},
    async onSpanStart() {},
    async onSpanEnd() {},
    async withSpan(span, fn) {
      if (span.spanData.type !== spanType) return fn();
      active = true;
      try {
        return await fn();
      } finally {
        active = false;
      }
    },
    async shutdown() {},
    async forceFlush() {},
  };

  return {
    processor,
    isActive: () => active,
  };
}

/** Runs a test with one tracing processor enabled and restores global tracing state. */
export async function withTestTracingProcessor<T>(
  processor: TracingProcessor,
  fn: () => Promise<T>,
): Promise<T> {
  setTraceProcessors([processor]);
  setTracingDisabled(false);
  try {
    return await fn();
  } finally {
    setTracingDisabled(true);
    setTraceProcessors([]);
  }
}
