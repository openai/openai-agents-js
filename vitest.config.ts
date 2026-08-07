import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  createWorkspacePackageAliases,
  readWorkspacePackages,
} from './helpers/vitest/workspacePackageAliases';

const rootDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(rootDir, 'packages');
const workspacePackages = readWorkspacePackages(packagesDir);
const testAliases = createWorkspacePackageAliases(workspacePackages);
const financialResearchExampleRoot = resolve(
  rootDir,
  'examples/financial-research-agent',
);

const baseTestConfig = {
  setupFiles: [resolve(rootDir, 'helpers/tests/console-guard.ts')],
  globalSetup: resolve(rootDir, 'helpers/tests/setup.ts'),
};

const packageProjects = workspacePackages.map(({ name, root }) => {
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

const financialResearchExampleProject = {
  root: financialResearchExampleRoot,
  resolve: {
    alias: testAliases,
  },
  test: {
    ...baseTestConfig,
    alias: testAliases,
    name: 'financial-research-agent-example',
    include: ['manager.test.ts'],
  },
};

export default defineConfig({
  test: {
    pool: 'threads',
    projects: [
      {
        root: rootDir,
        resolve: {
          alias: testAliases,
        },
        test: {
          ...baseTestConfig,
          alias: testAliases,
          name: 'workspace-test-config',
          include: [
            'helpers/tests/consoleGuard.test.ts',
            'helpers/vitest/workspacePackageAliases.test.ts',
            'scripts/update-rclone-pin.test.mjs',
          ],
        },
      },
      ...packageProjects,
      financialResearchExampleProject,
    ],
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
