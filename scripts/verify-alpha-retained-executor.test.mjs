import { groupWitness } from './retained-process-owner.mjs';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { isHostedAdmission } from './retained-hosted-admission.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { adaptSources, assertPassed, checkedFile, hostFailures, preflight, replaceOnce, retainedAdapter, runClosed, sourceCommit, title } from './verify-alpha-retained-executor.mjs';

// This command has been testing adapter mechanics only, without loading SDK code.
const checkout = resolve(process.env.RETAINED_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url)));
const scratch = async (body) => {
  const root = await mkdtemp(join(tmpdir(), 'private-retained-controls-'));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const goodReport = () => ({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ assertionResults: [{ fullName: title, status: 'passed' }] }] });

test('exact substitution has been rejecting missing and repeated source anchors', () => {
  assert.equal(replaceOnce('abc', 'b', 'B'), 'aBc');
  assert.throws(() => replaceOnce('abc', 'z', ''), /Source drift/);
  assert.throws(() => replaceOnce('aba', 'a', ''), /Source drift/);
});

test('CJS and ESM adaptation has been preserving scenario, skip, deadlines and cleanup', async () => {
  const original = await readFile(join(checkout, 'packages/agents-codex/test/native/retained-executor-native.test.ts'), 'utf8');
  for (const style of ['cjs', 'esm']) {
    const files = await adaptSources(checkout, style, { tsx: '/locked/tsx/loader.mjs', fixture: '/verified/exec-server-fixture', helperDirectory: '/installed/node_modules/@openai/agents-codex/bin' });
    const parent = files['retained-executor-native.test.ts'];
    assert.equal(parent.slice(parent.indexOf('it.skipIf(')), original.slice(original.indexOf('it.skipIf(')));
    assert(parent.includes('}, 25_000);'));
    assert(parent.includes("child.once('close'"));
    assert(!Object.keys(files).includes('fixtures/retained-executor-worker.ts'));
    const worker = files[`fixtures/retained-executor-worker.${style === 'cjs' ? 'cts' : 'mts'}`];
    assert(worker.includes(style === 'cjs' ? "require('@openai/agents')" : "from '@openai/agents'"));
    assert(worker.includes('await using session'));
    const executor = files['fixtures/public-executor.ts'];
    assert(executor.includes('await childClosed;'));
    assert(!executor.includes('../../../bin'));
    assert(executor.includes('await exited;'));
    for (const source of Object.values(files)) assert(!source.includes("from '../../../src/"));
  }
});

test('maintained source tampering has been failing before any generated test', async () => scratch(async (root) => {
  const relative = 'packages/agents-codex/test/native';
  await mkdir(join(root, relative), { recursive: true });
  await writeFile(join(root, relative, 'retained-executor-native.test.ts'), 'drift');
  await assert.rejects(adaptSources(root, 'cjs', {}), /Maintained source drift/);
}));

test('pass parsing has been rejecting skip, zero, duplicate, wrong-title and failed reports', () => {
  assertPassed(goodReport());
  for (const mutate of [
    (r) => { r.numPendingTests = 1; }, (r) => { r.numTotalTests = 0; },
    (r) => { r.numPassedTests = 2; }, (r) => { r.numFailedTests = 1; },
    (r) => { r.numTodoTests = 1; }, (r) => { r.success = false; },
    (r) => { r.testResults[0].assertionResults[0].status = 'pending'; },
    (r) => { r.testResults[0].assertionResults[0].fullName = 'other'; },
    (r) => { r.testResults.push(r.testResults[0]); },
    (r) => { r.testResults[0].assertionResults.push(r.testResults[0].assertionResults[0]); },
  ]) { const report = goodReport(); mutate(report); assert.throws(() => assertPassed(report)); }
});

