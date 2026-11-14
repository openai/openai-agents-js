import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { nativeInputs } from './native-bundle-inputs.mjs';
import {
  downloadNativeBundle,
  nativePlatforms,
} from './verified-native-bundle.mjs';

assert.equal(
  nativeInputs(),
  process.env.NATIVE_INPUTS,
  'Native inputs changed after preflight',
);
// These outputs belong to the exact successful current-run publication step.
const outputs = JSON.parse(process.env.NATIVE_ARTIFACT);
const id = Number(outputs['artifact-id']);
const bytes = await downloadNativeBundle({
  id,
  sha256: outputs['artifact-digest'],
});
assert.ok(bytes, 'Current-run native transfer is unavailable');
const platform = process.platform + '-' + process.arch;
const packageRoot = 'packages/agents-codex';
const products = ['native/codex.node', 'native/build-receipt.json', 'bin'];
const fixture =
  'native/test-bin/exec-server-fixture' +
  (process.platform === 'win32' ? '.exe' : '');
const hasFixture = Object.values(nativePlatforms).includes(platform);
if (hasFixture) products.push(fixture);
execFileSync('tar', ['-xzf', '-', '-C', packageRoot, ...products], {
  input: bytes,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (hasFixture && process.env.GITHUB_OUTPUT) {
  // The fixture travels in the verified archive and stays outside the release package.
  const digest = createHash('sha256')
    .update(readFileSync(join(packageRoot, fixture)))
    .digest('hex');
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `fixture_sha256=${digest}
`,
  );
}
console.log('Restored current-run native artifact ' + id);
