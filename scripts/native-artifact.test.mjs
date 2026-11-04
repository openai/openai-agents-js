import { Buffer } from 'node:buffer';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { sourceRepository } from '../packages/agents/scripts/native-source.mjs';
import {
  captureNativeScope,
  compatibleNativeScope,
  readNativeScope,
} from '../packages/agents/scripts/native-scope.mjs';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
import {
  resolveNativeDonor,
  committedNativeInputsMatch,
  publicationBoundary,
  validateCurrentSnapshot,
} from '../packages/agents/scripts/native-donor.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const commit = (letter) => letter.repeat(40);

const fixturePlatform = `${process.platform}-${process.arch}`;
function fixture(platform = fixturePlatform) {
  const repository = mkdtempSync(join(tmpdir(), 'native-artifact-'));
  const packageRoot = join(repository, 'packages/agents');
  const series = JSON.stringify({ patches: [], result_tree: commit('c') });
  const inputs = {
    'native/CODEX_REVISION': commit('a'),
    'native/index.js': 'native binding loader',
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
    await copyNativeArtifact(f.repository, fixturePlatform, staging);
    f.write('src/index.ts', 'CURRENT JavaScript');
    assert.equal(nativeInputIdentity(f.packageRoot), identity);
    for (const name of Object.keys(f.receipt.products))
      rmSync(join(f.packageRoot, name));
    for (const name of nativeHelpers(fixturePlatform))
      chmodSync(join(staging, name), 0o644);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = '';
      await copyNativeArtifact(
        f.repository,
        fixturePlatform,
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
    if (process.platform !== 'win32')
      assert.ok(
        lstatSync(join(f.packageRoot, nativeHelpers(fixturePlatform)[0])).mode &
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
        verifyNativeReceipt(f.repository, fixturePlatform),
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
      if (mutation === 'host')
        f.receipt.host =
          nativeHosts[
            fixturePlatform === 'darwin-arm64' ? 'linux-x64' : 'darwin-arm64'
          ];
      if (mutation === 'debug') f.receipt.release = false;
      if (mutation === 'source')
        f.receipt.sources['rust-sdk'].result_tree = commit('d');
      if (mutation === 'inventory')
        f.receipt.products['bin/extra'] = 'sha256:bad';
      if (mutation === 'binary') f.write('native/codex.node', 'tampered');
      if (mutation === 'missing-input')
        delete f.receipt.inputs['native/rust/lib.rs'];
      f.write('native/build-receipt.json', JSON.stringify(f.receipt));
      await assert.rejects(verifyNativeReceipt(f.repository, fixturePlatform));
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
      await copyNativeArtifact(f.repository, fixturePlatform, staging);
      if (symlink) {
        rmSync(join(staging, 'native/codex.node'));
        symlinkSync(
          join(f.packageRoot, 'native/codex.node'),
          join(staging, 'native/codex.node'),
        );
      } else writeFileSync(join(staging, 'unexpected'), 'extra');
      await assert.rejects(
        copyNativeArtifact(
          f.repository,
          fixturePlatform,
          f.packageRoot,
          staging,
        ),
        /symlink|Unexpected native artifact/,
      );
    } finally {
      f.dispose();
    }
  }
});

