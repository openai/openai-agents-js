import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const matchingProfile = (summary, buildId) => {
  assert.match(summary, /Maximum function count:\s*[1-9]\d*/);
  const ids = summary
    .split('Binary IDs:')
    .slice(1)
    .flatMap((section) => section.trim().split(/\s+/));
  assert.deepEqual(
    ids,
    [buildId],
    'Profile must contain only the exact Generate image',
  );
};

// The ordinary builder owns source preparation, V8 verification, Cargo arguments,
// product staging and receipts. PGO supplies only the addon target specialization.
export async function packagePgo({ packageRoot, prepare, build }) {
  assert.equal(
    process.platform + '-' + process.arch,
    'linux-x64',
    'PGO currently supports Linux x64 only',
  );
  for (const key of [
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'RUSTC_WRAPPER',
    'RUSTC_WORKSPACE_WRAPPER',
  ])
    assert(!process.env[key], `Unset ${key} for the controlled PGO recipe`);
  const root = join(packageRoot, 'native');
  const repository = resolve(packageRoot, '../..');
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
    return result.stdout;
  };
  const compiler = run('rustc', ['-vV']);
  assert.match(
    compiler,
    /^release: 1\.95\.0$/m,
    'Use the release producer Rust toolchain',
  );
  const host = compiler.match(/^host: (.+)$/m)?.[1];
  assert.equal(host, 'x86_64-unknown-linux-gnu');
  const sysroot = run('rustc', ['--print', 'sysroot']).trim();
  const profdata = join(sysroot, 'lib/rustlib', host, 'bin/llvm-profdata');
  assert(
    existsSync(profdata),
    'Install llvm-tools-preview for the same Rust toolchain',
  );
  const llvmVersion = run(profdata, ['--version']);
  assert.equal(
    llvmVersion.match(/LLVM version (\d+)/i)?.[1],
    compiler.match(/^LLVM version: (\d+)/m)?.[1],
    'Compiler/profile LLVM version mismatch',
  );
  const sourceRevision = run('git', ['rev-parse', 'HEAD']).trim();
  const sourceTree = run('git', ['rev-parse', 'HEAD^{tree}']).trim();
  assert.equal(
    run('git', ['status', '--porcelain', '--untracked-files=no']).trim(),
    '',
    'PGO release training requires clean tracked source',
  );
  const receiptPath = join(root, 'build-receipt.json');
  const ordinaryBytes = readFileSync(receiptPath);
  const ordinary = JSON.parse(ordinaryBytes);
  assert.equal(ordinary.format, 'reviewed-native-v1');
  assert.equal(ordinary.release, true);
  assert.equal(ordinary.host, host);
  assert(
    !ordinary.optimization,
    'Start from an ordinary same-source native bundle',
  );
  for (const [name, expected] of Object.entries(ordinary.products)) {
    assert.match(expected, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      'sha256:' + sha(join(packageRoot, name)),
      expected,
      `Ordinary product changed: ${name}`,
    );
  }
  prepare();
  const cache = join(root, '.cache');
  mkdirSync(cache, { recursive: true });
  const output = mkdtempSync(join(cache, 'pgo-'));
  chmodSync(output, 0o700);
  const addon = join(root, 'codex.node');
  const originalAddon = join(output, 'ordinary.node');
  copyFileSync(addon, originalAddon);
  const addonMode = statSync(addon).mode & 0o777;
  writeFileSync(join(output, 'ordinary-receipt.json'), ordinaryBytes);
  const sourceInputsHash = digest({
    sources: ordinary.sources,
    inputs: ordinary.inputs,
  });
  const corpus = json(join(here, 'pgo/corpus.json'));
  assert.equal(corpus.cases.length, 7);
  assert(corpus.cases.every((item) => item.mergeWeight === 1));
  const entry = join(repository, 'packages/agents/dist/index.mjs');
  assert(existsSync(entry), 'Run the normal SDK build before PGO packaging');
  const trainingSourceHashes = Object.fromEntries(
    ['train.mjs', 'fixture.mjs', 'corpus.json'].map((name) => [
      name,
      sha(join(here, 'pgo', name)),
    ]),
  );
  const evidence = {
    format: 'native-pgo-training-v1',
    sourceRevision,
    sourceTree,
    compiler,
    llvmVersion,
    llvmProfdataSha256: sha(profdata),
    sourceInputsHash,
    ordinaryReceiptSha256: createHash('sha256')
      .update(ordinaryBytes)
      .digest('hex'),
    trainingSourceHashes,
    publicEntrySha256: sha(entry),
    families: [],
    status: 'running',
  };
  const stage = (name) => {
    const path = join(output, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  const buildRaw = stage('build-raw');
  let complete = false;
  try {
    const generate = await build({
      addonOnly: true,
      companions: ordinary,
      environmentOverrides: {
        CARGO_TARGET_DIR: join(output, 'generate-target'),
        CARGO_BUILD_TARGET: host,
        CARGO_ENCODED_RUSTFLAGS: [`-Cprofile-generate=${buildRaw}`].join(
          '\x1f',
        ),
        LLVM_PROFILE_FILE: join(buildRaw, '%m-%p.profraw'),
      },
      optimization: { mode: 'generate', scope: 'addon', sourceInputsHash },
    });
    assert.equal(
      digest({ sources: generate.sources, inputs: generate.inputs }),
      sourceInputsHash,
    );
    const generateAddonSha256 = sha(addon);
    const buildId = run('readelf', ['-n', addon]).match(
      /Build ID: ([a-f\d]+)/i,
    )?.[1];
    assert(buildId, 'Generate addon needs an attributable ELF build ID');
    Object.assign(evidence, { generateAddonSha256, generateBuildId: buildId });
    const profiles = [];
    for (const spec of corpus.cases) {
      const family = stage(spec.family),
        raw = join(family, 'raw'),
        tmp = join(family, 'tmp');
      mkdirSync(raw, { mode: 0o700 });
      mkdirSync(tmp, { mode: 0o700 });
      const summary = join(family, 'result.json');
      const env = Object.fromEntries(
        ['PATH', 'HOME', 'USER', 'LOGNAME']
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      );
      Object.assign(env, {
        LANG: 'C.UTF-8',
        TZ: 'UTC',
        TMPDIR: tmp,
        OPENAI_AGENTS_DISABLE_TRACING: '1',
        LLVM_PROFILE_FILE: join(raw, '%m-%p.profraw'),
      });
      const child = spawn(
        process.execPath,
        [
          join(here, 'pgo/train.mjs'),
          spec.family,
          entry,
          generateAddonSha256,
          summary,
        ],
        {
          cwd: repository,
          env,
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit'],
        },
      );
      const closed = once(child, 'close');
      let forced = false,
        killTimer,
        remainingGroup = false,
        primaryError;
      const cleanupErrors = [];
      const signalGroup = (signal) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') cleanupErrors.push(error);
        }
      };
      const terminate = () => {
        if (forced) return;
        forced = true;
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), 5000);
      };
      const timeout = setTimeout(terminate, 120000);
      process.once('SIGINT', terminate);
      process.once('SIGTERM', terminate);
      try {
        const [code, signal] = await closed;
        assert.equal(code, 0, `Training ${spec.family} failed`);
        assert.equal(signal, null);
        assert.equal(forced, false);
      } catch (error) {
        primaryError = error;
      } finally {
        clearTimeout(timeout);
        process.off('SIGINT', terminate);
        process.off('SIGTERM', terminate);
        // A failed child must not leave its owned fixture behind.
        if (child.pid) {
          try {
            process.kill(-child.pid, 0);
            remainingGroup = true;
          } catch (error) {
            if (error.code !== 'ESRCH') {
              cleanupErrors.push(error);
              remainingGroup = true;
            }
          }
          if (remainingGroup) signalGroup('SIGKILL');
        }
        clearTimeout(killTimer);
      }
      if (primaryError && !cleanupErrors.length) throw primaryError;
      if (cleanupErrors.length)
        throw new AggregateError(
          primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
          'Training process or owned cleanup failed',
          { cause: primaryError },
        );
      assert.equal(
        remainingGroup,
        false,
        'Training child left an owned process behind',
      );
      const result = json(summary);
      assert.equal(result.pid, child.pid);
      assert.equal(result.status, 'passed');
      assert.equal(result.fixtureJoined, true);
      assert.equal(result.addonSha256, generateAddonSha256);
      assert.equal(result.providers, spec.providers);
      assert.equal(result.agents, spec.providers);
      assert.equal(result.providerCloses, spec.providers);
      assert.equal(result.explicitRuntimes, spec.explicitRuntimes ?? 0);
      assert.equal(result.runtimeCloses, spec.explicitRuntimes ?? 0);
      assert.equal(result.successes, spec.successes);
      assert.equal(result.rejections, spec.controlledRejections);
      assert.equal(result.fixtureStats.requests, spec.requests);
      assert.deepEqual(result.fixtureStats.failures, []);
      assert.equal(
        readdirSync(tmp).length,
        0,
        'Training temporary files remain',
      );
      const raws = readdirSync(raw);
      assert.equal(
        raws.length,
        1,
        'Only one actual addon profile per family is admitted',
      );
      assert(
        raws[0].endsWith(`-${child.pid}.profraw`),
        'Wrong profile writer PID',
      );
      const path = join(raw, raws[0]);
      const counters = run(profdata, ['show', '--binary-ids', path]);
      matchingProfile(counters, buildId);
      profiles.push(path);
      evidence.families.push({
        family: spec.family,
        rawSha256: sha(path),
        result,
        counters,
      });
      save(join(output, 'training.json'), evidence);
    }
    assert.equal(sha(addon), generateAddonSha256);
    assert.equal(run('rustc', ['-vV']), compiler);
    const merged = join(output, 'merged.profdata');
    run(profdata, [
      'merge',
      '--instr',
      '--failure-mode=any',
      '--num-threads=1',
      '--output=' + merged,
      ...profiles.map((path) => '--weighted-input=1,' + path),
    ]);
    const mergedSummary = run(profdata, ['show', '--binary-ids', merged]);
    matchingProfile(mergedSummary, buildId);
    chmodSync(merged, 0o444);
    const profileSha256 = sha(merged);
    const optimization = {
      mode: 'use',
      scope: 'addon',
      compiler,
      llvmVersion,
      llvmProfdataSha256: sha(profdata),
      sourceInputsHash,
      sourceRevision,
      trainingSourceTree: sourceTree,
      trainingSourceHashes,
      publicEntrySha256: evidence.publicEntrySha256,
      generateAddonSha256,
      generateBuildId: buildId,
      profileSha256,
      trainingFamilies: corpus.cases.map((item) => item.family),
      familyWeights: corpus.cases.map(() => 1),
      trainingCalls: corpus.cases.reduce(
        (count, item) => count + item.calls,
        0,
      ),
      trainingRequests: corpus.cases.reduce(
        (count, item) => count + item.requests,
        0,
      ),
      ordinaryCompanionReceiptSha256: evidence.ordinaryReceiptSha256,
      products: Object.fromEntries(
        Object.keys(ordinary.products).map((name) => [
          name,
          name === 'native/codex.node' ? 'profile-use' : 'ordinary-release',
        ]),
      ),
    };
    const use = await build({
      addonOnly: true,
      companions: ordinary,
      environmentOverrides: {
        CARGO_TARGET_DIR: join(output, 'use-target'),
        CARGO_BUILD_TARGET: host,
        CARGO_ENCODED_RUSTFLAGS: [
          `-Cprofile-use=${merged}`,
          '-Cllvm-args=-pgo-warn-missing-function',
        ].join('\x1f'),
        LLVM_PROFILE_FILE: undefined,
      },
      optimization,
    });
    assert.equal(
      digest({ sources: use.sources, inputs: use.inputs }),
      sourceInputsHash,
    );
    assert.equal(sha(merged), profileSha256);
    assert.equal(run('rustc', ['-vV']), compiler);
    assert.equal(run('git', ['rev-parse', 'HEAD^{tree}']).trim(), sourceTree);
    assert.equal(
      run('git', ['status', '--porcelain', '--untracked-files=no']).trim(),
      '',
    );
    for (const [name, expected] of Object.entries(ordinary.products)) {
      if (name !== 'native/codex.node') {
        assert.match(expected, /^sha256:[a-f0-9]{64}$/);
        assert.equal('sha256:' + sha(join(packageRoot, name)), expected);
      }
    }
    evidence.status = 'passed-generate-training-merge-use';
    evidence.optimization = optimization;
    complete = true;
  } catch (error) {
    evidence.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    if (!complete) {
      const staged = join(root, `codex.restore.${process.pid}.node`);
      copyFileSync(originalAddon, staged);
      chmodSync(staged, addonMode);
      renameSync(staged, addon);
      writeFileSync(receiptPath, ordinaryBytes);
      evidence.status = 'failed-ordinary-addon-restored';
    }
    // CI diagnostics stay in the ignored build cache, never the npm payload.
    save(join(output, 'training.json'), evidence);
  }
}
