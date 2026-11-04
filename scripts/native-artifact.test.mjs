import { URL } from 'node:url';
import process from 'node:process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  copyNativeArtifact,
  nativeHelpers,
  nativeHosts,
  nativeInputIdentity,
  nativeInputs,
  verifyNativeReceipt,
} from '../packages/agents/scripts/native-receipt.mjs';
import { resolveNativeDonor } from '../packages/agents/scripts/native-donor.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const commit = (letter) => letter.repeat(40);

function fixture(platform = 'linux-x64') {
  const repository = mkdtempSync(join(tmpdir(), 'native-artifact-'));
  const packageRoot = join(repository, 'packages/agents');
  const series = JSON.stringify({ patches: [], result_tree: commit('c') });
  const inputs = {
    'native/CODEX_REVISION': commit('a'),
    'native/Cargo.toml': `rmcp = { git = "https://github.com/modelcontextprotocol/rust-sdk", rev = "${commit('b')}", version = "=3.3.0" }\n`,
    'native/Cargo.lock': 'lock',
    'native/build.rs': 'build',
    'native/tests/fixtures/exec_server.rs': 'fixture',
    'native/rust/lib.rs': 'native source',
    'native/patches/series.json': series,
    'native/rmcp-patches/series.json': series,
    'scripts/producer.mjs': 'producer recipe',
  };
  const write = (name, bytes) => {
    const path = join(packageRoot, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  for (const [name, bytes] of Object.entries(inputs)) write(name, bytes);
  const products = ['native/codex.node', ...nativeHelpers(platform)];
  for (const name of products) {
    write(name, name);
    chmodSync(join(packageRoot, name), 0o755);
  }
  const source = (revision) => ({
    revision,
    result_tree: commit('c'),
    manifest_sha256: sha(series),
    patches: [],
  });
  const receipt = {
    format: 'reviewed-native-v1',
    release: true,
    host: nativeHosts[platform],
    sources: { codex: source(commit('a')), 'rust-sdk': source(commit('b')) },
    inputs: Object.fromEntries(
      Object.entries(inputs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => [name, sha(bytes)]),
    ),
    products: Object.fromEntries(
      products.map((name) => [name, `sha256:${sha(name)}`]),
    ),
  };
  write('native/build-receipt.json', JSON.stringify(receipt));
  return {
    repository,
    packageRoot,
    receipt,
    write,
    dispose: () => rmSync(repository, { recursive: true, force: true }),
  };
}

test('native-only artifacts restore with no compiler and leave current SDK source intact', async () => {
  const f = fixture();
  try {
    assert.deepEqual(
      Object.keys(nativeInputs(f.packageRoot)).sort(),
      Object.keys(f.receipt.inputs).sort(),
    );
    const identity = nativeInputIdentity(f.packageRoot);
    const staging = join(f.repository, 'donor');
    await copyNativeArtifact(f.repository, 'linux-x64', staging);
    f.write('src/index.ts', 'CURRENT JavaScript');
    assert.equal(nativeInputIdentity(f.packageRoot), identity);
    for (const name of Object.keys(f.receipt.products))
      rmSync(join(f.packageRoot, name));
    for (const name of nativeHelpers('linux-x64'))
      chmodSync(join(staging, name), 0o644);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = '';
      await copyNativeArtifact(
        f.repository,
        'linux-x64',
        f.packageRoot,
        staging,
      );
    } finally {
      process.env.PATH = oldPath;
    }
    assert.equal(
      readFileSync(join(f.packageRoot, 'src/index.ts'), 'utf8'),
      'CURRENT JavaScript',
    );
    assert.equal(
      sha(readFileSync(join(f.packageRoot, 'native/codex.node'))),
      sha('native/codex.node'),
    );
    assert.ok(
      lstatSync(join(f.packageRoot, nativeHelpers('linux-x64')[0])).mode &
        0o111,
    );
  } finally {
    f.dispose();
  }
});

test('receipt reuse rejects changed, missing and newly added native inputs and policy helpers', async () => {
  for (const mutation of ['changed', 'missing', 'added', 'selector']) {
    const f = fixture();
    try {
      if (mutation === 'changed') f.write('native/rust/lib.rs', 'changed');
      if (mutation === 'missing')
        rmSync(join(f.packageRoot, 'native/rust/lib.rs'));
      if (mutation === 'added') f.write('native/rust/new.rs', 'new');
      if (mutation === 'selector')
        f.write('scripts/native-donor.mjs', 'new selection policy');
      await assert.rejects(
        verifyNativeReceipt(f.repository, 'linux-x64'),
        /input inventory/,
      );
    } finally {
      f.dispose();
    }
  }
});

test('receipt reuse rejects wrong host, debug builds, source identity, inventory and binary corruption', async () => {
  for (const mutation of [
    'host',
    'debug',
    'source',
    'inventory',
    'binary',
    'missing-input',
  ]) {
    const f = fixture();
    try {
      if (mutation === 'host') f.receipt.host = nativeHosts['win32-x64'];
      if (mutation === 'debug') f.receipt.release = false;
      if (mutation === 'source')
        f.receipt.sources['rust-sdk'].result_tree = commit('d');
      if (mutation === 'inventory')
        f.receipt.products['bin/extra'] = 'sha256:bad';
      if (mutation === 'binary') f.write('native/codex.node', 'tampered');
      if (mutation === 'missing-input')
        delete f.receipt.inputs['native/rust/lib.rs'];
      f.write('native/build-receipt.json', JSON.stringify(f.receipt));
      await assert.rejects(verifyNativeReceipt(f.repository, 'linux-x64'));
    } finally {
      f.dispose();
    }
  }
});

test('private donor staging rejects additional files and symbolic links before copying', async () => {
  for (const symlink of [false, true]) {
    const f = fixture();
    try {
      const staging = join(f.repository, 'donor');
      await copyNativeArtifact(f.repository, 'linux-x64', staging);
      if (symlink) {
        rmSync(join(staging, 'native/codex.node'));
        symlinkSync(
          join(f.packageRoot, 'native/codex.node'),
          join(staging, 'native/codex.node'),
        );
      } else writeFileSync(join(staging, 'unexpected'), 'extra');
      await assert.rejects(
        copyNativeArtifact(f.repository, 'linux-x64', f.packageRoot, staging),
        /symlink|Unexpected native artifact/,
      );
    } finally {
      f.dispose();
    }
  }
});

function donorFixture() {
  const context = {
    eventName: 'pull_request',
    sha: commit('d'),
    repo: { owner: 'openai', repo: 'openai-agents-js' },
    payload: {
      repository: { id: 1 },
      pull_request: {
        number: 9,
        head: { sha: commit('d'), repo: { id: 1 } },
        base: { sha: commit('c') },
      },
    },
  };
  const artifact = {
    id: 10,
    name: 'exact-native-key',
    expired: false,
    created_at: '2026-11-04T00:00:01Z',
    workflow_run: {
      id: 20,
      repository_id: 1,
      head_repository_id: 1,
      head_branch: 'feat/codex-harness',
    },
  };
  const run = {
    id: 20,
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_branch: 'feat/codex-harness',
    head_sha: commit('b'),
    repository: { id: 1 },
    head_repository: { id: 1 },
    path: '.github/workflows/alpha-release-artifacts.yml',
    pull_requests: [],
    referenced_workflows: [
      {
        path: `openai/openai-agents-js/.github/workflows/alpha-native-package.yml@${commit('b')}`,
        sha: commit('b'),
        ref: 'refs/heads/feat/codex-harness',
      },
    ],
  };
  const job = {
    name: 'package / Package and test (linux-x64)',
    conclusion: 'success',
    steps: [
      { name: 'Build native products', conclusion: 'success' },
      {
        name: 'Upload native products',
        conclusion: 'success',
        started_at: '2026-11-04T00:00:00Z',
        completed_at: '2026-11-04T00:00:02Z',
      },
      { name: 'Test the extracted bundles', conclusion: 'success' },
    ],
  };
  const files = { type: 'file', sha: commit('e') };
  const listing = { total_count: 1, artifacts: [artifact] };
  const github = {
    rest: {
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          const [base, head] = basehead.split('...');
          return {
            data: {
              status: head >= base ? 'ahead' : 'behind',
              behind_by: head >= base ? 0 : 1,
            },
          };
        },
        getContent: async () => ({ data: files }),
        getCommit: async ({ ref }) => ({
          data: {
            sha: ref,
            parents: [{ sha: commit('a') }, { sha: run.head_sha }],
          },
        }),
      },
      actions: {
        listArtifactsForRepo: async () => ({ data: listing }),
        getWorkflowRun: async () => ({ data: run }),
        listJobsForWorkflowRun: async () => ({
          data: { total_count: 1, jobs: [job] },
        }),
      },
    },
  };
  const resolve = () =>
    resolveNativeDonor({
      github,
      context,
      name: artifact.name,
      recipe: commit('e'),
      platform: 'linux-x64',
    });
  return { context, artifact, run, job, files, listing, resolve, github };
}

