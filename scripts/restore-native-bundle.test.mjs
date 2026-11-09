import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
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
import { expect, onTestFinished, test, vi } from 'vitest';
import {
  isProducer,
  isNativePublication,
  nativePlatforms,
  waitForNativeProducer,
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
function publicationJobs(platform, preflight = false) {
  const key = Object.keys(nativePlatforms).find(
    (key) => nativePlatforms[key] === platform,
  );
  return [
    {
      id: 2,
      run_id: 1,
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
          started_at: at(1),
          completed_at: at(3),
        },
      ],
    },
    {
      id: 3,
      run_id: 1,
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
    { head_repository: { full_name: 'fork/openai-agents-js' } },
  ])
    expect(isProducer({ ...producer, ...change }, 1)).toBe(false);
});

const finishing = { ...producer, status: 'in_progress', conclusion: null };
const finishingJobs = Object.values(nativePlatforms).map((platform) => ({
  name: 'Package and test (' + platform + ')',
  run_id: producer.id,
  run_attempt: 1,
  status: 'in_progress',
  conclusion: null,
  steps: [{ name: 'Test the extracted bundles', status: 'in_progress' }],
}));

async function simulateDonorWait(
  states,
  {
    jobs = finishingJobs,
    platforms = Object.values(nativePlatforms),
    requestDurations = [],
  } = {},
) {
  let elapsed = 0;
  let lookups = 0;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const success = await waitForNativeProducer(
      [{ run: finishing, platforms: new Set(platforms) }],
      {
        request(endpoint, remaining) {
          expect(remaining).toBeGreaterThan(0);
          if (endpoint.endsWith('/jobs?per_page=100'))
            return { total_count: jobs.length, jobs };
          const state = states[Math.min(lookups, states.length - 1)];
          elapsed += requestDurations[lookups] ?? 0;
          lookups++;
          if (state instanceof Error) throw state;
          return state;
        },
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
      },
    );
    return { success, elapsed, lookups };
  } finally {
    log.mockRestore();
  }
}

test('waits for a late canonical donor, then reports successful completion for re-verification', async () => {
  const result = await simulateDonorWait([finishing, finishing, producer]);
  expect(result).toEqual({ success: true, elapsed: 20_000, lookups: 3 });
});

test('the donor wait caps elapsed time and falls back when a donor stalls', async () => {
  const result = await simulateDonorWait([finishing]);
  expect(result).toEqual({ success: false, elapsed: 85_000, lookups: 10 });
});

test('the final poll catches a donor that finishes after the last regular poll', async () => {
  const result = await simulateDonorWait([
    ...Array(9).fill(finishing),
    producer,
  ]);
  expect(result).toEqual({ success: true, elapsed: 85_000, lookups: 10 });
});

test('a slow status response still leaves room for a final bounded poll', async () => {
  const result = await simulateDonorWait(
    [...Array(9).fill(finishing), producer],
    { requestDurations: [0, ...Array(7).fill(500), 2_500] },
  );
  expect(result).toEqual({ success: true, elapsed: 86_000, lookups: 10 });
});

test('a failed, canceled, stale, retrying, or unobservable donor falls back immediately', async () => {
  for (const state of [
    ...['failure', 'cancelled', 'stale'].map((conclusion) => ({
      ...producer,
      conclusion,
    })),
    { ...finishing, run_attempt: 2 },
    new Error('GitHub metadata unavailable'),
  ]) {
    const result = await simulateDonorWait([finishing, state]);
    expect(result).toEqual({ success: false, elapsed: 10_000, lookups: 2 });
  }
});

test('missing exact artifacts or inconclusive package progress skips the wait', async () => {
  const incompleteArtifacts = await simulateDonorWait([finishing], {
    platforms: ['linux-x64', 'win32-x64'],
  });
  expect(incompleteArtifacts).toEqual({
    success: false,
    elapsed: 0,
    lookups: 0,
  });
  const earlyPackage = await simulateDonorWait([finishing], {
    jobs: [{ ...finishingJobs[0], steps: [] }, ...finishingJobs.slice(1)],
  });
  expect(earlyPackage).toEqual({ success: false, elapsed: 0, lookups: 1 });
});

