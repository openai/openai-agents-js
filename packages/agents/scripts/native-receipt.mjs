import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readSeries } from './native-source.mjs';

export const nativeHosts = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function nativeSourceSpecs(packageRoot, { source, rmcpSource } = {}) {
  const root = join(packageRoot, 'native');
  const revision = readFileSync(join(root, 'CODEX_REVISION'), 'utf8').trim();
  assert.match(revision, /^[a-f0-9]{40}$/);
  const rmcp = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(
    /^rmcp = \{ git = "([^"]+)", rev = "([a-f0-9]{40})", version = "=3\.3\.0"/m,
  );
  assert.ok(
    rmcp && rmcp[1] === 'https://github.com/modelcontextprotocol/rust-sdk',
    'Cargo.toml must retain the pinned RMCP Git source and exact version',
  );
  return [
    {
      name: 'codex',
      url: 'https://github.com/openai/codex.git',
      revision,
      source,
      patches: 'patches',
    },
    {
      name: 'rust-sdk',
      url: rmcp[1],
      revision: rmcp[2],
      source: rmcpSource,
      patches: 'rmcp-patches',
    },
  ];
}

export function nativeInputs(packageRoot) {
  const repository = resolve(packageRoot, '../..');
  for (let parent = join(packageRoot, 'native'); ; parent = dirname(parent)) {
    for (const name of ['config', 'config.toml']) {
      try {
        lstatSync(join(parent, '.cargo', name));
        assert.fail(
          'Repository Cargo configuration is unsupported in native production',
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (parent === repository) break;
  }
  for (const directory of [
    '',
    'native',
    'native/tests',
    'native/tests/fixtures',
  ]) {
    assert.ok(
      lstatSync(join(packageRoot, directory)).isDirectory(),
      `Native input directory must be regular: ${directory || '.'}`,
    );
  }
  const files = new Set([
    'native/CODEX_REVISION',
    'native/index.js',
    'native/Cargo.toml',
    'native/Cargo.lock',
    'native/build.rs',
    'native/tests/fixtures/exec_server.rs',
  ]);
  for (const directory of [
    'native/rust',
    'native/patches',
    'native/rmcp-patches',
    'scripts',
  ]) {
    assert.ok(
      lstatSync(join(packageRoot, directory)).isDirectory(),
      `Native input directory must be regular: ${directory}`,
    );
    for (const name of readdirSync(join(packageRoot, directory), {
      recursive: true,
    })) {
      const relative = `${directory}/${name}`;
      const stat = lstatSync(join(packageRoot, relative));
      assert.ok(
        stat.isDirectory() || stat.isFile(),
        `Native input aliases and special files are unsupported: ${relative}`,
      );
      if (stat.isFile()) files.add(relative);
    }
  }
  return Object.fromEntries(
    [...files].sort().map((name) => {
      const file = join(packageRoot, name);
      assert.ok(
        lstatSync(file).isFile(),
        `Native input must be a regular file: ${name}`,
      );
      return [name, hash(readFileSync(file))];
    }),
  );
}

export function nativeInputIdentity(packageRoot) {
  return hash(JSON.stringify(nativeInputs(packageRoot)));
}

function sourceIdentities(packageRoot) {
  return Object.fromEntries(
    nativeSourceSpecs(packageRoot).map((spec) => {
      const series = readSeries(join(packageRoot, 'native', spec.patches));
      return [
        spec.name,
        {
          revision: spec.revision,
          result_tree: series.result_tree,
          manifest_sha256: series.manifest_sha256,
          patches: series.patches.map(({ path, sha256 }) => ({ path, sha256 })),
        },
      ];
    }),
  );
}

export function nativeHelpers(platform) {
  assert.ok(nativeHosts[platform], 'Unsupported alpha artifact platform');
  const windows = platform === 'win32-x64';
  return [
    'codex-sdk-runtime',
    'codex-code-mode-host',
    ...(platform === 'linux-x64' ? ['codex-linux-sandbox'] : []),
    ...(!windows ? ['codex-execve-wrapper'] : []),
  ].map((name) => `bin/${name}${windows ? '.exe' : ''}`);
}

export async function verifyNativeReceipt(
  repository,
  platform,
  { artifactRoot, normalizeModes = false } = {},
) {
  const packageRoot = join(repository, 'packages/agents');
  const productsRoot = artifactRoot ?? packageRoot;
  const receiptPath = join(productsRoot, 'native/build-receipt.json');
  assert.ok(
    lstatSync(receiptPath).isFile(),
    'Native receipt must be a regular file',
  );
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const helpers = nativeHelpers(platform);
  assert.equal(receipt.format, 'reviewed-native-v1');
  assert.equal(
    receipt.release,
    true,
    'Alpha artifacts require a release native build',
  );
  assert.equal(receipt.host, nativeHosts[platform]);
  assert.deepEqual(
    receipt.inputs,
    nativeInputs(packageRoot),
    'Native input inventory changed',
  );
  assert.deepEqual(
    receipt.sources,
    sourceIdentities(packageRoot),
    'Native source identities changed',
  );
  const products = ['native/codex.node', ...helpers];
  assert.deepEqual(
    Object.keys(receipt.products).sort(),
    [...products].sort(),
    'Unexpected native product inventory',
  );
  if (artifactRoot) {
    const files = readdirSync(artifactRoot, { recursive: true })
      .filter((name) => {
        const stat = lstatSync(join(artifactRoot, name));
        assert.ok(
          !stat.isSymbolicLink(),
          `Native artifact contains a symlink: ${name}`,
        );
        assert.ok(
          stat.isDirectory() || stat.isFile(),
          `Invalid native artifact entry: ${name}`,
        );
        return stat.isFile();
      })
      .map((name) => name.replaceAll('\\', '/'));
    assert.deepEqual(
      files.sort(),
      [
        ...products,
        'native/build-receipt.json',
        ...(existsSync(join(artifactRoot, 'native/snapshot-provenance.json'))
          ? ['native/snapshot-provenance.json']
          : []),
      ].sort(),
      'Unexpected native artifact files',
    );
  }
  for (const name of products) {
    const file = join(productsRoot, name);
    const stat = lstatSync(file);
    assert.ok(
      stat.isFile() && stat.size > 0,
      `Invalid native product file: ${name}`,
    );
    assert.equal(
      `sha256:${hash(readFileSync(file))}`,
      receipt.products[name],
      `Native product changed: ${name}`,
    );
    if (platform !== 'win32-x64' && helpers.includes(name) && !normalizeModes) {
      assert.ok(stat.mode & 0o111, `Helper is not executable: ${name}`);
    }
  }
  // GitHub artifacts preserve bytes, but normalize executable files to mode 0644.
  if (normalizeModes && platform !== 'win32-x64') {
    for (const name of helpers) chmodSync(join(productsRoot, name), 0o755);
  }
  return { revision: receipt.sources.codex.revision, helpers };
}

export async function copyNativeArtifact(
  repository,
  platform,
  destination,
  source,
) {
  const packageRoot = join(repository, 'packages/agents');
  const restoring = source !== undefined;
  const sourceRoot = source ?? packageRoot;
  const { helpers } = await verifyNativeReceipt(
    repository,
    platform,
    restoring ? { artifactRoot: sourceRoot, normalizeModes: true } : {},
  );
  if (!restoring)
    assert.ok(
      !existsSync(destination) || readdirSync(destination).length === 0,
      'Native staging directory must be empty',
    );
  for (const name of [
    'native/codex.node',
    ...helpers,
    'native/build-receipt.json',
  ]) {
    const file = join(destination, name);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(sourceRoot, name), file);
    if (platform !== 'win32-x64' && helpers.includes(name))
      chmodSync(file, 0o755);
  }
  await verifyNativeReceipt(
    repository,
    platform,
    restoring ? {} : { artifactRoot: destination },
  );
}
