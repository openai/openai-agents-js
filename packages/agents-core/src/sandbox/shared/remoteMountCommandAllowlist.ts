import { arraysEqual } from './compare';

export const DEFAULT_REMOTE_MOUNT_COMMAND_ALLOWLIST = [
  'ls',
  'find',
  'stat',
  'cat',
  'less',
  'head',
  'tail',
  'du',
  'grep',
  'rg',
  'wc',
  'sort',
  'cut',
  'cp',
  'tee',
  'echo',
  'mkdir',
  'rm',
];

export function isDefaultRemoteMountCommandAllowlist(
  allowlist: readonly string[],
): boolean {
  return arraysEqual(allowlist, DEFAULT_REMOTE_MOUNT_COMMAND_ALLOWLIST);
}

export function hasCustomRemoteMountCommandAllowlist(
  allowlist: readonly string[],
): boolean {
  return (
    allowlist.length > 0 && !isDefaultRemoteMountCommandAllowlist(allowlist)
  );
}
