import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { downloadNativeBundle } from './verified-native-bundle.mjs';

const packages = [
  'agents-core',
  'agents-openai',
  'agents-realtime',
  'agents-codex',
  'agents',
  'agents-extensions',
];
const portable = [
  'codex-realtime-control.wasm',
  'codex-turn-control.wasm',
  'codex-realtime-control.mjs',
  'codex-realtime-control.cjs',
  'codex-turn-control.mjs',
  'codex-turn-control.cjs',
  'portable-build-receipt.json',
];
export const sdkBuildPaths = [
  ...packages.flatMap((name) => [
    `packages/${name}/dist`,
    `packages/${name}/src/metadata.ts`,
  ]),
  ...['agents-codex', 'agents'].flatMap((name) =>
    portable.map((file) => `packages/${name}/native/${file}`),
  ),
];

export function packSdkBuild(output) {
  execFileSync('tar', ['-czf', output, '--', ...sdkBuildPaths], {
    stdio: 'inherit',
  });
}

export function restoreSdkBuild(bytes) {
  // Select only common outputs; platform binaries and their receipts stay local.
  execFileSync('tar', ['-xzf', '-', '--', ...sdkBuildPaths], {
    input: bytes,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === 'pack') {
    assert.ok(process.argv[3], 'Missing SDK build archive path');
    packSdkBuild(resolve(process.argv[3]));
  } else {
    assert.equal(process.argv[2], 'restore');
    const outputs = JSON.parse(process.env.SDK_ARTIFACT);
    const bytes = await downloadNativeBundle({
      id: Number(outputs['artifact-id']),
      sha256: outputs['artifact-digest'],
    });
    assert.ok(bytes, 'Current-run SDK build transfer is unavailable');
    restoreSdkBuild(bytes);
  }
}
