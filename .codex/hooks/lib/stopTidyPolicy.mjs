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
const CLOSEOUT_PATTERNS = [
  /\bdone\b/,
  /\bcompleted\b/,
  /\bready\b/,
  /\bfinal\b/,
  /\bverified\b/,
  /\bverification\b/,
  /\btests?\s+passed\b/,
  /\blint\s+passed\b/,
  /\bbuild\s+passed\b/,
  /\bwrap(?:ping)?\s+up\b/,
];

function matchesLintFixScope(filePath) {
  if (LINT_FIX_SCOPE_ROOT_FILES.has(filePath)) {
    return true;
  }

  return (
    LINT_FIX_SCOPE_PREFIXES.some((prefix) => filePath.startsWith(prefix)) &&
    LINTABLE_SUFFIXES.some((suffix) => filePath.endsWith(suffix))
  );
}

export function shouldEnforce(lastAssistantMessage) {
  if (!lastAssistantMessage) {
    return false;
  }

  const lowered = lastAssistantMessage.toLowerCase();
  return CLOSEOUT_PATTERNS.some((pattern) => pattern.test(lowered));
}

export function lintFixPaths(cwd) {
  return parseStatusPaths(cwd).filter(matchesLintFixScope).sort();
}