test('strict preflight failure has been recording zero invocations without capability probes', async () => scratch(async (root) => {
  const host = { platform: 'linux', arch: 'x64', nodeMajor: '24', uid: 1000, daemon: { directory: true, symlink: false, uid: 1000, mode: 0 }, wouldSkip: false };
  assert.deepEqual(hostFailures(host), ['daemon-owner-mode-0700-required']);
  await assert.rejects(preflight(root, host), /Strict retained preflight/);
  const receipt = JSON.parse(await readFile(join(root, 'retained-preflight.json'), 'utf8'));
  assert.equal(receipt.disposition, 'preflight-failed');
  assert.deepEqual(receipt.reconnectInvocations, { cjs: 0, esm: 0 });
  assert.equal(receipt.proofEligible, false);
  assert.deepEqual(hostFailures({ ...host, daemon: { ...host.daemon, mode: 0o700 }, wouldSkip: true }), ['maintained-sandbox-skip']);
}));

test('identity and admission failures have been stopping before SDK resolution or spawning', async () => scratch(async (root) => {
  const path = join(root, 'inert');
  await writeFile(path, 'inert');
  const sha256 = createHash('sha256').update('inert').digest('hex');
  assert.deepEqual(await checkedFile({ path, sha256 }), { path, sha256 });
  await assert.rejects(checkedFile({ path, sha256: '0'.repeat(64) }), /Identity mismatch/);
  await assert.rejects(retainedAdapter({ checkout, admission: { sourceCommit: '0'.repeat(40) }, evidence: root }));
  await assert.rejects(retainedAdapter({ checkout, admission: { sourceCommit, transferEvidence: { path, sha256: '0'.repeat(64) } }, evidence: root }), /Identity mismatch/);
}));

test('bounded inert Node children have been joining close on success, failure and spawn error', { skip: process.platform !== 'linux' }, async () => {
  const closed = await runClosed(process.execPath, ['-e', 'process.exitCode = 0']);
  assert.equal(closed.code, 0);
  assert.equal(closed.close, true);
  assert.equal(closed.cleanup.joined, true);
  await assert.rejects(runClosed(process.execPath, ['-e', 'process.exitCode = 7']), /code=7/);
  await assert.rejects(runClosed('/nonexistent/private-retained-control', []), /spawnError=true/);
});

test('private verifier hooks have been remaining opt-in and before original receipts', async () => {
  const original = execFileSync('git', ['show', sourceCommit + ':scripts/verify-alpha-package.mjs'], { cwd: checkout, encoding: 'utf8' });
  const candidate = await readFile(new URL('./verify-alpha-package.mjs', import.meta.url), 'utf8');
  const expected = original.replace('export async function verifyAlphaPackage(directory) {', 'export async function verifyAlphaPackage(directory, { retainedExecutor } = {}) {')
    .replace('    const types = await verifyTypes(consumer, env);', "    const types = await verifyTypes(consumer, env);\n    await retainedExecutor?.({ profile: 'starter', consumer, receipt, env });")
    .replace('    await verifyTypes(existing, env);', "    await verifyTypes(existing, env);\n    await retainedExecutor?.({ profile: 'app', consumer: existing, receipt, env });");
  assert.equal(candidate, expected);
});


