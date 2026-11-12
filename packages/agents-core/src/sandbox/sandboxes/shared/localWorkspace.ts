import {
  beforeGitRepoCopy,
  type BeforeGitRepoCopy,
} from '../../internal/gitRepoCopy';
import { UserError } from '../../../errors';
import {
  openLocalSourceDirectory,
  readLocalSourceDirectory,
  readLocalSourceFile,
  readLocalSourceFileAt,
  readLocalSourceEntriesAt,
} from '../../shared/localSourceReader';
import type { NativeSourceEntry } from '../../shared/localSourceTypes';
import { SandboxUnsupportedFeatureError } from '../../errors';
import type { SandboxConcurrencyLimits } from '../../client';
import type {
  Dir,
  Entry,
  File,
  GitRepo,
  LocalDir,
  LocalFile,
  Mount,
  TypedMount,
} from '../../entries';
import { isMount } from '../../entries';
import { Manifest, normalizeRelativePath } from '../../manifest';
import { validateMountCredentialBoundaries } from '../../mountSecurity';
import type { SandboxPathGrant } from '../../pathGrants';
import { permissionsForSandboxEntry } from '../../permissions';
import { WorkspacePathPolicy } from '../../workspacePaths';
import { formatSandboxProcessError, runSandboxProcess } from './runProcess';
import type { SandboxProcessResult } from './runProcess';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { tmpdir } from 'node:os';
import {
  isHostPathWithinRoot,
  isHostPathStrictlyWithinRoot,
  relativeHostPathEscapesRoot,
  sandboxPathGrantHostPath,
} from '../../shared/hostPath';
import { isSandboxPathNotFoundError } from '../../shared/pathProbe';

const GIT_VERSION_TIMEOUT_MS = 10_000;
const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
const COMMIT_REF_PATTERN = /^[0-9a-fA-F]{7,40}$/;
const MATERIALIZATION_FILE_WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW;
const LOCAL_SOURCE_FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const LOCAL_SOURCE_DIRECTORY_READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;

type MaterializeLocalWorkspaceOptions = {
  [beforeGitRepoCopy]?: BeforeGitRepoCopy;
  concurrencyLimits?: SandboxConcurrencyLimits;
  manifestRoot?: string;
  localSourceBaseDir?: string;
  localSourceGrants?: SandboxPathGrant[];
  allowLocalBindMounts?: boolean;
  allowIdentityMetadata?: boolean;
  supportsMount?: (entry: Mount | TypedMount) => boolean;
  materializeMount?: (args: {
    logicalPath: string;
    entry: Mount | TypedMount;
  }) => Promise<void>;
};

type MaterializeEntriesOptions = MaterializeLocalWorkspaceOptions & {
  skipMountEntries?: boolean;
};

type LocalWorkspaceManifestMetadataOptions = {
  allowLocalBindMounts?: boolean;
  allowIdentityMetadata?: boolean;
  supportsMount?: (entry: Mount | TypedMount) => boolean;
};

export async function materializeLocalWorkspaceManifest(
  manifest: Manifest,
  workspaceRootPath: string,
  options: MaterializeLocalWorkspaceOptions = {},
): Promise<void> {
  validateMountCredentialBoundaries(manifest);
  assertLocalWorkspaceManifestMetadataSupported(
    'Local sandbox materialization',
    manifest,
    {
      supportsMount: options.supportsMount,
      allowLocalBindMounts: options.allowLocalBindMounts,
      allowIdentityMetadata: options.allowIdentityMetadata,
    },
  );
  await mkdir(workspaceRootPath, { recursive: true });
  await materializeEntries(workspaceRootPath, manifest.entries, '', {
    ...options,
    manifestRoot: manifest.root,
    localSourceGrants: manifest.extraPathGrants,
    skipMountEntries: true,
  });
  await materializeLocalWorkspaceManifestMounts(
    manifest,
    workspaceRootPath,
    options,
  );
}

export function assertLocalWorkspaceManifestMetadataSupported(
  providerName: string,
  manifest: Manifest,
  options: LocalWorkspaceManifestMetadataOptions = {},
): void {
  if (!options.allowIdentityMetadata && manifest.users.length > 0) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support manifest users yet.`,
    );
  }
  if (!options.allowIdentityMetadata && manifest.groups.length > 0) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support manifest groups yet.`,
    );
  }

  for (const [logicalPath, entry] of Object.entries(manifest.entries)) {
    assertLocalWorkspaceEntryMetadataSupported(
      providerName,
      logicalPath,
      entry,
      options,
    );
  }
}

