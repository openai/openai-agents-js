import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(rootDir, 'packages');
const testAliases = {
  '@openai/agents-core/sandbox/local': resolve(
    rootDir,
    'packages/agents-core/src/sandbox/local.ts',
  ),
  '@openai/agents-core/sandbox/internal': resolve(
    rootDir,
    'packages/agents-core/src/sandbox/internal.ts',
  ),
  '@openai/agents-core/sandbox': resolve(
    rootDir,
    'packages/agents-core/src/sandbox/index.ts',
  ),
};

const baseTestConfig = {
  setupFiles: [resolve(rootDir, 'helpers/tests/console-guard.ts')],
  globalSetup: resolve(rootDir, 'helpers/tests/setup.ts'),
};

const packageEntries = readdirSync(packagesDir, { withFileTypes: true }).filter(
  (entry) => entry.isDirectory(),
);

const packageProjects = packageEntries.map((entry) => {
  const root = resolve(packagesDir, entry.name);
  const packageJsonPath = resolve(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: string;
  };
  const name = packageJson.name ?? entry.name;

  return {
    root,
    resolve: {
      alias: testAliases,
    },
    test: {
      ...baseTestConfig,
      alias: testAliases,
      name,
    },
  };
});

export default defineConfig({
  test: {
    alias: testAliases,
    pool: 'threads',
    projects: packageProjects,
    // Coverage options are global in Vitest workspaces.
    // Keep the filter at the root to avoid scanning docs/examples/dist output.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'json-summary', 'lcov'],
      all: true,
      include: ['packages/**/src/**/*.ts'],
      exclude: ['**/*.d.ts', 'packages/**/test/**', 'packages/**/dist/**'],
    },
  },
});
