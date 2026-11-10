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
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';

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

function observation(data) {
  const { go, mode, connect, http, outcome, osStatus, peerSha256 } = JSON.parse(data);
  assert.equal(go, goVersion);
  assert.equal(mode, 'system');
  for (const status of [connect, http]) {
    assert(
      Number.isInteger(status) &&
        (status === 0 || (status >= 100 && status <= 599)),
    );
  }
  assert(outcomes.includes(outcome));

  const verified = outcome === 'verified';
  const metadata = { connect, http, verified };
  if (verified) assert(connect === 200 && http > 0 && peerSha256);
  if (peerSha256 !== undefined) {
    assert(Array.isArray(peerSha256) && peerSha256.length > 0);
    for (const digest of peerSha256) assert.match(digest, sha256);
  }
  if (osStatus !== undefined) {
    assert.equal(outcome, 'certificate-verification-failed');
    assert.match(osStatus, /^-?[0-9]{1,10}$/);
    const code = Number(osStatus);
    assert(code >= -(2 ** 31) && code < 2 ** 31);
    metadata.osStatus = code;
  }
  return { metadata, peerSha256 };
}

function compare(writePolicy, child, host) {
  const bothPresented = child?.peerSha256 !== undefined && host?.peerSha256 !== undefined;
  const samePresentedChain = bothPresented && isDeepStrictEqual(child.peerSha256, host.peerSha256);
  let result;
  if (!host?.metadata.verified || (bothPresented && !samePresentedChain)) {
    result = 'control-drift';
  } else if (child?.metadata.verified) {
    result = 'verified-tls';
  } else if (writePolicy === 'trusted_workspace_write') {
    result = 'trusted-tls-failure';
  } else if (samePresentedChain && child.metadata.connect === 200 &&
      child.metadata.http === 0 && child.metadata.osStatus === -26276) {
    result = 'strict-baseline-reproduced';
  } else {
    result = 'strict-tls-failure';
  }
  return { result, samePresentedChain, child: child?.metadata, host: host?.metadata };
}

async function optionalReceipt(read) {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function readListener(cwd) {
  const proxy = await readPrivate(cwd, '.sdk-loopback-proxy');
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?\n$/.exec(proxy);
  assert(match && match[0] === proxy && Number(match[1]) <= 65535);
  return proxy.slice(0, -1);
}

const sandboxEmitters = ['/kernel', '/System/Library/Kernels/kernel', '/usr/libexec/sandboxd'];
const trustEmitters = ['/usr/libexec/trustd', '/usr/libexec/trustd.agent'];
const sandboxOperation = /^(mach-lookup|mach-register|file-read-(?:data|metadata|xattr)|file-write-(?:data|create|unlink)|sysctl-read|network-outbound)(?=$|\s)\s*/;
const pathClasses = new Map([
  ['/System/Library/Keychains/SystemRootCertificates.keychain', 'system-keychain'],
  ['/System/Library/Keychains/SystemCACertificates.keychain', 'system-keychain'],
  ['/Library/Keychains/System.keychain', 'system-keychain'],
  ['/Library/Security/Trust Settings/Admin.plist', 'admin-trust-settings'],
  ['/var/protected/trustd/private/Admin.plist', 'admin-trust-settings'],
  ['/private/var/protected/trustd/private/Admin.plist', 'admin-trust-settings'],
  ['/etc/ssl/cert.pem', 'stock-pem'],
  ['/private/etc/ssl/cert.pem', 'stock-pem'],
]);
const userTrustSettings = /^\/(?:Library\/Security\/Trust Settings|(?:private\/)?var\/protected\/trustd\/private)\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\/TrustSettings\.plist$/;

function classifyPath(target, runnerHome) {
  if (/[\r\n]/.test(target)) return 'unclassified-target';
  if (pathClasses.has(target)) return pathClasses.get(target);
  if (userTrustSettings.test(target)) return 'user-trust-settings';
  if (runnerHome) {
    const prefix = join(runnerHome, 'Library/Keychains') + sep;
    if (target.startsWith(prefix)) {
      const relative = target.slice(prefix.length);
      if (/^.+\.(?:keychain(?:-db)?|db)$/.test(relative) &&
          relative.split('/').every((part) => part && part !== '.' && part !== '..')) {
        return 'user-keychain';
      }
    }
  }
  return 'unclassified-target';
}
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

export function summarizeLog(stdout, pid, start, end, runnerHome) {
  const [sandbox, trust] = correlation(pid);
  const sandboxPrefix = new RegExp('^' + sandbox.prefix);
  const trustPrefix = new RegExp('^' + trust.prefix + '(?=' + trustMetadata + '$)');
  const lines = stdout.trim().split(/\r?\n/);
  const trailer = JSON.parse(lines.pop());
  assert(trailer?.finished === 1 || trailer?.finished === true);
  let correlated = false;
  const operationCounts = {};
  const pathClassCounts = {};
  const daemonStatusCounts = {};
  const increment = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
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
      increment(operationCounts, operation);
      if (operation.startsWith('file-')) {
        const target = eventMessage.slice(prefix[0].length + op[0].length);
        increment(pathClassCounts, classifyPath(target, runnerHome));
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
      if (op) increment(operationCounts, op[1]);
      if (hasStatus) increment(daemonStatusCounts, daemonStatus);
    }
  }
  const logResult = Object.keys(operationCounts).length || Object.keys(daemonStatusCounts).length
    ? 'attributed-operation-or-status'
    : correlated ? 'correlated-without-operation-or-status' : 'completed-zero-correlated';
  return { logResult, operationCounts, pathClassCounts, daemonStatusCounts };
}

