import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';

export const sdkNames = [
  '@openai/agents',
  '@openai/agents-codex',
  '@openai/agents-core',
  '@openai/agents-openai',
  '@openai/agents-realtime',
];

export async function hashes(file) {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return {
    sha256: sha256.digest('hex'),
    integrity: `sha512-${sha512.digest('base64')}`,
  };
}

export async function verifyArtifactDirectory(directory) {
  const platform = `${process.platform}-${process.arch}`;
  const receipt = JSON.parse(
    await readFile(join(directory, `build-${platform}.json`), 'utf8'),
  );
  assert.equal(receipt.platform, platform);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(receipt.codexRevision, /^[a-f0-9]{40}$/);
  assert.match(receipt.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
  assert.deepEqual(Object.keys(receipt.packages).sort(), [...sdkNames].sort());
  for (const [name, record] of [
    ['starter', receipt.starter],
    ...Object.entries(receipt.packages),
  ]) {
    assert.equal(record.archive, basename(record.archive));
    assert(!record.archive.includes('\\'), 'Archive must be a filename');
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    const actual = await hashes(join(directory, record.archive));
    assert.equal(actual.sha256, record.sha256, `${name} SHA256 mismatch`);
    if (name !== 'starter') {
      assert.equal(record.version, receipt.version, `${name} version mismatch`);
      assert.equal(
        actual.integrity,
        record.integrity,
        `${name} integrity mismatch`,
      );
    }
  }
  const checksums = (
    await readFile(join(directory, `SHA256SUMS-${platform}`), 'utf8')
  )
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([a-f0-9]{64})\s+(\S+)$/.exec(line);
      assert(match, 'Invalid release checksum entry');
      return `${match[1]}  ${match[2]}`;
    });
  const expectedChecksums = [
    receipt.starter,
    ...Object.values(receipt.packages),
  ].map((record) => `${record.sha256}  ${record.archive}`);
  assert.deepEqual(
    checksums.sort(),
    expectedChecksums.sort(),
    'Release checksum list mismatch',
  );
  return receipt;
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      timeout: 300_000,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolveRun()
        : reject(
            new Error(
              `${command} ${args.join(' ')} failed (${code ?? signal})`,
            ),
          ),
    );
  });
}

async function bundledNpmCli() {
  const bin = dirname(process.execPath);
  for (const candidate of [
    join(bin, 'node_modules/npm/bin/npm-cli.js'),
    resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
    resolve(bin, '../share/nodejs/npm/bin/npm-cli.js'),
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next Node distribution layout. */
    }
  }
  throw new Error(
    'Cannot find bundled npm CLI next to Node.js; use the official Node.js 24 distribution.',
  );
}

