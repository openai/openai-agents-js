'use strict';

// Temporary, exact-ref diagnostic; never log argv, environment, or child output.
if (
  process.env.OPENAI_AGENTS_TRACE_NATIVE_GIT === '1' &&
  process.env.GITHUB_REPOSITORY === 'openai/openai-agents-js' &&
  process.env.GITHUB_EVENT_NAME === 'push' &&
  process.env.GITHUB_REF === 'refs/heads/ci/hillclimb/js-warm-macos-git-trace-29' &&
  process.env.RUNNER_OS === 'macOS'
) {
  const childProcess = require('node:child_process');
  const { syncBuiltinESMExports } = require('node:module');
  const { performance } = require('node:perf_hooks');
  const { writeSync } = require('node:fs');
  const original = childProcess.spawnSync;
  const families = new Set([
    'cat-file', 'ls-tree', 'rev-parse', 'init', 'read-tree',
    'apply', 'write-tree', 'archive', 'fetch',
  ]);
  let sequence = 0;
  childProcess.spawnSync = function (command, args, options) {
    const argv = Array.isArray(args) ? args : [];
    const lowering = command === process.execPath && argv.some(
      (arg) => typeof arg === 'string' && /(?:^|[/\\])wasm2js$/.test(arg),
    );
    if (command !== 'git' && !lowering) return Reflect.apply(original, this, arguments);
    const settings = Array.isArray(args) ? options ?? {} : args ?? {};
    const input = settings.input;
    const inputBytes = typeof input === 'string'
      ? Buffer.byteLength(input)
      : input?.byteLength ?? 0;
    const record = {
      trace: lowering ? 'native-binaryen' : 'native-git', pid: process.pid, sequence: ++sequence,
      family: lowering ? 'wasm2js' : argv.find((arg) => families.has(arg)) ?? 'other', inputBytes,
    };
    const start = performance.now();
    writeSync(2, JSON.stringify({ ...record, phase: 'start' }) + '\n');
    let result;
    try {
      result = Reflect.apply(original, this, arguments);
      return result;
    } finally {
      writeSync(2, JSON.stringify({
        ...record, phase: 'end', elapsedMs: performance.now() - start,
        status: result?.status ?? null, signal: result?.signal ?? null,
      }) + '\n');
    }
  };
  syncBuiltinESMExports();
}