export async function materializeLocalWorkspaceManifestEntry(
  workspaceRootPath: string,
  logicalPath: string,
  entry: Entry,
  options: MaterializeLocalWorkspaceOptions = {},
): Promise<void> {
  assertLocalWorkspaceEntryMetadataSupported(
    'Local sandbox materialization',
    logicalPath,
    entry,
    {
      supportsMount: options.supportsMount,
      allowLocalBindMounts: options.allowLocalBindMounts,
      allowIdentityMetadata: options.allowIdentityMetadata,
    },
  );
  if (isMount(entry)) {
    if (options.materializeMount) {
      await options.materializeMount({ logicalPath, entry });
      return;
    }
    await materializeLocalBindMountEntry(
      workspaceRootPath,
      logicalPath,
      entry,
      options,
    );
    return;
  }
  const destination = logicalPath
    ? resolve(workspaceRootPath, logicalPath)
    : workspaceRootPath;

  switch (entry.type) {
    case 'dir':
      await materializeDirEntry(
        workspaceRootPath,
        destination,
        entry,
        logicalPath,
        options,
      );
      break;
    case 'file':
      await materializeFileEntry(
        workspaceRootPath,
        destination,
        entry,
        logicalPath,
      );
      break;
    case 'local_file':
      await materializeLocalFileEntry(
        workspaceRootPath,
        destination,
        entry,
        logicalPath,
        options,
      );
      break;
    case 'local_dir':
      await materializeLocalDirEntry(
        workspaceRootPath,
        destination,
        entry,
        logicalPath,
        options,
      );
      break;
    case 'git_repo':
      await materializeGitRepoEntry(
        workspaceRootPath,
        destination,
        entry,
        logicalPath,
        options[beforeGitRepoCopy],
      );
      break;
    default:
      throw new UserError(
        `Unsupported sandbox entry type: ${(entry as Entry).type}`,
      );
  }

  await applyEntryPermissions(
    workspaceRootPath,
    destination,
    entry,
    logicalPath,
  );
}

export async function materializeLocalWorkspaceManifestMounts(
  manifest: Manifest,
  workspaceRootPath: string,
  options: MaterializeLocalWorkspaceOptions = {},
): Promise<void> {
  validateMountCredentialBoundaries(manifest);
  assertLocalWorkspaceManifestMetadataSupported(
    'Local sandbox materialization',
    manifest,
    {
      supportsMount: options.supportsMount,
      allowLocalBindMounts: options.allowLocalBindMounts,
      allowIdentityMetadata: options.allowIdentityMetadata,
    },
  );
  for (const {
    logicalPath,
    entry,
  } of manifest.mountTargetsForMaterialization()) {
    await materializeLocalWorkspaceManifestEntry(
      workspaceRootPath,
      logicalPath,
      entry,
      {
        ...options,
        manifestRoot: manifest.root,
        localSourceGrants: manifest.extraPathGrants,
      },
    );
  }
}

/** Reapply manifest sticky intent without replacing snapshot contents or modes. */
export async function restoreLocalWorkspaceManifestStickyPermissions(
  manifest: Manifest,
  workspaceRootPath: string,
): Promise<void> {
  for (const { logicalPath, entry } of manifest.iterEntries()) {
    if (
      isMount(entry) ||
      !permissionsForSandboxEntry(entry.permissions).sticky
    ) {
      continue;
    }
    const destination = resolve(workspaceRootPath, logicalPath);
    const info = await lstat(destination).catch((error: unknown) => {
      // A snapshot may have replaced a manifest ancestor with a file.
      if (
        isSandboxPathNotFoundError(error) ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR'
      ) {
        return null;
      }
      throw error;
    });
    if (info?.isDirectory()) {
      await assertSafeMaterializationPath(
        workspaceRootPath,
        destination,
        logicalPath,
      );
      const handle = await open(destination, LOCAL_SOURCE_DIRECTORY_READ_FLAGS);
      try {
        const openedInfo = await handle.stat();
        if (
          !openedInfo.isDirectory() ||
          !sameFilesystemEntry(info, openedInfo)
        ) {
          throw new UserError(
            `Sandbox sticky permission target changed during restore: ${logicalPath || '.'}`,
          );
        }
        await handle.chmod((openedInfo.mode & 0o7777) | 0o1000);
      } finally {
        await handle.close();
      }
    }
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (!isSandboxPathNotFoundError(error)) {
      throw error;
    }
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (probeError) {
      if (isSandboxPathNotFoundError(probeError)) {
        return false;
      }
      throw probeError;
    }
    if (info.isSymbolicLink()) {
      try {
        await stat(path);
        return true;
      } catch (retryError) {
        if (isSandboxPathNotFoundError(retryError)) {
          return false;
        }
        throw retryError;
      }
    }
    return true;
  }
}

