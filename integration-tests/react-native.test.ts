import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execa as execaBase, type ResultPromise } from 'execa';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createIntegrationSubprocessEnv } from './_helpers/env';
import { requireEnvVar } from './_helpers/prereqs';

const repositoryRoot = process.cwd();
const fixtureDirectory = path.join(
  repositoryRoot,
  '.cache',
  'integration-tests',
  'realtime-react-native',
);
const npmConfigPath = path.join(fixtureDirectory, '.npmrc');
const excludedFixtureDirectories = new Set([
  '.expo',
  'android',
  'dist',
  'ios',
  'node_modules',
]);
const baseEnv = createIntegrationSubprocessEnv({
  EXPO_NO_TELEMETRY: '1',
  NPM_CONFIG_USERCONFIG: npmConfigPath,
  OPENAI_API_KEY: undefined,
});
const fixtureExeca = execaBase({
  cwd: fixtureDirectory,
  env: baseEnv,
});

describe('React Native', () => {
  beforeAll(async () => {
    await rm(fixtureDirectory, { force: true, recursive: true });
    const exampleDirectory = path.join(
      repositoryRoot,
      'examples',
      'realtime-react-native',
    );
    await cp(exampleDirectory, fixtureDirectory, {
      filter: (source) => {
        const [topLevelDirectory] = path
          .relative(exampleDirectory, source)
          .split(path.sep);
        return !excludedFixtureDirectories.has(topLevelDirectory);
      },
      recursive: true,
    });

    const packageJsonPath = path.join(fixtureDirectory, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    packageJson.dependencies['@openai/agents-realtime'] = 'latest';
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      npmConfigPath,
      [
        'registry=https://registry.npmjs.org/',
        '@openai:registry=http://localhost:4873/',
        '',
      ].join('\n'),
      'utf8',
    );

    console.log('[react-native] Installing published dependencies');
    await fixtureExeca`npm install --cache .npm-cache --prefer-online`;
    console.log('[react-native] Type-checking the example');
    await fixtureExeca`npm run build-check`;
    console.log('[react-native] Creating an Android Metro bundle');
    await fixtureExeca`npm run bundle:android`;
  }, 300_000);

  test('bundles the published packages for Android', async () => {
    const bundleFiles = await findFiles(
      path.join(fixtureDirectory, 'dist'),
      (file) => file.endsWith('.js'),
    );
    expect(bundleFiles.length).toBeGreaterThan(0);

    const bundle = (
      await Promise.all(bundleFiles.map((file) => readFile(file, 'utf8')))
    ).join('\n');
    expect(bundle).toContain('React Native assistant');
    expect(bundle).not.toContain('node:async_hooks');
    expect(bundle).not.toContain('node:events');
  });

  test(
    'connects through WebRTC on Android (opt-in)',
    { timeout: 900_000 },
    async (context) => {
      if (process.env.OPENAI_AGENTS_RUN_REACT_NATIVE_LIVE !== '1') {
        context.skip();
      }

      const apiKey = requireEnvVar(
        'OPENAI_API_KEY',
        'the React Native live integration test',
      );
      const device = await fixtureExeca`adb get-state`;
      expect(device.stdout.trim()).toBe('device');

      const liveEnv = createIntegrationSubprocessEnv({
        CI: '1',
        EXPO_PUBLIC_REACT_NATIVE_E2E: '1',
        EXPO_PUBLIC_REALTIME_TOKEN_URL: 'http://127.0.0.1:8787/token',
        OPENAI_API_KEY: undefined,
      });
      const run = execaBase({ cwd: fixtureDirectory, env: liveEnv });
      const runTokenServer = execaBase({
        cwd: fixtureDirectory,
        env: { ...liveEnv, OPENAI_API_KEY: apiKey },
      });
      let tokenServer: ResultPromise | undefined;
      let metro: ResultPromise | undefined;

      try {
        tokenServer = runTokenServer`npm run token-server`;
        tokenServer.catch(() => {});
        await waitForOutput(tokenServer, 'Realtime token server listening');

        await run`adb reverse tcp:8787 tcp:8787`;
        await run`adb reverse tcp:8082 tcp:8082`;
        await run`adb logcat -c`;

        metro = run`npm run start -- --port 8082`;
        metro.catch(() => {});
        await waitForOutput(metro, 'Metro waiting on');

        await run`npm run android -- --port 8082 --no-bundler`;
        await run`adb shell pm grant com.openai.agents.realtimernexample android.permission.RECORD_AUDIO`;
        await run`adb shell am force-stop com.openai.agents.realtimernexample`;
        await run`adb shell monkey -p com.openai.agents.realtimernexample 1`;

        const result = await waitForAndroidSentinel(run);
        expect(result).toBe('RN_REALTIME_E2E:PASS');
      } finally {
        metro?.kill('SIGTERM');
        tokenServer?.kill('SIGTERM');
      }
    },
  );

  afterAll(async () => {
    await rm(fixtureDirectory, { force: true, recursive: true });
  });
});

async function findFiles(
  directory: string,
  predicate: (file: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return findFiles(file, predicate);
      }
      return predicate(file) ? [file] : [];
    }),
  );
  return files.flat();
}

async function waitForOutput(
  process: ResultPromise,
  expected: string,
  timeoutMs = 60_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for "${expected}".`)),
      timeoutMs,
    );
    const onData = (data: Buffer) => {
      if (data.toString().includes(expected)) {
        clearTimeout(timeout);
        process.stdout?.off('data', onData);
        resolve();
      }
    };
    process.stdout?.on('data', onData);
    process.catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForAndroidSentinel(
  run: ReturnType<typeof execaBase>,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await run`adb logcat -d`;
    const pass = result.stdout.match(/RN_REALTIME_E2E:PASS/);
    if (pass) {
      return pass[0];
    }
    const failure = result.stdout.match(/RN_REALTIME_E2E:FAIL:[^\n]+/);
    if (failure) {
      throw new Error(failure[0]);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Timed out waiting for the React Native E2E sentinel.');
}