function donorFixture() {
  const context = {
    eventName: 'push',
    sha: commit('d'),
    ref: 'refs/heads/sdk-work',
    runId: 30,
    repo: { owner: 'openai', repo: 'openai-agents-js' },
    payload: {
      repository: { id: 1 },
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
  const nativeJobs = ['linux-x64', 'darwin-arm64', 'win32-x64'].map(
    (platform) => ({
      name: `native / Native publication (${platform})`,
      run_attempt: 1,
      conclusion: 'success',
      completed_at: '2026-11-04T00:00:04Z',
      steps: [
        { name: 'Stage native snapshot', conclusion: 'success' },
        {
          name: 'Publish native snapshot',
          conclusion: 'success',
          started_at: '2026-11-04T00:00:00Z',
          completed_at: '2026-11-04T00:00:02Z',
        },
      ],
    }),
  );
  const sdkJobs = ['linux-x64', 'darwin-arm64', 'win32-x64'].map(
    (platform) => ({
      name: `sdk / SDK and package (${platform})`,
      run_attempt: 1,
      conclusion: 'success',
      steps: [
        {
          name: 'Begin SDK execution',
          conclusion: 'success',
          started_at: '2026-11-04T00:00:06Z',
        },
        { name: 'Test the extracted bundles', conclusion: 'success' },
      ],
    }),
  );
  const job = nativeJobs[0];
  const qualification = sdkJobs[0];
  const jobs = { total_count: 6, jobs: [...nativeJobs, ...sdkJobs] };
  const comparison = { compatible: true };
  artifact.digest = `sha256:${'a'.repeat(64)}`;
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
        getArtifact: async () => ({ data: artifact }),
        listJobsForWorkflowRun: async () => ({
          data: jobs,
        }),
      },
    },
  };
  const scope = {
    format: 'native-snapshot-scope-v1',
    kind: 'pr',
    repository_id: 1,
    head_repository_id: 1,
    source_sha: commit('d'),
    head_ref: 'sdk-work',
    run_id: 30,
    run_attempt: 1,
    pr_number: 9,
    base_repository_id: 1,
    base_ref: 'feat/codex-harness',
  };
  const resolve = () =>
    resolveNativeDonor({
      github,
      context,
      scope,
      name: artifact.name,
      recipe: sha(
        JSON.stringify({
          '.github/workflows/alpha-release-artifacts.yml': commit('e'),
          '.github/workflows/alpha-native-package.yml': commit('e'),
          '.github/workflows/alpha-sdk-package.yml': commit('e'),
        }),
      ),
      inputsMatch: async () => comparison.compatible,
      platform: 'linux-x64',
    });
  return {
    context,
    scope,
    artifact,
    run,
    job,
    files,
    listing,
    resolve,
    github,
    jobs,
    nativeJobs,
    sdkJobs,
    qualification,
    comparison,
  };
}

test('canonical exact native donors require an ancestor and successful fresh producer', async () => {
  const f = donorFixture();
  assert.deepEqual(await f.resolve(), {
    artifactId: 10,
    runId: 20,
    digest: `sha256:${'a'.repeat(64)}`,
    expectedScope: {
      producer: {
        repository_id: 1,
        head_repository_id: 1,
        source_sha: f.run.head_sha,
        head_ref: f.run.head_branch,
        run_id: 20,
        run_attempt: 1,
      },
      consumer: f.scope,
    },
  });
  f.run.head_sha = commit('f');
  assert.equal(await f.resolve(), undefined);
});

