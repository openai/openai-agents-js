import type { Dir, Entry, GitRepo, Mount, TypedMount } from './types';

export function isDir(entry: Entry): entry is Dir {
  return entry.type === 'dir';
}

export function isGitRepo(entry: Entry): entry is GitRepo {
  return entry.type === 'git_repo';
}

export function isMount(entry: Entry): entry is Mount | TypedMount {
  return entry.type === 'mount' || entry.type.endsWith('_mount');
}

export function isDirectoryLikeEntry(
  entry: Entry,
): entry is Dir | GitRepo | Mount | TypedMount {
  return entry.type === 'dir' || entry.type === 'git_repo' || isMount(entry);
}
