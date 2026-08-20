import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertReviewOptionalFilesExist,
  isReviewTestProfile,
  REVIEW_TEST_PROFILE_ENV,
  reviewOptionalFilesForRoot,
  reviewOptionalTestFiles,
} from './reviewTestProfile';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));

describe('review test profile', () => {
  it('keeps review-optional ownership in existing test files', () => {
    expect(() => assertReviewOptionalFilesExist(rootDir)).not.toThrow();
    expect(reviewOptionalTestFiles).toHaveLength(
      new Set(reviewOptionalTestFiles).size,
    );
    expect(reviewOptionalTestFiles).toEqual(
      expect.arrayContaining([
        'helpers/tests/consoleGuard.test.ts',
        'packages/agents-core/test/sandboxes/docker.test.ts',
      ]),
    );
  });

  it('returns paths relative to each Vitest project root', () => {
    expect(reviewOptionalFilesForRoot(rootDir, rootDir)).toEqual([
      ...reviewOptionalTestFiles,
    ]);
    expect(
      reviewOptionalFilesForRoot(
        rootDir,
        resolve(rootDir, 'packages/agents-core'),
      ),
    ).toEqual([
      'test/sandboxes/docker.test.ts',
      'test/sandboxes/unixLocal.git.test.ts',
      'test/sandboxes/unixLocal.process.test.ts',
      'test/sandboxes/unixLocal.signals.test.ts',
    ]);
    expect(
      reviewOptionalFilesForRoot(
        rootDir,
        resolve(rootDir, 'packages/agents-openai'),
      ),
    ).toEqual([]);
  });

  it('fails fast for misspelled profiles', () => {
    expect(isReviewTestProfile({})).toBe(false);
    expect(isReviewTestProfile({ [REVIEW_TEST_PROFILE_ENV]: 'full' })).toBe(
      false,
    );
    expect(isReviewTestProfile({ [REVIEW_TEST_PROFILE_ENV]: 'review' })).toBe(
      true,
    );
    expect(() =>
      isReviewTestProfile({ [REVIEW_TEST_PROFILE_ENV]: 'fast' }),
    ).toThrow(`Unsupported ${REVIEW_TEST_PROFILE_ENV} value: fast`);
  });

  it('selects full and review profiles through Vitest modes', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(rootDir, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.test).toContain('vitest run --mode full');
    expect(packageJson.scripts['test:coverage']).toContain(
      'vitest run --mode full',
    );
    expect(packageJson.scripts['test:watch']).toContain(
      'vitest --watch --mode watch',
    );
    expect(packageJson.scripts['test:review']).toContain(
      'vitest run --mode review',
    );

    const vitestConfig = readFileSync(
      resolve(rootDir, 'vitest.config.ts'),
      'utf8',
    );
    expect(vitestConfig).toContain(
      "const reviewTestProfile = mode === 'review';",
    );
    expect(vitestConfig).toContain(
      "process.env.OPENAI_AGENTS_TEST_PROFILE = 'review';",
    );
    expect(vitestConfig).toContain(
      "process.env.OPENAI_AGENTS_TEST_PROFILE = 'full';",
    );
  });
});
