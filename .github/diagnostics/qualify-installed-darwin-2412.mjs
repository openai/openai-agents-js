import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [artifactDirectory, selectedLoginPatch] = process.argv.slice(2);
assert(
  artifactDirectory,
  'Provide the verified official Darwin Alpha artifact directory',
);
assert(
  selectedLoginPatch,
  'Provide the verified selected-login diagnostic patch',
);
assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64');
assert.equal(process.versions.node.split('.')[0], '24');
const checkout = await realpath(process.cwd());
const fromCheckout = (file) => import(pathToFileURL(join(checkout, file)));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const source = 'e727b885102bafc18318d7bd7cce9e17438198fd';
const tree = '663dccb05cdcd2f935c91399e61ff65ffe19904f';
const fingerprint =
  '1400d1d7659efa24a8806318f2be56675b6c4dc38fab8fa449162f119a6a27a3';
const platform = 'darwin-arm64';
assert.equal(git('rev-parse', 'HEAD'), source);
assert.equal(git('rev-parse', 'HEAD^{tree}'), tree);
assert.equal(
  git('show', '-s', '--format=%P', 'HEAD'),
  'e10fee5438a292f22f22ed2661b8037cee06e582',
);

const { nativeInputs, nativeComparisonPaths } = await fromCheckout(
  'scripts/native-bundle-inputs.mjs',
);
const { verifyArtifactDirectory, hashes } = await fromCheckout(
  'scripts/verify-alpha-package.mjs',
);
const { verifyNativeReceipt, verifyStarterLock } = await fromCheckout(
  'scripts/alpha-package.mjs',
);
assert.equal(nativeInputs(), fingerprint);
assert.equal(
  git('ls-files', '--stage', '--', ...nativeComparisonPaths()).split('\n')
    .length,
  346,
);
const { helpers } = await verifyNativeReceipt(checkout, platform);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const transfer = await readJson(
  join(checkout, 'packages/agents-codex/native/build-receipt.json'),
);
const artifacts = await realpath(artifactDirectory);
const build = await verifyArtifactDirectory(artifacts, platform);
assert.equal(build.sourceCommit, source);
assert.equal(build.codexRevision, transfer.sources.codex.revision);

const scratch = await realpath(
  await mkdtemp(join(tmpdir(), 'js2412-installed-')),
);
assert(!scratch.startsWith(checkout + sep));
const starter = join(scratch, 'agents-starter');
const testFiles = [
  'test/native/local-executor-policy-native.test.ts',
  'test/native/saved-codex-login-native.test.ts',
];
const selectors = [
  'scopes trusted local workspace writes, private authentication and command temp',
  'scopes Git and SSH settings for local commands',
  'blocks delegation from a local command to launchd with strict',
  'blocks delegation from a local command to launchd with trusted_workspace_write',
  'keeps selected saved-login credentials private in trusted commands',
];
const env = {
  ...process.env,
  OPENAI_AGENTS_NATIVE_TESTS: '1',
  OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX: '1',
  OPENAI_AGENTS_TEST_DARWIN_TRUSTED_CREDENTIALS: '1',
};
for (const key of [
  'OPENAI_API_KEY',
  'CODEX_HOME',
  'NODE_PATH',
  'NODE_OPTIONS',
  'GH_TOKEN',
  'CODEX_THREAD_ID',
])
  delete env[key];
