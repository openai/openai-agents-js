import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  prepareSources,
  verifyVendoredHyper,
} from '../packages/agents-codex/scripts/native-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codex = join(root, 'packages/agents-codex');
const native = join(codex, 'native');
const { values } = parseArgs({
  options: { source: { type: 'string' }, 'rmcp-source': { type: 'string' } },
});
const products = [native, join(root, 'packages/agents/native')];
for (const directory of products) {
  mkdirSync(directory, { recursive: true });
  rmSync(join(directory, 'portable-build-receipt.json'), { force: true });
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = readFileSync(join(native, 'CODEX_REVISION'), 'utf8').trim();
const cargo = readFileSync(join(native, 'Cargo.toml'), 'utf8');
const rmcp = cargo.match(/^rmcp = \{ git = "([^"]+)", rev = "([a-f0-9]{40})"/m);
if (
  !/^[a-f0-9]{40}$/.test(revision) ||
  !rmcp ||
  rmcp[1] !== 'https://github.com/modelcontextprotocol/rust-sdk'
)
  throw new Error('Invalid pinned native source inputs.');
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
verifyVendoredHyper(native);
const sourceIdentity = prepareSources(native, sources, true);
const crate = join(
  native,
  '.upstream/reviewed-codex/codex-rs/realtime-control',
);
const inputFiles = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'src/wasm.rs'];
const textCrate = join(dirname(crate), 'turn-control');
const textInputFiles = [...inputFiles, 'src/portable.rs'];

const snapshot = () => ({
  script: sha256(readFileSync(fileURLToPath(import.meta.url))),
  sourceIdentity,
  inputs: Object.fromEntries(
    inputFiles.map((name) => [name, sha256(readFileSync(join(crate, name)))]),
  ),
  textInputs: Object.fromEntries(
    textInputFiles.map((name) => [
      name,
      sha256(readFileSync(join(textCrate, name))),
    ]),
  ),
});
const require = createRequire(import.meta.url);
const binaryen = dirname(require.resolve('binaryen'));
const binaryenManifest = JSON.parse(
  readFileSync(join(binaryen, 'package.json'), 'utf8'),
);
if (binaryenManifest.version !== '108.0.0')
  throw new Error('Portable Hermes builds require pinned binaryen@108.0.0.');
