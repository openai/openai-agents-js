import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const canonicalBranch = (branch) =>
  ['main', 'feat/codex-harness'].includes(branch);
export const scopeFile = 'native/snapshot-provenance.json';

export function validateNativeScope(scope) {
  assert.equal(
    scope?.format,
    'native-snapshot-scope-v1',
    'Invalid native snapshot scope',
  );
  assert.ok(
    ['canonical', 'pr', 'unscoped', 'fork'].includes(scope.kind),
    'Invalid native snapshot scope kind',
  );
  for (const key of [
    'repository_id',
    'head_repository_id',
    'run_id',
    'run_attempt',
  ])
    assert.ok(
      Number.isSafeInteger(scope[key]) && scope[key] > 0,
      `Missing snapshot ${key}`,
    );
  assert.match(scope.source_sha, /^[a-f0-9]{40}$/);
  assert.ok(
    typeof scope.head_ref === 'string' && scope.head_ref.length > 0,
    'Missing snapshot branch',
  );
  if (scope.kind === 'pr' || scope.kind === 'fork') {
    assert.ok(
      Number.isSafeInteger(scope.pr_number) && scope.pr_number > 0,
      'Missing captured PR number',
    );
    assert.ok(
      Number.isSafeInteger(scope.base_repository_id) &&
        scope.base_repository_id > 0,
      'Missing captured base repository',
    );
    assert.ok(
      typeof scope.base_ref === 'string' && scope.base_ref.length > 0,
      'Missing captured base ref',
    );
  } else assert.equal(scope.pr_number, null, 'Unexpected PR identity');
  if (scope.kind === 'canonical')
    assert.ok(canonicalBranch(scope.head_ref), 'Noncanonical snapshot branch');
  if (scope.kind !== 'fork')
    assert.equal(
      scope.head_repository_id,
      scope.repository_id,
      'Foreign push source',
    );
  return scope;
}

export async function captureNativeScope({ github, context, attempt }) {
  const id = context.payload.repository.id;
  const pr =
    context.eventName === 'pull_request'
      ? context.payload.pull_request
      : undefined;
  const common = {
    format: 'native-snapshot-scope-v1',
    repository_id: id,
    head_repository_id: pr?.head.repo.id ?? id,
    source_sha: pr?.head.sha ?? context.sha,
    head_ref: pr?.head.ref ?? context.ref.replace(/^refs\/heads\//, ''),
    run_id: context.runId,
    run_attempt: attempt,
    pr_number: null,
    base_repository_id: null,
    base_ref: null,
  };
  if (pr) {
    assert.notEqual(pr.head.repo.id, id, 'Owned PRs use the push pipeline');
    return validateNativeScope({
      ...common,
      kind: 'fork',
      pr_number: pr.number,
      base_repository_id: pr.base.repo.id,
      base_ref: pr.base.ref,
    });
  }
  assert.equal(context.eventName, 'push', 'Unsupported native producer event');
  assert.notEqual(
    context.payload.deleted,
    true,
    'Branch deletion cannot produce native snapshots',
  );
  if (canonicalBranch(common.head_ref))
    return validateNativeScope({ ...common, kind: 'canonical' });
  const { data } = await github.rest.pulls.list({
    ...context.repo,
    state: 'open',
    head: `${context.repo.owner}:${common.head_ref}`,
    per_page: 100,
  });
  assert.ok(Array.isArray(data), 'Incomplete open PR response');
  // A bounded or ambiguous response never establishes a unique PR identity.
  if (data.length !== 1)
    return validateNativeScope({ ...common, kind: 'unscoped' });
  const match = data[0];
  assert.ok(
    match && typeof match.state === 'string',
    'Incomplete open PR identity',
  );
  if (match.state !== 'open')
    return validateNativeScope({ ...common, kind: 'unscoped' });
  assert.ok(
    Number.isSafeInteger(match.number) && match.number > 0,
    'Incomplete open PR number',
  );
  for (const side of ['head', 'base']) {
    assert.ok(
      Number.isSafeInteger(match[side]?.repo?.id) && match[side].repo.id > 0,
      'Incomplete open PR repository',
    );
    assert.ok(
      typeof match[side]?.ref === 'string' && match[side].ref.length > 0,
      'Incomplete open PR branch',
    );
  }
  assert.match(
    match.head.sha ?? '',
    /^[a-f0-9]{40}$/,
    'Incomplete open PR source',
  );
  assert.ok(
    match?.head?.repo && match?.base?.repo,
    'Incomplete open PR identity',
  );
  if (
    match.head.repo.id !== id ||
    match.base.repo.id !== id ||
    match.head.ref !== common.head_ref ||
    match.head.sha !== common.source_sha
  )
    return validateNativeScope({ ...common, kind: 'unscoped' });
  return validateNativeScope({
    ...common,
    kind: 'pr',
    pr_number: match.number,
    base_repository_id: match.base.repo.id,
    base_ref: match.base.ref,
  });
}

export function readNativeScope(directory) {
  const path = join(directory, scopeFile);
  assert.ok(
    lstatSync(path).isFile(),
    'Snapshot provenance must be a regular file',
  );
  return validateNativeScope(JSON.parse(readFileSync(path, 'utf8')));
}

export function compatibleNativeScope(record, { producer, consumer }) {
  validateNativeScope(record);
  validateNativeScope(consumer);
  for (const key of [
    'repository_id',
    'head_repository_id',
    'source_sha',
    'head_ref',
    'run_id',
    'run_attempt',
  ])
    assert.equal(
      record[key],
      producer[key],
      `Snapshot producer ${key} changed`,
    );
  if (record.kind === 'canonical') return canonicalBranch(producer.head_ref);
  if (record.kind !== 'pr' || consumer.kind !== 'pr') return false;
  return [
    'pr_number',
    'repository_id',
    'head_repository_id',
    'base_repository_id',
    'base_ref',
    'head_ref',
  ].every((key) => record[key] === consumer[key]);
}
