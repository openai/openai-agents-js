import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { UserError } from '../../../errors';
import {
  resolveSandboxArchiveLimits,
  type SandboxArchiveLimits,
} from '../../client';
import { SandboxArchiveError } from '../../errors';
import type { WorkspaceArchiveData } from '../../session';
import { isHostPathStrictlyWithinRoot } from '../../shared/hostPath';
import { isRecord } from '../../shared/typeGuards';
import {
  clearDirectory,
  shouldSkipSnapshotPath,
  readStableSnapshotDirectoryEntries,
  readStableSnapshotFile,
  writeStableSnapshotFile,
  assertSafeSnapshotDestinationPath,
} from './snapshotFilesystem';

type WorkspaceArchiveV1 = {
  version: 1;
  directories: string[];
  files: Array<{ path: string; data: string }>;
};

type ArchiveDestinations = {
  directories: string[];
  files: Array<{ destination: string; base64: string }>;
};

// A prepared archive is bound to the root whose native names and paths were checked.
type PreparedWorkspaceArchive = ArchiveDestinations & { root: string };

export async function createWorkspaceArchive(
  sourceRoot: string,
  excludedLogicalPaths: Set<string>,
): Promise<Uint8Array> {
  // Remote SnapshotStore is provider-agnostic, so its portable fallback is a small
  // JSON/base64 archive instead of relying on host tar availability.
  const archive: WorkspaceArchiveV1 = {
    version: 1,
    directories: [],
    files: [],
  };
  await appendWorkspaceArchiveEntries(
    archive,
    sourceRoot,
    excludedLogicalPaths,
  );
  return new TextEncoder().encode(JSON.stringify(archive));
}

async function appendWorkspaceArchiveEntries(
  archive: WorkspaceArchiveV1,
  sourceRoot: string,
  excludedLogicalPaths: Set<string>,
  currentRelativePath: string = '',
  expectedSourceStats?: Stats,
): Promise<void> {
  const entries = await readStableSnapshotDirectoryEntries(
    sourceRoot,
    expectedSourceStats,
  );
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = currentRelativePath
      ? `${currentRelativePath}/${entry.name}`
      : entry.name;
    if (shouldSkipSnapshotPath(relativePath, excludedLogicalPaths)) {
      continue;
    }

    const sourcePath = join(sourceRoot, entry.name);
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isDirectory()) {
      archive.directories.push(relativePath);
      await appendWorkspaceArchiveEntries(
        archive,
        sourcePath,
        excludedLogicalPaths,
        relativePath,
        sourceStats,
      );
      continue;
    }
    if (!sourceStats.isFile()) {
      continue;
    }

    archive.files.push({
      path: relativePath,
      data: Buffer.from(
        await readStableSnapshotFile(sourcePath, sourceStats),
      ).toString('base64'),
    });
  }
}

export async function restoreWorkspaceArchive(
  data: WorkspaceArchiveData,
  destinationRoot: string,
  options: { archiveLimits?: SandboxArchiveLimits | null } = {},
): Promise<void> {
  const archive = await prepareWorkspaceArchive(
    data,
    destinationRoot,
    options.archiveLimits,
  );
  await clearDirectory(archive.root);
  for (const directory of archive.directories) {
    await writeSafeArchiveDirectory(archive.root, directory);
  }
  for (const file of archive.files) {
    await writeSafeArchiveFile(archive.root, file.destination, file.base64);
  }
}

async function prepareWorkspaceArchive(
  data: WorkspaceArchiveData,
  destinationRoot: string,
  limits?: SandboxArchiveLimits | null,
): Promise<PreparedWorkspaceArchive> {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : workspaceArchiveDataToUint8Array(data);
  const archiveLimits = resolveSandboxArchiveLimits(limits);
  checkWorkspaceArchiveInputBytes(bytes.byteLength, archiveLimits);

  const archive = parseWorkspaceArchive(
    JSON.parse(new TextDecoder().decode(bytes)),
    destinationRoot,
    archiveLimits,
  );

  await mkdir(destinationRoot, { recursive: true });
  await validateWorkspaceArchiveTree(destinationRoot, archive);
  return { root: destinationRoot, ...archive };
}

function workspaceArchiveDataToUint8Array(
  data: ArrayBuffer | Uint8Array,
): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

function checkWorkspaceArchiveInputBytes(
  actual: number,
  limits: ReturnType<typeof resolveSandboxArchiveLimits>,
): void {
  const limit = limits?.maxInputBytes;
  if (limit != null && actual > limit) {
    throw new SandboxArchiveError(
      'Workspace archive input size exceeds limit.',
      {
        reason: 'archive input size exceeds limit',
        limit,
        actual,
      },
    );
  }
}

