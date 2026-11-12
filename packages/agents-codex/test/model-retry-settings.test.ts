import { describe, it, expect, vi } from 'vitest';
import { APIUserAbortError } from 'openai';
import { captureModelSettings, modelOverrides } from '../src/runtime/provider';
import {
  retryPolicies,
  isModelCallbackAbort,
  modelRetryFailureToNative,
  type RetryContext,
} from '../src/runtime/model-retry';
function context(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    attemptId: 'opaque-1',
    attempt: 1,
    requestAttempt: 1,
    maxRetries: 2,
    model: 'test',
    threadId: 'thread',
    turnId: 'turn',
    transport: 'http',
    signal: new AbortController().signal,
    error: new Error('original'),
    normalizedError: { isAbort: false, isNetworkError: true, isTimeout: false },
    responseStarted: false,
    retryUnsafeOutput: false,
    localEffects: false,
    stateful: false,
    ...overrides,
  };
}
describe('native retry settings capture', () => {
  it('detaches backoff and captures callback identity without serializing it', () => {
    const policy = vi.fn(() => ({ retry: false }));
    const source = {
      maxRetries: 2,
      backoff: {
        initialDelayMs: 5,
        maxDelayMs: 20,
        multiplier: 2,
        jitter: false,
      },
      policy,
    };
    const captured = captureModelSettings({
      retry: source,
      attemptTimeoutMs: 100,
      invocationTimeoutMs: 500,
    });
    source.backoff.initialDelayMs = 99;
    source.policy = vi.fn(() => ({ retry: true }));
    expect(captured.retry?.policy).toBe(policy);
    expect(captured.retry?.backoff?.initialDelayMs).toBe(5);
    expect(Object.isFrozen(captured.retry)).toBe(true);
    expect(Object.isFrozen(captured.retry?.backoff)).toBe(true);
    const wire = modelOverrides(undefined, captured);
    expect(wire).toEqual({
      invocation_timeout_ms: 500,
      request_controls: {
        attempt_timeout_ms: 100,
        retry: {
          max_retries: 2,
          configured: true,
          has_policy: true,
          backoff: {
            initial_delay_ms: 5,
            max_delay_ms: 20,
            multiplier: 2,
            jitter: false,
          },
        },
      },
    });
    expect(JSON.stringify(wire)).not.toContain('"policy":');
    expect(JSON.stringify(captured)).not.toContain('policy');
  });
  it('distinguishes omission from explicit clear', () => {
    expect(modelOverrides(undefined, {})).toEqual({});
    expect(
      modelOverrides(undefined, { retry: null, attemptTimeoutMs: null }),
    ).toEqual({ request_controls: { retry: null, attempt_timeout_ms: null } });
  });
  it.each([-1, 0.5, NaN, Infinity, 4294967296])(
    'rejects invalid retry count %s',
    (value) =>
      expect(() =>
        captureModelSettings({ retry: { maxRetries: value } }),
      ).toThrow(TypeError),
  );
  it.each([0, -1, 0.5, Infinity, 4294967296])(
    'rejects invalid attempt timeout %s',
    (value) =>
      expect(() => captureModelSettings({ attemptTimeoutMs: value })).toThrow(
        TypeError,
      ),
  );
  it('accepts zero backoff and rejects invalid nested fields', () => {
    expect(
      captureModelSettings({
        retry: {
          maxRetries: 0,
          backoff: {
            initialDelayMs: 0,
            maxDelayMs: 0,
            multiplier: 0,
            jitter: false,
          },
        },
      }).retry?.maxRetries,
    ).toBe(0);
    for (const backoff of [
      { initialDelayMs: -1 },
      { maxDelayMs: NaN },
      { multiplier: Infinity },
      { jitter: 'yes' },
      { unknown: 1 },
    ])
      expect(() =>
        captureModelSettings({ retry: { backoff: backoff as never } }),
      ).toThrow(TypeError);
  });
});
describe('native pure retry policies', () => {
  it('selects normalized network/status/retry-after facts and captures status lists', async () => {
    const statuses = [429];
    const policy = retryPolicies.httpStatus(statuses);
    statuses[0] = 500;
    expect(
      await policy(
        context({
          normalizedError: {
            isAbort: false,
            isNetworkError: false,
            isTimeout: false,
            statusCode: 429,
          },
        }),
      ),
    ).toEqual({ retry: true });
    expect(await retryPolicies.networkError()(context())).toEqual({
      retry: true,
    });
    expect(
      await retryPolicies.retryAfter()(
        context({
          normalizedError: {
            isAbort: false,
            isNetworkError: false,
            isTimeout: false,
            retryAfterMs: 17,
          },
        }),
      ),
    ).toEqual({ retry: true, delayMs: 17 });
    expect(await retryPolicies.never()(context())).toEqual({ retry: false });
  });
  it('retains provider hard veto across any/all approval', async () => {
    const input = context({
      providerAdvice: {
        suggested: false,
        replaySafety: 'safe',
        reason: 'veto',
      },
    });
    for (const combine of [retryPolicies.any, retryPolicies.all])
      expect(
        await combine(retryPolicies.providerSuggested(), () => ({
          retry: true,
          approveUnsafeReplay: true,
        }))(input),
      ).toMatchObject({ retry: false, reason: 'veto' });
  });
  it('delegates provider unsafe veto only to explicit replay approval', async () => {
    const input = context({
      providerAdvice: { suggested: false, replaySafety: 'unsafe' },
    });
    for (const combine of [retryPolicies.any, retryPolicies.all]) {
      expect(
        await combine(retryPolicies.providerSuggested(), () => ({
          retry: true,
        }))(input),
      ).toMatchObject({ retry: false });
      expect(
        await combine(retryPolicies.providerSuggested(), () => ({
          retry: true,
          approveUnsafeReplay: true,
          delayMs: 8,
        }))(input),
      ).toMatchObject({ retry: true, approveUnsafeReplay: true, delayMs: 8 });
    }
  });
  it('freezes normalized/advice views without replacing the original error', async () => {
    const input = context({
      providerAdvice: { suggested: true, replaySafety: 'safe' },
    });
    const seen = vi.fn((view: RetryContext) => {
      expect(view.error).toBe(input.error);
      expect(Object.isFrozen(view.normalizedError)).toBe(true);
      expect(Object.isFrozen(view.providerAdvice)).toBe(true);
      return { retry: true };
    });
    expect(
      await retryPolicies.all(seen, retryPolicies.networkError())(input),
    ).toMatchObject({ retry: true });
  });
  it('preserves policy error and cancellation identity before another policy', async () => {
    const error = new Error('policy');
    await expect(
      retryPolicies.any(() => {
        throw error;
      })(context()),
    ).rejects.toBe(error);
    const controller = new AbortController();
    const reason = new Error('stop');
    const later = vi.fn(() => ({ retry: true }));
    await expect(
      retryPolicies.any(() => {
        controller.abort(reason);
        return { retry: true };
      }, later)(context({ signal: controller.signal })),
    ).rejects.toBe(reason);
    expect(later).not.toHaveBeenCalled();
  });
});

it('keeps non-abort cleanup failures separate from nested abort metadata', () => {
  const aborted = Object.assign(new Error('cancelled'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
  const cleanup = new Error('cleanup failed', { cause: aborted });
  expect(modelRetryFailureToNative(cleanup).is_abort).toBe(true);
  expect(isModelCallbackAbort(cleanup)).toBe(false);
  expect(isModelCallbackAbort(aborted)).toBe(true);
  expect(isModelCallbackAbort(new APIUserAbortError())).toBe(true);
  expect(
    isModelCallbackAbort(
      Object.assign(new Error('cancelled'), { name: 'APIUserAbortError' }),
    ),
  ).toBe(true);
});
