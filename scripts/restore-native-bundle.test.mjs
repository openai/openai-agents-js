import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
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
import {
  isProducer,
  publicationStep,
  nativePlatforms,
} from './verified-native-bundle.mjs';

const repository = { full_name: 'openai/openai-agents-js' };
const producer = {
  id: 1,
  run_attempt: 1,
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
const at = (second) =>
  '2026-01-01T00:00:' + String(second).padStart(2, '0') + 'Z';
function publicationJobs(platform, preflight = false, run = producer) {
  const key = Object.keys(nativePlatforms).find(
    (key) => nativePlatforms[key] === platform,
  );
  return [
    {
      id: 2 + Object.values(nativePlatforms).indexOf(platform) * 2,
      run_id: run.id,
      head_sha: run.head_sha,
      run_attempt: 1,
      conclusion: 'success',
      name: preflight
        ? 'Select native bundles'
        : 'produce-' + key + ' / Native bundle (' + platform + ')',
      steps: [
        {
          name: preflight
            ? 'Publish native bundle (' + platform + ')'
            : 'Publish native bundle',
          conclusion: 'success',
          number: 12,
          started_at: at(1),
          completed_at: at(3),
        },
      ],
    },
    {
      id: 3 + Object.values(nativePlatforms).indexOf(platform) * 2,
      run_id: run.id,
      head_sha: run.head_sha,
      run_attempt: 1,
      conclusion: 'success',
      name: 'Package and test (' + platform + ')',
      started_at: at(10),
      steps: [],
    },
  ];
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
    { repository: { full_name: 'fork/openai-agents-js' } },
    { head_repository: { full_name: 'fork/openai-agents-js' } },
  ])
    expect(isProducer({ ...producer, ...change }, 1)).toBe(false);
});

test('selects only the exact owner step before the first same-platform package', () => {
  const asset = { created_at: at(2) };
  for (const platform of Object.values(nativePlatforms)) {
    for (const preflight of [false, true]) {
      const [owner, packaged] = publicationJobs(platform, preflight);
      const otherPlatform = {
        ...packaged,
        name:
          platform === 'linux-x64'
            ? 'Package and test (linux-arm64)'
            : 'Package and test (linux-x64)',
        started_at: at(1),
      };
      const select = (jobs, run = producer) =>
        publicationStep(asset, run, jobs, platform);
      expect(select([owner, packaged, otherPlatform])).toEqual({
        job: owner.id,
        step: 12,
      });
      expect(
        select([owner, packaged, { ...otherPlatform, run_attempt: 2 }]),
      ).toBeUndefined();
      expect(
        select([owner, { ...packaged, started_at: at(2) }]),
      ).toBeUndefined();
      expect(select([owner, packaged, owner])).toBeUndefined();
      expect(
        select([{ ...owner, head_sha: 'wrong' }, packaged]),
      ).toBeUndefined();
      const retry = { ...producer, run_attempt: 2 };
      const rerun = { ...packaged, run_attempt: 2, started_at: at(20) };
      expect(select([owner, packaged, rerun], retry)).toEqual({
        job: owner.id,
        step: 12,
      });
      expect(
        select([owner, packaged, { ...rerun, conclusion: 'failure' }], retry),
      ).toBeUndefined();
      const lateOwner = {
        ...owner,
        run_attempt: 2,
        steps: [
          { ...owner.steps[0], started_at: at(11), completed_at: at(15) },
        ],
      };
      expect(
        publicationStep(
          { created_at: at(14) },
          retry,
          [owner, packaged, lateOwner, rerun],
          platform,
        ),
      ).toBeUndefined();
    }
  }
});

