import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 as pathWin32 } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  resolveRemoteSandboxEffectivePath,
  validateRemoteSandboxPath,
} from '../../src/sandbox/shared';

describe('remote sandbox path command construction', () => {
  test('keeps remote helper commands POSIX even when running on Windows', async () => {
    const commands: string[] = [];

    const resolved = await validateRemoteSandboxPath({
      root: '/workspace',
      path: '/workspace/link.txt',
      runCommand: async (command) => {
        commands.push(command);
        return {
          status: 0,
          stdout: '/workspace/link.txt\n',
          stderr: '',
        };
      },
    });

    expect(resolved).toBe('/workspace/link.txt');
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain('/tmp/openai-agents-resolve-path.sh');
    expect(extractHelperDir(commands[0])).toMatch(
      /^\/tmp\/openai-agents-resolve-path-[0-9a-f-]+$/u,
    );
    const invocation = commands[0]?.trim().split(/\r?\n/u).at(-1);
    expect(invocation).toBe(
      "sh \"$helper_path\" '/workspace' '/workspace/link.txt' '0'",
    );
    expect(invocation).not.toContain('\\');
  });

  test('uses a unique helper directory for each remote path check', async () => {
    const commands: string[] = [];

    for (const path of ['/workspace/first.txt', '/workspace/second.txt']) {
      await validateRemoteSandboxPath({
        root: '/workspace',
        path,
        runCommand: async (command) => {
          commands.push(command);
          return {
            status: 0,
            stdout: `${path}\n`,
            stderr: '',
          };
        },
      });
    }

    expect(commands).toHaveLength(2);
    expect(extractHelperDir(commands[0])).not.toBe(
      extractHelperDir(commands[1]),
    );
  });

  test('does not send local hostPath values to remote path helpers', async () => {
    const commands: string[] = [];
    const hostPath = join(tmpdir(), 'host-only-data');

    await validateRemoteSandboxPath({
      root: '/workspace',
      path: '/mnt/data/input.txt',
      options: {
        extraPathGrants: [
          {
            path: '/mnt/data',
            hostPath,
            readOnly: true,
          },
        ],
      },
      runCommand: async (command) => {
        commands.push(command);
        return {
          status: 0,
          stdout: '/mnt/data/input.txt\n',
          stderr: '',
        };
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("'/mnt/data' '1'");
    expect(commands[0]).not.toContain(hostPath);
  });

  test('returns the remote validated resolved path to callers', async () => {
    const resolved = await validateRemoteSandboxPath({
      root: '/workspace',
      path: '/workspace/link/file.txt',
      runCommand: async () => ({
        status: 0,
        stdout: '/workspace/real/file.txt\n',
        stderr: '',
      }),
    });

    expect(resolved).toBe('/workspace/real/file.txt');
  });

  test('fails closed when validation succeeds without an absolute path', async () => {
    await expect(
      validateRemoteSandboxPath({
        root: '/workspace',
        path: 'link.txt',
        runCommand: async () => ({ status: 0 }),
      }),
    ).rejects.toThrow(/did not return an absolute resolved path/i);

    await expect(
      validateRemoteSandboxPath({
        root: '/workspace',
        path: 'link.txt',
        runCommand: async () => ({ status: 0, stdout: 'workspace/link.txt\n' }),
      }),
    ).rejects.toThrow(/did not return an absolute resolved path/i);
  });

  test('rejects Windows host separators before remote command construction', async () => {
    let commandRan = false;

    await expect(
      validateRemoteSandboxPath({
        root: '/workspace',
        path: pathWin32.join('/workspace', 'link.txt'),
        runCommand: async () => {
          commandRan = true;
          return {
            status: 0,
            stdout: '/workspace/link.txt\n',
            stderr: '',
          };
        },
      }),
    ).rejects.toThrow(/must use "\/" separators/i);

    expect(commandRan).toBe(false);
  });
});

function extractHelperDir(command: string | undefined): string {
  const match = command?.match(/^helper_dir='([^']+)'$/mu);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('remote sandbox path identity', () => {
  test.each(['file\n', '\rfile', '\n', 'dir\n/../file'])(
    'rejects raw CR/LF in path boundaries before normalization: %j',
    async (value) => {
      let commandRan = false;
      const runCommand = async () => {
        commandRan = true;
        return { status: 0, stdout: '/workspace/file\n' };
      };
      for (const input of [
        { root: '/workspace', path: value },
        { root: `/workspace/${value}`, path: 'file' },
        {
          root: '/workspace',
          path: 'file',
          options: {
            extraPathGrants: [{ path: `/grant/${value}`, readOnly: false }],
            forWrite: true,
          },
        },
      ]) {
        await expect(
          validateRemoteSandboxPath({ ...input, runCommand }),
        ).rejects.toMatchObject({
          code: 'path_resolution_error',
          details: {
            root: input.root,
            path: input.path,
            forWrite: input.options?.forWrite ?? false,
          },
        });
      }
      await expect(
        resolveRemoteSandboxEffectivePath({
          path: `/workspace/${value}`,
          runCommand,
        }),
      ).rejects.toMatchObject({
        code: 'path_resolution_error',
        details: { path: `/workspace/${value}` },
      });
      expect(commandRan).toBe(false);
    },
  );

  const runCommand = async (command: string) => {
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  test('rejects newline paths and symlink targets before they can change identity', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agents-path-identity-'));
    try {
      const root = join(await realpath(temp), 'workspace');
      await mkdir(root);
      const outside = join(temp, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'secret'), 'outside');
      const multiline = `${root}/prefix\n${outside}`;
      await mkdir(multiline, { recursive: true });
      const safe = join(root, 'safe');
      await mkdir(safe);
      // A dangling target must not become the existing path without its newline.
      await symlink(`${safe}\n`, join(root, 'trailing-target'));
      const physical = join(root, 'physical\n');
      await mkdir(physical);
      await symlink(physical, join(root, 'physical-link'));

      for (const path of [
        `${multiline}/secret`,
        'trailing-target/new.txt',
        'physical-link/new.txt',
      ]) {
        await expect(
          validateRemoteSandboxPath({ root, path, runCommand }),
        ).rejects.toThrow(/carriage returns or newlines/);
      }

      // Ordinary aliases and missing write leaves retain their exact spelling.
      const filename = "space ' Unicode-雪 .txt ";
      await writeFile(join(safe, filename), 'inside');
      await symlink(join(safe, filename), join(root, 'safe-link'));
      await expect(
        validateRemoteSandboxPath({
          root,
          path: 'safe-link',
          options: { forWrite: true },
          runCommand,
        }),
      ).resolves.toBe(join(safe, filename));
      await expect(
        validateRemoteSandboxPath({
          root,
          path: 'safe/new.txt',
          options: { forWrite: true },
          runCommand,
        }),
      ).resolves.toBe(join(safe, 'new.txt'));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test.each([
    '/workspace/file\n/outside/secret\n',
    '/workspace/file\n\n',
    '/workspace/file\r\n',
  ])('rejects ambiguous validator output %j', async (stdout) => {
    const runCommand = async () => ({ status: 0, stdout });
    await expect(
      validateRemoteSandboxPath({
        root: '/workspace',
        path: 'file',
        runCommand,
      }),
    ).rejects.toThrow(/did not return an absolute resolved path/);
    await expect(
      resolveRemoteSandboxEffectivePath({
        path: '/workspace/file',
        runCommand,
      }),
    ).rejects.toThrow(/effective-path resolution/);
  });

  test('preserves trailing spaces in effective paths', async () => {
    await expect(
      resolveRemoteSandboxEffectivePath({
        path: '/workspace/file ',
        runCommand: async () => ({ status: 0, stdout: '/workspace/file \n' }),
      }),
    ).resolves.toBe('/workspace/file ');
  });
});