try {
  execFileSync('/usr/bin/tar', [
    '-xzf',
    join(artifacts, build.starter.archive),
    '-C',
    scratch,
  ]);
  verifyStarterLock(
    await readJson(join(starter, 'package-lock.json')),
    build.packages,
  );
  for (const { archive, sha256 } of Object.values(build.packages)) {
    assert.equal(
      (await hashes(join(starter, 'vendor/agents', archive))).sha256,
      sha256,
    );
  }
  const npm = resolve(
    dirname(process.execPath),
    '../lib/node_modules/npm/bin/npm-cli.js',
  );
  execFileSync(
    process.execPath,
    [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: starter,
      env: { ...env, PATH: '' },
      stdio: 'inherit',
    },
  );
  const require = createRequire(join(starter, 'package.json'));
  for (const specifier of [
    '@openai/agents',
    '@openai/agents/testing',
    '@openai/agents-codex',
  ]) {
    assert(
      (await realpath(require.resolve(specifier))).startsWith(
        join(starter, 'node_modules') + sep,
      ),
    );
  }
  const installed = join(starter, 'node_modules/@openai/agents-codex');
  assert.deepEqual(
    await readJson(join(installed, 'native/build-receipt.json')),
    transfer,
  );
  for (const [file, expected] of Object.entries(transfer.products)) {
    assert.equal(
      `sha256:${(await hashes(join(installed, file))).sha256}`,
      expected,
    );
    if (helpers.includes(file))
      await access(join(installed, file), constants.X_OK);
  }

  const testTools = await realpath(join(checkout, 'node_modules/vitest'));
  await symlink(testTools, join(starter, 'node_modules/vitest'), 'dir');
  assert(
    (await realpath(require.resolve('ws'))).startsWith(
      join(starter, 'node_modules') + sep,
    ),
  );
  const fixtures = [
    'model-server.ts',
    'native-descendant-model.ts',
    'public-executor.ts',
    'saved-codex-login-loopback.ts',
    'saved-codex-login-child.mjs',
  ];
  await mkdir(join(starter, 'test/native/fixtures'), { recursive: true });
  for (const file of [
    ...testFiles,
    ...fixtures.map((name) => `test/native/fixtures/${name}`),
  ]) {
    const sourcePath = `packages/agents-codex/${file}`;
    const bytes = execFileSync('git', ['show', `HEAD:${sourcePath}`]);
    await writeFile(join(starter, file), bytes);
  }
  const patch = await realpath(selectedLoginPatch);
  assert.equal(
    (await hashes(patch)).sha256,
    '28b4ec3988e1e0a65e8c8fb0abf90bab841d79f17937b0d1a96fb3752b9c9ec7',
  );
  execFileSync('git', ['apply', '-p3', patch], { cwd: starter });
  assert.equal(
    (await hashes(join(starter, testFiles[1]))).sha256,
    'd6b4513fa96f9b042b4e846a3b1bebc5438db2412e2e477f0d69b6c063bc8d07',
  );
  // The selected-login fixture supplies its own loopback CONNECT proxy and CA.
  const proxy = execFileSync('/usr/sbin/scutil', ['--proxy'], {
    encoding: 'utf8',
  });
  assert(
    !/Enable\s*:\s*1/.test(proxy),
    'Stock Darwin diagnostic requires an unconfigured system proxy',
  );
  await writeFile(join(starter, 'vitest.config.mjs'), 'export default {}\n');
  console.log(
    JSON.stringify({
      source,
      tree,
      fingerprint,
      node: process.version,
      nativeInputs: 346,
      receiptInputs: Object.keys(transfer.inputs).length,
      products: transfer.products,
      executableHelpers: helpers,
      packages: build.packages,
      starter: build.starter,
    }),
  );
  const result = join(scratch, 'test-results.json');
  execFileSync(
    process.execPath,
    [
      join(testTools, 'vitest.mjs'),
      'run',
      '--config',
      './vitest.config.mjs',
      '--pool=forks',
      '--maxWorkers=1',
      '--reporter=verbose',
      '--reporter=json',
      '--outputFile.json',
      result,
      ...testFiles,
      '-t',
      selectors.join('|'),
    ],
    { cwd: starter, env, stdio: 'inherit' },
  );
  const report = await readJson(result);
  const selected = report.testResults
    .flatMap(({ assertionResults }) => assertionResults)
    .filter(({ title }) => selectors.includes(title));
  assert.deepEqual(
    selected.map(({ title, status }) => [title, status]).sort(),
    selectors.map((title) => [title, 'passed']).sort(),
  );
  assert.equal(report.numPassedTests, selectors.length);
  console.log(
    'Verified five selected installed Darwin tests, zero selected skips',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
