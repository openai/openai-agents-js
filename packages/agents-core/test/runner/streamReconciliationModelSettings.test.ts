import { describe, expect, it } from 'vitest';

import { getAbortReconciliationModelSettings } from '../../src/runner/streamReconciliation';

describe('abort reconciliation model settings', () => {
  it('disables forced tool choice without mutating the original settings', () => {
    const modelSettings = {
      toolChoice: 'required' as const,
      temperature: 0.2,
    };

    expect(getAbortReconciliationModelSettings(modelSettings)).toEqual({
      toolChoice: 'none',
      temperature: 0.2,
    });
    expect(modelSettings.toolChoice).toBe('required');
  });
});