test('native publication precedes all SDK execution, including other platforms and prior attempts', () => {
  const asset = { created_at: at(2) };
  for (const platform of Object.values(nativePlatforms)) {
    for (const preflight of [false, true]) {
      const jobs = publicationJobs(platform, preflight);
      expect(isNativePublication(asset, producer, jobs, platform)).toBe(true);
      for (const created_at of [at(0), at(4)])
        expect(
          isNativePublication({ created_at }, producer, jobs, platform),
        ).toBe(false);
      const earlierSdk = {
        ...jobs[1],
        name: 'Package and test (other-platform)',
        started_at: at(2),
      };
      expect(
        isNativePublication(asset, producer, [...jobs, earlierSdk], platform),
      ).toBe(false);
      expect(
        isNativePublication(
          asset,
          { ...producer, run_attempt: 2 },
          [
            ...jobs.map((j) => ({ ...j, run_attempt: 2 })),
            { ...jobs[1], started_at: at(0) },
          ],
          platform,
        ),
      ).toBe(false);
      expect(
        isNativePublication(
          asset,
          producer,
          [
            ...jobs,
            {
              ...jobs[1],
              run_attempt: 2,
              conclusion: null,
            },
          ],
          platform,
        ),
      ).toBe(false);
      expect(
        isNativePublication(
          asset,
          { ...producer, run_attempt: 2 },
          [
            ...jobs,
            {
              ...jobs[1],
              run_attempt: 2,
              conclusion: 'failure',
            },
          ],
          platform,
        ),
      ).toBe(false);
      expect(
        isNativePublication(
          asset,
          producer,
          [{ ...jobs[0], steps: [] }, jobs[1]],
          platform,
        ),
      ).toBe(false);
      expect(
        isNativePublication(
          asset,
          producer,
          [jobs[0], { ...jobs[1], started_at: undefined }],
          platform,
        ),
      ).toBe(false);
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
      runLookups: options.runLookups ?? [],
      runs: options.runs ?? {},
      jobs: options.jobs ?? [],
      jobsByRun: options.jobsByRun ?? {},
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
      const original = cp.execFileSync;
      let runLookup = 0;
      cp.execFileSync = (command, args, options) => {
        if (command !== 'gh') return original(command, args, options);
        appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + '\\n');
        // Fresh provider logs have UNKNOWN STEP. They are not publication proof.
        if (args[0] === 'run') throw new Error('Step logs are unavailable');
        const endpoint = args.at(-1);
        if (endpoint.includes('/actions/workflows/')) return JSON.stringify({id: 1});
        if (endpoint.includes('/actions/artifacts?')) {
          const params = new URL('https://github.invalid/' + endpoint).searchParams;
          return JSON.stringify({artifacts: fixture.assets.filter(a => a.name === params.get('name')).slice(0, Number(params.get('per_page')))});
        }
        if (endpoint.includes('/jobs?')) return JSON.stringify([{jobs: fixture.jobsByRun[endpoint.split('/').at(-2)] ?? fixture.jobs}]);
        if (endpoint.includes('/actions/runs/')) return JSON.stringify(fixture.runLookups[runLookup++] ?? fixture.runs[endpoint.split('/').at(-1)] ?? fixture.run);
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
          GITHUB_EVENT_NAME: options.event ?? 'push',
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
  const platform = process.platform + '-' + process.arch;
  const key = Object.keys(nativePlatforms).find(
    (k) => nativePlatforms[k] === platform,
  );
  const bundle = join(temp, 'bundle');
  const products = [
    'native/codex.node',
    'native/build-receipt.json',
    'bin/helper',
  ];
  const fixture =
    'native/test-bin/exec-server-fixture' +
    (process.platform === 'win32' ? '.exe' : '');
  if (['linux-x64', 'darwin-arm64', 'win32-x64'].includes(platform))
    products.push(fixture);
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
    jobs: publicationJobs(platform),
    bytes: archive,
  };
  writeFileSync(join(repo, 'sdk.js'), 'export default 1;\n');
  commit('SDK only');
  const staged = run(qualified);
  expect(staged.status, staged.error).toBe(0);
  expect(staged.output).toContain(key + '_hit=true');
  expect(staged.summary).toContain('Verified native artifact 12 from run 1');
  expect(staged.summary).toContain(inputs);
  expect(staged.requests.some((args) => args[0] === 'run')).toBe(false);
  expect(readFileSync(join(temp, asset.name))).toEqual(archive);
  expect(existsSync(join(native, 'codex.node'))).toBe(false);

  const allAssets = Object.values(nativePlatforms).map((p, i) => ({
    ...asset,
    id: 12 + i,
    name: 'native-' + inputs + '-' + p + '.tar.gz',
  }));
  const allJobs = Object.values(nativePlatforms).flatMap((p) =>
    publicationJobs(p),
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

  const race = {
    ...qualified,
    assets: allAssets,
    jobs: allJobs,
    runLookups: allAssets.map(() => ({ ...finishing, head_sha: source })),
  };
  const push = run(race);
  expect(push.status, push.error).toBe(0);
  expect(push.requests.some(([kind]) => kind === 'download')).toBe(false);
  const pr = run({ ...race, event: 'pull_request' });
  expect(pr.status, pr.error).toBe(0);
  for (const k of Object.keys(nativePlatforms)) {
    expect(pr.output).toContain(k + '_hit=true');
  }
  const unverified = run({ ...race, event: 'pull_request', jobs: [] });
  expect(unverified.status, unverified.error).toBe(0);
  expect(unverified.requests.some(([kind]) => kind === 'download')).toBe(false);
  const unavailable = run({ ...race, event: 'pull_request', status: 403 });
  expect(unavailable.status, unavailable.error).toBe(0);
  expect(
    unavailable.requests.filter(([kind]) => kind === 'download'),
  ).toHaveLength(allAssets.length);
  for (const k of Object.keys(nativePlatforms)) {
    expect(unavailable.output).toContain(k + '_hit=false');
  }

  const pair = {
    'artifact-id': '12',
    'artifact-digest': asset.digest.slice(7),
  };
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
  if (['linux-x64', 'darwin-arm64', 'win32-x64'].includes(platform)) {
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
      },
      true,
    );
    expect(incomplete.status).toBe(1);
    expect(incomplete.error).toContain(fixture);
  }
  const corrupt = run(
    { inputs, artifact: pair, bytes: Buffer.from('corrupt') },
    true,
  );
  expect(corrupt.status).toBe(1);
  expect(corrupt.error).toContain('Native bundle checksum mismatch');
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

test('workflow keeps the publication barrier and qualification coverage on explicit protected transfers', () => {
  const path = (name) =>
    fileURLToPath(new URL('../.github/workflows/' + name, import.meta.url));
  const workflow = readFileSync(path('alpha-release-artifacts.yml'), 'utf8');
  const native = readFileSync(path('native-bundle.yml'), 'utf8');
  const select = workflow.slice(
    workflow.indexOf('  select:'),
    workflow.indexOf('  produce-linux:'),
  );
  const qualify = workflow.slice(
    workflow.indexOf('  package:'),
    workflow.indexOf('  package-linux:'),
  );
  expect(qualify).toContain(
    'needs: [select, produce-linux, produce-macos, produce-windows]',
  );
  expect(qualify).toContain(
    "github.event_name != 'pull_request' && !cancelled() && needs.select.result == 'success'",
  );
  for (const key of Object.keys(nativePlatforms)) {
    expect(workflow).toContain('toJSON(steps.upload_' + key + '.outputs)');
    expect(qualify).toContain('needs.produce-' + key + ".result == 'skipped'");
    expect(qualify).toContain('needs.produce-' + key + ".result == 'success'");
    expect(qualify).toContain(
      'needs.select.outputs.' +
        key +
        '_artifact || needs.produce-' +
        key +
        '.outputs.artifact',
    );
  }
  expect(native).toContain('toJSON(steps.upload.outputs)');
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
  'pull request qualification for %s waits for its own native transfer',
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
      "github.event_name == 'pull_request' && !cancelled() && needs.select.result == 'success'",
    );
    expect(qualify).toContain(
      `needs.select.outputs.${key}_hit == 'true' && needs.produce-${key}.result == 'skipped'`,
    );
    expect(qualify).toContain(
      `needs.select.outputs.${key}_hit != 'true' && needs.produce-${key}.result == 'success'`,
    );
    expect(qualify).toContain(`include: [*${key}_package]`);
    expect(qualify).toContain('steps: *package_steps');
  },
);

test('Windows filename qualification runs beside native builds on pull requests', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/native-bundle.yml', import.meta.url),
    'utf8',
  );
  const [native, regression] = workflow.split(
    '\n  windows-filename-regression:\n',
  );
  expect(native).toContain(
    "if: runner.os == 'Windows' && github.event_name != 'pull_request'",
  );
  expect(native.indexOf('run: &test_windows_filename')).toBeLessThan(
    native.indexOf('name: Publish native bundle'),
  );
  expect(native).toContain(
    'cargo test --locked --release --target "$native_host" -p codex-exec-server --lib invalid_filename -- --nocapture',
  );
  expect(regression).toContain(
    "inputs.platform == 'win32-x64' && github.event_name == 'pull_request'",
  );
  expect(regression).toContain(
    'run: node packages/agents-codex/scripts/native.mjs prepare',
  );
  expect(regression).toContain('working-directory: *codex_rust_root');
  expect(regression).toContain('run: *test_windows_filename');
  expect(regression).not.toContain('needs:');
});
