import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Manifest } from '../../src/sandbox/manifest';

const readerModule = '../../src/sandbox/shared/localSourceReader';
afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock(readerModule);
  vi.resetModules();
});

test.skipIf(process.platform === 'win32')(
  'retains local skill index authority after an enumerated child is swapped',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-index-authority-'));
    const source = join(root, 'source');
    const outside = join(root, 'outside');
    mkdirSync(join(source, 'report'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(
      join(source, 'report/SKILL.md'),
      '---\nname: report\ndescription: ALLOWED_INDEX\n---\n',
    );
    writeFileSync(
      join(outside, 'SKILL.md'),
      '---\nname: report\ndescription: PRIVATE_OUTSIDE_INDEX\n---\n',
    );
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      renameSync(join(source, 'report'), join(source, 'original-report'));
      symlinkSync(outside, join(source, 'report'), 'dir');
      swapped = true;
    };
    vi.doMock('node:fs', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:fs')>();
      return {
        ...original,
        opendirSync: (path: string) => {
          const directory = original.opendirSync(path);
          const close = directory.closeSync.bind(directory);
          directory.closeSync = () => {
            close();
            swap();
          };
          return directory;
        },
      };
    });
    vi.doMock(readerModule, async (importOriginal) => {
      const original =
        await importOriginal<
          typeof import('../../src/sandbox/shared/localSourceReader')
        >();
      return {
        ...original,
        readLocalSourceEntriesAt: async (
          ...args: Parameters<typeof original.readLocalSourceEntriesAt>
        ) => {
          const entries = await original.readLocalSourceEntriesAt(...args);
          swap();
          return entries;
        },
      };
    });
    try {
      const { localDirLazySkillSource } =
        await import('../../src/sandbox/localSkills');
      const lazy = localDirLazySkillSource({ src: source, baseDir: source });
      const index = await lazy.getIndex!(new Manifest(), '.agents', {
        maxEntries: 1024,
        maxFileBytes: 64 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
      });
      expect(swapped).toBe(true);
      expect(JSON.stringify(index)).not.toContain('PRIVATE_OUTSIDE_INDEX');
      expect(index).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('skips a following non-skill directory after the exact metadata byte budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-index-exact-'));
  const document = '---\nname: report\ndescription: EXACT_BUDGET\n---\n';
  mkdirSync(join(root, 'a-skill'));
  mkdirSync(join(root, 'z-empty'));
  writeFileSync(join(root, 'a-skill/SKILL.md'), document);
  try {
    const { localDirLazySkillSource } =
      await import('../../src/sandbox/localSkills');
    const lazy = localDirLazySkillSource({ src: root, baseDir: root });
    const index = await lazy.getIndex!(new Manifest(), '.agents', {
      maxEntries: 1024,
      maxFileBytes: 64 * 1024,
      maxTotalBytes: Buffer.byteLength(document),
    });
    expect(index).toEqual([
      { name: 'report', description: 'EXACT_BUDGET', path: 'a-skill' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
