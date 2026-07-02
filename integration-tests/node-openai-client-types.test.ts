import { beforeAll, describe, test } from 'vitest';
import { execa as execaBase } from 'execa';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const execa = execaBase({
  cwd: './integration-tests/node-openai-client-types',
  env: createIntegrationSubprocessEnv(),
});

describe('Node.js (NodeNext OpenAI client types)', () => {
  beforeAll(async () => {
    console.log('[node-openai-client-types] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[node-openai-client-types] Installing dependencies');
    await execa`npm install`;
  }, 60_000);

  test('accepts an ESM OpenAI client across TypeScript versions', async () => {
    await execa`npm run build-check`;
  }, 15_000);
});