const wasm2js = join(binaryen, 'bin/wasm2js');
const wasm2jsHash = sha256(readFileSync(wasm2js));
const before = snapshot();
const target = resolve(native, '.cache/portable-target');
const environment = { ...process.env, CARGO_TARGET_DIR: target };
delete environment.OPENAI_API_KEY;
function run(program, args, cwd = native) {
  const result = spawnSync(program, args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} failed (${result.status}).`);
  return result.stdout.toString();
}
run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
const toolchain = run('rustc', ['-vV']);
function buildControl(cratePath, binary) {
  run('cargo', [
    'build',
    '--manifest-path',
    join(cratePath, 'Cargo.toml'),
    '--target',
    'wasm32-unknown-unknown',
    '--release',
    '--locked',
  ]);
  const built = join(target, 'wasm32-unknown-unknown/release', binary);
  const bytes = readFileSync(built);
  const module = new globalThis.WebAssembly.Module(bytes);
  if (globalThis.WebAssembly.Module.imports(module).length)
    throw new Error('Portable control imports host capabilities.');
  const exports = new Map(
    globalThis.WebAssembly.Module.exports(module).map(({ name, kind }) => [
      name,
      kind,
    ]),
  );
  for (const [name, kind] of [
    ['memory', 'memory'],
    ['input_buffer', 'function'],
    ['apply', 'function'],
    ['output_pointer', 'function'],
    ['output_length', 'function'],
  ])
    if (exports.get(name) !== kind)
      throw new Error(`Portable control omitted ABI export ${name}.`);
  return { built, bytes };
}
const { built, bytes } = buildControl(crate, 'codex_realtime_control.wasm');
const text = buildControl(textCrate, 'codex_turn_control.wasm');
// Binaryen's virtual filesystem does not consistently resolve Windows drive paths.
// Keep its input and output local to an explicit working directory.
function lowerControl(wasmPath) {
  const loweringDirectory = dirname(wasmPath);
  const loweredPath = basename(wasmPath, '.wasm') + '.lowered.js';
  run(
    process.execPath,
    [
      wasm2js,
      basename(wasmPath),
      '-o',
      loweredPath,
      '--emscripten',
      '--enable-multivalue',
      '--enable-bulk-memory',
      '--enable-nontrapping-float-to-int',
      '--strip-debug',
      '-O',
    ],
    loweringDirectory,
  );
  const lowered = readFileSync(join(loweringDirectory, loweredPath), 'utf8');
  if (
    lowered.includes('WebAssembly') ||
    !lowered.startsWith('function instantiate(')
  )
    throw new Error(
      'Hermes control is not an isolated host-independent factory.',
    );
  return lowered;
}
const lowered = lowerControl(built);
const loweredText = lowerControl(text.built);
if (sha256(readFileSync(wasm2js)) !== wasm2jsHash)
  throw new Error('Binaryen changed during the portable build.');
const hermesProducts = {};
for (const [index, directory] of products.entries()) {
  const owner = index === 0;
  const banner =
    '// Generated from reviewed Rust control with Binaryen 108 (Apache-2.0).\n';
  const body = owner ? `${banner}${lowered}\n` : '';
  const generated = {
    'codex-realtime-control.mjs': owner
      ? `${body}import { PortableVoiceControlBinding } from '../dist/voice/portable-binding.mjs';\nexport function createHermesVoiceControl() { return new PortableVoiceControlBinding(instantiate({})); }\n`
      : `export { createHermesVoiceControl } from '@openai/agents-codex/voice/control.hermes';\n`,
    'codex-realtime-control.cjs': owner
      ? `${body}const { PortableVoiceControlBinding } = require('../dist/voice/portable-binding.js');\nexports.createHermesVoiceControl = function () { return new PortableVoiceControlBinding(instantiate({})); };\n`
      : `module.exports = require('@openai/agents-codex/voice/control.hermes');\n`,
    'codex-turn-control.mjs': owner
      ? `${banner}${loweredText}\nimport { HermesTextControl } from '../dist/runtime/turn-control-binding.mjs';\nexport function createHermesTextControl() { return new HermesTextControl(() => instantiate({})); }\n`
      : `export { createHermesTextControl } from '@openai/agents-codex/worker/control.hermes';\n`,
    'codex-turn-control.cjs': owner
      ? `${banner}${loweredText}\nconst { HermesTextControl } = require('../dist/runtime/turn-control-binding.js');\nexports.createHermesTextControl = function () { return new HermesTextControl(() => instantiate({})); };\n`
      : `module.exports = require('@openai/agents-codex/worker/control.hermes');\n`,
  };
  const hashes = {};
  for (const [name, content] of Object.entries(generated)) {
    writeFileSync(join(directory, name), content);
    hashes[name] = sha256(readFileSync(join(directory, name)));
  }
  hermesProducts[owner ? '@openai/agents-codex' : '@openai/agents'] = hashes;
}
const afterSources = prepareSources(native, sources, false);
if (
  JSON.stringify(afterSources) !== JSON.stringify(sourceIdentity) ||
  JSON.stringify(snapshot()) !== JSON.stringify(before)
)
  throw new Error('Portable control source changed during build.');
const artifact = sha256(bytes);
const receipt = {
  format: 'reviewed-portable-realtime-v1',
  ...before,
  toolchain,
  target: 'wasm32-unknown-unknown',
  artifact: { path: 'codex-realtime-control.wasm', sha256: artifact },
  text: { path: 'codex-turn-control.wasm', sha256: sha256(text.bytes) },

  hermes: {
    binaryen: binaryenManifest.version,
    wasm2jsSha256: wasm2jsHash,
    artifacts: hermesProducts,
  },
};
for (const directory of products) {
  for (const [source, product] of [
    [built, receipt.artifact],
    [text.built, receipt.text],
  ]) {
    const staged = join(directory, `${product.path}.${process.pid}`);
    copyFileSync(source, staged);
    if (sha256(readFileSync(staged)) !== product.sha256)
      throw new Error('Portable artifact copy changed.');
    renameSync(staged, join(directory, product.path));
  }
  writeFileSync(
    join(directory, 'portable-build-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
console.log(
  `Built reviewed portable Realtime control (${bytes.length} bytes, sha256 ${artifact}).`,
);
