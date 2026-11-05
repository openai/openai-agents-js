import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

export const nativeInputPaths = [
  'packages/agents/native',
  'packages/agents/scripts',
  'packages/agents/bin',
  // An ancestor workspace can supply Cargo's lockfile, dependencies and profiles.
  ':(glob)**/Cargo.toml',
  ':(glob)**/Cargo.lock',
  ':(glob)**/.cargo',
  ':(glob)**/.cargo/**',
  ':(glob)**/.gitattributes',
  '.github/workflows/alpha-release-artifacts.yml',
  'scripts/native-bundle-inputs.mjs',
  'scripts/restore-native-bundle.mjs',
];

export function nativeInputs() {
  // Include file names, modes and blob IDs, including newly added inputs.
  const tracked = (paths) =>
    execFileSync('git', ['ls-files', '--stage', '-z', '--', ...paths], {
      maxBuffer: 64 * 1024 * 1024,
    });
  const native = tracked(nativeInputPaths);
  // Symlinks and ancestor workspaces can reach arbitrary files outside the native crate.
  const linked = native
    .toString()
    .split('\0')
    .some((entry) => entry.startsWith('120000 '));
  const ancestor = [
    'Cargo.toml',
    'packages/Cargo.toml',
    'packages/agents/Cargo.toml',
  ].some(existsSync);
  const entries =
    linked || ancestor
      ? tracked(['.', ':(exclude).github/native-bundle.json'])
      : native;
  return createHash('sha256').update(entries).digest('hex');
}
