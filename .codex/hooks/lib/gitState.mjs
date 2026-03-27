import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runGit(cwd, ...args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
}

export function gitRoot(cwd) {
  const result = runGit(cwd, 'rev-parse', '--show-toplevel');
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'git root lookup failed');
  }
  return result.stdout.trim();
}

export function parseStatusPaths(cwd) {
  const unstaged = runGit(cwd, 'diff', '--name-only', '--diff-filter=ACMR');
  const untracked = runGit(cwd, 'ls-files', '--others', '--exclude-standard');
  if (unstaged.status !== 0 || untracked.status !== 0) {
    return [];
  }

  return [...unstaged.stdout.split('\n'), ...untracked.stdout.split('\n')]
    .map((line) => line.trim())
    .filter(Boolean);
}

function untrackedPaths(cwd, paths) {
  if (paths.length === 0) {
    return new Set();
  }

  const result = runGit(
    cwd,
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...paths,
  );
  if (result.status !== 0) {
    return new Set();
  }

  return new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export function fingerprintForPaths(cwd, paths) {
  if (paths.length === 0) {
    return null;
  }

  const repoRoot = gitRoot(cwd);
  const untracked = untrackedPaths(cwd, paths);
  const trackedPaths = paths.filter((filePath) => !untracked.has(filePath));
  const diffParts = [];

  if (trackedPaths.length > 0) {
    const diff = runGit(
      cwd,
      'diff',
      '--no-ext-diff',
      '--binary',
      '--',
      ...trackedPaths,
    );
    if (diff.status === 0) {
      diffParts.push(diff.stdout);
    }
  }

  for (const filePath of [...untracked].sort()) {
    try {
      const content = readFileSync(path.join(repoRoot, filePath));
      const digest = createHash('sha256').update(content).digest('hex');
      diffParts.push(`untracked:${filePath}:${digest}`);
    } catch {
      continue;
    }
  }

  if (diffParts.length === 0) {
    return null;
  }

  return createHash('sha256').update(diffParts.join('\n')).digest('hex');
}
