import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const REVIEW_TEST_PROFILE_ENV = 'OPENAI_AGENTS_TEST_PROFILE';

export const reviewOptionalTestFiles = [
  'helpers/tests/consoleGuard.test.ts',
  'packages/agents-core/test/sandboxes/docker.test.ts',
  'packages/agents-core/test/sandboxes/unixLocal.git.test.ts',
  'packages/agents-core/test/sandboxes/unixLocal.process.test.ts',
  'packages/agents-core/test/sandboxes/unixLocal.signals.test.ts',
] as const;

export function isReviewTestProfile(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const profile = environment[REVIEW_TEST_PROFILE_ENV];
  if (profile === undefined) {
    return false;
  }
  if (profile === 'full') {
    return false;
  }
  if (profile === 'review') {
    return true;
  }
  throw new Error(
    `Unsupported ${REVIEW_TEST_PROFILE_ENV} value: ${profile}. Expected "full", "review", or an unset variable.`,
  );
}

export function reviewOptionalFilesForRoot(
  repositoryRoot: string,
  projectRoot: string,
): string[] {
  const relativeProjectRoot = relative(repositoryRoot, projectRoot);
  const prefix = relativeProjectRoot
    ? `${relativeProjectRoot.split(sep).join('/')}/`
    : '';

  return reviewOptionalTestFiles
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length));
}

export function assertReviewOptionalFilesExist(repositoryRoot: string): void {
  for (const file of reviewOptionalTestFiles) {
    if (!existsSync(resolve(repositoryRoot, file))) {
      throw new Error(`Review-optional test file does not exist: ${file}`);
    }
  }
}
