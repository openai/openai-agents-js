import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { nativeInputs } from './native-bundle-inputs.mjs';
import { isNativePublication } from './verified-native-bundle.mjs';

export const pin = Object.freeze({
  repository: 'openai/openai-agents-js',
  repositoryId: 993521808,
  ref: 'refs/heads/ci/hillclimb/js-current-linux-workers-37',
  source: '36e5e7dba55c42e1a5c857c98f801c2560737a46',
  sourceRef: 'ci/hillclimb/js-current-seed-34',
  run: 43473605302,
  workflow: 405439512,
  inputs: '01b831870b762e7acee2fc0f489709ecfce2ad509afa19244f575e4b4c75aafc',
  artifact: 14062324442,
  digest: 'da17fb5f1dce2d213c0b65d42838845cd3defede83bcd31f92461199d6e68a65',
});
const workflowPath = '.github/workflows/hillclimb-linux-workers.yml';
const scriptPath = 'scripts/hillclimb-linux-workers.mjs';

export function validateSource(run, jobs, artifact) {
  assert.equal(run.id, pin.run);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'push');
  assert.equal(run.repository?.full_name, pin.repository);
  assert.equal(run.repository?.id, pin.repositoryId);
  assert.equal(run.head_repository?.full_name, pin.repository);
  assert.equal(run.head_repository?.id, pin.repositoryId);
  assert.equal(run.workflow_id, pin.workflow);
  assert.equal(run.path, '.github/workflows/alpha-release-artifacts.yml');
  assert.equal(run.head_sha, pin.source);
  assert.equal(run.head_branch, pin.sourceRef);
  assert.equal(jobs.length, 9);
  assert.ok(
    jobs.every(
      (job) =>
        job.run_id === pin.run &&
        job.run_attempt === 1 &&
        job.head_sha === pin.source &&
        job.head_branch === pin.sourceRef &&
        job.status === 'completed',
    ),
  );
  const expected = [
    'Select native bundles',
    ...Object.entries({
      linux: 'linux-x64',
      'linux-arm64': 'linux-arm64',
      macos: 'darwin-arm64',
      windows: 'win32-x64',
    }).flatMap(([key, platform]) => [
      `produce-${key} / Native bundle (${platform})`,
      `Package and test (${platform})`,
    ]),
  ];
  assert.deepEqual(jobs.map((job) => job.name).sort(), expected.sort());
  assert.ok(jobs.every((job) => job.conclusion === 'success'));
  assert.equal(artifact.id, pin.artifact);
  assert.equal(artifact.expired, false);
  assert.ok(
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0,
  );
  assert.equal(artifact.name, `native-${pin.inputs}-linux-x64.tar.gz`);
  assert.equal(artifact.digest, 'sha256:' + pin.digest);
  assert.equal(artifact.workflow_run?.id, pin.run);
  assert.equal(artifact.workflow_run?.head_sha, pin.source);
  assert.equal(artifact.workflow_run?.head_branch, pin.sourceRef);
  assert.equal(artifact.workflow_run?.repository_id, pin.repositoryId);
  assert.equal(artifact.workflow_run?.head_repository_id, pin.repositoryId);
  assert.ok(isNativePublication(artifact, run, jobs, 'linux-x64'));
}

export function validateCheckout() {
  assert.equal(process.env.GITHUB_REPOSITORY, pin.repository);
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(process.env.GITHUB_REF, pin.ref);
  assert.equal(process.platform + '-' + process.arch, 'linux-x64');
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), process.env.GITHUB_SHA);
  assert.equal(git('show', '-s', '--format=%P', 'HEAD'), pin.source);
  assert.equal(git('diff', '--name-only'), '');
  assert.equal(git('diff', '--cached', '--name-only'), '');
  assert.deepEqual(
    git('diff', '--name-status', pin.source, 'HEAD').split('\n').sort(),
    [`A\t${workflowPath}`, `A\t${scriptPath}`].sort(),
  );
  assert.equal(nativeInputs(), pin.inputs);
}

async function main() {
  validateCheckout();
  assert.ok(process.env.GH_TOKEN, 'A read-only GitHub token is required');
  const api = async (path) => {
    const response = await fetch(
      `https://api.github.com/repos/${pin.repository}/${path}`,
      {
        headers: {
          Authorization: 'Bearer ' + process.env.GH_TOKEN,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(180_000),
      },
    );
    assert.ok(
      response.ok,
      'GitHub metadata request failed: ' + response.status,
    );
    return response.json();
  };
  const run = await api(`actions/runs/${pin.run}`);
  const page = await api(
    `actions/runs/${pin.run}/jobs?filter=all&per_page=100`,
  );
  assert.equal(page.total_count, page.jobs.length);
  const artifact = await api(`actions/artifacts/${pin.artifact}`);
  validateSource(run, page.jobs, artifact);
  console.log(
    `Verified diagnostic source run ${pin.run}, commit ${pin.source}, artifact ${pin.artifact}, sha256:${pin.digest}`,
  );
  execFileSync(process.execPath, ['scripts/restore-native-bundle.mjs'], {
    env: {
      ...process.env,
      NATIVE_INPUTS: pin.inputs,
      NATIVE_ARTIFACT: JSON.stringify({
        'artifact-id': String(pin.artifact),
        'artifact-digest': pin.digest,
      }),
    },
    stdio: 'inherit',
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
