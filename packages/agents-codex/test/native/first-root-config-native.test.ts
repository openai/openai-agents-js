import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const nativeIt = process.env.OPENAI_AGENTS_NATIVE_TESTS === '1' ? it : it.skip;
nativeIt(
  'uses one private first-root view while raw and later starts reload',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'first-root-config-'));
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    delete env.OPENAI_API_KEY;
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              './fixtures/first-root-config-process.mjs',
              import.meta.url,
            ),
          ),
          fileURLToPath(new URL('../../native/index.js', import.meta.url)),
          home,
        ],
        { env, timeout: 20_000, maxBuffer: 1024 * 1024 },
      );
      expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({
        status: 'pass',
        coherentFirstRoot: true,
        laterAndRawReload: true,
        changedOverrideReload: true,
        parseFailureInvalidates: true,
        closedRejects: true,
        managedPolicyReload: true,
        rawStartInvalidates: true,
        freshOpeningReload: true,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  25_000,
);
