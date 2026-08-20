import { describe, expect, it, vi } from 'vitest';

import { Usage } from '../../src/usage';
import {
  attachModelFailureUsage,
  consumeModelFailureUsage,
  createModelFailureUsageScope,
  getToolUsageRecorder,
  recordToolUsage,
  reportModelFailureUsage,
  setToolUsageRecorder,
} from '../../src/runner/usageTracking';

describe('runner usage tracking', () => {
  it('isolates request scopes and falls back to errors after scope cleanup', () => {
    const request = Object.freeze({ _internal: { runnerManagedRetry: true } });
    const firstRecorder = vi.fn();
    const secondRecorder = vi.fn();
    const first = createModelFailureUsageScope(request, firstRecorder);
    const second = createModelFailureUsageScope(request, secondRecorder);
    const firstError = Object.freeze(new Error('first'));
    const secondError = Object.freeze(new Error('second'));
    const usage = new Usage({ inputTokens: 3, outputTokens: 4 });

    reportModelFailureUsage({ ...first.request }, firstError, usage);
    reportModelFailureUsage(second.request, secondError, usage);
    usage.inputTokens = 99;

    expect(firstRecorder).toHaveBeenCalledTimes(1);
    expect(secondRecorder).toHaveBeenCalledTimes(1);
    expect(firstRecorder.mock.calls[0][0].inputTokens).toBe(3);
    expect(consumeModelFailureUsage(firstError)).toBeUndefined();
    expect(first.request._internal).not.toBe(second.request._internal);
    expect(request._internal).toEqual({ runnerManagedRetry: true });

    first.close();
    first.close();
    reportModelFailureUsage(
      first.request,
      firstError,
      new Usage({ totalTokens: 5 }),
    );
    expect(firstRecorder).toHaveBeenCalledTimes(1);
    expect(consumeModelFailureUsage(firstError)?.totalTokens).toBe(5);
    second.close();
  });

  it('records tool usage through non-enumerable tool details metadata', () => {
    const details = {};
    const recorder = vi.fn();
    const usage = new Usage({ inputTokens: 3, outputTokens: 2 });

    setToolUsageRecorder(details, recorder);
    recordToolUsage(details, usage);

    expect(getToolUsageRecorder(details)).toBe(recorder);
    expect(recorder).toHaveBeenCalledOnce();
    expect(recorder).toHaveBeenCalledWith(usage);
    expect(Object.keys(details)).toEqual([]);
  });

  it('consumes detached model failure usage exactly once', () => {
    const error = new Error('model failed');
    const usage = new Usage({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      inputTokensDetails: { cachedTokens: 1 },
      requestUsageEntries: [
        {
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          endpoint: 'responses.create',
        },
      ],
    });

    attachModelFailureUsage(error, usage);
    usage.inputTokens = 100;

    const consumed = consumeModelFailureUsage(error);
    expect(consumed).toMatchObject({
      requests: 1,
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
    expect(consumed?.requestUsageEntries?.[0]?.endpoint).toBe(
      'responses.create',
    );
    expect(consumeModelFailureUsage(error)).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
  });

  it('prepends newly attached usage to unconsumed failure usage', () => {
    const error = new Error('model failed after retry');
    attachModelFailureUsage(
      error,
      new Usage({
        requests: 1,
        inputTokens: 5,
        requestUsageEntries: [
          {
            inputTokens: 5,
            outputTokens: 0,
            totalTokens: 5,
            endpoint: 'responses.create',
          },
        ],
      }),
    );
    attachModelFailureUsage(
      error,
      new Usage({
        requests: 1,
        inputTokens: 3,
        requestUsageEntries: [
          {
            inputTokens: 3,
            outputTokens: 0,
            totalTokens: 3,
            endpoint: 'responses.create',
          },
        ],
      }),
    );

    const consumed = consumeModelFailureUsage(error);
    expect(consumed).toMatchObject({ requests: 2, inputTokens: 8 });
    expect(
      consumed?.requestUsageEntries?.map((entry) => entry.inputTokens),
    ).toEqual([3, 5]);
    expect(consumeModelFailureUsage(error)).toBeUndefined();
  });

  it('tracks failure usage without mutating a frozen error', () => {
    const error = Object.freeze(new Error('frozen model error'));

    expect(() =>
      attachModelFailureUsage(
        error,
        new Usage({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
      ),
    ).not.toThrow();

    expect(consumeModelFailureUsage(error)).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    });
    expect(consumeModelFailureUsage(error)).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
    expect(Object.getOwnPropertySymbols(error)).toEqual([]);
  });
});
