import { describe, expect, it } from 'vitest';
import { runSandboxProcess } from '../../src/sandbox/shared/process';
import { shellCommandForPty } from '../../src/sandbox/shared/pty';

describe('runSandboxProcess', () => {
  it('captures stdout and stderr without blocking the event loop', async () => {
    const result = await runSandboxProcess(process.execPath, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err');",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.timedOut).toBe(false);
  });

  it('terminates long-running processes after the timeout', async () => {
    const result = await runSandboxProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000);'],
      { timeoutMs: 50 },
    );

    expect(result.timedOut).toBe(true);
  });

  it('limits captured output', async () => {
    const result = await runSandboxProcess(
      process.execPath,
      ['-e', "process.stdout.write('abcdef');"],
      { maxOutputBytes: 3 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('abc');
  });

  it('returns spawn errors instead of hanging', async () => {
    const result = await runSandboxProcess(
      '__openai_agents_missing_command__',
      [],
      { timeoutMs: 50 },
    );

    expect(result.status).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.timedOut).toBe(false);
  });
});

describe('shellCommandForPty', () => {
  it('does not run fallback /bin/sh as a login shell', () => {
    expect(shellCommandForPty({ cmd: 'printf ok' })).toBe(
      "/bin/sh -c 'printf ok'",
    );
  });

  it('keeps login mode for explicitly configured shells', () => {
    expect(
      shellCommandForPty({
        cmd: 'printf ok',
        shell: '/bin/bash',
      }),
    ).toBe("/bin/bash -lc 'printf ok'");
  });
});
