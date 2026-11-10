import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
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
import { isDeepStrictEqual, promisify } from 'node:util';

const execute = promisify(execFile);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const sha256 = /^[a-f0-9]{64}$/;
const goVersion = 'go1.26.10';
const modes = ['system', 'pem'];
const callId = 'stock-go-trust';
const done = 'Go trust command finished.';
const outcomes = [
  'invalid-proxy',
  'pem-read-failed',
  'pem-parse-failed',
  'transport-error',
  'certificate-verification-failed',
  'missing-verified-chain',
  'verified',
];

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
  for (const [relative, expected] of Object.entries(native.products)) {
    const file = join(codex, relative);
    assert((await lstat(file)).isFile());
    assert.equal(await realpath(file), file);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.equal(`sha256:${hash.digest('hex')}`, expected);
  }
  console.log(
    JSON.stringify({
      sdk: build.version,
      sdkCommit: build.sourceCommit,
      codexRevision: build.codexRevision,
      installedNativeProductsVerified: Object.keys(native.products).length,
    }),
  );
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

function fingerprints(value) {
  assert(Array.isArray(value) && value.length > 0);
  for (const digest of value) assert.match(digest, sha256);
  return value;
}

function observation(leg, expectedMode, data) {
  const {
    go,
    mode,
    connect,
    http,
    outcome,
    osStatus,
    pemSha256,
    peerSha256,
    verifiedChainsSha256,
  } = JSON.parse(data);
  assert.equal(go, goVersion);
  assert.equal(mode, expectedMode);
  for (const status of [connect, http]) {
    assert(
      Number.isInteger(status) &&
        (status === 0 || (status >= 100 && status <= 599)),
    );
  }
  assert(outcomes.includes(outcome));

  const result = { leg, go, mode, connect, http, outcome };
  if (osStatus !== undefined) {
    assert.match(osStatus, /^-?[0-9]{1,10}$/);
    result.osStatus = Number(osStatus);
  }
  if (pemSha256 !== undefined) {
    assert.match(pemSha256, sha256);
    result.pemSha256 = pemSha256;
  }
  if (peerSha256 !== undefined) result.peerSha256 = fingerprints(peerSha256);
  if (verifiedChainsSha256 !== undefined) {
    assert(Array.isArray(verifiedChainsSha256) && verifiedChainsSha256.length > 0);
    result.verifiedChainsSha256 = verifiedChainsSha256.map(fingerprints);
  }
  if (outcome === 'verified')
    assert(http && result.peerSha256 && result.verifiedChainsSha256);
  return result;
}

function classify(observations) {
  const [hostSystem, hostPem, strictSystem, strictPem] = observations;
  const inconclusive = (reason) => ({ result: 'inconclusive', reason });
  if (observations.some(({ connect }) => connect !== 200))
    return inconclusive('CONNECT control failed');
  const controls = [hostSystem, hostPem, strictPem];
  if (controls.some(({ outcome }) => outcome !== 'verified'))
    return inconclusive('TLS control failed');
  if (!hostPem.pemSha256 || hostPem.pemSha256 !== strictPem.pemSha256)
    return inconclusive('PEM digests differ or are missing');
  if (observations.some(
    ({ peerSha256 }) => !isDeepStrictEqual(peerSha256, hostSystem.peerSha256),
  ))
    return inconclusive('Presented peer chains differ or are missing');

  if (strictSystem.outcome === 'verified') return { result: 'non-reproduction' };
  if (strictSystem.outcome === 'certificate-verification-failed') {
    return {
      result: strictSystem.osStatus === -26276
        ? 'reproduced'
        : 'different-certificate-verification-error',
    };
  }
  return inconclusive('Strict system request did not establish a TLS verification outcome');
}

