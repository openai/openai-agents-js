import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesystemMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: filesystemMocks.lstat,
    stat: filesystemMocks.stat,
  };
});

import { pathExists } from '../../src/sandbox/sandboxes/shared/localWorkspace';

describe('local workspace path probes', () => {
  beforeEach(() => {
    filesystemMocks.stat.mockReset();
    filesystemMocks.lstat.mockReset();
  });

  it.each([
    { name: 'a regular file', isSymbolicLink: false },
    { name: 'a directory', isSymbolicLink: false },
  ])(
    'recognizes $name created after the initial stat',
    async ({ isSymbolicLink }) => {
      filesystemMocks.stat.mockRejectedValueOnce(
        Object.assign(new Error('No such file or directory'), {
          code: 'ENOENT',
        }),
      );
      filesystemMocks.lstat.mockResolvedValueOnce({
        isSymbolicLink: () => isSymbolicLink,
      });

      await expect(pathExists('/workspace/concurrent')).resolves.toBe(true);
    },
  );

  it('continues treating dangling symbolic links as missing', async () => {
    filesystemMocks.stat.mockRejectedValueOnce(
      Object.assign(new Error('No such file or directory'), { code: 'ENOENT' }),
    );
    filesystemMocks.lstat.mockResolvedValueOnce({ isSymbolicLink: () => true });
    filesystemMocks.stat.mockRejectedValueOnce(
      Object.assign(new Error('No such file or directory'), { code: 'ENOENT' }),
    );

    await expect(pathExists('/workspace/dangling')).resolves.toBe(false);
  });

  it('recognizes a valid symbolic link created after the initial stat', async () => {
    filesystemMocks.stat.mockRejectedValueOnce(
      Object.assign(new Error('No such file or directory'), { code: 'ENOENT' }),
    );
    filesystemMocks.lstat.mockResolvedValueOnce({ isSymbolicLink: () => true });
    filesystemMocks.stat.mockResolvedValueOnce({});

    await expect(pathExists('/workspace/created-link')).resolves.toBe(true);
  });
});
