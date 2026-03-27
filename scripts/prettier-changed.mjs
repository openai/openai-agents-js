import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repoRoot);

const TARGET_PREFIXES = ['packages/', 'examples/', 'integration-tests/'];

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
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...TARGET_PREFIXES.map((prefix) => prefix.slice(0, -1)),
  ]),
]);

const filesToFormat = [...changedFiles].filter(isTargetTsFile).sort();

if (filesToFormat.length === 0) {
  console.log('No changed TypeScript files to format.');
  process.exit(0);
}

const prettier = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'prettier', '--write', ...filesToFormat],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);

if (prettier.error) {
  throw prettier.error;
}

process.exit(prettier.status ?? 1);
