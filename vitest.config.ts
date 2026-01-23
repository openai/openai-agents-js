import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(rootDir, 'packages');

const coverageInclude = [resolve(rootDir, 'packages/**/src/**/*.ts')];
const coverageExclude = [
  resolve(rootDir, '**/*.d.ts'),
  resolve(rootDir, 'packages/**/test/**'),
  resolve(rootDir, 'packages/**/dist/**'),
];

const baseTestConfig = {
  setupFiles: [resolve(rootDir, 'helpers/tests/console-guard.ts')],
  globalSetup: resolve(rootDir, 'helpers/tests/setup.ts'),
  // Enable code coverage reporting with Vitest's built‑in integration. We
  // only enable it for the monorepo packages (workspaces) so that the
  // initial report focuses on our public libraries and avoids unnecessary
  // noise from docs and examples.
  coverage: {
    provider: 'v8',
    reporter: ['text', 'html', 'json', 'json-summary', 'lcov'],
    all: true,
    // Only include source files from the published packages. This keeps the
    // metrics meaningful and prevents Vitest from trying to instrument node
    // dependencies or the compiled dist folder.
    include: coverageInclude,
    exclude: coverageExclude,
  },
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
  },
});
