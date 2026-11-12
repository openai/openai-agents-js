import assert from 'node:assert/strict';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { runClosed } from './retained-process-owner.mjs';
import { baselineSourceCommit, isHostedAdmission } from './retained-hosted-admission.mjs';
export { runClosed };
export const sourceCommit = baselineSourceCommit;
export const title = 'reconnects fresh clients to one retained executor with current credentials';
const nativeTest = 'packages/agents-codex/test/native/';
const pins = {
  'retained-executor-native.test.ts': '8510d88cc7f31bbcae6adb7043fcb1c4dd8fe33fa3655bbd0c4fefa5d675fe0d',
  'fixtures/retained-executor-worker.ts': 'c7d542015f6a5f3e9cf2e41548f88fdded6aba1c83b1e96017ec31f4545673ea',
  'fixtures/public-executor.ts': 'ec7a57564eb6e29b227c3a35a1f758830281790379d59aedc90ae90c66a631f8',
  'fixtures/model-server.ts': '3051843fb1fc69a3e5390828463f74f15fe59ea8490f83244bb50e22cbbeeb4a',
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `Source drift: ${before}`);
  return source.replace(before, after);
}
export async function checkedFile(record) {
  assert(isAbsolute(record.path));
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const path = await realpath(record.path);
  assert.equal(digest(await readFile(path)), record.sha256, `Identity mismatch: ${path}`);
  return { path, sha256: record.sha256 };
}

export function hostFailures(host) {
  return [
    [host.platform === 'linux' && host.arch === 'x64', 'linux-x64-required'],
    [host.nodeMajor === '24', 'node-24-required'],
    [host.daemon?.directory && !host.daemon.symlink && host.daemon.uid === host.uid && host.daemon.mode === 0o700, 'daemon-owner-mode-0700-required'],
    [!host.wouldSkip, 'maintained-sandbox-skip'],
  ].filter(([ok]) => !ok).map(([, reason]) => reason);
}
export async function inspectHost() {
  const uid = process.getuid?.();
  let daemon;
  try {
    const info = await lstat(`/tmp/codex-daemon-${uid}`);
    daemon = { directory: info.isDirectory(), symlink: info.isSymbolicLink(), uid: info.uid, mode: info.mode & 0o7777 };
  } catch { /* Missing directory has been failing strict admission without repair. */ }
  return { platform: process.platform, arch: process.arch, nodeMajor: process.versions.node.split('.')[0], uid, daemon,
    wouldSkip: process.env.GITHUB_ACTIONS !== 'true' && process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' && process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1' };
}
export async function preflight(evidence, host, checkoutCommit = baselineSourceCommit) {
  host ??= await inspectHost();
  const failures = hostFailures(host);
  const record = { sourceCommit: checkoutCommit, baselineSourceCommit, disposition: 'preflight-failed', proofEligible: false, reconnectInvocations: { cjs: 0, esm: 0 }, host, failures };
  if (!failures.length) {
    try {
      await runClosed('bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true']);
      await runClosed('openssl', ['version']);
      for (const address of ['127.0.0.1', '127.0.0.2', '127.0.0.3']) {
        await new Promise((done, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(0, address, () => server.close((error) => error ? reject(error) : done()));
        });
      }
      record.disposition = 'preflight-passed';
    } catch (error) {
      failures.push('namespace-tooling-or-listener-probe-failed');
      record.parentSignal = error.parentSignal;
      record.cleanup = error.cleanup;
    }
  }
  await writeFile(join(evidence, 'retained-preflight.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  if (failures.length) {
    const error = new Error(`Strict retained preflight: ${failures.join(', ')}`);
    error.parentSignal = record.parentSignal;
    throw error;
  }
}

