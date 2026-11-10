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
import { promisify } from 'node:util';

const execute = promisify(execFile);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const sha256 = /^[a-f0-9]{64}$/;
const goVersion = 'go1.26.10';
const callId = 'stock-go-trust';
const done = 'Go trust command finished.';
const outcomes = [
  'invalid-proxy',
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
  assert(stat.isFile() && (stat.mode & 0o077) === 0);
  return readFile(file, 'utf8');
}

function observation(data) {
  const { go, mode, connect, http, outcome, osStatus } = JSON.parse(data);
  assert.equal(go, goVersion);
  assert.equal(mode, 'system');
  for (const status of [connect, http]) {
    assert(
      Number.isInteger(status) &&
        (status === 0 || (status >= 100 && status <= 599)),
    );
  }
  assert(outcomes.includes(outcome));

  const result = { connect, http, outcome };
  if (osStatus !== undefined) {
    assert.match(osStatus, /^-?[0-9]{1,10}$/);
    result.osStatus = Number(osStatus);
  }
  const reproduced =
    connect === 200 && http === 0 &&
    outcome === 'certificate-verification-failed' && result.osStatus === -26276;
  return { ...result, result: reproduced ? 'reproduced' : 'different-tls-observation' };
}

const sandboxEmitters = ['/kernel', '/System/Library/Kernels/kernel', '/usr/libexec/sandboxd'];
const trustEmitters = ['/usr/libexec/trustd', '/usr/libexec/trustd.agent'];
const sandboxOperation = /^(mach-lookup|mach-register|file-read-(?:data|metadata|xattr)|file-write-(?:data|create|unlink)|sysctl-read|network-outbound)(?=$|\s)\s*/;
const publicServices = new Set([
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.TrustEvaluationAgent',
  'com.apple.securityd.xpc',
  'com.apple.securityd.systemkeychain',
  'com.apple.ocspd',
  'com.apple.trustdFileHelper',
]);
const publicPaths = new Set([
  '/System/Library/Keychains/SystemRootCertificates.keychain',
  '/Library/Keychains/System.keychain',
  '/Library/Security/Trust Settings/Admin.plist',
  '/etc/ssl/cert.pem',
  '/private/etc/ssl/cert.pem',
]);
const trustOperation = /^(?:sec_)?(trust_evaluate|trust_store_contains|trust_store_copy_all|trust_store_copy_usage_constraints)(?=$|[ \t,:;])[ \t,:;]*/;
const statusText = String.raw`(?:Error Domain=NSOSStatusErrorDomain Code=|OSStatus(?:[ \t]*[=:][ \t]*|[ \t]+))(-?[0-9]{1,10})`;
const trustStatus = new RegExp('^' + statusText + '$');
// Match metadata-only daemon messages. The adjacent "responding" trace
// formats the complete XPC reply and is excluded at the query boundary.
const trustMetadata = String.raw`(?:(?:operation:|returning error:)[ \t]*)?(?:[A-Za-z_][A-Za-z_0-9]{0,79}(?:[ \t]+(?:\([0-9]+\)|${statusText}))?|${statusText})`;
const logNotice = /^(?:Filtering the log data using |Skipping (?:info and debug|info|debug) messages[,.])/;

function correlation(pid) {
  assert(Number.isInteger(pid) && pid > 0 && pid <= 2 ** 31 - 1);
  const task = String.raw`github-trust\[${pid}\]/[01]#-?[0-9]+ LF=-?[0-9]+`;
  return [
    {
      emitters: sandboxEmitters,
      prefix: String.raw`(?:Sandbox(?:Violation)?: |\(\[[0-9]+\]\) )?github-trust\(${pid}\)[ \t]+deny(?:\([0-9]+\))?(?=$|[ \t])[ \t]*`,
    },
    {
      emitters: trustEmitters,
      // trustd.c prints the SecTask description, whose PID comes from the client audit token.
      prefix: String.raw`(?:XPC \[${task}\][ \t]+operation:[ \t]*|` +
        String.raw`(?:Authentication is needed )?${task}(?=$|[ \t:])[ \t:]*|` +
        String.raw`[Cc]lient[ _-]?[Pp][Ii][Dd][ \t]*[=:][ \t]*${pid}(?=$|[ \t,:;])[ \t,:;]*)`,
    },
  ];
}

