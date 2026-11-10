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
import { OutputValidationError } from '../src/runtime/output';

it('returns a validated success if optional usage tracing fails', async () => {
  const decide = bindDecide({
    provider: {
      async getDecision() {
        return { value: true };
      },
    },
    assertActive() {},
  });
  await expect(decide('Ready?', { input: 'Explicit.' })).resolves.toBe(true);
});
it('preserves the exact completed refusal if optional usage tracing fails', async () => {
  const refusal = new DecisionError('refusal', {
    requestId: 'completed-refusal',
  });
  const decide = bindDecide({
    provider: {
      async getDecision() {
        throw refusal;
      },
    },
    assertActive() {},
  });
  await expect(decide('Ready?', { input: 'Explicit.' })).rejects.toBe(refusal);
});
it('still rejects wrong-schema output after optional usage tracing fails', async () => {
  const decide = bindDecide({
    provider: {
      async getDecision() {
        return { value: 'yes' };
      },
    },
    assertActive() {},
  });
  await expect(decide('Ready?', { input: 'Explicit.' })).rejects.toBeInstanceOf(
    OutputValidationError,
  );
});
it('still preserves cancellation after optional usage tracing fails', async () => {
  const controller = new AbortController(),
    reason = new Error('application cancelled');
  const decide = bindDecide({
    provider: {
      async getDecision() {
        controller.abort(reason);
        return { value: true };
      },
    },
    assertActive() {},
  });
  await expect(
    decide('Ready?', { input: 'Explicit.', signal: controller.signal }),
  ).rejects.toBe(reason);
});
