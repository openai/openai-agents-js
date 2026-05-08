import { UserError } from '../../../errors';
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
import type { SandboxPathGrant } from '../../pathGrants';
import { permissionsForSandboxEntry } from '../../permissions';
import { WorkspacePathPolicy } from '../../workspacePaths';
import { formatSandboxProcessError, runSandboxProcess } from './runProcess';
import type { SandboxProcessResult } from './runProcess';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { constants, type Dirent, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isHostPathWithinRoot,
  isHostPathStrictlyWithinRoot,
  relativeHostPathEscapesRoot,
} from '../../shared/hostPath';

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

type StableLocalDirSource = {
  root: string;
  stat: Stats;
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

export async function applyOwnershipRecursive(
  targetPath: string,
  uid: number,
  gid: number,
): Promise<void> {
  const info = await lstat(targetPath).catch(() => null);
  if (!info) {
    return;
  }
  if (info.isSymbolicLink()) {
    return;
  }

  await chown(targetPath, uid, gid);
  if (!info.isDirectory()) {
    return;
  }

  const children = await readdir(targetPath);
  await Promise.all(
    children.map(async (child) => {
      await applyOwnershipRecursive(join(targetPath, child), uid, gid);
    }),
  );
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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
    await readStableLocalFile(
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
      isHostPathWithinRoot(resolve(grant.path), resolvedSourcePath),
    )
  ) {
    return resolvedSourcePath;
  }

  throw new UserError(
    `${entryType} source must stay within the local source base directory or manifest.extraPathGrants: ${resolvedSourcePath} (base: ${base})`,
  );
}

async function copyLocalDirectory(
  sourceDir: string,
  destination: string,
  options: MaterializeLocalWorkspaceOptions,
  workspaceRootPath: string,
  logicalPath: string,
  expectedSourceStat?: Stats,
): Promise<void> {
  const source = await resolveStableLocalDirSource(
    sourceDir,
    expectedSourceStat,
  );
  await createMaterializationDirectory(
    workspaceRootPath,
    destination,
    logicalPath,
  );
  const children = await readStableLocalDirEntries(sourceDir, source.stat);

  await runLimited(
    children,
    resolveLocalDirEntryConcurrency(options.concurrencyLimits),
    async (child) => {
      const sourcePath = join(sourceDir, child.name);
      const destinationPath = join(destination, child.name);
      const childLogicalPath = joinLogicalPath(logicalPath, child.name);

      if (child.isDirectory()) {
        const childSourceStat = await assertStableLocalDirChild(
          source.root,
          sourcePath,
        );
        await copyLocalDirectory(
          sourcePath,
          destinationPath,
          options,
          workspaceRootPath,
          childLogicalPath,
          childSourceStat,
        );
        return;
      }
      if (child.isFile()) {
        await writeMaterializationFile(
          workspaceRootPath,
          destinationPath,
          childLogicalPath,
          await readStableLocalDirFile(source.root, sourcePath),
        );
        return;
      }
      if (child.isSymbolicLink()) {
        throw new UserError(
          `local_dir entries do not support symbolic links: ${sourcePath}`,
        );
      }
    },
  );
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

async function resolveStableLocalDirSource(
  sourceDir: string,
  expectedSourceStat?: Stats,
): Promise<StableLocalDirSource> {
  await assertNoLocalSourceSymlinkAncestors(
    sourceDir,
    'local_dir',
    localDirPathChangedError,
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
    throw localDirPathChangedError(sourceDir);
  }

  const sourceRoot = await realpathStableLocalSourcePath(sourceDir);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sourceDir, LOCAL_SOURCE_DIRECTORY_READ_FLAGS);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw localDirPathChangedError(sourceDir);
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isDirectory() ||
      !sameFilesystemEntry(openedStat, sourceStat)
    ) {
      throw localDirPathChangedError(sourceDir);
    }
    return { root: sourceRoot, stat: openedStat };
  } finally {
    await handle.close();
  }
}

async function readStableLocalDirEntries(
  sourceDir: string,
  expectedStat: Stats,
): Promise<Array<Dirent<string>>> {
  let children: Array<Dirent<string>>;
  try {
    children = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (isPathChangedError(error)) {
      throw localDirPathChangedError(sourceDir);
    }
    throw error;
  }

  await assertStableLocalDirPath(sourceDir, expectedStat);
  return children;
}

