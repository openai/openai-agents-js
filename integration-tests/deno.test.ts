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

  test('should be able to run with zod', { timeout: 60000 }, async () => {
    const { stdout } = await execa`deno --allow-net --allow-env zod.ts`;
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

  test(
    'AsyncLocalStorage propagation preserves tracing context',
    { timeout: 60000 },
    async () => {
      const { stdout } = await execa`deno --allow-env als-propagation.ts`;
      const match = stdout.match(/\[ALS_REPORT\](.*)\[\/ALS_REPORT\]/s);
      expect(match).not.toBeNull();

      const report = JSON.parse(match?.[1] ?? '{}') as Record<string, boolean>;
      expect(report).toEqual(
        expect.objectContaining({
          sync: true,
          promiseThen: true,
          queueMicrotask: true,
          setTimeout: true,
          cryptoDigest: true,
          readablePull: true,
          transformStreamTransform: true,
          transformStreamFlush: true,
        }),
      );
    },
  );

  afterAll(async () => {
    await execa`rm -f deno.lock`;
  });
});
