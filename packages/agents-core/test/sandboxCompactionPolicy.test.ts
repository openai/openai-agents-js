import { describe, expect, it } from 'vitest';
import { DynamicCompactionPolicy } from '../src/sandbox';

describe('DynamicCompactionPolicy', () => {
  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects an invalid threshold ratio %s',
    (thresholdRatio) => {
      expect(() => new DynamicCompactionPolicy(thresholdRatio)).toThrow(
        'DynamicCompactionPolicy.thresholdRatio must be a finite number between 0 and 1.',
      );
    },
  );

  it.each([0, 1])('accepts boundary threshold ratio %s', (thresholdRatio) => {
    const policy = new DynamicCompactionPolicy(thresholdRatio);

    expect(policy.compactThreshold('gpt-5-mini')).toBe(
      Math.floor(400000 * thresholdRatio),
    );
  });
});
