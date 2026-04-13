import { parseStatusPaths } from './gitState.mjs';

export const MAX_LINT_FIX_FILES = 20;

const LINT_FIX_SCOPE_PREFIXES = [
  'packages/',
  'examples/',
  'integration-tests/',
  'helpers/',
  'scripts/',
];
const LINT_FIX_SCOPE_ROOT_FILES = new Set([
  'eslint.config.mjs',
  'vitest.config.ts',
  'vitest.integration.config.ts',
]);
const LINTABLE_SUFFIXES = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts'];

function matchesLintFixScope(filePath) {
  if (LINT_FIX_SCOPE_ROOT_FILES.has(filePath)) {
    return true;
  }

  return (
    LINT_FIX_SCOPE_PREFIXES.some((prefix) => filePath.startsWith(prefix)) &&
    LINTABLE_SUFFIXES.some((suffix) => filePath.endsWith(suffix))
  );
}

export function lintFixPaths(cwd) {
  return parseStatusPaths(cwd).filter(matchesLintFixScope).sort();
}