test('canonical exact native donors require an ancestor and successful fresh producer', async () => {
  const f = donorFixture();
  assert.deepEqual(await f.resolve(), { artifactId: 10, runId: 20 });
  f.run.head_sha = commit('f');
  assert.equal(await f.resolve(), undefined);
});

test('same-PR reuse uses immutable execution identity and never promotes into push builds', async () => {
  const f = donorFixture();
  f.run.event = 'pull_request';
  f.run.head_sha = commit('c');
  f.run.referenced_workflows = [
    {
      path: `openai/openai-agents-js/.github/workflows/alpha-native-package.yml@${commit('f')}`,
      sha: commit('f'),
      ref: 'refs/pull/9/merge',
    },
  ];
  f.run.pull_requests = [
    {
      number: 9,
      head: { sha: commit('c'), repo: { id: 1 } },
      base: { sha: commit('b') },
    },
  ];
  assert.deepEqual(await f.resolve(), { artifactId: 10, runId: 20 });
  f.run.pull_requests[0].number = 8;
  assert.equal(await f.resolve(), undefined);
  f.run.pull_requests[0].number = 9;
  f.context.eventName = 'push';
  assert.equal(await f.resolve(), undefined);
  f.context.eventName = 'pull_request';
  f.context.payload.pull_request.base.sha = commit('e');
  f.run.pull_requests[0].head.sha = commit('d');
  f.run.pull_requests[0].base.sha = commit('f');
  assert.deepEqual(await f.resolve(), { artifactId: 10, runId: 20 });
});

