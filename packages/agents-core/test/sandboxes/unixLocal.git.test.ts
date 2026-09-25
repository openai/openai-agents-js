import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Manifest, UnixLocalSandboxClient } from '../../src/sandbox/local';

import * as gitProcess from '../../src/sandbox/sandboxes/shared/runProcess';

const execFileAsync = promisify(execFile);

describe('UnixLocalSandboxClient git repository entries', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-core-sandbox-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('rejects repository option injection before changing an existing workspace', async () => {
    const repository = join(rootDir, 'source');
    await mkdir(repository);
    await createGitRepository(repository, 'original\n');
    const session = await new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    }).create(
      new Manifest({
        entries: { app: { type: 'git_repo', repo: `file://${repository}` } },
      }),
    );
    const workspace = session.state.workspaceRootPath;
    const config = await readFile(join(workspace, 'app/.git/config'), 'utf8');
    const previousManifest = session.state.manifest;
    const marker = join(rootDir, 'injected-marker');
    const markerScript = join(rootDir, 'marker.sh');
    // The only injected action writes a marker inside this test's temporary directory.
    await writeFile(markerScript, `#!/bin/sh\nprintf injected > '${marker}'\n`);
    const repo = `--upload-pack=/bin/sh '${markerScript}' #://`;
    const update = new Manifest({
      entries: {
        'before.txt': { type: 'file', content: 'must not be written' },
        app: { type: 'git_repo', repo: `file://${repository}` },
      },
    });
    // Manifest entries are mutable; applyManifest must validate its snapshot too.
    update.entries.app.repo = repo;
    const updateError = await session
      .applyManifest(update)
      .catch((error: unknown) => error);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(updateError).toEqual(
      new Error('git_repo repository URL must not start with "-".'),
    );
    await expect(
      session.materializeEntry({
        path: 'app',
        entry: { type: 'git_repo', repo },
      }),
    ).rejects.toThrow('git_repo repository URL must not start with "-".');
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(workspace, 'before.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(workspace, 'app/README.md'), 'utf8')).toBe(
      'original\n',
    );
    expect(await readFile(join(workspace, 'app/.git/config'), 'utf8')).toBe(
      config,
    );
    expect(session.state.manifest).toBe(previousManifest);
  }, 10_000);

  it('rejects repository options on fresh creation before creating a workspace', async () => {
    const manifest = new Manifest({
      entries: { app: { type: 'git_repo', repo: 'owner/repo' } },
    });
    manifest.entries.app.repo = '--upload-pack=unused #://';
    await expect(
      new UnixLocalSandboxClient({ workspaceBaseDir: rootDir }).create(
        manifest,
      ),
    ).rejects.toThrow('git_repo repository URL must not start with "-".');
    expect(await readdir(rootDir)).toEqual([]);
  });

  it.each(['branch', 'tag'] as const)(
    'preserves named %s refs with a subpath',
    async (kind) => {
      const processSpy = vi.spyOn(gitProcess, 'runSandboxProcess');
      const repository = join(rootDir, 'named-source');
      await mkdir(repository);
      await createGitRepository(repository, 'named ref\n');
      await execFileAsync('git', [kind, 'selected-ref'], { cwd: repository });
      const session = await new UnixLocalSandboxClient({
        workspaceBaseDir: rootDir,
      }).create(
        new Manifest({
          entries: {
            'selected.txt': {
              type: 'git_repo',
              repo: `file://${repository}`,
              ref: 'selected-ref',
              subpath: 'README.md',
            },
          },
        }),
      );
      expect(
        Buffer.from(
          await session.readFile({ path: 'selected.txt' }),
        ).toString(),
      ).toBe('named ref\n');
      expect(processSpy).toHaveBeenCalledWith(
        'git',
        [
          'clone',
          '--depth',
          '1',
          '--branch',
          'selected-ref',
          '--',
          `file://${repository}`,
          expect.any(String),
        ],
        expect.any(Object),
      );
    },
    10_000,
  );

  it('creates parent directories before cloning nested git repositories', async () => {
    const repository = join(rootDir, 'source-repo');
    await mkdir(repository, { recursive: true });
    await createGitRepository(repository, 'nested repo\n');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'deps/app': {
            type: 'git_repo',
            repo: `file://${repository}`,
          },
        },
      }),
    );

    expect(await session.pathExists('deps/app/README.md')).toBe(true);
  }, 10_000);

  it('treats empty git repository subpaths as the repository root', async () => {
    const repository = join(rootDir, 'empty-subpath-repo');
    await mkdir(repository, { recursive: true });
    await createGitRepository(repository, 'repo root\n');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          app: {
            type: 'git_repo',
            repo: `file://${repository}`,
            subpath: '',
          },
        },
      }),
    );

    const output = await session.execCommand({
      cmd: 'cat /workspace/app/README.md',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 2_000,
    });
    expect(output).toContain('repo root');
  }, 10_000);

  it('checks out commit SHA refs when cloning git repositories', async () => {
    const repository = join(rootDir, 'commit-repo');
    await mkdir(repository, { recursive: true });
    await createGitRepository(repository, 'commit ref\n');
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repository },
    );

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          app: {
            type: 'git_repo',
            repo: `file://${repository}`,
            ref: commitSha.trim(),
          },
        },
      }),
    );

    const output = await session.execCommand({
      cmd: 'cat /workspace/app/README.md',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 2_000,
    });
    expect(output).toContain('commit ref');
  }, 10_000);
});

async function createGitRepository(
  repository: string,
  readmeContent: string,
): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repository,
  });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], {
    cwd: repository,
  });
  await writeFile(join(repository, 'README.md'), readmeContent, 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repository });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repository });
}
