import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa as execaBase } from 'execa';

const execa = execaBase({ cwd: './integration-tests/deno' });

describe('Deno', () => {
  beforeAll(async () => {
    // Remove lock file to avoid errors
    await execa`rm -f deno.lock`;
    console.log('[deno] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[deno] Installing dependencies');
    await execa`deno install`;
  }, 60000);

  test('should be able to run', { timeout: 60000 }, async () => {
    const { stdout } = await execa`deno --allow-net --allow-env main.ts`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test(
    'aisdk runner should not lose tracing context',
    { timeout: 60000 },
    async () => {
      const { stdout } = await execa`deno --allow-all aisdk.ts`;
      expect(stdout).toContain('[AISDK_RESPONSE]hello[/AISDK_RESPONSE]');
    },
  );

  afterAll(async () => {
    await execa`rm -f deno.lock`;
  });
});
