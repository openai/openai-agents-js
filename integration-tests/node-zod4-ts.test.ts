import { describe, test, expect, beforeAll } from 'vitest';
import { execa as execaBase } from 'execa';

const execa = execaBase({
  cwd: './integration-tests/node-zod4-ts',
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    TS_NODE_PROJECT: '',
    TS_NODE_COMPILER_OPTIONS: '',
  },
});

describe('Node.js (TypeScript + Zod v4)', () => {
  beforeAll(async () => {
    console.log('[node-zod4-ts] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[node-zod4-ts] Installing dependencies');
    await execa`npm install`;
  }, 60000);

  test('should build-check, build, and run', { timeout: 60000 }, async () => {
    await execa`npm run build-check`;
    await execa`npm run build`;
    const { stdout } = await execa`npm run start`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });
});
