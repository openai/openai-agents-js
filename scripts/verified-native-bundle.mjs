import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeComparisonPaths } from './native-bundle-inputs.mjs';

const repo = 'openai/openai-agents-js';
const workflow = 'alpha-release-artifacts.yml';
const canonicalBranch = 'feat/codex-harness';
const donorWaitMs = 90_000;
const donorPollMs = 10_000;
const donorRequestMs = 5_000;
export const nativePlatforms = {
  linux: 'linux-x64',
  macos: 'darwin-arm64',
  windows: 'win32-x64',
};
const api = (...args) =>
  JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
const approvedBranch = (branch) =>
  branch === canonicalBranch ||
  branch?.startsWith('ci/native-bundle/') === true;

function hasProducerIdentity(run, workflowId) {
  return (
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    run.event === 'push' &&
    run.workflow_id === workflowId &&
    run.path === '.github/workflows/' + workflow &&
    approvedBranch(run.head_branch) &&
    /^[a-f0-9]{40}$/.test(run.head_sha)
  );
}

export function isProducer(run, workflowId) {
  return (
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    hasProducerIdentity(run, workflowId)
  );
}

function isFinishingProducer(run, workflowId) {
  return (
    run.status === 'in_progress' &&
    run.conclusion === null &&
    run.run_attempt === 1 &&
    run.head_branch === canonicalBranch &&
    hasProducerIdentity(run, workflowId)
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

export function findNativeBundle(inputs, platform, onInFlight) {
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
      !approvedBranch(candidate.head_branch)
    )
      continue;
    if (seenRuns.has(candidate.id)) continue;
    // Untrusted uploads must not turn an optional cache lookup into an unbounded scan.
    if (seenRuns.size === 20) break;
    seenRuns.add(candidate.id);
    const path = 'repos/' + repo + '/actions/runs/' + candidate.id;
    const run = api(path);
    if (!isProducer(run, workflowId)) {
      if (
        onInFlight &&
        isFinishingProducer(run, workflowId) &&
        run.id === candidate.id &&
        Number.isSafeInteger(run.id) &&
        /^sha256:[a-f0-9]{64}$/.test(asset.digest)
      )
        onInFlight(run, platform);
      continue;
    }
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
    // Off-branch producers execute SDK qualification too: preserve full-tree equality.
    const paths = run.head_branch.startsWith('ci/native-bundle/')
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

function timedApi(endpoint, timeout) {
  return JSON.parse(
    execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      timeout: Math.max(1, Math.floor(Math.min(donorRequestMs, timeout))),
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

function packagingNearlyDone(page, runId) {
  if (page.total_count !== page.jobs.length) return false;
  return Object.values(nativePlatforms).every((platform) => {
    const matching = page.jobs.filter(
      (job) => job.name === 'Package and test (' + platform + ')',
    );
    if (matching.length !== 1) return false;
    const [job] = matching;
    if (job.run_id !== runId || job.run_attempt !== 1) return false;
    if (job.status === 'completed') return job.conclusion === 'success';
    if (job.status !== 'in_progress' || job.conclusion !== null) return false;
    const smoke = job.steps.find(
      (step) => step.name === 'Test the extracted bundles',
    );
    return smoke?.status === 'in_progress' || smoke?.conclusion === 'success';
  });
}

// This only decides whether another normal lookup is worthwhile. It never
// returns artifact bytes or bypasses successful-run and publication proof.
export async function waitForNativeProducer(
  candidates,
  { request = timedApi, now = () => performance.now(), sleep = delay } = {},
) {
  const matching = [...candidates].filter(({ platforms }) =>
    Object.values(nativePlatforms).every((platform) => platforms.has(platform)),
  );
  if (matching.length !== 1) return false;
  const [{ run: candidate }] = matching;
  const endpoint = 'repos/' + repo + '/actions/runs/' + candidate.id;
  const deadline = now() + donorWaitMs;
  const lookup = (path) => {
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    return request(path, remaining);
  };
  const sameAttempt = (run) =>
    run?.id === candidate.id &&
    run.head_sha === candidate.head_sha &&
    run.head_branch === canonicalBranch &&
    run.run_attempt === 1;

  try {
    let run = lookup(endpoint);
    if (!sameAttempt(run)) return false;
    if (isProducer(run, candidate.workflow_id)) return true;
    if (!isFinishingProducer(run, candidate.workflow_id)) return false;
    const jobs = lookup(endpoint + '/attempts/1/jobs?per_page=100');
    if (!jobs || !packagingNearlyDone(jobs, run.id)) return false;
    console.log('Waiting up to 90 seconds for Alpha run ' + run.id + '.');
    // Leave enough time for a final request instead of sleeping to the cutoff.
    const finalPollAt = deadline - donorRequestMs;
    let finalPoll = false;
    while (!finalPoll) {
      const untilFinalPoll = finalPollAt - now();
      if (untilFinalPoll > 0) {
        await sleep(Math.min(donorPollMs, untilFinalPoll));
      }
      finalPoll = now() >= finalPollAt;
      run = lookup(endpoint);
      if (!sameAttempt(run)) return false;
      if (isProducer(run, candidate.workflow_id)) return true;
      if (!isFinishingProducer(run, candidate.workflow_id)) return false;
    }
  } catch {
    // This optional timing lookup must not block the ordinary cold build.
  }
  return false;
}
