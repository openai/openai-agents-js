import { UserError } from '@openai/agents-core';
import {
  isHostPathStrictlyWithinRoot,
  type Entry,
  type Manifest,
} from '@openai/agents-core/sandbox';
import { constants, type Dirent, type Stats } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeGitRepository } from './git';
import { formatSandboxProcessError, runSandboxProcess } from './process';
import {
  applyMaterializedManifestEntryToState,
  applyMaterializedManifestToState,
  materializeInlineManifestEntry,
  materializeManifestEntries,
  resolveLocalDirFileConcurrency,
  resolveMaterializedChildPath,
  runLimited,
} from './manifest';
import type { SandboxProcessResult } from './process';
import type {
  ManifestMaterializationOptions,
  MaterializedManifestEntryState,
  MaterializedManifestState,
} from './manifest';
import type { RemoteManifestWriter } from './types';
import type { RemoteSandboxPathResolver } from './types';

const GIT_VERSION_TIMEOUT_MS = 10_000;
const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
const COMMIT_REF_PATTERN = /^[0-9a-fA-F]{7,40}$/;
const LOCAL_SOURCE_FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const LOCAL_SOURCE_DIRECTORY_READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;

type StableLocalDirectorySource = {
  root: string;
  stat: Stats;
};

export async function applyLocalSourceManifestEntryToState(
  state: MaterializedManifestEntryState,
  path: string,
  entry: Entry,
  providerLabel: string,
  writer: RemoteManifestWriter,
  resolvePath: RemoteSandboxPathResolver,
  options: ManifestMaterializationOptions = {},
): Promise<void> {
  await applyMaterializedManifestEntryToState(
    state,
    path,
    entry,
    providerLabel,
    writer,
    resolvePath,
    materializeLocalSourceManifestEntry,
    options,
  );
}

export async function applyLocalSourceManifestToState(
  state: MaterializedManifestState,
  manifest: Manifest,
  providerLabel: string,
  writer: RemoteManifestWriter,
  resolvePath: RemoteSandboxPathResolver,
  options: ManifestMaterializationOptions = {},
): Promise<void> {
  await applyMaterializedManifestToState(
    state,
    manifest,
    providerLabel,
    writer,
    resolvePath,
    materializeLocalSourceManifestEntry,
    options,
  );
}

export async function materializeLocalSourceManifest(
  writer: RemoteManifestWriter,
  manifest: Manifest,
  providerLabel: string,
  resolvePath: RemoteSandboxPathResolver,
  options: ManifestMaterializationOptions = {},
): Promise<void> {
  await materializeManifestEntries(
    writer,
    manifest,
    providerLabel,
    resolvePath,
    materializeLocalSourceManifestEntry,
    options,
  );
}

export async function materializeLocalSourceManifestEntry(
  writer: RemoteManifestWriter,
  absolutePath: string,
  entry: Entry,
  providerLabel: string,
  options: ManifestMaterializationOptions = {},
): Promise<void> {
  switch (entry.type) {
    case 'dir':
      await writer.mkdir(absolutePath);
      if (entry.children) {
        for (const [childPath, childEntry] of Object.entries(entry.children)) {
          const child = await resolveMaterializedChildPath(
            absolutePath,
            childPath,
            options,
          );
          await materializeLocalSourceManifestEntry(
            writer,
            child.absolutePath,
            childEntry,
            providerLabel,
            {
              ...options,
              logicalPath: child.logicalPath,
            },
          );
        }
      }
      break;
    case 'local_file':
      await writer.writeFile(
        absolutePath,
        await readStableLocalFile(entry.src),
      );
      break;
    case 'local_dir':
      await materializeLocalDirectory(writer, absolutePath, entry.src, options);
      break;
    case 'git_repo':
      await materializeGitRepo(
        writer,
        absolutePath,
        entry,
        entry.ref,
        providerLabel,
        options,
      );
      break;
    default:
      await materializeInlineManifestEntry(
        writer,
        absolutePath,
        entry,
        providerLabel,
        options,
      );
      return;
  }

  await options.applyMetadata?.(absolutePath, entry);
}

