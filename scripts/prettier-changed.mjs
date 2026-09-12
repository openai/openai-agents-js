import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { execaSync } from 'execa';
import { execaRunOutcome } from './pnpm-bootstrap.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repoRoot);

const TARGET_PREFIXES = ['packages/', 'examples/', 'integration-tests/'];
const checkOnly = process.argv.includes('--check');

function readGitLines(args) {
  const output = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isTargetTsFile(filePath) {
  return (
    filePath.endsWith('.ts') &&
    TARGET_PREFIXES.some((prefix) => filePath.startsWith(prefix))
  );
}

const changedFiles = new Set([
  ...readGitLines([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    '--',
    ...TARGET_PREFIXES.map((prefix) => prefix.slice(0, -1)),
  ]),
  ...readGitLines([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR',
    '--',
    ...TARGET_PREFIXES.map((prefix) => prefix.slice(0, -1)),
  ]),
  ...readGitLines([
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...TARGET_PREFIXES.map((prefix) => prefix.slice(0, -1)),
  ]),
]);

const filesToFormat = [...changedFiles].filter(isTargetTsFile).sort();

if (filesToFormat.length === 0) {
  console.log(
    `No changed TypeScript files to ${checkOnly ? 'check' : 'format'}.`,
  );
  process.exit(0);
}

// Execa resolves the Windows pnpm shim and quotes these file names itself, so names
// containing spaces, ampersands or percent signs reach Prettier unchanged.
const prettier = execaSync(
  'pnpm',
  ['exec', 'prettier', checkOnly ? '--check' : '--write', ...filesToFormat],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    reject: false,
  },
);

const outcome = execaRunOutcome(prettier);

if (outcome.spawnError) {
  throw new Error(`Prettier failed to start: ${outcome.spawnError}`);
}
if (outcome.exitCode === undefined) {
  throw new Error(`Prettier terminated by ${outcome.signal ?? 'a signal'}.`);
}

process.exit(outcome.exitCode);
