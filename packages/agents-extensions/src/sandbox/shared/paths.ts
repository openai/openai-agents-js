import { UserError } from '@openai/agents-core';
import { randomUUID } from 'node:crypto';
import {
  type Manifest,
  normalizeRelativePath,
  posixDirname,
  type SandboxPathGrant,
  SandboxPathResolutionError,
  shellQuote,
  WorkspacePathPolicy,
} from '@openai/agents-core/sandbox';
import type { RemoteSandboxPathOptions } from './types';

export { posixDirname, shellQuote };

export type RemotePathCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

export type ValidateRemoteSandboxPathArgs = {
  root: string;
  path?: string;
  options?: ValidateRemoteSandboxPathOptions;
  runCommand(command: string): Promise<RemotePathCommandResult>;
};

export type ValidateRemoteSandboxPathOptions = RemoteSandboxPathOptions & {
  extraPathGrants?: SandboxPathGrant[];
};

export type ValidateRemoteSandboxPathForManifestArgs = Omit<
  ValidateRemoteSandboxPathArgs,
  'root' | 'options'
> & {
  manifest: Manifest;
  options?: RemoteSandboxPathOptions;
};

const RESOLVE_WORKSPACE_PATH_HELPER = String.raw`#!/bin/sh
set -eu

root="$1"
candidate="$2"
for_write="$3"
shift 3
max_symlink_depth=64

case "$for_write" in
  0|1) ;;
  *) printf 'for_write must be 0 or 1: %s\n' "$for_write" >&2; exit 64 ;;
esac

if [ $(( $# % 2 )) -ne 0 ]; then
  printf 'extra path grants must be root/read_only pairs\n' >&2
  exit 64
fi

resolve_path() {
  path="$1"
  depth="$2"
  seen=""
  if [ "$#" -ge 3 ]; then
    seen="$3"
  fi
  if [ "$path" = "/" ]; then
    printf '/\n'
    return 0
  fi
  if [ "$depth" -ge "$max_symlink_depth" ]; then
    printf 'symlink resolution depth exceeded: %s\n' "$path" >&2
    exit 112
  fi
  if [ -d "$path" ]; then
    (cd "$path" && pwd -P)
    return 0
  fi
  parent=$(dirname "$path")
  base=$(basename "$path")
  if [ -z "$parent" ] || [ "$parent" = "$path" ]; then
    parent="/"
  fi
  resolved_parent=$(resolve_path "$parent" "$depth" "$seen")
  candidate_path=$(join_child_path "$resolved_parent" "$base")
  if [ -L "$candidate_path" ]; then
    case ":$seen:" in
      *":$candidate_path:"*)
        printf 'symlink resolution depth exceeded: %s\n' "$candidate_path" >&2
        exit 112
        ;;
    esac
    target=$(readlink "$candidate_path")
    next_depth=$((depth + 1))
    next_seen="$seen:$candidate_path"
    case "$target" in
      /*) resolve_path "$target" "$next_depth" "$next_seen" ;;
      *)
        relative_target=$(join_child_path "$resolved_parent" "$target")
        resolve_path "$relative_target" "$next_depth" "$next_seen"
        ;;
    esac
    return 0
  fi
  printf '%s\n' "$candidate_path"
}

join_child_path() {
  parent="$1"
  child="$2"
  if [ "$parent" = "/" ]; then
    printf '/%s\n' "$child"
  else
    printf '%s/%s\n' "$parent" "$child"
  fi
}

resolved_candidate=$(resolve_path "$candidate" 0)
best_grant_root=""
best_grant_original=""
best_grant_read_only="0"
best_grant_len=0

check_workspace_root() {
  resolved_root=$(resolve_path "$root" 0)
  if [ "$resolved_root" = "/" ]; then
    case "$resolved_candidate" in
      /*)
        printf '%s\n' "$resolved_candidate"
        exit 0
        ;;
    esac
  fi
  case "$resolved_candidate" in
    "$resolved_root"|"$resolved_root"/*)
      printf '%s\n' "$resolved_candidate"
      exit 0
      ;;
  esac
}

consider_extra_grant() {
  allowed_root="$1"
  read_only="$2"
  case "$read_only" in
    0|1) ;;
    *) printf 'extra path grant read_only must be 0 or 1: %s\n' "$read_only" >&2; exit 64 ;;
  esac
  resolved_root=$(resolve_path "$allowed_root" 0)
  if [ "$resolved_root" = "/" ]; then
    printf 'extra path grant must not resolve to filesystem root: %s\n' "$allowed_root" >&2
    exit 113
  fi
  case "$resolved_candidate" in
    "$resolved_root"|"$resolved_root"/*)
      root_len=$(printf '%s' "$resolved_root" | wc -c | tr -d ' ')
      if [ "$root_len" -gt "$best_grant_len" ]; then
        best_grant_root="$resolved_root"
        best_grant_original="$allowed_root"
        best_grant_read_only="$read_only"
        best_grant_len="$root_len"
      fi
      ;;
  esac
}

while [ "$#" -gt 0 ]; do
  consider_extra_grant "$1" "$2"
  shift 2
done

check_workspace_root
if [ -n "$best_grant_root" ]; then
  if [ "$for_write" = "1" ] && [ "$best_grant_read_only" = "1" ]; then
    printf 'read-only extra path grant: %s\nresolved path: %s\n' "$best_grant_original" "$resolved_candidate" >&2
    exit 114
  fi
  printf '%s\n' "$resolved_candidate"
  exit 0
fi

printf 'workspace escape: %s\n' "$resolved_candidate" >&2
exit 111`;

