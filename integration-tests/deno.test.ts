import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa as execaBase } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const denoCwd = './integration-tests/deno';
const denoNpmrcPath = path.resolve(denoCwd, '.npmrc');
let denoCacheDir = '';
let execa = execaBase({ cwd: denoCwd });

describe('Deno', () => {
  beforeAll(async () => {
    // Use an isolated Deno cache so scoped registry resolution does not reuse stale global npm metadata.
    denoCacheDir = await mkdtemp(path.join(tmpdir(), 'openai-agents-js-deno-'));
    execa = execaBase({
      cwd: denoCwd,
      env: createIntegrationSubprocessEnv({
        DENO_DIR: denoCacheDir,
        NPM_CONFIG_USERCONFIG: denoNpmrcPath,
      }),
    });

    await rm(path.join(denoCwd, 'deno.lock'), { force: true });
    console.log('[deno] Removing node_modules');
    await rm(path.join(denoCwd, 'node_modules'), {
      recursive: true,
      force: true,
    });
    console.log('[deno] Installing dependencies');
    await execa`deno install --reload=npm:`;
  }, 60000);

  test('should be able to run', { timeout: 60000 }, async () => {
    const { stdout } =
      await execa`deno --allow-net --allow-env --reload=npm: main.ts`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test('should be able to run with zod', { timeout: 60000 }, async () => {
    const { stdout } =
      await execa`deno --allow-net --allow-env --reload=npm: zod.ts`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test(
    'aisdk runner should not lose tracing context',
    { timeout: 60000 },
    async () => {
      const { stdout } = await execa`deno --allow-all --reload=npm: aisdk.ts`;
      expect(stdout).toContain('[AISDK_RESPONSE]hello[/AISDK_RESPONSE]');
    },
  );

  test(
    'AsyncLocalStorage propagation preserves tracing context',
    { timeout: 60000 },
    async () => {
      const { stdout } =
        await execa`deno --allow-env --reload=npm: als-propagation.ts`;
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
    await rm(path.join(denoCwd, 'deno.lock'), { force: true });
    await rm(denoCacheDir, { recursive: true, force: true });
  });
});
