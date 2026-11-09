import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as sourceReaders from '@openai/agents-core/sandbox/internal';
import { materializeLocalSourceManifestEntry } from '../../src/sandbox/shared/localSources';

vi.mock('@openai/agents-core/sandbox/internal', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@openai/agents-core/sandbox/internal')
    >();
  return {
    ...actual,
    openLocalSourceDirectory: vi.fn(actual.openLocalSourceDirectory),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(sourceReaders.openLocalSourceDirectory).mockReset();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test.each([false, true])(
  'joins a discarded iterator read when it later rejects: %s',
  async (rejectRead) => {
    const entered = Promise.withResolvers<void>();
    const releaseDirectory = Promise.withResolvers<void>();
    const writerFailed = Promise.withResolvers<void>();
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    let readSettled = false;
    let materializationSettled = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    vi.mocked(sourceReaders.openLocalSourceDirectory).mockResolvedValue({
      entries: async () => [
        { name: 'a', type: 'file' },
        { name: 'nested', type: 'directory' },
      ],
      readFile: async () => Buffer.from('a'),
      close: async () => {},
      openDirectory: async () => ({
        entries: async () => [{ name: 'b', type: 'file' }],
        openDirectory: async () => {
          throw new Error('unexpected child');
        },
        close: async () => {},
        readFile: async () => {
          readStarted.resolve();
          await releaseRead.promise;
          readSettled = true;
          if (rejectRead) throw new Error('discarded source failed');
          return Buffer.from('b');
        },
      }),
    });
    const firstError = new Error('destination failed');
    const operation = materializeLocalSourceManifestEntry(
      {
        async mkdir(path) {
          if (path.endsWith('/nested')) {
            entered.resolve();
            await releaseDirectory.promise;
          }
        },
        async writeFile() {
          await entered.promise;
          writerFailed.resolve();
          throw firstError;
        },
      },
      '/workspace/copied',
      { type: 'local_dir', src: '/sources/input' },
      'test',
      {
        localSourceBaseDir: '/sources',
        concurrencyLimits: { localDirFiles: 2 },
      },
    ).catch((error) => {
      materializationSettled = true;
      return error;
    });
    try {
      await writerFailed.promise;
      releaseDirectory.resolve();
      await readStarted.promise;
      // Every ungated promise can settle before this scheduler checkpoint.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const returnedBeforeReadSettled = materializationSettled;
      releaseRead.resolve();
      expect(await operation).toBe(firstError);
      expect(returnedBeforeReadSettled).toBe(false);
      expect(readSettled).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      releaseDirectory.resolve();
      releaseRead.resolve();
      await operation;
      process.removeListener('unhandledRejection', onUnhandled);
    }
  },
);

test('uploads original local_dir content after its ancestor is replaced during materialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-source-upload-'));
  roots.push(root);
  const parent = join(root, 'parent');
  const source = join(parent, 'source');
  const outside = join(root, 'outside');
  await mkdir(source, { recursive: true });
  await mkdir(join(outside, 'source'), { recursive: true });
  await writeFile(join(source, 'input.txt'), 'SAFE');
  await writeFile(join(outside, 'source', 'input.txt'), 'OUTSIDE');
  await writeFile(join(outside, 'source', 'secret.txt'), 'SECRET');
  const files = new Map<string, string>();
  await materializeLocalSourceManifestEntry(
    {
      async mkdir() {
        await rename(parent, join(root, 'saved'));
        await symlink(
          outside,
          parent,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
      async writeFile(path, content) {
        files.set(path, Buffer.from(content).toString());
      },
    },
    '/workspace/source',
    { type: 'local_dir', src: source },
    'test',
    { localSourceBaseDir: root },
  );
  expect([...files]).toEqual([['/workspace/source/input.txt', 'SAFE']]);
});

test('joins pending local_dir reads when the destination writer fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-source-upload-'));
  roots.push(root);
  await Promise.all(
    ['a', 'b', 'c'].map((name) =>
      writeFile(join(root, name), Buffer.alloc(1024 * 1024, name)),
    ),
  );
  let active = 0;
  await expect(
    materializeLocalSourceManifestEntry(
      {
        async mkdir() {},
        async writeFile() {
          active++;
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error('destination failed');
          } finally {
            active--;
          }
        },
      },
      '/workspace/source',
      { type: 'local_dir', src: root },
      'test',
      { localSourceBaseDir: root, concurrencyLimits: { localDirFiles: 2 } },
    ),
  ).rejects.toThrow('destination failed');
  expect(active).toBe(0);
});