async function materializeLocalDirectory(
  writer: RemoteManifestWriter,
  absolutePath: string,
  sourceDir: string,
  options: ManifestMaterializationOptions,
  expectedSourceStat?: Stats,
): Promise<void> {
  const source = await resolveStableLocalDirectorySource(
    sourceDir,
    expectedSourceStat,
  );
  await writer.mkdir(absolutePath);
  const entries = await readStableLocalDirectoryEntries(sourceDir, source.stat);

  await runLimited(
    entries,
    resolveLocalDirFileConcurrency(options.concurrencyLimits),
    async (entry) => {
      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = `${absolutePath}/${entry.name}`;

      if (entry.isDirectory()) {
        const childSourceStat = await assertStableLocalDirectoryChild(
          source.root,
          sourcePath,
        );
        await materializeLocalDirectory(
          writer,
          destinationPath,
          sourcePath,
          options,
          childSourceStat,
        );
        return;
      }

      if (entry.isFile()) {
        await writer.writeFile(
          destinationPath,
          await readStableLocalDirectoryFile(source.root, sourcePath),
        );
        return;
      }

      if (entry.isSymbolicLink()) {
        throw new UserError(
          `local_dir entries do not support symbolic links: ${sourcePath}`,
        );
      }
    },
  );
}

async function resolveStableLocalDirectorySource(
  sourceDir: string,
  expectedSourceStat?: Stats,
): Promise<StableLocalDirectorySource> {
  await assertNoLocalSourceSymlinkAncestors(
    sourceDir,
    'local_dir',
    localDirectoryPathChangedError,
  );
  const sourceStat = await statStableLocalSourcePath(sourceDir);
  if (sourceStat.isSymbolicLink()) {
    throw new UserError(
      `local_dir entries do not support symbolic links: ${sourceDir}`,
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new UserError(`local_dir source must be a directory: ${sourceDir}`);
  }
  if (
    expectedSourceStat &&
    !sameFilesystemEntry(sourceStat, expectedSourceStat)
  ) {
    throw localDirectoryPathChangedError(sourceDir);
  }

  const sourceRoot = await realpathStableLocalSourcePath(sourceDir);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sourceDir, LOCAL_SOURCE_DIRECTORY_READ_FLAGS);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw localDirectoryPathChangedError(sourceDir);
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isDirectory() ||
      !sameFilesystemEntry(openedStat, sourceStat)
    ) {
      throw localDirectoryPathChangedError(sourceDir);
    }
    return { root: sourceRoot, stat: openedStat };
  } finally {
    await handle.close();
  }
}

async function readStableLocalDirectoryEntries(
  sourceDir: string,
  expectedStat: Stats,
): Promise<Array<Dirent<string>>> {
  let entries: Array<Dirent<string>>;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (isPathChangedError(error)) {
      throw localDirectoryPathChangedError(sourceDir);
    }
    throw error;
  }

  await assertStableLocalDirectoryPath(sourceDir, expectedStat);
  return entries;
}

async function assertStableLocalDirectoryPath(
  sourcePath: string,
  expectedStat: Stats,
): Promise<void> {
  const currentStat = await statStableLocalSourcePath(sourcePath);
  if (
    currentStat.isSymbolicLink() ||
    !currentStat.isDirectory() ||
    !sameFilesystemEntry(currentStat, expectedStat)
  ) {
    throw localDirectoryPathChangedError(sourcePath);
  }
}

