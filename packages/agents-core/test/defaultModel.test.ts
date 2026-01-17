import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME,
  getDefaultModel,
  getDefaultModelSettings,
  gpt5ReasoningSettingsRequired,
  isGpt5Default,
} from '../src/defaultModel';
import { loadEnv } from '../src/config';
vi.mock('../src/config', () => ({
  loadEnv: vi.fn(),
}));
const mockedLoadEnv = vi.mocked(loadEnv);
beforeEach(() => {
  mockedLoadEnv.mockReset();
  mockedLoadEnv.mockReturnValue({});
});
describe('gpt5ReasoningSettingsRequired', () => {
  test('detects GPT-5 models while ignoring chat latest', () => {
    expect(gpt5ReasoningSettingsRequired('gpt-5')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.1')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.2')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.2-codex')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5-mini')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5-nano')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5-pro')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5-chat-latest')).toBe(false);
  });
  test('returns false for non GPT-5 models', () => {
    expect(gpt5ReasoningSettingsRequired('gpt-4o')).toBe(false);
  });
});
describe('getDefaultModel', () => {
  test('falls back to gpt-4.1 when env var missing', () => {
    mockedLoadEnv.mockReturnValue({});
    expect(getDefaultModel()).toBe('gpt-4.1');
  });
  test('lowercases provided env value', () => {
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'GPT-5-MINI',
    });
    expect(getDefaultModel()).toBe('gpt-5-mini');
  });
});
describe('isGpt5Default', () => {
  test('returns true only when env points to GPT-5', () => {
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'gpt-5-preview',
    });
    expect(isGpt5Default()).toBe(true);
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'gpt-4o-mini',
    });
    expect(isGpt5Default()).toBe(false);
  });
});
describe('getDefaultModelSettings', () => {
  test('returns reasoning defaults for GPT-5.2 models', () => {
    expect(getDefaultModelSettings('gpt-5.2')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });
  test('returns reasoning defaults for GPT-5.2 codex models', () => {
    expect(getDefaultModelSettings('gpt-5.2-codex')).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
  });
  test('returns reasoning defaults for GPT-5.1 models', () => {
    expect(getDefaultModelSettings('gpt-5.1')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });
  test('returns reasoning defaults for other GPT-5 models', () => {
    expect(getDefaultModelSettings('gpt-5-mini')).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
  });
  test('returns empty settings for non GPT-5 models', () => {
    expect(getDefaultModelSettings('gpt-4o')).toEqual({});
  });
});
