import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const installed = join(await realpath(process.cwd()), 'node_modules') + sep;
for (const name of ['@openai/agents', '@openai/agents/testing', '@openai/agents-codex']) {
  assert((await realpath(fileURLToPath(import.meta.resolve(name)))).startsWith(installed));
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const nativePackage = join(installed, '@openai', 'agents-codex');
const receiptPath = join(nativePackage, 'native', 'build-receipt.json');
assert.equal(
  await sha256(receiptPath),
  'a9a0be05f1eda57fd06bc7dd6d780a65ac914384577e99d64fba37a0c7e50505',
);
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
for (const [path, digest] of Object.entries(receipt.products)) {
  const product = join(nativePackage, path);
  assert((await realpath(product)).startsWith(nativePackage + sep));
  assert.equal('sha256:' + await sha256(product), digest, path);
  assert.equal((await stat(product)).mode & 0o777, 0o755, path);
}
console.log('PASS installed Darwin native receipt and four executable products');

const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-darwin-credential-')));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const workspace = join(root, 'workspace');
const home = join(root, 'home');
const codex = join(home, '.codex');
const auth = join(codex, 'auth.json');
const oauth = join(codex, '.credentials.json');
const authAlias = join(workspace, 'auth-alias');
const ready = join(workspace, 'ready');
const release = join(workspace, 'release');

async function replaceAfterInitialCommandReads() {
  const deadline = performance.now() + 10_000;
  while (!(await stat(ready).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  }))) {
    assert(performance.now() < deadline, 'trusted command did not reach the initial mask check');
    await delay(25);
  }
  for (const path of [auth, oauth]) {
    const before = await stat(path);
    const replacement = path + '.replacement';
    await writeFile(replacement, 'synthetic-replacement\n', { mode: 0o600, flag: 'wx' });
    await rename(replacement, path);
    assert.notEqual((await stat(path)).ino, before.ino);
    assert.equal(await readFile(path, 'utf8'), 'synthetic-replacement\n');
  }
  await writeFile(release, 'continue');
}

try {
  await mkdir(workspace);
  await mkdir(codex, { recursive: true });
  await writeFile(auth, 'synthetic-auth\n', { mode: 0o600 });
  await writeFile(oauth, 'synthetic-mcp\n', { mode: 0o600 });
  await writeFile(join(codex, 'ordinary.txt'), 'ordinary');
  await symlink(auth, authAlias);
  process.env.HOME = home;
  process.env.CODEX_HOME = codex;
  process.env.OPENAI_API_KEY = 'synthetic-ambient-key';
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  const { Agent, Environment } = await import('@openai/agents');
  const { text, toolCall, withScriptedResponses } = await import('@openai/agents/testing');
  const checkFiles = [auth, oauth, authAlias].map(
    (path) => `if ( : < ${quote(path)} ) 2>/dev/null; then exit 12; fi`,
  );
  const cmd = [
    'set -eu',
    `test "$(cat ${quote(join(codex, 'ordinary.txt'))})" = ordinary`,
    'test -z "${OPENAI_API_KEY+x}${CODEX_HOME+x}"',
    ...checkFiles,
    'printf ready > ready',
    'tries=0; until test -f release; do tries=$((tries + 1)); test "$tries" -lt 200 || exit 13; /bin/sleep 0.05; done',
    ...checkFiles,
    'printf verified > verified',
  ].join('; ');
  await withScriptedResponses(
    [
      {
        items: [
          toolCall('exec_command', { cmd, yield_time_ms: 15_000 }, {
            callId: 'darwin-credential',
          }),
        ],
      },
      { items: [text('done')] },
    ],
    async (peer) => {
      const agent = new Agent({
        provider: peer.provider,
        model: 'gpt-5',
        instructions: 'Run the fixture.',
      });
      const session = await agent.session({
        environment: Environment.local({
          cwd: workspace,
          writePolicy: 'trusted_workspace_write',
          tools: ['exec_command'],
          approval: () => true,
        }),
      });
      try {
        const turn = await session.submit('Verify the synthetic credential masks.');
        const [result] = await Promise.all([turn.wait(), replaceAfterInitialCommandReads()]);
        assert.equal(result.finalOutput, 'done');
        const command = (await Array.fromAsync(session.items())).find(
          (item) => item.type === 'command_execution' && item.callId === 'darwin-credential',
        );
        assert.equal(command?.exitCode, 0);
        assert.equal(await readFile(join(workspace, 'verified'), 'utf8'), 'verified');
        console.log('PASS installed Darwin ambient auth and MCP masks before and after atomic replacement');
      } finally {
        await session.close();
      }
    },
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