export function joinSandboxLogicalPath(
  root: string,
  logicalPath: string,
): string {
  if (!logicalPath) {
    return root;
  }
  return root === '/' ? `/${logicalPath}` : `${root}/${logicalPath}`;
}

function assertLocalWorkspaceEntryMetadataSupported(
  providerName: string,
  logicalPath: string,
  entry: Entry,
  options: LocalWorkspaceManifestMetadataOptions = {},
): void {
  const displayPath = logicalPath || '.';
  if (isMount(entry)) {
    if (
      options.supportsMount?.(entry) ||
      (options.allowLocalBindMounts !== false &&
        isSupportedLocalBindMount(entry))
    ) {
      return;
    }
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support this mount entry: ${displayPath}`,
    );
  }
  if (entry.group !== undefined) {
    throw new SandboxUnsupportedFeatureError(
      `${providerName} does not support sandbox entry group ownership yet: ${displayPath}`,
    );
  }

  if (entry.type !== 'dir' || !entry.children) {
    return;
  }

  for (const [childPath, childEntry] of Object.entries(entry.children)) {
    assertLocalWorkspaceEntryMetadataSupported(
      providerName,
      joinLogicalPath(logicalPath, childPath),
      childEntry,
      options,
    );
  }
}

async function materializeEntries(
  workspaceRootPath: string,
  entries: Record<string, Entry>,
  prefix: string = '',
  options: MaterializeEntriesOptions = {},
): Promise<void> {
  await runLimited(
    Object.entries(entries),
    resolveManifestEntryConcurrency(options.concurrencyLimits),
    async ([path, entry]) => {
      if (options.skipMountEntries && isMount(entry)) {
        return;
      }
      const logicalPath = prefix
        ? `${prefix}/${normalizeRelativePath(path)}`
        : normalizeRelativePath(path);
      await materializeLocalWorkspaceManifestEntry(
        workspaceRootPath,
        logicalPath,
        entry,
        options,
      );
    },
  );
}

async function materializeLocalBindMountEntry(
  workspaceRootPath: string,
  logicalPath: string,
  entry: Mount | TypedMount,
  options: MaterializeLocalWorkspaceOptions,
): Promise<void> {
  if (!isSupportedLocalBindMount(entry)) {
    throw new SandboxUnsupportedFeatureError(
      `Local sandbox materialization only supports mount entries with an absolute source and localBindMountStrategy(): ${logicalPath || '.'}`,
    );
  }
  if (entry.readOnly !== false) {
    throw new SandboxUnsupportedFeatureError(
      `Local sandbox materialization cannot enforce read-only local bind mounts: ${logicalPath || '.'}`,
    );
  }

  // A local bind mount is implemented as a symlink, so read-only semantics cannot be
  // enforced by this materializer itself.
  const source = await realpath(entry.source).catch(() => {
    throw new UserError(
      `Local bind mount source does not exist: ${entry.source}`,
    );
  });
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory()) {
    throw new UserError(
      `Local bind mount source must be a directory: ${source}`,
    );
  }

  const mountLogicalPath = resolveMountLogicalPath(
    options.manifestRoot ?? '/workspace',
    logicalPath,
    entry.mountPath,
  );
  if (!mountLogicalPath) {
    throw new SandboxUnsupportedFeatureError(
      'Local sandbox materialization does not support mounting over the workspace root.',
    );
  }

  const destination = resolve(workspaceRootPath, mountLogicalPath);
  await createMaterializationParentDirectory(
    workspaceRootPath,
    destination,
    mountLogicalPath,
  );
  await rm(destination, { recursive: true, force: true });
  await symlink(source, destination, 'dir');
}

function isSupportedLocalBindMount(
  entry: Mount | TypedMount,
): entry is Mount & { source: string } {
  return (
    entry.type === 'mount' &&
    typeof entry.source === 'string' &&
    isAbsolute(entry.source) &&
    (entry.mountStrategy === undefined ||
      entry.mountStrategy.type === 'local_bind')
  );
}

function resolveMountLogicalPath(
  root: string,
  logicalPath: string,
  mountPath?: string,
): string {
  if (mountPath === undefined) {
    return normalizeRelativePath(logicalPath);
  }
  const resolved = new WorkspacePathPolicy({ root }).resolve(mountPath, {
    forWrite: true,
  });
  if (typeof resolved.workspaceRelativePath !== 'string') {
    throw new UserError(
      `Mount path "${mountPath}" escapes the workspace root.`,
    );
  }
  return normalizeRelativePath(resolved.workspaceRelativePath);
}

async function createMaterializationDirectory(
  workspaceRootPath: string,
  destination: string,
  logicalPath: string,
): Promise<void> {
  await assertSafeMaterializationPath(
    workspaceRootPath,
    destination,
    logicalPath,
  );
  await mkdir(destination, { recursive: true });
  await assertSafeMaterializationPath(
    workspaceRootPath,
    destination,
    logicalPath,
  );
}

async function createMaterializationParentDirectory(
  workspaceRootPath: string,
  destination: string,
  logicalPath: string,
): Promise<void> {
  const parent = dirname(destination);
  await assertSafeMaterializationPath(workspaceRootPath, parent, logicalPath);
  await mkdir(parent, { recursive: true });
  await assertSafeMaterializationPath(workspaceRootPath, parent, logicalPath);
  await assertSafeMaterializationPath(
    workspaceRootPath,
    destination,
    logicalPath,
  );
}

async function assertSafeMaterializationPath(
  workspaceRootPath: string,
  destination: string,
  logicalPath: string,
): Promise<void> {
  // Check after directory creation and again before writes so a concurrent symlink swap
  // cannot redirect manifest materialization outside the workspace root.
  const workspaceRootRealPath = await realpath(workspaceRootPath).catch(() => {
    throw materializationEscapesWorkspaceError(logicalPath);
  });
  const relativeDestination = relative(workspaceRootPath, destination);
  if (relativeHostPathEscapesRoot(relativeDestination)) {
    throw materializationEscapesWorkspaceError(logicalPath);
  }
  if (relativeDestination === '') {
    return;
  }

  let current = workspaceRootPath;
  for (const segment of relativeDestination.split(sep)) {
    if (!segment) {
      continue;
    }
    current = join(current, segment);
    const info = await lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (!info) {
      return;
    }
    if (info.isSymbolicLink()) {
      throw new UserError(
        `Sandbox materialization path "${logicalPath || '.'}" escapes the workspace root through a symbolic link.`,
      );
    }

    const currentRealPath = await realpath(current).catch(() => {
      throw materializationEscapesWorkspaceError(logicalPath);
    });
    if (!isHostPathWithinRoot(workspaceRootRealPath, currentRealPath)) {
      throw materializationEscapesWorkspaceError(logicalPath);
    }
  }
}

async function materializeDirEntry(
  workspaceRootPath: string,
  destination: string,
  entry: Dir,
  logicalPath: string,
  options: MaterializeEntriesOptions,
): Promise<void> {
  await createMaterializationDirectory(
    workspaceRootPath,
    destination,
    logicalPath,
  );
  if (entry.children) {
    await materializeEntries(
      workspaceRootPath,
      entry.children,
      logicalPath,
      options,
    );
  }
}

async function materializeFileEntry(
  workspaceRootPath: string,
  destination: string,
  entry: File,
  logicalPath: string,
): Promise<void> {
  await createMaterializationParentDirectory(
    workspaceRootPath,
    destination,
    logicalPath,
  );
  await writeMaterializationFile(
    workspaceRootPath,
    destination,
    logicalPath,
    entry.content,
  );
}

async function materializeLocalFileEntry(
  workspaceRootPath: string,
  destination: string,
  entry: LocalFile,
  logicalPath: string,
  options: MaterializeLocalWorkspaceOptions,
): Promise<void> {
  await createMaterializationParentDirectory(
    workspaceRootPath,
    destination,
    logicalPath,
  );
  await writeMaterializationFile(
    workspaceRootPath,
    destination,
    logicalPath,
    await readLocalSourceFile(
      resolveLocalSourcePath('local_file', entry.src, options),
    ),
  );
}

async function materializeLocalDirEntry(
  workspaceRootPath: string,
  destination: string,
  entry: LocalDir,
  logicalPath: string,
  options: MaterializeLocalWorkspaceOptions,
): Promise<void> {
  await copyLocalDirectory(
    resolveLocalSourcePath('local_dir', entry.src, options),
    destination,
    options,
    workspaceRootPath,
    logicalPath,
  );
}

function resolveLocalSourcePath(
  entryType: 'local_dir' | 'local_file',
  sourcePath: string,
  options: MaterializeLocalWorkspaceOptions,
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

type LocalDirectoryContent =
  | { type: 'dir'; path: string }
  | { type: 'file'; path: string; content: Uint8Array };

export type LocalWorkspaceContent = (
  | { type: 'dir'; path: string; mustBeEmpty?: boolean }
  | { type: 'file'; path: string; content: Uint8Array }
  | {
      type: 'file';
      path: string;
      size: number;
      chunks: AsyncIterable<Uint8Array>;
    }
  | { type: 'symlink'; path: string; target: string }
) & { permissions?: number };

/** Read configured resources without opening any live workspace destination. */
export async function* readLocalWorkspaceEntry(
  entry: Entry,
  localSourceGrants: SandboxPathGrant[],
  privateGitRoot: string | undefined,
  beforeCopy?: BeforeGitRepoCopy,
): AsyncGenerator<LocalWorkspaceContent> {
  assertLocalWorkspaceEntryMetadataSupported(
    'Local sandbox materialization',
    '',
    entry,
    { allowLocalBindMounts: false },
  );
  yield* readLocalWorkspaceEntryContents(
    entry,
    '',
    localSourceGrants,
    privateGitRoot,
    beforeCopy,
  );
}

async function* readLocalWorkspaceEntryContents(
  entry: Entry,
  path: string,
  localSourceGrants: SandboxPathGrant[],
  privateGitRoot: string | undefined,
  beforeCopy?: BeforeGitRepoCopy,
): AsyncGenerator<LocalWorkspaceContent> {
  const permissions =
    permissionsForSandboxEntry(entry.permissions).toMode() & 0o1777;
  switch (entry.type) {
    case 'dir':
      yield { type: 'dir', path, permissions };
      for (const [childPath, child] of Object.entries(entry.children ?? {})) {
        yield* readLocalWorkspaceEntryContents(
          child,
          posix.join(path, normalizeRelativePath(childPath)),
          localSourceGrants,
          privateGitRoot,
        );
      }
      return;
    case 'file':
      yield {
        type: 'file',
        path,
        permissions,
        content: Buffer.from(entry.content),
      };
      return;
    case 'local_file':
      yield {
        type: 'file',
        path,
        permissions,
        content: await readLocalSourceFile(
          resolveLocalSourcePath('local_file', entry.src, {
            localSourceGrants,
          }),
        ),
      };
      return;
    case 'local_dir':
      for await (const item of readLocalDirectoryContents(
        resolveLocalSourcePath('local_dir', entry.src, { localSourceGrants }),
        '',
      )) {
        yield {
          ...item,
          path: posix.join(path, item.path),
          ...(item.path === '' ? { permissions } : {}),
        };
      }
      return;
    case 'git_repo': {
      if (privateGitRoot === undefined) {
        throw new UserError(
          'Git resources require a private temporary directory.',
        );
      }
      await assertGitAvailable();
      const temporary = await mkdtemp(join(privateGitRoot, 'checkout-'));
      try {
        const { result, commitFetchError } = await cloneGitRepo(
          normalizeGitRepository(entry),
          temporary,
          entry.ref,
        );
        if (result.status !== 0) {
          throw new UserError(
            `Failed to materialize git_repo entry ${entry.repo}: ${formatSandboxProcessError(commitFetchError ?? result)}`,
          );
        }
        const source = await resolveGitRepoSource(temporary, entry);
        const copiesTree = gitRepoCopiesTree(entry);
        const info = await lstat(source);
        if (beforeCopy && !info.isDirectory())
          throw new UserError('Eager skill sources require a directory.');
        if (copiesTree && info.isFile()) {
          yield {
            type: 'file',
            path,
            permissions,
            content: await readFile(source),
          };
          return;
        }
        if (!info.isDirectory()) {
          throw new UserError(
            `git_repo subpath must resolve to a file or directory: ${entry.subpath}`,
          );
        }
        if (beforeCopy) await prepareGitRepoCopy(source, beforeCopy);
        // SHA/subpath copies retain existing target modes; direct clones retain Git modes.
        const contents = copiesTree
          ? readLocalDirectoryContents(source, '')
          : readClonedGitContent(source, '');
        for await (const item of contents) {
          yield {
            ...item,
            path: posix.join(path, item.path),
            ...(item.path === '' ? { permissions } : {}),
            ...(item.path === '' && item.type === 'dir' && !copiesTree
              ? { mustBeEmpty: true }
              : {}),
          };
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      return;
    }
    default:
      throw new SandboxUnsupportedFeatureError(
        'Mount entries must be configured through the sandbox mount APIs.',
      );
  }
}

async function* readClonedGitContent(
  source: string,
  path: string,
): AsyncGenerator<LocalWorkspaceContent> {
  const info = await lstat(source);
  const permissions = info.mode & 0o1777;
  if (info.isSymbolicLink()) {
    yield { type: 'symlink', path, target: await readlink(source) };
  } else if (info.isFile()) {
    const handle = await open(source, LOCAL_SOURCE_FILE_READ_FLAGS);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFilesystemEntry(opened, info)) {
        throw new UserError('git_repo file changed while materializing.');
      }
      yield {
        type: 'file',
        path,
        permissions,
        size: opened.size,
        chunks: readClonedGitFileChunks(handle, opened.size),
      };
    } finally {
      await handle.close();
    }
  } else if (info.isDirectory()) {
    yield { type: 'dir', path, permissions };
    for (const child of await readdir(source, { withFileTypes: true })) {
      yield* readClonedGitContent(
        join(source, child.name),
        posix.join(path, child.name),
      );
    }
  }
}

async function* readClonedGitFileChunks(
  handle: Awaited<ReturnType<typeof open>>,
  remaining: number,
): AsyncGenerator<Uint8Array> {
  while (remaining > 0) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      throw new UserError('git_repo file changed while materializing.');
    }
    remaining -= bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

async function* readLocalDirectoryContents(
  sourceDir: string,
  relativePath: string,
): AsyncGenerator<LocalDirectoryContent> {
  for await (const item of readLocalSourceDirectory(sourceDir)) {
    yield {
      ...item,
      path: relativePath ? posix.join(relativePath, item.path) : item.path,
    };
  }
}

async function copyLocalDirectory(
  sourceDir: string,
  destination: string,
  options: MaterializeLocalWorkspaceOptions,
  workspaceRootPath: string,
  logicalPath: string,
): Promise<void> {
  const directory = await openLocalSourceDirectory(sourceDir);
  const queue: { parent: readonly string[]; entry: NativeSourceEntry }[] = [
    { parent: [], entry: { name: '', type: 'directory' } },
  ];
  let failed = false;
  let failure: unknown;
  try {
    const limit = resolveLocalDirEntryConcurrency(options.concurrencyLimits);
    const work = async ({ parent, entry }: (typeof queue)[number]) => {
      const components = entry.name ? [...parent, entry.name] : parent;
      const destinationPath = join(destination, ...components);
      const childLogicalPath = components.reduce(joinLogicalPath, logicalPath);
      if (entry.type === 'directory') {
        await createMaterializationDirectory(
          workspaceRootPath,
          destinationPath,
          childLogicalPath,
        );
        if (failed) return;
        const children = await readLocalSourceEntriesAt(directory, components);
        if (failed) return;
        for (let index = children.length - 1; index >= 0; index--) {
          queue.push({ parent: components, entry: children[index] });
        }
      } else if (entry.type === 'file') {
        await writeMaterializationFile(
          workspaceRootPath,
          destinationPath,
          childLogicalPath,
          await readLocalSourceFileAt(directory, components),
        );
      } else if (entry.type === 'symlink') {
        throw new UserError(
          `local_dir entries do not support symbolic links: ${entry.name}`,
        );
      }
    };
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      const finish = () => {
        active--;
        pump();
      };
      const pump = () => {
        while (!failed && active < limit && queue.length > 0) {
          const item = queue.pop()!;
          active++;
          void work(item).then(finish, (error) => {
            if (!failed) {
              failed = true;
              failure = error;
            }
            finish();
          });
        }
        // Workers publish children only after their parent destination exists.
        // Failure stops dequeues, but every started directory/file still joins.
        if (active === 0) {
          if (failed) reject(failure);
          else resolve();
        }
      };
      pump();
    });
  } finally {
    await directory.close();
  }
}

async function writeMaterializationFile(
  workspaceRootPath: string,
  destination: string,
  logicalPath: string,
  content: string | Uint8Array,
): Promise<void> {
  await assertSafeMaterializationPath(
    workspaceRootPath,
    destination,
    logicalPath,
  );

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(destination, MATERIALIZATION_FILE_WRITE_FLAGS);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw materializationEscapesWorkspaceError(logicalPath);
    }
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }

  await assertSafeMaterializationPath(
    workspaceRootPath,
    destination,
    logicalPath,
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

async function prepareGitRepoCopy(
  source: string,
  beforeCopy: BeforeGitRepoCopy,
): Promise<void> {
  const directory = await openLocalSourceDirectory(source);
  try {
    const entries = await readLocalSourceEntriesAt(directory, []);
    if (entries.some(({ type }) => type !== 'directory' && type !== 'file'))
      throw new UserError('Skill trees require regular files and directories.');
    await beforeCopy(
      entries.map(({ name }) => name),
      entries.filter(({ type }) => type === 'file').map(({ name }) => name),
    );
  } finally {
    await directory.close();
  }
}

export function gitRepoCopiesTree(entry: GitRepo): boolean {
  return Boolean(entry.subpath || (entry.ref && looksLikeCommitRef(entry.ref)));
}

async function materializeGitRepoEntry(
  workspaceRootPath: string,
  destination: string,
  entry: GitRepo,
  logicalPath: string,
  beforeCopy?: BeforeGitRepoCopy,
): Promise<void> {
  await assertGitAvailable();

  const repository = normalizeGitRepository(entry);
  const cloneIntoTemporaryDirectory = gitRepoCopiesTree(entry);
  const cloneDestination = cloneIntoTemporaryDirectory
    ? await mkdtemp(join(tmpdir(), 'openai-agents-git-repo-'))
    : destination;
  try {
    if (cloneIntoTemporaryDirectory) {
      await mkdir(dirname(cloneDestination), { recursive: true });
    } else {
      await createMaterializationParentDirectory(
        workspaceRootPath,
        cloneDestination,
        logicalPath,
      );
    }
    const { result: cloneResult, commitFetchError } = await cloneGitRepo(
      repository,
      cloneDestination,
      entry.ref,
    );
    if (cloneResult.status !== 0) {
      throw new UserError(
        `Failed to materialize git_repo entry ${entry.repo}: ${formatSandboxProcessError(commitFetchError ?? cloneResult)}`,
      );
    }
    if (!cloneIntoTemporaryDirectory) {
      await assertSafeMaterializationPath(
        workspaceRootPath,
        destination,
        logicalPath,
      );
      return;
    }

    const sourcePath = await resolveGitRepoSource(cloneDestination, entry);
    const sourceInfo = await lstat(sourcePath);
    if (beforeCopy && !sourceInfo.isDirectory())
      throw new UserError('Eager skill sources require a directory.');
    if (sourceInfo.isDirectory()) {
      if (beforeCopy) await prepareGitRepoCopy(sourcePath, beforeCopy);
      await copyLocalDirectory(
        sourcePath,
        destination,
        {},
        workspaceRootPath,
        logicalPath,
      );
      return;
    }
    if (sourceInfo.isFile()) {
      await createMaterializationParentDirectory(
        workspaceRootPath,
        destination,
        logicalPath,
      );
      await writeMaterializationFile(
        workspaceRootPath,
        destination,
        logicalPath,
        await readFile(sourcePath),
      );
      return;
    }
    throw new UserError(
      `git_repo subpath must resolve to a file or directory: ${entry.subpath}`,
    );
  } finally {
    if (cloneIntoTemporaryDirectory) {
      await rm(cloneDestination, { recursive: true, force: true });
    }
  }
}

async function resolveGitRepoSource(
  cloneRoot: string,
  entry: GitRepo,
): Promise<string> {
  const source = entry.subpath ? resolve(cloneRoot, entry.subpath) : cloneRoot;
  if (
    entry.subpath &&
    !isHostPathStrictlyWithinRoot(
      await realpath(cloneRoot),
      await realpath(source),
    )
  ) {
    throw new UserError(
      `git_repo subpath escapes the cloned repository: ${entry.subpath}`,
    );
  }
  return source;
}

async function assertGitAvailable(): Promise<void> {
  const gitVersion = await runSandboxProcess('git', ['--version'], {
    timeoutMs: GIT_VERSION_TIMEOUT_MS,
  });
  if (gitVersion.status !== 0) {
    throw new UserError(
      'git_repo entries require a local `git` executable, but `git` was not found.',
    );
  }
}

async function cloneGitRepo(
  repository: string,
  destination: string,
  ref: string | undefined,
): Promise<{
  result: SandboxProcessResult;
  commitFetchError?: SandboxProcessResult;
}> {
  if (!ref || !looksLikeCommitRef(ref)) {
    return { result: await cloneNamedRef(repository, destination, ref) };
  }

  // Branch/tag shallow clone does not reliably fetch arbitrary SHAs, so commit-looking
  // refs take the explicit init/fetch/checkout path first.
  const result = await fetchCommitRef(repository, destination, ref);
  if (result.status === 0) {
    return { result };
  }

  await rm(destination, { recursive: true, force: true });
  return {
    result: await cloneNamedRef(repository, destination, ref),
    commitFetchError: result,
  };
}

async function cloneNamedRef(
  repository: string,
  destination: string,
  ref: string | undefined,
): Promise<SandboxProcessResult> {
  const args = ['clone', '--depth', '1'];
  if (ref) {
    args.push('--branch', ref);
  }
  args.push('--', repository, destination);
  return await runSandboxProcess('git', args, {
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
  });
}

async function fetchCommitRef(
  repository: string,
  destination: string,
  ref: string,
): Promise<SandboxProcessResult> {
  const steps: string[][] = [
    ['init', destination],
    ['-C', destination, 'remote', 'add', 'origin', repository],
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

async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  if (limit <= 1) {
    for (const item of items) {
      await fn(item);
    }
    return;
  }

  let nextIndex = 0;
  let failed = false;
  // This intentionally stays as a tiny work queue rather than adding a dependency for
  // the few manifest and local_dir concurrency limits used here.
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      try {
        while (!failed && nextIndex < items.length) {
          const item = items[nextIndex++];
          await fn(item);
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  );
  try {
    await Promise.all(workers);
  } catch (error) {
    // Cleanup must wait for every writer, including nested materialization queues.
    await Promise.allSettled(workers);
    throw error;
  }
}

function resolveManifestEntryConcurrency(
  limits?: SandboxConcurrencyLimits,
): number {
  return normalizeConcurrencyLimit(limits?.manifestEntries, 4);
}

function resolveLocalDirEntryConcurrency(
  limits?: SandboxConcurrencyLimits,
): number {
  return normalizeConcurrencyLimit(limits?.localDirFiles, 4);
}

function normalizeConcurrencyLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new UserError('Sandbox concurrency limits must be positive numbers.');
  }

  return Math.floor(value);
}

function joinLogicalPath(parent: string, child: string): string {
  const normalizedChild = normalizeRelativePath(child);
  if (!parent || parent === '.') {
    return normalizedChild;
  }
  let parentEnd = parent.length;
  while (parentEnd > 0 && parent[parentEnd - 1] === '/') {
    parentEnd--;
  }
  return `${parent.slice(0, parentEnd)}/${normalizedChild}`;
}

async function applyEntryPermissions(
  workspaceRootPath: string,
  destination: string,
  entry: Entry,
  logicalPath: string,
): Promise<void> {
  await assertSafeMaterializationPath(
    workspaceRootPath,
    destination,
    logicalPath,
  );
  const permissions = permissionsForSandboxEntry(entry.permissions);
  await chmod(destination, permissions.toMode() & 0o1777);
}

function materializationEscapesWorkspaceError(logicalPath: string): UserError {
  return new UserError(
    `Sandbox materialization path "${logicalPath || '.'}" escapes the workspace root.`,
  );
}

function normalizeGitRepository(entry: GitRepo): string {
  const repository = entry.repo;
  if (!repository) {
    throw new UserError('git_repo entries require a repo.');
  }
  if (repository.includes('://') || repository.startsWith('git@')) {
    return repository;
  }

  return `https://${entry.host ?? 'github.com'}/${repository}.git`;
}