function parseWorkspaceArchive(
  archive: unknown,
  destinationRoot: string,
  limits: ReturnType<typeof resolveSandboxArchiveLimits>,
): ArchiveDestinations {
  if (!isRecord(archive) || archive.version !== 1) {
    throw new UserError('Unsupported remote snapshot archive version.');
  }
  if (!Array.isArray(archive.directories) || !Array.isArray(archive.files)) {
    throw new UserError('Invalid remote snapshot archive members.');
  }

  const parentSegment =
    sep === '/' ? /(?:^|\/)\.\.(?:\/|$)/u : /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
  let memberCount = 0;
  function memberPath(path: unknown, kind: 'file' | 'directory'): string {
    if (typeof path !== 'string') {
      throw new UserError('Invalid remote snapshot archive member path.');
    }
    memberCount += 1;
    checkWorkspaceArchiveMemberCount(memberCount, path, limits);
    // A directory's optional trailing separator must not lengthen the installation path.
    const destination = join(destinationRoot, path, '.');
    if (
      isAbsolute(path) ||
      path.includes('\0') ||
      parentSegment.test(path) ||
      (kind === 'file' && (path.endsWith('/') || path.endsWith(sep))) ||
      !isHostPathStrictlyWithinRoot(destinationRoot, destination)
    ) {
      throw new UserError(`Invalid remote snapshot archive path: ${path}`);
    }

    return destination;
  }

  const directories = archive.directories.map((path) =>
    memberPath(path, 'directory'),
  );
  let extractedBytes = 0;
  const files = archive.files.map((file: unknown) => {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      typeof file.data !== 'string'
    ) {
      throw new UserError('Invalid remote snapshot archive file.');
    }
    const path = memberPath(file.path, 'file');
    if (limits?.maxExtractedBytes != null) {
      extractedBytes += Buffer.byteLength(file.data, 'base64');
      checkWorkspaceArchiveExtractedBytes(extractedBytes, file.path, limits);
    }
    return { destination: path, base64: file.data };
  });
  return { directories, files };
}

type ArchiveMember = { path: string; offset: number; file: boolean };
type ProbedEntry = { name: string; children?: ArchiveMember[] };

async function validateWorkspaceArchiveTree(
  destinationRoot: string,
  archive: ArchiveDestinations,
): Promise<void> {
  if (!archive.files.length && !archive.directories.length) return;
  const members = [
    ...archive.directories.map((path) => ({
      path: relative(destinationRoot, path),
      offset: 0,
      file: false,
    })),
    ...archive.files.map(({ destination }) => ({
      path: relative(destinationRoot, destination),
      offset: 0,
      file: true,
    })),
  ];
  const groups = [{ members, prefixLength: 0 }];
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationRoot);
  const longest = members.reduce(
    (length, member) => Math.max(length, nativePathLength(member.path)),
    0,
  );
  const scratch = await createArchiveProbeDirectory(destinationRoot, longest);
  try {
    if (scratch)
      await checkArchivePathLength(destinationRoot, scratch, longest);
    let longestStored = 0;
    while (groups.length) {
      const { members, prefixLength } = groups.pop()!;
      let entries: ProbedEntry[];
      await assertSafeSnapshotDestinationPath(destinationRoot, destinationRoot);
      try {
        entries = await probeSiblingNames(scratch ?? destinationRoot, members);
      } catch (error) {
        if (
          !scratch ||
          (error as NodeJS.ErrnoException).code !== 'ENAMETOOLONG'
        )
          throw error;
        // Even one extra component can exceed PATH_MAX for a top-level name.
        // Use the granted directory itself and remove only markers we created.
        entries = await probeSiblingNames(destinationRoot, members);
      }
      for (const entry of entries) {
        const length = prefixLength + nativePathLength(entry.name);
        longestStored = Math.max(longestStored, length);
        if (entry.children?.length)
          groups.push({ members: entry.children, prefixLength: length + 1 });
      }
    }
    // An earlier directory spelling can occupy more bytes than its alias in a later file path.
    if (longestStored > longest) {
      if (!scratch)
        throw new UserError(
          'Workspace archive destination exceeds the pathname limit.',
        );
      await checkArchivePathLength(destinationRoot, scratch, longestStored);
    }
  } finally {
    if (scratch) await rmdir(scratch);
  }
}

