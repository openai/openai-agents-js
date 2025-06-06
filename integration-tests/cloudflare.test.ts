import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa as execaBase, ResultPromise } from 'execa';

const execa = execaBase({
  cwd: './integration-tests/cloudflare-workers/worker',
});

let server: ResultPromise;

describe('Cloudflare Workers', () => {
  beforeAll(async () => {
    // Remove lock file to avoid errors
    await execa`rm -f package-lock.json`;
    console.log('[cloudflare] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[cloudflare] Installing dependencies');
    await execa`npm install`;
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

  test(
    'should be able to run',
    async () => {
      const response = await fetch('http://localhost:8787/');
      const text = await response.text();
      expect(text).toContain('[RESPONSE]Hello there![/RESPONSE]');
    },
    {
      timeout: 60000,
    },
  );

  afterAll(async () => {
    if (server) {
      server.kill();
    }
  });
});
