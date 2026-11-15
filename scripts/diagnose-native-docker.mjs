// This entrypoint has been keeping candidate runner-policy qualification red.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const directory = resolve('results/native-docker');
mkdirSync(directory, { recursive: true });
const image = process.env.CODEX_DOCKER_TEST_IMAGE;
const socket = process.env.CODEX_DOCKER_TEST_SOCKET;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
assert.equal(socket, '/var/run/docker.sock');
const hash = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const dockerfile = resolve('.github/docker/native-executor.Dockerfile');
const docker = (...args) =>
  execFileSync('/usr/bin/docker', ['--host', 'unix://' + socket, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
const [selectedImage] = JSON.parse(docker('image', 'inspect', image));
const profileDirectory = '/etc/openai-agents-native-docker';
const rootFile = (path) => {
  assert.equal(dirname(path), profileDirectory);
  for (const entry of [profileDirectory, path]) {
    const info = lstatSync(entry);
    assert.equal(info.uid, 0, 'Runner policy must be root-owned');
    assert.equal(info.mode & 0o022, 0, 'Runner policy must not be writable');
    assert.equal(info.isSymbolicLink(), false);
  }
  assert.equal(lstatSync(path).isFile(), true);
  return readFileSync(path, 'utf8');
};
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY, 'openai/openai-agents-js');
const sdk = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
assert.equal(
  sdk,
  process.env.GITHUB_SHA,
  'Checkout must match tested merge/push',
);
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const parents = execFileSync('git', ['cat-file', '-p', sdk], {
  encoding: 'utf8',
})
  .split('\n\n', 1)[0]
  .split('\n')
  .filter((line) => line.startsWith('parent '))
  .map((line) => line.slice(7));
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  assert.equal(
    event.pull_request.head.repo.full_name,
    process.env.GITHUB_REPOSITORY,
  );
  assert.equal(
    event.pull_request.base.repo.full_name,
    process.env.GITHUB_REPOSITORY,
  );
  assert.equal(event.pull_request.base.ref, 'feat/codex-harness');
  assert.equal(process.env.GITHUB_REF, `refs/pull/${event.number}/merge`);
  assert.deepEqual(parents, [
    event.pull_request.base.sha,
    event.pull_request.head.sha,
  ]);
} else {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/feat/codex-harness');
  assert.equal(event.ref, process.env.GITHUB_REF);
  assert.equal(event.after, sdk);
  assert.equal(event.deleted, false);
}
assert.equal(event.repository.full_name, process.env.GITHUB_REPOSITORY);
const lineage = {
  ref: process.env.GITHUB_REF,
  sourceCommit: sdk,
  parents,
  repository: process.env.GITHUB_REPOSITORY,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  eventName: process.env.GITHUB_EVENT_NAME,
};
const profile = JSON.parse(rootFile(join(profileDirectory, 'manifest.json')));
assert.equal(profile.format, 'native-docker-runner-profile-v1');
assert.equal(profile.runId, process.env.GITHUB_RUN_ID);
assert.equal(profile.runAttempt, process.env.GITHUB_RUN_ATTEMPT);
assert.equal(profile.sourceCommit, sdk);
assert.equal(profile.imageId, selectedImage.Id);
assert.equal(profile.recipeSha256, hash(dockerfile));
assert.equal(typeof profile.diagnosticOnly, 'boolean');
assert.equal(profile.upstream.version, 'v28.0.4');
assert.equal(
  profile.upstream.seccompSha256,
  '9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76',
);
assert.equal(
  profile.upstream.apparmorTemplateSha256,
  '42130ca5908f45263facef820961d9e1a988e82f8a2937f4658e7bcccc96cc07',
);
assert.equal(
  profile.apparmor.name,
  `agents-native-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
);
for (const [kind, filename] of [
  ['apparmor', 'apparmor.profile'],
  ['seccomp', 'seccomp.json'],
]) {
  const path = join(profileDirectory, filename);
  assert.equal(profile[kind].path, path);
  rootFile(path);
  assert.equal(hash(path), profile[kind].sha256);
}

writeFileSync(
  join(directory, 'runner-profile.json'),
  JSON.stringify(
    {
      profile,
      lineage,
      wrapperSha256: hash('.github/docker/native-executor-docker.py'),
      probesSha256: hash('.github/docker/native-executor-probes.py'),
    },
    null,
    2,
  ) + '\n',
);
const environment = { ...process.env };
for (const key of [
  'OPENAI_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
])
  delete environment[key];
const wrapper = mkdtempSync(join(tmpdir(), 'agents-native-docker-wrapper-'));
chmodSync(wrapper, 0o700);
copyFileSync(
  '.github/docker/native-executor-docker.py',
  join(wrapper, 'docker'),
);
chmodSync(join(wrapper, 'docker'), 0o700);
const containerEvidence = join(directory, 'containers.jsonl');
writeFileSync(containerEvidence, '', { mode: 0o600 });
writeFileSync(
  join(wrapper, 'configuration.json'),
  JSON.stringify({
    host: 'unix://' + socket,
    image,
    imageId: selectedImage.Id,
    profile,
    evidence: containerEvidence,
  }),
  { mode: 0o600 },
);
environment.PATH = wrapper + ':' + (environment.PATH ?? '/usr/bin:/bin');

let container;
const result = {
  diagnosticOnly: true,
  probesPassed: false,
  nativeControlsPassed: false,
};
rmSync(join(directory, 'qualification.json'), { force: true });
try {
  const probeContainer = spawnSync(
    join(wrapper, 'docker'),
    [
      '--host',
      'unix://' + socket,
      'run',
      '-d',
      '--network',
      'none',
      '--label',
      'agents-native-ci-probe=true',
      image,
      '/bin/sh',
      '-c',
      'sleep 300',
    ],
    { env: environment, encoding: 'utf8' },
  );
  if (probeContainer.status === 0) {
    container = probeContainer.stdout.trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    const probe = spawnSync(
      join(wrapper, 'docker'),
      [
        '--host',
        'unix://' + socket,
        'exec',
        '-i',
        container,
        '/usr/local/bin/python',
        '-',
        profile.apparmor.name,
      ],
      {
        env: environment,
        input: readFileSync('.github/docker/native-executor-probes.py'),
        encoding: 'utf8',
      },
    );
    writeFileSync(join(directory, 'probes.stdout'), probe.stdout ?? '');
    writeFileSync(join(directory, 'probes.stderr'), probe.stderr ?? '');
    result.probesPassed = probe.status === 0;
  } else {
    writeFileSync(
      join(directory, 'probe-start.stderr'),
      probeContainer.stderr ?? String(probeContainer.error),
    );
  }
  const native = spawnSync(
    process.execPath,
    ['scripts/qualify-native-docker.mjs', '--diagnostic-only'],
    { env: environment, stdio: 'inherit' },
  );
  result.nativeControlsPassed = native.status === 0;
} finally {
  try {
    if (container) docker('rm', '-f', container);
  } finally {
    rmSync(wrapper, { recursive: true, force: true });
    writeFileSync(
      join(directory, 'diagnostic-result.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
  }
}
// The final in-job aggregation owns success only after cleanup.
