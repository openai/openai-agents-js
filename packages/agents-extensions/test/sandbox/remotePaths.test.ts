import { win32 as pathWin32 } from 'node:path';
import { describe, expect, test } from 'vitest';
import { validateRemoteSandboxPath } from '../../src/sandbox/shared';

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
