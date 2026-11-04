import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execaSync } from 'execa';

import {
  nativeHosts as hosts,
  verifyNativeReceipt,
} from '../packages/agents/scripts/native-receipt.mjs';
export { verifyNativeReceipt };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const packageNames = [
  'agents',
  'agents-core',
  'agents-openai',
  'agents-realtime',
];
const publicNames = packageNames.map((name) => `@openai/${name}`);
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const run = (command, args, cwd, cache) =>
  execaSync(command, args, {
    cwd,
    env: { npm_config_cache: cache },
    maxBuffer: 32 * 1024 * 1024,
  }).stdout;

export function alphaManifest(original, version, platform) {
  assert.match(version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
  assert.ok(hosts[platform], 'Unsupported alpha artifact platform');
  assert.ok(publicNames.includes(original.name), 'Unsupported SDK package');
  const [os, cpu] = platform.split('-');
  const manifest = {
    ...original,
    version,
    private: true,
    os: [os],
    cpu: [cpu],
    engines: { ...original.engines, node: '>=24' },
  };
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.libc;
  if (os === 'linux') manifest.libc = ['glibc'];
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    if (!original[section]) continue;
    manifest[section] = Object.fromEntries(
      Object.entries(original[section]).map(([name, value]) => {
        if (name.startsWith('@openai/agents')) {
          assert.ok(
            publicNames.includes(name),
            `Unbundled SDK dependency: ${name}`,
          );
          return [name, version];
        }
        assert.ok(
          !value.startsWith('workspace:'),
          `Unresolved workspace dependency: ${name}`,
        );
        return [name, value];
      }),
    );
  }
  return manifest;
}

export function starterManifest(packages, zod) {
  return {
    private: true,
    type: 'module',
    engines: { node: '>=24' },
    dependencies: {
      ...Object.fromEntries(
        Object.entries(packages).map(([name, record]) => [
          name,
          `file:vendor/agents/${record.archive}`,
        ]),
      ),
      zod,
    },
    overrides: Object.fromEntries(
      publicNames
        .filter((name) => name !== '@openai/agents')
        .map((name) => [name, `$${name}`]),
    ),
  };
}

export function verifyStarterLock(lock, packages) {
  const found = new Set();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    assert.ok(
      !entry.resolved || entry.resolved.startsWith('file:'),
      'Starter lock must omit registry-resolved URLs',
    );
    const name = path.slice(
      path.lastIndexOf('node_modules/') + 'node_modules/'.length,
    );
    if (!Object.hasOwn(packages, name)) continue;
    const record = packages[name];
    assert.equal(
      path,
      `node_modules/${name}`,
      `Duplicate SDK package: ${name}`,
    );
    assert.equal(entry.resolved, `file:vendor/agents/${record.archive}`);
    assert.equal(entry.version, record.version);
    assert.equal(entry.integrity, record.integrity);
    assert.ok(!entry.link, `SDK package is linked: ${name}`);
    found.add(name);
  }
  assert.deepEqual(
    [...found].sort(),
    [...publicNames].sort(),
    'Incomplete SDK lock',
  );
}

async function stagePackage(
  repository,
  name,
  version,
  platform,
  staging,
  cache,
  helpers,
) {
  const source = join(repository, 'packages', name);
  const destination = join(staging, name, 'package');
  await mkdir(destination, { recursive: true });
  const [pack] = JSON.parse(
    run(
      'npm',
      ['pack', '--dry-run', '--ignore-scripts', '--json'],
      source,
      cache,
    ),
  );
  for (const { path } of pack.files) {
    assert.ok(
      !isAbsolute(path) && !path.split(/[\\/]/).includes('..'),
      'Unsafe package file path',
    );
    const file = join(source, path);
    assert.ok(
      (await lstat(file)).isFile(),
      `Package input must be a regular file: ${path}`,
    );
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await copyFile(file, join(destination, path));
  }
  await copyFile(join(repository, 'LICENSE'), join(destination, 'LICENSE'));
  const manifest = alphaManifest(
    await json(join(source, 'package.json')),
    version,
    platform,
  );
  if (name === 'agents') {
    manifest.publishConfig = {
      ...manifest.publishConfig,
      executableFiles: helpers.map((file) => `./${file}`),
    };
    for (const helper of helpers) await chmod(join(destination, helper), 0o755);
  }
  await writeJson(join(destination, 'package.json'), manifest);
  // Metadata is staged with the archive versions; tracked source stays stable.
  const metadata = {
    name: manifest.name,
    version,
    versions: {
      [manifest.name]: version,
      ...Object.fromEntries(
        Object.entries(manifest.dependencies ?? {}).filter(
          ([name]) => name.startsWith('@openai/') || name === 'openai',
        ),
      ),
    },
  };
  await writeFile(
    join(destination, 'dist/metadata.mjs'),
    `export const METADATA = ${JSON.stringify(metadata)};\nexport default METADATA;\n`,
  );
  await writeFile(
    join(destination, 'dist/metadata.js'),
    `Object.defineProperty(exports, '__esModule', {value:true});\nconst METADATA = ${JSON.stringify(metadata)};\nexports.METADATA = METADATA;\nexports.default = METADATA;\n`,
  );
  for (const extension of ['js', 'mjs'])
    await rm(join(destination, `dist/metadata.${extension}.map`), {
      force: true,
    });
  return destination;
}

