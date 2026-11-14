import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import { setTimeout } from 'node:timers/promises';
import * as tls from 'node:tls';
import {
  prepareSources,
  sha256Bytes,
  verifyVendoredHyper,
} from './native-source.mjs';

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

const cargoManifest = readFileSync(join(root, 'Cargo.toml'), 'utf8');
const rmcp = cargoManifest.match(
  /^rmcp = \{ git = "([^"]+)", rev = "([a-f0-9]{40})", version = "=3\.3\.0"/m,
);
if (!rmcp || rmcp[1] !== 'https://github.com/modelcontextprotocol/rust-sdk') {
  throw new Error(
    'Cargo.toml must retain the pinned RMCP Git source and exact version',
  );
}
const sources = [
  {
    name: 'codex',
    url: 'https://github.com/openai/codex.git',
    revision,
    source: values.source,
    patches: 'patches',
  },
  {
    name: 'rust-sdk',
    url: rmcp[1],
    revision: rmcp[2],
    source: values['rmcp-source'],
    patches: 'rmcp-patches',
  },
];
function audit(prepare = false) {
  verifyVendoredHyper(root);
  return prepareSources(root, sources, prepare);
}

// One input snapshot and product inventory serve build validation and its receipt.
function buildInputs() {
  const files = new Set([
    'native/CODEX_REVISION',
    'native/Cargo.toml',
    'native/Cargo.lock',
    'native/build.rs',
    'native/tests/fixtures/exec_server.rs',
    'licenses/hyper/LICENSE',
  ]);
  for (const directory of [
    'native/rust',
    'native/patches',
    'native/rmcp-patches',
    'scripts',
  ]) {
    for (const name of readdirSync(join(packageRoot, directory), {
      recursive: true,
    })) {
      const relative = `${directory}/${name}`;
      if (lstatSync(join(packageRoot, relative)).isFile()) files.add(relative);
    }
  }
  return Object.fromEntries(
    [...files]
      .sort()
      .map((file) => [
        file,
        sha256Bytes(readFileSync(join(packageRoot, file))),
      ]),
  );
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

async function v8ReleaseAsset(artifact) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const tag = `rusty-v8-v${v8Release.version}`;
  const release = await globalThis.fetch(
    `https://api.github.com/repos/openai/codex/releases/tags/${tag}`,
    {
      headers,
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const apiError = async (response) => {
    const reset = response.headers.get('x-ratelimit-reset');
    await response.body?.cancel();
    throw new Error(
      `V8 download failed (${response.status}) via release API: ${artifact.name}${reset ? `; rate reset ${reset}` : ''}`,
    );
  };
  if (!release.ok) return apiError(release);
  const metadata = await release.json();
  const asset = metadata.assets?.find(
    ({ name, digest }) => name === artifact.name && digest === artifact.digest,
  );
  if (
    metadata.tag_name !== tag ||
    !Number.isSafeInteger(asset?.id) ||
    asset.id <= 0 ||
    asset.state !== 'uploaded'
  )
    throw new Error(`No pinned V8 release asset: ${artifact.name}`);
  const response = await globalThis.fetch(
    `https://api.github.com/repos/openai/codex/releases/assets/${asset.id}`,
    {
      headers: { ...headers, Accept: 'application/octet-stream' },
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 302) {
    const url = new URL(response.headers.get('location'));
    await response.body?.cancel();
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Invalid V8 release asset redirect');
    // The release download host must never receive the API credential.
    return globalThis.fetch(url, {
      signal: globalThis.AbortSignal.timeout(30_000),
    });
  }
  if (!response.ok) return apiError(response);
  return response;
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
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let failure;
      try {
        response = await globalThis.fetch(url);
      } catch (error) {
        if (
          !(error instanceof TypeError) ||
          error.cause?.code !== 'UND_ERR_CONNECT_TIMEOUT'
        )
          throw error;
        failure = 'hit a connection timeout (UND_ERR_CONNECT_TIMEOUT)';
      }
      if (!failure) {
        if (response.status !== 504) break;
        await response.body?.cancel();
        failure = 'returned HTTP 504';
      }
      if (attempt === 3) {
        response = await v8ReleaseAsset(artifact);
        break;
      }
      const delay = attempt * 1000;
      console.warn(
        `V8 download for ${filename} ${failure} on attempt ${attempt} of 3. Retrying in ${delay} ms.`,
      );
      await setTimeout(delay);
    }
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
  const inputs = buildInputs();
  const release = values.release || command === 'package';
  const environment = {
    ...process.env,
    // The optional release API credential belongs only to this downloader.
    GITHUB_TOKEN: undefined,
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
  // Keep the regression graph and its outputs separate from the Core build.
  run(
    'cargo',
    [
      'test',
      '--locked',
      '--target',
      host,
      '--manifest-path',
      join(root, 'rust/tests/hyper-readiness/Cargo.toml'),
      '--test',
      'readiness',
    ],
    {
      env: {
        ...environment,
        CARGO_TARGET_DIR: join(environment.CARGO_TARGET_DIR, 'hyper-readiness'),
      },
      stdio: 'inherit',
    },
  );
  equalSnapshot(audit(), sourceIdentity, 'Reviewed source');
  equalSnapshot(buildInputs(), inputs, 'Native inputs');
  // Restored Cargo fingerprints can otherwise accept SDK files with old timestamps.
  const clean = [
    'clean',
    '--locked',
    '--package',
    'codex-agents-node',
    '--package',
    'codex-agents-helpers',
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
      ...(windows ? ['--package', 'codex-agents-node'] : helpers),
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
        '--package',
        'codex-agents-helpers',
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
  equalSnapshot(buildInputs(), inputs, 'Native inputs');
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
    equalSnapshot(buildInputs(), inputs, 'Native inputs');
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
