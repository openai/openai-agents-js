import { expect, it, vi } from 'vitest';
import { RunBudgetTracker } from '../src/runtime/run-budget';

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
