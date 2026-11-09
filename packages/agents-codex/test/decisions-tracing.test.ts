import { expect, it, vi } from 'vitest';
import type { TraceSpan } from '../src/runtime/tracing-context';
import type { TraceOptions } from '../src/runtime/telemetry';

const tracing = vi.hoisted(() => ({
  failure: new Error('trace transport failed'),
}));
vi.mock('../src/runtime/tracing-context', async (original) => ({
  ...(await original<typeof import('../src/runtime/tracing-context')>()),
  getCurrentSpan: () => ({ context: { disabled: false } }),
  withSpan: async (
    options: TraceOptions,
    callback: (span: TraceSpan) => unknown,
  ) => {
    if (options.name === 'decision.usage') throw tracing.failure;
    return callback({} as TraceSpan);
  },
}));
import { bindDecide, DecisionError } from '../src/runtime/decisions';

it('retains a completed refusal if usage tracing also fails', async () => {
  const refusal = new DecisionError('refusal');
  const decide = bindDecide({
    provider: {
      async getDecision() {
        throw refusal;
      },
    },
    assertActive() {},
  });
  const error = await decide('Ready?', { input: 'Explicit.' }).catch(
    (error) => error,
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([refusal, tracing.failure]);
  expect(error.cause).toBe(refusal);
});
