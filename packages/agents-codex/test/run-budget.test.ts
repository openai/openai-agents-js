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
  { maxTokens: 1 },
  { maxEstimatedCostMicros: 1 },
  { maxRequests: 1, maxTokens: 0 },
  { maxRequests: 1, maxEstimatedCostMicros: 1 },
])(
  'refuses usage-limited checkpoints without invoking an estimator',
  (limits) => {
    const estimateCostMicros = vi.fn(() => 1);
    const budget = RunBudgetTracker.capture({ ...limits, estimateCostMicros })!;
    budget.observe({ total_tokens: 1 });
    expect(() => budget.checkpoint()).toThrow(
      'Only request-only run budgets support portable checkpoints',
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
