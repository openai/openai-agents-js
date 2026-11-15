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

export function isProducer(run, workflowId) {
  return (
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    run.event === 'push' &&
    run.workflow_id === workflowId &&
    run.path === '.github/workflows/' + workflow &&
    approvedBranch(run.head_branch) &&
    /^[a-f0-9]{40}$/.test(run.head_sha)
  );
}

const uploader = 'cf430e030ddbb5b0abf93d22962f4752f3646cd9';
const prefix = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;

export function uploadStepMatches(log, asset, runId) {
  if (
    typeof log !== 'string' ||
    Buffer.byteLength(log) > 64 * 1024 ||
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '') ||
    !/^native-[0-9a-f]{64}-(linux-x64|linux-arm64|darwin-arm64|win32-x64)\.tar\.gz$/.test(
      asset.name ?? '',
    )
  ) {
    return false;
  }

  const lines = log.replace(/^\uFEFF/, '').split(/\r?\n/);
  const contents = lines
    .filter((line) => prefix.test(line))
    .map((line) => line.replace(prefix, ''));
  const markers = [
    `##[group]Run actions/upload-artifact@${uploader}`,
    'SHA256 digest of uploaded artifact is ' + asset.digest.slice(7),
    `Artifact ${asset.name} successfully finalized. Artifact ID ${asset.id}`,
    `Artifact download URL: https://github.com/${repo}/actions/runs/${runId}/artifacts/${asset.id}`,
  ];
  const receiptLines = contents.filter(
    (line) =>
      line.startsWith('##[group]Run actions/upload-artifact@') ||
      line.startsWith('SHA256 digest of uploaded artifact is ') ||
      /^Artifact .+ successfully finalized\. Artifact ID /.test(line) ||
      line.startsWith('Artifact download URL: '),
  );
  return (
    contents[0] === markers[0] &&
    receiptLines.length === markers.length &&
    markers.every((marker, index) => receiptLines[index] === marker)
  );
}

export function publicationStep(asset, run, jobs, platform) {
  // A newer job attempt can appear after the completed run was read.
  if (jobs.some((job) => job.run_attempt > run.run_attempt)) return undefined;
  const matching = (name) => jobs.filter((job) => job.name === name);
  const latest = (entries) => {
    const latestAttempt = Math.max(...entries.map((job) => job.run_attempt));
    const matches = entries.filter((job) => job.run_attempt === latestAttempt);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const packageJobs = matching('Package and test (' + platform + ')');
  if (
    packageJobs.some(
      (job) =>
        job.run_id !== run.id ||
        job.head_sha !== run.head_sha ||
        !Number.isSafeInteger(job.run_attempt) ||
        job.run_attempt < 1,
    ) ||
    latest(packageJobs)?.conclusion !== 'success'
  )
    return undefined;
  const starts = packageJobs
    .filter((job) => job.conclusion !== 'skipped')
    .map((job) => Date.parse(job.started_at));
  if (!starts.length || starts.some((time) => !Number.isFinite(time)))
    return undefined;
  const earliestPackage = Math.min(...starts);
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
  const candidates = [];
  for (const [name, stepName] of owners) {
    const job = latest(matching(name));
    if (
      job?.conclusion !== 'success' ||
      job.run_id !== run.id ||
      job.head_sha !== run.head_sha ||
      !Number.isSafeInteger(job.id) ||
      job.id <= 0 ||
      !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt < 1
    )
      continue;
    const steps = job.steps.filter((entry) => entry.name === stepName);
    if (steps.length !== 1 || steps[0].conclusion !== 'success') continue;
    const step = steps[0];
    if (!Number.isSafeInteger(step.number) || step.number <= 0) continue;
    const created = Date.parse(asset.created_at);
    const start = Date.parse(step.started_at);
    const end = Date.parse(step.completed_at);
    // This time bound selects the prospective uploader. Its log still supplies the proof.
    if (start <= created && created <= end + 1000 && end < earliestPackage)
      candidates.push({ job: job.id, step: step.number });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function readPublicationStep(job, step) {
  try {
    return execFileSync(
      'gh',
      [
        'api',
        '--allow-escape-sequences',
        'repos/' + repo + '/actions/jobs/' + job + '/steps/' + step + '/logs',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    if (/\bHTTP (404|410)\b/.test(error.stderr ?? '')) return '';
    // Match the other selector API calls: unknown service errors stop fanout.
    throw error;
  }
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
    const owner = publicationStep(asset, run, jobs, platform);
    if (!owner) continue;
    assert.match(asset.digest, /^sha256:[0-9a-f]{64}$/);
    if (
      !uploadStepMatches(
        readPublicationStep(owner.job, owner.step),
        asset,
        run.id,
      )
    )
      continue;
    return { id: asset.id, sha256: asset.digest.slice(7), run: run.id };
  }
  return undefined;
}