export async function verifyAlphaPackage(directory) {
  assert.equal(process.versions.node.split('.')[0], '24', 'Use Node.js 24');
  const platform = `${process.platform}-${process.arch}`;
  for (const profile of ['starter', 'app']) {
    await rm(join(directory, `installed-${profile}-${platform}.json`), {
      force: true,
    });
  }
  const receipt = await verifyArtifactDirectory(directory);
  const npmCli = await bundledNpmCli();
  const staging = await mkdtemp(join(tmpdir(), 'agents-alpha-consumer-'));
  const checkout = fileURLToPath(new URL('../', import.meta.url));
  assert(!resolve(staging).startsWith(resolve(checkout) + sep));
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CI;
  delete env.NODE_PATH;
  const installEnv = { ...env };
  // npm runs through an absolute Node executable. No command on PATH can
  // compile an addon, invoke a compiler, or fetch a build tool during install.
  for (const key of Object.keys(installEnv)) {
    if (key.toLowerCase() === 'path') delete installEnv[key];
  }
  installEnv.PATH = '';
  try {
    const archive = receipt.starter.archive;
    // Run tar with relative paths so Git Bash tar can extract on Windows.
    await cp(join(directory, archive), join(staging, archive));
    await run('tar', ['-xzf', archive], staging, env);
    const consumer = join(staging, 'agents-starter');
    const manifest = JSON.parse(
      await readFile(join(consumer, 'package.json'), 'utf8'),
    );
    assert.equal(
      typeof manifest.dependencies.zod,
      'string',
      'hello.mjs imports zod',
    );
    for (const name of sdkNames) {
      assert.equal(
        manifest.dependencies[name],
        `file:vendor/agents/${receipt.packages[name].archive}`,
        `${name} must use its bundled archive`,
      );
      const actual = await hashes(
        join(consumer, manifest.dependencies[name].slice(5)),
      );
      assert.equal(actual.sha256, receipt.packages[name].sha256);
    }
    const fixture = await readFile(
      new URL('./verify-alpha-consumer.mjs', import.meta.url),
    );
    await writeFile(join(consumer, 'verify-alpha-consumer.mjs'), fixture);
    await writeFile(
      join(consumer, 'verification-build.json'),
      JSON.stringify(receipt),
    );
    await run(
      process.execPath,
      [npmCli, 'ci', '--ignore-scripts'],
      consumer,
      installEnv,
    );
    await run(process.execPath, ['verify-alpha-consumer.mjs'], consumer, env);
    const types = await verifyTypes(consumer, env);
    const record = async (profile) =>
      writeFile(
        join(directory, `installed-${profile}-${receipt.platform}.json`),
        `${JSON.stringify(
          {
            ...receipt,
            profile,
            node: process.version,
            ...types,
            verified: [
              'archive-hashes',
              'local-sdk-lock',
              'cjs',
              'esm',
              'facade-runtime-identity',
              'forwarded-subpaths',
              'runtime-payload-ownership',
              'typescript-cjs',
              'typescript-esm',
              'native-receipt',
              'native-helpers',
              'starter-tool',
              'native-tool',
              'native-sessions',
              'classic-sessions',
              'install-without-build-tools',
            ],
          },
          null,
          2,
        )}\n`,
      );
    await record('starter');

    // Transplant the vendored packages and lock into another application. A
    // failing lifecycle hook proves documented installation never compiles code.
    const existing = join(staging, 'existing-application');
    await cp(consumer, existing, {
      recursive: true,
      filter: (file) => !file.split(sep).includes('node_modules'),
    });
    manifest.scripts = { preinstall: 'node -e "process.exit(99)"' };
    manifest.description = 'Existing application with vendored SDK archives';
    await writeFile(
      join(existing, 'package.json'),
      JSON.stringify(manifest, null, 2),
    );
    await run(
      process.execPath,
      [npmCli, 'ci', '--ignore-scripts'],
      existing,
      installEnv,
    );
    await run(process.execPath, ['verify-alpha-consumer.mjs'], existing, env);
    await verifyTypes(existing, env);
    await record('app');
    console.log(
      `Alpha consumer verification passed: ${receipt.version} ${receipt.platform}`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyTypes(consumer, env) {
  const require = createRequire(import.meta.url);
  const compilerManifest =
    require.resolve('@typescript/typescript6/package.json');
  const compiler = JSON.parse(await readFile(compilerManifest, 'utf8'));
  const nodeTypes = require.resolve('@types/node/package.json');
  const source = await readFile(
    new URL('./verify-alpha-types.ts', import.meta.url),
  );
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(consumer, `verify-alpha-types.${extension}`), source);
  }
  await writeFile(
    join(consumer, 'tsconfig.verify.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
          typeRoots: [dirname(dirname(nodeTypes))],
          lib: ['ESNext', 'DOM'],
        },
        files: ['verify-alpha-types.mts', 'verify-alpha-types.cts'],
      },
      null,
      2,
    ),
  );
  // The compiler belongs to the verification harness, never the consumer's
  // dependencies. npm installation still has no compiler or command on PATH.
  await run(
    process.execPath,
    [
      resolve(dirname(compilerManifest), compiler.bin.tsc6),
      '-p',
      'tsconfig.verify.json',
    ],
    consumer,
    env,
  );
  // Also check the declarations an ordinary installed consumer resolves.
  const installedConfig = JSON.parse(
    await readFile(join(consumer, 'tsconfig.verify.json'), 'utf8'),
  );
  delete installedConfig.compilerOptions.typeRoots;
  await writeFile(
    join(consumer, 'tsconfig.verify-installed.json'),
    JSON.stringify(installedConfig, null, 2),
  );
  await run(
    process.execPath,
    [
      resolve(dirname(compilerManifest), compiler.bin.tsc6),
      '-p',
      'tsconfig.verify-installed.json',
    ],
    consumer,
    env,
  );
  const installedNodeTypes = createRequire(
    join(consumer, 'package.json'),
  ).resolve('@types/node/package.json');
  return {
    typescript: compiler.version,
    nodeTypes: JSON.parse(await readFile(nodeTypes, 'utf8')).version,
    installedNodeTypes: JSON.parse(await readFile(installedNodeTypes, 'utf8'))
      .version,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({ options: { directory: { type: 'string' } } });
  assert(
    values.directory,
    'Usage: node scripts/verify-alpha-package.mjs --directory <artifact directory>',
  );
  await verifyAlphaPackage(resolve(values.directory));
}