test('Hyper license bytes invalidate native inputs without Cargo fallback', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agents-native-license-'));
  onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
  const native = join(repo, 'packages/agents-codex/native');
  const license = join(repo, 'packages/agents-codex/licenses/hyper/LICENSE');
  mkdirSync(native, { recursive: true });
  mkdirSync(dirname(license), { recursive: true });
  writeFileSync(join(native, 'lib.rs'), '// unchanged native source\n');
  writeFileSync(license, 'first notice\n');
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = () => {
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
      'license input fixture',
    );
  };
  git('init', '-q');
  commit();
  const module = new URL('./native-bundle-inputs.mjs', import.meta.url).href;
  const snapshot = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { nativeInputs, nativeComparisonPaths } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify({
  hash: nativeInputs(), paths: nativeComparisonPaths()
}));`,
        ],
        { cwd: repo, encoding: 'utf8' },
      ),
    );
  const before = snapshot();
  expect(before.paths).not.toEqual(['.']);
  writeFileSync(license, 'replacement notice\n');
  commit();
  expect(git('diff', '--name-only', 'HEAD^', 'HEAD')).toBe(
    'packages/agents-codex/licenses/hyper/LICENSE',
  );
  const after = snapshot();
  expect(after.paths).toEqual(before.paths);
  expect(after.hash).not.toBe(before.hash);
});

// Run the real CLI, Git fingerprint and selective extraction; replace only transport.
test('preflight stages verified opaque archives and current-run transfers pin exact bytes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agents-native-reuse-'));
  onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  const output = join(temp, 'output');
  const summary = join(temp, 'summary');
  const requests = join(temp, 'requests');
  const native = join(repo, 'packages/agents-codex/native');
  mkdirSync(native, { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message) => {
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
  };
  function run(options = {}, transfer = false) {
    for (const file of [output, summary, requests]) writeFileSync(file, '');
    const fixture = {
      assets: options.assets ?? [],
      run: options.run ?? producer,
      runs: options.runs ?? {},
      jobs: options.jobs ?? [],
      jobsByRun: options.jobsByRun ?? {},
      publicationStatus: options.publicationStatus ?? 200,
      publicationLog: options.publicationLog,
      bytes:
        options.bytes?.toString('base64') ??
        Buffer.from('wrong bytes').toString('base64'),
      status: options.status ?? 200,
    };
    const mock = `
      import cp from 'node:child_process';
      import { appendFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const fixture = ${JSON.stringify(fixture)};
      if (${options.arm64 === true}) {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });
      }
      const original = cp.execFileSync;
      cp.execFileSync = (command, args, options) => {
        if (command !== 'gh') return original(command, args, options);
        appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + '\\n');
        const endpoint = args.at(-1);
        if (endpoint.includes('/actions/workflows/')) return JSON.stringify({id: 1});
        if (endpoint.includes('/actions/artifacts?')) {
          const params = new URL('https://github.invalid/' + endpoint).searchParams;
          return JSON.stringify({artifacts: fixture.assets.filter(a => a.name === params.get('name')).slice(0, Number(params.get('per_page')))});
        }
        if (endpoint.includes('/jobs?')) return JSON.stringify([{jobs: fixture.jobsByRun[endpoint.split('/').at(-2)] ?? fixture.jobs}]);
        if (endpoint.includes('/steps/12/logs')) {
          if (fixture.publicationStatus !== 200) {
            const error = new Error('publication log unavailable');
            error.stderr = 'gh: (HTTP ' + fixture.publicationStatus + ')';
            throw error;
          }
          if (fixture.publicationLog !== undefined) return fixture.publicationLog;
          const jobId = Number(endpoint.split('/').at(-4));
          const owner = fixture.jobs.find(job => job.id === jobId);
          const platform = owner.name.split('(').at(-1).replace(')', '');
          const artifact = fixture.assets.find(asset =>
              asset.workflow_run.id === owner.run_id && asset.name.endsWith('-' + platform + '.tar.gz'));
          if (!artifact) throw new Error('Unexpected uploader: ' + endpoint);
          return [
            '##[group]Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
            'SHA256 digest of uploaded artifact is ' + artifact.digest.slice(7),
            'Artifact ' + artifact.name + ' successfully finalized. Artifact ID ' + artifact.id,
            'Artifact download URL: https://github.com/openai/openai-agents-js/actions/runs/' + owner.run_id + '/artifacts/' + artifact.id,
          ].map(line=>'2026-01-01T00:00:02.0Z '+line).join('\\n');
        }
        if (endpoint.includes('/actions/runs/')) return JSON.stringify(fixture.runs[endpoint.split('/').at(-1)] ?? fixture.run);
        throw new Error('Unexpected endpoint: ' + endpoint);
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (url) => {
        appendFileSync(${JSON.stringify(requests)}, JSON.stringify(['download',url]) + '\\n');
        return new Response(Buffer.from(fixture.bytes,'base64'), {status: fixture.status});
      };
    `;
    const cli = fileURLToPath(
      new URL(
        transfer
          ? './restore-native-bundle.mjs'
          : './select-native-bundles.mjs',
        import.meta.url,
      ),
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
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          NATIVE_INPUTS: options.inputs ?? '',
          NATIVE_ARTIFACT: JSON.stringify(options.artifact ?? {}),
        },
      },
    );
    return {
      status: result.status,
      error: result.stderr,
      log: result.stdout,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      requests: readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s)),
    };
  }
  git('init', '-q');
  writeFileSync(join(native, 'lib.rs'), '// first input\n');
  const source = commit('native source');
  const cold = run();
  expect(cold.status, cold.error).toBe(0);
  const inputs = /^inputs_hash=([a-f0-9]{64})$/m.exec(cold.output)[1];
  for (const key of Object.keys(nativePlatforms))
    expect(cold.output).toContain(key + '_hit=false');
  const hostPlatform = process.platform + '-' + process.arch;
  const hostKey = Object.keys(nativePlatforms).find(
    (k) => nativePlatforms[k] === hostPlatform,
  );
  const key = hostKey ?? 'linux-arm64';
  const platform = nativePlatforms[key];
  const bundle = join(temp, 'bundle');
  const products = [
    'native/codex.node',
    'native/build-receipt.json',
    'bin/helper',
  ];
  const armFixture = 'native/test-bin/exec-server-fixture';
  const fixture = armFixture + (process.platform === 'win32' ? '.exe' : '');
  if (hostKey) products.push(fixture);
  for (const product of new Set([...products, armFixture])) {
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
    created_at: at(2),
    digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'),
    workflow_run: {
      id: 1,
      repository_id: 1,
      head_repository_id: 1,
      head_branch: 'feat/codex-harness',
    },
  };
  const qualified = {
    assets: [asset],
    run: { ...producer, head_sha: source },
    jobs: publicationJobs(platform, false, { ...producer, head_sha: source }),
    bytes: archive,
  };
  writeFileSync(join(repo, 'sdk.js'), 'export default 1;\n');
  commit('SDK only');
  const staged = run(qualified);
  expect(staged.status, staged.error).toBe(0);
  expect(staged.output).toContain(key + '_hit=true');
  expect(staged.summary).toContain('Verified native artifact 12 from run 1');
  expect(staged.summary).toContain(inputs);
  expect(
    staged.requests.filter((args) => args.at(-1).includes('/steps/12/logs')),
  ).toEqual([
    [
      'api',
      `repos/openai/openai-agents-js/actions/jobs/${qualified.jobs[0].id}/steps/12/logs`,
    ],
  ]);
  expect(run({ ...qualified, publicationStatus: 404 }).output).toContain(
    key + '_hit=false',
  );
  const recordedUpload = [
    '##[group]Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
    'SHA256 digest of uploaded artifact is ' + asset.digest.slice(7),
    'Artifact ' + asset.name + ' successfully finalized. Artifact ID 12',
    'Artifact download URL: https://github.com/openai/openai-agents-js/actions/runs/1/artifacts/12',
  ];
  const uploadLog = (lines) =>
    lines.map((line) => '2026-01-01T00:00:02.0Z ' + line).join('\n');
  for (const changedLines of [
    recordedUpload.map((line) =>
      line.replace('Artifact ID 12', 'Artifact ID 13'),
    ),
    recordedUpload.map((line) =>
      line.replace(asset.digest.slice(7), '0'.repeat(64)),
    ),
    [
      ...recordedUpload,
      'SHA256 digest of uploaded artifact is ' + '0'.repeat(64),
    ],
  ]) {
    const unverified = run({
      ...qualified,
      publicationLog: uploadLog(changedLines),
    });
    expect(unverified.output).toContain(key + '_hit=false');
    expect(unverified.requests.some((args) => args[0] === 'download')).toBe(
      false,
    );
  }
  const limited = run({ ...qualified, publicationStatus: 429 });
  expect(limited.status).toBe(1);
  expect(
    limited.requests.filter((args) => args.at(-1).includes('/steps/12/logs')),
  ).toHaveLength(1);
  expect(readFileSync(join(temp, asset.name))).toEqual(archive);
  expect(existsSync(join(native, 'codex.node'))).toBe(false);

  const allAssets = Object.values(nativePlatforms).map((p, i) => ({
    ...asset,
    id: 12 + i,
    name: 'native-' + inputs + '-' + p + '.tar.gz',
  }));
  const allJobs = Object.values(nativePlatforms).flatMap((p) =>
    publicationJobs(p, false, qualified.run),
  );
  const all = run({ ...qualified, assets: allAssets, jobs: allJobs });
  expect(all.status, all.error).toBe(0);
  for (const [k, p] of Object.entries(nativePlatforms)) {
    expect(all.output).toContain(k + '_hit=true');
    expect(
      readFileSync(join(temp, 'native-' + inputs + '-' + p + '.tar.gz')),
    ).toEqual(archive);
  }
  expect(existsSync(join(native, 'codex.node'))).toBe(false);

  const pair = {
    'artifact-id': '12',
    'artifact-digest': asset.digest.slice(7),
  };
  const armRestored = run(
    { inputs, artifact: pair, bytes: archive, arm64: true },
    true,
  );
  expect(armRestored.status, armRestored.error).toBe(0);
  const restoredArmFixture = join(repo, 'packages/agents-codex', armFixture);
  expect(readFileSync(restoredArmFixture, 'utf8')).toBe(armFixture + '\n');
  const fixtureSha256 = createHash('sha256')
    .update(readFileSync(restoredArmFixture))
    .digest('hex');
  expect(armRestored.output).toBe(`fixture_sha256=${fixtureSha256}\n`);
  rmSync(restoredArmFixture);
  const restored = run({ inputs, artifact: pair, bytes: archive }, true);
  expect(restored.status, restored.error).toBe(0);
  expect(restored.requests).toEqual([
    [
      'download',
      'https://api.github.com/repos/openai/openai-agents-js/actions/artifacts/12/zip',
    ],
  ]);
  for (const product of products)
    expect(
      readFileSync(join(repo, 'packages/agents-codex', product), 'utf8'),
    ).toBe(product + '\n');
  const withoutFixture = execFileSync(
    'tar',
    [
      '-czf',
      '-',
      '-C',
      bundle,
      'native/codex.node',
      'native/build-receipt.json',
      'bin',
    ],
    { stdio: 'pipe' },
  );
  const incomplete = run(
    {
      inputs,
      artifact: {
        ...pair,
        'artifact-digest': createHash('sha256')
          .update(withoutFixture)
          .digest('hex'),
      },
      bytes: withoutFixture,
      arm64: true,
    },
    true,
  );
  expect(incomplete.status).toBe(1);
  expect(incomplete.error).toContain(armFixture);
  expect(incomplete.output).toBe('');
  const corrupt = run(
    { inputs, artifact: pair, bytes: Buffer.from('corrupt') },
    true,
  );
  expect(corrupt.status).toBe(1);
  expect(corrupt.error).toContain('Native bundle checksum mismatch');
  expect(corrupt.output).toBe('');
  const missingTransfer = run(
    { inputs, artifact: pair, bytes: archive, status: 410 },
    true,
  );
  expect(missingTransfer.status).toBe(1);
  expect(missingTransfer.error).toContain(
    'Current-run native transfer is unavailable',
  );
  const changedInputs = run(
    { inputs: '0'.repeat(64), artifact: pair, bytes: archive },
    true,
  );
  expect(changedInputs.status).toBe(1);
  expect(changedInputs.error).toContain(
    'Native inputs changed after preflight',
  );

  const retained = {
    ...asset,
    id: 99,
    workflow_run: { ...asset.workflow_run, id: 3 },
  };
  const untrusted = run({
    ...qualified,
    assets: [retained, asset],
    runs: { 3: { ...qualified.run, id: 3, event: 'pull_request' } },
  });
  expect(untrusted.output).toContain(key + '_hit=true');
  const ignored = Array.from({ length: 99 }, (_, i) => ({
    ...asset,
    id: 1000 + i,
    workflow_run: {
      ...asset.workflow_run,
      id: 1000 + i,
      head_branch: 'feature/untrusted',
    },
  }));
  const filtered = run({ ...qualified, assets: [...ignored, asset] });
  const runReads = (r) =>
    r.requests.filter((args) => /\/actions\/runs\/\d+$/.test(args.at(-1)));
  expect(filtered.output).toContain(key + '_hit=true');
  expect(runReads(filtered)).toHaveLength(1);
  const outside = run({
    ...qualified,
    assets: [...ignored, ignored[0], asset],
  });
  expect(outside.output).toContain(key + '_hit=false');
  expect(runReads(outside)).toHaveLength(0);
  const blocked = Array.from({ length: 21 }, (_, i) => ({
    ...retained,
    workflow_run: { ...retained.workflow_run, id: 2000 + i },
  }));
  const exhausted = run({
    ...qualified,
    assets: [...blocked, asset],
    runs: Object.fromEntries(
      blocked.map((a) => [
        a.workflow_run.id,
        { ...qualified.run, id: a.workflow_run.id, event: 'pull_request' },
      ]),
    ),
  });
  expect(exhausted.output).toContain(key + '_hit=false');
  expect(runReads(exhausted)).toHaveLength(20);
  expect(
    exhausted.requests
      .filter((args) => args.at(-1).includes('/actions/artifacts?'))
      .every((args) => !args.includes('--paginate')),
  ).toBe(true);

  for (const changes of [
    { event: 'pull_request' },
    { status: 'in_progress' },
    { head_branch: 'ci/native-bundle/test' },
  ])
    expect(
      run({ ...qualified, run: { ...qualified.run, ...changes } }).output,
    ).toContain(key + '_hit=false');
  expect(
    run({
      ...qualified,
      run: {
        ...qualified.run,
        head_branch: 'ci/native-bundle/test',
        head_sha: git('rev-parse', 'HEAD'),
      },
      jobs: publicationJobs(platform, false, {
        ...producer,
        head_sha: git('rev-parse', 'HEAD'),
      }),
    }).output,
  ).toContain(key + '_hit=true');
  expect(
    run({
      ...qualified,
      jobs: [{ ...qualified.jobs[0], steps: [] }, qualified.jobs[1]],
    }).output,
  ).toContain(key + '_hit=false');
  expect(
    run({ ...qualified, assets: [{ ...asset, created_at: at(15) }] }).output,
  ).toContain(key + '_hit=false');
  expect(run({ ...qualified, status: 410 }).output).toContain(
    key + '_hit=false',
  );
  expect(
    run({ ...qualified, assets: [{ ...asset, expired: true }] }).output,
  ).toContain(key + '_hit=false');
  for (const options of [
    { bytes: Buffer.from('corrupt') },
    { status: 403 },
    { assets: [{ ...asset, digest: 'invalid' }] },
  ])
    expect(run({ ...qualified, ...options }).status).toBe(1);

  writeFileSync(join(native, 'new.rs'), 'new native source\n');
  commit('native change');
  expect(run(qualified).output).toContain(key + '_hit=false');
  mkdirSync(join(repo, '.cargo'));
  writeFileSync(
    join(repo, '.cargo/config.toml'),
    '[build]\nrustc-wrapper = "wrapper"\n',
  );
  writeFileSync(join(repo, 'wrapper'), 'first compiler wrapper\n');
  commit('configure wrapper');
  const configured = run().output;
  writeFileSync(join(repo, 'wrapper'), 'replacement compiler wrapper\n');
  commit('change wrapper');
  expect(/^inputs_hash=(.+)$/m.exec(run().output)[1]).not.toBe(
    /^inputs_hash=(.+)$/m.exec(configured)[1],
  );
}, 30_000);

test('restores only regular Windows parts from the specified artifact outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agents-windows-parts-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'verified');
  const root = join(directory, 'package');
  execFileSync('git', ['init', '-q', directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const receipt = 'native/build-receipt.json';
  const addon = 'native/codex.node';
  const helper = 'bin/codex-sdk-runtime.exe';
  const host = 'bin/codex-code-mode-host.exe';
  const fixture = 'native/test-bin/exec-server-fixture.exe';
  for (const name of [receipt, addon, helper, host, fixture]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), name);
  }
  const archive = (...files) =>
    execFileSync('tar', ['-czf', '-', '-C', root, ...files], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const validAddon = archive(receipt, addon);
  const validHelpers = archive(receipt, helper, host, fixture);
  const artifact = (id, bytes) =>
    JSON.stringify({
      'artifact-id': String(id),
      'artifact-digest': createHash('sha256').update(bytes).digest('hex'),
    });
  const run = (addonBytes, expectedAddon = addonBytes) => {
    const sources = JSON.stringify({
      1: addonBytes.toString('base64'),
      2: validHelpers.toString('base64'),
    });
    const preload = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = cp.execFileSync;
      cp.execFileSync = (command, args, options) => {
        if (command === 'tar' && args[0] === '-xzf') {
          assert.ok(!args.includes('-C'), 'tar must not receive a native drive path');
          assert.ok(options.cwd, 'tar must extract in its staging directory');
        }
        return original(command, args, options);
      };
      syncBuiltinESMExports();
      const archives = ${sources};
      globalThis.fetch = async (url) => {
        const id = new URL(url).pathname.split('/').at(-2);
        return new Response(Buffer.from(archives[id], 'base64'));
      };
    `;
    return spawnSync(
      process.execPath,
      [
        '--import',
        'data:text/javascript,' + encodeURIComponent(preload),
        fileURLToPath(
          new URL('./restore-windows-native-parts.mjs', import.meta.url),
        ),
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          WINDOWS_PARTS: output,
          WINDOWS_ADDON: artifact(1, expectedAddon),
          WINDOWS_HELPERS: artifact(2, validHelpers),
          NATIVE_INPUTS: createHash('sha256').digest('hex'),
        },
      },
    );
  };
  for (const bad of [
    archive(receipt, addon, addon),
    archive(receipt, addon, helper),
    archive(receipt),
  ]) {
    const result = run(bad);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unexpected Windows addon transfer files');
    expect(existsSync(output)).toBe(false);
  }
  const corrupt = run(validAddon, Buffer.from('another archive'));
  expect(corrupt.status).toBe(1);
  expect(corrupt.stderr).toContain('Native bundle checksum mismatch');
  expect(existsSync(output)).toBe(false);
  const valid = run(validAddon);
  expect(valid.status, valid.stderr).toBe(0);
  expect(readFileSync(join(output, 'addon', addon), 'utf8')).toBe(addon);
  expect(readFileSync(join(output, 'helpers', fixture), 'utf8')).toBe(fixture);
});

