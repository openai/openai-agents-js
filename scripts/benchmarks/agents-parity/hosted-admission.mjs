/** Untimed, SDK-free container admission; no measurement execution path. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { lstat, chmod, copyFile, mkdir, mkdtemp, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, parse } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const image = 'docker.io/library/python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170';
const nodeVersion = 'v24.11.1';
const peerHash = '28ba24e1c0e940e6d598dc91874dfda982dcb8d9bbf1f7556f9798b99ec4d3b5';
const self = fileURLToPath(import.meta.url);
const label = 'org.openai.f9-untimed-owner';
const namespaces = ['net', 'pid', 'mnt', 'ipc'];
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const blank = () => ({ admitted: false, SDKExecuted: false, timingStarted: false, samples: 0 });
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const safeFailure = (error) => ({ name: error.name, code: error.code ?? null, message: error instanceof assert.AssertionError ? error.message : 'Admission operation failed; no SDK execution.' });

async function gitFree(path) {
  const resolved = await realpath(path);
  assert.equal(resolved, path, 'Staging path must have no symlink components');
  for (let current = resolved; ; current = dirname(current)) {
    let present = true;
    try { await lstat(join(current, '.git')); } catch (error) {
      assert.equal(error.code, 'ENOENT');
      present = false;
    }
    assert.equal(present, false, 'Git ancestry is not eligible');
    if (current === parse(current).root) break;
  }
  return resolved;
}

async function ns(pid = 'self') {
  return Object.fromEntries(await Promise.all(namespaces.map(async (name) => [name, await readlink(`/proc/${pid}/ns/${name}`)])));
}

function childEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.RUNNER_TEMP, LANG: 'C.UTF-8' };
}

async function docker(args, timeout = 15000) {
  return execute('docker', args, { env: childEnvironment(), timeout, maxBuffer: 1024 * 1024 });
}

async function inspect(cid) {
  assert.match(cid, /^[a-f0-9]{64}$/);
  return JSON.parse((await docker(['inspect', cid])).stdout)[0];
}

async function ownerContext() {
  assert.equal(process.platform, 'linux');
  assert.match(process.env.F9_OWNER ?? '', /^\d+:\d+$/);
  assert(process.env.RUNNER_TEMP, 'RUNNER_TEMP is required');
  const temporary = await gitFree(await realpath(process.env.RUNNER_TEMP));
  return { owner: process.env.F9_OWNER, output: join(temporary, 'f9-untimed-admission-result'), temporary };
}

async function cleanup(context) {
  let cid;
  try { cid = (await readFile(join(context.output, 'container.id'), 'utf8')).trim(); }
  catch (error) {
    if (error.code === 'ENOENT') assert.fail('Missing exact container identity; cleanup remains unconfirmed');
    throw error;
  }
  assert.match(cid, /^[a-f0-9]{64}$/);
  const exists = (await docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${cid}`])).stdout.trim();
  if (!exists) return;
  assert.equal(exists, cid, 'Ambiguous container identity');
  const container = await inspect(cid);
  assert.equal(container.Config.Labels?.[label], context.owner, 'Foreign container owner');
  await docker(['rm', '--force', cid]);
  assert.equal((await docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${cid}`])).stdout.trim(), '', 'Owned container remains');
}

function validateContainer(container, context, inputs, uid) {
  const host = container.HostConfig;
  assert.equal(container.Config.Image, image);
  assert.equal(host.NetworkMode, 'none');
  assert(['', 'private'].includes(host.PidMode));
  assert(['', 'private', 'shareable'].includes(host.IpcMode));
  assert.equal(host.Privileged, false);
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.Init, true);
  assert.equal(container.Config.User, uid);
  assert.equal(container.Config.Labels?.[label], context.owner);
  assert.equal(host.CapAdd?.length ?? 0, 0);
  assert(host.CapDrop.includes('ALL'));
  assert(host.SecurityOpt.some((item) => /^no-new-privileges(?::true)?$/.test(item)));
  assert.equal(host.Devices?.length ?? 0, 0);
  assert.equal(host.DeviceRequests?.length ?? 0, 0);
  const mounts = container.Mounts.filter((mount) => mount.Type !== 'tmpfs');
  assert.equal(mounts.length, 2);
  for (const [destination, source, writable] of [['/inputs', inputs, false], ['/outputs', context.output, true]]) {
    const mount = mounts.find((item) => item.Destination === destination);
    assert(mount && mount.Type === 'bind');
    assert.equal(mount.Source, source);
    assert.equal(mount.RW, writable);
  }
  assert.deepEqual(Object.keys(host.Tmpfs ?? {}), ['/tmp']);
  const allowed = ['PATH', 'HOME', 'LANG', 'PYTHON', 'GPG_KEY', 'F9_'];
  for (const entry of container.Config.Env) {
    const key = entry.split('=', 1)[0];
    assert(allowed.some((prefix) => prefix.endsWith('_') ? key.startsWith(prefix) : key === prefix || key.startsWith(prefix + '_')), 'Unexpected container environment');
  }
}

async function host() {
  const context = await ownerContext();
  await mkdir(context.output, { mode: 0o700 });
  const receipt = { ...blank(), source: 'R4 exact SSE peer; boundary-only admission', owner: context.owner, image };
  let problem;
  try {
    assert.equal(process.version, nodeVersion, 'Wrong host Node version');
    assert.equal(process.arch, 'x64');
    assert(process.getuid() !== 0, 'Non-root runner UID is required');
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) assert(!process.env[key], `Unsupported host setting: ${key}`);
    const work = await mkdtemp(join(context.temporary, 'f9-untimed-inputs-'));
    await gitFree(work);
    const peer = fileURLToPath(new URL('./fixtures/f9-r4-warm-server.mjs', import.meta.url));
    assert.equal(await hash(peer), peerHash, 'Changed sealed peer');
    for (const [from, to, mode] of [[self, 'admission.mjs', 0o444], [peer, 'peer.mjs', 0o444], [await realpath(process.execPath), 'node', 0o555]]) {
      await copyFile(from, join(work, to));
      await chmod(join(work, to), mode);
    }
    const hostNamespaces = await ns();
    const nodeHash = await hash(join(work, 'node'));
    const driverHash = await hash(join(work, 'admission.mjs'));
    const uid = `${process.getuid()}:${process.getgid()}`;
    const args = ['create', '--cidfile', join(context.output, 'container.id'), '--label', `${label}=${context.owner}`, '--network', 'none', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', uid, '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777', '--mount', `type=bind,src=${work},dst=/inputs,readonly`, '--mount', `type=bind,src=${context.output},dst=/outputs`, '--env', 'HOME=/tmp', '--env', 'F9_INSIDE=1', '--env', `F9_HOST_NS=${JSON.stringify(hostNamespaces)}`, '--env', `F9_NODE_HASH=${nodeHash}`, '--env', `F9_DRIVER_HASH=${driverHash}`, image, '/inputs/node', '/inputs/admission.mjs', '--inside'];
    const cid = (await docker(args)).stdout.trim();
    assert.equal((await readFile(join(context.output, 'container.id'), 'utf8')).trim(), cid);
    const container = await inspect(cid);
    validateContainer(container, context, work, uid);
    receipt.hostNamespaces = hostNamespaces;
    receipt.node = { version: process.version, sha256: nodeHash };
    receipt.peerSha256 = peerHash;
    await docker(['start', '--attach', cid], 45000);
    const ended = await inspect(cid);
    assert.equal(ended.State.Running, false);
    assert.equal(ended.State.ExitCode, 0);
    const inside = JSON.parse(await readFile(join(context.output, 'inside.json'), 'utf8'));
    assert.equal(inside.admitted, true);
    assert.equal(inside.SDKExecuted, false);
    assert.equal(inside.timingStarted, false);
    assert.equal(inside.samples, 0);
    receipt.inside = inside;
  } catch (error) { problem = error; receipt.failure = safeFailure(error); }
  finally {
    try { await cleanup(context); receipt.cleanupConfirmed = true; }
    catch (error) { receipt.cleanupConfirmed = false; receipt.cleanupFailure = safeFailure(error); problem ??= error; }
    receipt.admitted = !problem;
    await save(join(context.output, 'receipt.json'), receipt);
  }
  if (problem) throw problem;
}

async function denied(protocol, family) {
  const address = family === 4 ? '192.0.2.1' : '2001:db8::1';
  return new Promise((resolve, reject) => {
    const socket = protocol === 'tcp' ? new net.Socket() : dgram.createSocket(family === 4 ? 'udp4' : 'udp6');
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (protocol === 'tcp') socket.destroy();
        else socket.close();
      } catch {
        // Cleanup has been preserving the original probe result.
      }
      if (!error || !['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM', ...(family === 6 ? ['EAFNOSUPPORT'] : [])].includes(error.code)) reject(new Error('Denied-egress control did not prove local rejection'));
      else resolve({ protocol, family, code: error.code });
    };
    const timer = setTimeout(() => finish(new Error('Ambiguous network timeout')), 2500);
    socket.once('error', finish);
    if (protocol === 'tcp') socket.connect({ host: address, port: 9 }, () => finish());
    else socket.send(Buffer.from([0]), 53, address, (error) => finish(error));
  });
}

async function request(port, path, body) {
  return new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', agent: false, headers: body ? { 'content-type': 'application/json' } : {} }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; if (text.length > 1024 * 1024) call.destroy(new Error('Peer output overflow')); });
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode === 200) resolve(text);
        else reject(new Error('Peer HTTP failure'));
      });
    });
    call.setTimeout(3000, () => call.destroy(new Error('Peer request timeout')));
    call.once('error', reject);
    call.end(body ? JSON.stringify(body) : undefined);
  });
}

async function inside() {
  const receipt = { ...blank() };
  let child;
  let exited;
  const deadline = setTimeout(() => process.exit(1), 30000);
  try {
    assert.equal(process.env.F9_INSIDE, '1');
    assert.equal(process.version, nodeVersion, 'Incompatible container Node');
    assert(process.getuid() !== 0);
    await gitFree('/inputs');
    await gitFree('/outputs');
    assert.equal(await hash('/inputs/node'), process.env.F9_NODE_HASH);
    assert.equal(await hash('/inputs/admission.mjs'), process.env.F9_DRIVER_HASH);
    assert.equal(await hash('/inputs/peer.mjs'), peerHash);
    const hostNamespaces = JSON.parse(process.env.F9_HOST_NS);
    const current = await ns();
    for (const name of namespaces) assert.notEqual(current[name], hostNamespaces[name], 'Shared host namespace');
    const status = await readFile('/proc/self/status', 'utf8');
    assert(/^CapEff:\s+0+$/m.test(status));
    assert(/^NoNewPrivs:\s+1$/m.test(status));
    const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n');
    assert.equal(routes.length, 1, 'Non-loopback IPv4 route');
    const interfaces = (await readFile('/proc/net/dev', 'utf8')).trim().split('\n').slice(2).map((line) => line.trim().split(':')[0]);
    assert.deepEqual(interfaces, ['lo']);
    for (const line of (await readFile('/proc/net/ipv6_route', 'utf8')).trim().split('\n').filter(Boolean)) assert.equal(line.trim().split(/\s+/).at(-1), 'lo', 'Non-loopback IPv6 route');
    for (const key of Object.keys(process.env)) assert(!/^(OPENAI_|CODEX_|OTEL_|GITHUB_|ACTIONS_|NODE_|LD_)/.test(key), 'Ambient credential or loader setting');
    receipt.namespaces = current;
    receipt.deniedEgress = [];
    for (const family of [4, 6]) for (const protocol of ['tcp', 'udp']) receipt.deniedEgress.push(await denied(protocol, family));
    child = fork('/inputs/peer.mjs', [], { execPath: '/inputs/node', env: { PATH: '/inputs', HOME: '/tmp' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error('Peer process failed'))); });
    // Retain the rejection immediately while awaiting the peer readiness message.
    exited.catch(() => {});
    const port = await Promise.race([new Promise((resolve) => child.once('message', (message) => resolve(message.port))), exited.then(() => { throw new Error('Peer exited before readiness'); })]);
    assert(Number.isInteger(port) && port > 0 && port < 65536);
    assert.deepEqual(await ns(child.pid), current);
    assert.match(await readFile(`/proc/${child.pid}/status`, 'utf8'), new RegExp(`^PPid:\\s+${process.pid}$`, 'm'));
    await request(port, '/reset?oneShot=true');
    const streamed = await request(port, '/v1/responses', { model: 'gpt-5', input: [{ role: 'user', content: 'BENCH:admission:0:0 hello' }], stream: true, tools: [] });
    const frames = streamed.split('\n\n').flatMap((frame) => frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))));
    const completed = frames.filter((frame) => frame.type === 'response.completed');
    assert.equal(completed.length, 1);
    assert(JSON.stringify(completed[0]).includes('ANSWER:admission:0'));
    const stats = JSON.parse(await request(port, '/stats'));
    assert.equal(stats.requests, 1);
    assert.equal(stats.errors, 0);
    child.send('close');
    await exited;
    receipt.peer = { sha256: peerHash, requests: 1, errors: 0, joinedExit: true };
    receipt.admitted = true;
  } catch (error) { receipt.failure = safeFailure(error); process.exitCode = 1; }
  finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (exited) await exited.catch(() => {});
    await save('/outputs/inside.json', receipt);
    clearTimeout(deadline);
  }
}

try {
  assert(process.argv.length <= 3);
  if (process.argv[2] === '--inside') await inside();
  else if (process.argv[2] === '--cleanup') await cleanup(await ownerContext());
  else { assert.equal(process.argv[2], undefined); await host(); }
} catch (error) {
  console.error(JSON.stringify({ ...blank(), failure: safeFailure(error) }));
  process.exitCode = 1;
}