test('missing, expired and unsuccessful donors fall back to a fresh build', async () => {
  for (const mutation of ['missing', 'expired', 'failed']) {
    const f = donorFixture();
    if (mutation === 'missing') {
      f.listing.total_count = 0;
      f.listing.artifacts = [];
    }
    if (mutation === 'expired') f.artifact.expired = true;
    if (mutation === 'failed') f.run.conclusion = 'failure';
    assert.equal(await f.resolve(), undefined);
  }
});

test('incomplete reads, foreign provenance, altered recipes and unqualified payloads fail visibly', async () => {
  for (const mutation of [
    'incomplete',
    'foreign',
    'recipe',
    'not-file',
    'not-fresh',
    'not-qualified',
    'wrong-upload',
  ]) {
    const f = donorFixture();
    if (mutation === 'incomplete') f.listing.total_count = 2;
    if (mutation === 'foreign') f.artifact.workflow_run.head_repository_id = 2;
    if (mutation === 'recipe') f.files.sha = commit('f');
    if (mutation === 'not-file') f.files.type = 'dir';
    if (mutation === 'not-fresh') f.job.steps[0].conclusion = 'skipped';
    if (mutation === 'not-qualified') f.job.steps[2].conclusion = 'failure';
    if (mutation === 'wrong-upload')
      f.artifact.created_at = '2026-11-03T00:00:00Z';
    await assert.rejects(f.resolve());
  }
});

test('Windows donors keep the exact executable helper inventory', async () => {
  const f = fixture('win32-x64');
  try {
    const staging = join(f.repository, 'windows-donor');
    await copyNativeArtifact(f.repository, 'win32-x64', staging);
    await copyNativeArtifact(f.repository, 'win32-x64', f.packageRoot, staging);
    const receipt = JSON.parse(
      readFileSync(join(staging, 'native/build-receipt.json'), 'utf8'),
    );
    assert.deepEqual(
      Object.keys(receipt.products).sort(),
      [
        'native/codex.node',
        'bin/codex-sdk-runtime.exe',
        'bin/codex-code-mode-host.exe',
      ].sort(),
    );
  } finally {
    f.dispose();
  }
});

test('a crowded native history searches only the newest bounded page and can build fresh', async () => {
  const f = donorFixture();
  f.listing.total_count = 45;
  f.listing.artifacts = Array.from({ length: 20 }, (_, index) => ({
    ...f.artifact,
    id: 10 + index,
  }));
  assert.deepEqual(await f.resolve(), { artifactId: 10, runId: 20 });
  f.run.conclusion = 'failure';
  assert.equal(await f.resolve(), undefined);
  f.listing.artifacts.pop();
  await assert.rejects(f.resolve(), /Incomplete artifact page/);
});

test('native identity rejects unsupported input file and directory aliases', () => {
  for (const alias of ['fixed', 'leaf', 'directory', 'fixture-directory']) {
    const f = fixture();
    try {
      if (alias === 'fixed') {
        rmSync(join(f.packageRoot, 'native/Cargo.lock'));
        symlinkSync(
          join(f.packageRoot, 'native/rust/lib.rs'),
          join(f.packageRoot, 'native/Cargo.lock'),
        );
      } else if (alias === 'leaf') {
        rmSync(join(f.packageRoot, 'native/rust/lib.rs'));
        symlinkSync(
          join(f.packageRoot, 'scripts/producer.mjs'),
          join(f.packageRoot, 'native/rust/lib.rs'),
        );
      } else {
        const directory =
          alias === 'directory' ? 'native/rust' : 'native/tests/fixtures';
        rmSync(join(f.packageRoot, directory), { recursive: true });
        symlinkSync(
          join(f.packageRoot, 'scripts'),
          join(f.packageRoot, directory),
          'junction',
        );
      }
      assert.throws(
        () => nativeInputIdentity(f.packageRoot),
        /regular|aliases/,
      );
    } finally {
      f.dispose();
    }
  }
});