async function readStableLocalFile(sourcePath: string): Promise<Uint8Array> {
  await assertNoLocalSourceSymlinkAncestors(
    sourcePath,
    'local_file',
    localFilePathChangedError,
  );
  const sourceStat = await statStableLocalSourcePath(
    sourcePath,
    localFilePathChangedError,
  );
  if (sourceStat.isSymbolicLink()) {
    throw new UserError(
      `local_file entries do not support symbolic links: ${sourcePath}`,
    );
  }
  if (!sourceStat.isFile()) {
    throw localFilePathChangedError(sourcePath);
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sourcePath, LOCAL_SOURCE_FILE_READ_FLAGS);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw localFilePathChangedError(sourcePath);
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFilesystemEntry(openedStat, sourceStat)) {
      throw localFilePathChangedError(sourcePath);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertNoLocalSourceSymlinkAncestors(
  sourcePath: string,
  entryType: 'local_dir' | 'local_file',
  pathChangedError: (sourcePath: string) => UserError,
): Promise<void> {
  const resolvedPath = resolve(sourcePath);
  let current = dirname(resolvedPath);

  while (current !== dirname(current)) {
    const parent = dirname(current);
    if (parent === dirname(parent)) {
      break;
    }
    let currentStat: Stats;
    try {
      currentStat = await lstat(current);
    } catch (error) {
      if (isPathChangedError(error)) {
        throw pathChangedError(sourcePath);
      }
      throw error;
    }
    if (currentStat.isSymbolicLink()) {
      throw new UserError(
        `${entryType} entries do not support symbolic link ancestors: ${sourcePath}`,
      );
    }
    current = parent;
  }
}

async function readStableLocalDirectoryFile(
  sourceRoot: string,
  sourcePath: string,
): Promise<Uint8Array> {
  // local_dir expands on the host before upload, so reject symlinks and pin the
  // opened inode to avoid leaking swapped-in files outside the declared directory.
  const sourceStat = await statStableLocalSourcePath(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new UserError(
      `local_dir entries do not support symbolic links: ${sourcePath}`,
    );
  }
  if (!sourceStat.isFile()) {
    throw localDirectoryPathChangedError(sourcePath);
  }

  const resolvedSourcePath = await realpathStableLocalSourcePath(sourcePath);
  assertPathInsideRootChild(
    sourceRoot,
    resolvedSourcePath,
    `local_dir entry path changed while materializing: ${sourcePath}`,
  );

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sourcePath, LOCAL_SOURCE_FILE_READ_FLAGS);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw localDirectoryPathChangedError(sourcePath);
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFilesystemEntry(openedStat, sourceStat)) {
      throw localDirectoryPathChangedError(sourcePath);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertStableLocalDirectoryChild(
  sourceRoot: string,
  sourcePath: string,
): Promise<Stats> {
  const sourceStat = await statStableLocalSourcePath(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new UserError(
      `local_dir entries do not support symbolic links: ${sourcePath}`,
    );
  }
  if (!sourceStat.isDirectory()) {
    throw localDirectoryPathChangedError(sourcePath);
  }

  const resolvedSourcePath = await realpathStableLocalSourcePath(sourcePath);
  assertPathInsideRootChild(
    sourceRoot,
    resolvedSourcePath,
    `local_dir entry path changed while materializing: ${sourcePath}`,
  );

  return sourceStat;
}

async function statStableLocalSourcePath(
  sourcePath: string,
  pathChangedError: (
    sourcePath: string,
  ) => UserError = localDirectoryPathChangedError,
): Promise<Stats> {
  try {
    return await lstat(sourcePath);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw pathChangedError(sourcePath);
    }
    throw error;
  }
}

async function realpathStableLocalSourcePath(
  sourcePath: string,
  pathChangedError: (
    sourcePath: string,
  ) => UserError = localDirectoryPathChangedError,
): Promise<string> {
  try {
    return await realpath(sourcePath);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw pathChangedError(sourcePath);
    }
    throw error;
  }
}

function localDirectoryPathChangedError(sourcePath: string): UserError {
  return new UserError(
    `local_dir entry path changed while materializing: ${sourcePath}`,
  );
}

function localFilePathChangedError(sourcePath: string): UserError {
  return new UserError(
    `local_file entry path changed while materializing: ${sourcePath}`,
  );
}

function isPathChangedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ELOOP' ||
      error.code === 'ENOENT' ||
      error.code === 'ENOTDIR')
  );
}