export async function adaptSources(checkout, style, { tsx, fixture, helperDirectory }) {
  assert(['cjs', 'esm'].includes(style));
  const files = {};
  for (const [name, hash] of Object.entries(pins)) {
    const bytes = await readFile(join(checkout, nativeTest, name));
    assert.equal(digest(bytes), hash, `Maintained source drift: ${name}`);
    files[name] = bytes.toString();
  }
  const extension = style === 'cjs' ? 'cts' : 'mts';
  let parent = files['retained-executor-native.test.ts'];
  parent = replaceOnce(parent, "import type { JsonObject } from '../../src/runtime/binding';", 'type JsonObject = Record<string, any>;');
  parent = replaceOnce(parent, './fixtures/retained-executor-worker.ts', `./fixtures/retained-executor-worker.${extension}`);
  parent = replaceOnce(parent, "execArgv: ['--stack-size=16384', '--import', 'tsx']", `execArgv: ['--stack-size=16384', '--import', ${JSON.stringify(tsx)}]`);
  files['retained-executor-native.test.ts'] = parent;
  let worker = files['fixtures/retained-executor-worker.ts'];
  worker = replaceOnce(worker, "import {\n  Agent,\n  Environment,\n  NativeProvider,\n  type SessionState,\n} from '../../../src/index';", style === 'cjs'
    ? "import type { SessionState } from '@openai/agents';\nconst { Agent, Environment, NativeProvider } = require('@openai/agents');"
    : "import { Agent, Environment, NativeProvider, type SessionState } from '@openai/agents';");
  worker = "import { installedIdentity } from './installed-identity.cjs';\n" + worker;
  worker = replaceOnce(worker, '    process.send?.(result);', '    installedIdentity({ Agent, Environment, NativeProvider });\n    process.send?.(result);');
  delete files['fixtures/retained-executor-worker.ts'];
  files[`fixtures/retained-executor-worker.${extension}`] = worker;
  files['fixtures/model-server.ts'] = replaceOnce(files['fixtures/model-server.ts'], "import type { JsonObject, JsonValue } from '../../../src/runtime/binding';", 'type JsonObject = Record<string, any>;\ntype JsonValue = any;');
  files['fixtures/model-server.ts'] = replaceOnce(files['fixtures/model-server.ts'], "import type { NativeConfig } from '../../../src/runtime/config';", 'type NativeConfig = Record<string, any>;');
  let executor = replaceOnce(files['fixtures/public-executor.ts'], "import type { JsonObject } from '../../../src/runtime/binding';", 'type JsonObject = Record<string, any>;');
  executor = replaceOnce(executor, "process.env.CODEX_EXEC_SERVER_TEST_BINARY ??\n        resolve(\n          import.meta.dirname,\n          '../../../native/test-bin/exec-server-fixture',\n        )", JSON.stringify(fixture));
  executor = replaceOnce(executor, "resolve(import.meta.dirname, '../../../bin')", JSON.stringify(helperDirectory));
  executor = replaceOnce(executor, 'let restored = false;', 'let restored = false;\n  let childClosed: Promise<void> | undefined;');
  executor = replaceOnce(executor, '    for (const [name, value] of Object.entries(environment)) {', '    await childClosed;\n    for (const [name, value] of Object.entries(environment)) {');
  executor = replaceOnce(executor, '    let startupError: Error | undefined;', "    childClosed = new Promise((done) => child!.once('close', () => done()));\n    let startupError: Error | undefined;");
  files['fixtures/public-executor.ts'] = executor;
  return files;
}

export function assertPassed(report) {
  assert.equal(report.success, true);
  for (const key of ['numTotalTests', 'numPassedTests']) assert.equal(report[key], 1, key);
  for (const key of ['numFailedTests', 'numPendingTests', 'numTodoTests']) assert.equal(report[key], 0, key);
  assert.equal(report.testResults.length, 1);
  const results = report.testResults[0].assertionResults;
  assert.equal(results.length, 1);
  assert.equal(results[0].fullName, title);
  assert.equal(results[0].status, 'passed');
}