test('only immutable pushes can donate, independent of live PR association metadata', async () => {
  const f = donorFixture();
  f.run.event = 'pull_request';
  assert.equal(await f.resolve(), undefined);
  f.run.event = 'push';
  f.run.head_branch = 'sdk-work';
  f.artifact.workflow_run.head_branch = 'sdk-work';
  f.run.referenced_workflows[0].ref = 'refs/heads/sdk-work';
  f.run.pull_requests = [
    { number: 99, head: { sha: commit('f') }, base: { sha: commit('a') } },
  ];
  assert.equal((await f.resolve()).artifactId, 10);
  f.scope.kind = 'canonical';
  f.scope.pr_number = null;
  f.scope.head_ref = 'main';
  assert.equal(await f.resolve(), undefined);
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
    if (mutation === 'not-qualified')
      f.qualification.steps[1].conclusion = 'failure';
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
  assert.deepEqual(await f.resolve(), {
    artifactId: 10,
    runId: 20,
    digest: `sha256:${'a'.repeat(64)}`,
    expectedScope: {
      producer: {
        repository_id: 1,
        head_repository_id: 1,
        source_sha: f.run.head_sha,
        head_ref: f.run.head_branch,
        run_id: 20,
        run_attempt: 1,
      },
      consumer: f.scope,
    },
  });
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

test('real advanced PR association metadata never qualifies a PR run as a push donor', async () => {
  const observed = JSON.parse(
    readFileSync(
      new URL('./fixtures/native-run-live-pr.json', import.meta.url),
      'utf8',
    ),
  );
  assert.notEqual(observed.head_sha, observed.pull_requests[0].head.sha);
  const f = donorFixture();
  Object.assign(f.run, observed);
  f.artifact.workflow_run.id = observed.id;
  assert.equal(await f.resolve(), undefined);
});

test('every executed callee must match immutable push authority and the exact branch', async () => {
  for (const mutation of [
    'missing',
    'foreign',
    'wrong-ref',
    'changed-callee',
    'changed-sdk',
  ]) {
    const f = donorFixture();
    if (mutation === 'missing') f.run.referenced_workflows = [];
    if (mutation === 'foreign')
      f.run.referenced_workflows[0].path =
        'foreign/repo/.github/workflows/alpha-native-package.yml@' +
        f.run.head_sha;
    if (mutation === 'wrong-ref')
      f.run.referenced_workflows[0].ref = 'refs/pull/9/merge';
    if (mutation === 'changed-callee')
      f.run.referenced_workflows[0].sha = commit('f');
    if (mutation === 'changed-sdk')
      f.run.referenced_workflows.push({
        path:
          'openai/openai-agents-js/.github/workflows/alpha-sdk-package.yml@' +
          commit('f'),
        sha: commit('f'),
        ref: 'refs/heads/feat/codex-harness',
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

test('full caller content prevents a reverted extra job from donating products', async () => {
  const f = donorFixture();
  f.github.rest.repos.getContent = async ({ path }) => ({
    data: {
      type: 'file',
      sha: path.endsWith('alpha-release-artifacts.yml')
        ? commit('f')
        : commit('e'),
    },
  });
  await assert.rejects(f.resolve(), /recipe changed/);
  f.github.rest.repos.getContent = async () => ({ data: f.files });
  f.comparison.compatible = false;
  assert.equal(await f.resolve(), undefined);
});

test('complete committed input comparison allows SDK changes but rejects reverted producer policy and Cargo configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-committed-inputs-'));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const commitAll = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '--quiet');
    mkdirSync(join(root, 'packages/agents/scripts'), { recursive: true });
    writeFileSync(join(root, 'packages/agents/scripts/native.mjs'), 'producer');
    const base = commitAll();
    mkdirSync(join(root, 'packages/agents/src'), { recursive: true });
    writeFileSync(join(root, 'packages/agents/src/index.ts'), 'current SDK');
    writeFileSync(join(root, 'CONTRIBUTING.md'), 'SDK documentation');
    const sdk = commitAll();
    assert.equal(
      committedNativeInputsMatch({ repository: root, from: base, to: sdk }),
      true,
    );
    writeFileSync(join(root, 'packages/agents/src/relocated.mjs'), 'producer');
    rmSync(join(root, 'packages/agents/scripts/native.mjs'));
    const renamed = commitAll();
    assert.equal(
      committedNativeInputsMatch({ repository: root, from: sdk, to: renamed }),
      false,
    );
    writeFileSync(join(root, 'packages/agents/scripts/native.mjs'), 'producer');
    rmSync(join(root, 'packages/agents/src/relocated.mjs'));
    commitAll();

    writeFileSync(
      join(root, 'packages/agents/scripts/native.mjs'),
      'malicious producer',
    );
    mkdirSync(join(root, '.cargo'));
    writeFileSync(
      join(root, '.cargo/config.toml'),
      'rustc-wrapper = "wrapper"',
    );
    const poisoned = commitAll();
    writeFileSync(join(root, 'packages/agents/scripts/native.mjs'), 'producer');
    rmSync(join(root, '.cargo'), { recursive: true });
    const clean = commitAll();
    assert.equal(
      committedNativeInputsMatch({
        repository: root,
        from: poisoned,
        to: clean,
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository Cargo configuration is rejected and the prepublication native loader is an input', async () => {
  for (const config of [
    '.cargo/config.toml',
    'packages/.cargo/config',
    'packages/agents/.cargo/config.toml',
    'packages/agents/native/.cargo/config',
  ]) {
    const f = fixture();
    try {
      const path = join(f.repository, config);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'rustc-wrapper = "wrapper"');
      assert.throws(
        () => nativeInputIdentity(f.packageRoot),
        /Cargo configuration/,
      );
    } finally {
      f.dispose();
    }
  }
  const f = fixture();
  try {
    f.write('native/index.js', 'changed loader');
    await assert.rejects(
      verifyNativeReceipt(f.repository, fixturePlatform),
      /input inventory/,
    );
  } finally {
    f.dispose();
  }
});

test('global publication cutoff rejects cross-platform SDK interleaving and earlier attempts', () => {
  const f = donorFixture();
  f.nativeJobs[1].completed_at = '2026-11-04T00:00:10Z';
  assert.throws(
    () => publicationBoundary(f.jobs.jobs),
    /SDK execution preceded/,
  );
  f.nativeJobs[1].completed_at = '2026-11-04T00:00:04Z';
  f.jobs.jobs.push({
    name: 'old SDK attempt',
    steps: [
      {
        name: 'Begin SDK execution',
        conclusion: 'success',
        started_at: '2026-11-04T00:00:03Z',
      },
    ],
  });
  assert.throws(
    () => publicationBoundary(f.jobs.jobs),
    /SDK execution preceded/,
  );
});

test('captured current-run IDs and digests reject post-barrier replacement', async () => {
  for (const invalid of ['none', 'id', 'digest', 'late', 'equal']) {
    const f = donorFixture();
    f.context.runId = 20;
    const snapshot = {
      artifact_id: '10',
      artifact_digest: 'a'.repeat(64),
      artifact_name: f.artifact.name,
      provenance: JSON.stringify({ ...f.scope, run_id: 20 }),
    };
    if (invalid === 'id') f.artifact.id = 11;
    if (invalid === 'digest') f.artifact.digest = `sha256:${'b'.repeat(64)}`;
    if (invalid === 'late') f.artifact.created_at = '2026-11-04T00:00:07Z';
    if (invalid === 'equal') f.artifact.created_at = '2026-11-04T00:00:04Z';
    const validate = () =>
      validateCurrentSnapshot({
        github: f.github,
        context: f.context,
        name: f.artifact.name,
        platform: 'linux-x64',
        snapshot,
      });
    if (invalid === 'none')
      assert.deepEqual(await validate(), { artifactId: 10, runId: 20 });
    else await assert.rejects(validate());
  }
});

test('earliest SDK execution survives selecting a later successful qualification attempt', async () => {
  const f = donorFixture();
  f.jobs.jobs.push({
    ...f.qualification,
    conclusion: 'failure',
    steps: [
      {
        name: 'Begin SDK execution',
        conclusion: 'success',
        started_at: '2026-11-04T00:00:03Z',
      },
      { name: 'Test the extracted bundles', conclusion: 'failure' },
    ],
  });
  f.jobs.total_count++;
  await assert.rejects(f.resolve(), /SDK execution preceded/);
  delete f.sdkJobs[1].steps;
  assert.throws(
    () => publicationBoundary(f.jobs.jobs),
    /Incomplete SDK execution history/,
  );
});

test('push scope captures a unique exact open PR before SDK execution and never learns a PR later', async () => {
  const f = donorFixture();
  const pr = {
    state: 'open',
    number: 9,
    head: { repo: { id: 1 }, ref: 'sdk-work', sha: f.context.sha },
    base: { repo: { id: 1 }, ref: 'feat/codex-harness' },
  };
  let records = [pr];
  f.github.rest.pulls = { list: async () => ({ data: records }) };
  const capture = () =>
    captureNativeScope({ github: f.github, context: f.context, attempt: 1 });
  assert.deepEqual(await capture(), f.scope);
  for (records of [
    [],
    [pr, pr],
    [{ ...pr, head: { ...pr.head, sha: commit('e') } }],
    [{ ...pr, state: 'closed' }],
  ])
    assert.equal((await capture()).kind, 'unscoped');
  records = [{}];
  await assert.rejects(capture(), /Incomplete open PR identity/);
  records = [pr];
  f.context.payload.deleted = true;
  await assert.rejects(capture(), /Branch deletion/);
  f.context.payload.deleted = false;
  f.context.ref = 'refs/heads/main';
  assert.equal((await capture()).kind, 'canonical');
  f.context.eventName = 'pull_request';
  f.context.payload.pull_request = {
    ...pr,
    head: { ...pr.head, repo: { id: 2 } },
  };
  assert.equal((await capture()).kind, 'fork');
});

test('captured provenance restricts branch snapshots to the original PR and repository without trusting later live associations', () => {
  const f = donorFixture();
  const record = { ...f.scope, source_sha: commit('b'), run_id: 20 };
  const expected = { producer: { ...record }, consumer: { ...f.scope } };
  assert.equal(compatibleNativeScope(record, expected), true);
  for (const mutation of [
    'number',
    'branch',
    'repository',
    'unscoped',
    'canonical',
  ]) {
    const consumer = { ...f.scope };
    if (mutation === 'number') consumer.pr_number = 10;
    if (mutation === 'branch') consumer.head_ref = 'other-work';
    if (mutation === 'repository') consumer.base_repository_id = 2;
    if (mutation === 'unscoped') {
      consumer.kind = 'unscoped';
      consumer.pr_number = null;
    }
    if (mutation === 'canonical') {
      consumer.kind = 'canonical';
      consumer.pr_number = null;
      consumer.head_ref = 'main';
    }
    assert.equal(
      compatibleNativeScope(record, { ...expected, consumer }),
      false,
    );
  }
  const prePr = { ...record, kind: 'unscoped', pr_number: null };
  assert.equal(compatibleNativeScope(prePr, expected), false);
  for (const key of [
    'source_sha',
    'run_id',
    'run_attempt',
    'head_ref',
    'head_repository_id',
  ])
    assert.throws(() =>
      compatibleNativeScope(
        {
          ...record,
          [key]: key.endsWith('id') || key === 'run_attempt' ? 3 : commit('a'),
        },
        expected,
      ),
    );
  const canonical = {
    ...record,
    kind: 'canonical',
    head_ref: 'feat/codex-harness',
    pr_number: null,
  };
  assert.equal(
    compatibleNativeScope(canonical, {
      producer: canonical,
      consumer: f.scope,
    }),
    true,
  );
});

test('private scope metadata is validated without copying it into the current SDK package', async () => {
  const f = fixture();
  try {
    const staging = join(f.repository, 'snapshot');
    await copyNativeArtifact(f.repository, fixturePlatform, staging);
    const scope = donorFixture().scope;
    writeFileSync(
      join(staging, 'native/snapshot-provenance.json'),
      JSON.stringify(scope),
    );
    assert.deepEqual(readNativeScope(staging), scope);
    await copyNativeArtifact(
      f.repository,
      fixturePlatform,
      f.packageRoot,
      staging,
    );
    assert.equal(
      existsSync(join(f.packageRoot, 'native/snapshot-provenance.json')),
      false,
    );
    writeFileSync(join(staging, 'native/snapshot-provenance.json'), '{}');
    assert.throws(
      () => readNativeScope(staging),
      /Invalid native snapshot scope/,
    );
  } finally {
    f.dispose();
  }
});

test('the native snapshot CLI keeps Rust off the reuse path and falls back for a different captured PR', async () => {
  const f = fixture();
  try {
    for (const name of [
      'native-artifact.mjs',
      'native-receipt.mjs',
      'native-scope.mjs',
      'native-source.mjs',
    ])
      f.write(
        'scripts/' + name,
        readFileSync(
          new URL('../packages/agents/scripts/' + name, import.meta.url),
          'utf8',
        ),
      );
    f.receipt.inputs = nativeInputs(f.packageRoot);
    f.write('native/build-receipt.json', JSON.stringify(f.receipt));
    const record = donorFixture().scope;
    const output = join(f.repository, 'outputs');
    writeFileSync(output, '');
    const staging = join(f.repository, 'native-only');
    const invoke = (command, expected) =>
      execFileSync(
        process.execPath,
        [join(f.packageRoot, 'scripts/native-artifact.mjs'), command, staging],
        {
          env: {
            ...process.env,
            PATH: '',
            EXPECTED_PLATFORM: fixturePlatform,
            GITHUB_OUTPUT: output,
            NATIVE_PROVENANCE: JSON.stringify(record),
            NATIVE_EXPECTED_PROVENANCE: JSON.stringify(expected),
          },
        },
      );
    invoke('stage');
    f.write('src/current.ts', 'CURRENT SDK source');
    f.write('native/codex.node', 'current marker');
    invoke('donor', {
      producer: record,
      consumer: { ...record, pr_number: 10 },
    });
    assert.match(readFileSync(output, 'utf8'), /usable=false/);
    assert.equal(
      readFileSync(join(f.packageRoot, 'native/codex.node'), 'utf8'),
      'current marker',
    );
    invoke('donor', { producer: record, consumer: record });
    assert.match(readFileSync(output, 'utf8'), /usable=true/);
    assert.equal(
      readFileSync(join(f.packageRoot, 'src/current.ts'), 'utf8'),
      'CURRENT SDK source',
    );
    invoke('restore', record);
    await verifyNativeReceipt(f.repository, fixturePlatform);
    writeFileSync(
      join(staging, 'native/snapshot-provenance.json'),
      JSON.stringify({ ...record, run_id: 99 }),
    );
    assert.throws(
      () => invoke('restore', record),
      /Captured snapshot provenance changed/,
    );
  } finally {
    f.dispose();
  }
});

test(
  'POSIX fixtures still reject an unexecutable native helper',
  { skip: process.platform === 'win32' },
  async () => {
    const f = fixture();
    try {
      chmodSync(join(f.packageRoot, nativeHelpers(fixturePlatform)[0]), 0o644);
      await assert.rejects(
        verifyNativeReceipt(f.repository, fixturePlatform),
        /not executable/,
      );
    } finally {
      f.dispose();
    }
  },
);

test('pinned source fetch fails visibly at its deadline without retrying or falling through to source audits', () => {
  const upstream = mkdtempSync(join(tmpdir(), 'native-fetch-'));
  const original = childProcess.spawnSync;
  const calls = [];
  try {
    childProcess.spawnSync = (_command, args, options) => {
      calls.push({ args, options });
      if (args.includes('fetch'))
        return {
          error: Object.assign(new Error('fixture deadline'), {
            code: 'ETIMEDOUT',
          }),
        };
      return {
        status: args.includes('cat-file') ? 1 : 0,
        stdout: Buffer.alloc(0),
      };
    };
    syncBuiltinESMExports();
    assert.throws(
      () =>
        sourceRepository(upstream, {
          name: 'codex',
          url: 'https://github.com/openai/codex.git',
          revision: commit('a'),
        }),
      (error) =>
        /pinned codex revision.*5 minute deadline/.test(error.message) &&
        error.cause.code === 'ETIMEDOUT',
    );
    const fetches = calls.filter(({ args }) => args.includes('fetch'));
    assert.equal(fetches.length, 1);
    const { args, options } = fetches[0];
    assert.ok(args.includes('--depth=1') && args.includes(commit('a')));
    assert.ok(
      args.includes('http.lowSpeedLimit=1024') &&
        args.includes('http.lowSpeedTime=120'),
    );
    assert.equal(options.timeout, 300000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit']);
    assert.equal(calls.at(-1), fetches[0]);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    rmSync(upstream, { recursive: true, force: true });
  }
});

test('native host and loader rejection use the intended platform on every supported host', async () => {
  for (const platform of Object.keys(nativeHosts)) {
    const f = fixture(platform);
    try {
      f.receipt.host = Object.values(nativeHosts).find(
        (host) => host !== nativeHosts[platform],
      );
      f.write('native/build-receipt.json', JSON.stringify(f.receipt));
      await assert.rejects(
        verifyNativeReceipt(f.repository, platform),
        (error) =>
          error.actual === f.receipt.host &&
          error.expected === nativeHosts[platform],
      );
      f.receipt.host = nativeHosts[platform];
      f.write('native/build-receipt.json', JSON.stringify(f.receipt));
      f.write('native/index.js', 'changed loader');
      await assert.rejects(
        verifyNativeReceipt(f.repository, platform),
        /input inventory/,
      );
    } finally {
      f.dispose();
    }
  }
});

test('executed SDK markers require timestamps across every platform and attempt', async () => {
  for (const platform of ['linux-x64', 'darwin-arm64', 'win32-x64']) {
    for (const marker of [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'in_progress', conclusion: null },
      { conclusion: 'success' },
    ]) {
      const f = donorFixture();
      f.jobs.jobs.push({
        name: `sdk / SDK and package (${platform})`,
        run_attempt: 1,
        conclusion: 'failure',
        steps: [{ name: 'Begin SDK execution', ...marker, started_at: null }],
      });
      f.jobs.total_count++;
      await assert.rejects(f.resolve(), /timestamp/);
    }
  }
});

test('pending and skipped SDK markers without starts do not invent execution times', () => {
  for (const marker of [
    { status: 'queued', conclusion: null },
    { status: 'pending', conclusion: null },
    { status: 'waiting', conclusion: null },
    { status: 'completed', conclusion: 'skipped' },
  ]) {
    const f = donorFixture();
    f.jobs.jobs.push({
      name: 'sdk / SDK and package (darwin-arm64)',
      run_attempt: 1,
      conclusion: null,
      steps: [{ name: 'Begin SDK execution', ...marker, started_at: null }],
    });
    assert.equal(publicationBoundary(f.jobs.jobs).sdkStarted, true);
  }
});

test('SDK qualification follows job attempts, accepting a retry after skipped setup but rejecting a later failed setup', async () => {
  const skipped = {
    name: 'Begin SDK execution',
    status: 'completed',
    conclusion: 'skipped',
    started_at: null,
  };
  const f = donorFixture();
  f.qualification.run_attempt = 2;
  f.jobs.jobs.push({
    ...f.qualification,
    run_attempt: 1,
    conclusion: 'failure',
    steps: [
      skipped,
      { name: 'Test the extracted bundles', conclusion: 'skipped' },
    ],
  });
  f.jobs.total_count++;
  assert.equal((await f.resolve()).artifactId, 10);
  f.jobs.jobs.push({
    ...f.qualification,
    run_attempt: 3,
    conclusion: 'failure',
    steps: [
      skipped,
      { name: 'Test the extracted bundles', conclusion: 'skipped' },
    ],
  });
  f.jobs.total_count++;
  await assert.rejects(f.resolve(), /SDK qualification failed/);
  f.jobs.jobs.pop();
  f.jobs.total_count--;
  delete f.qualification.run_attempt;
  await assert.rejects(f.resolve(), /Missing SDK qualification attempt/);
});
