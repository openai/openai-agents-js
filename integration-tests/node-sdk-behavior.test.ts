import { rm } from 'node:fs/promises';

import { beforeAll, describe, expect, test } from 'vitest';
import { execa as execaBase } from 'execa';

import { createIntegrationSubprocessEnv } from './_helpers/env';

const fixtureDirectory = './integration-tests/node-sdk-behavior';
const execa = execaBase({
  cwd: fixtureDirectory,
  env: createIntegrationSubprocessEnv(),
});

describe.sequential('Node.js published SDK behavior', () => {
  beforeAll(async () => {
    console.log('[node-sdk-behavior] Removing node_modules');
    await rm(`${fixtureDirectory}/node_modules`, {
      recursive: true,
      force: true,
    });
    console.log('[node-sdk-behavior] Installing dependencies from Verdaccio');
    await execa`npm install`;
  }, 120_000);

  test('core behavior profile', { timeout: 1_200_000 }, async () => {
    const { stdout } = await execa`npm run test:core`;
    expect(stdout).toContain('fail 0');
  });

  test('capability behavior profile', { timeout: 1_200_000 }, async () => {
    const { stdout } = await execa`npm run test:capabilities`;
    expect(stdout).toContain('fail 0');
  });
});