function samePRExecutionFixture() {
  const f = donorFixture();
  f.run.event = 'pull_request';
  f.run.head_sha = commit('c');
  f.run.pull_requests = [
    {
      number: 9,
      head: { sha: commit('d'), repo: { id: 1 } },
      base: { sha: commit('f') },
    },
  ];
  f.run.referenced_workflows = [
    {
      path: `openai/openai-agents-js/.github/workflows/alpha-native-package.yml@${commit('f')}`,
      sha: commit('f'),
      ref: 'refs/pull/9/merge',
    },
  ];
  return f;
}

test('real advanced PR association metadata does not replace the immutable run head', async () => {
  const observed = JSON.parse(
    readFileSync(
      new URL('./fixtures/native-run-live-pr.json', import.meta.url),
      'utf8',
    ),
  );
  assert.notEqual(observed.head_sha, observed.pull_requests[0].head.sha);
  const f = samePRExecutionFixture();
  Object.assign(f.run, observed, {
    status: 'completed',
    conclusion: 'success',
    referenced_workflows: f.run.referenced_workflows,
  });
  const repositoryId = observed.repository.id;
  f.context.payload.repository.id = repositoryId;
  f.context.payload.pull_request = observed.pull_requests[0];
  f.artifact.workflow_run.id = observed.id;
  f.artifact.workflow_run.repository_id = repositoryId;
  f.artifact.workflow_run.head_repository_id = repositoryId;
  f.run.referenced_workflows[0].ref = `refs/pull/${observed.pull_requests[0].number}/merge`;
  assert.deepEqual(await f.resolve(), { artifactId: 10, runId: observed.id });
});

test('a rewound live base cannot substitute a head-file recipe for the executed merge recipe', async () => {
  const f = samePRExecutionFixture();
  f.context.payload.pull_request.base.sha = commit('a');
  f.run.pull_requests[0].base.sha = commit('a');
  f.github.rest.repos.getContent = async ({ ref }) => ({
    data: {
      type: 'file',
      sha: ref === commit('f') ? commit('f') : commit('e'),
    },
  });
  await assert.rejects(f.resolve(), /recipe changed/);
});

test('native donors reject absent, ambiguous, foreign and wrong-ref execution references', async () => {
  for (const invalid of [
    'absent',
    'ambiguous',
    'foreign',
    'wrong-ref',
    'mutable-path',
    'wrong-parent',
    'not-merge',
  ]) {
    const f = samePRExecutionFixture();
    if (invalid === 'absent') f.run.referenced_workflows = [];
    if (invalid === 'ambiguous')
      f.run.referenced_workflows.push({ ...f.run.referenced_workflows[0] });
    if (invalid === 'foreign')
      f.run.referenced_workflows[0].path = `other/repository/.github/workflows/alpha-native-package.yml@${commit('f')}`;
    if (invalid === 'wrong-ref')
      f.run.referenced_workflows[0].ref = 'refs/pull/8/merge';
    if (invalid === 'mutable-path')
      f.run.referenced_workflows[0].path =
        'openai/openai-agents-js/.github/workflows/alpha-native-package.yml@refs/heads/main';
    if (invalid === 'wrong-parent')
      f.github.rest.repos.getCommit = async ({ ref }) => ({
        data: {
          sha: ref,
          parents: [{ sha: commit('a') }, { sha: commit('b') }],
        },
      });
    if (invalid === 'not-merge')
      f.github.rest.repos.getCommit = async ({ ref }) => ({
        data: { sha: ref, parents: [{ sha: f.run.head_sha }] },
      });
    await assert.rejects(f.resolve());
  }
});

test('canonical producer execution must resolve to its immutable push commit and branch', async () => {
  for (const invalid of ['commit', 'branch']) {
    const f = donorFixture();
    if (invalid === 'commit')
      f.run.referenced_workflows[0] = {
        path: `openai/openai-agents-js/.github/workflows/alpha-native-package.yml@${commit('f')}`,
        sha: commit('f'),
        ref: 'refs/heads/feat/codex-harness',
      };
    if (invalid === 'branch')
      f.run.referenced_workflows[0].ref = 'refs/heads/other';
    await assert.rejects(f.resolve());
  }
});