async function queryLog(pid, start, end, runnerHome) {
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
      return summarizeLog(stdout, pid, start, end, runnerHome);
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

async function readUtcStamp(cwd, name) {
  const value = await readPrivate(cwd, name);
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
  const time = Date.parse(value.trim());
  assert(Number.isFinite(time));
  assert.equal(value, new Date(time).toISOString().replace('.000Z', 'Z') + '\n');
  return time;
}

export async function collectDiagnostic(cwd, commandStartedAt, runnerHome) {
  const assertions = {};
  const check = async (name, validate) => {
    try {
      const value = await validate();
      assertions[name] = 'pass';
      return value;
    } catch {
      assertions[name] = 'fail';
    }
  };

  const pid = await check('probePid', async () => {
    const value = await readPrivate(cwd, '.probe-pid');
    assert.match(value, /^[1-9][0-9]{0,9}\n$/);
    const pid = Number(value);
    assert(pid <= 2 ** 31 - 1);
    return pid;
  });
  const start = await check('probeStartUtc', () => readUtcStamp(cwd, '.probe-start'));
  const exitSecond = await check('probeEndUtc', () => readUtcStamp(cwd, '.probe-end'));
  assertions.probeWindow = 'skipped';
  let end;
  if (start !== undefined && exitSecond !== undefined) {
    end = await check('probeWindow', async () => {
      // Include the exit second without asking log show for a future end time.
      const end = exitSecond + 1000;
      const now = Date.now();
      assert(start >= Math.floor(commandStartedAt / 1000) * 1000);
      assert(start <= exitSecond && end - start <= 15_000 && exitSecond <= now);
      if (end > now) await delay(end - now);
      assert(end <= Date.now());
      return end;
    });
  }

  let log;
  if (pid !== undefined && end !== undefined) {
    log = await queryLog(pid, start, end, runnerHome);
  } else {
    log = {
      logResult: 'skipped',
      logSkipReason: pid === undefined
        ? end === undefined ? 'unvalidated-pid-and-window' : 'unvalidated-pid'
        : 'unvalidated-window',
    };
  }

  return { assertions, ...log };
}

const command = [
  'set -eu',
  'umask 077',
  'if (printf changed > ../sandbox-canary) 2>/dev/null; then exit 27; fi',
  'printf "%s\\n" workspace > .workspace-canary',
  'test "$(/bin/cat .workspace-canary)" = workspace',
  'test -n "${HTTPS_PROXY:-}"',
  '(printf "%s\\n" "$HTTPS_PROXY" > .sdk-loopback-proxy) 2>/dev/null || :',
  'status=0',
  "/bin/date -u '+%Y-%m-%dT%H:%M:%SZ' > .probe-start",
  '/usr/bin/env -i HTTPS_PROXY="$HTTPS_PROXY" ./github-trust system > system.json 2>/dev/null &',
  'pid=$!',
  'wait "$pid" || status=$?',
  "/bin/date -u '+%Y-%m-%dT%H:%M:%SZ' > .probe-end",
  'printf "%s\\n" "$pid" > .probe-pid',
  'exit "$status"',
].join('\n');

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
  const runnerHome = await realpath(homedir());
  const temporary = await mkdtemp(join(runnerHome, '.agents-go-trust-'));
  try {
    // Both Sessions use the stock native sandbox. Only their workspace and write policy differ.
    for (const writePolicy of ['strict', 'trusted_workspace_write']) {
      phase = `${writePolicy} workspace setup`;
      const root = join(temporary, writePolicy);
      const cwd = join(root, 'workspace');
      const canary = join(root, 'sandbox-canary');
      await mkdir(cwd, { recursive: true });
      await writeFile(canary, 'protected');
      const binary = join(cwd, 'github-trust');
      await copyFile(sourceBinary, binary);
      await chmod(binary, 0o700);
      const copiedSha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
      assert.equal(copiedSha256, binarySha256);

      phase = `${writePolicy} Session and host control`;
      let commandStartedAt;
      const run = await optionalReceipt(() => withModel(
        [
          [{
            type: 'function_call',
            call_id: callId,
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: command, yield_time_ms: 20_000 }),
          }],
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
                writePolicy,
                tools: ['exec_command'],
                network: { allowedDomains: ['api.github.com'] },
              }),
            });
            try {
              commandStartedAt = Date.now();
              const turn = await session.submit('Run the probe.');
              assert.equal((await turn.wait()).finalOutput, done);
              const commands = (await Array.fromAsync(session.items())).filter(
                (item) => item.type === 'command_execution',
              );
              assert.equal(commands.length, 1);
              const [execution] = commands;
              assert.equal(execution.callId, callId);

              const child = await optionalReceipt(async () =>
                observation(await readPrivate(cwd, 'system.json')),
              );
              const proxy = await optionalReceipt(() => readListener(cwd));
              const host = proxy && await optionalReceipt(async () => {
                const { stdout } = await execute(binary, ['system'], {
                  cwd,
                  env: { HTTPS_PROXY: proxy },
                  timeout: 12_000,
                  killSignal: 'SIGKILL',
                  maxBuffer: 64 * 1024,
                });
                return observation(stdout);
              });
              return { execution, child, host, sameManagedListener: proxy !== undefined };
            } finally {
              await session.close();
            }
          } finally {
            await provider.close();
          }
        },
      ));

      phase = `${writePolicy} diagnostic receipt collection`;
      const { execution, child, host, sameManagedListener = false } = run ?? {};
      const exitCode = execution?.exitCode;
      const workspaceWriteRead = exitCode === 0 &&
        await optionalReceipt(() => readPrivate(cwd, '.workspace-canary')) === 'workspace\n';
      const outsideWriteDenied = (workspaceWriteRead || child !== undefined) &&
        await readFile(canary, 'utf8') === 'protected';
      const commandPassed = execution?.status === 'completed' && workspaceWriteRead && outsideWriteDenied;
      const comparison = compare(writePolicy, child, host);
      const result = commandPassed ? comparison.result : 'probe-failure';
      const diagnostic = writePolicy === 'trusted_workspace_write' && !child?.metadata.verified
        ? commandStartedAt === undefined
          ? { logResult: 'skipped', logSkipReason: 'command-not-started' }
          : await collectDiagnostic(cwd, commandStartedAt, runnerHome)
        : undefined;
      console.log(JSON.stringify({
        writePolicy, exitCode, outsideWriteDenied, workspaceWriteRead,
        ...comparison, result, sameManagedListener, ...diagnostic,
      }));
      if (result !== 'verified-tls' && result !== 'strict-baseline-reproduced') process.exitCode = 1;
    }
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
