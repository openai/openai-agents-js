import { describe, expect, it } from 'vitest';
import {
  addModelReportedUsage,
  attachConfiguredModelUsageSource,
  attachModelUsageSource,
  mergeConfiguredChildRestoreUsage,
  modelAttemptUsage,
  restoreModelUsageOffset,
  type ModelAttemptOwner,
} from '../src/runtime/model-attempts';
import { runUsageSnapshot, type RunUsage } from '../src/runtime/run-events';
const usage = (
  requests: number,
  tokens: number | bigint,
  missing = 0,
): RunUsage =>
  runUsageSnapshot(
    {
      inputTokens: tokens,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: tokens,
    },
    requests,
    missing,
  );
const owner = (initial = usage(0, 0)): ModelAttemptOwner => {
  const value: ModelAttemptOwner = {
    tokenUsage: null,
    requests: 0,
    missingUsageRequests: 0,
  };
  restoreModelUsageOffset(value, initial);
  return value;
};
const add = (value: ModelAttemptOwner, tokens: number, requests = 1) =>
  addModelReportedUsage(
    value,
    { input_tokens: tokens, total_tokens: tokens },
    requests,
    0,
  );
describe('configured child shared totals', () => {
  it.each([false, true])(
    'credits legacy or already included history before child opening: %s',
    (included) => {
      const historical = mergeConfiguredChildRestoreUsage(
        usage(included ? 3 : 2, included ? 19 : 10),
        usage(1, 9),
        included ? usage(1, 9) : undefined,
      );
      const parent = owner(historical);
      expect(modelAttemptUsage(parent)).toMatchObject({
        requests: 3,
        totalTokens: 19,
      });
      const child = owner(usage(1, 9));
      attachConfiguredModelUsageSource(parent, child, usage(1, 9));
      expect(modelAttemptUsage(parent)).toMatchObject({
        requests: 3,
        totalTokens: 19,
      });
      add(child, 5);
      attachConfiguredModelUsageSource(parent, child);
      expect(modelAttemptUsage(parent)).toMatchObject({
        requests: 4,
        totalTokens: 24,
      });
      expect(modelAttemptUsage(parent)).toMatchObject({
        requests: 4,
        totalTokens: 24,
      });
    },
  );
  it('retains earlier accepted work across rollback and a new child owner', () => {
    const parent = owner(usage(3, 19)),
      old = owner(usage(1, 9));
    attachConfiguredModelUsageSource(parent, old, usage(1, 9));
    add(old, 4);
    const reopened = owner(usage(1, 9));
    attachConfiguredModelUsageSource(parent, reopened, usage(1, 9));
    add(reopened, 5);
    expect(modelAttemptUsage(parent)).toMatchObject({
      requests: 5,
      totalTokens: 28,
    });
  });
  it('attributes nested work through one immediate parent', () => {
    const root = owner(usage(4, 24)),
      child = owner(usage(2, 14)),
      grandchild = owner(usage(1, 5));
    attachConfiguredModelUsageSource(root, child, usage(2, 14));
    attachConfiguredModelUsageSource(child, grandchild, usage(1, 5));
    add(grandchild, 3);
    expect(modelAttemptUsage(root)).toMatchObject({
      requests: 5,
      totalTokens: 27,
    });
  });
  it('keeps distinct repeated child occurrences and large counters', () => {
    const parent = owner(),
      a = owner(),
      b = owner();
    attachConfiguredModelUsageSource(parent, a);
    attachConfiguredModelUsageSource(parent, b);
    add(a, 9);
    add(b, 9);
    expect(modelAttemptUsage(parent)).toMatchObject({
      requests: 2,
      totalTokens: 18,
    });
    const exact = 2n ** 60n;
    expect(
      mergeConfiguredChildRestoreUsage(
        usage(3, exact + 9n),
        usage(1, 9),
        usage(1, 9),
      ).totalTokens,
    ).toBe(exact + 9n);
  });
  it('preserves ordinary links and refuses mixed attribution', () => {
    const parent = owner(usage(2, 10)),
      child = owner(usage(1, 9));
    attachModelUsageSource(parent, child);
    attachModelUsageSource(parent, child);
    expect(modelAttemptUsage(parent)).toMatchObject({
      requests: 3,
      totalTokens: 19,
    });
    expect(() => attachConfiguredModelUsageSource(parent, child)).toThrow(
      'plain usage link',
    );
  });
  it('refuses proof outside either scope and inconsistent missing counts', () => {
    expect(() =>
      mergeConfiguredChildRestoreUsage(usage(2, 10), usage(1, 9), usage(2, 9)),
    ).toThrow();
    expect(() =>
      mergeConfiguredChildRestoreUsage(usage(2, 3), usage(1, 9), usage(1, 9)),
    ).toThrow();
    expect(() =>
      mergeConfiguredChildRestoreUsage(
        usage(2, 10, 1),
        usage(1, 9, 1),
        usage(1, 9),
      ),
    ).toThrow();
  });
});
