import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { nativeInputPaths, nativeInputs } from './native-bundle-inputs.mjs';

const repo = 'openai/openai-agents-js';
const workflow = 'alpha-release-artifacts.yml';
const uploadStep = 'Upload the native bundle for pinning';
const api = (...args) => JSON.parse(execFileSync('gh', ['api', ...args]));

export function verifyProducer(run, workflowId) {
  assert.equal(run.conclusion, 'success', 'Choose a successful native build');
  assert.equal(run.repository.full_name, repo);
  assert.equal(run.head_repository?.full_name, repo);
  // A direct push executes the workflow and checks out the same immutable commit.
  assert.equal(run.event, 'push', 'Choose a direct Alpha push build');
  assert.equal(run.workflow_id, workflowId);
  assert.equal(run.path, '.github/workflows/' + workflow);
  assert.ok(
    run.head_branch === 'feat/codex-harness' ||
      run.head_branch.startsWith('ci/native-bundle/'),
    'Choose the harness branch or a native-bundle producer branch',
  );
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
}

export function verifyUpload(jobName, asset, log) {
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  const sha256 = asset.digest.slice('sha256:'.length);
  // gh separates each provider-recorded step from its output with tabs.
  const prefix = jobName + '\t' + uploadStep + '\t';
  const lines = log.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  const finalized =
    'Artifact ' +
    asset.name +
    ' successfully finalized. Artifact ID ' +
    asset.id;
  const checksum = 'SHA256 digest of uploaded artifact is ' + sha256;
  assert.ok(
    lines.some((line) => line.endsWith(finalized)),
    'Artifact ID must come from the platform upload step',
  );
  assert.ok(
    lines.some((line) => line.endsWith(checksum)),
    'Artifact digest must come from the platform upload step',
  );
  return { id: asset.id, sha256 };
}

function pinForRun(runId) {
  assert.match(
    runId,
    /^[1-9]\d*$/,
    'Usage: node scripts/pin-native-bundle.mjs RUN_ID or --check',
  );
  const path = 'repos/' + repo + '/actions/runs/' + runId;
  const run = api(path);
  verifyProducer(
    run,
    api('repos/' + repo + '/actions/workflows/' + workflow).id,
  );
  if (
    spawnSync('git', ['cat-file', '-e', run.head_sha + '^{commit}']).status !==
    0
  ) {
    execFileSync('git', [
      'fetch',
      '--no-tags',
      '--depth=1',
      'https://github.com/' + repo + '.git',
      run.head_sha,
    ]);
  }
  assert.equal(
    spawnSync('git', [
      'diff',
      '--quiet',
      run.head_sha,
      'HEAD',
      '--',
      ...nativeInputPaths,
    ]).status,
    0,
    'The producer must match the reviewed native sources and build workflow',
  );
  if (run.head_branch.startsWith('ci/native-bundle/')) {
    // An off-branch build also executes SDK setup and qualification code.
    // Compare its complete checkout with the proposed commit before trusting its uploads.
    assert.equal(
      spawnSync('git', [
        'diff',
        '--quiet',
        run.head_sha,
        'HEAD',
        '--',
        '.',
        ':(exclude).github/native-bundle.json',
      ]).status,
      0,
      'The producer branch must match the complete proposed tree except for the pin',
    );
  }

  function list(endpoint, field) {
    return api('--paginate', '--slurp', path + endpoint).flatMap(
      (page) => page[field],
    );
  }
  const artifacts = list('/artifacts?per_page=100', 'artifacts');
  const jobs = list('/jobs?filter=all&per_page=100', 'jobs');
  const inputs = nativeInputs();
  const platforms = {};
  for (const platform of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
    // Rerunning a failed platform keeps the other platforms' successful jobs.
    const name = 'Package and test (' + platform + ')';
    const job = jobs
      .filter((entry) => entry.name === name)
      .sort((a, b) => b.run_attempt - a.run_attempt)[0];
    assert.equal(
      job?.conclusion,
      'success',
      'Expected a qualified job for ' + platform,
    );
    assert.equal(job.run_id, run.id);
    const upload = job.steps.find((step) => step.name === uploadStep);
    assert.equal(
      upload?.conclusion,
      'success',
      'Expected a fresh native build for ' + platform,
    );
    const artifactName =
      'native-' + inputs + '-' + platform + '-' + job.run_attempt + '.tar.gz';
    const matches = artifacts.filter(
      (asset) => !asset.expired && asset.name === artifactName,
    );
    assert.equal(
      matches.length,
      1,
      'Expected one fresh bundle for ' + platform,
    );
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
    platforms[platform] = verifyUpload(name, matches[0], log);
  }
  return { run: run.id, source: run.head_sha, inputs, platforms };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const manifest = '.github/native-bundle.json';
  const check = process.argv[2] === '--check';
  const proposed = check
    ? JSON.parse(readFileSync(manifest, 'utf8'))
    : undefined;
  const verified = pinForRun(
    check ? String(proposed.run) : (process.argv[2] ?? ''),
  );
  if (check) {
    assert.deepEqual(
      proposed,
      verified,
      'The proposed pin must match the verified uploads',
    );
    console.log('Verified native bundles from run ' + verified.run);
  } else {
    const temp = manifest + '.' + process.pid;
    writeFileSync(temp, JSON.stringify(verified, null, 2) + '\n');
    renameSync(temp, manifest);
    console.log(
      'Pinned native bundles from run ' +
        verified.run +
        ' (' +
        verified.source +
        ')',
    );
  }
}
