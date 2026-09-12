import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnixLocalFiles } from '../../src/sandbox/sandboxes/shared/unixLocalFiles';

const fsMocks = vi.hoisted(() => ({
  realpathSync: vi.fn((path: string) => path),
  accessSync: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: fsMocks.realpathSync,
    accessSync: fsMocks.accessSync,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: childProcessMocks.spawnSync,
  };
});

const processPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

function pretendUnixHost() {
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  });
}

describe('UnixLocalFiles python discovery', () => {
  beforeEach(() => {
    pretendUnixHost();
    childProcessMocks.spawnSync.mockReturnValue({
      status: 0,
      error: undefined,
      stdout: 'ready',
      stderr: '',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    childProcessMocks.spawnSync.mockReset();
    fsMocks.realpathSync.mockClear();
    fsMocks.accessSync.mockClear();
    if (processPlatformDescriptor) {
      Object.defineProperty(process, 'platform', processPlatformDescriptor);
    }
  });

  it.each(['', '   '])(
    'discovers the default python3 when OPENAI_AGENTS_PYTHON is %j',
    (value) => {
      vi.stubEnv('OPENAI_AGENTS_PYTHON', value);
      expect(new UnixLocalFiles().backend).toBe('python');
      expect(childProcessMocks.spawnSync).toHaveBeenCalled();
    },
  );

  it('uses a configured absolute OPENAI_AGENTS_PYTHON after trim', () => {
    vi.stubEnv('OPENAI_AGENTS_PYTHON', '  /custom/python3  ');
    expect(new UnixLocalFiles().backend).toBe('python');
    expect(childProcessMocks.spawnSync).toHaveBeenCalledWith(
      '/custom/python3',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('does not fall back to default discovery for a relative override', () => {
    vi.stubEnv('OPENAI_AGENTS_PYTHON', './python3');
    expect(new UnixLocalFiles().backend).toBe('node');
    expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
  });
});
