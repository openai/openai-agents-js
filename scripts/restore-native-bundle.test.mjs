import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
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
import { isProducer, verifyUpload } from './verified-native-bundle.mjs';

const repository = { full_name: 'openai/openai-agents-js' };
const producer = {
  id: 1,
  status: 'completed',
  conclusion: 'success',
  repository,
  head_repository: repository,
  event: 'push',
  workflow_id: 1,
  path: '.github/workflows/alpha-release-artifacts.yml',
  head_branch: 'feat/codex-harness',
  head_sha: 'a'.repeat(40),
};
const jobName =
  'Package and test (' + process.platform + '-' + process.arch + ')';
const step = 'Upload the native bundle';

function uploadLog(asset) {
  const prefix = jobName + '\t' + step + '\t2026-01-01T00:00:00Z ';
  return (
    prefix +
    'Artifact ' +
    asset.name +
    ' successfully finalized. Artifact ID ' +
    asset.id +
    '\n' +
    prefix +
    'SHA256 digest of uploaded artifact is ' +
    asset.digest.slice(7)
  );
}

test('only successful direct Alpha producers in approved branches are eligible', () => {
  expect(isProducer(producer, 1)).toBe(true);
  expect(
    isProducer({ ...producer, head_branch: 'ci/native-bundle/test' }, 1),
  ).toBe(true);
  for (const change of [
    { path: '.github/workflows/caller.yml' },
    { workflow_id: 2 },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_branch: 'other' },
    { head_repository: { full_name: 'fork/openai-agents-js' } },
  ])
    expect(isProducer({ ...producer, ...change }, 1)).toBe(false);
});

test('artifact ID and digest must both come from the owning upload step', () => {
  const asset = {
    name: 'bundle.tar.gz',
    id: 12,
    digest: 'sha256:' + 'a'.repeat(64),
  };
  const log = uploadLog(asset);
  expect(verifyUpload(jobName, asset, log)).toEqual({
    id: 12,
    sha256: 'a'.repeat(64),
  });
  for (const forged of [
    log.replaceAll(step, 'Other step'),
    log.replaceAll(jobName, 'Other job'),
    log.replace('ID 12', 'ID 13'),
    log.replace(
      'digest of uploaded artifact is ' + 'a'.repeat(64),
      'digest of uploaded artifact is ' + 'b'.repeat(64),
    ),
  ])
    expect(() => verifyUpload(jobName, asset, forged)).toThrow();
});

