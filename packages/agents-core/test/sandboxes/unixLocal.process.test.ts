import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Manifest, UnixLocalSandboxClient } from '../../src/sandbox/local';

const execFileAsync = promisify(execFile);
const ACTIVE_PROCESS_POLL_MS = 50;
const ACTIVE_PROCESS_MAX_POLLS = 80;

describe('UnixLocalSandboxClient process sessions', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-core-sandbox-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('allocates a PTY for tty commands', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const initialOutput = await session.execCommand({
      cmd: 'test -t 0 && printf "tty yes\\n" || printf "tty no\\n"',
      shell: '/bin/sh',
      login: false,
      tty: true,
      yieldTimeMs: 1_000,
    });
    const sessionId = Number(
      initialOutput.match(/Process running with session ID (\d+)/)?.[1],
    );
    const output = Number.isFinite(sessionId)
      ? `${initialOutput}${await writeUntilExit(
          {
            writeStdin: (args) => session.writeStdin(args),
          },
          sessionId,
          '',
        )}`
      : initialOutput;

    expect(output).toContain('Process exited with code 0');
    expect(output).toContain('tty yes');
    expect(output).not.toContain('tty no');
  });

  it('fails tty commands clearly when the Python PTY bridge is unavailable', async () => {
    const originalPython = process.env.OPENAI_AGENTS_PYTHON;
    const missingPython = join(rootDir, 'missing-python3');
    process.env.OPENAI_AGENTS_PYTHON = missingPython;

    try {
      const client = new UnixLocalSandboxClient({
        workspaceBaseDir: rootDir,
      });
      const session = await client.create(new Manifest());

      await expect(
        session.execCommand({
          cmd: 'printf "hello\\n"',
          shell: '/bin/sh',
          login: false,
          tty: true,
          yieldTimeMs: 1_000,
        }),
      ).rejects.toMatchObject({
        code: 'configuration_error',
        message:
          'PTY support requires Python 3. Install python3 or set OPENAI_AGENTS_PYTHON to a Python 3 executable.',
        details: expect.objectContaining({
          pythonExecutable: missingPython,
        }),
      });
    } finally {
      if (originalPython === undefined) {
        delete process.env.OPENAI_AGENTS_PYTHON;
      } else {
        process.env.OPENAI_AGENTS_PYTHON = originalPython;
      }
    }
  });

  it('checks relative PTY Python executables from the command cwd', async () => {
    const originalPython = process.env.OPENAI_AGENTS_PYTHON;
    const pythonPath = await whichPython();

    try {
      const client = new UnixLocalSandboxClient({
        workspaceBaseDir: rootDir,
      });
      const session = await client.create(new Manifest());
      await symlink(
        pythonPath,
        join(session.state.workspaceRootPath, 'python3'),
      );
      process.env.OPENAI_AGENTS_PYTHON = './python3';

      const output = await session.execCommand({
        cmd: 'test -t 0 && printf "tty yes\\n" || printf "tty no\\n"',
        shell: '/bin/sh',
        login: false,
        tty: true,
        yieldTimeMs: 1_000,
      });
      const finalOutput = await collectActiveCommandOutput(
        {
          writeStdin: (args) => session.writeStdin(args),
        },
        output,
      );

      expect(finalOutput).toContain('Process exited with code 0');
      expect(finalOutput).toContain('tty yes');
      expect(finalOutput).not.toContain('tty no');
    } finally {
      if (originalPython === undefined) {
        delete process.env.OPENAI_AGENTS_PYTHON;
      } else {
        process.env.OPENAI_AGENTS_PYTHON = originalPython;
      }
    }
  });

  it('supports interactive sessions with write_stdin', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const started = await session.execCommand({
      cmd: 'read value; printf "%s\\n" "$value"',
      shell: '/bin/sh',
      login: false,
      tty: true,
      yieldTimeMs: 0,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const finished = await writeUntilExit(
      {
        writeStdin: (args) => session.writeStdin(args),
      },
      sessionId,
      'hello stdin\n',
    );

    expect(started).toContain('Process running with session ID');
    expect(finished).toContain('Process exited with code 0');
    expect(finished).toContain('hello stdin');
  });

  it('returns buffered PTY output when yielding an active session', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const started = await session.execCommand({
      cmd: 'printf "prompt> "; sleep 1; read value; printf "received:%s\\n" "$value"',
      shell: '/bin/sh',
      login: false,
      tty: true,
      yieldTimeMs: 500,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const bufferedOutput = started.includes('prompt>')
      ? started
      : await waitForOutputContaining(
          {
            writeStdin: (args) => session.writeStdin(args),
          },
          sessionId,
          'prompt>',
        );
    const polled = await session.writeStdin({
      sessionId,
      yieldTimeMs: 50,
    });
    const finished = await writeUntilExit(
      {
        writeStdin: (args) => session.writeStdin(args),
      },
      sessionId,
      'hello stdin\n',
    );

    expect(started).toContain('Process running with session ID');
    expect(bufferedOutput).toContain('prompt>');
    expect(polled).not.toContain('prompt>');
    expect(finished).toContain('Process exited with code 0');
    expect(finished).toContain('received:hello stdin');
  });

  it('honors yieldTimeMs for non-tty commands', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const started = await session.execCommand({
      cmd: 'sleep 0.2; printf "done\\n"',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 0,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const finished = await writeUntilExit(
      {
        writeStdin: (args) => session.writeStdin(args),
      },
      sessionId,
      '',
    );

    expect(started).toContain('Process running with session ID');
    expect(finished).toContain('Process exited with code 0');
    expect(finished).toContain('done');
  });

  it('reports SIGINT-terminated non-tty commands as failures', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const started = await session.execCommand({
      cmd: 'read value',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 0,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const interrupted = await session.writeStdin({
      sessionId,
      chars: '\u0003',
      yieldTimeMs: 1_000,
    });

    expect(started).toContain('Process running with session ID');
    expect(interrupted).toContain('Process exited with code 130');
  });

  it('returns only unread output from active sessions', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const started = await session.execCommand({
      cmd: 'printf "ready\\n"; read value; printf "done\\n"',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 50,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const readyOutput = started.includes('ready')
      ? started
      : await waitForOutputContaining(
          {
            writeStdin: (args) => session.writeStdin(args),
          },
          sessionId,
          'ready',
        );
    const polled = await session.writeStdin({
      sessionId,
      yieldTimeMs: 50,
    });
    const finished = await writeUntilExit(
      {
        writeStdin: (args) => session.writeStdin(args),
      },
      sessionId,
      'continue\n',
    );

    expect(readyOutput).toContain('ready');
    expect(polled).not.toContain('ready');
    expect(finished).toContain('done');
    expect(finished).not.toContain('ready');
  });

  it('caps unread active session output', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const started = await session.execCommand({
      cmd: 'sleep 0.1; yes output | head -c 2500000; sleep 2',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 10,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const output = await session.writeStdin({
      sessionId,
      chars: '',
      yieldTimeMs: 1_000,
      maxOutputTokens: 20,
    });

    expect(output).toContain('characters truncated from process output');
    expect(output.length).toBeLessThan(2_000);
    const finalOutput = output.includes('Process exited with code')
      ? output
      : await writeUntilExit(
          {
            writeStdin: (args) => session.writeStdin(args),
          },
          sessionId,
          '',
        );
    expect(finalOutput).toContain('Process exited with code 0');
  }, 10_000);
});

async function writeUntilExit(
  session: {
    writeStdin(args: {
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
    }): Promise<string>;
  },
  sessionId: number,
  chars: string,
): Promise<string> {
  let output = await session.writeStdin({
    sessionId,
    chars,
    yieldTimeMs: ACTIVE_PROCESS_POLL_MS,
  });
  let combinedOutput = output;

  for (
    let attempt = 0;
    attempt < ACTIVE_PROCESS_MAX_POLLS &&
    !output.includes('Process exited with code');
    attempt += 1
  ) {
    output = await session.writeStdin({
      sessionId,
      chars: '',
      yieldTimeMs: ACTIVE_PROCESS_POLL_MS,
    });
    combinedOutput += output;
  }

  return combinedOutput;
}

async function whichPython(): Promise<string> {
  const { stdout } = await execFileAsync('which', ['python3']);
  return stdout.trim();
}

async function collectActiveCommandOutput(
  session: {
    writeStdin(args: {
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
    }): Promise<string>;
  },
  initialOutput: string,
): Promise<string> {
  const sessionId = Number(
    initialOutput.match(/Process running with session ID (\d+)/)?.[1],
  );
  if (!Number.isFinite(sessionId)) {
    return initialOutput;
  }

  return `${initialOutput}${await writeUntilExit(session, sessionId, '')}`;
}

async function waitForOutputContaining(
  session: {
    writeStdin(args: {
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
    }): Promise<string>;
  },
  sessionId: number,
  expected: string,
  options: { yieldTimeMs?: number; maxOutputTokens?: number } = {},
): Promise<string> {
  let output = '';

  for (
    let attempt = 0;
    attempt < ACTIVE_PROCESS_MAX_POLLS && !output.includes(expected);
    attempt += 1
  ) {
    output += await session.writeStdin({
      sessionId,
      chars: '',
      yieldTimeMs: options.yieldTimeMs ?? ACTIVE_PROCESS_POLL_MS,
      maxOutputTokens: options.maxOutputTokens,
    });
  }

  return output;
}
