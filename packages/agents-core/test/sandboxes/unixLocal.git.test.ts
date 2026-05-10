import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Manifest, UnixLocalSandboxClient } from '../../src/sandbox/local';

const execFileAsync = promisify(execFile);

describe('UnixLocalSandboxClient git repository entries', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-core-sandbox-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

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
