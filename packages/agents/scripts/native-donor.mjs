import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { canonicalBranch, validateNativeScope } from './native-scope.mjs';

const callerPath = '.github/workflows/alpha-release-artifacts.yml';
const nativePath = '.github/workflows/alpha-native-package.yml';
const sdkPath = '.github/workflows/alpha-sdk-package.yml';
const shaPattern = /^[a-f0-9]{40}$/;
const recipePattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const platforms = ['linux-x64', 'darwin-arm64', 'win32-x64'];
const MAX_CANDIDATES = 20;

export async function executedNativeRecipe({ github, repo, run, workflowSha }) {
  assert.equal(run.path, callerPath, 'Unexpected producer workflow');
  assert.match(run.head_sha, shaPattern);
  assert.ok(
    Array.isArray(run.referenced_workflows),
    'Missing executed workflow references',
  );
  const isPush = run.event === 'push';
  // Fork PRs still qualify their own current-run snapshots, but are never historical donors.
  assert.ok(
    isPush || (run.event === 'pull_request' && workflowSha),
    'Only push runs can establish donor recipe authority',
  );
  const executed = isPush ? run.head_sha : workflowSha;
  assert.match(executed, shaPattern);
  assert.ok(
    run.referenced_workflows.some((entry) =>
      entry.path?.startsWith(`${repo.owner}/${repo.repo}/${nativePath}@`),
    ),
    'Missing native workflow execution',
  );
  for (const reference of run.referenced_workflows) {
    assert.ok(
      [nativePath, sdkPath].some(
        (path) =>
          reference.path === `${repo.owner}/${repo.repo}/${path}@${executed}`,
      ),
      'Unexpected or mutable callee reference',
    );
    assert.equal(
      reference.sha,
      executed,
      'Callee did not execute at the immutable source',
    );
    if (isPush)
      assert.equal(
        reference.ref,
        `refs/heads/${run.head_branch}`,
        'Wrong native workflow branch reference',
      );
  }
  const blobs = {};
  for (const path of [callerPath, nativePath, sdkPath]) {
    const { data: file } = await github.rest.repos.getContent({
      ...repo,
      path,
      ref: executed,
    });
    assert.ok(
      file &&
        !Array.isArray(file) &&
        file.type === 'file' &&
        shaPattern.test(file.sha),
      'Incomplete executed native recipe',
    );
    blobs[path] = file.sha;
  }
  return createHash('sha256').update(JSON.stringify(blobs)).digest('hex');
}

export function committedNativeInputsMatch({ repository, from, to }) {
  assert.match(from, shaPattern);
  assert.match(to, shaPattern);
  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-only',
      '-z',
      from,
      to,
      '--',
    ],
    { cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    'Cannot completely compare committed native inputs',
  );
  // These paths execute only after native publication. Unknown changes require a fresh native build.
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .every(
      (path) =>
        path.startsWith('docs/') ||
        path.startsWith('examples/') ||
        /^packages\/[^/]+\/(?:src|test)\//.test(path) ||
        /^[^/]+\.(?:md|mdx)$/.test(path),
    );
}

const named = (job, label) =>
  job.name === label || job.name.endsWith(` / ${label}`);
const timestamp = (value) => {
  const time = Date.parse(value);
  assert.ok(Number.isFinite(time), 'Missing phase timestamp');
  return time;
};

async function runJobs(github, repo, runId) {
  const { data } = await github.rest.actions.listJobsForWorkflowRun({
    ...repo,
    run_id: runId,
    filter: 'all',
    per_page: 100,
  });
  assert.ok(
    Array.isArray(data.jobs) && Number.isSafeInteger(data.total_count),
    'Incomplete producer jobs',
  );
  assert.equal(
    data.jobs.length,
    Math.min(data.total_count, 100),
    'Incomplete producer job page',
  );
  return data.total_count > 100 ? undefined : data.jobs;
}

export function publicationBoundary(jobs) {
  const native = platforms.map((platform) => {
    const matches = jobs.filter((job) =>
      named(job, `Native publication (${platform})`),
    );
    assert.ok(matches.length > 0, 'Native phase lacks a platform publication');
    matches.sort(
      (a, b) => timestamp(b.completed_at) - timestamp(a.completed_at),
    );
    assert.equal(
      matches[0].conclusion,
      'success',
      'Native publication phase did not complete',
    );
    return matches[0];
  });
  const allNative = jobs.filter((job) =>
    platforms.some((platform) =>
      named(job, `Native publication (${platform})`),
    ),
  );
  const cutoff = Math.max(
    ...allNative.map((job) => timestamp(job.completed_at)),
  );
  for (const job of jobs.filter((entry) =>
    platforms.some((platform) => named(entry, `SDK and package (${platform})`)),
  )) {
    assert.ok(Array.isArray(job.steps), 'Incomplete SDK execution history');
    if (job.conclusion)
      assert.ok(
        job.steps.some((step) => step.name === 'Begin SDK execution'),
        'Missing SDK execution marker',
      );
  }
  const sdk = [];
  for (const job of jobs) {
    for (const step of (job.steps ?? []).filter(
      (entry) => entry.name === 'Begin SDK execution',
    )) {
      if (step.conclusion === 'skipped') continue;
      if (
        ['queued', 'pending', 'waiting'].includes(step.status) &&
        !step.conclusion &&
        !step.started_at
      )
        continue;
      // Every executed marker across all platforms and attempts must establish its start.
      sdk.push(timestamp(step.started_at));
    }
  }
  if (sdk.length)
    assert.ok(
      cutoff < Math.min(...sdk),
      'SDK execution preceded complete native publication',
    );
  return { native, cutoff, sdkStarted: sdk.length > 0 };
}