async function main() {
  assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64');
  assert(process.getuid() > 0);
  assert.equal(process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX, '1');
  const starter = await realpath(process.cwd());
  await verifyInstalled(starter);
  const { Agent, Environment, NativeProvider } = await import('@openai/agents');

  phase = 'probe workspace setup';
  const [sourceBinary, binarySha256] = process.argv.slice(2);
  assert.match(binarySha256, sha256);
  const temporary = await mkdtemp(join(homedir(), '.agents-go-trust-'));
  try {
    const root = await realpath(temporary);
    const cwd = join(root, 'workspace');
    const canary = join(root, 'sandbox-canary');
    await mkdir(cwd);
    await writeFile(canary, 'protected');
    const binary = join(cwd, 'github-trust');
    await copyFile(sourceBinary, binary);
    await chmod(binary, 0o700);
    const copiedSha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex');
    assert.equal(copiedSha256, binarySha256);
    const command = [
      'set -eu',
      'umask 077',
      'if (printf changed > ../sandbox-canary) 2>/dev/null; then exit 27; fi',
      'test -n "${HTTPS_PROXY:-}"',
      'printf "%s\\n" "$HTTPS_PROXY" > .sdk-loopback-proxy',
      '/usr/bin/env -i HTTPS_PROXY="$HTTPS_PROXY" ./github-trust system > system.json 2>/dev/null',
      '/usr/bin/env -i HTTPS_PROXY="$HTTPS_PROXY" ./github-trust pem > pem.json 2>/dev/null',
    ].join('\n');

    phase = 'strict native command';
    const observations = await withModel(
      [
        [
          {
            type: 'function_call',
            call_id: callId,
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: command, yield_time_ms: 20_000 }),
          },
        ],
        [message(done)],
      ],
      async (baseUrl) => {
        const provider = new NativeProvider({
          baseUrl,
          apiKey: 'synthetic-alpha-key',
          supportsWebsockets: false,
          requestMaxRetries: 0,
          streamMaxRetries: 0,
        });
        try {
          const agent = new Agent({
            instructions: 'Run the requested command.',
            model: 'gpt-5.5',
            provider,
          });
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
            const commands = (await Array.fromAsync(session.items())).filter(
              (item) => item.type === 'command_execution',
            );
            assert.equal(commands.length, 1);
            const [execution] = commands;
            assert.equal(execution.callId, callId);
            assert.equal(execution.status, 'completed');
            assert.equal(execution.exitCode, 0);
            assert.equal(await readFile(canary, 'utf8'), 'protected');

            phase = 'strict receipts and loopback proxy validation';
            const strict = [];
            for (const mode of modes) {
              const data = await readFile(join(cwd, `${mode}.json`), 'utf8');
              strict.push(observation('strict', mode, data));
            }
            const proxyFile = join(cwd, '.sdk-loopback-proxy');
            const stat = await lstat(proxyFile);
            assert(stat.isFile() && (stat.mode & 0o077) === 0);
            const proxy = await readFile(proxyFile, 'utf8');
            const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?\n$/.exec(proxy);
            assert(match && match[0] === proxy && Number(match[1]) <= 65535);
            const endpoint = proxy.slice(0, -1);

            phase = 'host controls through the live SDK proxy';
            const host = [];
            for (const mode of modes) {
              const { stdout } = await execute(binary, [mode], {
                cwd,
                env: { HTTPS_PROXY: endpoint },
                timeout: 12_000,
              });
              host.push(observation('host', mode, stdout));
            }
            const observations = [...host, ...strict];
            console.log(
              JSON.stringify({
                command: {
                  status: execution.status,
                  exitCode: execution.exitCode,
                  outsideWorkspaceWrite: 'denied',
                },
                observations,
              }),
            );
            phase = 'Session cleanup and synthetic model verification';
            return observations;
          } finally {
            await session.close();
          }
        } finally {
          await provider.close();
        }
      },
    );

    phase = 'TLS comparison';
    const verdict = classify(observations);
    const httpNon2xx = observations
      .filter(
        ({ outcome, http }) => outcome === 'verified' && (http < 200 || http >= 300),
      )
      .map(({ leg, mode, http }) => ({ leg, mode, http }));
    console.log(JSON.stringify({ ...verdict, httpNon2xx }));
    if (verdict.result === 'inconclusive') process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
  await main();
} catch {
  console.log(JSON.stringify({ result: 'infrastructure-failure', phase }));
  process.exitCode = 1;
}
