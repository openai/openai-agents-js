import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';

const execFileAsync = promisify(execFile);
const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testFileDir, '../../..');
const sandboxLocalModuleUrl = pathToFileURL(
  join(testFileDir, '../../src/sandbox/local.ts'),
).href;

const PYTHON_SIGNAL_IGNORE_WRAPPER = String.raw`
import signal
import subprocess
import sys

signal.signal(getattr(signal, sys.argv[1]), signal.SIG_IGN)
raise SystemExit(subprocess.run(sys.argv[2:]).returncode)
`;

describe('UnixLocalSandboxClient PTY signal handling', () => {
  it.concurrent.each([
    { signalName: 'SIGINT', chars: '\u0003', expectedExitCodes: [127, 130] },
    { signalName: 'SIGQUIT', chars: '\u001c', expectedExitCodes: [131] },
  ])(
    'interrupts tty commands with $signalName even if the parent ignores it',
    async ({ signalName, chars, expectedExitCodes }) => {
      const rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-sandbox-signal-test-'),
      );
      const scriptPath = join(rootDir, `pty-${signalName.toLowerCase()}.ts`);

      try {
        await writeFile(
          scriptPath,
          `
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Manifest, UnixLocalSandboxClient } from ${JSON.stringify(sandboxLocalModuleUrl)};

const [, , chars, expectedExitCodesJson] = process.argv;
const expectedExitCodes = JSON.parse(expectedExitCodesJson);

async function main() {
  const rootDir = await mkdtemp(join(tmpdir(), 'agents-core-pty-signal-child-'));
  const client = new UnixLocalSandboxClient({ workspaceBaseDir: rootDir });
  const session = await client.create(new Manifest());

  try {
    const started = await session.execCommand({
      cmd: 'printf "ready\\\\n"; exec sleep 30',
      shell: '/bin/sh',
      login: false,
      tty: true,
      yieldTimeMs: 100,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\\d+)/)?.[1],
    );
    if (!Number.isFinite(sessionId)) {
      throw new Error(\`Expected active PTY session, received: \${started}\`);
    }
    let readyOutput = started;
    for (
      let attempt = 0;
      attempt < 50 && !readyOutput.includes('ready');
      attempt += 1
    ) {
      readyOutput += await session.writeStdin({
        sessionId,
        chars: '',
        yieldTimeMs: 100,
      });
    }
    if (!readyOutput.includes('ready')) {
      throw new Error(\`Expected PTY command to become ready, received: \${readyOutput}\`);
    }

    let interrupted = await session.writeStdin({
      sessionId,
      chars,
      yieldTimeMs: 100,
    });
    for (
      let attempt = 0;
      attempt < 50 && !interrupted.includes('Process exited with code');
      attempt += 1
    ) {
      interrupted += await session.writeStdin({
        sessionId,
        chars: '',
        yieldTimeMs: 100,
      });
    }
    if (
      !expectedExitCodes.some((code) =>
        interrupted.includes(\`Process exited with code \${code}\`),
      )
    ) {
      throw new Error(
        \`Expected one of exit codes \${expectedExitCodes.join(', ')}, received: \${interrupted}\`,
      );
    }
  } finally {
    await session.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}

void main();
`,
          'utf8',
        );

        await execFileAsync(
          process.env.OPENAI_AGENTS_PYTHON ?? 'python3',
          [
            '-c',
            PYTHON_SIGNAL_IGNORE_WRAPPER,
            signalName,
            'pnpm',
            'exec',
            'tsx',
            scriptPath,
            chars,
            JSON.stringify(expectedExitCodes),
          ],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              CI: '1',
            },
            maxBuffer: 1024 * 1024,
            timeout: 20_000,
          },
        );
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