function sameFilesystemEntry(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPathInsideRootChild(
  sourceRoot: string,
  resolvedSourcePath: string,
  errorMessage: string,
): void {
  if (!isHostPathStrictlyWithinRoot(sourceRoot, resolvedSourcePath)) {
    throw new UserError(errorMessage);
  }
}

async function materializeGitRepo(
  writer: RemoteManifestWriter,
  absolutePath: string,
  repository: string | { host?: string; repo: string; subpath?: string },
  ref: string | undefined,
  providerLabel: string,
  options: ManifestMaterializationOptions,
): Promise<void> {
  const gitVersion = await runSandboxProcess('git', ['--version'], {
    timeoutMs: GIT_VERSION_TIMEOUT_MS,
  });
  if (gitVersion.status !== 0) {
    throw new UserError(
      'git_repo entries require a local `git` executable, but `git` was not found.',
    );
  }

  const tempDir = await mkdtemp(
    join(tmpdir(), `openai-agents-${providerLabel}-git-`),
  );
  try {
    const repositoryUrl = normalizeGitRepository(repository);
    const { result: cloneResult, commitFetchError } = await cloneGitRepo(
      repositoryUrl,
      tempDir,
      ref,
    );
    if (cloneResult.status !== 0) {
      throw new UserError(
        `Failed to materialize git_repo entry ${formatGitRepositoryForError(repository)}: ${formatSandboxProcessError(commitFetchError ?? cloneResult)}`,
      );
    }
    const subpath =
      typeof repository === 'string' ? undefined : repository.subpath;
    const sourcePath = subpath ? join(tempDir, subpath) : tempDir;
    if (subpath) {
      const cloneRoot = await realpath(tempDir);
      const sourceRealpath = await realpath(sourcePath);
      assertPathInsideRootChild(
        cloneRoot,
        sourceRealpath,
        `git_repo subpath escapes the cloned repository: ${subpath}`,
      );
    }
    await materializeGitRepoSource(
      writer,
      absolutePath,
      sourcePath,
      options,
      subpath,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function cloneGitRepo(
  repositoryUrl: string,
  destination: string,
  ref: string | undefined,
): Promise<{
  result: SandboxProcessResult;
  commitFetchError?: SandboxProcessResult;
}> {
  if (!ref || !looksLikeCommitRef(ref)) {
    return { result: await cloneNamedRef(repositoryUrl, destination, ref) };
  }

  // Branch/tag shallow clone does not reliably fetch arbitrary SHAs, so
  // commit-looking refs take the explicit init/fetch/checkout path first.
  const result = await fetchCommitRef(repositoryUrl, destination, ref);
  if (result.status === 0) {
    return { result };
  }

  await rm(destination, { recursive: true, force: true });
  return {
    result: await cloneNamedRef(repositoryUrl, destination, ref),
    commitFetchError: result,
  };
}

async function cloneNamedRef(
  repositoryUrl: string,
  destination: string,
  ref: string | undefined,
): Promise<SandboxProcessResult> {
  const cloneArgs = ['clone', '--depth', '1', '--no-tags'];
  if (ref) {
    cloneArgs.push('--branch', ref);
  }
  cloneArgs.push(repositoryUrl, destination);
  return await runSandboxProcess('git', cloneArgs, {
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
  });
}

async function fetchCommitRef(
  repositoryUrl: string,
  destination: string,
  ref: string,
): Promise<SandboxProcessResult> {
  const steps: string[][] = [
    ['init', destination],
    ['-C', destination, 'remote', 'add', 'origin', repositoryUrl],
    ['-C', destination, 'fetch', '--depth', '1', '--no-tags', 'origin', ref],
    ['-C', destination, 'checkout', '--detach', 'FETCH_HEAD'],
  ];

  for (const args of steps) {
    const result = await runSandboxProcess('git', args, {
      timeoutMs: GIT_CLONE_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return result;
    }
  }

  return {
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
  };
}

function looksLikeCommitRef(ref: string): boolean {
  return COMMIT_REF_PATTERN.test(ref);
}

async function materializeGitRepoSource(
  writer: RemoteManifestWriter,
  absolutePath: string,
  sourcePath: string,
  options: ManifestMaterializationOptions,
  subpath?: string,
): Promise<void> {
  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.isDirectory()) {
    await materializeLocalDirectory(writer, absolutePath, sourcePath, options);
    return;
  }
  if (sourceInfo.isFile()) {
    await writer.writeFile(absolutePath, await readFile(sourcePath));
    return;
  }
  throw new UserError(
    `git_repo subpath must resolve to a file or directory: ${subpath ?? '.'}`,
  );
}

function formatGitRepositoryForError(
  repository: string | { host?: string; repo: string; subpath?: string },
): string {
  if (typeof repository === 'string') {
    return repository;
  }
  return repository.repo;
}
