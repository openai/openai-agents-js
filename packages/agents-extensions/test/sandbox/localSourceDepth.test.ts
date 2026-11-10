import { readdirSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as readers from '@openai/agents-core/sandbox/internal';
import * as gitProcess from '../../src/sandbox/shared/process';
import { materializeLocalSourceManifestEntry } from '../../src/sandbox/shared/localSources';

vi.mock('@openai/agents-core/sandbox/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof readers>();
  return {
    ...actual,
    openLocalSourceDirectory: vi.fn(actual.openLocalSourceDirectory),
  };
});
vi.mock('../../src/sandbox/shared/process', async (importOriginal) => {
  const actual = await importOriginal<typeof gitProcess>();
  return { ...actual, runSandboxProcess: vi.fn(actual.runSandboxProcess) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(readers.openLocalSourceDirectory).mockReset();
  vi.mocked(gitProcess.runSandboxProcess).mockReset();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function deepTree(root: string) {
  const components = Array.from({ length: 64 }, () => 'd');
  const leaf = join(root, ...components);
  await mkdir(leaf, { recursive: true });
  await writeFile(join(leaf, 'safe.txt'), 'SAFE');
  return [...components, 'safe.txt'].join('/');
}

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

test.skipIf(process.platform !== 'linux').each([false, true])(
  'uploads a deep native directory with bounded descriptors (git: %s)',
  async (git) => {
    const root = await mkdtemp(join(tmpdir(), 'agents-provider-depth-'));
    roots.push(root);
    const source = join(root, 'source');
    const relative = await deepTree(source);
    const actual = await vi.importActual<typeof readers>(
      '@openai/agents-core/sandbox/internal',
    );
    let openedSource = source;
    let atLeaf = 0;
    type Directory = Awaited<
      ReturnType<typeof readers.openLocalSourceDirectory>
    >;
    const wrap = (directory: Directory): Directory => ({
      entries: () => directory.entries(),
      close: () => directory.close(),
      openDirectory: async (name, enumerate) =>
        wrap(await directory.openDirectory(name, enumerate)),
      readFile(name) {
        atLeaf = sourceDescriptorCount(openedSource);
        return directory.readFile(name);
      },
    });
    vi.mocked(readers.openLocalSourceDirectory).mockImplementation(
      async (path) => {
        openedSource = path;
        return wrap(await actual.openLocalSourceDirectory(path));
      },
    );
    vi.mocked(gitProcess.runSandboxProcess).mockImplementation(
      async (_command, args) => {
        // Isolate Git transport; enumeration and file reads use real native handles.
        if (args[0] === 'clone')
          await deepTree(join(args[args.length - 1], 'tree'));
        return {
          status: 0,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
    );
    const files = new Map<string, string>();
    await materializeLocalSourceManifestEntry(
      {
        async mkdir() {},
        async writeFile(path, content) {
          files.set(path, Buffer.from(content).toString());
        },
      },
      '/workspace/copied',
      git
        ? {
            type: 'git_repo',
            repo: 'https://example.test/repo.git',
            subpath: 'tree',
          }
        : { type: 'local_dir', src: source },
      'test',
      { localSourceBaseDir: root },
    );
    expect([...files]).toEqual([[`/workspace/copied/${relative}`, 'SAFE']]);
    expect(atLeaf).toBeGreaterThan(0);
    expect(atLeaf).toBeLessThan(8);
    expect(sourceDescriptorCount(openedSource)).toBe(0);
  },
  60_000,
);
