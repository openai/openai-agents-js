import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { executedNativeRecipe } from '../packages/agents/scripts/native-donor.mjs';
import { captureNativeScope } from '../packages/agents/scripts/native-scope.mjs';

const owner = 'openai';
const repo = 'openai-agents-js';
const fullName = `${owner}/${repo}`;
const sha = (letter) => letter.repeat(40);
const workflow = (name) => `.github/workflows/${name}.yml`;
const direct = workflow('alpha-release-artifacts');
const stacked = workflow('stacked-executor-policy');
const native = workflow('alpha-native-package');
const sdk = workflow('alpha-sdk-package');
const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('direct and stacked native routes run only eligible repository events', () => {
  const conditions = [direct, native, sdk].flatMap((path) =>
    [...source(path).matchAll(/^ {4}if: >-\n((?: {6}.+\n)+)/gm)].map(
      (match) => ({ path, expression: match[1] }),
    ),
  );
  assert.equal(conditions.length, 6);
  const cases = [
    { event: 'push', expected: true },
    { event: 'push', deleted: true, expected: false },
    { event: 'pull_request', base: 'feat/codex-harness', expected: false },
    { event: 'pull_request', base: 'main', expected: false },
    { event: 'pull_request', base: 'feat/executor-policy', expected: true },
    {
      event: 'pull_request',
      base: 'feat/executor-policy/nested',
      expected: true,
    },
    { event: 'pull_request', base: 'fix/executor-policy', expected: false },
    {
      event: 'pull_request',
      base: 'feat/codex-harness',
      fork: true,
      expected: true,
    },
    {
      event: 'pull_request',
      base: 'feat/executor-policy',
      fork: true,
      expected: true,
    },
    { event: 'workflow_dispatch', expected: false },
    { event: 'push', foreign: true, expected: false },
  ];
  for (const { path, expression } of conditions) {
    for (const entry of cases) {
      const github = {
        repository: entry.foreign ? 'someone/fork' : fullName,
        event_name: entry.event,
        event: {
          deleted: entry.deleted,
          pull_request: {
            head: {
              repo: { full_name: entry.fork ? 'someone/fork' : fullName },
            },
            base: { ref: entry.base },
          },
        },
      };
      assert.equal(
        runInNewContext(expression, {
          github,
          startsWith: (value, prefix) => value.startsWith(prefix),
        }),
        entry.expected,
        `${path}: ${JSON.stringify(entry)}`,
      );
    }
  }
});

test('owned stacked PR captures its merge source and existing PR scope', async () => {
  const context = {
    eventName: 'pull_request',
    sha: sha('a'),
    runId: 123,
    payload: {
      repository: { id: 1 },
      pull_request: {
        number: 42,
        head: { sha: sha('b'), ref: 'feat/child', repo: { id: 1 } },
        base: { ref: 'feat/parent', repo: { id: 1 } },
      },
    },
  };
  const captured = await captureNativeScope({ context, attempt: 2 });
  assert.equal(captured.kind, 'pr');
  assert.equal(captured.source_sha, context.sha);
  assert.notEqual(captured.source_sha, context.payload.pull_request.head.sha);
  assert.equal(captured.pr_number, 42);
  assert.equal(captured.base_ref, 'feat/parent');
  assert.equal(captured.base_repository_id, 1);
  assert.equal(captured.run_attempt, 2);
  for (const base of ['main', 'feat/codex-harness', 'fix/parent']) {
    context.payload.pull_request.base.ref = base;
    await assert.rejects(
      captureNativeScope({ context, attempt: 2 }),
      /Owned direct PRs/,
    );
  }
  context.payload.pull_request.head.repo.id = 2;
  assert.equal(
    (await captureNativeScope({ context, attempt: 2 })).kind,
    'fork',
  );
});

function recipeFixture(path = direct, event = 'push') {
  const reads = [];
  const blobs = Object.fromEntries(
    [direct, stacked, native, sdk].map((path) => [path, sha('c')]),
  );
  const reference = (path) => ({
    path: `${fullName}/${path}@${sha('a')}`,
    sha: sha('a'),
    ref: event === 'push' ? 'refs/heads/feat/child' : 'refs/pull/42/merge',
  });
  const run = {
    path,
    event,
    head_sha: event === 'push' ? sha('a') : sha('b'),
    head_branch: 'feat/child',
    // The SDK callee need not be scheduled during native publication.
    referenced_workflows: [
      reference(native),
      ...(path === stacked ? [reference(direct)] : []),
    ],
  };
  const github = {
    rest: {
      repos: {
        getContent: async ({ path, ref }) => {
          reads.push({ path, ref });
          return { data: { type: 'file', sha: blobs[path] } };
        },
      },
    },
  };
  return {
    reads,
    blobs,
    run,
    reference,
    evaluate: () =>
      executedNativeRecipe({
        github,
        repo: { owner, repo },
        run,
        workflowSha: sha('a'),
      }),
  };
}

test('push and stacked routes bind the same four immutable workflow blobs before SDK execution', async () => {
  const push = recipeFixture();
  const pr = recipeFixture(stacked, 'pull_request');
  const directRecipe = await push.evaluate();
  assert.equal(await pr.evaluate(), directRecipe);
  assert.deepEqual(
    pr.reads,
    [direct, stacked, native, sdk].map((path) => ({ path, ref: sha('a') })),
  );
  for (const path of [direct, stacked, native, sdk]) {
    pr.blobs[path] = sha('d');
    assert.notEqual(await pr.evaluate(), directRecipe, path);
    pr.blobs[path] = sha('c');
  }
  pr.run.referenced_workflows.push(pr.reference(sdk));
  assert.equal(await pr.evaluate(), directRecipe);
});

test('stacked recipes reject missing, mutable, foreign and mismatched callee authority', async () => {
  const mutations = [
    (f) => {
      f.run.path = workflow('unrecognized');
    },
    (f) => {
      f.run.event = 'push';
    },
    (f) => {
      f.run.referenced_workflows.shift();
    },
    (f) => {
      f.run.referenced_workflows.pop();
    },
    (f) => {
      f.run.referenced_workflows[1].sha = sha('b');
    },
    (f) => {
      f.run.referenced_workflows[1].path = `${fullName}/${direct}@main`;
    },
    (f) => {
      f.run.referenced_workflows.push({ ...f.reference(sdk), sha: sha('b') });
    },
    (f) => {
      f.run.referenced_workflows.push({
        ...f.reference(sdk),
        path: `someone/fork/${sdk}@${sha('a')}`,
      });
    },
  ];
  for (const mutate of mutations) {
    const fixture = recipeFixture(stacked, 'pull_request');
    mutate(fixture);
    await assert.rejects(fixture.evaluate());
    assert.equal(fixture.reads.length, 0);
  }
});
