import { afterEach, expect, test, vi } from 'vitest';

const posixModule = '../../src/sandbox/shared/localSourcePosix';
const procfsModule = '../../src/sandbox/shared/localSourceProcfs';

afterEach(() => {
  vi.doUnmock(posixModule);
  vi.doUnmock(procfsModule);
  vi.resetModules();
});

test.skipIf(process.platform !== 'linux')(
  'reports both unavailable backends and retains failed initialization across sources',
  async () => {
    const nativeError = new Error('Native binary cannot load');
    const procfsError = new Error('Procfs is not trusted or accessible');
    const initialize = vi.fn(() => {
      throw nativeError;
    });
    const openProcfsSourceRoot = vi.fn().mockRejectedValue(procfsError);
    vi.doMock(posixModule, initialize);
    vi.doMock(procfsModule, () => ({ openProcfsSourceRoot }));
    const { readLocalSourceFile } =
      await import('../../src/sandbox/shared/localSourceReader');
    for (const path of ['/first', '/second']) {
      const failure = await readLocalSourceFile(path).catch((error) => error);
      expect(failure.code).toBe('ENOTSUP');
      expect(failure.errors).toHaveLength(2);
      // Vitest wraps a failing mock factory and retains its original cause.
      expect(failure.errors[0].cause ?? failure.errors[0]).toBe(nativeError);
      expect(failure.errors[1]).toBe(procfsError);
    }
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(openProcfsSourceRoot).toHaveBeenCalledTimes(2);
  },
);

test.skipIf(process.platform !== 'linux')(
  'preserves source access failures without selecting the procfs backend',
  async () => {
    const denied = Object.assign(new Error('Source access denied'), {
      code: 'EACCES',
    });
    vi.doMock(posixModule, () => ({
      openPosixSourceRoot: vi.fn().mockRejectedValue(denied),
    }));
    const openProcfsSourceRoot = vi.fn();
    vi.doMock(procfsModule, () => ({ openProcfsSourceRoot }));
    const { readLocalSourceFile } =
      await import('../../src/sandbox/shared/localSourceReader');
    await expect(readLocalSourceFile('/input')).rejects.toBe(denied);
    expect(openProcfsSourceRoot).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform !== 'linux')(
  'rejects symbolic link ancestors without selecting the procfs backend',
  async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.doMock(posixModule, () => ({
      openPosixSourceRoot: vi.fn().mockResolvedValue({
        openDirectory: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Symbolic link'), { code: 'ELOOP' }),
          ),
        close,
      }),
    }));
    const openProcfsSourceRoot = vi.fn();
    vi.doMock(procfsModule, () => ({ openProcfsSourceRoot }));
    const { readLocalSourceFile } =
      await import('../../src/sandbox/shared/localSourceReader');
    await expect(readLocalSourceFile('/parent/input')).rejects.toThrow(
      /symbolic link ancestors/,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(openProcfsSourceRoot).not.toHaveBeenCalled();
  },
);
