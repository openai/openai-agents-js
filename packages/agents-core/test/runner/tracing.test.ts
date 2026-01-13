import { describe, expect, it } from 'vitest';

import { getTracing } from '../../src/runner/tracing';

describe('getTracing', () => {
  it('returns the correct tracing mode for each combination', () => {
    expect(getTracing(true, true)).toEqual(false);
    expect(getTracing(true, false)).toEqual(false);
    expect(getTracing(false, true)).toEqual(true);
    expect(getTracing(false, false)).toEqual('enabled_without_data');
  });
});
