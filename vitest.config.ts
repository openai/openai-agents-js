import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';
import {
  assertReviewOptionalFilesExist,
  reviewOptionalFilesForRoot,
} from './helpers/vitest/reviewTestProfile';
import { recommendedTestWorkers } from './helpers/vitest/testConcurrency';
import {
  createWorkspacePackageAliases,
  readWorkspacePackages,
} from './helpers/vitest/workspacePackageAliases';

const rootDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(rootDir, 'packages');
const workspacePackages = readWorkspacePackages(packagesDir);
const testAliases = createWorkspacePackageAliases(workspacePackages);
const maxWorkers = recommendedTestWorkers(availableParallelism());
const financialResearchExampleRoot = resolve(
  rootDir,
  'examples/financial-research-agent',
);
const realtimeReactNativeExampleRoot = resolve(
  rootDir,
  'examples/realtime-react-native',
);

const baseTestConfig = {
  setupFiles: [resolve(rootDir, 'helpers/tests/console-guard.ts')],
  globalSetup: resolve(rootDir, 'helpers/tests/setup.ts'),
};

assertReviewOptionalFilesExist(rootDir);

function reviewExcludes(
  projectRoot: string,
  reviewTestProfile: boolean,
): { exclude?: string[] } {
  if (!reviewTestProfile) {
    return {};
  }
  const optionalFiles = reviewOptionalFilesForRoot(rootDir, projectRoot);
  if (optionalFiles.length === 0) {
    return {};
  }
  return {
    exclude: [...configDefaults.exclude, ...optionalFiles],
  };
}

function createProjects(reviewTestProfile: boolean) {
  const packageProjects = workspacePackages.map(({ name, root }) => ({
    root,
    resolve: { alias: testAliases },
    test: {
      ...baseTestConfig,
      ...reviewExcludes(root, reviewTestProfile),
      alias: testAliases,
      name,
    },
  }));

  const financialResearchExampleProject = {
    root: financialResearchExampleRoot,
    resolve: { alias: testAliases },
    test: {
      ...baseTestConfig,
      ...reviewExcludes(financialResearchExampleRoot, reviewTestProfile),
      alias: testAliases,
      name: 'financial-research-agent-example',
      include: ['manager.test.ts'],
    },
  };

  const realtimeReactNativeExampleProject = {
    root: realtimeReactNativeExampleRoot,
    resolve: { alias: testAliases },
    test: {
      ...baseTestConfig,
      ...reviewExcludes(realtimeReactNativeExampleRoot, reviewTestProfile),
      alias: testAliases,
      name: 'realtime-react-native-example',
      include: ['test/**/*.test.ts'],
    },
  };

  return [
    {
      root: rootDir,
      resolve: { alias: testAliases },
      test: {
        ...baseTestConfig,
        ...reviewExcludes(rootDir, reviewTestProfile),
        alias: testAliases,
        name: 'workspace-test-config',
        maxConcurrency: 4,
        include: [
          'helpers/tests/consoleGuard.test.ts',
          'helpers/vitest/codeChangeVerificationPolicy.test.ts',
          'helpers/vitest/reviewTestProfile.test.ts',
          'helpers/vitest/testConcurrency.test.ts',
          'helpers/vitest/workspacePackageAliases.test.ts',
          'scripts/update-rclone-pin.test.mjs',
          'scripts/released-api-contract.test.mjs',
          'scripts/run-integration-tests-managed.test.mjs',
          'scripts/workflow-contracts.test.mjs',
        ],
      },
    },
    ...packageProjects,
    financialResearchExampleProject,
    realtimeReactNativeExampleProject,
  ];
}

export default defineConfig(({ mode }) => {
  process.env.NODE_ENV = 'test';
  const reviewTestProfile = mode === 'review';
  if (mode === 'review') {
    process.env.OPENAI_AGENTS_TEST_PROFILE = 'review';
  } else if (mode === 'full' || mode === 'watch') {
    process.env.OPENAI_AGENTS_TEST_PROFILE = 'full';
  }
  if (mode !== 'watch') {
    process.env.CI = '1';
  }

  return {
  test: {
    allowOnly: mode === 'watch',
    pool: 'threads',
    maxWorkers,
    projects: createProjects(reviewTestProfile),
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
  },
  };
});
