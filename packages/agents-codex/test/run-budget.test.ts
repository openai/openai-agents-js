import { expect, it, vi } from 'vitest';
import { RunBudgetTracker, type RunBudget } from '../src/runtime/run-budget';

it('retains consumed admissions across detached request-budget checkpoints', () => {
  const original = RunBudgetTracker.capture({ maxRequests: 2 })!;
  original.check(() => {});
  original.charge();
  original.observe(undefined);
  const saved = original.checkpoint();
  const restored = RunBudgetTracker.restoreCheckpoint(
    JSON.parse(JSON.stringify(saved)),
    { maxRequests: 2 },
  );
  restored.check(() => {});
  restored.charge();
  expect(() => restored.check(() => {})).toThrow(
    expect.objectContaining({ code: 'run_budget_exceeded' }),
  );
  expect(restored.checkpoint()).toEqual({
    version: 1,
    maxRequests: 2,
    admittedRequests: 2,
  });
  expect(original.checkpoint()).toEqual(saved);
  saved.admittedRequests = 0;
  saved.maxRequests = 10;
  expect(() => restored.check(() => {})).toThrow(
    expect.objectContaining({ code: 'run_budget_exceeded' }),
  );
  expect(original.checkpoint()).toEqual({
    version: 1,
    maxRequests: 2,
    admittedRequests: 1,
  });
});

it.each([0, 1, Number.MAX_SAFE_INTEGER])(
  'retains an exhausted request budget of %i without checking admission during capture',
  (maxRequests) => {
    const restored = RunBudgetTracker.restoreCheckpoint(
      {
        version: 1,
        maxRequests,
        admittedRequests: maxRequests,
      },
      { maxRequests },
    );
    const saved = restored.checkpoint();
    expect(saved.admittedRequests).toBe(maxRequests);
    expect(() => restored.check(() => {})).toThrow(
      expect.objectContaining({ code: 'run_budget_exceeded' }),
    );
    expect(restored.checkpoint()).toEqual(saved);
  },
);

it.each<RunBudget>([
  { maxEstimatedCostMicros: 1 },
  { maxRequests: 1, maxEstimatedCostMicros: 1 },
])(
  'refuses cost-limited checkpoints without invoking an estimator',
  (limits) => {
    const estimateCostMicros = vi.fn(() => 1);
    const budget = RunBudgetTracker.capture({ ...limits, estimateCostMicros })!;
    budget.observe({ total_tokens: 1 });
    expect(() => budget.checkpoint()).toThrow(
      'Estimated-cost run budgets do not support portable checkpoints',
    );
    expect(estimateCostMicros).not.toHaveBeenCalled();
  },
);

it.each([
  null,
  [],
  {},
  { version: 2, maxRequests: 1, admittedRequests: 0 },
  { version: 1, maxRequests: -1, admittedRequests: 0 },
  { version: 1, maxRequests: true, admittedRequests: 0 },
  { version: 1, maxRequests: 1, admittedRequests: 2 },
  { version: 1, maxRequests: 1, admittedRequests: -1 },
  { version: 1, maxRequests: 1, admittedRequests: 0.5 },
  { version: 1, maxRequests: 1, admittedRequests: '0' },
  { version: 1, maxRequests: Infinity, admittedRequests: 0 },
  { version: 1, maxRequests: Number.MAX_SAFE_INTEGER + 1, admittedRequests: 0 },
  { version: 1, maxRequests: 1, admittedRequests: 0, maxTokens: 10 },
])('rejects a malformed request-budget checkpoint: %j', (saved) => {
  expect(() =>
    RunBudgetTracker.restoreCheckpoint(saved, { maxRequests: 1 }),
  ).toThrow();
});

it.each([
  {
    maxTokens: undefined,
    missingUsage: 'stop',
    code: 'run_budget_usage_unavailable',
    estimates: 0,
  },
  {
    maxTokens: 1,
    missingUsage: 'stop',
    code: 'run_budget_exceeded',
    estimates: 0,
  },
  {
    maxTokens: undefined,
    missingUsage: 'continue',
    code: 'run_budget_exceeded',
    estimates: 1,
  },
] as const)(
  'handles mixed reported and missing usage with $missingUsage and maxTokens=$maxTokens',
  ({ maxTokens, missingUsage, code, estimates }) => {
    const estimateCostMicros = vi.fn(() => 1);
    const budget = RunBudgetTracker.capture({
      maxTokens,
      maxEstimatedCostMicros: 1,
      estimateCostMicros,
      missingUsage,
    })!;

    budget.observe({ total_tokens: 1 });
    budget.observe(undefined);

    expect(() => budget.check(() => {})).toThrow(
      expect.objectContaining({ code, retryable: false }),
    );
    expect(estimateCostMicros).toHaveBeenCalledTimes(estimates);
  },
);

