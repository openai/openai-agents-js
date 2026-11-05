import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { nativeInputs } from './native-bundle-inputs.mjs';
import { findNativeBundle } from './verified-native-bundle.mjs';

const platform = process.platform + '-' + process.arch;
const { GITHUB_OUTPUT } = process.env;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = nativeInputs();

function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      'Native bundle (' + platform + ', ' + inputs + '): ' + message + '\n',
    );
  }
}

async function restore() {
  const asset = findNativeBundle(inputs, platform);
  if (!asset) {
    report('No verified native bundle for these inputs. Building from source.');
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
    report('Native artifact is unavailable. Building from source.');
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
  execFileSync(
    'tar',
    ['-xzf', '-', '-C', 'packages/agents-codex', ...products],
    {
      input: archive,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  report(
    'Restored verified native artifact ' + asset.id + ' from run ' + asset.run,
  );
  return true;
}

appendFileSync(GITHUB_OUTPUT, 'inputs=' + inputs + '\n');
appendFileSync(GITHUB_OUTPUT, 'restored=' + (await restore()) + '\n');