function originalPublication(
  artifact,
  jobs,
  platform,
  { requireQualification },
) {
  assert.match(artifact.digest ?? '', digestPattern);
  const boundary = publicationBoundary(jobs);
  const job = boundary.native[platforms.indexOf(platform)];
  assert.ok(job, 'Unsupported native platform');
  const upload = job.steps?.find(
    (step) => step.name === 'Publish native snapshot',
  );
  const stage = job.steps?.find(
    (step) => step.name === 'Stage native snapshot',
  );
  assert.equal(
    stage?.conclusion,
    'success',
    'Native snapshot was not staged in the pure phase',
  );
  assert.equal(
    upload?.conclusion,
    'success',
    'Native snapshot was not published in the pure phase',
  );
  const created = timestamp(artifact.created_at);
  assert.ok(
    created >= timestamp(upload.started_at) &&
      created < timestamp(upload.completed_at) + 1000 &&
      created < boundary.cutoff,
    'Artifact is not an original pre-SDK publication',
  );
  assert.ok(
    Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0,
    'Missing native publication attempt',
  );
  if (requireQualification) {
    assert.ok(boundary.sdkStarted, 'Missing SDK qualification phase');
    const qualification = jobs.filter((entry) =>
      named(entry, `SDK and package (${platform})`),
    );
    assert.ok(qualification.length > 0, 'Missing SDK qualification');
    for (const entry of qualification)
      assert.ok(
        Number.isSafeInteger(entry.run_attempt) && entry.run_attempt > 0,
        'Missing SDK qualification attempt',
      );
    qualification.sort((a, b) => b.run_attempt - a.run_attempt);
    assert.ok(
      qualification.length === 1 ||
        qualification[0].run_attempt !== qualification[1].run_attempt,
      'Ambiguous latest SDK qualification attempt',
    );
    assert.equal(
      qualification[0].conclusion,
      'success',
      'SDK qualification failed',
    );
    assert.equal(
      qualification[0].steps?.find(
        (step) => step.name === 'Test the extracted bundles',
      )?.conclusion,
      'success',
      'Native snapshot lacks extracted-package qualification',
    );
  }
  return job.run_attempt;
}