it.each([
  { missingUsage: 'stop', code: 'run_budget_usage_unavailable', estimates: 1 },
  { missingUsage: 'continue', code: 'run_budget_exceeded', estimates: 2 },
] as const)(
  'applies $missingUsage to an unknown estimate with another response pending',
  ({ missingUsage, code, estimates }) => {
    const estimateCostMicros = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(1);
    const budget = RunBudgetTracker.capture({
      maxEstimatedCostMicros: 1,
      estimateCostMicros,
      missingUsage,
    })!;

    budget.observe({ total_tokens: 1 });
    budget.observe({ total_tokens: 2 });

    expect(() => budget.check(() => {})).toThrow(
      expect.objectContaining({ code, retryable: false }),
    );
    expect(estimateCostMicros).toHaveBeenCalledTimes(estimates);
  },
);

it.each([
  undefined,
  { maxRequests: 1 },
  { maxRequests: 3 },
  { maxRequests: 2, maxTokens: 1 },
])('requires the original request-only ceiling on restore: %j', (current) => {
  expect(() =>
    RunBudgetTracker.restoreCheckpoint(
      { version: 1, maxRequests: 2, admittedRequests: 1 },
      current,
    ),
  ).toThrow();
});

it.each([undefined, 2])(
  'retains token consumption and request ceiling %s',
  (maxRequests) => {
    const budget = { maxTokens: 10, maxRequests };
    const source = RunBudgetTracker.capture(budget)!;
    source.charge();
    source.observe({ total_tokens: 4 });
    const saved = source.checkpoint();
    expect(saved).toEqual({
      version: 2,
      maxTokens: 10,
      consumedTokens: 4,
      usageMissing: false,
      missingUsage: 'stop',
      maxRequests: maxRequests ?? null,
      admittedRequests: maxRequests === undefined ? null : 1,
    });
    const restored = RunBudgetTracker.restoreCheckpoint(
      JSON.parse(JSON.stringify(saved)),
      budget,
    );
    restored.check(() => {});
    restored.observe({ total_tokens: 6 });
    expect(() => restored.check(() => {})).toThrow(
      expect.objectContaining({ code: 'run_budget_exceeded' }),
    );
  },
);

it('saturates persisted token consumption without changing usage totals', () => {
  const source = RunBudgetTracker.capture({
    maxTokens: Number.MAX_SAFE_INTEGER,
  })!;
  source.observe({ total_tokens: Number.MAX_SAFE_INTEGER });
  source.observe({ total_tokens: Number.MAX_SAFE_INTEGER });
  expect(source.checkpoint()).toMatchObject({
    consumedTokens: Number.MAX_SAFE_INTEGER,
  });
  const restored = RunBudgetTracker.restoreCheckpoint(source.checkpoint(), {
    maxTokens: Number.MAX_SAFE_INTEGER,
  });
  expect(() => restored.check(() => {})).toThrow(
    expect.objectContaining({ code: 'run_budget_exceeded' }),
  );
});

it.each(['stop', 'continue'] as const)(
  'retains sticky missing usage with policy %s',
  (missingUsage) => {
    const budget = { maxTokens: 10, missingUsage };
    const source = RunBudgetTracker.capture(budget)!;
    source.observe(undefined);
    source.observe({ total_tokens: 1 });
    const restored = RunBudgetTracker.restoreCheckpoint(
      source.checkpoint(),
      budget,
    );
    expect(restored.checkpoint()).toMatchObject({
      consumedTokens: 1,
      usageMissing: true,
      missingUsage,
    });
    if (missingUsage === 'stop')
      expect(() => restored.check(() => {})).toThrow(
        expect.objectContaining({ code: 'run_budget_usage_unavailable' }),
      );
    else restored.check(() => {});
  },
);

it('requires the original trusted token limits and effective policy', () => {
  const saved = RunBudgetTracker.capture({
    maxTokens: 10,
    maxRequests: 2,
  })!.checkpoint();
  for (const current of [
    undefined,
    { maxTokens: 11, maxRequests: 2 },
    { maxTokens: 10 },
    { maxTokens: 10, maxRequests: 2, missingUsage: 'continue' as const },
    { maxTokens: 10, maxRequests: 2, maxEstimatedCostMicros: 1 },
  ])
    expect(() => RunBudgetTracker.restoreCheckpoint(saved, current)).toThrow();
  expect(() =>
    RunBudgetTracker.restoreCheckpoint(saved, {
      maxTokens: 10,
      maxRequests: 2,
      missingUsage: 'stop',
    }),
  ).not.toThrow();
});

it.each([
  { consumedTokens: 11 },
  { consumedTokens: -1 },
  { consumedTokens: 0.5 },
  { consumedTokens: Number.MAX_SAFE_INTEGER + 1 },
  { maxTokens: null },
  { usageMissing: undefined },
  { missingUsage: 'ignore' },
  { maxRequests: 1, admittedRequests: null },
  { maxRequests: null, admittedRequests: 0 },
  { maxRequests: 1, admittedRequests: 2 },
  { extra: true },
])('rejects malformed token receipts %j', (invalid) => {
  const saved = RunBudgetTracker.capture({ maxTokens: 10 })!.checkpoint();
  expect(() =>
    RunBudgetTracker.restoreCheckpoint(
      { ...saved, ...invalid },
      { maxTokens: 10 },
    ),
  ).toThrow();
});
