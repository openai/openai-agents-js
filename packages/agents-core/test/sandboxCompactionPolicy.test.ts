import { describe, expect, it } from 'vitest';
import {
  compaction,
  DynamicCompactionPolicy,
  StaticCompactionPolicy,
} from '../src/sandbox';

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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an invalid fallback threshold %s',
    (fallbackThreshold) => {
      expect(() => new DynamicCompactionPolicy(0.9, fallbackThreshold)).toThrow(
        'DynamicCompactionPolicy.fallbackThreshold must be a finite number greater than or equal to 0.',
      );
    },
  );

  it('keeps a valid fallback threshold for unrecognised models', () => {
    const policy = new DynamicCompactionPolicy(0.9, 1000);

    expect(policy.compactThreshold('not-a-known-model')).toBe(1000);
    expect(policy.compactThreshold()).toBe(1000);
  });
});

describe('StaticCompactionPolicy', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    'rejects an invalid threshold %s',
    (threshold) => {
      expect(() => new StaticCompactionPolicy(threshold)).toThrow(
        'StaticCompactionPolicy.threshold must be a finite number greater than or equal to 0.',
      );
    },
  );

  it.each([0, 240000])('accepts a valid threshold %s', (threshold) => {
    expect(new StaticCompactionPolicy(threshold).compactThreshold()).toBe(
      threshold,
    );
  });
});

describe('compaction sampling params', () => {
  it('never serialises a non-numeric compact_threshold', () => {
    // NaN serialises to null on the wire, which is not a valid threshold.
    const params = compaction({
      policy: new StaticCompactionPolicy(240000),
    }).samplingParams({ model: 'gpt-4o' });

    const threshold = (params as any).context_management[0].compact_threshold;
    expect(Number.isFinite(threshold)).toBe(true);
    expect(JSON.parse(JSON.stringify(params))).toEqual(params);
  });
});