function assertCleanSource(repository, output) {
  const args = ['status', '--porcelain', '--untracked-files=all', '--', '.'];
  const generated = relative(repository, output);
  // Generated deliverables may live inside the checkout, but never count as
  // source inputs or excuse unrelated uncommitted files.
  if (generated && !generated.startsWith('..') && !isAbsolute(generated)) {
    args.push(`:(exclude)${generated.replaceAll('\\', '/')}/`);
  }
  assert.equal(
    run('git', args, repository).trim(),
    '',
    'Commit the exact candidate source before producing alpha artifacts',
  );
}

export async function produceAlpha({ repository = root, version, output }) {
  assert.ok(
    Number(process.versions.node.split('.')[0]) >= 24,
    'Use Node.js 24 or later',
  );
  assert.match(version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
  assert.ok(isAbsolute(output), '--output must be absolute');
  assertCleanSource(repository, output);
  const platform = `${process.platform}-${process.arch}`;
  const { revision, helpers } = await verifyNativeReceipt(repository, platform);
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], repository).trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  await mkdir(output, { recursive: true });
  assert.deepEqual(await readdir(output), [], 'Output directory must be empty');
  const staging = await mkdtemp(join(tmpdir(), 'agents-alpha-package-'));
  const cache = join(staging, 'npm-cache');
  const artifacts = join(staging, 'artifacts');
  await mkdir(artifacts);
  try {
    const packages = {};
    for (const name of packageNames) {
      const directory = await stagePackage(
        repository,
        name,
        version,
        platform,
        staging,
        cache,
        helpers,
      );
      const archive = `openai-${name}-${version}-${platform}.tgz`;
      run(
        'tar',
        ['-czf', archive, '-C', dirname(directory), 'package'],
        artifacts,
      );
      const bytes = await readFile(join(artifacts, archive));
      packages[`@openai/${name}`] = {
        archive,
        version,
        sha256: hash(bytes),
        integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
      };
    }
    const starter = join(staging, 'agents-starter');
    const vendor = join(starter, 'vendor/agents');
    await mkdir(vendor, { recursive: true });
    for (const record of Object.values(packages))
      await copyFile(
        join(artifacts, record.archive),
        join(vendor, record.archive),
      );
    const { dependencies } = await json(
      join(repository, 'packages/agents/package.json'),
    );
    await writeJson(
      join(starter, 'package.json'),
      starterManifest(packages, dependencies.zod),
    );
    await copyFile(
      join(repository, 'scripts/alpha-starter/hello.mjs'),
      join(starter, 'hello.mjs'),
    );
    await writeFile(
      join(starter, 'README.md'),
      `# Agents SDK alpha ${version}\n\nUse Node.js 24 and its bundled npm on ${platform}. Linux requires glibc 2.39 or newer and OpenSSL 3.\n\nRun \`npm ci --ignore-scripts\`, set OPENAI_API_KEY, then run \`node hello.mjs\`. The example sends a live API request. npm downloads third-party dependencies. Keep package.json, package-lock.json and all four vendor archives together.\n`,
    );
    run(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--omit-lockfile-registry-resolved',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      starter,
      cache,
    );
    verifyStarterLock(await json(join(starter, 'package-lock.json')), packages);
    // Only the curated starter directory is shipped, excluding the npm cache.
    const archive = `agents-starter-${version}-${platform}.tar.gz`;
    run('tar', ['-czf', archive, '-C', staging, 'agents-starter'], artifacts);
    const receipt = {
      sourceCommit,
      version,
      platform,
      codexRevision: revision,
      starter: {
        archive,
        sha256: hash(await readFile(join(artifacts, archive))),
      },
      packages,
    };
    await verifyNativeReceipt(repository, platform);
    assertCleanSource(repository, output);
    assert.equal(
      run('git', ['rev-parse', 'HEAD'], repository).trim(),
      sourceCommit,
      'Source commit changed during packaging',
    );
    await writeJson(join(artifacts, `build-${platform}.json`), receipt);
    await writeFile(
      join(artifacts, `SHA256SUMS-${platform}`),
      [...Object.values(packages), receipt.starter]
        .map(({ archive, sha256 }) => `${sha256}  ${archive}\n`)
        .join(''),
    );
    assert.deepEqual(
      await readdir(output),
      [],
      'Output changed during packaging',
    );
    // Copy the build record last so incomplete copies never look qualified.
    const buildRecord = `build-${platform}.json`;
    for (const file of [
      ...(await readdir(artifacts)).filter((file) => file !== buildRecord),
      buildRecord,
    ]) {
      await copyFile(join(artifacts, file), join(output, file));
    }
    console.log(`Created ${archive} and four matched SDK archives.`);
    return receipt;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values, positionals } = parseArgs({
    options: { version: { type: 'string' }, output: { type: 'string' } },
    allowPositionals: true,
  });
  assert.equal(positionals.length, 0, 'Unexpected positional arguments');
  assert.ok(values.version && values.output, 'Expected --version and --output');
  await produceAlpha(values);
}
