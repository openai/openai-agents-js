import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { execa as execaBase, ResultPromise } from 'execa';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

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
let wroteEnvFile = false;

describe('Vite React', () => {
  beforeAll(async () => {
    // Remove lock file to avoid errors
    await execa`rm -f package-lock.json`;
    console.log('[vite-react] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[vite-react] Installing dependencies');
    await execa`npm install`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY must be set to run the Vite React integration test.',
      );
    }
    await writeFile(envPath, `VITE_OPENAI_API_KEY=${apiKey}\n`, 'utf8');
    wroteEnvFile = true;

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
    if (wroteEnvFile) {
      await unlink(envPath).catch(() => {});
    }
  });
});