test('inert failing tooling has been replacing transplanted adapters and keeping failure evidence separate', { skip: process.platform !== 'linux' }, async () => scratch(async (root) => {
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const recordFile = async (name, bytes) => {
    const path = join(root, name);
    await writeFile(path, bytes);
    return { path, sha256: hash(bytes) };
  };
  const fixture = await recordFile('inert-executor', 'Never executed');
  const inertTool = await recordFile('inert-tool.mjs', 'process.exitCode = 0;');
  const lock = { path: join(checkout, 'pnpm-lock.yaml'), sha256: hash(await readFile(join(checkout, 'pnpm-lock.yaml'))) };
  const consumer = join(root, 'consumer');
  const agentRoot = join(consumer, 'node_modules/@openai/agents-codex');
  await mkdir(join(agentRoot, 'native'), { recursive: true });
  await writeFile(join(consumer, 'package.json'), '{}');
  await writeFile(join(agentRoot, 'package.json'), JSON.stringify({ name: '@openai/agents-codex', exports: { '.': './inert.js' } }));
  await writeFile(join(agentRoot, 'inert.js'), 'throw new Error("Never imported");');
  await writeFile(join(agentRoot, 'native/codex.node'), 'Never loaded');
  const nativeReceipt = JSON.stringify({ format: 'reviewed-native-v1', release: true, products: { 'native/codex.node': 'sha256:' + hash('Never loaded') } });
  await writeFile(join(agentRoot, 'native/build-receipt.json'), nativeReceipt);
  const transferEvidence = await recordFile('inert-transfer.json', JSON.stringify({ sourceCommit, fixtureSha256: fixture.sha256, nativeReceiptSha256: hash(nativeReceipt) }));
  const callback = await retainedAdapter({ checkout, evidence: root, admission: {
    sourceCommit, fixture, transferEvidence,
    tooling: { vitest: inertTool, vitestCli: inertTool, tsx: inertTool, ws: inertTool, lock },
  } });
  const receipt = { sourceCommit, platform: 'linux-x64', codexRevision: 'a'.repeat(40) };
  for (const [profile, style, extension, absent] of [['starter', 'cjs', 'cts', 'mts'], ['app', 'esm', 'mts', 'cts']]) {
    await assert.rejects(callback({ profile, consumer, receipt, env: {} }), /retained qualification failed/);
    assert((await readFile(join(consumer, `f4b/fixtures/retained-executor-worker.${extension}`), 'utf8')).includes('installedIdentity'));
    await assert.rejects(readFile(join(consumer, `f4b/fixtures/retained-executor-worker.${absent}`)), /ENOENT/);
    const result = JSON.parse(await readFile(join(root, `retained-${style}.json`), 'utf8'));
    assert.equal(result.disposition, 'retained-failed');
    assert.equal(result.proofEligible, false);
    assert(!result.localRetainedPassed);
    assert.equal(result.child.code, 0);
    assert.equal(result.child.close, true);
    assert.equal(result.child.cleanup.joined, true);
  }
}));


test('caller-supplied admission JSON has not been acquiring hosted qualification', () => {
  assert.equal(isHostedAdmission({ sourceCommit, nativeSelector: 'a'.repeat(64) }), false);
});

test('watchdog has been joining its process group and an observed detached descendant', { skip: process.platform !== 'linux' }, async () => {
  const program = `const { spawn } = require('node:child_process');
    for (const detached of [false, true]) spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached, stdio: 'ignore' });
    setInterval(() => {}, 1000);`;
  await assert.rejects(runClosed(process.execPath, ['-e', program], {}, { deadlineMs: 1000 }), (error) => {
    assert.match(error.message, /timeout=true/);
    assert.equal(error.cleanup.joined, true);
    assert(error.cleanup.observed.length >= 3);
    return true;
  });
});


for (const shutdown of ['SIGTERM', 'SIGINT']) {
  test(`parent ${shutdown} has been joining owned groups before restoring shutdown`, { skip: process.platform !== 'linux' }, async () => scratch(async (directory) => {
    const report = join(directory, 'shutdown.json');
    const wrapper = join(directory, 'shutdown.mjs');
    const owner = new URL('./retained-process-owner.mjs', import.meta.url).href;
    await writeFile(wrapper, `
      import { runClosed } from ${JSON.stringify(owner)};
      import { writeFile } from 'node:fs/promises';
      setTimeout(() => process.kill(process.pid, ${JSON.stringify(shutdown)}), 500);
      try { await runClosed(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); }
      catch (error) {
        await writeFile(${JSON.stringify(report)}, JSON.stringify({ signal: error.parentSignal, cleanup: error.cleanup }));
        if (error.parentSignal) process.kill(process.pid, error.parentSignal);
        throw error;
      }
    `);
    await assert.rejects(runClosed(process.execPath, [wrapper]), (error) => {
      assert.equal(error.cleanup.joined, true);
      return true;
    });
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(result.signal, shutdown);
    assert.equal(result.cleanup.joined, true);
    assert.equal(result.cleanup.scope, 'new-process-group-and-observed-descendants');
  }));
}


test('group signalling has been requiring the original birth and owned group', () => {
  const original = { pid: 42, birth: '100', group: 42 };
  assert.equal(groupWitness(original, { ...original }, 42), true);
  assert.equal(groupWitness(original, { ...original, birth: '101' }, 42), false);
  assert.equal(groupWitness(original, { ...original, group: 43 }, 42), false);
  assert.equal(groupWitness(original, undefined, 42), false);
});
