import { describe, expect, it } from 'vitest';
import { snapshotRawUsage } from '../../src/utils/rawUsage';

describe('snapshotRawUsage', () => {
  it('preserves field presence and returns a detached JSON object', () => {
    const rawUsage = {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      provider_metric: null,
      omitted_metric: undefined,
    };

    const snapshot = snapshotRawUsage(rawUsage);
    rawUsage.input_tokens_details.cached_tokens = 9;

    expect(snapshot).toEqual({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      provider_metric: null,
    });
  });

  it('returns undefined for absent or non-JSON-compatible usage', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(snapshotRawUsage(undefined)).toBeUndefined();
    expect(snapshotRawUsage([])).toBeUndefined();
    expect(snapshotRawUsage({ provider_metric: 1n })).toBeUndefined();
    expect(
      snapshotRawUsage({ provider_metric: new Map([['key', 'value']]) }),
    ).toBeUndefined();

    const throwingUsage = {
      get input_tokens(): number {
        throw new Error('unavailable');
      },
    };
    expect(snapshotRawUsage(throwingUsage)).toBeUndefined();
    expect(snapshotRawUsage(cyclic)).toBeUndefined();
  });
});
