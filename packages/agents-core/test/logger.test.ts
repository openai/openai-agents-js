import { afterEach, describe, expect, test, vi } from 'vitest';

describe('logger', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('does not evaluate logging flags at module initialization', async () => {
    const configModule = await import('../src/config');
    const modelDataSpy = vi.spyOn(
      configModule.logging,
      'dontLogModelData',
      'get',
    );
    const toolDataSpy = vi.spyOn(
      configModule.logging,
      'dontLogToolData',
      'get',
    );

    const loggerModule = await import('../src/logger');

    expect(modelDataSpy).not.toHaveBeenCalled();
    expect(toolDataSpy).not.toHaveBeenCalled();

    const logger = loggerModule.getLogger('test');

    expect(modelDataSpy).not.toHaveBeenCalled();
    expect(toolDataSpy).not.toHaveBeenCalled();

    void logger.dontLogModelData;
    void logger.dontLogToolData;

    expect(modelDataSpy).toHaveBeenCalledTimes(1);
    expect(toolDataSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['tool', 'logToolActionError', 'dontLogToolData'],
    ['model', 'logModelActionError', 'dontLogModelData'],
  ] as const)(
    'redacts %s errors and supplemental payloads when data logging is disabled',
    async (_kind, helperName, flagName) => {
      const loggerModule = await import('../src/logger');
      const targetLogger = loggerModule.getLogger('test');
      const errorSpy = vi
        .spyOn(targetLogger, 'error')
        .mockImplementation(() => {});
      vi.spyOn(targetLogger, flagName, 'get').mockReturnValue(true);
      const secret = 'SECRET_LOG_VALUE_123';

      loggerModule[helperName](
        targetLogger,
        'Operation failed',
        new Error(secret),
        {
          secret,
        },
      );

      expect(errorSpy).toHaveBeenCalledWith('Operation failed', 'Error');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
    },
  );

  test.each([
    ['tool', 'logToolActionError', 'dontLogToolData'],
    ['model', 'logModelActionError', 'dontLogModelData'],
  ] as const)(
    'preserves existing %s error details when data logging is enabled',
    async (_kind, helperName, flagName) => {
      const loggerModule = await import('../src/logger');
      const targetLogger = loggerModule.getLogger('test');
      const errorSpy = vi
        .spyOn(targetLogger, 'error')
        .mockImplementation(() => {});
      vi.spyOn(targetLogger, flagName, 'get').mockReturnValue(false);
      const error = new Error('SECRET_LOG_VALUE_123');
      const details = { secret: 'SECRET_LOG_VALUE_123' };

      loggerModule[helperName](
        targetLogger,
        'Operation failed',
        error,
        details,
      );

      expect(errorSpy).toHaveBeenCalledWith('Operation failed', error, details);
    },
  );

  test('uses safe types for non-Error thrown values', async () => {
    const { getSafeErrorType } = await import('../src/logger');

    expect(getSafeErrorType('SECRET_LOG_VALUE_123')).toBe('string');
    expect(getSafeErrorType({ secret: 'SECRET_LOG_VALUE_123' })).toBe('object');
  });

  test('does not inspect overridden Error constructors', async () => {
    const { getSafeErrorType } = await import('../src/logger');
    const constructorGetter = vi.fn(() => {
      throw new Error('The Error constructor must not be inspected.');
    });
    const error = new Error('SECRET_LOG_VALUE_123');
    Object.defineProperty(error, 'constructor', { get: constructorGetter });

    expect(getSafeErrorType(error)).toBe('Error');
    expect(constructorGetter).not.toHaveBeenCalled();
  });

  test('does not expose overridden Error constructor names', async () => {
    const { getSafeErrorType } = await import('../src/logger');
    const error = new Error('SECRET_LOG_VALUE_123');
    Object.defineProperty(error, 'constructor', {
      value: { name: 'SECRET_CONSTRUCTOR_NAME_123' },
    });

    expect(getSafeErrorType(error)).toBe('Error');
  });
});
