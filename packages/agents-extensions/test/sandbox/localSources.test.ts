import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { Manifest, file, gitRepo, localDir } from '@openai/agents-core/sandbox';
import { materializeLocalSourceManifest } from '../../src/sandbox/shared/localSources';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function sourceTree(git: boolean) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'agents-copy-limit-')),
  );
  temporaryDirectories.push(root);
  const files = [
    'a/one.txt',
    'a/deep/two.txt',
    'b/three.txt',
    'b/deep/four.txt',
    'c/five.txt',
    'six.txt',
  ];
  for (const path of files) {
    await fs.mkdir(dirname(join(root, 'tree', path)), { recursive: true });
    await fs.writeFile(join(root, 'tree', path), path);
  }
  if (git) {
    await exec('git', ['init', '--quiet', root]);
    await exec('git', ['-C', root, 'add', 'tree']);
    await exec('git', [
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
  }
  return {
    root,
    files,
    entry: git
      ? gitRepo({ repo: pathToFileURL(root).href, subpath: 'tree' })
      : localDir({ src: join(root, 'tree') }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

test.each([
  { git: false, limit: 1 },
  { git: false, limit: 2 },
  { git: false, limit: undefined },
  { git: true, limit: 2 },
])(
  'bounds reads and awaited uploads across a recursive source ($git, $limit)',
  async ({ git, limit }) => {
    const { root, files, entry } = await sourceTree(git);
    const open = fs.open;
    let active = 0;
    let peak = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (typeof args[1] === 'number' && !(args[1] & constants.O_DIRECTORY)) {
        active++;
        peak = Math.max(peak, active);
      }
      return open(...args);
    });
    const pending: Array<ReturnType<typeof deferred>> = [];
    const written = new Map<string, string>();
    const mkdir = vi.fn();
    const metadata = vi.fn();
    let settled = false;
    const operation = materializeLocalSourceManifest(
      {
        mkdir,
        writeFile: async (path, content) => {
          const gate = deferred();
          pending.push(gate);
          written.set(path, Buffer.from(content).toString());
          await gate.promise;
          active--;
        },
      },
      new Manifest({ entries: { copied: entry } }),
      'test',
      async (path) => `/workspace/${path}`,
      {
        localSourceBaseDir: root,
        concurrencyLimits: { localDirFiles: limit },
        applyMetadata: metadata,
      },
    ).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(pending.length).toBeGreaterThanOrEqual(limit ?? 4),
      );
      expect(metadata).not.toHaveBeenCalled();
      while (!settled) {
        await vi.waitFor(() =>
          expect(settled || pending.length > 0).toBe(true),
        );
        pending.shift()?.resolve();
      }
      await operation;
      expect(peak).toBe(limit ?? 4);
      expect(active).toBe(0);
      expect(written).toEqual(
        new Map(files.map((path) => [`/workspace/copied/${path}`, path])),
      );
      expect(mkdir).toHaveBeenCalledWith('/workspace/copied/a/deep');
      expect(metadata).toHaveBeenCalledExactlyOnceWith(
        '/workspace/copied',
        expect.objectContaining(entry),
      );
    } finally {
      // Release later writes too if an assertion fails while a worker is blocked.
      await vi.waitFor(() => {
        pending.splice(0).forEach((gate) => gate.resolve());
        expect(settled).toBe(true);
      });
      await operation;
    }
  },
);

test.each(['upload', 'traversal'])(
  'waits for active git uploads before clone cleanup on %s failure',
  async (failureKind) => {
    const { entry } = await sourceTree(true);
    const gate = deferred();
    const failure = new Error('copy failed');
    const open = fs.open;
    let cloneRoot: string | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).includes('openai-agents-test-git-')) {
        cloneRoot = String(args[0]).split('/tree')[0];
      }
      return open(...args);
    });
    let writes = 0;
    let failureReached = false;
    let settled = false;
    const operation = materializeLocalSourceManifest(
      {
        mkdir: async (path) => {
          if (failureKind === 'traversal' && path.endsWith('/b')) {
            failureReached = true;
            throw failure;
          }
        },
        writeFile: async () => {
          writes++;
          if (writes === 1) {
            await gate.promise;
          } else if (failureKind === 'upload') {
            failureReached = true;
            throw failure;
          }
        },
      },
      new Manifest({ entries: { copied: entry } }),
      'test',
      async (path) => `/workspace/${path}`,
      { concurrencyLimits: { localDirFiles: 2 } },
    )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(failureReached).toBe(true));
      expect(settled).toBe(false);
      expect(cloneRoot).toBeDefined();
      await expect(fs.stat(cloneRoot!)).resolves.toBeDefined();
    } finally {
      gate.resolve();
    }
    expect(await operation).toBe(failure);
    await expect(fs.stat(cloneRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

test('drains sibling manifest entries and stops queued entries after failure', async () => {
  const gate = deferred();
  const failure = new Error('entry failed');
  let failureReached = false;
  let settled = false;
  const writes: string[] = [];
  const operation = materializeLocalSourceManifest(
    {
      mkdir: vi.fn(),
      writeFile: async (path) => {
        writes.push(path);
        if (path.endsWith('/active')) await gate.promise;
        if (path.endsWith('/failed')) {
          failureReached = true;
          throw failure;
        }
      },
    },
    new Manifest({
      entries: {
        active: file({ content: 'a' }),
        failed: file({ content: 'b' }),
        queued: file({ content: 'c' }),
      },
    }),
    'test',
    async (path) => `/workspace/${path}`,
    { concurrencyLimits: { manifestEntries: 2 } },
  )
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  try {
    await vi.waitFor(() => expect(failureReached).toBe(true));
    expect(settled).toBe(false);
  } finally {
    gate.resolve();
  }
  expect(await operation).toBe(failure);
  expect(writes).toEqual(['/workspace/active', '/workspace/failed']);
});
