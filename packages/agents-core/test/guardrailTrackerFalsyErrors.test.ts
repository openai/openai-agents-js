import { describe, expect, it } from 'vitest';

import { createGuardrailTracker } from '../src/runner/guardrails';

async function captureRejection(promise: Promise<void>) {
  try {
    await promise;
    return { rejected: false as const, reason: undefined };
  } catch (reason) {
    return { rejected: true as const, reason };
  }
}

const falsyReasons: unknown[] = [null, undefined, 0, false, ''];

describe('createGuardrailTracker', () => {
  it.each(falsyReasons)(
    'awaitCompletion preserves a falsy rejection reason: %p',
    async (reason) => {
      const tracker = createGuardrailTracker();
      tracker.setPromise(Promise.reject(reason));

      const result = await captureRejection(tracker.awaitCompletion());

      expect(tracker.failed).toBe(true);
      expect(result.rejected).toBe(true);
      expect(result.reason).toBe(reason);
    },
  );

  it.each(falsyReasons)(
    'throwIfError preserves a falsy stored error: %p',
    async (reason) => {
      const tracker = createGuardrailTracker();
      tracker.setError(reason);

      const result = await captureRejection(tracker.throwIfError());

      expect(tracker.failed).toBe(true);
      expect(result.rejected).toBe(true);
      expect(result.reason).toBe(reason);
    },
  );
});
