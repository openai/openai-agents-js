import { afterEach, describe, expect, test } from 'vitest';
import { logging } from '../src/config';

const loggingFlagNames = [
  'OPENAI_AGENTS_DONT_LOG_MODEL_DATA',
  'OPENAI_AGENTS_DONT_LOG_TOOL_DATA',
] as const;

const originalLoggingFlags = Object.fromEntries(
  loggingFlagNames.map((flagName) => [flagName, process.env[flagName]]),
) as Record<(typeof loggingFlagNames)[number], string | undefined>;

afterEach(() => {
  for (const flagName of loggingFlagNames) {
    const originalValue = originalLoggingFlags[flagName];
    if (originalValue === undefined) {
      delete process.env[flagName];
    } else {
      process.env[flagName] = originalValue;
    }
  }
});

describe('logging', () => {
  test('does not log model or tool data by default', () => {
    delete process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA;
    delete process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA;

    expect(logging.dontLogModelData).toBe(true);
    expect(logging.dontLogToolData).toBe(true);
  });

  test.each(['0', 'false'])(
    'enables sensitive data logging when the flags are %s',
    (flagValue) => {
      process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = flagValue;
      process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = flagValue;

      expect(logging.dontLogModelData).toBe(false);
      expect(logging.dontLogToolData).toBe(false);
    },
  );

  test.each(['1', 'true'])(
    'disables sensitive data logging when the flags are %s',
    (flagValue) => {
      process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = flagValue;
      process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = flagValue;

      expect(logging.dontLogModelData).toBe(true);
      expect(logging.dontLogToolData).toBe(true);
    },
  );
});
