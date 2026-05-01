import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa as execaBase } from 'execa';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const execa = execaBase({
  cwd: './integration-tests/bun',
  env: createIntegrationSubprocessEnv(),
});

describe('Bun', () => {
  beforeAll(async () => {
    // Remove lock file to avoid errors.
    await execa`rm -f bun.lock`;
    console.log('[bun] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[bun] Installing dependencies');
    await execa`bun install`;
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
  });
});
