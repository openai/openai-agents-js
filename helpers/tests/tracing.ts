import {
  setTraceProcessors,
  setTracingDisabled,
  type Span,
  type SpanData,
  type TracingProcessor,
} from '@openai/agents-core';

export function createTestTracingProcessor(
  overrides: Partial<TracingProcessor> = {},
): TracingProcessor {
  return {
    async onTraceStart() {},
    async onTraceEnd() {},
    async onSpanStart() {},
    async onSpanEnd() {},
    async shutdown() {},
    async forceFlush() {},
    ...overrides,
  };
}

/** Tracks whether test work is executing inside a selected Agents span type. */
export function createTracingContextProbe(spanType: SpanData['type']) {
  let active = false;
  const observations: boolean[] = [];
  const processor = createTestTracingProcessor({
    async withSpan<T>(span: Span<any>, fn: () => Promise<T>) {
      if (span.spanData.type !== spanType) return fn();
      active = true;
      try {
        return await fn();
      } finally {
        active = false;
      }
    },
  });

  return {
    processor,
    isActive: () => active,
    observe() {
      observations.push(active);
    },
    observations,
  };
}

/** Exhausts a streamed result when a test only cares about side effects. */
export async function consumeAsyncIterable<T>(
  iterable: AsyncIterable<T>,
): Promise<void> {
  for await (const _value of iterable) {
    // Consume the iterable completely.
  }
}

/** Exposes a promise's controls so lifecycle tests can pause at exact boundaries. */
export function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
