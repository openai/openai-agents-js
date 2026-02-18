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
});