// Exercise the real CLI and Git comparison; replace only GitHub transport.
test('automatic reuse survives SDK changes, skips untrusted producers and fails on corrupt eligible bundles', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agents-native-reuse-'));
  onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  const output = join(temp, 'output');
  const summary = join(temp, 'summary');
  const native = join(repo, 'packages/agents-codex/native');
  mkdirSync(native, { recursive: true });
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
  function restore(options = {}) {
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const fixture = {
      assets: options.assets ?? [],
      run: options.run ?? producer,
      runs: options.runs ?? {},
      jobs: options.jobs ?? [],
      jobsByRun: options.jobsByRun ?? {},
      log: options.log ?? '',
      bytes:
        options.bytes?.toString('base64') ??
        Buffer.from('wrong bytes').toString('base64'),
      status: options.status ?? 200,
    };
    const mock = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const fixture = ${JSON.stringify(fixture)};
      const original = cp.execFileSync;
      cp.execFileSync = (command, args, options) => {
        if (command !== 'gh') return original(command, args, options);
        if (args[0] === 'run') return fixture.log;
        const endpoint = args.at(-1);
        if (endpoint.includes('/actions/workflows/')) return JSON.stringify({id: 1});
        if (endpoint.includes('/actions/artifacts?')) {
          const name = new URL('https://github.invalid/' + endpoint).searchParams.get('name');
          return JSON.stringify([{artifacts: fixture.assets.filter(asset => asset.name === name)}]);
        }
        if (endpoint.includes('/jobs?')) return JSON.stringify([{jobs: fixture.jobsByRun[endpoint.split('/').at(-2)] ?? fixture.jobs}]);
        if (endpoint.includes('/actions/runs/')) return JSON.stringify(fixture.runs[endpoint.split('/').at(-1)] ?? fixture.run);
        throw new Error('Unexpected endpoint: ' + endpoint);
      };
      syncBuiltinESMExports();
      globalThis.fetch = async () => new Response(Buffer.from(fixture.bytes, 'base64'), {status: fixture.status});
    `;
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
          GH_TOKEN: 'fixture',
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    return {
      status: result.status,
      error: result.stderr,
      log: result.stdout,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
    };
  }
  git('init', '-q');
  writeFileSync(join(native, 'lib.rs'), '// first input\n');
  const source = commit('native source');
  const cold = restore();
  expect(cold.status).toBe(0);
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
    name: 'native-' + inputs + '-' + platform + '.tar.gz',
    id: 12,
    expired: false,
    workflow_run: { id: 1 },
    digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'),
  };
  const qualified = {
    assets: [asset],
    run: { ...producer, head_sha: source },
    jobs: [
      {
        id: 2,
        run_id: 1,
        run_attempt: 1,
        name: jobName,
        conclusion: 'success',
        steps: [{ name: step, conclusion: 'success' }],
      },
    ],
    log: uploadLog(asset),
    bytes: archive,
  };
  writeFileSync(join(repo, 'sdk.js'), 'export default 1;\n');
  commit('SDK only');
  const restored = restore(qualified);
  expect(restored.status, restored.error).toBe(0);
  expect(restored.output).toContain('restored=true');
  expect(restored.summary).toContain(
    'Restored verified native artifact 12 from run 1',
  );
  expect(restored.summary).toContain(inputs);
  // An identically named PR artifact must not hide a valid trusted producer.
  expect(
    restore({
      ...qualified,
      assets: [{ ...asset, id: 99, workflow_run: { id: 3 } }, asset],
      runs: { 3: { ...qualified.run, event: 'pull_request' } },
    }).output,
  ).toContain('restored=true');
  // A retained cold artifact becomes ineligible after its producer has a warm rerun.
  const retained = { ...asset, id: 99, workflow_run: { id: 3 } };
  const warmRerun = {
    ...qualified,
    runs: { 3: { ...qualified.run, id: 3 } },
    jobsByRun: {
      3: [
        { ...qualified.jobs[0], run_id: 3 },
        {
          ...qualified.jobs[0],
          run_id: 3,
          run_attempt: 2,
          steps: [{ name: step, conclusion: 'skipped' }],
        },
      ],
    },
  };
  expect(restore({ ...warmRerun, assets: [retained, asset] }).output).toContain(
    'restored=true',
  );
  const noDonor = restore({ ...warmRerun, assets: [retained] });
  expect(noDonor.status).toBe(0);
  expect(noDonor.output).toContain('restored=false');
  expect(
    restore({
      ...qualified,
      run: {
        ...qualified.run,
        head_sha: git('rev-parse', 'HEAD'),
        head_branch: 'ci/native-bundle/test',
      },
    }).output,
  ).toContain('restored=true');
  for (const product of products)
    expect(
      readFileSync(join(repo, 'packages/agents-codex', product), 'utf8'),
    ).toBe(product + '\n');
  const corrupt = restore({ ...qualified, bytes: Buffer.from('corrupt') });
  expect(corrupt.status).toBe(1);
  expect(corrupt.error).toContain('Native bundle checksum mismatch');
  const replaced = restore({
    ...qualified,
    log: uploadLog({ ...asset, id: 13 }),
  });
  expect(replaced.status).toBe(1);
  expect(replaced.error).toContain('Artifact ID must come from');
  expect(restore({ ...qualified, status: 410 }).output).toContain(
    'restored=false',
  );
  expect(
    restore({ ...qualified, assets: [{ ...asset, expired: true }] }).output,
  ).toContain('restored=false');
  for (const change of [
    { event: 'pull_request' },
    { status: 'in_progress' },
    { head_branch: 'ci/native-bundle/test' },
  ]) {
    expect(
      restore({ ...qualified, run: { ...qualified.run, ...change } }).output,
    ).toContain('restored=false');
  }
  // A rerun may start between reading the successful run and listing its jobs.
  const racing = {
    ...warmRerun,
    jobsByRun: {
      3: [
        { ...qualified.jobs[0], run_id: 3 },
        {
          ...qualified.jobs[0],
          run_id: 3,
          run_attempt: 2,
          conclusion: null,
          steps: [],
        },
      ],
    },
  };
  expect(restore({ ...racing, assets: [retained, asset] }).output).toContain(
    'restored=true',
  );
  const racingMiss = restore({ ...racing, assets: [retained] });
  expect(racingMiss.status).toBe(0);
  expect(racingMiss.output).toContain('restored=false');
  const failedLatest = restore({
    ...qualified,
    jobs: [
      ...qualified.jobs,
      { ...qualified.jobs[0], run_attempt: 2, conclusion: 'failure' },
    ],
  });
  expect(failedLatest.status).toBe(0);
  expect(failedLatest.output).toContain('restored=false');
  // Newly tracked native inputs force a miss without accepting a nearby bundle.
  writeFileSync(join(native, 'new.rs'), 'new native source\n');
  commit('native change');
  expect(restore(qualified).output).toContain('restored=false');
  mkdirSync(join(repo, '.cargo'));
  writeFileSync(
    join(repo, '.cargo/config.toml'),
    '[build]\nrustc-wrapper = "wrapper"\n',
  );
  writeFileSync(join(repo, 'wrapper'), 'first compiler wrapper\n');
  const configured = restore({
    ...qualified,
    run: { ...qualified.run, head_sha: commit('configure wrapper') },
  }).output;
  writeFileSync(join(repo, 'wrapper'), 'replacement compiler wrapper\n');
  const changed = restore({
    ...qualified,
    run: { ...qualified.run, head_sha: commit('change wrapper') },
  }).output;
  expect(/^inputs=(.+)$/m.exec(changed)[1]).not.toBe(
    /^inputs=(.+)$/m.exec(configured)[1],
  );
}, 30_000);
