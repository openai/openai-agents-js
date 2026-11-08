import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { nativeInputs } from './native-bundle-inputs.mjs';
import { downloadNativeBundle } from './verified-native-bundle.mjs';

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
const products = ['native/codex.node', 'native/build-receipt.json', 'bin'];
if (['linux-x64', 'darwin-arm64', 'win32-x64'].includes(platform))
  products.push(
    'native/test-bin/exec-server-fixture' +
      (process.platform === 'win32' ? '.exe' : ''),
  );
execFileSync('tar', ['-xzf', '-', '-C', 'packages/agents-codex', ...products], {
  input: bytes,
  stdio: ['pipe', 'inherit', 'inherit'],
});
console.log('Restored current-run native artifact ' + id);
