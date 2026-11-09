import { UserError } from '@openai/agents-core';
import { type Entry, type Manifest } from '@openai/agents-core/sandbox';
import {
  isHostPathStrictlyWithinRoot,
  openLocalSourceDirectory,
  readLocalSourceFile,
  isHostPathWithinRoot,
  sandboxPathGrantHostPath,
} from '@openai/agents-core/sandbox/internal';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeGitRepository } from './git';
import { formatSandboxProcessError, runSandboxProcess } from './process';
import {
  applyMaterializedManifestEntryToState,
  applyMaterializedManifestToState,
  materializeInlineManifestEntry,
  materializeManifestEntries,
  mergeManifestDelta,
  resolveLocalDirFileConcurrency,
  resolveMaterializedChildPath,
  runLimited,
} from './manifest';
import type { SandboxProcessResult } from './process';
import type {
  ManifestMaterializationOptions,
  MaterializedManifestEntryState,
  MaterializedManifestState,
  PreparedMaterializedManifestTransition,
} from './manifest';
import type { RemoteManifestWriter } from './types';
import type { RemoteSandboxPathResolver } from './types';

const GIT_VERSION_TIMEOUT_MS = 10_000;
const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
const COMMIT_REF_PATTERN = /^[0-9a-fA-F]{7,40}$/;
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
    {
      ...options,
      localSourceGrants: state.manifest.extraPathGrants,
    },
  );
}

export async function applyLocalSourceManifestToState(
  state: MaterializedManifestState,
  manifest: Manifest,
  providerLabel: string,
  writer: RemoteManifestWriter,
  resolvePath: RemoteSandboxPathResolver,
  options: ManifestMaterializationOptions = {},
  preparedTransition?: PreparedMaterializedManifestTransition,
): Promise<void> {
  const sourceManifest = mergeManifestDelta(state.manifest, manifest);
  await applyMaterializedManifestToState(
    state,
    manifest,
    providerLabel,
    writer,
    resolvePath,
    materializeLocalSourceManifestEntry,
    {
      ...options,
      localSourceGrants: sourceManifest.extraPathGrants,
    },
    preparedTransition,
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
    {
      ...options,
      localSourceGrants: manifest.extraPathGrants,
    },
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
        await readLocalSourceFile(
          resolveLocalSourcePath('local_file', entry.src, options),
        ),
      );
      break;
    case 'local_dir':
      await materializeLocalDirectory(
        writer,
        absolutePath,
        resolveLocalSourcePath('local_dir', entry.src, options),
        options,
      );
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

function resolveLocalSourcePath(
  entryType: 'local_dir' | 'local_file',
  sourcePath: string,
  options: ManifestMaterializationOptions,
): string {
  const base = resolve(options.localSourceBaseDir ?? process.cwd());
  const resolvedSourcePath = resolve(base, sourcePath);
  if (
    isHostPathWithinRoot(base, resolvedSourcePath) ||
    (options.localSourceGrants ?? []).some((grant) =>
      isHostPathWithinRoot(
        resolve(sandboxPathGrantHostPath(grant)),
        resolvedSourcePath,
      ),
    )
  ) {
    return resolvedSourcePath;
  }

  throw new UserError(
    `${entryType} source must stay within the local source base directory or manifest.extraPathGrants: ${resolvedSourcePath} (base: ${base})`,
  );
}

async function materializeLocalDirectory(
  writer: RemoteManifestWriter,
  absolutePath: string,
  sourceDir: string,
  options: ManifestMaterializationOptions,
): Promise<void> {
  await runLimited(
    walkLocalDirectory(writer, absolutePath, sourceDir),
    resolveLocalDirFileConcurrency(options.concurrencyLimits),
    async ({ content, destinationPath }) => {
      await writer.writeFile(destinationPath, await content);
    },
  );
}

async function* walkLocalDirectory(
  writer: RemoteManifestWriter,
  absolutePath: string,
  sourceDir: string,
): AsyncGenerator<{ content: Promise<Uint8Array>; destinationPath: string }> {
  const source = await openLocalSourceDirectory(sourceDir);
  try {
    yield* walkOpenedLocalDirectory(writer, absolutePath, source, sourceDir);
  } finally {
    await source.close();
  }
}

async function* walkOpenedLocalDirectory(
  writer: RemoteManifestWriter,
  absolutePath: string,
  source: Awaited<ReturnType<typeof openLocalSourceDirectory>>,
  sourcePath: string,
): AsyncGenerator<{ content: Promise<Uint8Array>; destinationPath: string }> {
  const pendingReads = new Set<Promise<Uint8Array>>();
  try {
    await writer.mkdir(absolutePath);
    for (const entry of await source.entries()) {
      const destinationPath = `${absolutePath}/${entry.name}`;
      if (entry.type === 'directory') {
        const child = await source.openDirectory(entry.name);
        try {
          yield* walkOpenedLocalDirectory(
            writer,
            destinationPath,
            child,
            join(sourcePath, entry.name),
          );
        } finally {
          await child.close();
        }
      } else if (entry.type === 'file') {
        // Begin acquisition while the directory is retained. The backend queues
        // close after acquisitions and owns each opened file until its read ends.
        const content = source.readFile(entry.name);
        pendingReads.add(content);
        // A sibling failure can make runLimited discard an awaited iterator
        // result. Observe every read here, including results no worker accepts.
        void content.then(
          () => pendingReads.delete(content),
          () => pendingReads.delete(content),
        );
        yield { content, destinationPath };
      } else if (entry.type === 'symlink') {
        throw new UserError(
          `local_dir entries do not support symbolic links: ${join(sourcePath, entry.name)}`,
        );
      }
    }
  } finally {
    // Iterator cancellation joins source work before its directory is closed.
    await Promise.allSettled(pendingReads);
  }
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
  cloneArgs.push('--', repositoryUrl, destination);
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
