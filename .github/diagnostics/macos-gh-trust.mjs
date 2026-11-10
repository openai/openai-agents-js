import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const sha256 = /^[a-f0-9]{64}$/;
const callId = 'stock-gh-trust';
const done = 'GitHub CLI trust commands finished.';

let phase = 'installed SDK validation';
async function verifyInstalled(starter) {
  const build = await json(join(starter, 'verification-build.json'));
  assert.equal(build.platform, 'darwin-arm64');
  const require = createRequire(import.meta.url);
  const modules = await realpath(join(starter, 'node_modules'));
  assert(modules.startsWith(starter + sep));
  for (const [name, { version }] of Object.entries(build.packages)) {
    const root = await realpath(join(modules, name));
    assert.equal(root, join(modules, name));
    assert((await realpath(require.resolve(name))).startsWith(root + sep));
    const esmEntry = await realpath(new URL(import.meta.resolve(name)));
    assert(esmEntry.startsWith(root + sep));
    const manifest = await json(join(root, 'package.json'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, version);
  }

  const codex = join(modules, '@openai/agents-codex');
  const releaseReceipt = await readFile(
    join(starter, 'release-native-receipt.json'),
  );
  assert.deepEqual(
    await readFile(join(codex, 'native/build-receipt.json')),
    releaseReceipt,
  );
  const native = JSON.parse(releaseReceipt);
  assert.equal(native.format, 'reviewed-native-v1');
  assert.equal(native.release, true);
  assert.equal(native.host, 'aarch64-apple-darwin');
  assert.equal(native.sources.codex.revision, build.codexRevision);
  assert.equal(
    (await readFile(join(codex, 'native/CODEX_REVISION'), 'utf8')).trim(),
    build.codexRevision,
  );
  const helpers = [
    'bin/codex-code-mode-host',
    'bin/codex-execve-wrapper',
    'bin/codex-sdk-runtime',
  ];
  assert.deepEqual(Object.keys(native.products).sort(), [...helpers, 'native/codex.node']);
  for (const [relative, expected] of Object.entries(native.products)) {
    const file = join(codex, relative);
    const stat = await lstat(file);
    assert(stat.isFile() && stat.size > 0);
    if (helpers.includes(relative)) assert(stat.mode & 0o111);
    assert.equal(await realpath(file), file);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.equal(`sha256:${hash.digest('hex')}`, expected);
  }
}

const message = (text) => ({
  type: 'message',
  id: 'answer',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});

// Responses SSE framing from the pinned installed alpha consumer.
async function withModel(responses, run) {
  let requests = 0;
  let failed = false;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer synthetic-alpha-key');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const script = responses[requests++];
      assert(script);
      const output = typeof script === 'function' ? script(body) : script;
      const id = `response-${requests}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id } },
        ...output.map((item, output_index) => ({
          type: 'response.output_item.done',
          output_index,
          item,
        })),
        { type: 'response.completed', response: { id, output } },
      ])
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch {
      failed = true;
      response.writeHead(500).end('Synthetic model verification failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await run(`http://127.0.0.1:${server.address().port}/v1`);
    assert.equal(failed, false);
    assert.equal(requests, responses.length);
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function readPrivate(cwd, name) {
  const file = join(cwd, name);
  const stat = await lstat(file);
  assert(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= 64 * 1024);
  return readFile(file, 'utf8');
}

async function readListener(cwd) {
  const proxy = await readPrivate(cwd, '.sdk-loopback-proxy');
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?\n$/.exec(proxy);
  assert(match && match[0] === proxy && Number(match[1]) <= 65535);
  return proxy.slice(0, -1);
}

export function observation(statusText, httpText, stderr) {
  assert.match(statusText, /^(?:0|[1-9][0-9]{0,2})\n$/);
  const exitCode = Number(statusText);
  const httpMatch = /^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) ([1-5][0-9]{2})(?:[ \t][^\r\n]*)?\r?\n?$/.exec(httpText);
  if (httpMatch) return { exitCode, connect: 200, tls: 'verified', http: Number(httpMatch[1]) };
  const target = /^Get "https:\/\/api\.github\.com\/": .*$/m.exec(stderr)?.[0];
  if (target && /\bx509:/.test(target)) {
    const osStatus = /\bOSStatus (-?[0-9]{1,10})\b/.exec(target);
    return { exitCode, connect: 200, tls: 'verification-failed', http: null,
      ...(osStatus && { osStatus: Number(osStatus[1]) }) };
  }
  if (target && /\btls:/.test(target)) {
    return { exitCode, connect: null, tls: 'handshake-failed', http: null };
  }
  return { exitCode, connect: null, tls: 'unobserved', http: null,
    failure: /To get started with GitHub CLI, please run:[\s\S]*gh auth login/.test(stderr)
      ? 'local-auth-required' : 'unclassified' };
}

const command = [
  'set -eu',
  'umask 077',
  'if (printf changed > ../sandbox-canary) 2>/dev/null; then exit 27; fi',
  'printf "%s\\n" workspace > .workspace-canary',
  'test "$(/bin/cat .workspace-canary)" = workspace',
  'test -n "${HTTPS_PROXY:-}"',
  'printf "%s\\n" "$HTTPS_PROXY" > .sdk-loopback-proxy',
  'synthetic=0',
  'run_gh() {',
  '  leg=$1; shift; status=0',
  '  if [ "$synthetic" = 1 ]; then set -- GH_TOKEN=synthetic-noncredential-nov9 "$@"; fi',
  '  /usr/bin/env -i HOME="$PWD/gh-home" GH_CONFIG_DIR="$PWD/gh-config" GH_HOST=github.com \\',
  '    GH_PROMPT_DISABLED=1 GH_TELEMETRY=0 GH_NO_UPDATE_NOTIFIER=1 \\',
  '    GH_NO_EXTENSION_UPDATE_NOTIFIER=1 HTTPS_PROXY="$HTTPS_PROXY" "$@" \\',
  '    ./gh api --hostname github.com --method GET --silent --include / > "$leg.stdout" 2> "$leg.stderr" || status=$?',
  '  /usr/bin/sed -n "1p" "$leg.stdout" > "$leg.http"',
  '  /bin/rm "$leg.stdout"',
  '  printf "%s\\n" "$status" > "$leg.exit"',
  '}',
  'run_gh default',
  'if [ ! -s default.http ] && /usr/bin/grep -q "To get started with GitHub CLI, please run:" default.stderr; then',
  '  synthetic=1',
  '  run_gh default',
  'fi',
  'run_gh pem SSL_CERT_FILE=/etc/ssl/cert.pem',
  'printf "%s\\n" "$synthetic" > .synthetic',
].join('\n');

function assertNoGitHubKeychainItem() {
  // Look up item metadata only and capture the result without printing it.
  const env = { HOME: homedir(), LANG: 'C', LC_ALL: 'C' };
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'gh:github.com'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    assert(Number.isInteger(error.status) && error.status !== 0 &&
      /could not be found in the keychain/i.test(String(error.stderr)));
    return;
  }
  throw new Error('GitHub Keychain item present');
}

