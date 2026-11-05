import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const nativeInputPaths = [
  'packages/agents/native',
  'packages/agents/scripts',
  ':(glob)**/.cargo/**',
  ':(glob)**/.gitattributes',
  '.github/workflows/alpha-release-artifacts.yml',
  'scripts/native-bundle-inputs.mjs',
  'scripts/restore-native-bundle.mjs',
];

export function nativeInputs() {
  // Include file names, modes and blob IDs, including newly added inputs.
  const entries = execFileSync('git', [
    'ls-files',
    '--stage',
    '-z',
    '--',
    ...nativeInputPaths,
  ]);
  return createHash('sha256').update(entries).digest('hex');
}
