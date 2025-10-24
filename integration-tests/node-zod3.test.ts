import { describe, test, expect, beforeAll } from 'vitest';
import { execa as execaBase } from 'execa';

const execa = execaBase({
  cwd: './integration-tests/node-zod3',
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    TS_NODE_PROJECT: '',
    TS_NODE_COMPILER_OPTIONS: '',
  },
});

describe('Node.js', () => {
  beforeAll(async () => {
    // remove lock file to avoid errors
    console.log('[node] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[node] Installing dependencies');
    await execa`npm install`;
  }, 60000);

  test('should be able to run using CommonJS', async () => {
    const { stdout } = await execa`npm run start:cjs`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test('should be able to run using ESM', async () => {
    const { stdout } = await execa`npm run start:esm`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });
});
