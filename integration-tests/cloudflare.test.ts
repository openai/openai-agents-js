import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa as execaBase, ResultPromise } from 'execa';
import path from 'node:path';

import { createIntegrationSubprocessEnv } from './_helpers/env';
import { requireEnvVar, withManagedFile } from './_helpers/prereqs';

const execa = execaBase({
  cwd: './integration-tests/cloudflare-workers/worker',
  env: createIntegrationSubprocessEnv(),
});

let server: ResultPromise;
const devVarsPath = path.join(
  process.cwd(),
  'integration-tests',
  'cloudflare-workers',
  'worker',
  '.dev.vars',
);
let cleanupDevVars: (() => Promise<void>) | undefined;

describe('Cloudflare Workers', () => {
  beforeAll(async () => {
    // Remove lock file to avoid errors.
    await execa`rm -f package-lock.json`;
    console.log('[cloudflare] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[cloudflare] Installing dependencies');
    await execa`npm install`;
    const apiKey = requireEnvVar(
      'OPENAI_API_KEY',
      'the Cloudflare Workers integration test',
    );
    cleanupDevVars = await withManagedFile(
      devVarsPath,
      `OPENAI_API_KEY=${apiKey}\n`,
    );
    console.log('[cloudflare] Starting server');
    server = execa`npm run start`;
    await new Promise((resolve) => {
      server.stdout?.on('data', (data) => {
        if (data.toString().includes('Ready')) {
          resolve(true);
        }
      });
    });
    process.on('exit', () => {
      if (server) {
        server.kill();
      }
    });
  }, 60000);

  test('should be able to run', { timeout: 60000 }, async () => {
    const response = await fetch('http://localhost:8787/');
    const text = await response.text();
    expect(text).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  test(
    'aisdk runner should not lose tracing context',
    { timeout: 60000 },
    async () => {
      const response = await fetch('http://localhost:8787/aisdk');
      const text = await response.text();
      expect(text).toContain('[AISDK_RESPONSE]hello[/AISDK_RESPONSE]');
    },
  );

  test(
    'AsyncLocalStorage propagation preserves tracing context',
    { timeout: 60000 },
    async () => {
      const response = await fetch('http://localhost:8787/als-propagation');
      const report = (await response.json()) as Record<string, boolean>;

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
    if (server) {
      server.kill();
    }
    if (cleanupDevVars) {
      await cleanupDevVars();
    }
  });
});