export function summarizeLog(stdout, pid, start, end) {
  const [sandbox, trust] = correlation(pid);
  const sandboxPrefix = new RegExp('^' + sandbox.prefix);
  const trustPrefix = new RegExp('^' + trust.prefix + '(?=' + trustMetadata + '$)');
  const lines = stdout.trim().split(/\r?\n/);
  const trailer = JSON.parse(lines.pop());
  assert(trailer?.finished === 1 || trailer?.finished === true);
  let correlated = false;
  const evidence = [];
  for (const line of lines) {
    if (!line.trim() || logNotice.test(line)) continue;
    const { processImagePath, eventMessage, timestamp } = JSON.parse(line);
    const time = typeof timestamp === 'string' && /(?:Z|[+-]\d\d:?\d\d)$/.test(timestamp)
      ? Date.parse(timestamp.replace(' ', 'T'))
      : NaN;
    if (!(time >= start && time < end) || typeof eventMessage !== 'string') continue;
    if (sandbox.emitters.includes(processImagePath)) {
      const prefix = sandboxPrefix.exec(eventMessage);
      if (!prefix) continue;
      correlated = true;
      const op = sandboxOperation.exec(eventMessage.slice(prefix[0].length));
      if (!op) continue;
      const operation = op[1];
      const target = eventMessage.slice(prefix[0].length + op[0].length);
      if (operation.startsWith('mach-')) {
        const service = target.replace(/ \((?:global-name|local-name|per-pid)\)$/, '');
        evidence.push(publicServices.has(service) ? { operation, service } : { operation });
      } else if (operation.startsWith('file-') && target) {
        evidence.push(publicPaths.has(target)
          ? { operation, path: target }
          : { operation, pathKind: 'file-path-omitted' });
      } else {
        evidence.push({ operation });
      }
    } else if (trust.emitters.includes(processImagePath)) {
      const prefix = trustPrefix.exec(eventMessage);
      if (!prefix) continue;
      correlated = true;
      const detail = eventMessage.slice(prefix[0].length).replace(/^(?:operation:|returning error:)[ \t]*/, '');
      const op = trustOperation.exec(detail);
      const status = trustStatus.exec(detail.slice(op?.[0].length ?? 0));
      const daemonStatus = Number(status?.[1]);
      const hasStatus = daemonStatus >= -(2 ** 31) && daemonStatus < 2 ** 31;
      if (op || hasStatus) evidence.push({
        ...(op && { operation: op[1] }),
        ...(hasStatus && { daemonStatus }),
      });
    }
  }
  const logResult = evidence.length > 0
    ? 'attributed-operation-or-status'
    : correlated ? 'correlated-without-operation-or-status' : 'completed-zero-correlated';
  return { logResult, evidence };
}

async function queryLog(pid, start, end) {
  const predicate = correlation(pid).map(({ emitters, prefix }, i) => (
    '(processImagePath IN {' + emitters.map((path) => JSON.stringify(path)).join(', ') +
    '} AND eventMessage MATCHES ' +
    JSON.stringify(prefix + (i === 0 ? '[\\s\\S]*' : trustMetadata)) + ')'
  )).join(' OR ');
  const logDate = (time) => new Date(time).toISOString().slice(0, 19).replace('T', ' ') + '+0000';
  const unavailable = (logFailure) => ({ logResult: 'access-or-query-failure', logFailure });
  try {
    // These show options include existing records at those levels.
    const { stdout, stderr } = await execute('/usr/bin/log', [
      'show', '--style', 'ndjson', '--no-pager', '--info', '--debug', '--timezone', 'UTC',
      '--start', logDate(start), '--end', logDate(end), '--predicate', predicate,
    ], {
      env: { LC_ALL: 'C' },
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
    });
    if (stderr.split(/\r?\n/).some((line) => line.trim() && !logNotice.test(line))) {
      return unavailable('unexpected-diagnostic');
    }
    try {
      return summarizeLog(stdout, pid, start, end);
    } catch {
      return unavailable('incomplete-or-invalid-ndjson');
    }
  } catch (error) {
    if (Number.isInteger(error.code)) {
      return { ...unavailable('command-exit'), logExitCode: error.code };
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return unavailable('output-limit');
    return unavailable(error.killed ? 'query-interrupted' : 'command-unavailable');
  }
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
      'status=0',
      "/bin/date -u '+%Y-%m-%dT%H:%M:%SZ' > .probe-start",
      '/usr/bin/env -i HTTPS_PROXY="$HTTPS_PROXY" ./github-trust system > system.json 2>/dev/null &',
      'pid=$!',
      'wait "$pid" || status=$?',
      "/bin/date -u '+%Y-%m-%dT%H:%M:%SZ' > .probe-end",
      'printf "%s\\n" "$pid" > .probe-pid',
      'exit "$status"',
    ].join('\n');

    phase = 'strict native command';
    const receipt = await withModel(
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
            const proxy = await readPrivate(cwd, '.sdk-loopback-proxy');
            const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?\n$/.exec(proxy);
            assert(match && match[0] === proxy && Number(match[1]) <= 65535);

            const pidText = await readPrivate(cwd, '.probe-pid');
            assert.match(pidText, /^[1-9][0-9]{0,9}\n$/);
            const pid = Number(pidText);
            assert(pid <= 2 ** 31 - 1);
            const stamp = async (name) => {
              const value = await readPrivate(cwd, name);
              assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d:\d\dZ\n$/);
              const time = Date.parse(value.trim());
              assert(Number.isFinite(time));
              return time;
            };
            const start = await stamp('.probe-start');
            // Include the rest of the exit second with an exclusive upper bound.
            const end = (await stamp('.probe-end')) + 1000;
            assert(end > start && end - start <= 15_000);
            const tls = observation(await readPrivate(cwd, 'system.json'));
            phase = 'Session cleanup and synthetic model verification';
            return { pid, start, end, tls, canaryDenied: 1, exitCode: execution.exitCode };
          } finally {
            await session.close();
          }
        } finally {
          await provider.close();
        }
      },
    );

    phase = 'host unified log query';
    const { pid, start, end, tls, canaryDenied, exitCode } = receipt;
    const log = await queryLog(pid, start, end);
    console.log(JSON.stringify({
      pid,
      window: { start: new Date(start).toISOString(), endExclusive: new Date(end).toISOString() },
      canaryDenied,
      exitCode,
      tls,
      ...log,
    }));
    if (log.logResult === 'access-or-query-failure') process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.log(JSON.stringify({ result: 'infrastructure-failure', phase }));
    process.exitCode = 1;
  }
}
