import { readdirSync, readlinkSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Manifest } from '../../src/sandbox/manifest';
import * as readers from '../../src/sandbox/shared/localSourceReader';
import * as gitProcess from '../../src/sandbox/sandboxes/shared/runProcess';
import {
  materializeLocalWorkspaceManifest,
  readLocalWorkspaceEntry,
} from '../../src/sandbox/sandboxes/shared/localWorkspace';

vi.mock(
  '../../src/sandbox/shared/localSourceReader',
  async (importOriginal) => {
    const actual = await importOriginal<typeof readers>();
    return {
      ...actual,
      openLocalSourceDirectory: vi.fn(actual.openLocalSourceDirectory),
    };
  },
);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(readers.openLocalSourceDirectory).mockReset();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'agents-core-depth-'));
  roots.push(root);
  return root;
}

test('materializes more local_file entries than the native submission limit', async () => {
  const root = await temporaryRoot();
  const source = join(root, 'source.txt');
  await writeFile(source, 'SAFE');
  const names = Array.from({ length: 300 }, (_, index) => `copy-${index}`);
  await materializeLocalWorkspaceManifest(
    new Manifest({
      entries: Object.fromEntries(
        names.map((name) => [name, { type: 'local_file', src: source }]),
      ),
    }),
    join(root, 'workspace'),
    {
      localSourceBaseDir: root,
      concurrencyLimits: { manifestEntries: 300 },
    },
  );
  const contents = await Promise.all(
    names.map((name) => readFile(join(root, 'workspace', name), 'utf8')),
  );
  expect(contents).toEqual(names.map(() => 'SAFE'));
});

function sourceDescriptorCount(root: string) {
  return readdirSync('/proc/self/fd').filter((fd) => {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      return target === root || target.startsWith(`${root}${sep}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }).length;
}

async function deepTree(root: string, depth = 64) {
  const components = Array.from({ length: depth }, () => 'd');
  const leaf = join(root, ...components);
  await mkdir(leaf, { recursive: true });
  await writeFile(join(leaf, 'safe.txt'), 'SAFE');
  return [...components, 'safe.txt'];
}

async function observeNativeReads(onRead: () => Promise<void> | void) {
  const actual = await vi.importActual<typeof readers>(
    '../../src/sandbox/shared/localSourceReader',
  );
  type Directory = Awaited<ReturnType<typeof readers.openLocalSourceDirectory>>;
  const wrap = (directory: Directory): Directory => ({
    entries: () => directory.entries(),
    close: () => directory.close(),
    openDirectory: async (name, enumerate) =>
      wrap(await directory.openDirectory(name, enumerate)),
    async readFile(name) {
      await onRead();
      return directory.readFile(name);
    },
  });
  vi.mocked(readers.openLocalSourceDirectory).mockImplementation(async (path) =>
    wrap(await actual.openLocalSourceDirectory(path)),
  );
}

test.skipIf(process.platform !== 'linux')(
  'materializes deep local_dir with bounded native descriptors',
  async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source');
    const relative = await deepTree(source);
    let atLeaf = 0;
    await observeNativeReads(() => {
      atLeaf = sourceDescriptorCount(source);
    });
    await materializeLocalWorkspaceManifest(
      new Manifest({ entries: { copied: { type: 'local_dir', src: source } } }),
      join(root, 'workspace'),
      { localSourceBaseDir: root },
    );
    expect(
      await readFile(join(root, 'workspace', 'copied', ...relative), 'utf8'),
    ).toBe('SAFE');
    expect(atLeaf).toBeGreaterThan(0);
    expect(atLeaf).toBeLessThan(8);
    expect(sourceDescriptorCount(source)).toBe(0);
  },
  60_000,
);

test('shares the configured local_dir file budget across sibling directories', async () => {
  const root = await temporaryRoot();
  const source = join(root, 'source');
  const files = ['a/one', 'a/two', 'b/one', 'b/two', 'c/one', 'c/two'];
  for (const file of files) {
    await mkdir(join(source, file, '..'), { recursive: true });
    await writeFile(join(source, file), file);
  }
  let active = 0;
  let peak = 0;
  await observeNativeReads(async () => {
    active++;
    peak = Math.max(peak, active);
    try {
      // Hold real reads across scheduler turns so sibling workers overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      active--;
    }
  });
  await materializeLocalWorkspaceManifest(
    new Manifest({ entries: { copied: { type: 'local_dir', src: source } } }),
    join(root, 'workspace'),
    { localSourceBaseDir: root, concurrencyLimits: { localDirFiles: 2 } },
  );
  expect(peak).toBe(2);
  expect(active).toBe(0);
  for (const file of files)
    expect(
      await readFile(join(root, 'workspace', 'copied', file), 'utf8'),
    ).toBe(file);
});

test.skipIf(process.platform !== 'linux')(
  'streams a deep cloned git file without retaining ancestor directory handles',
  async () => {
    const root = await temporaryRoot();
    vi.spyOn(gitProcess, 'runSandboxProcess').mockImplementation(
      async (_command, args) => {
        if (args[0] === 'clone') {
          const destination = args[args.length - 1];
          await deepTree(destination, 300);
          await symlink('d', join(destination, 'link'));
        }
        return {
          status: 0,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
    );
    const files: string[] = [];
    let peak = 0;
    let linkTarget: string | undefined;
    for await (const item of readLocalWorkspaceEntry(
      { type: 'git_repo', repo: 'https://example.test/repo.git' },
      [],
      root,
    )) {
      peak = Math.max(peak, sourceDescriptorCount(root));
      if (item.type === 'file' && 'chunks' in item) {
        const chunks = [];
        for await (const chunk of item.chunks) chunks.push(Buffer.from(chunk));
        files.push(Buffer.concat(chunks).toString());
      } else if (item.type === 'symlink') linkTarget = item.target;
    }
    expect(files).toEqual(['SAFE']);
    expect(linkTarget).toBe('d');
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(8);
    expect(sourceDescriptorCount(root)).toBe(0);
  },
  60_000,
);
