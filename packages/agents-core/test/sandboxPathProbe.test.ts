import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SandboxWorkspaceArchiveReadError,
  SandboxWorkspaceReadNotFoundError,
} from '../src/sandbox';
import {
  isSandboxPathNotFoundError,
  probeSandboxPathExists,
} from '../src/sandbox/shared/pathProbe';
import { runSandboxProcess } from '../src/sandbox/sandboxes/shared/runProcess';

describe('sandbox path probes', () => {
  it('recognizes typed and filesystem not-found errors only', () => {
    expect(isSandboxPathNotFoundError({ code: 'ENOENT' })).toBe(true);
    expect(
      isSandboxPathNotFoundError({ code: 'workspace_read_not_found' }),
    ).toBe(true);
    expect(
      isSandboxPathNotFoundError(
        new SandboxWorkspaceReadNotFoundError('missing'),
      ),
    ).toBe(true);
    expect(isSandboxPathNotFoundError({ code: 'EACCES' })).toBe(false);
    expect(isSandboxPathNotFoundError(new Error('missing'))).toBe(false);
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    expect(isSandboxPathNotFoundError(hostile.proxy)).toBe(false);
  });

  it('returns existing paths without running the diagnostic probe', async () => {
    const runCommand = vi.fn(async () => ({ status: 0 }));

    await expect(
      probeSandboxPathExists({ path: '/workspace/exists', runCommand }),
    ).resolves.toBe(true);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith("test -e '/workspace/exists'");
  });

  it('diagnoses ambiguous missing-path probe results', async () => {
    const runCommand = vi.fn(async (_command: string) => ({ status: 1 }));

    await expect(
      probeSandboxPathExists({ path: '/workspace/missing', runCommand }),
    ).resolves.toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[1]?.[0]).toContain(
      'OPENAI_AGENTS_READ_PATH_PROBE_V1',
    );
  });

  it('accepts an explicit missing-path diagnostic without a second probe', async () => {
    const runCommand = vi.fn(async () => ({
      status: 1,
      stderr: 'test: /workspace/missing: No such file or directory',
    }));

    await expect(
      probeSandboxPathExists({ path: '/workspace/missing', runCommand }),
    ).resolves.toBe(false);
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 1, stderr: 'Permission denied' },
    { status: 2, stderr: 'Input/output error' },
    { status: 1, timedOut: true },
    { status: null, signal: 'SIGTERM' },
  ])('rejects inaccessible and failed path probes: %j', async (result) => {
    await expect(
      probeSandboxPathExists({
        path: '/workspace/blocked',
        runCommand: async () => result,
      }),
    ).rejects.toBeInstanceOf(SandboxWorkspaceArchiveReadError);
  });

  it('rejects broken or inaccessible paths discovered by the second probe', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ status: 1 })
      .mockResolvedValueOnce({ status: 2 });

    await expect(
      probeSandboxPathExists({ path: '/workspace/broken', runCommand }),
    ).rejects.toMatchObject({
      code: 'workspace_archive_read_error',
      details: { path: '/workspace/broken', status: 2 },
    });
  });

  it('preserves provider and transport failures', async () => {
    const failure = new Error('provider unavailable');

    await expect(
      probeSandboxPathExists({
        path: '/workspace/blocked',
        runCommand: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('does not retain partial stdout in path probe errors', async () => {
    const sensitiveOutput = 'sensitive partial contents';

    let thrown: unknown;
    try {
      await probeSandboxPathExists({
        path: '/workspace/blocked',
        runCommand: async () => ({ status: 1, stdout: sensitiveOutput }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'workspace_archive_read_error',
      details: { stdoutBytes: sensitiveOutput.length },
    });
    expect((thrown as Error).message).not.toContain(sensitiveOutput);
  });

  it('classifies real missing paths, broken links, and inaccessible ancestors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agents-path-probe-'));
    const existing = join(root, 'exists.txt');
    const missing = join(root, 'missing.txt');
    const dangling = join(root, 'dangling');
    const invalid = join(root, 'invalid');
    const inaccessible = join(root, 'inaccessible');
    await writeFile(existing, 'hello');
    await symlink('missing-target', dangling);
    await symlink('exists.txt/nested', invalid);
    await mkdir(inaccessible, { mode: 0o700 });
    await chmod(inaccessible, 0);
    const runCommand = async (command: string) =>
      await runSandboxProcess('/bin/sh', ['-c', command]);

    try {
      await expect(
        probeSandboxPathExists({ path: existing, runCommand }),
      ).resolves.toBe(true);
      await expect(
        probeSandboxPathExists({ path: missing, runCommand }),
      ).resolves.toBe(false);
      await expect(
        probeSandboxPathExists({ path: dangling, runCommand }),
      ).resolves.toBe(false);
      await expect(
        probeSandboxPathExists({ path: invalid, runCommand }),
      ).rejects.toBeInstanceOf(SandboxWorkspaceArchiveReadError);
      await expect(
        probeSandboxPathExists({
          path: join(inaccessible, 'nested.txt'),
          runCommand,
        }),
      ).rejects.toBeInstanceOf(SandboxWorkspaceArchiveReadError);
    } finally {
      await chmod(inaccessible, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
});
