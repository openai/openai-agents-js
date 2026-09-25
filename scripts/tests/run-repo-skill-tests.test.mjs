import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const runnerUrl = new URL('../run-repo-skill-tests.mjs', import.meta.url).href;
const validatorPath = fileURLToPath(
  new URL(
    '../../.agents/skills/changeset-validation/scripts/changeset-validation-result.mjs',
    import.meta.url,
  ),
);

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'repo-skill-runner-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runSelected(suites, env = {}) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runSuites } from ${JSON.stringify(runnerUrl)};
    process.exitCode = runSuites(${JSON.stringify(suites)});
  `,
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    },
  );
}

function nodeSuite(name, code) {
  return {
    name,
    command: process.execPath,
    args: ['--input-type=module', '-e', code],
  };
}

test('runs children in order with isolated credentials, local Git, and cleanup', (t) => {
  const directory = fixture(t);
  const resultFile = path.join(directory, 'child.json');
  const laterFile = path.join(directory, 'later');
  const result = runSelected(
    [
      nodeSuite(
        'environment probe',
        `
      import { writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      const git = spawnSync('git', ['ls-remote', 'https://example.invalid/repo'], { encoding: 'utf8' });
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ env: process.env, gitStatus: git.status, gitError: git.stderr }));
    `,
      ),
      nodeSuite(
        'later suite',
        `
      import { existsSync, writeFileSync } from 'node:fs';
      if (!existsSync(${JSON.stringify(resultFile)})) process.exit(2);
      writeFileSync(${JSON.stringify(laterFile)}, 'ran');
    `,
      ),
    ],
    {
      OPENAI_API_KEY: 'synthetic-test-value',
      OPENAI_ADMIN_KEY: 'synthetic-test-value',
      GITHUB_TOKEN: 'synthetic-test-value',
      GH_TOKEN: 'synthetic-test-value',
      GH_ENTERPRISE_TOKEN: 'synthetic-test-value',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.allow',
      GIT_CONFIG_VALUE_0: 'always',
      PYTHONPATH: directory,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(readFileSync(resultFile, 'utf8'));
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_ADMIN_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'PYTHONPATH',
  ]) {
    assert.equal(child.env[name], undefined, name);
  }
  assert.equal(child.gitStatus, 128);
  assert.match(child.gitError, /transport 'https' not allowed/);
  assert.equal(child.env.HOME, child.env.TMPDIR);
  assert.equal(existsSync(child.env.TMPDIR), false);
  assert.equal(existsSync(laterFile), true);
  assert.match(result.stdout, /PASS: environment probe/);
  assert.match(result.stdout, /All 2 repository skill suites passed/);
});

test('propagates a failing child and cleans up without running later suites', (t) => {
  const directory = fixture(t);
  const temporaryPathFile = path.join(directory, 'temporary-path');
  const laterFile = path.join(directory, 'later');
  const result = runSelected([
    nodeSuite(
      'controlled failure',
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(temporaryPathFile)}, process.env.TMPDIR);
      writeFileSync(process.env.TMPDIR + '/partial-output', 'partial');
      process.exit(23);
    `,
    ),
    nodeSuite(
      'must not run',
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(laterFile)}, 'unexpected');
    `,
    ),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL: controlled failure \(exit 23\)/);
  assert.equal(existsSync(readFileSync(temporaryPathFile, 'utf8')), false);
  assert.equal(existsSync(laterFile), false);
  assert.doesNotMatch(result.stdout, /All .* passed/);
});

test('fails when a child cannot start', (t) => {
  const result = runSelected([
    {
      name: 'missing interpreter',
      command: path.join(fixture(t), 'missing'),
      args: [],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL: missing interpreter .*ENOENT/);
});

test(
  'fails when a child terminates from a signal',
  { skip: process.platform === 'win32' },
  () => {
    const result = runSelected([
      nodeSuite('signaled child', "process.kill(process.pid, 'SIGTERM');"),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL: signaled child \(signal SIGTERM\)/);
  },
);

// Reuse the three pure result-validator fixtures; never invoke milestone assignment.
for (const [name, verdict, expectedStatus, expectedOutput] of [
  [
    'valid JSON passes',
    { ok: true, errors: [], warnings: [], required_bump: 'none' },
    0,
    /changeset-validation passed/,
  ],
  [
    'invalid verdict fails',
    {
      ok: false,
      errors: ['Missing changeset.'],
      warnings: [],
      required_bump: 'patch',
    },
    1,
    /Missing changeset/,
  ],
  ['schema errors fail', { ok: true }, 1, /Missing errors array/],
]) {
  test(`changeset fixture: ${name}`, (t) => {
    const file = path.join(fixture(t), 'verdict.json');
    writeFileSync(file, JSON.stringify(verdict));
    const result = spawnSync(process.execPath, [validatorPath, file], {
      encoding: 'utf8',
      env: {},
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.match(result.stdout + result.stderr, expectedOutput);
  });
}
