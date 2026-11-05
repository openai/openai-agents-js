import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';

test('native reuse requires unchanged inputs and the exact bytes authorized by the PR base', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agents-native-pin-'));
  onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  const output = join(temp, 'output');
  const native = join(repo, 'packages/agents/native');
  mkdirSync(native, { recursive: true });
  mkdirSync(join(repo, '.github'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  function commit(message) {
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      message,
    );
    return git('rev-parse', 'HEAD');
  }
  function restore(base, status = 200) {
    writeFileSync(output, '');
    // Run the real CLI with a controlled artifact response.
    const mock =
      'globalThis.fetch = async () => new Response("wrong bytes", {status: ' +
      status +
      '})';
    const cli = fileURLToPath(
      new URL('./restore-native-bundle.mjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      ['--import', 'data:text/javascript,' + encodeURIComponent(mock), cli],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PIN_REF: base,
          GH_TOKEN: 'fixture',
          GITHUB_OUTPUT: output,
        },
      },
    );
    return {
      status: result.status,
      error: result.stderr,
      output: readFileSync(output, 'utf8'),
    };
  }

  git('init', '-q');
  writeFileSync(join(native, 'lib.rs'), '// first input\n');
  const cold = restore(commit('native source'));
  expect(cold.output).toContain('restored=false');
  const inputs = /^inputs=([a-f0-9]{64})$/m.exec(cold.output)[1];
  const platform = process.platform + '-' + process.arch;
  const asset = { id: 1, sha256: '0'.repeat(64) };
  const pin = join(repo, '.github/native-bundle.json');
  writeFileSync(
    pin,
    JSON.stringify({ inputs, platforms: { [platform]: asset } }),
  );
  const base = commit('accepted pin');
  writeFileSync(join(repo, 'sdk.js'), 'export default 1;\n');
  commit('SDK only');
  // The event base can be outside a shallow checkout of the merge commit.
  const missingBase = restore('f'.repeat(40));
  expect(missingBase.status).toBe(0);
  expect(missingBase.output).toContain('restored=false');
  const corrupt = restore(base);
  expect(corrupt.status).toBe(1);
  expect(corrupt.error).toContain('Native bundle checksum mismatch');
  expect(restore(base, 410).output).toContain('restored=false');

  writeFileSync(
    pin,
    JSON.stringify({ inputs, platforms: { [platform]: { ...asset, id: 2 } } }),
  );
  commit('proposed pin');
  expect(restore(base).output).toContain('restored=false');
  git('checkout', base, '--', '.github/native-bundle.json');
  writeFileSync(join(native, 'new.rs'), '// new compiler input\n');
  commit('additional native source');
  expect(restore(base).output).toContain('restored=false');
});
