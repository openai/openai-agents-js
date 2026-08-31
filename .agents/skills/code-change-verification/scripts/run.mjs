#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBootstrapInstall } from '../../../../scripts/pnpm-bootstrap.mjs';

const { console, process } = globalThis;
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

const VALIDATION_NAMES = [
  'build-check',
  'dist-check',
  'lint',
  'test',
  'format-check',
];
const VALIDATION_COMMANDS = [
  'pnpm -r build-check',
  'pnpm -r -F "@openai/*" dist:check',
  'pnpm lint',
  'pnpm test',
  'pnpm format:check:changed',
];

function printUsage() {
  console.log(`code-change-verification

Usage:
  node .agents/skills/code-change-verification/scripts/run.mjs
`);
}

function getRepoRoot() {
  try {
    return execFileSync(
      'git',
      ['-C', scriptDir, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return path.resolve(scriptDir, '../../../..');
  }
}

function reportExit(label, { exitCode, signal, spawnError }) {
  if (spawnError) {
    console.error(`code-change-verification: ${label} failed to start.`);
    console.error(spawnError);
    return 1;
  }
  if (typeof exitCode === 'number') {
    if (exitCode !== 0) {
      console.error(
        `code-change-verification: ${label} failed with exit code ${exitCode}.`,
      );
    }
    return exitCode;
  }

  console.error(
    `code-change-verification: ${label} terminated by ${signal ?? 'an unknown signal'}.`,
  );
  return 1;
}

function installDependencies(repoRoot) {
  console.log('Running pnpm i --frozen-lockfile...');
  const result = runBootstrapInstall({
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  return reportExit('install', {
    exitCode: result.status,
    signal: result.signal,
    spawnError: result.error,
  });
}

// Execa resolves the Windows pnpm shim and quotes arguments itself, so nothing here
// has to build a command line. It is imported only after install, once it exists.
function runPnpm(execaSync, repoRoot, label, args) {
  console.log(`Running pnpm ${args.join(' ')}...`);
  const result = execaSync('pnpm', args, {
    cwd: repoRoot,
    env: process.env,
    extendEnv: false,
    stdio: 'inherit',
    reject: false,
  });

  return reportExit(label, {
    exitCode: result.isTerminated ? undefined : result.exitCode,
    signal: result.signal,
  });
}

async function runVerification() {
  const repoRoot = getRepoRoot();
  const installExitCode = installDependencies(repoRoot);
  if (installExitCode !== 0) {
    return installExitCode;
  }

  const { execaSync } = await import('execa');

  const buildExitCode = runPnpm(execaSync, repoRoot, 'build', ['build']);
  if (buildExitCode !== 0) {
    return buildExitCode;
  }

  const validationExitCode = runPnpm(execaSync, repoRoot, 'validation', [
    'exec',
    'concurrently',
    '--kill-others-on-fail',
    '--kill-timeout',
    '5000',
    '--names',
    VALIDATION_NAMES.join(','),
    ...VALIDATION_COMMANDS,
  ]);
  if (validationExitCode !== 0) {
    return validationExitCode;
  }

  console.log('code-change-verification: all commands passed.');
  return 0;
}

if (process.argv.includes('--help')) {
  printUsage();
  process.exit(0);
}

process.exit(await runVerification());
