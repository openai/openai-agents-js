import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { nativeComparisonPaths } from './native-bundle-inputs.mjs';

const repo = 'openai/openai-agents-js';
const workflow = 'alpha-release-artifacts.yml';
export const nativePlatforms = {
  linux: 'linux-x64',
  'linux-arm64': 'linux-arm64',
  macos: 'darwin-arm64',
  windows: 'win32-x64',
};
const api = (...args) =>
  JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
const approvedBranch = (branch) =>
  branch === 'feat/codex-harness' ||
  branch?.startsWith('ci/native-bundle/') === true;

// Temporary exact benchmark pair; production donor approval stays unchanged.
const benchmarkPush = (branch) =>
  process.env.GITHUB_REPOSITORY === repo &&
  process.env.GITHUB_EVENT_NAME === 'push' &&
  process.env.GITHUB_REF === 'refs/heads/' + branch;
const benchmarkSeed = (branch) =>
  benchmarkPush('ci/hillclimb/js-current-warm-40') &&
  branch === 'ci/hillclimb/js-current-seed-40';
const approvedDonor = (branch) =>
  benchmarkPush('ci/hillclimb/js-current-warm-40')
    ? benchmarkSeed(branch)
    : approvedBranch(branch);

export function isProducer(run, workflowId) {
  return (
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    run.event === 'push' &&
    run.workflow_id === workflowId &&
    run.path === '.github/workflows/' + workflow &&
    approvedDonor(run.head_branch) &&
    /^[a-f0-9]{40}$/.test(run.head_sha)
  );
}

export function isNativePublication(asset, run, jobs, platform) {
  const latest = (name) =>
    jobs
      .filter((job) => job.name === name)
      .sort((a, b) => b.run_attempt - a.run_attempt)[0];
  if (
    jobs.some((job) => job.run_attempt > run.run_attempt) ||
    latest('Package and test (' + platform + ')')?.conclusion !== 'success'
  )
    return false;
  // Include prior attempts: SDK code must never precede a trusted publication.
  const starts = jobs
    .filter(
      (job) =>
        job.name.startsWith('Package and test (') &&
        job.conclusion !== 'skipped',
    )
    .map((job) => Date.parse(job.started_at));
  if (!starts.length || starts.some((time) => !Number.isFinite(time)))
    return false;
  const earliestSdk = Math.min(...starts);
  const key = Object.keys(nativePlatforms).find(
    (key) => nativePlatforms[key] === platform,
  );
  const owners = [
    ['Select native bundles', 'Publish native bundle (' + platform + ')'],
    [
      'produce-' + key + ' / Native bundle (' + platform + ')',
      'Publish native bundle',
    ],
  ];
  for (const [name, stepName] of owners) {
    const job = latest(name);
    const step = job?.steps?.find((entry) => entry.name === stepName);
    if (job?.conclusion !== 'success' || step?.conclusion !== 'success')
      continue;
    assert.equal(job.run_id, run.id);
    const created = Date.parse(asset.created_at);
    const start = Date.parse(step.started_at);
    const end = Date.parse(step.completed_at);
    if (start <= created && created <= end && end < earliestSdk) return true;
  }
  return false;
}

export async function downloadNativeBundle(asset) {
  assert.ok(
    Number.isSafeInteger(asset.id) && asset.id > 0,
    'Invalid native artifact ID',
  );
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  const response = await globalThis.fetch(
    'https://api.github.com/repos/' +
      repo +
      '/actions/artifacts/' +
      asset.id +
      '/zip',
    {
      headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN },
      signal: globalThis.AbortSignal.timeout(180_000),
    },
  );
  if ([404, 410].includes(response.status)) return undefined;
  assert.ok(response.ok, 'Native download returned HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    asset.sha256,
    'Native bundle checksum mismatch',
  );
  return bytes;
}

export function findNativeBundle(inputs, platform) {
  if (benchmarkPush('ci/hillclimb/js-current-seed-40')) return undefined;
  const name = 'native-' + inputs + '-' + platform + '.tar.gz';
  const workflowId = api('repos/' + repo + '/actions/workflows/' + workflow).id;
  // Exact-name lookup avoids a stale committed pointer and unrelated run scans.
  const page = api(
    'repos/' +
      repo +
      '/actions/artifacts?per_page=100&name=' +
      encodeURIComponent(name),
  );
  const seenRuns = new Set();
  for (const asset of page.artifacts) {
    if (asset.expired || asset.name !== name) continue;
    const candidate = asset.workflow_run;
    if (
      !candidate ||
      candidate.repository_id !== candidate.head_repository_id ||
      !approvedDonor(candidate.head_branch)
    )
      continue;
    if (seenRuns.has(candidate.id)) continue;
    // Untrusted uploads must not turn an optional cache lookup into an unbounded scan.
    if (seenRuns.size === 20) break;
    seenRuns.add(candidate.id);
    const path = 'repos/' + repo + '/actions/runs/' + candidate.id;
    const run = api(path);
    // PRs and running producers are ordinary misses, never a reason to wait.
    if (!isProducer(run, workflowId)) continue;
    if (
      spawnSync('git', ['cat-file', '-e', run.head_sha + '^{commit}'])
        .status !== 0
    ) {
      execFileSync('git', [
        'fetch',
        '--no-tags',
        '--depth=1',
        'https://github.com/' + repo + '.git',
        run.head_sha,
      ]);
    }
    if (
      benchmarkSeed(run.head_branch) &&
      spawnSync('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD'])
        .status !== 0
    )
      continue;
    // Off-branch producers execute SDK qualification too: preserve full-tree equality.
    const paths =
      benchmarkSeed(run.head_branch) ||
      run.head_branch.startsWith('ci/native-bundle/')
        ? ['.']
        : nativeComparisonPaths();
    if (
      spawnSync('git', [
        'diff',
        '--quiet',
        run.head_sha,
        'HEAD',
        '--',
        ...paths,
      ]).status !== 0
    ) {
      continue;
    }
    const jobs = api(
      '--paginate',
      '--slurp',
      path + '/jobs?filter=all&per_page=100',
    ).flatMap((page) => page.jobs);
    if (!isNativePublication(asset, run, jobs, platform)) continue;
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
    return { id: asset.id, sha256: asset.digest.slice(7), run: run.id };
  }
  return undefined;
}
