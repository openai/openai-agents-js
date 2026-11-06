import { types } from 'node:util';
import type { JsonObject } from './binding';
import { NativeError } from './native-error';
import { addRunUsage, parseTokenCount, type TokenUsage } from './run-events';

/**
 * Limits for direct native Agent runs and Session submissions. Migration
 * runners reject this option before invoking the selected Model. A new root
 * starts fresh. Live manual replies, retained steering, and SDK output
 * corrections share the root budget. Active portable checkpoints are unavailable.
 *
 * Supply at least one nonnegative safe integer limit. Zero blocks the first
 * preparation. A request already admitted can exceed a usage or cost limit and
 * still finish. These limits do not guarantee actual spending.
 *
 * The request limit counts controlled root model preparation admissions.
 * A preparation can be admitted before any physical transport request is sent.
 * Transport retries, internal requests without their own gate, and independent
 * child requests add no admissions to the root budget.
 * Usage and estimates include raw completions observed on the root, including
 * any compaction usage reported there. Work without a root completion falls
 * outside usage accounting.
 *
 * Rejections use NativeError codes `run_budget_exceeded`,
 * `run_budget_usage_unavailable`, or `run_budget_invalid_estimate`.
 */
export interface RunBudget {
  maxRequests?: number;
  /** Provider-reported total tokens across observed root completions. */
  maxTokens?: number;
  /** Application-estimated cost in integer micro-USD. */
  maxEstimatedCostMicros?: number;
  /**
   * Return a nonnegative safe integer in micro-USD or undefined if unknown.
   * Use a synchronous, stable estimate for the reported usage of each
   * response. The SDK calls it before a subsequent preparation, when it needs
   * the estimate to decide admission. The native usage view represents omitted
   * optional cached input, cache-write input, and reasoning output counts as zero.
   */
  estimateCostMicros?: (usage: TokenUsage) => number | undefined;
  /**
   * By default ('stop'), missing usage or a missing estimate blocks the next
   * preparation when that metric has a limit. An absent estimator is also
   * missing data for a cost limit. 'continue' skips missing data. A reported
   * zero is known usage. Request-only limits need no usage.
   */
  missingUsage?: 'stop' | 'continue';
}

/** The live operation owns this tracker, including any correction Sessions. */
export class RunBudgetTracker {
  private requests = 0n;
  private tokens = 0n;
  private cost = 0n;
  private missing = false;
  private readonly unestimated: TokenUsage[] = [];

  private constructor(
    private readonly maxRequests: number | undefined,
    private readonly maxTokens: number | undefined,
    private readonly maxEstimatedCostMicros: number | undefined,
    private readonly estimateCostMicros: RunBudget['estimateCostMicros'],
    private readonly missingUsage: NonNullable<RunBudget['missingUsage']>,
  ) {}

  static capture(config: RunBudget | undefined): RunBudgetTracker | undefined {
    if (config === undefined) return;
    if (config === null || typeof config !== 'object' || Array.isArray(config))
      throw new TypeError('budget must be an object');
    const {
      maxRequests,
      maxTokens,
      maxEstimatedCostMicros,
      estimateCostMicros,
      missingUsage = 'stop',
    } = config;
    const limits = { maxRequests, maxTokens, maxEstimatedCostMicros };
    if (Object.values(limits).every((value) => value === undefined))
      throw new TypeError('budget requires at least one limit');
    for (const [name, value] of Object.entries(limits))
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new TypeError(
          `budget.${name} must be a nonnegative safe integer`,
        );
    if (missingUsage !== 'stop' && missingUsage !== 'continue')
      throw new TypeError('budget.missingUsage must be stop or continue');
    if (
      estimateCostMicros !== undefined &&
      typeof estimateCostMicros !== 'function'
    )
      throw new TypeError('budget.estimateCostMicros must be callable');
    return new RunBudgetTracker(
      maxRequests,
      maxTokens,
      maxEstimatedCostMicros,
      estimateCostMicros,
      missingUsage,
    );
  }

  observe(raw: JsonObject | undefined): void {
    if (
      this.maxTokens === undefined &&
      this.maxEstimatedCostMicros === undefined
    )
      return;
    if (!raw || raw.total_tokens == null) {
      this.missing = true;
      return;
    }
    const total = BigInt(parseTokenCount(raw.total_tokens));
    if (total < 0n) {
      this.missing = true;
      return;
    }
    if (this.maxTokens !== undefined) this.tokens += total;
    if (this.maxEstimatedCostMicros !== undefined) {
      if (this.estimateCostMicros)
        this.unestimated.push(addRunUsage(null, raw));
      else this.missing = true;
    }
  }

  check(assertActive: () => void): void {
    if (
      (this.maxRequests !== undefined && this.requests >= this.maxRequests) ||
      (this.maxTokens !== undefined && this.tokens >= this.maxTokens) ||
      (this.maxEstimatedCostMicros !== undefined &&
        this.cost >= this.maxEstimatedCostMicros)
    )
      this.exceeded();
    this.checkMissingUsage();
    const maxCost = this.maxEstimatedCostMicros;
    if (maxCost !== undefined)
      for (const usage of this.unestimated.splice(0)) {
        const estimate = this.estimate(usage);
        assertActive();
        if (estimate === undefined) {
          this.missing = true;
          this.checkMissingUsage();
          continue;
        }
        this.cost += BigInt(estimate);
        if (this.cost >= maxCost) this.exceeded();
      }
  }

  private checkMissingUsage(): void {
    if (this.missing && this.missingUsage === 'stop')
      throw new NativeError(
        'Reported usage or a cost estimate is unavailable',
        {
          code: 'run_budget_usage_unavailable',
          retryable: false,
        },
      );
  }

  private exceeded(): never {
    throw new NativeError('Root run budget reached', {
      code: 'run_budget_exceeded',
      retryable: false,
    });
  }

  charge(): void {
    this.requests++;
  }

  private estimate(usage: TokenUsage): number | undefined {
    try {
      const estimator = this.estimateCostMicros;
      const value = estimator?.(usage);
      if (value === undefined || (Number.isSafeInteger(value) && value >= 0))
        return value;
      // A callback outside the synchronous contract may reject asynchronously.
      if (types.isPromise(value)) void value.catch(() => {});
    } catch {
      // Never surface callback errors or values through this diagnostic.
    }
    throw new NativeError(
      'Run budget estimator must return a nonnegative safe integer or undefined',
      {
        code: 'run_budget_invalid_estimate',
        retryable: false,
      },
    );
  }
}
