import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { execa as execaBase, ResultPromise } from 'execa';
import path from 'node:path';

import {
  assertPathExists,
  requireEnvVar,
  withManagedFile,
} from './_helpers/prereqs';

const execa = execaBase({
  cwd: './integration-tests/vite-react',
});

let server: ResultPromise;
const envPath = path.join(
  process.cwd(),
  'integration-tests',
  'vite-react',
  '.env',
);
let cleanupEnvFile: (() => Promise<void>) | undefined;

describe('Vite React', () => {
  beforeAll(async () => {
    // Remove lock file to avoid errors
    await execa`rm -f package-lock.json`;
    console.log('[vite-react] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[vite-react] Installing dependencies');
    await execa`npm install`;

    const apiKey = requireEnvVar(
      'OPENAI_API_KEY',
      'the Vite React integration test',
    );
    cleanupEnvFile = await withManagedFile(
      envPath,
      `VITE_OPENAI_API_KEY=${apiKey}\n`,
    );
    await assertPathExists(
      chromium.executablePath(),
      'Playwright Chromium is not installed. Run `pnpm exec playwright install` before running the Vite React integration test.',
    );

    console.log('[vite-react] Building');
    await execa`npm run build`;
    console.log('[vite-react] Starting server');
    server = execa`npm run preview -- --port 9999`;
    server.catch(() => {});
    await new Promise((resolve) => {
      server.stdout?.on('data', (data) => {
        if (data.toString().includes('http://localhost')) {
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
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('http://localhost:9999/');
    const root = await page.$('#root');
    const span = await root?.waitForSelector('span[data-testid="response"]', {
      state: 'attached',
      timeout: 60000,
    });
    expect(await span?.textContent()).toBe('[RESPONSE]Hello there![/RESPONSE]');
    await browser.close();
  });

  afterAll(async () => {
    if (server) {
      server.kill();
    }
    if (cleanupEnvFile) {
      await cleanupEnvFile();
    }
  });
});
