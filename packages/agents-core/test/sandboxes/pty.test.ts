import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnInPseudoTerminal } from '../../src/sandbox/sandboxes/shared/pty';

const childProcessMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: childProcessMocks.spawnSync,
    spawn: childProcessMocks.spawn,
  };
});

describe('spawnInPseudoTerminal', () => {
  beforeEach(() => {
    childProcessMocks.spawnSync.mockReturnValue({
      status: 0,
      error: undefined,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    });
    childProcessMocks.spawn.mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    childProcessMocks.spawnSync.mockReset();
    childProcessMocks.spawn.mockReset();
  });

  it.each(['', '   '])(
    'uses python3 when OPENAI_AGENTS_PYTHON is %j',
    (value) => {
      vi.stubEnv('OPENAI_AGENTS_PYTHON', value);
      spawnInPseudoTerminal('echo', ['hi']);
      expect(childProcessMocks.spawn).toHaveBeenCalledWith(
        'python3',
        expect.any(Array),
        expect.any(Object),
      );
    },
  );

  it('uses a configured OPENAI_AGENTS_PYTHON executable', () => {
    vi.stubEnv('OPENAI_AGENTS_PYTHON', '  /custom/python3  ');
    spawnInPseudoTerminal('echo', ['hi']);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      '/custom/python3',
      expect.any(Array),
      expect.any(Object),
    );
  });
});
