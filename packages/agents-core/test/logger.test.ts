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
    ['logToolActionDebug', 'debug'],
    ['logToolActionWarning', 'warn'],
  ] as const)(
    'redacts tool errors logged with %s',
    async (helperName, method) => {
      const loggerModule = await import('../src/logger');
      const targetLogger = loggerModule.getLogger('test');
      const logSpy = vi
        .spyOn(targetLogger, method)
        .mockImplementation(() => {});
      vi.spyOn(targetLogger, 'dontLogToolData', 'get').mockReturnValue(true);
      const secret = 'SECRET_TOOL_LOG_VALUE_123';

      loggerModule[helperName](
        targetLogger,
        'Operation failed',
        new Error(secret),
        { secret },
      );

      expect(logSpy).toHaveBeenCalledWith('Operation failed', 'Error');
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secret);
    },
  );

  test.each([
    ['logModelAndToolActionDebug', 'debug'],
    ['logModelAndToolActionError', 'error'],
    ['logModelAndToolActionWarning', 'warn'],
  ] as const)(
    'redacts model and tool errors logged with %s when either flag is enabled',
    async (helperName, method) => {
      const loggerModule = await import('../src/logger');
      const secret = 'SECRET_COMBINED_LOG_VALUE_123';

      for (const [dontLogModelData, dontLogToolData] of [
        [true, false],
        [false, true],
        [true, true],
      ] as const) {
        const targetLogger = loggerModule.getLogger('test');
        const logSpy = vi
          .spyOn(targetLogger, method)
          .mockImplementation(() => {});
        vi.spyOn(targetLogger, 'dontLogModelData', 'get').mockReturnValue(
          dontLogModelData,
        );
        vi.spyOn(targetLogger, 'dontLogToolData', 'get').mockReturnValue(
          dontLogToolData,
        );

        loggerModule[helperName](
          targetLogger,
          'Operation failed',
          new Error(secret),
          { secret },
        );

        expect(logSpy).toHaveBeenCalledWith('Operation failed', 'Error');
        expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secret);
      }
    },
  );

  test.each([
    ['logModelAndToolActionDebug', 'debug'],
    ['logModelAndToolActionError', 'error'],
    ['logModelAndToolActionWarning', 'warn'],
  ] as const)(
    'preserves model and tool diagnostics logged with %s when both flags are disabled',
    async (helperName, method) => {
      const loggerModule = await import('../src/logger');
      const targetLogger = loggerModule.getLogger('test');
      const logSpy = vi
        .spyOn(targetLogger, method)
        .mockImplementation(() => {});
      vi.spyOn(targetLogger, 'dontLogModelData', 'get').mockReturnValue(false);
      vi.spyOn(targetLogger, 'dontLogToolData', 'get').mockReturnValue(false);
      const error = new Error('SECRET_COMBINED_LOG_VALUE_123');
      const details = { secret: 'SECRET_COMBINED_LOG_VALUE_123' };

      loggerModule[helperName](
        targetLogger,
        'Operation failed',
        error,
        details,
      );

      expect(logSpy).toHaveBeenCalledWith('Operation failed', error, details);
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

  test.each([
    [
      'revoked Proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
    [
      'Proxy with a throwing prototype trap',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('SECRET_PROXY_TRAP_123');
            },
          },
        ),
    ],
  ] as const)('safely classifies a %s', async (_description, createError) => {
    const { getSafeErrorType } = await import('../src/logger');

    expect(getSafeErrorType(createError())).toBe('object');
  });

  test.each([
    ['tool', 'logToolActionError', 'dontLogToolData'],
    ['model', 'logModelActionError', 'dontLogModelData'],
  ] as const)(
    'safely redacts hostile %s error values',
    async (_kind, helperName, flagName) => {
      const loggerModule = await import('../src/logger');
      const targetLogger = loggerModule.getLogger('test');
      const errorSpy = vi
        .spyOn(targetLogger, 'error')
        .mockImplementation(() => {});
      vi.spyOn(targetLogger, flagName, 'get').mockReturnValue(true);
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();

      loggerModule[helperName](targetLogger, 'Operation failed', proxy);

      expect(errorSpy).toHaveBeenCalledWith('Operation failed', 'object');
    },
  );

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

  test.each([
    ['string', (): unknown => 'SECRET_COMBINED_STRING_123', 'string'],
    [
      'object',
      (): unknown => ({ secret: 'SECRET_COMBINED_OBJECT_123' }),
      'object',
    ],
    [
      'overridden Error constructor',
      (): unknown => {
        const error = new Error('SECRET_COMBINED_ERROR_123');
        Object.defineProperty(error, 'constructor', {
          value: { name: 'SECRET_COMBINED_CONSTRUCTOR_123' },
        });
        return error;
      },
      'Error',
    ],
    [
      'revoked Proxy',
      (): unknown => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
      'object',
    ],
    [
      'throwing prototype trap',
      (): unknown =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('SECRET_COMBINED_PROXY_TRAP_123');
            },
          },
        ),
      'object',
    ],
  ] as const)(
    'safely redacts combined model and tool errors with a %s',
    async (_description, createError, expectedType) => {
      const loggerModule = await import('../src/logger');
      const targetLogger = loggerModule.getLogger('test');
      const warnSpy = vi
        .spyOn(targetLogger, 'warn')
        .mockImplementation(() => {});
      vi.spyOn(targetLogger, 'dontLogModelData', 'get').mockReturnValue(true);
      vi.spyOn(targetLogger, 'dontLogToolData', 'get').mockReturnValue(false);

      expect(() =>
        loggerModule.logModelAndToolActionWarning(
          targetLogger,
          'Operation failed',
          createError(),
        ),
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith('Operation failed', expectedType);
    },
  );

  test('does not expose overridden Error constructor names', async () => {
    const { getSafeErrorType } = await import('../src/logger');
    const error = new Error('SECRET_LOG_VALUE_123');
    Object.defineProperty(error, 'constructor', {
      value: { name: 'SECRET_CONSTRUCTOR_NAME_123' },
    });

    expect(getSafeErrorType(error)).toBe('Error');
  });
});