export function resolveSandboxAbsolutePath(
  root: string,
  path?: string,
  options: ValidateRemoteSandboxPathOptions = {},
): string {
  return new WorkspacePathPolicy({
    root,
    extraPathGrants: options.extraPathGrants,
  }).resolve(path, { forWrite: options.forWrite }).path;
}

export async function validateRemoteSandboxPath({
  root,
  path,
  options = {},
  runCommand,
}: ValidateRemoteSandboxPathArgs): Promise<string> {
  const candidate = resolveSandboxAbsolutePath(root, path, options);
  const helperDir = `/tmp/openai-agents-resolve-path-${randomUUID()}`;
  const helperArgs = [
    root,
    candidate,
    options.forWrite ? '1' : '0',
    ...(options.extraPathGrants ?? []).flatMap((grant) => [
      grant.path,
      grant.readOnly ? '1' : '0',
    ]),
  ];
  const command = [
    `helper_dir=${shellQuote(helperDir)}`,
    'helper_path="$helper_dir/resolve-workspace-path.sh"',
    'cleanup() { rm -rf "$helper_dir"; }',
    'trap cleanup EXIT HUP INT TERM',
    'umask 077',
    'mkdir "$helper_dir" || exit 125',
    'cat > "$helper_path" <<\'OPENAI_AGENTS_RESOLVE_PATH\'',
    RESOLVE_WORKSPACE_PATH_HELPER,
    'OPENAI_AGENTS_RESOLVE_PATH',
    'chmod 700 "$helper_path" || exit 125',
    `"$helper_path" ${helperArgs.map(shellQuote).join(' ')}`,
  ].join('\n');
  const result = await runCommand(command);
  if (result.status !== 0) {
    const message = (
      result.stderr ||
      result.stdout ||
      'remote validation failed'
    )
      .trim()
      .split(/\r?\n/u)
      .join('; ');
    throw new SandboxPathResolutionError(
      `Sandbox path "${path ?? ''}" failed remote validation: ${message}`,
      {
        root,
        path: path ?? '',
        forWrite: options.forWrite ?? false,
      },
    );
  }

  const resolvedPath = result.stdout?.trim().split(/\r?\n/u).pop();
  if (!resolvedPath?.startsWith('/')) {
    throw new SandboxPathResolutionError(
      `Sandbox path "${path ?? ''}" failed remote validation: validator did not return an absolute resolved path.`,
      {
        root,
        path: path ?? '',
        forWrite: options.forWrite ?? false,
      },
    );
  }
  return resolvedPath;
}

export async function validateRemoteSandboxPathForManifest({
  manifest,
  path,
  options = {},
  runCommand,
}: ValidateRemoteSandboxPathForManifestArgs): Promise<string> {
  return await validateRemoteSandboxPath({
    root: manifest.root,
    path,
    options: {
      ...options,
      extraPathGrants: manifest.extraPathGrants,
    },
    runCommand,
  });
}

export function resolveSandboxRelativePath(
  root: string,
  path?: string,
): string {
  const resolved = new WorkspacePathPolicy({
    root,
  }).resolve(path, { forWrite: true });
  if (typeof resolved.workspaceRelativePath !== 'string') {
    throw new UserError(
      `Sandbox path "${path ?? ''}" escapes the workspace root.`,
    );
  }
  return normalizeRelativePath(resolved.workspaceRelativePath);
}

export function resolveSandboxWorkdir(root: string, path?: string): string {
  return resolveSandboxAbsolutePath(root, path);
}
