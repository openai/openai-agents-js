import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

test.skipIf(process.platform !== 'linux')(
  'retains unlimited procfs enumeration without spreading directory entries',
  async () => {
    const file = () => true;
    const other = () => false;
    const entries = Array.from({ length: 150_000 }, (_, index) => ({
      name: `item-${index}`,
      isFile: file,
      isDirectory: other,
      isSymbolicLink: other,
    }));
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const original =
        await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...original,
        // Model the trusted mount namespace independently of the test host's root owner.
        lstat: async (path: string) => {
          const info = await original.lstat(path);
          if (path === '/' || path === '/proc') {
            info.uid = 0;
            info.mode &= ~0o022;
          }
          return info;
        },
        readdir: vi.fn().mockResolvedValue(entries),
      };
    });
    const { openProcfsSourceRoot } =
      await import('../../src/sandbox/shared/localSourceProcfs');
    const root = await openProcfsSourceRoot('/');
    try {
      const actual = await root.entries();
      expect(actual).toHaveLength(entries.length);
      expect(actual.at(-1)).toEqual({ name: 'item-149999', type: 'file' });
    } finally {
      await root.close();
    }
  },
);
