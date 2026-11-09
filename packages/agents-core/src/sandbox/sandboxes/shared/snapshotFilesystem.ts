import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { UserError } from '../../../errors';
import {
  isHostPathWithinRoot,
  relativeHostPathEscapesRoot,
} from '../../shared/hostPath';

const SNAPSHOT_FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const SNAPSHOT_FILE_WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW;

export async function clearDirectory(destinationRoot: string): Promise<void> {
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationRoot);
  const entries = await readdir(destinationRoot);
  await Promise.all(
    entries.map(async (entry) => {
      await rm(join(destinationRoot, entry), { recursive: true, force: true });
    }),
  );
}

export function shouldSkipSnapshotPath(
  relativePath: string,
  excludedLogicalPaths: Set<string>,
): boolean {
  for (const excluded of excludedLogicalPaths) {
    if (
      excluded === '' ||
      relativePath === excluded ||
      relativePath.startsWith(`${excluded}/`)
    ) {
      return true;
    }
  }
  return false;
}

export async function readStableSnapshotDirectoryEntries(
  sourceRoot: string,
  expectedSourceStats?: Stats,
): Promise<Array<Dirent<string>>> {
  const sourceStats = await lstat(sourceRoot);
  if (
    !sourceStats.isDirectory() ||
    (expectedSourceStats &&
      !sameFilesystemEntry(sourceStats, expectedSourceStats))
  ) {
    throw snapshotPathChangedError(sourceRoot);
  }

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  await assertStableSnapshotDirectory(sourceRoot, sourceStats);
  return entries;
}

async function assertStableSnapshotDirectory(
  sourceRoot: string,
  expectedSourceStats: Stats,
): Promise<void> {
  const sourceStats = await lstat(sourceRoot);
  if (
    !sourceStats.isDirectory() ||
    !sameFilesystemEntry(sourceStats, expectedSourceStats)
  ) {
    throw snapshotPathChangedError(sourceRoot);
  }
}

export async function readStableSnapshotFile(
  sourcePath: string,
  expectedSourceStats: Stats,
): Promise<Uint8Array> {
  const sourceStats = await lstat(sourcePath);
  if (
    !sourceStats.isFile() ||
    !sameFilesystemEntry(sourceStats, expectedSourceStats)
  ) {
    throw snapshotPathChangedError(sourcePath);
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sourcePath, SNAPSHOT_FILE_READ_FLAGS);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw snapshotPathChangedError(sourcePath);
    }
    throw error;
  }
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      !sameFilesystemEntry(openedStats, sourceStats)
    ) {
      throw snapshotPathChangedError(sourcePath);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function writeStableSnapshotFile(
  destinationRoot: string,
  destinationPath: string,
  content: Uint8Array,
  mode?: number,
): Promise<void> {
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationPath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(destinationPath, SNAPSHOT_FILE_WRITE_FLAGS, mode);
  } catch (error) {
    if (isPathChangedError(error)) {
      throw snapshotPathChangedError(destinationPath);
    }
    throw error;
  }
  try {
    await handle.writeFile(content);
    if (mode !== undefined) {
      await handle.chmod(mode);
    }
  } finally {
    await handle.close();
  }
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationPath);
}

export async function assertSafeSnapshotDestinationPath(
  destinationRoot: string,
  destinationPath: string,
): Promise<void> {
  const rootStats = await lstat(destinationRoot).catch(() => undefined);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw snapshotPathChangedError(destinationRoot);
  }

  const rootRealPath = await realpath(destinationRoot).catch(() => {
    throw snapshotPathChangedError(destinationRoot);
  });
  const relativeDestination = relative(destinationRoot, destinationPath);
  if (relativeHostPathEscapesRoot(relativeDestination)) {
    throw snapshotPathChangedError(destinationPath);
  }
  if (relativeDestination === '') {
    return;
  }

  let current = destinationRoot;
  for (const segment of relativeDestination.split(sep)) {
    if (!segment) {
      continue;
    }
    current = join(current, segment);
    const currentStats = await lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (!currentStats) {
      return;
    }
    if (currentStats.isSymbolicLink()) {
      throw snapshotPathChangedError(current);
    }

    const currentRealPath = await realpath(current).catch(() => {
      throw snapshotPathChangedError(current);
    });
    if (!isHostPathWithinRoot(rootRealPath, currentRealPath)) {
      throw snapshotPathChangedError(current);
    }
  }
}

function snapshotPathChangedError(path: string): UserError {
  return new UserError(`Sandbox snapshot path changed while copying: ${path}`);
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
