import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { verifyProducer, verifyUpload } from './pin-native-bundle.mjs';

test('a successful caller with Alpha job names cannot mint a native pin', () => {
  const repository = { full_name: 'openai/openai-agents-js' };
  const run = {
    conclusion: 'success',
    repository,
    head_repository: repository,
    event: 'push',
    workflow_id: 1,
    path: '.github/workflows/alpha-release-artifacts.yml',
    head_branch: 'ci/native-bundle/test',
    head_sha: 'a'.repeat(40),
  };
  expect(() => verifyProducer(run, 1)).not.toThrow();
  for (const change of [
    { path: '.github/workflows/caller.yml' },
    { workflow_id: 2 },
    { event: 'pull_request' },
    { head_branch: 'other' },
    { head_repository: { full_name: 'fork/openai-agents-js' } },
  ])
    expect(() => verifyProducer({ ...run, ...change }, 1)).toThrow();
});

test('the selected artifact ID and digest must both come from the platform upload step', () => {
  const job = 'Package and test (linux-x64)';
  const step = 'Upload the native bundle for pinning';
  const sha256 = 'a'.repeat(64);
  const asset = { name: 'bundle.tar.gz', id: 12, digest: 'sha256:' + sha256 };
  const prefix = job + '\t' + step + '\t2026-01-01T00:00:00Z ';
  const finalized =
    prefix + 'Artifact bundle.tar.gz successfully finalized. Artifact ID 12';
  const checksum = prefix + 'SHA256 digest of uploaded artifact is ' + sha256;
  expect(verifyUpload(job, asset, finalized + '\n' + checksum)).toEqual({
    id: 12,
    sha256,
  });
  for (const forged of [
    finalized.replace(step, 'Other step'),
    finalized.replace(job, 'Other job'),
    finalized.replace('ID 12', 'ID 13'),
  ])
    expect(() => verifyUpload(job, asset, forged + '\n' + checksum)).toThrow();
  expect(() =>
    verifyUpload(
      job,
      asset,
      finalized + '\n' + checksum.replace(sha256, 'b'.repeat(64)),
    ),
  ).toThrow();
});

// Allow time for Git, Node, and tar subprocesses in parallel CI runs.
test('native reuse requires unchanged inputs and the exact bytes authorized by the PR base', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agents-native-pin-'));
  onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  const output = join(temp, 'output');
  const native = join(repo, 'packages/agents-codex/native');
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
  function restore(base, status = 200, bytes) {
    writeFileSync(output, '');
    // Run the real CLI with a controlled artifact response.
    const mock =
      'globalThis.fetch = async () => new Response(' +
      (bytes
        ? 'Buffer.from(' +
          JSON.stringify(bytes.toString('base64')) +
          ', "base64")'
        : '"wrong bytes"') +
      ', {status: ' +
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
  const bundle = join(temp, 'bundle');
  const products = [
    'native/codex.node',
    'native/build-receipt.json',
    'bin/helper',
  ];
  if (platform === 'darwin-arm64')
    products.push('native/test-bin/exec-server-fixture');
  for (const product of products) {
    mkdirSync(dirname(join(bundle, product)), { recursive: true });
    writeFileSync(join(bundle, product), product + '\n');
  }
  const archive = execFileSync(
    'tar',
    ['-czf', '-', '-C', bundle, 'native', 'bin'],
    { stdio: 'pipe' },
  );
  const asset = {
    id: 1,
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
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
  const restored = restore(base, 200, archive);
  expect(restored.status).toBe(0);
  expect(restored.output).toContain('restored=true');
  for (const product of products)
    expect(
      readFileSync(join(repo, 'packages/agents-codex', product), 'utf8'),
    ).toBe(product + '\n');

  writeFileSync(
    pin,
    JSON.stringify({ inputs, platforms: { [platform]: { ...asset, id: 2 } } }),
  );
  commit('proposed pin');
  expect(restore(base).output).toContain('restored=false');
  git('checkout', base, '--', '.github/native-bundle.json');
  for (const path of [
    'packages/agents-codex/native/new.rs',
    'Cargo.toml',
    'packages/agents-codex/bin/extra',
  ]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), 'new tracked build input\n');
    commit('additional build input');
    expect(restore(base).output).toContain('restored=false');
    git('rm', '-q', path);
  }
  mkdirSync(join(repo, '.cargo'));
  writeFileSync(
    join(repo, '.cargo/config.toml'),
    '[build]\nrustc-wrapper = "wrapper"\n',
  );
  writeFileSync(join(repo, 'wrapper'), 'first compiler wrapper\n');
  const configured = restore(commit('configure a compiler wrapper')).output;
  writeFileSync(join(repo, 'wrapper'), 'replacement compiler wrapper\n');
  const changed = restore(commit('change the external wrapper')).output;
  expect(/^inputs=(.+)$/m.exec(changed)[1]).not.toBe(
    /^inputs=(.+)$/m.exec(configured)[1],
  );
}, 30_000);
