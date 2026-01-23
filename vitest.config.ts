import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(rootDir, 'packages');

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
    test: {
      ...baseTestConfig,
      name,
    },
  };
});

export default defineConfig({
  test: {
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
