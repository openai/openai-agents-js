import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';

const lockPath = '.github/native-bundle.json';
const platform = process.platform + '-' + process.arch;
const { GITHUB_OUTPUT, PIN_REF, RUNNER_TEMP } = process.env;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Git includes file names, modes, and blob IDs, including newly added inputs.
const inputs = sha256(
  execFileSync('git', [
    'ls-files',
    '--stage',
    '-z',
    '--',
    'packages/agents/native',
    'packages/agents/scripts',
    ':(glob)**/.cargo/**',
    ':(glob)**/.gitattributes',
    '.github/workflows/alpha-release-artifacts.yml',
    'scripts/restore-native-bundle.mjs',
  ]),
);

async function restore() {
  // A PR changing the pin must build fresh. Its base authorizes any download.
  if (
    !existsSync(lockPath) ||
    execFileSync('git', [
      'diff',
      '--name-only',
      PIN_REF,
      'HEAD',
      '--',
      lockPath,
    ]).length
  ) {
    console.log('No accepted native pin. Building from source.');
    return false;
  }
  const lock = JSON.parse(
    execFileSync('git', ['show', PIN_REF + ':' + lockPath]),
  );
  if (lock.inputs !== inputs) {
    console.log('Native inputs changed. Building from source.');
    return false;
  }
  const asset = lock.platforms[platform];
  assert.ok(
    Number.isSafeInteger(asset.id) && asset.id > 0,
    'Invalid native artifact ID',
  );
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  const response = await globalThis.fetch(
    'https://api.github.com/repos/openai/openai-agents-js/actions/artifacts/' +
      asset.id +
      '/zip',
    {
      headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN },
      signal: globalThis.AbortSignal.timeout(180_000),
    },
  );
  if ([404, 410].includes(response.status)) {
    console.log('Pinned artifact is unavailable. Building from source.');
    return false;
  }
  assert.ok(response.ok, 'Native download returned HTTP ' + response.status);
  const archive = join(RUNNER_TEMP, 'pinned-native.tar.gz');
  await pipeline(response.body, createWriteStream(archive, { flags: 'wx' }));
  assert.equal(
    sha256(readFileSync(archive)),
    asset.sha256,
    'Native bundle checksum mismatch',
  );
  execFileSync('tar', ['-xzf', archive, '-C', 'packages/agents'], {
    stdio: 'inherit',
  });
  console.log(
    'Restored verified native artifact ' + asset.id + ' for ' + platform,
  );
  return true;
}

appendFileSync(GITHUB_OUTPUT, 'inputs=' + inputs + '\n');
appendFileSync(GITHUB_OUTPUT, 'restored=' + (await restore()) + '\n');
