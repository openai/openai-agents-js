import { afterEach, describe, expect, test, vi } from 'vitest';

const loggingFlagNames = [
  'OPENAI_AGENTS_DONT_LOG_MODEL_DATA',
  'OPENAI_AGENTS_DONT_LOG_TOOL_DATA',
] as const;

const originalLoggingFlags = Object.fromEntries(
  loggingFlagNames.map((flagName) => [flagName, process.env[flagName]]),
) as Record<(typeof loggingFlagNames)[number], string | undefined>;

afterEach(() => {
  vi.resetModules();
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
  test('does not log model or tool data by default', async () => {
    delete process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA;
    delete process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA;
    const { logging } = await import('../src/config');

    expect(logging.dontLogModelData).toBe(true);
    expect(logging.dontLogToolData).toBe(true);
  });

  test.each(['0', 'false'])(
    'enables sensitive data logging when the flags are %s',
    async (flagValue) => {
      process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = flagValue;
      process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = flagValue;
      const { logging } = await import('../src/config');

      expect(logging.dontLogModelData).toBe(false);
      expect(logging.dontLogToolData).toBe(false);
    },
  );

  test.each(['1', 'true'])(
    'disables sensitive data logging when the flags are %s',
    async (flagValue) => {
      process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = flagValue;
      process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = flagValue;
      const { logging } = await import('../src/config');

      expect(logging.dontLogModelData).toBe(true);
      expect(logging.dontLogToolData).toBe(true);
    },
  );

  test.each(['', 'TRUE', 'False', 'yes', ' 0 '])(
    'keeps sensitive data logging disabled for unrecognized value %j',
    async (flagValue) => {
      process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = flagValue;
      process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = flagValue;
      const { logging } = await import('../src/config');

      expect(logging.dontLogModelData).toBe(true);
      expect(logging.dontLogToolData).toBe(true);
    },
  );

  test('supports a programmatic override when environment variables are unavailable', async () => {
    delete process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA;
    delete process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA;
    const { logging, setSensitiveDataLoggingEnabled } =
      await import('../src/config');

    setSensitiveDataLoggingEnabled(true);
    expect(logging.dontLogModelData).toBe(false);
    expect(logging.dontLogToolData).toBe(false);

    setSensitiveDataLoggingEnabled(false);
    expect(logging.dontLogModelData).toBe(true);
    expect(logging.dontLogToolData).toBe(true);
  });

  test('gives the programmatic override precedence over environment variables', async () => {
    process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = '1';
    process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = '1';
    const { logging, setSensitiveDataLoggingEnabled } =
      await import('../src/config');

    setSensitiveDataLoggingEnabled(true);
    expect(logging.dontLogModelData).toBe(false);
    expect(logging.dontLogToolData).toBe(false);
  });

  test.each(['false', 1, null, undefined, new Boolean(true)])(
    'rejects non-boolean programmatic override %j and fails closed',
    async (invalidValue) => {
      const { logging, setSensitiveDataLoggingEnabled } =
        await import('../src/config');
      setSensitiveDataLoggingEnabled(true);

      expect(() =>
        setSensitiveDataLoggingEnabled(invalidValue as never),
      ).toThrow(TypeError);
      expect(logging.dontLogModelData).toBe(true);
      expect(logging.dontLogToolData).toBe(true);
    },
  );
});
