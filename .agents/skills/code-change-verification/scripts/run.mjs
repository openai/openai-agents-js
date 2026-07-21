#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runPnpm(repoRoot, label, args) {
  console.log(`Running pnpm ${args.join(' ')}...`);
  const result = spawnSync(getPnpmCommand(), args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`code-change-verification: ${label} failed to start.`);
    console.error(result.error);
    return 1;
  }
  if (typeof result.status === 'number') {
    if (result.status !== 0) {
      console.error(
        `code-change-verification: ${label} failed with exit code ${result.status}.`,
      );
    }
    return result.status;
  }

  console.error(
    `code-change-verification: ${label} terminated by ${result.signal ?? 'an unknown signal'}.`,
  );
  return 1;
}

function runVerification() {
  const repoRoot = getRepoRoot();
  const installExitCode = runPnpm(repoRoot, 'install', [
    'i',
    '--frozen-lockfile',
  ]);
  if (installExitCode !== 0) {
    return installExitCode;
  }

  const buildExitCode = runPnpm(repoRoot, 'build', ['build']);
  if (buildExitCode !== 0) {
    return buildExitCode;
  }

  const validationExitCode = runPnpm(repoRoot, 'validation', [
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

process.exit(runVerification());
