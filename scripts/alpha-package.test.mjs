import process from 'node:process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  alphaManifest,
  packageNames,
  starterManifest,
  verifyNativeReceipt,
  verifyStarterLock,
} from './alpha-package.mjs';

import {
  nativeInputs,
  nativeHosts,
  nativeHelpers,
} from '../packages/agents/scripts/native-receipt.mjs';

const version = '0.22.0-alpha.1';
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('stages a matched alpha dependency graph without changing source manifests', () => {
  const source = {
    name: '@openai/agents',
    version: '0.21.0',
    scripts: { prepack: 'never-run' },
    devDependencies: { test: '*' },
    dependencies: { '@openai/agents-core': 'workspace:*', openai: '^7.2.0' },
  };
  const before = clone(source);
  const result = alphaManifest(source, version, 'linux-x64');
  assert.deepEqual(source, before);
  assert.equal(result.version, version);
  assert.equal(result.private, true);
  assert.equal(result.dependencies['@openai/agents-core'], version);
  assert.equal(result.dependencies.openai, '^7.2.0');
  assert.equal(result.scripts, undefined);
  assert.equal(result.devDependencies, undefined);
  assert.deepEqual(result.os, ['linux']);
  assert.deepEqual(result.cpu, ['x64']);
  assert.deepEqual(result.libc, ['glibc']);
  assert.equal(result.engines.node, '>=24');
  assert.throws(() => alphaManifest(source, '0.22.0', 'linux-x64'));
  assert.throws(
    () =>
      alphaManifest(
        {
          ...source,
          dependencies: { '@openai/agents-extensions': 'workspace:*' },
        },
        version,
        'linux-x64',
      ),
    /Unbundled/,
  );
});

test('starter lock rejects registry fallback and duplicate SDK installations', () => {
  const packages = Object.fromEntries(
    packageNames.map((name) => [
      `@openai/${name}`,
      {
        archive: `openai-${name}-${version}-linux-x64.tgz`,
        version,
        integrity: `sha512-${name}`,
      },
    ]),
  );
  const manifest = starterManifest(packages, '^4.3.5');
  const lock = {
    packages: Object.fromEntries(
      Object.entries(packages).map(([name, record]) => [
        `node_modules/${name}`,
        {
          version,
          resolved: `file:vendor/agents/${record.archive}`,
          integrity: record.integrity,
        },
      ]),
    ),
  };
  verifyStarterLock(lock, packages);
  assert.equal(
    manifest.overrides['@openai/agents-core'],
    '$@openai/agents-core',
  );
  assert.equal(manifest.dependencies.zod, '^4.3.5');
  assert.equal(Object.keys(manifest.dependencies).length, 5);
  const proxy = clone(lock);
  proxy.packages['node_modules/third-party'] = {
    version: '1.0.0',
    resolved: 'https://producer.example.test/package.tgz',
    integrity: 'sha512-example',
  };
  assert.throws(
    () => verifyStarterLock(proxy, packages),
    /omit registry-resolved/,
  );
  const registry = clone(lock);
  registry.packages['node_modules/@openai/agents-core'].resolved =
    'https://registry.npmjs.org/archive.tgz';
  assert.throws(() => verifyStarterLock(registry, packages));
  const duplicate = clone(lock);
  duplicate.packages['node_modules/other/node_modules/@openai/agents-core'] =
    lock.packages['node_modules/@openai/agents-core'];
  assert.throws(() => verifyStarterLock(duplicate, packages), /Duplicate/);
});

test('release receipt rejects debug builds, changed binaries, and fixture payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-alpha-receipt-'));
  const packageRoot = join(root, 'packages/agents');
  const revision = 'a'.repeat(40);
  const platform = `${process.platform}-${process.arch}`;
  const files = {
    'native/CODEX_REVISION': revision,
    'native/codex.node': 'addon',
    ...Object.fromEntries(nativeHelpers(platform).map((name) => [name, name])),
  };
  const series = JSON.stringify({ patches: [], result_tree: 'c'.repeat(40) });
  const nativeFiles = {
    'native/index.js': 'native loader',
    'native/Cargo.toml': `rmcp = { git = "https://github.com/modelcontextprotocol/rust-sdk", rev = "${revision}", version = "=3.3.0" }\n`,
    'native/Cargo.lock': 'lock',
    'native/build.rs': 'build',
    'native/tests/fixtures/exec_server.rs': 'fixture',
    'native/rust/lib.rs': 'source',
    'native/patches/series.json': series,
    'native/rmcp-patches/series.json': series,
    'scripts/native.mjs': 'producer',
  };
  for (const [name, bytes] of Object.entries(nativeFiles)) {
    await mkdir(dirname(join(packageRoot, name)), { recursive: true });
    await writeFile(join(packageRoot, name), bytes);
  }
  const identity = {
    revision,
    result_tree: 'c'.repeat(40),
    manifest_sha256: digest(series),
    patches: [],
  };
  const receipt = {
    format: 'reviewed-native-v1',
    release: true,
    host: nativeHosts[platform],
    sources: { codex: identity, 'rust-sdk': identity },
    inputs: { 'native/CODEX_REVISION': digest(revision) },
    products: Object.fromEntries(
      Object.entries(files)
        .filter(([name]) => name !== 'native/CODEX_REVISION')
        .map(([name, bytes]) => [name, `sha256:${digest(bytes)}`]),
    ),
  };
  const receiptPath = join(packageRoot, 'native/build-receipt.json');
  try {
    for (const [name, bytes] of Object.entries(files)) {
      await mkdir(dirname(join(packageRoot, name)), { recursive: true });
      await writeFile(join(packageRoot, name), bytes);
      await chmod(join(packageRoot, name), 0o755);
    }
    receipt.inputs = nativeInputs(packageRoot);
    await writeFile(receiptPath, JSON.stringify(receipt));
    assert.equal(
      (await verifyNativeReceipt(root, platform)).revision,
      revision,
    );
    await writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, release: false }),
    );
    await assert.rejects(
      verifyNativeReceipt(root, platform),
      /release native build/,
    );
    await writeFile(
      receiptPath,
      JSON.stringify({
        ...receipt,
        products: {
          ...receipt.products,
          'native/test-bin/fixture': 'sha256:bad',
        },
      }),
    );
    await assert.rejects(
      verifyNativeReceipt(root, platform),
      /product inventory/,
    );
    await writeFile(receiptPath, JSON.stringify(receipt));
    await writeFile(join(packageRoot, 'native/codex.node'), 'tampered');
    await assert.rejects(verifyNativeReceipt(root, platform), /changed/);
    assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).release, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