async function probeSiblingNames(
  root: string,
  members: ArchiveMember[],
): Promise<ProbedEntry[]> {
  const aliases = new Map<string, ProbedEntry>();
  const names = new Map<string, ProbedEntry>();
  const created: string[] = [];
  async function probe(name: string, directory: boolean): Promise<ProbedEntry> {
    const path = join(root, name);
    let storedName = name;
    try {
      await mkdir(path, { mode: 0o700 });
      created.push(path);
      storedName = basename(await realpath(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const key = await archiveEntryKey(path);
    const existing = aliases.get(key);
    if (existing) return existing;
    const entry = { name: storedName, children: directory ? [] : undefined };
    aliases.set(key, entry);
    return entry;
  }
  try {
    // Process parents in installation order to retain the first native spelling.
    for (const member of members) {
      const end = member.path.indexOf(sep, member.offset);
      const name = member.path.slice(member.offset, end < 0 ? undefined : end);
      const directory = !member.file || end >= 0;
      let entry = names.get(name);
      if (!entry) {
        entry = await probe(name, directory);
        names.set(name, entry);
      }
      if (directory !== Boolean(entry.children))
        throw new UserError(
          `Conflicting remote snapshot archive path: ${name}`,
        );
      if (end >= 0) entry.children!.push({ ...member, offset: end + 1 });
    }
    return [...aliases.values()];
  } finally {
    for (const path of created) await rmdir(path);
  }
}

async function archiveEntryKey(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  // Existing hard links have separate names when the workspace is replaced.
  const id = `${info.dev}:${info.ino}`;
  if (info.isDirectory() || info.nlink === 1n) return id;
  const entries = await readdir(dirname(path));
  const name = basename(path);
  if (entries.includes(name)) return `${id}/${name}`;
  if (info.isFile()) {
    const canonical = basename(await realpath(path));
    if (entries.includes(canonical)) return `${id}/${canonical}`;
  }
  throw new UserError(
    `Cannot distinguish hard-linked workspace archive paths: ${name}`,
  );
}

function nativePathLength(path: string): number {
  return sep === '/' ? Buffer.byteLength(path) : path.length;
}

async function checkArchivePathLength(
  root: string,
  scratch: string,
  longest: number,
): Promise<void> {
  // Probe the longest complete pathname without resolving links in the old workspace.
  // The empty directory replaces the first part of the path, so the probe has
  // exactly the same native length as the destination even at the host limit.
  const remaining = longest - relative(root, scratch).length;
  if (remaining <= 0) return;
  const physical = await realpath(scratch);
  const prefix =
    nativePathLength(physical) > nativePathLength(scratch) ? physical : scratch;
  const suffix =
    (sep + 'x').repeat(Math.floor(remaining / 2)) + (remaining % 2 ? 'x' : '');
  try {
    await lstat(prefix + suffix);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function createArchiveProbeDirectory(
  root: string,
  longest: number,
): Promise<string | undefined> {
  // A single component keeps the probe usable even for deep workspace roots.
  for (let index = 0; ; index++) {
    const path = join(root, index.toString(36));
    try {
      await mkdir(path, { mode: 0o700 });
      return path;
    } catch (error) {
      // All shorter probe names already exist and fit at this root.
      if (
        (error as NodeJS.ErrnoException).code === 'ENAMETOOLONG' &&
        index.toString(36).length > longest
      )
        return undefined;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function checkWorkspaceArchiveMemberCount(
  actual: number,
  member: string,
  limits: ReturnType<typeof resolveSandboxArchiveLimits>,
): void {
  const limit = limits?.maxMembers;
  if (limit != null && actual > limit) {
    throw new SandboxArchiveError(
      'Workspace archive member count exceeds limit.',
      {
        reason: 'archive member count exceeds limit',
        limit,
        actual,
        member,
      },
    );
  }
}

function checkWorkspaceArchiveExtractedBytes(
  actual: number,
  member: string,
  limits: ReturnType<typeof resolveSandboxArchiveLimits>,
): void {
  const limit = limits?.maxExtractedBytes;
  if (limit != null && actual > limit) {
    throw new SandboxArchiveError(
      'Workspace archive extracted size exceeds limit.',
      {
        reason: 'archive extracted size exceeds limit',
        limit,
        actual,
        member,
      },
    );
  }
}

async function writeSafeArchiveDirectory(
  destinationRoot: string,
  destinationPath: string,
): Promise<void> {
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationPath);
  await mkdir(destinationPath, { recursive: true });
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationPath);
}

async function writeSafeArchiveFile(
  destinationRoot: string,
  destinationPath: string,
  base64Data: string,
): Promise<void> {
  await assertSafeSnapshotDestinationPath(
    destinationRoot,
    dirname(destinationPath),
  );
  await mkdir(dirname(destinationPath), { recursive: true });
  await assertSafeSnapshotDestinationPath(
    destinationRoot,
    dirname(destinationPath),
  );
  await writeStableSnapshotFile(
    destinationRoot,
    destinationPath,
    Buffer.from(base64Data, 'base64'),
  );
}