async function assertStableLocalDirPath(
  sourcePath: string,
  expectedStat: Stats,
): Promise<void> {
  const currentStat = await statStableLocalSourcePath(sourcePath);
  if (
    currentStat.isSymbolicLink() ||
    !currentStat.isDirectory() ||
    !sameFilesystemEntry(currentStat, expectedStat)
  ) {
    throw localDirPathChangedError(sourcePath);
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
  pathChangedError: (path: string) => UserError,
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

async function readStableLocalDirFile(
  sourceRoot: string,
  sourcePath: string,
): Promise<Uint8Array> {
  const sourceStat = await statStableLocalSourcePath(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new UserError(
      `local_dir entries do not support symbolic links: ${sourcePath}`,
    );
  }
  if (!sourceStat.isFile()) {
    throw localDirPathChangedError(sourcePath);
  }

  const resolvedSourcePath = await realpathStableLocalSourcePath(sourcePath);
  if (!isHostPathStrictlyWithinRoot(sourceRoot, resolvedSourcePath)) {
    throw localDirPathChangedError(sourcePath);
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sourcePath, LOCAL_SOURCE_FILE_READ_FLAGS);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw localDirPathChangedError(sourcePath);
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFilesystemEntry(openedStat, sourceStat)) {
      throw localDirPathChangedError(sourcePath);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function statStableLocalSourcePath(
  sourcePath: string,
  pathChangedError: (
    sourcePath: string,
  ) => UserError = localDirPathChangedError,
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
  ) => UserError = localDirPathChangedError,
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

function localDirPathChangedError(sourcePath: string): UserError {
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

async function assertStableLocalDirChild(
  sourceRoot: string,
  sourcePath: string,
): Promise<Stats> {
  // local_dir deliberately rejects symlinks so a host-side source cannot smuggle
  // files outside the declared directory into the sandbox.
  const sourceStat = await statStableLocalSourcePath(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new UserError(
      `local_dir entries do not support symbolic links: ${sourcePath}`,
    );
  }
  if (!sourceStat.isDirectory()) {
    throw localDirPathChangedError(sourcePath);
  }

  const resolvedSourcePath = await realpathStableLocalSourcePath(sourcePath);
  if (!isHostPathStrictlyWithinRoot(sourceRoot, resolvedSourcePath)) {
    throw localDirPathChangedError(sourcePath);
  }

  return sourceStat;
}

function sameFilesystemEntry(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function materializeGitRepoEntry(
  workspaceRootPath: string,
  destination: string,
  entry: GitRepo,
  logicalPath: string,
): Promise<void> {
  const gitVersion = await runSandboxProcess('git', ['--version'], {
    timeoutMs: GIT_VERSION_TIMEOUT_MS,
  });
  if (gitVersion.status !== 0) {
    throw new UserError(
      'git_repo entries require a local `git` executable, but `git` was not found.',
    );
  }

  const repository = normalizeGitRepository(entry);
  const cloneIntoTemporaryDirectory =
    Boolean(entry.subpath) ||
    Boolean(entry.ref && looksLikeCommitRef(entry.ref));
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

    const sourcePath = entry.subpath
      ? resolve(cloneDestination, entry.subpath)
      : cloneDestination;
    if (entry.subpath) {
      const cloneRoot = await realpath(cloneDestination);
      const subpathRealpath = await realpath(sourcePath);
      if (!isHostPathStrictlyWithinRoot(cloneRoot, subpathRealpath)) {
        throw new UserError(
          `git_repo subpath escapes the cloned repository: ${entry.subpath}`,
        );
      }
    }
    const sourceInfo = await lstat(sourcePath);
    if (sourceInfo.isDirectory()) {
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
  args.push(repository, destination);
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
  // This intentionally stays as a tiny work queue rather than adding a dependency for
  // the few manifest and local_dir concurrency limits used here.
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
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
  return `${parent.replace(/\/+$/u, '')}/${normalizedChild}`;
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
  await chmod(destination, permissions.toMode() & 0o777);
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
