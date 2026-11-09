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
import { dirname, join, resolve } from 'node:path';
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
const snapshot = () => ({
  script: sha256(readFileSync(fileURLToPath(import.meta.url))),
  sourceIdentity,
  inputs: Object.fromEntries(
    inputFiles.map((name) => [name, sha256(readFileSync(join(crate, name)))]),
  ),
});
const before = snapshot();
const target = resolve(native, '.cache/portable-target');
const environment = { ...process.env, CARGO_TARGET_DIR: target };
delete environment.OPENAI_API_KEY;
function run(program, args) {
  const result = spawnSync(program, args, {
    cwd: native,
    env: environment,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} failed (${result.status}).`);
  return result.stdout.toString();
}
const toolchain = run('rustc', ['-vV']);
run('cargo', [
  'build',
  '--manifest-path',
  join(crate, 'Cargo.toml'),
  '--target',
  'wasm32-unknown-unknown',
  '--release',
  '--locked',
]);
const built = join(
  target,
  'wasm32-unknown-unknown/release/codex_realtime_control.wasm',
);
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
};
for (const directory of products) {
  const staged = join(directory, `codex-realtime-control.${process.pid}.wasm`);
  copyFileSync(built, staged);
  if (sha256(readFileSync(staged)) !== artifact)
    throw new Error('Portable artifact copy changed.');
  renameSync(staged, join(directory, 'codex-realtime-control.wasm'));
  writeFileSync(
    join(directory, 'portable-build-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
console.log(
  `Built reviewed portable Realtime control (${bytes.length} bytes, sha256 ${artifact}).`,
);