async function main() {
  assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64');
  assert(process.getuid() > 0);
  assert.equal(process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX, '1');
  const starter = await realpath(process.cwd());
  await verifyInstalled(starter);
  const { Agent, Environment, NativeProvider } = await import('@openai/agents');
  phase = 'credential isolation preflight';
  assertNoGitHubKeychainItem();

  phase = 'probe workspace setup';
  const [sourceBinary, binarySha256] = process.argv.slice(2);
  assert.match(binarySha256, sha256);
  const temporary = await mkdtemp(join(await realpath(homedir()), '.agents-gh-trust-'));
  try {
    const cwd = join(temporary, 'workspace');
    const canary = join(temporary, 'sandbox-canary');
    await mkdir(cwd);
    for (const dir of ['gh-home', 'gh-config']) await mkdir(join(cwd, dir), { mode: 0o700 });
    await writeFile(canary, 'protected');
    const binary = join(cwd, 'gh');
    await copyFile(sourceBinary, binary);
    await chmod(binary, 0o700);
    const copiedSha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    assert.equal(copiedSha256, binarySha256);

    phase = 'strict SDK command';
    await withModel(
      [[{
        type: 'function_call',
        call_id: callId,
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: command, yield_time_ms: 45_000 }),
      }], [message(done)]],
      async (baseUrl) => {
        const provider = new NativeProvider({
          baseUrl,
          apiKey: 'synthetic-alpha-key',
          supportsWebsockets: false,
          requestMaxRetries: 0,
          streamMaxRetries: 0,
        });
        try {
          const agent = new Agent({ instructions: 'Run the requested command.', model: 'gpt-5.5', provider });
          const session = await agent.session({
            environment: Environment.local({
              cwd,
              writePolicy: 'strict',
              tools: ['exec_command'],
              network: { allowedDomains: ['api.github.com'] },
            }),
          });
          try {
            const turn = await session.submit('Run the probe.');
            assert.equal((await turn.wait()).finalOutput, done);
            const executions = (await Array.fromAsync(session.items())).filter(
              (item) => item.type === 'command_execution',
            );
            assert.equal(executions.length, 1);
            const [execution] = executions;
            assert.equal(execution.callId, callId);
            assert.equal(execution.status, 'completed');
            assert.equal(execution.exitCode, 0);
          } finally {
            await session.close();
          }
        } finally {
          await provider.close();
        }
      },
    );

    phase = 'sanitized receipt';
    await readListener(cwd);
    const workspaceWriteRead = (await readPrivate(cwd, '.workspace-canary')) === 'workspace\n';
    const outsideWriteDenied = (await readFile(canary, 'utf8')) === 'protected';
    const syntheticFlag = await readPrivate(cwd, '.synthetic');
    assert.match(syntheticFlag, /^[01]\n$/);
    const synthetic = syntheticFlag === '1\n';
    const readLeg = async (name) => observation(
      await readPrivate(cwd, name + '.exit'),
      await readPrivate(cwd, name + '.http'),
      await readPrivate(cwd, name + '.stderr'),
    );
    const defaultTrust = await readLeg('default');
    const explicitPem = await readLeg('pem');
    const demonstrated = workspaceWriteRead && outsideWriteDenied &&
      defaultTrust.osStatus === -26276 && explicitPem.tls === 'verified' &&
      (!synthetic || explicitPem.http === 401);
    console.log(JSON.stringify({
      result: demonstrated ? 'explicit-pem-demonstrated' : 'comparison-did-not-demonstrate-workaround',
      defaultTrust, explicitPem, synthetic, workspaceWriteRead, outsideWriteDenied,
      sameManagedListener: true, endpoint: 'https://api.github.com/',
      certificateIdentity: 'not-exposed-by-stock-cli',
    }));
    if (!demonstrated) process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    console.log(JSON.stringify({ result: 'infrastructure-failure', phase }));
    process.exitCode = 1;
  }
}
