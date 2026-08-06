import { describe, test, expect, beforeAll } from 'vitest';
import { execa as execaBase } from 'execa';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const execa = execaBase({
  cwd: './integration-tests/node-ai-sdk-v4-ts',
  env: createIntegrationSubprocessEnv(),
});

describe('Node.js (TypeScript + AI SDK v4)', () => {
  beforeAll(async () => {
    console.log('[node-ai-sdk-v4-ts] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[node-ai-sdk-v4-ts] Installing dependencies');
    await execa`npm install`;
  }, 60000);

  test(
    'published packages handle an AI SDK v4 tool loop',
    { timeout: 120000 },
    async () => {
      await execa`npm run build-check`;
      await execa`npm run build`;
      const { stdout } = await execa`npm run start`;
      expect(stdout).toContain(
        '[AISDK_V4_RESPONSE]Berlin is sunny.[/AISDK_V4_RESPONSE]',
      );
    },
  );
});
