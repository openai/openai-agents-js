#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { console } = globalThis;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const skillsRoot = path.join(repoRoot, '.agents/skills');

const pythonSuites = [
  ['implementation-kickoff', 'test_validate_handoff.py'],
  ['implementation-final-review', 'test_prepare_review_round.py'],
  ['implementation-final-review', 'test_review_state.py'],
  ['implementation-final-review', 'test_review_protocol.py'],
].map(([skill, file]) => ({
  name: `${skill}/${file}`,
  command: 'python3',
  args: ['-m', 'unittest', '-v', file],
  cwd: path.join(skillsRoot, skill, 'scripts'),
}));

const suites = [
  ...pythonSuites,
  {
    name: 'sensitive-logging-audit/inventory-logging.test.mjs',
    command: process.execPath,
    args: [
      '--test',
      path.join(
        skillsRoot,
        'sensitive-logging-audit/scripts/inventory-logging.test.mjs',
      ),
    ],
    cwd: repoRoot,
  },
  {
    name: 'runner and offline changeset fixtures',
    command: process.execPath,
    args: [
      '--test',
      path.join(repoRoot, 'scripts/tests/run-repo-skill-tests.test.mjs'),
    ],
    cwd: repoRoot,
  },
];

// Keep credentials, runtime preload options, and user Git configuration out of children.
function childEnvironment(temporaryRoot) {
  const env = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'PATHEXT',
    'LD_LIBRARY_PATH',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    LANG: 'C',
    LC_ALL: 'C',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: temporaryRoot,
    GIT_CONFIG_KEY_1: 'commit.gpgSign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
  };
}

// Export only the execution boundary so tests can exercise real failing children.
export function runSuites(selectedSuites) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'repo-skill-tests-'));
  try {
    const env = childEnvironment(temporaryRoot);
    for (const suite of selectedSuites) {
      console.log(`\n=== ${suite.name} ===`);
      const result = spawnSync(suite.command, suite.args, {
        cwd: suite.cwd,
        env,
        stdio: 'inherit',
      });
      if (result.error || result.status !== 0) {
        const reason =
          result.error?.message ??
          (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
        console.error(`FAIL: ${suite.name} (${reason})`);
        return 1;
      }
      console.log(`PASS: ${suite.name}`);
    }
    console.log(
      `\nAll ${selectedSuites.length} repository skill suites passed.`,
    );
    return 0;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runSuites(suites);
}
