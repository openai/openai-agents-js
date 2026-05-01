import { describe, test, expect, beforeAll } from 'vitest';
import { execa as execaBase } from 'execa';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const execa = execaBase({
  cwd: './integration-tests/node',
  env: createIntegrationSubprocessEnv(),
});

describe('Node.js', () => {
  beforeAll(async () => {
    // Remove lock file to avoid errors.
    console.log('[node] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[node] Installing dependencies');
    await execa`npm install`;
  }, 60000);

  test('should be able to run using CommonJS', { timeout: 15000 }, async () => {
    const { stdout } = await execa`npm run start:cjs`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test('should be able to run using ESM', { timeout: 15000 }, async () => {
    const { stdout } = await execa`npm run start:esm`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test('aisdk runner should not lose tracing context', async () => {
    const { stdout } = await execa`npm run start:aisdk:cjs`;
    expect(stdout).toContain('[AISDK_RESPONSE]hello[/AISDK_RESPONSE]');
  });

  test(
    'codex runner should not lose tracing context',
    { timeout: 120_000 },
    async () => {
      const { stdout } = await execa`npm run start:codex`;
      expect(stdout).toContain('[CODEX_RESPONSE]');
    },
  );

  test(
    'sandbox agent should run with unix-local',
    { timeout: 60_000 },
    async () => {
      const { stdout } = await execa`npm run start:sandbox:unix-local`;
      expect(stdout).toMatch(
        /\[SANDBOX_TOOLS\].*exec_command.*\[\/SANDBOX_TOOLS\]/s,
      );
      expect(stdout).toContain(
        '[SANDBOX_RESPONSE]unix-local-node:unix-local-node-command[/SANDBOX_RESPONSE]',
      );
    },
  );

  test(
    'sandbox agent should run with docker',
    { timeout: 120_000 },
    async (context) => {
      try {
        await execa`docker info`;
      } catch {
        context.skip();
      }

      const { stdout } = await execa`npm run start:sandbox:docker`;
      expect(stdout).toMatch(
        /\[SANDBOX_TOOLS\].*exec_command.*\[\/SANDBOX_TOOLS\]/s,
      );
      expect(stdout).toContain(
        '[SANDBOX_RESPONSE]docker-node:docker-node-command[/SANDBOX_RESPONSE]',
      );
    },
  );
});
