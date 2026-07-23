import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa as execaBase } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const bunCwd = './integration-tests/bun';
let bunCacheDir = '';
let execa = execaBase({ cwd: bunCwd });

describe('Bun', () => {
  beforeAll(async () => {
    // Use an isolated Bun cache so republished local packages cannot reuse stale tarballs.
    bunCacheDir = await mkdtemp(path.join(tmpdir(), 'openai-agents-js-bun-'));
    execa = execaBase({
      cwd: bunCwd,
      env: createIntegrationSubprocessEnv({
        BUN_INSTALL_CACHE_DIR: bunCacheDir,
      }),
    });

    // Remove lock file to avoid errors.
    await execa`rm -f bun.lock`;
    console.log('[bun] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[bun] Installing dependencies');
    await execa`bun install --minimum-release-age=0`;
  }, 60000);

  test('should be able to run', { timeout: 15_000 }, async () => {
    const { stdout } = await execa`bun run index.ts`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test('should be able to run with zod', { timeout: 15_000 }, async () => {
    const { stdout } = await execa`bun run zod.ts`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test(
    'aisdk runner should not lose tracing context',
    { timeout: 15_000 },
    async () => {
      const { stdout } = await execa`bun run aisdk.ts`;
      expect(stdout).toContain('[AISDK_RESPONSE]hello[/AISDK_RESPONSE]');
    },
  );

  test(
    'sandbox agent should run with unix-local',
    { timeout: 60_000 },
    async () => {
      const { stdout } = await execa`bun run sandbox-unix-local.ts`;
      expect(stdout).toMatch(
        /\[SANDBOX_TOOLS\].*exec_command.*\[\/SANDBOX_TOOLS\]/s,
      );
      expect(stdout).toContain(
        '[SANDBOX_RESPONSE]unix-local-bun:unix-local-bun-command[/SANDBOX_RESPONSE]',
      );
    },
  );

  afterAll(async () => {
    await execa`rm -f bun.lock`;
    await rm(bunCacheDir, { recursive: true, force: true });
  });
});
