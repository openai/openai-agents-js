import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
nativeIt(
  'keeps accepted computer application data private and detached',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-computer-data-'));
    try {
      const result = await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          join(
            dirname(fileURLToPath(import.meta.url)),
            'fixtures/computer-application-data-child.ts',
          ),
        ],
        {
          timeout: 50_000,
          maxBuffer: 2_097_152,
          env: {
            ...process.env,
            OPENAI_API_KEY: undefined,
            CODEX_HOME: join(directory, 'home'),
          },
        },
      );
      expect(result.stdout).toContain('PASS computer-application-data');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