test('workflow preserves qualification coverage on explicit protected transfers', () => {
  const path = (name) =>
    fileURLToPath(new URL('../.github/workflows/' + name, import.meta.url));
  const workflow = readFileSync(path('alpha-release-artifacts.yml'), 'utf8');
  const native = readFileSync(path('native-bundle.yml'), 'utf8');
  const select = workflow.slice(
    workflow.indexOf('  select:'),
    workflow.indexOf('  produce-linux:'),
  );
  const qualify = workflow.slice(workflow.indexOf('  package-linux:'));
  for (const [key, platform] of Object.entries(nativePlatforms)) {
    expect(workflow).toContain('toJSON(steps.upload_' + key + '.outputs)');
    const hit = `needs.select.outputs.${key}_hit`;
    const result = `needs.produce-${key}.result`;
    expect(select).toContain(
      `name: Publish native bundle (${platform})\n        id: upload_${key}\n        if: steps.select.outputs.${key}_hit == 'true'`,
    );
    expect(workflow).toContain(
      `produce-${key}:\n    needs: select\n    if: ${hit} != 'true'\n    uses: ./.github/workflows/native-bundle.yml\n    with:\n      platform: ${platform}`,
    );
    expect(qualify).toContain(
      `((${hit} == 'true' && ${result} == 'skipped') ||\n       (${hit} != 'true' && ${result} == 'success'))`,
    );
    expect(qualify).toContain(
      'needs.select.outputs.' +
        key +
        '_artifact || needs.produce-' +
        key +
        '.outputs.artifact',
    );
  }
  expect(native).toContain('toJSON(steps.upload.outputs)');
  expect(native).toContain("format('Native bundle ({0})', inputs.platform)");
  expect(native).toContain(
    'windows-bundle:\n    name: Native bundle (win32-x64)\n    needs: [native, windows-filenames]',
  );
  expect(native).toContain(
    "inputs.platform == 'win32-x64' && jobs.windows-bundle.outputs.artifact",
  );
  expect(native).toContain(
    'WINDOWS_ADDON: ${{ needs.native.outputs.windows_addon }}',
  );
  expect(native).toContain(
    'WINDOWS_HELPERS: ${{ needs.windows-filenames.outputs.windows_helpers }}',
  );
  expect(native).toContain('name: Publish native bundle\n');
  expect(native).toContain(
    `inputs.platform == 'linux-arm64' && inputs.managed_arm && '{"group":"codex-runners","labels":"codex-linux-arm64"}'`,
  );
  expect(native).toContain(
    `inputs.platform == 'linux-arm64' && '"ubuntu-24.04-arm"'`,
  );
  expect(native).toContain(
    "inputs.platform == 'linux-arm64' && (inputs.managed_arm && 16 || 4)",
  );
  expect(workflow).toContain('managed_arm: &managed_arm >-');
  expect(qualify).toContain('managed_arm: *managed_arm');
  expect(qualify).toContain(
    'platform: linux-arm64\n            runner: ubuntu-24.04-arm\n',
  );
  expect(native).toContain('macos-15-xlarge');
  expect(qualify).toContain('runner: macos-15\n');
  expect(qualify).not.toContain('macos-15-xlarge');
  expect(workflow + native).not.toContain('overwrite:');
  for (const source of [select, native]) {
    expect(source).not.toContain('pnpm install');
    expect(source).not.toContain('pnpm build');
    expect(source).not.toContain('pnpm/action-setup');
  }
  expect(qualify).toContain('name: Package and test (${{ matrix.platform }})');
  expect(qualify).toContain('NATIVE_ARTIFACT: ${{ matrix.artifact }}');
  expect(qualify).toContain('Check runner platform');
  expect(qualify).toContain('apparmor-profiles bubblewrap');
  for (const step of [
    'Build the current SDK',
    'Qualify canonical native storage',
    'Qualify the Linux worker',
    'Qualify local executor grants on macOS',
    'Qualify completed child history on macOS',
    'Qualify executor stop and process cleanup on macOS',
    'Qualify owned child tracing on macOS',
    'Qualify native tracing and decoded OTLP transports',
    'Test the extracted bundles',
  ])
    expect(qualify).toContain('name: ' + step);
});

test.each(Object.keys(nativePlatforms))(
  'qualification for %s keeps the exact transfer and shared coverage',
  (key) => {
    const workflow = readFileSync(
      new URL(
        '../.github/workflows/alpha-release-artifacts.yml',
        import.meta.url,
      ),
      'utf8',
    );
    const qualify = workflow
      .split(`  package-${key}:\n`)[1]
      .split(/^ {2}package-/m)[0];
    expect(qualify).toContain(`needs: [select, produce-${key}]`);
    expect(qualify).toContain(
      "!cancelled() && needs.select.result == 'success'",
    );
    expect(qualify).toContain(
      `needs.select.outputs.${key}_hit == 'true' && needs.produce-${key}.result == 'skipped'`,
    );
    expect(qualify).toContain(
      `needs.select.outputs.${key}_hit != 'true' && needs.produce-${key}.result == 'success'`,
    );
    expect(qualify).toContain(`- platform: ${nativePlatforms[key]}`);
    expect(qualify).toContain(
      key === 'linux' ? 'steps: &package_steps' : 'steps: *package_steps',
    );
    expect(qualify).toContain(
      'name: Package and test (${{ matrix.platform }})',
    );
  },
);
