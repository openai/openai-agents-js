import { describe, expect, it, vi } from 'vitest';

import { Usage } from '../../src/usage';
import {
  getToolUsageRecorder,
  recordToolUsage,
  setToolUsageRecorder,
} from '../../src/runner/usageTracking';

describe('runner usage tracking', () => {
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
});
