import { describe, test, expect, beforeAll } from 'vitest';
import { execa as execaBase } from 'execa';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const execa = execaBase({
  cwd: './integration-tests/node-zod4',
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

  test(
    'should be able to run using CommonJS',
    { timeout: 15_000 },
    async () => {
      const { stdout } = await execa`npm run start:cjs`;
      expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
    },
  );

  test('should be able to run using ESM', { timeout: 15_000 }, async () => {
    const { stdout } = await execa`npm run start:esm`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });
});
