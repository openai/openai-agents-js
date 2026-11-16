import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { nativeInputs } from './native-bundle-inputs.mjs';
import { downloadNativeBundle } from './verified-native-bundle.mjs';

assert.equal(
  nativeInputs(),
  process.env.NATIVE_INPUTS,
  'Native inputs changed after preflight',
);
const root = resolve(process.env.WINDOWS_PARTS);
const receipt = 'native/build-receipt.json';
const transfers = [
  ['addon', process.env.WINDOWS_ADDON, [receipt, 'native/codex.node']],
  [
    'helpers',
    process.env.WINDOWS_HELPERS,
    [
      receipt,
      'bin/codex-sdk-runtime.exe',
      'bin/codex-code-mode-host.exe',
      'native/test-bin/exec-server-fixture.exe',
    ],
  ],
];

const staging = mkdtempSync(root + '-');
try {
  for (const [part, output, files] of transfers) {
    const artifact = JSON.parse(output);
    const bytes = await downloadNativeBundle({
      id: Number(artifact['artifact-id']),
      sha256: artifact['artifact-digest'],
    });
    assert.ok(bytes, `Windows ${part} transfer is unavailable`);
    const entries = execFileSync('tar', ['-tzf', '-'], {
      input: bytes,
      encoding: 'utf8',
    })
      .trimEnd()
      .split(/\r?\n/);
    assert.deepEqual(
      entries.sort(),
      [...files].sort(),
      `Unexpected Windows ${part} transfer files`,
    );
    const details = execFileSync('tar', ['-tvzf', '-'], {
      input: bytes,
      encoding: 'utf8',
    })
      .trimEnd()
      .split(/\r?\n/);
    assert.equal(details.length, files.length);
    assert.ok(
      details.every((entry) => entry.startsWith('-')),
      'Windows transfer must contain regular files',
    );
    const directory = join(staging, part);
    mkdirSync(directory);
    // Let Node set the working directory so Git for Windows tar does not
    // interpret a native drive path passed through its -C option.
    execFileSync('tar', ['-xzf', '-', ...files], {
      cwd: directory,
      input: bytes,
    });
  }
  renameSync(staging, root);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
