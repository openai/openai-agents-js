import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { nativeInputs } from './native-bundle-inputs.mjs';
import { downloadNativeBundle } from './verified-native-bundle.mjs';

export const baselineSourceCommit = 'd6c6d345bdf6902311fd04fd9c6366dd0cf9799f';
export const originalReviewSourceCommit = '2b0bc368d6fbf7c25f4a89b6c38803609edbedf0';
const externalBaseline = {
  '.changeset/managed-child-turn-readiness.md': '6f3a6e2c280fca6bd1b04e79c96cb6410adb33c2',
  'packages/agents-codex/test/native/parity-native-agents.test.ts': 'e77077d1b3908e96749d73f67cb026d986ab8255',
};
const admitted = new WeakSet();
export const isHostedAdmission = (record) => admitted.has(record);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allowedChanges = new Set([
  '.github/workflows/alpha-release-artifacts.yml',
  'scripts/verify-alpha-package.mjs',
  'scripts/verify-alpha-retained-executor.mjs',
  'scripts/test-alpha-retained-package.mjs',
  'scripts/verify-alpha-retained-executor.test.mjs',
  'scripts/retained-hosted-admission.mjs',
  'scripts/retained-process-owner.mjs',
]);
export async function prepareHostedAdmission(checkout, evidence) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Hosted job admission required');
  assert.equal(process.env.GITHUB_REPOSITORY, 'openai/openai-agents-js');
  assert.equal(process.env.EXPECTED_PLATFORM, 'linux-x64');
  const sourceCommit = process.env.GITHUB_SHA;
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(process.env.GITHUB_RUN_ID, /^\d+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT, /^\d+$/);
  assert.equal(await realpath(checkout), await realpath(process.env.GITHUB_WORKSPACE));
  assert.equal(await realpath(process.cwd()), await realpath(checkout));
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sourceCommit);
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Clean hosted source required');
  for (const [path, blob] of Object.entries(externalBaseline))
    assert.equal(git('rev-parse', sourceCommit + ':' + path), blob, `External baseline drift: ${path}`);
  try {
    git('cat-file', '-e', baselineSourceCommit + '^{commit}');
  } catch {
    git('fetch', '--no-tags', '--depth=1', 'https://github.com/openai/openai-agents-js.git', baselineSourceCommit);
  }
  assert.equal(git('rev-parse', '--verify', baselineSourceCommit + '^{commit}'), baselineSourceCommit, 'Pinned baseline commit unavailable');
  const changes = git('diff', '--name-only', baselineSourceCommit, sourceCommit).split('\n').filter(Boolean);
  for (const path of changes) assert(allowedChanges.has(path), `Unsupported source change: ${path}`);
  const selector = nativeInputs();
  assert.equal(selector, process.env.NATIVE_INPUTS, 'Current-run native selector mismatch');
  const publication = JSON.parse(process.env.NATIVE_ARTIFACT);
  const artifactId = Number(publication['artifact-id']);
  const artifactDigest = publication['artifact-digest'];
  assert(Number.isSafeInteger(artifactId) && artifactId > 0);
  assert.match(artifactDigest, /^[a-f0-9]{64}$/);
  // Reuse the existing current-run digest-checked download and existing token.
  const archive = await downloadNativeBundle({ id: artifactId, sha256: artifactDigest });
  assert(archive, 'Verified current-run transfer unavailable');
  const member = (name) => execFileSync('tar', ['-xOzf', '-', name], { input: archive, maxBuffer: 256 * 1024 * 1024 });
  const nativeReceiptBytes = member('native/build-receipt.json');
  const fixtureBytes = member('native/test-bin/exec-server-fixture');
  const fixturePath = await realpath(join(checkout, 'packages/agents-codex/native/test-bin/exec-server-fixture'));
  assert.equal(digest(await readFile(fixturePath)), digest(fixtureBytes), 'Restored fixture differs from authenticated transfer');
  assert.equal(digest(await readFile(join(checkout, 'packages/agents-codex/native/build-receipt.json'))), digest(nativeReceiptBytes));
  const moduleRoot = await realpath(join(checkout, 'node_modules'));
  const require = createRequire(join(checkout, 'package.json'));
  const vitestRoot = await realpath(join(checkout, 'node_modules/vitest'));
  const files = {
    vitest: join(vitestRoot, 'dist/index.js'), vitestCli: join(vitestRoot, 'vitest.mjs'),
    tsx: require.resolve('tsx'), ws: createRequire(join(checkout, 'packages/agents-codex/package.json')).resolve('ws'), lock: join(checkout, 'pnpm-lock.yaml'),
  };
  const tooling = {};
  for (const [name, file] of Object.entries(files)) {
    const path = await realpath(file);
    if (name !== 'lock') assert(path.startsWith(moduleRoot + sep), 'Tooling left the frozen hosted workspace');
    tooling[name] = { path, sha256: digest(await readFile(path)) };
  }
  assert.equal(tooling.lock.sha256, digest(execFileSync('git', ['show', sourceCommit + ':pnpm-lock.yaml'], { cwd: checkout })));
  const transfer = {
    sourceCommit, nativeSelector: selector, fixtureSha256: digest(fixtureBytes), nativeReceiptSha256: digest(nativeReceiptBytes),
    publication: { artifactId, artifactDigest, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT },
    archiveSha256: digest(archive),
    // The publication belongs to this run; a retained compiler producer stays distinct.
    consumerCheckout: sourceCommit,
  };
  const transferPath = join(evidence, 'verified-transfer.json');
  const transferText = JSON.stringify(transfer, null, 2) + '\n';
  await writeFile(transferPath, transferText, { mode: 0o600 });
  const record = {
    sourceCommit, baselineSourceCommit, originalReviewSourceCommit, externalBaseline, nativeSelector: selector,
    fixture: { path: fixturePath, sha256: transfer.fixtureSha256 },
    transferEvidence: { path: transferPath, sha256: digest(Buffer.from(transferText)) },
    tooling, lockedInstallation: 'existing hosted pnpm install --frozen-lockfile step',
    currentRunPublication: transfer.publication,
  };
  await writeFile(join(evidence, 'hosted-admission.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  admitted.add(record);
  return record;
}
