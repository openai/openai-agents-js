import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME,
  getDefaultModel,
  getDefaultModelSettings,
  gpt5ReasoningSettingsRequired,
  isGpt5Default,
  isGpt5OrNewerReasoningModel,
  isGpt5OrNewerDefault,
} from '../src/defaultModel';
import { loadEnv } from '../src/config';
import { Agent } from '../src/agent';
vi.mock('../src/config', () => ({
  loadEnv: vi.fn(),
  logging: {
    dontLogModelData: false,
    dontLogToolData: false,
  },
}));
const mockedLoadEnv = vi.mocked(loadEnv);
beforeEach(() => {
  mockedLoadEnv.mockReset();
  mockedLoadEnv.mockReturnValue({});
});
describe('gpt5ReasoningSettingsRequired', () => {
  test('detects GPT-5 models while ignoring chat latest families', () => {
    expect(gpt5ReasoningSettingsRequired('gpt-5')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.1')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.2')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.2-codex')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.2-pro')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5.4-pro')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5-mini')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5-nano')).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-5-chat-latest')).toBe(false);
    expect(gpt5ReasoningSettingsRequired('gpt-5.1-chat-latest')).toBe(false);
    expect(gpt5ReasoningSettingsRequired('gpt-5.2-chat-latest')).toBe(false);
    expect(gpt5ReasoningSettingsRequired('gpt-5.3-chat-latest')).toBe(false);
  });
  test('returns false for non GPT-5 models', () => {
    expect(gpt5ReasoningSettingsRequired('gpt-4o')).toBe(false);
  });
});
describe('GPT-5-and-newer settings family', () => {
  test.each(['gpt-5', 'gpt-5.1', 'gpt-6-astra'])(
    'recognizes %s independently of effort defaults',
    (model) => {
      expect(isGpt5OrNewerReasoningModel(model)).toBe(true);
    },
  );

  test.each([
    'gpt-4.1',
    'o3',
    'gpt-5-chat-latest',
    'gpt-5.1-chat-latest',
    'gpt-5.2-chat-latest',
    'gpt-5.3-chat-latest',
  ])('keeps %s outside the settings family', (model) => {
    expect(isGpt5OrNewerReasoningModel(model)).toBe(false);
  });

  test('preserves the public GPT-5 helper semantics for later generations', () => {
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'gpt-6-astra',
    });
    expect(isGpt5OrNewerDefault()).toBe(true);
    expect(gpt5ReasoningSettingsRequired('gpt-6-astra')).toBe(false);
    expect(isGpt5Default()).toBe(false);
  });
});
describe('getDefaultModel', () => {
  test('falls back to gpt-5.6-luna when env var missing', () => {
    mockedLoadEnv.mockReturnValue({});
    expect(getDefaultModel()).toBe('gpt-5.6-luna');
  });
  test('lowercases provided env value', () => {
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'GPT-5-MINI',
    });
    expect(getDefaultModel()).toBe('gpt-5-mini');
  });

  test.each(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'lowercases the %s model family from the environment',
    (model) => {
      mockedLoadEnv.mockReturnValue({
        [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: model.toUpperCase(),
      });

      expect(getDefaultModel()).toBe(model);
      expect(new Agent({ name: 'TestAgent' }).modelSettings).toEqual({
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
      });
    },
  );
});
describe('isGpt5Default', () => {
  test('returns true for the built-in GPT-5 default model', () => {
    mockedLoadEnv.mockReturnValue({});
    expect(isGpt5Default()).toBe(true);
  });

  test('returns true only when env points to GPT-5', () => {
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'gpt-5.4',
    });
    expect(isGpt5Default()).toBe(true);
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'gpt-4o-mini',
    });
    expect(isGpt5Default()).toBe(false);
  });
});
describe('getDefaultModelSettings', () => {
  test('uses low reasoning and verbosity for Astra explicitly and through the environment', () => {
    const expected = {
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    };
    expect(getDefaultModelSettings('gpt-6-astra')).toEqual(expected);
    expect(
      new Agent({ name: 'Astra', model: 'gpt-6-astra' }).modelSettings,
    ).toEqual(expected);
    mockedLoadEnv.mockReturnValue({
      [OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]: 'gpt-6-astra',
    });
    expect(getDefaultModelSettings()).toEqual(expected);
    expect(new Agent({ name: 'Default Astra' }).modelSettings).toEqual(
      expected,
    );
  });

  test.each(['gpt-5-mini'])(
    'omits an unregistered effort for %s while retaining shared verbosity',
    (model) => {
      expect(getDefaultModelSettings(model)).toEqual({
        text: { verbosity: 'low' },
      });
      expect(
        new Agent({ name: 'Model without an effort default', model })
          .modelSettings,
      ).toEqual({
        text: { verbosity: 'low' },
      });
    },
  );

  test('returns GPT-5.6 Luna defaults when no model is specified', () => {
    mockedLoadEnv.mockReturnValue({});
    expect(getDefaultModelSettings()).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test('returns none reasoning defaults for GPT-5.1 models', () => {
    expect(getDefaultModelSettings('gpt-5.1')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.1-2025-11-13')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test('returns none reasoning defaults for GPT-5.2 models', () => {
    expect(getDefaultModelSettings('gpt-5.2')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.2-2025-12-11')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test('returns none reasoning defaults for GPT-5.3 codex models', () => {
    expect(getDefaultModelSettings('gpt-5.3-codex')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test('returns none reasoning defaults for GPT-5.4 models', () => {
    expect(getDefaultModelSettings('gpt-5.4')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test('returns none reasoning defaults for GPT-5.4 snapshot families', () => {
    expect(getDefaultModelSettings('gpt-5.4-2026-03-05')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.4-mini-2026-03-17')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.4-nano-2026-03-17')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test('returns none reasoning defaults for GPT-5.4 mini and nano models', () => {
    expect(getDefaultModelSettings('gpt-5.4-mini')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.4-nano')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test('returns low-effort defaults for the base GPT-5 model', () => {
    expect(getDefaultModelSettings('gpt-5')).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5-2025-08-07')).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
  });

  test('returns low-effort defaults for GPT-5.2 codex models', () => {
    expect(getDefaultModelSettings('gpt-5.2-codex')).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
  });

  test('returns medium defaults for GPT-5 pro models', () => {
    expect(getDefaultModelSettings('gpt-5.2-pro')).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.2-pro-2025-12-11')).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.4-pro')).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.4-pro-2026-03-05')).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.5')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.5-2026-05-05')).toEqual({
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
    });
  });

  test.each(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'returns none reasoning defaults for %s',
    (model) => {
      expect(getDefaultModelSettings(model)).toEqual({
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
      });
    },
  );

  test('omits reasoning defaults for GPT-5 variants without confirmed support', () => {
    expect(getDefaultModelSettings('gpt-5-mini')).toEqual({
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5-mini-2025-08-07')).toEqual({
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5-nano')).toEqual({
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5-nano-2025-08-07')).toEqual({
      text: { verbosity: 'low' },
    });
    expect(getDefaultModelSettings('gpt-5.1-codex')).toEqual({
      text: { verbosity: 'low' },
    });
  });

  test('returns empty settings for GPT-5 chat latest aliases', () => {
    expect(getDefaultModelSettings('gpt-5-chat-latest')).toEqual({});
    expect(getDefaultModelSettings('gpt-5.1-chat-latest')).toEqual({});
    expect(getDefaultModelSettings('gpt-5.2-chat-latest')).toEqual({});
    expect(getDefaultModelSettings('gpt-5.3-chat-latest')).toEqual({});
  });

  test('returns empty settings for non GPT-5 models', () => {
    expect(getDefaultModelSettings('gpt-4o')).toEqual({});
  });
});
