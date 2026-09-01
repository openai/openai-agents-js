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

  it('strips provider tool choice overrides without mutating provider data', () => {
    const providerData = {
      tool_choice: 'required',
      custom: 'keep',
      extraBody: {
        tool_choice: 'required',
        metadata: 'keep',
      },
      extra_body: {
        tool_choice: 'required',
        other: 'keep',
      },
    };
    const modelSettings = {
      toolChoice: 'required' as const,
      providerData,
    };

    expect(getAbortReconciliationModelSettings(modelSettings)).toEqual({
      toolChoice: 'none',
      providerData: {
        custom: 'keep',
        extraBody: { metadata: 'keep' },
        extra_body: { other: 'keep' },
      },
    });
    expect(providerData).toEqual({
      tool_choice: 'required',
      custom: 'keep',
      extraBody: {
        tool_choice: 'required',
        metadata: 'keep',
      },
      extra_body: {
        tool_choice: 'required',
        other: 'keep',
      },
    });
  });
});
