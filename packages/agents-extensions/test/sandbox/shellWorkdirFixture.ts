import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';

export const shellWorkdirCases = [
  { name: 'semicolon', command: 'pwd > first; pwd > second' },
  { name: 'newline', command: 'pwd > first\npwd > second' },
  { name: 'background', command: 'pwd > first & wait; pwd > second' },
];

// Execute provider wire payloads locally; never contact a sandbox service.
export async function withShellWorkdirFixture(
  command: string,
  directory: 'existing' | 'missing' | 'inaccessible',
  execute: (fixture: {
    workdir: string;
    cmd: string;
    environment: Record<string, string>;
    runShell: (argv: string[]) => {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
  }) => Promise<string>,
): Promise<void> {
  const root = await realpath(
    await mkdtemp(join(process.cwd(), '.tmp-shell-workdir-')),
  );
  const fallback = join(root, 'fallback');
  const workdir = join(root, "requested ' directory");
  await mkdir(fallback);
  if (directory !== 'missing') {
    await mkdir(workdir);
  }
  if (directory === 'inaccessible') {
    await chmod(workdir, 0);
  }
  const value = "literal ' ; $HOME value";
  try {
    const output = await execute({
      workdir,
      cmd: `printf '%s' "$WORKDIR_TEST" > environment && ${command}\nexit 23`,
      environment: { WORKDIR_TEST: value },
      runShell: (argv) => {
        const result = spawnSync(argv[0], argv.slice(1), {
          cwd: fallback,
          env: { PATH: '/usr/bin:/bin', HOME: root },
          encoding: 'utf8',
          timeout: 5000,
        });
        if (result.error) throw result.error;
        expect(result.signal).toBeNull();
        expect(result.status).not.toBeNull();
        return {
          exitCode: result.status!,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    });
    expect(await readdir(fallback)).toEqual([]);
    if (directory === 'existing') {
      expect(output).toContain('Process exited with code 23');
      expect(await readFile(join(workdir, 'first'), 'utf8')).toBe(
        `${workdir}\n`,
      );
      expect(await readFile(join(workdir, 'second'), 'utf8')).toBe(
        `${workdir}\n`,
      );
      expect(await readFile(join(workdir, 'environment'), 'utf8')).toBe(value);
    } else {
      expect(output).toMatch(/Process exited with code [1-9]\d*/);
      expect(output).not.toContain('Process exited with code 23');
      expect(output).toContain('cd:');
      if (directory === 'inaccessible') {
        await chmod(workdir, 0o700);
        expect(await readdir(workdir)).toEqual([]);
      }
    }
  } finally {
    if (directory === 'inaccessible') await chmod(workdir, 0o700);
    await rm(root, { recursive: true, force: true });
  }
}
