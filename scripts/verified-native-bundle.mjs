import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { nativeComparisonPaths } from './native-bundle-inputs.mjs';

const repo = 'openai/openai-agents-js';
const workflow = 'alpha-release-artifacts.yml';
const uploadStep = 'Upload the native bundle';
const api = (...args) =>
  JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));

export function isProducer(run, workflowId) {
  return (
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    run.event === 'push' &&
    run.workflow_id === workflowId &&
    run.path === '.github/workflows/' + workflow &&
    (run.head_branch === 'feat/codex-harness' ||
      run.head_branch?.startsWith('ci/native-bundle/')) &&
    /^[a-f0-9]{40}$/.test(run.head_sha)
  );
}

export function verifyUpload(jobName, asset, log) {
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  const sha256 = asset.digest.slice('sha256:'.length);
  // Only the provider-recorded upload step can authorize these bytes.
  const prefix = jobName + '\t' + uploadStep + '\t';
  const lines = log.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  assert.ok(
    lines.some((line) =>
      line.endsWith(
        'Artifact ' +
          asset.name +
          ' successfully finalized. Artifact ID ' +
          asset.id,
      ),
    ),
    'Artifact ID must come from the platform upload step',
  );
  assert.ok(
    lines.some((line) =>
      line.endsWith('SHA256 digest of uploaded artifact is ' + sha256),
    ),
    'Artifact digest must come from the platform upload step',
  );
  return { id: asset.id, sha256 };
}

export function findNativeBundle(inputs, platform) {
  const name = 'native-' + inputs + '-' + platform + '.tar.gz';
  const workflowId = api('repos/' + repo + '/actions/workflows/' + workflow).id;
  // Exact-name lookup avoids a stale committed pointer and unrelated run scans.
  const pages = api(
    '--paginate',
    '--slurp',
    'repos/' +
      repo +
      '/actions/artifacts?per_page=100&name=' +
      encodeURIComponent(name),
  );
  for (const asset of pages.flatMap((page) => page.artifacts)) {
    if (asset.expired || asset.name !== name) continue;
    const path = 'repos/' + repo + '/actions/runs/' + asset.workflow_run.id;
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
    const jobName = 'Package and test (' + platform + ')';
    const job = jobs
      .filter((entry) => entry.name === jobName)
      .sort((a, b) => b.run_attempt - a.run_attempt)[0];
    const upload = job?.steps.find((step) => step.name === uploadStep);
    // Reruns can start after the run read or succeed without a fresh upload.
    if (job?.conclusion !== 'success' || upload?.conclusion !== 'success')
      continue;
    assert.equal(job.run_id, run.id);
    const log = execFileSync(
      'gh',
      [
        'run',
        'view',
        '--repo',
        repo,
        '--job',
        String(job.id),
        '--attempt',
        String(job.run_attempt),
        '--log',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return { ...verifyUpload(jobName, asset, log), run: run.id };
  }
  return undefined;
}