export async function retainedAdapter({ checkout, admission, evidence }) {
  assert.match(admission.sourceCommit, /^[a-f0-9]{40}$/);
  const qualifiedHosted = isHostedAdmission(admission);
  // These hashes have been requiring external verification of the CURRENT transfer/tooling.
  // A caller-supplied digest alone has not been proving producer attribution.
  const transferEvidence = await checkedFile(admission.transferEvidence);
  const transfer = JSON.parse(await readFile(transferEvidence.path, 'utf8'));
  assert.equal(transfer.sourceCommit, admission.sourceCommit);
  const fixture = await checkedFile(admission.fixture);
  assert.equal(transfer.fixtureSha256, fixture.sha256);
  const tooling = {};
  for (const name of ['vitest', 'vitestCli', 'tsx', 'ws', 'lock']) tooling[name] = await checkedFile(admission.tooling[name]);
  assert.equal(tooling.lock.sha256, digest(await readFile(join(checkout, 'pnpm-lock.yaml'))));
  return async ({ profile, consumer, receipt, env }) => {
    assert.equal(receipt.sourceCommit, admission.sourceCommit);
    assert.equal(receipt.platform, 'linux-x64');
    const style = profile === 'starter' ? 'cjs' : 'esm';
    assert(['starter', 'app'].includes(profile));
    const require = createRequire(join(consumer, 'package.json'));
    const root = await realpath(consumer);
    const agentRoot = await realpath(join(root, 'node_modules/@openai/agents-codex'));
    assert(require.resolve('@openai/agents-codex').startsWith(agentRoot + sep));
    assert(agentRoot.startsWith(join(root, 'node_modules') + sep));
    const nativeReceiptBytes = await readFile(join(agentRoot, 'native/build-receipt.json'));
    assert.equal(digest(nativeReceiptBytes), transfer.nativeReceiptSha256);
    const nativeReceipt = JSON.parse(nativeReceiptBytes);
    assert.equal(nativeReceipt.format, 'reviewed-native-v1');
    assert.equal(nativeReceipt.release, true);
    const products = {};
    for (const [name, expected] of Object.entries(nativeReceipt.products)) {
      const path = await realpath(resolve(agentRoot, name));
      assert(path.startsWith(agentRoot + sep));
      assert.equal(`sha256:${digest(await readFile(path))}`, expected);
      products[path] = expected;
    }
    assert(products[join(agentRoot, 'native/codex.node')]);
    const directory = join(consumer, 'f4b');
    await rm(directory, { recursive: true, force: true });
    await mkdir(join(directory, 'fixtures'), { recursive: true });
    const files = await adaptSources(checkout, style, { tsx: tooling.tsx.path, fixture: fixture.path, helperDirectory: join(agentRoot, 'bin') });
    for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
    // The child has been checking loaded addon identity and selected packaged helpers.
    await writeFile(join(directory, 'fixtures/installed-identity.cjs'), `
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const products = ${JSON.stringify(products)};
const consumer = ${JSON.stringify(root)};
for (const name of ['@openai/agents', '@openai/agents-codex']) {
  const path = require.resolve(name);
  assert(path.startsWith(join(consumer, 'node_modules') + '/'), 'SDK resolution has been leaving the installed app');
}
exports.installedIdentity = (actual) => {
  const addon = ${JSON.stringify(join(agentRoot, 'native/codex.node'))};
  assert(require.cache[addon], 'Installed addon has not been loaded');
  const sdk = require('@openai/agents-codex');
  const facade = require('@openai/agents');
  for (const name of ['Agent', 'Environment', 'NativeProvider']) {
    assert.equal(actual[name], sdk[name], 'Worker public identity differs from installed native SDK');
    assert.equal(facade[name], sdk[name]);
  }
  const native = require(${JSON.stringify(join(agentRoot, 'native/index.js'))});
  assert.equal(native.CODEX_REVISION, ${JSON.stringify(receipt.codexRevision)});
  const helpers = Object.values(native._packaged_runtime());
  assert.equal(helpers.length, 4);
  for (const file of [addon, ...helpers]) {
    assert(products[file], 'Unverified runtime path');
    assert.equal('sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex'), products[file]);
  }
  const identity = { pid: process.pid, addon, helpers, publicIdentity: true, sessionProviderCleanupJoined: true };
  writeFileSync(join(__dirname, 'identity-' + process.pid + '.json'), JSON.stringify(identity), { mode: 0o600 });
  return identity;
};
`);
    await writeFile(join(directory, 'vitest.config.mjs'), `export default {
      root: ${JSON.stringify(consumer)},
      resolve: { alias: [
        { find: /^vitest$/, replacement: ${JSON.stringify(tooling.vitest.path)} },
        { find: /^ws$/, replacement: ${JSON.stringify(tooling.ws.path)} }
      ] },
      test: { include: ['f4b/retained-executor-native.test.ts'], pool: 'forks', maxWorkers: 1, fileParallelism: false }
    };\n`);
    const output = join(directory, 'result.json');
    const runtimeEnv = { ...env };
    for (const name of Object.keys(runtimeEnv)) if (/key|token|secret|authorization|node_options|node_path/i.test(name)) delete runtimeEnv[name];
    delete runtimeEnv.CODEX_EXEC_SERVER_TEST_BINARY;
    const result = { sourceCommit: admission.sourceCommit, baselineSourceCommit, nativeSelector: admission.nativeSelector, style, profile, consumer, fixture, tooling, transferEvidence, nativeReceipt, proofEligible: false, externalQualificationRequired: !qualifiedHosted, reconnectInvocations: 1 };
    try {
      result.child = await runClosed(process.execPath, [tooling.vitestCli.path, 'run', '--config', join(directory, 'vitest.config.mjs'), 'f4b/retained-executor-native.test.ts', '-t', `^${title}$`, '--maxWorkers=1', '--reporter=json', `--outputFile=${output}`], { cwd: consumer, env: runtimeEnv });
      assertPassed(JSON.parse(await readFile(output, 'utf8')));
      const identities = (await readdir(join(directory, 'fixtures'))).filter((name) => /^identity-\d+\.json$/.test(name));
      // Denied-worker terminal failure has been remaining a permitted maintained outcome.
      assert(identities.length >= 2 && identities.length <= 3);
      result.workerIdentities = await Promise.all(identities.map(async (name) => JSON.parse(await readFile(join(directory, 'fixtures', name), 'utf8'))));
      assert.equal(new Set(result.workerIdentities.map((item) => item.pid)).size, identities.length);
      result.proofEligible = qualifiedHosted;
      result.disposition = 'passed';
      result.localRetainedPassed = true;
    } catch (error) {
      result.disposition = 'retained-failed';
      result.cleanup = error.cleanup;
      result.proofEligible = false;
      result.parentSignal = error.parentSignal;
      const failure = new Error(`Private ${style} retained qualification failed; see private receipt`);
      failure.parentSignal = error.parentSignal;
      throw failure;
    } finally {
      try {
        const report = JSON.parse(await readFile(output, 'utf8'));
        result.testReport = {
          success: report.success, total: report.numTotalTests, passed: report.numPassedTests,
          failed: report.numFailedTests, pending: report.numPendingTests, todo: report.numTodoTests,
          assertions: report.testResults?.flatMap((file) => file.assertionResults?.map(({ fullName, status }) => ({ fullName, status })) ?? []),
        };
      } catch { result.testReport = { available: false }; }
      await writeFile(join(evidence, `retained-${style}.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    }
  };
}
