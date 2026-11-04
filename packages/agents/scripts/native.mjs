import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { parseArgs } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tls from 'node:tls';
import { prepareSources } from './native-source.mjs';
import { nativeInputs, nativeSourceSpecs } from './native-receipt.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(packageRoot, 'native');
const upstream = join(root, '.upstream');
const archive = join(upstream, 'reviewed-codex');
const { values, positionals } = parseArgs({
  options: {
    source: { type: 'string' },
    'rmcp-source': { type: 'string' },
    release: { type: 'boolean', default: false },
    'test-fixture': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
const [command] = positionals;
if (
  positionals.length !== 1 ||
  !['prepare', 'audit', 'build', 'package'].includes(command) ||
  ((values.release || values['test-fixture']) && command !== 'build')
) {
  throw new Error(
    'Usage: node scripts/native.mjs prepare|audit|build|package [--source <codex-git-repository>] [--rmcp-source <rust-sdk-git-repository>] [--release] [--test-fixture]',
  );
}
if (command === 'build' || command === 'package')
  rmSync(join(root, 'build-receipt.json'), { force: true });
const revision = readFileSync(join(root, 'CODEX_REVISION'), 'utf8').trim();
const v8Release = JSON.parse(
  readFileSync(new URL('./v8-release.json', import.meta.url), 'utf8'),
);
if (!/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error(
    'native/CODEX_REVISION must contain a complete Git commit ID',
  );
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed (${result.status})`);
  }
  return result.stdout;
}

const sources = nativeSourceSpecs(packageRoot, {
  source: values.source,
  rmcpSource: values['rmcp-source'],
});
function audit(prepare = false) {
  return prepareSources(root, sources, prepare);
}

function equalSnapshot(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} changed during native build`);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function verifiedV8(filename, override) {
  const artifact = v8Release.assets.find(({ name }) => name === filename);
  if (!artifact)
    throw new Error(`No verified Codex V8 artifact for ${filename}`);
  const destination = override
    ? resolve(root, override)
    : join(root, '.cache', 'v8', filename);
  if (existsSync(destination)) {
    if ((await sha256(destination)) === artifact.digest) return destination;
    if (override) throw new Error(`V8 SHA-256 mismatch: ${destination}`);
  } else if (override) {
    throw new Error(`V8 override does not exist: ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.part`;
  try {
    const url = `https://github.com/openai/codex/releases/download/rusty-v8-v${v8Release.version}/${filename}`;
    // Older supported Node versions retain their normal TLS trust configuration.
    if (
      typeof tls.getCACertificates === 'function' &&
      typeof tls.setDefaultCACertificates === 'function'
    ) {
      tls.setDefaultCACertificates([
        ...tls.getCACertificates('default'),
        ...tls.getCACertificates('system'),
      ]);
    }
    const response = await globalThis.fetch(url);
    if (!response.ok)
      throw new Error(`V8 download failed (${response.status}): ${filename}`);
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: 'wx' }),
    );
    if ((await sha256(temporary)) !== artifact.digest) {
      throw new Error(`V8 SHA-256 mismatch: ${filename}`);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

async function build() {
  const receiptPath = join(root, 'build-receipt.json');
  rmSync(receiptPath, { force: true });
  const sourceIdentity = audit();
  const inputs = nativeInputs(packageRoot);
  const release = values.release || command === 'package';
  const environment = {
    ...process.env,
    // Keep Cargo's checkouts out of long Windows package source paths.
    ...(process.platform === 'win32'
      ? {}
      : {
          CARGO_HOME: resolve(root, process.env.CARGO_HOME || '.cache/cargo'),
        }),
    CARGO_TARGET_DIR: resolve(root, process.env.CARGO_TARGET_DIR || 'target'),
  };
  const host = run('rustc', ['-vV'], { env: environment })
    .toString('utf8')
    .match(/^host: (.+)$/m)?.[1];
  if (
    !host ||
    (environment.CARGO_BUILD_TARGET && environment.CARGO_BUILD_TARGET !== host)
  ) {
    throw new Error(
      'Verified V8 assets currently support native host builds only',
    );
  }
  if (['1', 'true', 'yes'].includes(environment.V8_FORCE_DEBUG)) {
    throw new Error(
      'Verified Codex V8 assets require V8_FORCE_DEBUG to be disabled',
    );
  }
  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  const version = lock.match(
    /\[\[package\]\]\nname = "v8"\nversion = "([^"]+)"/,
  )?.[1];
  if (version !== v8Release.version) {
    throw new Error(
      `Cargo.lock V8 ${version} has no matching verified release data`,
    );
  }
  const windows = host.endsWith('-windows-msvc');
  const archiveName = windows
    ? `rusty_v8_ptrcomp_sandbox_release_${host}.lib.gz`
    : `librusty_v8_ptrcomp_sandbox_release_${host}.a.gz`;
  const bindingName = `src_binding_ptrcomp_sandbox_release_${host}.rs`;
  environment.RUSTY_V8_ARCHIVE = await verifiedV8(
    archiveName,
    environment.RUSTY_V8_ARCHIVE,
  );
  environment.RUSTY_V8_SRC_BINDING_PATH = await verifiedV8(
    bindingName,
    environment.RUSTY_V8_SRC_BINDING_PATH,
  );
  // Restored Cargo fingerprints can otherwise accept SDK files with old timestamps.
  const clean = [
    'clean',
    '--locked',
    '--package',
    'codex-agents-node',
    ...(release ? ['--release'] : []),
  ];
  run('cargo', clean, { env: environment, stdio: 'inherit' });
  if (windows && !environment.CARGO_BUILD_TARGET) {
    run('cargo', [...clean, '--target', host], {
      env: environment,
      stdio: 'inherit',
    });
  }
  const helpers = [
    '--bin',
    'codex-sdk-runtime',
    '--bin',
    'codex-code-mode-host',
    ...(values['test-fixture'] ? ['--example', 'exec-server-fixture'] : []),
  ];
  const profile = release ? ['--release'] : [];
  const timings =
    environment.OPENAI_AGENTS_NATIVE_TIMINGS === '1' ? ['--timings'] : [];
  run(
    'cargo',
    [
      'build',
      '--locked',
      '--lib',
      ...(windows ? [] : helpers),
      ...profile,
      ...timings,
    ],
    { env: environment, stdio: 'inherit' },
  );
  if (windows) {
    // V8 executables need Codex's MSVC settings. Keep them off the Node addon:
    // its cdylib must retain the DLL-compatible CRT. Dependency Cargo configs
    // are not inherited, so select the unchanged upstream config explicitly.
    run(
      'cargo',
      [
        'build',
        '--locked',
        ...helpers,
        '--config',
        join(archive, 'codex-rs', '.cargo', 'config.toml'),
        '--target',
        host,
        ...profile,
        ...timings,
      ],
      { env: environment, stdio: 'inherit' },
    );
  }
  equalSnapshot(audit(), sourceIdentity, 'Reviewed source');
  equalSnapshot(nativeInputs(packageRoot), inputs, 'Native inputs');
  const output = join(
    environment.CARGO_TARGET_DIR,
    ...(environment.CARGO_BUILD_TARGET ? [host] : []),
    release ? 'release' : 'debug',
  );
  const helperOutput = windows
    ? join(environment.CARGO_TARGET_DIR, host, release ? 'release' : 'debug')
    : output;
  const library = windows
    ? 'agents_codex.dll'
    : host.includes('-apple-')
      ? 'libagents_codex.dylib'
      : 'libagents_codex.so';
  const suffix = windows ? '.exe' : '';
  // Existing Node processes may still have the old addon mapped into memory.
  const stagedAddon = join(root, `codex.${process.pid}.node`);
  copyFileSync(join(output, library), stagedAddon);
  renameSync(stagedAddon, join(root, 'codex.node'));
  const bin = join(packageRoot, 'bin');
  mkdirSync(bin, { recursive: true });
  const runtime = join(helperOutput, `codex-sdk-runtime${suffix}`);
  const payload = [[join(root, 'codex.node'), join(output, library)]];
  const runtimeNames = [
    'codex-sdk-runtime',
    ...(host.includes('-linux-') ? ['codex-linux-sandbox'] : []),
    ...(!windows ? ['codex-execve-wrapper'] : []),
  ];
  // Remove obsolete aliases from builds made before helper selection was
  // restricted by host. Only remove paths that this build script has owned.
  for (const name of [
    'apply_patch',
    'applypatch',
    'codex-linux-sandbox',
    'codex-execve-wrapper',
  ]) {
    if (!runtimeNames.includes(name)) {
      rmSync(join(bin, `${name}${suffix}`), { force: true });
    }
  }
  for (const name of runtimeNames) {
    const helper = join(bin, `${name}${suffix}`);
    copyFileSync(runtime, helper);
    payload.push([helper, runtime]);
  }
  const codeMode = join(helperOutput, `codex-code-mode-host${suffix}`);
  const codeModeDestination = join(bin, `codex-code-mode-host${suffix}`);
  copyFileSync(codeMode, codeModeDestination);
  payload.push([codeModeDestination, codeMode]);
  if (values['test-fixture']) {
    const testBin = join(root, 'test-bin');
    mkdirSync(testBin, { recursive: true });
    const fixture = join(
      helperOutput,
      'examples',
      `exec-server-fixture${suffix}`,
    );
    const destination = join(testBin, `exec-server-fixture${suffix}`);
    copyFileSync(fixture, destination);
    payload.push([destination, fixture]);
  }
  console.log(`Built native/codex.node and matching helpers in ${bin}`);
  let receipt;
  {
    for (const [destination, built] of payload) {
      const metadata = lstatSync(destination);
      if (
        !metadata.isFile() ||
        metadata.size === 0 ||
        (!windows &&
          destination !== join(root, 'codex.node') &&
          !(metadata.mode & 0o111)) ||
        (await sha256(destination)) !== (await sha256(built))
      ) {
        throw new Error(`Invalid packaged native artifact: ${destination}`);
      }
    }
    equalSnapshot(audit(), sourceIdentity, 'Reviewed source');
    equalSnapshot(nativeInputs(packageRoot), inputs, 'Native inputs');
    const products = Object.fromEntries(
      await Promise.all(
        payload.map(async ([destination]) => [
          destination.slice(packageRoot.length + 1).replaceAll('\\', '/'),
          await sha256(destination),
        ]),
      ),
    );
    receipt = {
      format: 'reviewed-native-v1',
      sources: sourceIdentity,
      inputs,
      host,
      release,
      products,
    };
  }
  if (command === 'package') {
    // Load in a child so the producer never retains a mapped addon across builds.
    run(
      process.execPath,
      [
        '-e',
        `
        const binding = require(process.argv[1]);
        if (binding.CODEX_REVISION !== process.argv[2] ||
            typeof binding.create_engine !== 'function' ||
            typeof binding.create_checkpoint_engine !== 'function') {
          throw new Error('Packaged addon is not the expected pinned Codex runtime');
        }
        const fs = require('node:fs');
        for (const helper of Object.values(binding._packaged_runtime())) {
          fs.accessSync(helper, fs.constants.F_OK | fs.constants.X_OK);
        }
      `,
        join(root, 'index.js'),
        revision,
      ],
      { timeout: 30_000 },
    );
    console.log(
      `Verified native addon and ${payload.length - 1} matching helpers for packaging`,
    );
  }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
}

if (command === 'prepare') audit(true);
else if (command === 'audit') audit();
else if (command === 'package') {
  // Never leave a previous receipt qualifying an interrupted packaging attempt.
  rmSync(join(root, 'build-receipt.json'), { force: true });
  audit(true);
  await build();
} else await build();
