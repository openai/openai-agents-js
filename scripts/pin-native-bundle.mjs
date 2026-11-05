import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { renameSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const runId = process.argv[2] ?? '';
assert.match(
  runId,
  /^[1-9]\d*$/,
  'Usage: node scripts/pin-native-bundle.mjs RUN_ID',
);
const repo = 'openai/openai-agents-js';
const path = 'repos/' + repo + '/actions/runs/' + runId;
const api = (...args) => JSON.parse(execFileSync('gh', ['api', ...args]));
const run = api(path);
assert.equal(run.conclusion, 'success', 'Choose a successful native build');
assert.equal(
  run.head_repository?.full_name,
  repo,
  'Choose a build from the SDK repository',
);
function list(endpoint, field) {
  return api('--paginate', '--slurp', path + endpoint).flatMap(
    (page) => page[field],
  );
}
const artifacts = list('/artifacts?per_page=100', 'artifacts');
const jobs = list('/jobs?filter=all&per_page=100', 'jobs');

let inputs;
const platforms = {};
for (const platform of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
  // A retry of one failed platform keeps the other platforms' successful jobs.
  const name = 'Package and test (' + platform + ')';
  const job = jobs
    .filter((entry) => entry.name === name || entry.name.endsWith(' / ' + name))
    .sort((a, b) => b.run_attempt - a.run_attempt)[0];
  assert.equal(
    job?.conclusion,
    'success',
    'Expected a qualified job for ' + platform,
  );
  const upload = job.steps.find(
    (step) => step.name === 'Upload the native bundle for pinning',
  );
  assert.equal(
    upload?.conclusion,
    'success',
    'Expected a fresh native build for ' + platform,
  );
  const suffix = '-' + platform + '-' + job.run_attempt + '.tar.gz';
  const matches = artifacts.filter(
    (asset) =>
      !asset.expired &&
      asset.name.startsWith('native-') &&
      asset.name.endsWith(suffix),
  );
  assert.equal(matches.length, 1, 'Expected one fresh bundle for ' + platform);
  const { id, digest, name: artifactName } = matches[0];
  const key = artifactName.slice('native-'.length, -suffix.length);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(
    inputs ?? key,
    key,
    'Platforms were built with different native inputs',
  );
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  inputs = key;
  platforms[platform] = { id, sha256: digest.slice('sha256:'.length) };
}

const manifest = '.github/native-bundle.json';
const temp = manifest + '.' + process.pid;
writeFileSync(
  temp,
  JSON.stringify({ run: Number(runId), inputs, platforms }, null, 2) + '\n',
);
renameSync(temp, manifest);
console.log(
  'Pinned native bundles from ' + run.html_url + ' (' + run.head_sha + ')',
);