export async function validateCurrentSnapshot({
  github,
  context,
  name,
  platform,
  snapshot,
}) {
  assert.match(snapshot.artifact_id ?? '', /^[1-9]\d*$/);
  assert.match(snapshot.artifact_digest ?? '', /^[a-f0-9]{64}$/);
  assert.equal(
    snapshot.artifact_name,
    name,
    'Captured native snapshot identity changed',
  );
  const id = Number(snapshot.artifact_id);
  assert.ok(Number.isSafeInteger(id));
  const { data: artifact } = await github.rest.actions.getArtifact({
    ...context.repo,
    artifact_id: id,
  });
  assert.equal(artifact.id, id, 'Captured native artifact ID changed');
  assert.equal(artifact.name, name, 'Captured native artifact name changed');
  assert.equal(
    artifact.digest,
    `sha256:${snapshot.artifact_digest}`,
    'Captured native artifact digest changed',
  );
  assert.equal(artifact.expired, false, 'Captured native artifact expired');
  assert.equal(
    artifact.workflow_run?.id,
    context.runId,
    'Captured native artifact belongs to another run',
  );
  assert.equal(
    artifact.workflow_run.repository_id,
    context.payload.repository.id,
    'Foreign snapshot repository',
  );
  assert.equal(
    artifact.workflow_run.head_repository_id,
    context.payload.pull_request?.head.repo.id ?? context.payload.repository.id,
    'Foreign snapshot source',
  );
  const jobs = await runJobs(github, context.repo, context.runId);
  assert.ok(jobs, 'Native phase history exceeds the supported bound');
  const attempt = originalPublication(artifact, jobs, platform, {
    requireQualification: false,
  });
  const scope = validateNativeScope(JSON.parse(snapshot.provenance));
  assert.equal(scope.run_id, context.runId, 'Snapshot capture run changed');
  assert.equal(scope.run_attempt, attempt, 'Snapshot capture attempt changed');
  assert.equal(
    scope.source_sha,
    context.payload.pull_request?.head.sha ?? context.sha,
    'Snapshot capture source changed',
  );
  assert.equal(
    scope.repository_id,
    context.payload.repository.id,
    'Snapshot capture repository changed',
  );
  assert.equal(
    scope.head_repository_id,
    context.payload.pull_request?.head.repo.id ?? context.payload.repository.id,
    'Snapshot capture head repository changed',
  );
  assert.equal(
    scope.head_ref,
    context.payload.pull_request?.head.ref ??
      context.ref.replace(/^refs\/heads\//, ''),
    'Snapshot capture branch changed',
  );
  return { artifactId: id, runId: context.runId };
}

export async function resolveNativeDonor({
  github,
  context,
  name,
  recipe,
  platform,
  scope,
  repository = process.env.GITHUB_WORKSPACE ?? process.cwd(),
  inputsMatch = committedNativeInputsMatch,
}) {
  validateNativeScope(scope);
  const repo = context.repo;
  const repositoryId = context.payload.repository.id;
  assert.equal(
    `${repo.owner}/${repo.repo}`,
    'openai/openai-agents-js',
    'Foreign native donor repository',
  );
  const currentHead = scope.source_sha;
  assert.match(recipe, recipePattern);
  const { data } = await github.rest.actions.listArtifactsForRepo({
    ...repo,
    name,
    per_page: MAX_CANDIDATES,
  });
  assert.ok(
    Array.isArray(data.artifacts) && Number.isSafeInteger(data.total_count),
    'Incomplete artifact response',
  );
  assert.equal(
    data.artifacts.length,
    Math.min(data.total_count, MAX_CANDIDATES),
    'Incomplete artifact page',
  );
  const artifacts = data.artifacts
    .filter((entry) => !entry.expired)
    .sort(
      (a, b) =>
        Number(canonicalBranch(b.workflow_run?.head_branch)) -
          Number(canonicalBranch(a.workflow_run?.head_branch)) ||
        Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  for (const artifact of artifacts) {
    assert.equal(artifact.name, name, 'Unexpected native artifact name');
    assert.ok(
      Number.isSafeInteger(artifact.id) &&
        Number.isSafeInteger(artifact.workflow_run?.id),
      'Incomplete artifact producer',
    );
    assert.equal(
      artifact.workflow_run.repository_id,
      repositoryId,
      'Foreign artifact repository',
    );
    const { data: run } = await github.rest.actions.getWorkflowRun({
      ...repo,
      run_id: artifact.workflow_run.id,
    });
    assert.equal(
      run.id,
      artifact.workflow_run.id,
      'Unexpected producer run ID',
    );
    if (run.event !== 'push') continue;
    assert.equal(
      artifact.workflow_run.head_repository_id,
      repositoryId,
      'Foreign artifact source',
    );
    assert.ok(
      typeof run.status === 'string' &&
        (run.status !== 'completed' || typeof run.conclusion === 'string'),
      'Incomplete producer status',
    );
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    assert.match(run.head_sha, shaPattern);
    const canonical = canonicalBranch(run.head_branch);
    if (
      !canonical &&
      (scope.kind !== 'pr' || run.head_branch !== scope.head_ref)
    )
      continue;
    if (scope.kind === 'canonical' && !canonical) continue;
    assert.equal(run.repository.id, repositoryId, 'Foreign producer run');
    assert.equal(
      run.head_repository.id,
      repositoryId,
      'Foreign producer checkout',
    );
    if (run.head_sha !== currentHead) {
      const { data: comparison } =
        await github.rest.repos.compareCommitsWithBasehead({
          ...repo,
          basehead: `${run.head_sha}...${currentHead}`,
        });
      assert.ok(
        ['ahead', 'behind', 'identical', 'diverged'].includes(
          comparison.status,
        ) && Number.isSafeInteger(comparison.behind_by),
        'Incomplete ancestry response',
      );
      if (
        !['ahead', 'identical'].includes(comparison.status) ||
        comparison.behind_by !== 0
      )
        continue;
    }
    assert.equal(
      await executedNativeRecipe({ github, repo, run }),
      recipe,
      'Producer workflow recipe changed',
    );
    if (
      !(await inputsMatch({ repository, from: run.head_sha, to: currentHead }))
    )
      continue;
    const jobs = await runJobs(github, repo, run.id);
    if (!jobs) continue;
    const attempt = originalPublication(artifact, jobs, platform, {
      requireQualification: true,
    });
    return {
      artifactId: artifact.id,
      runId: run.id,
      digest: artifact.digest,
      expectedScope: {
        producer: {
          repository_id: repositoryId,
          head_repository_id: repositoryId,
          source_sha: run.head_sha,
          head_ref: run.head_branch,
          run_id: run.id,
          run_attempt: attempt,
        },
        consumer: scope,
      },
    };
  }
  return undefined;
}
