import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Agent } from '../../src/agent';
import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import * as defaultModelModule from '../../src/defaultModel';
import type { Model, ModelSettings } from '../../src/model';
import {
  adjustModelSettingsForNonGPT5RunnerModel,
  maybeResetToolChoice,
} from '../../src/runner/modelSettings';
import { AgentToolUseTracker } from '../../src/runner/toolUseTracker';
import { FakeModelProvider } from '../stubs';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

describe('maybeResetToolChoice', () => {
  const agent = new Agent({ name: 'A' });
  const tracker = new AgentToolUseTracker();
  const modelSettings = { temperature: 0.5, toolChoice: 'auto' as const };

  it('does not reset when resetToolChoice is false', () => {
    const result = maybeResetToolChoice(agent, tracker, modelSettings);
    expect(result.toolChoice).toBe('auto');
  });

  it('resets tool choice once the agent has used a tool', () => {
    const resetAgent = new Agent({ name: 'B', resetToolChoice: true });
    tracker.addToolUse(resetAgent, ['some_tool']);

    const result = maybeResetToolChoice(resetAgent, tracker, modelSettings);
    expect(result.toolChoice).toBeUndefined();
  });

  it('keeps tool choice when the agent has not yet used tools even if resetToolChoice is true', () => {
    const resetAgent = new Agent({ name: 'C', resetToolChoice: true });
    const result = maybeResetToolChoice(resetAgent, tracker, modelSettings);
    expect(result.toolChoice).toBe('auto');
  });
});

describe('adjustModelSettingsForNonGPT5RunnerModel', () => {
  const gpt5Settings: ModelSettings = {
    providerData: { reasoning: { effort: 'low' }, text: { verbosity: 'low' } },
    reasoning: { effort: 'low' },
    text: { verbosity: 'low' },
  };

  const withGpt5Default = () =>
    vi.spyOn(defaultModelModule, 'isGpt5Default').mockReturnValue(true);

  it('keeps GPT-5 provider data when the explicit model is GPT-5', () => {
    const spy = withGpt5Default();
    const result = adjustModelSettingsForNonGPT5RunnerModel(
      true,
      gpt5Settings,
      'gpt-5-mini',
      { ...gpt5Settings },
      'gpt-5-mini',
    );
    expect(result.providerData?.reasoning).toBeDefined();
    expect(result.providerData?.text?.verbosity).toBe('low');
    spy.mockRestore();
  });

  it('strips GPT-5 provider data when the resolved model name is unavailable', () => {
    const spy = withGpt5Default();
    const anonymousModel = {
      getResponse: vi.fn(),
      getStreamedResponse: vi.fn(),
    } as unknown as Model;

    const result = adjustModelSettingsForNonGPT5RunnerModel(
      true,
      gpt5Settings,
      anonymousModel,
      { ...gpt5Settings },
      undefined,
    );
    expect(result.providerData?.reasoning).toBeUndefined();
    expect(result.providerData?.text?.verbosity).toBeUndefined();
    spy.mockRestore();
  });

  it('strips GPT-5-only provider data when a non-GPT-5 model is explicitly set', () => {
    const spy = withGpt5Default();
    const result = adjustModelSettingsForNonGPT5RunnerModel(
      true,
      gpt5Settings,
      'gpt-4o',
      { ...gpt5Settings },
      'gpt-4o',
    );
    expect(result.providerData?.reasoning).toBeUndefined();
    expect(result.providerData?.text?.verbosity).toBeUndefined();
    spy.mockRestore();
  });

  it('does not throw when providerData contains non-serializable values', () => {
    const spy = withGpt5Default();
    const uncloneable = () => 'noop';
    const agentModelSettings: ModelSettings = {
      providerData: {
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        fn: uncloneable,
      },
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    };
    const modelSettings: ModelSettings = {
      providerData: {
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        fn: uncloneable,
      },
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    };

    const result = adjustModelSettingsForNonGPT5RunnerModel(
      true,
      agentModelSettings,
      'gpt-4o',
      modelSettings,
      'gpt-4o',
    );

    expect(result.providerData?.fn).toBe(uncloneable);
    expect(result.providerData?.reasoning).toBeUndefined();
    expect(result.providerData?.text?.verbosity).toBeUndefined();
    expect(result.text?.verbosity).toBeUndefined();
    expect(modelSettings.providerData?.reasoning).toBeDefined();
    expect(modelSettings.providerData?.text?.verbosity).toBe('low');
    expect(modelSettings.text?.verbosity).toBe('low');
    spy.mockRestore();
  });
});
