import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const lockPath = '.github/native-bundle.json';
const platform = process.platform + '-' + process.arch;
const { GITHUB_OUTPUT, PIN_REF } = process.env;
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
  // Only an unchanged pin on the exact event base authorizes a download.
  // A shallow checkout can lack that commit when GitHub regenerates the merge ref.
  if (
    !existsSync(lockPath) ||
    spawnSync('git', ['diff', '--quiet', PIN_REF, 'HEAD', '--', lockPath])
      .status !== 0
  ) {
    console.log('No accepted native pin. Building from source.');
    return false;
  }
  const lock = JSON.parse(
    execFileSync('git', ['show', PIN_REF + ':' + lockPath]),
  );
  const asset = lock.platforms?.[platform];
  if (lock.inputs !== inputs || !asset) {
    console.log(
      'No matching platform pin for these native inputs. Building from source.',
    );
    return false;
  }
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
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(
    sha256(archive),
    asset.sha256,
    'Native bundle checksum mismatch',
  );
  const products = ['native/codex.node', 'native/build-receipt.json', 'bin'];
  if (platform === 'darwin-arm64')
    products.push('native/test-bin/exec-server-fixture');
  execFileSync('tar', ['-xzf', '-', '-C', 'packages/agents', ...products], {
    input: archive,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log(
    'Restored verified native artifact ' + asset.id + ' for ' + platform,
  );
  return true;
}

appendFileSync(GITHUB_OUTPUT, 'inputs=' + inputs + '\n');
appendFileSync(GITHUB_OUTPUT, 'restored=' + (await restore()) + '\n');
