import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const { fetch, AbortSignal } = globalThis;

const knownCases = [
  'cold-import',
  'cold-first',
  'warm-one-shot',
  'warm-session',
  'stream-session',
  'tool1',
  'tool8',
  'tool-chain8',
  'history100',
  'concurrent8',
];
const workloads = (process.env.BENCH_CASES ?? knownCases.join(',')).split(',');
const sides = (process.env.BENCH_SIDES ?? 'v0,v1').split(',');
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
const timeout = Number(process.env.BENCH_TIMEOUT_MS ?? 120000);
assert(
  Number(process.versions.node.split('.')[0]) >= 22,
  'Use Node22 or newer',
);
assert(
  workloads.length &&
    new Set(workloads).size === workloads.length &&
    workloads.every((x) => knownCases.includes(x)),
);
assert(
  sides.length &&
    new Set(sides).size === sides.length &&
    sides.every((x) => ['v0', 'v1'].includes(x)),
);
for (const value of [
  rounds,
  timeout,
  Number(process.env.BENCH_TURNS ?? 20),
  Number(process.env.BENCH_OUTPUT_BYTES ?? 256),
  Number(process.env.BENCH_STREAM_CHUNKS ?? 8),
])
  assert(Number.isSafeInteger(value) && value > 0);
assert(
  Number.isFinite(Number(process.env.BENCH_MODEL_DELAY_MS ?? 0)) &&
    Number(process.env.BENCH_MODEL_DELAY_MS ?? 0) >= 0,
);
assert(['off', 'on'].includes(process.env.BENCH_TRACE ?? 'off'));
assert(
  !process.execArgv.length &&
    !('NODE_OPTIONS' in process.env) &&
    !('NODE_V8_COVERAGE' in process.env) &&
    !('NODE_COMPILE_CACHE' in process.env) &&
    !('NODE_DISABLE_COMPILE_CACHE' in process.env),
  'Unset inherited Node instrumentation/compile-cache controls',
);
for (const key of Object.keys(process.env))
  assert(
    !key.startsWith('LD_') &&
      !key.startsWith('CPUPROFILE') &&
      !key.startsWith('SIGPROF_') &&
      !key.startsWith('NATIVE_PROFILE'),
    'Unset external instrumentation/loader overrides',
  );
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function input(side) {
  const prefix = side === 'v0' ? 'V0' : 'V1';
  assert(
    process.env[`${prefix}_ENTRY`] && process.env[`${prefix}_VERSION`],
    `Set ${prefix}_ENTRY and ${prefix}_VERSION`,
  );
  const entry = await realpath(resolve(process.env[`${prefix}_ENTRY`]));
  let directory = dirname(entry),
    metadata,
    packageBytes;
  for (;;) {
    try {
      packageBytes = await readFile(join(directory, 'package.json'));
      metadata = JSON.parse(packageBytes);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, 'Entry must belong to an SDK package');
    directory = parent;
  }
  assert.equal(
    metadata.name,
    '@openai/agents',
    'Use the public convenience-package entry',
  );
  assert.equal(
    metadata.version,
    process.env[`${prefix}_VERSION`],
    'Declared SDK version does not match package.json',
  );
  const require = createRequire(entry);
  const zodBytes = await readFile(require.resolve('zod/package.json'));
  return {
    entry,
    version: metadata.version,
    revision: process.env[`${prefix}_REVISION`] ?? null,
    entrySha256: hash(await readFile(entry)),
    packageJsonSha256: hash(packageBytes),
    zodVersion: JSON.parse(zodBytes).version,
    zodPackageJsonSha256: hash(zodBytes),
  };
}
const inputs = {};
for (const side of sides) inputs[side] = await input(side);
if (sides.length === 2)
  assert.equal(
    inputs.v0.zodVersion,
    inputs.v1.zodVersion,
    'Use the same Zod version for both tool adapters',
  );
const runtime = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
const sources = {};
for (const name of ['run.mjs', 'worker.mjs', 'server.mjs'])
  sources[name] = hash(await readFile(new URL(name, import.meta.url)));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !['OPENAI_API_KEY', 'CODEX_API_KEY'].includes(key),
  ),
);
for (const side of sides)
  env[side === 'v0' ? 'V0_ENTRY' : 'V1_ENTRY'] = inputs[side].entry;
