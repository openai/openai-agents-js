import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

// Deno 2.3.5 reports Darwin's compatibility flags even on Linux. Node's own
// filesystem functions still use their real ABI; this simulates only the shim.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    constants: {
      ...original.constants,
      O_DIRECTORY: 0x100000,
      O_NOFOLLOW: 0x100,
      O_NONBLOCK: 0x4,
    },
  };
});

import {
  openLocalSourceDirectory,
  readLocalSourceFile,
} from '../../src/sandbox/shared/localSourceReader';

test.skipIf(process.platform !== 'linux')(
  'rejects replaced ancestors and leaf links when compatibility flags use another ABI',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agents-source-flags-'));
    const source = join(root, 'source');
    const outside = join(root, 'outside');
    await mkdir(source);
    await mkdir(outside);
    await writeFile(join(source, 'input'), 'SAFE');
    await writeFile(join(outside, 'input'), 'OUTSIDE');
    const directory = await openLocalSourceDirectory(source);
    try {
      const saved = join(root, 'saved');
      await rename(source, saved);
      await symlink(outside, source);
      expect(await readFile(join(source, 'input'), 'utf8')).toBe('OUTSIDE');
      expect(Buffer.from(await directory.readFile('input')).toString()).toBe(
        'SAFE',
      );
      await expect(readLocalSourceFile(join(source, 'input'))).rejects.toThrow(
        /symbolic link ancestors/,
      );
      await symlink(join(outside, 'input'), join(saved, 'linked'));
      await expect(directory.readFile('linked')).rejects.toThrow(
        /symbolic link/,
      );
    } finally {
      await directory.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
