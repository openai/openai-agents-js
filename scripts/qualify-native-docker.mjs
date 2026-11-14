import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { nativeInputs } from './native-bundle-inputs.mjs';

assert.equal(process.platform + '-' + process.arch, 'linux-x64');
const directory = resolve('results/native-docker');
mkdirSync(directory, { recursive: true });
const image = process.env.CODEX_DOCKER_TEST_IMAGE;
const socket = process.env.CODEX_DOCKER_TEST_SOCKET;
const fixture = process.env.CODEX_EXEC_SERVER_TEST_BINARY;
assert.match(
  image ?? '',
  /^docker\.io\/library\/python:3\.14-slim@sha256:[a-f0-9]{64}$/,
);
assert.ok(
  socket && statSync(socket).isSocket(),
  'An explicit Docker socket is required',
);
assert.ok(fixture, 'The current native exec-server fixture is required');
accessSync(fixture, constants.F_OK | constants.X_OK);

const packageRoot = resolve('packages/agents-codex');
const addon = join(packageRoot, 'native/codex.node');
const hash = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const build = JSON.parse(
  readFileSync(join(packageRoot, 'native/build-receipt.json'), 'utf8'),
);
assert.equal(build.format, 'reviewed-native-v1');
const addonSha256 = hash(addon);
const fixtureSha256 = hash(fixture);
assert.equal(addonSha256, build.products['native/codex.node']);
assert.equal(
  fixtureSha256,
  build.products['native/test-bin/exec-server-fixture'],
);
const inputs = nativeInputs();
assert.equal(
  inputs,
  process.env.NATIVE_INPUTS,
  'Native inputs changed after artifact transfer',
);
const docker = (...args) =>
  execFileSync('/usr/bin/docker', ['--host', 'unix://' + socket, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
const [selectedImage] = JSON.parse(docker('image', 'inspect', image));
assert.equal(selectedImage.Os, 'linux');
assert.equal(selectedImage.Architecture, 'amd64');
const files = [
  'sandbox-docker-mapped-grants-native.test.ts',
  'sandbox-docker-agent-identity-native.test.ts',
];
const product = {
  sdk: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  core: JSON.parse(
    readFileSync(join(packageRoot, 'native/patches/series.json'), 'utf8'),
  ).result_tree,
  nativeInputs: inputs,
  addonSha256,
  fixtureSha256,
  buildReceiptSha256: hash(join(packageRoot, 'native/build-receipt.json')),
  image: {
    requested: image,
    id: selectedImage.Id,
    repoDigests: selectedImage.RepoDigests,
  },
  testSources: Object.fromEntries(
    files.map((file) => [file, hash(join(packageRoot, 'test/native', file))]),
  ),
};
writeFileSync(
  join(directory, 'product.json'),
  JSON.stringify(product, null, 2) + '\n',
);

const environment = {
  ...process.env,
  OPENAI_AGENTS_NATIVE_TESTS: '1',
  OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX: '1',
};
for (const name of [
  'OPENAI_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
])
  delete environment[name];
const report = join(directory, 'vitest.json');
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--project',
    '@openai/agents-codex',
    ...files.map((file) => 'packages/agents-codex/test/native/' + file),
    '--pool=forks',
    '--maxWorkers=1',
    '--reporter=verbose',
    '--reporter=json',
    '--outputFile.json=' + report,
  ],
  { env: environment, stdio: 'inherit' },
);
assert.ifError(result.error);
assert.equal(result.status, 0, 'Native Docker qualification failed');
const output = JSON.parse(readFileSync(report, 'utf8'));
assert.equal(output.success, true);
assert.equal(
  output.numTotalTests,
  2,
  'Both native Docker controls must be collected',
);
assert.equal(output.numPassedTests, 2, 'Both native Docker controls must pass');
assert.equal(output.numFailedTests, 0);
assert.equal(
  output.numPendingTests,
  0,
  'Native Docker qualification must not skip',
);
assert.equal(output.numTodoTests ?? 0, 0);
assert.deepEqual(
  output.testResults.map(({ name }) => basename(name)).sort(),
  [...files].sort(),
);
for (const suite of output.testResults) {
  assert.equal(suite.assertionResults.length, 1);
  assert.equal(suite.assertionResults[0].status, 'passed');
}
writeFileSync(
  join(directory, 'qualification.json'),
  JSON.stringify(
    {
      ...product,
      passed: 2,
      skipped: 0,
      reportSha256: hash(report),
    },
    null,
    2,
  ) + '\n',
);
