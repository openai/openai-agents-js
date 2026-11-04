import assert from 'node:assert/strict';

const workflowPath = '.github/workflows/alpha-release-artifacts.yml';
const shaPattern = /^[a-f0-9]{40}$/;
const MAX_CANDIDATES = 20;

export async function resolveNativeDonor({
  github,
  context,
  name,
  recipe,
  platform,
}) {
  const repo = context.repo;
  const repositoryId = context.payload.repository.id;
  const pr =
    context.eventName === 'pull_request'
      ? context.payload.pull_request
      : undefined;
  const currentHead = pr?.head.sha ?? context.sha;
  assert.match(currentHead, shaPattern);
  assert.match(recipe, shaPattern);
  assert.ok(Number.isSafeInteger(repositoryId), 'Missing repository identity');
  if (pr) assert.equal(pr.head.repo.id, repositoryId, 'Foreign PR source');
  const comparisons = new Map();
  async function ancestor(base, head) {
    assert.match(base, shaPattern);
    assert.match(head, shaPattern);
    if (base === head) return true;
    const key = `${base}...${head}`;
    if (!comparisons.has(key)) {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        ...repo,
        basehead: key,
      });
      assert.ok(
        ['ahead', 'behind', 'identical', 'diverged'].includes(data.status) &&
          Number.isSafeInteger(data.behind_by),
        'Incomplete ancestry response',
      );
      comparisons.set(
        key,
        ['ahead', 'identical'].includes(data.status) && data.behind_by === 0,
      );
    }
    return comparisons.get(key);
  }
  // For PRs, the checked-out head must include the base that contributed to the executed workflow.
  if (pr && !(await ancestor(pr.base.sha, currentHead))) return undefined;
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
  const artifacts = data.artifacts.filter((artifact) => !artifact.expired);
  artifacts.sort(
    (a, b) =>
      Number(b.workflow_run?.head_branch === 'feat/codex-harness') -
        Number(a.workflow_run?.head_branch === 'feat/codex-harness') ||
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
    assert.equal(
      artifact.workflow_run.head_repository_id,
      repositoryId,
      'Foreign artifact source',
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
    assert.ok(
      typeof run.status === 'string' &&
        (run.status !== 'completed' || typeof run.conclusion === 'string'),
      'Incomplete producer status',
    );
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    assert.match(run.head_sha, shaPattern);
    if (run.event === 'push' && run.head_branch === 'feat/codex-harness') {
      if (!(await ancestor(run.head_sha, pr?.base.sha ?? currentHead)))
        continue;
    } else if (pr && run.event === 'pull_request') {
      assert.ok(
        Array.isArray(run.pull_requests),
        'Incomplete producer PR identity',
      );
      const producerPR = run.pull_requests.find(
        (entry) => entry.number === pr.number,
      );
      if (!producerPR) continue;
      assert.equal(
        producerPR.head.repo.id,
        repositoryId,
        'Foreign producer PR source',
      );
      assert.equal(
        producerPR.head.sha,
        run.head_sha,
        'Producer PR head differs from run',
      );
      if (
        !(await ancestor(run.head_sha, currentHead)) ||
        !(await ancestor(pr.base.sha, run.head_sha)) ||
        !(await ancestor(producerPR.base.sha, pr.base.sha))
      )
        continue;
    } else continue;
    assert.equal(run.repository.id, repositoryId, 'Foreign producer run');
    assert.equal(
      run.head_repository.id,
      repositoryId,
      'Foreign producer checkout',
    );
    assert.equal(run.path, workflowPath, 'Unexpected producer workflow');
    const { data: file } = await github.rest.repos.getContent({
      ...repo,
      path: workflowPath,
      ref: run.head_sha,
    });
    assert.ok(
      file &&
        !Array.isArray(file) &&
        file.type === 'file' &&
        shaPattern.test(file.sha),
      'Incomplete producer recipe',
    );
    assert.equal(file.sha, recipe, 'Producer workflow recipe changed');
    const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
      ...repo,
      run_id: run.id,
      filter: 'all',
      per_page: 100,
    });
    assert.ok(
      Array.isArray(jobs.jobs) && Number.isSafeInteger(jobs.total_count),
      'Incomplete producer jobs',
    );
    assert.equal(
      jobs.jobs.length,
      Math.min(jobs.total_count, 100),
      'Incomplete producer job page',
    );
    if (jobs.total_count > 100) continue;
    const created = Date.parse(artifact.created_at);
    assert.ok(Number.isFinite(created), 'Missing artifact creation time');
    const qualified = jobs.jobs.some((job) => {
      if (
        job.name !== `Package and test (${platform})` ||
        job.conclusion !== 'success'
      )
        return false;
      const steps = job.steps;
      assert.ok(Array.isArray(steps), 'Incomplete producer steps');
      const fresh = steps.find((step) => step.name === 'Build native products');
      const upload = steps.find(
        (step) => step.name === 'Upload native products',
      );
      const qualification = steps.find(
        (step) => step.name === 'Test the extracted bundles',
      );
      return (
        fresh?.conclusion === 'success' &&
        upload?.conclusion === 'success' &&
        qualification?.conclusion === 'success' &&
        created >= Date.parse(upload.started_at) &&
        created < Date.parse(upload.completed_at) + 1000
      );
    });
    assert.ok(
      qualified,
      'Native artifact lacks a successful fresh producer and qualification',
    );
    return { artifactId: artifact.id, runId: run.id };
  }
  return undefined;
}