let server, serverClosed, active, activeClosed, interrupted, failure;
function closed(child) {
  return new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
}
async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(child, completion, graceful = false) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return completion;
  if (graceful && child.connected) child.send('close', () => {});
  else child.kill('SIGTERM');
  try {
    return await bounded(completion, 3000, 'Child cleanup deadline');
  } catch {
    child.kill('SIGKILL');
    return await bounded(completion, 3000, 'Forced child join deadline');
  }
}
const interrupt = (signal) => {
  interrupted = new Error(`Interrupted by ${signal}`);
  active?.kill('SIGTERM');
  server?.kill('SIGTERM');
};
const onInt = () => interrupt('SIGINT'),
  onTerm = () => interrupt('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);
try {
  server = fork(fileURLToPath(new URL('./server.mjs', import.meta.url)), [], {
    env,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  serverClosed = closed(server);
  const port = await bounded(
    new Promise((resolvePort, reject) => {
      server.once('message', (message) => resolvePort(message.port));
      server.once('error', reject);
      server.once('exit', () =>
        reject(new Error('Fixture exited before readiness')),
      );
    }),
    5000,
    'Fixture readiness deadline',
  );
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const stats = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const workload of workloads)
    for (let round = 0; round < rounds; round++) {
      for (const side of round % 2 ? [...sides].reverse() : sides) {
        if (interrupted) throw interrupted;
        const reset = await fetch(
          `http://127.0.0.1:${port}/reset?oneShot=${['cold-first', 'warm-one-shot'].includes(workload)}&chain=${workload === 'tool-chain8'}&longInput=${workload === 'history100'}`,
          { signal: AbortSignal.timeout(5000) },
        );
        assert.equal(reset.status, 200);
        await reset.text();
        const before = await stats(),
          start = performance.now();
        const preload = process.env.BENCH_WORKER_IMPORT
          ? ['--import', process.env.BENCH_WORKER_IMPORT]
          : [];
        active = spawn(
          process.execPath,
          [
            ...preload,
            fileURLToPath(new URL('./worker.mjs', import.meta.url)),
            side,
            workload,
          ],
          {
            env: {
              ...env,
              BENCH_BASE_URL: baseUrl,
              BENCH_PARENT_START_EPOCH_MS: String(
                performance.timeOrigin + start,
              ),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        activeClosed = closed(active);
        let stdout = '',
          stderr = '';
        active.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        active.stderr.on('data', (chunk) => {
          stderr += chunk;
          process.stderr.write(chunk);
        });
        active.once('error', (error) => {
          stderr += String(error);
        });
        const status = await bounded(
          activeClosed,
          timeout,
          `Timed out ${side} ${workload}`,
        );
        const processWallMs = performance.now() - start;
        if (interrupted) throw interrupted;
        assert.deepEqual(
          status,
          { code: 0, signal: null },
          `${side} ${workload}: ${stderr}\n${stdout}`,
        );
        const result = JSON.parse(stdout.trim().split('\n').at(-1)),
          after = await stats();
        assert.equal(
          after.errors - before.errors,
          0,
          `Fixture errors: ${JSON.stringify(after.failures)}`,
        );
        assert.equal(
          after.requests - before.requests,
          result.expectedRequests ?? 0,
          'Request count mismatch',
        );
        const tools =
          workload === 'tool1'
            ? 1
            : ['tool8', 'tool-chain8'].includes(workload)
              ? 8
              : 0;
        assert.equal(
          result.toolCalls ?? 0,
          result.completed * tools,
          'Tool count mismatch',
        );
        assert.equal(result.errors, 0);
        assert.equal(result.side, side);
        assert.equal(result.workload, workload);
        const serverCpuMs =
          (after.cpu.user -
            before.cpu.user +
            after.cpu.system -
            before.cpu.system) /
          1000;
        console.log(
          JSON.stringify({
            ...result,
            round,
            processWallMs,
            serverCpuMs,
            modelConnections: after.modelConnections,
            diagnosticPreload: process.env.BENCH_WORKER_IMPORT ?? null,
            serverRequests: after.requests - before.requests,
            requestBytes: after.bytes - before.bytes,
            serverErrors: after.errors - before.errors,
            inputs,
            runtime,
            sources,
          }),
        );
        active = activeClosed = undefined;
      }
    }
  for (const side of sides)
    assert.deepEqual(
      await input(side),
      inputs[side],
      'SDK entry/package metadata changed during the run',
    );
  for (const [name, digest] of Object.entries(sources))
    assert.equal(
      hash(await readFile(new URL(name, import.meta.url))),
      digest,
      'Harness changed during the run',
    );
} catch (error) {
  failure = { error };
} finally {
  try {
    try {
      await stop(active, activeClosed);
    } finally {
      const status = await stop(server, serverClosed, true);
      if (status)
        assert.deepEqual(
          status,
          { code: 0, signal: null },
          'Fixture did not exit normally',
        );
    }
  } catch (cleanupError) {
    if (failure) console.error('Cleanup failure:', cleanupError);
    else failure = { error: cleanupError };
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
}
if (failure) throw failure.error;
