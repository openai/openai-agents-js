import { describe, test, expect, beforeAll } from 'vitest';
import { execa as execaBase } from 'execa';

const execa = execaBase({
  cwd: './integration-tests/node-ai-sdk-v3-ts',
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    TS_NODE_PROJECT: '',
    TS_NODE_COMPILER_OPTIONS: '',
  },
});

describe('Node.js (TypeScript + AI SDK v3)', () => {
  beforeAll(async () => {
    console.log('[node-ai-sdk-v3-ts] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[node-ai-sdk-v3-ts] Installing dependencies');
    await execa`npm install`;
  }, 60000);

  test('should build-check, build, and run', { timeout: 120000 }, async () => {
    await execa`npm run build-check`;
    await execa`npm run build`;
    const { stdout } = await execa`npm run start`;
    expect(stdout).toContain('[AISDK_V3_RESPONSE]');
  });
});
