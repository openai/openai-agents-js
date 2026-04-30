import { UserError } from '../../../errors';
import {
  isNoopSnapshotSpec,
  type RemoteSnapshot,
  type RemoteSnapshotSpec,
  type SnapshotSpec,
} from '../../snapshot';
import type {
  LocalSandboxSnapshot,
  LocalSandboxSnapshotSpec,
  LocalSnapshot,
  LocalSnapshotSpec,
} from '../types';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { constants, type Dirent, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import type { Manifest } from '../../manifest';
import type { WorkspaceArchiveData } from '../../session';
import { stableJsonStringify } from '../../shared/stableJson';
import { isRecord } from '../../shared/typeGuards';
import {
  isHostPathStrictlyWithinRoot,
  isHostPathWithinRoot,
  relativeHostPathEscapesRoot,
} from '../../shared/hostPath';
import { defaultLocalSnapshotBaseDir } from './localSnapshotPaths';
import { serializeManifest } from './manifestPersistence';

export const LOCAL_SNAPSHOT_FINGERPRINT_VERSION = 'workspace_tree_sha256_v1';
const SNAPSHOT_FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const SNAPSHOT_FILE_WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW;

export type LocalSnapshotFingerprint = {
  fingerprint: string;
  version: typeof LOCAL_SNAPSHOT_FINGERPRINT_VERSION;
};

type LocalSnapshotState = {
  workspaceRootPath: string;
  manifest: Manifest;
  snapshotSpec?: SnapshotSpec | null;
  snapshot?: LocalSandboxSnapshot | null;
  snapshotFingerprint?: string | null;
  snapshotFingerprintVersion?: string | null;
};

export async function createLocalSnapshot(
  state: LocalSnapshotState,
  spec?: LocalSnapshotSpec,
): Promise<LocalSnapshot> {
  const snapshotPath = await mkdtempForSnapshot(spec);
  await copyDirectory(
    state.workspaceRootPath,
    snapshotPath,
    state.manifest.ephemeralPersistencePaths(),
  );
  return {
    id: randomUUID(),
    type: 'local',
    path: snapshotPath,
  };
}

export async function createRemoteSnapshot(
  state: LocalSnapshotState,
  spec: RemoteSnapshotSpec,
): Promise<RemoteSnapshot> {
  const data = await createWorkspaceArchive(
    state.workspaceRootPath,
    state.manifest.ephemeralPersistencePaths(),
  );
  const saved = await spec.store.save({
    id: spec.id,
    data,
    metadata: spec.metadata,
  });
  return {
    id: saved.id,
    type: 'remote',
    ...(saved.metadata ? { metadata: saved.metadata } : {}),
  };
}

export async function persistLocalSnapshot<TState extends LocalSnapshotState>(
  providerName: string,
  state: TState,
  spec: SnapshotSpec | null,
): Promise<LocalSandboxSnapshot | null> {
  if (isNoopSnapshotSpec(spec)) {
    await replaceLocalSnapshot(state, null);
    replaceLocalSnapshotFingerprint(state, null);
    return null;
  }
  if (isRemoteSnapshotSpec(spec)) {
    const fingerprint = await computeLocalSnapshotFingerprint(state);
    const snapshot = await createRemoteSnapshot(state, spec);
    await replaceLocalSnapshot(state, snapshot);
    replaceLocalSnapshotFingerprint(state, fingerprint);
    return snapshot;
  }
  if (spec && spec.type !== 'local') {
    throw new UserError(
      `${providerName} does not support snapshot specs of type "${spec.type}".`,
    );
  }

  const fingerprint = await computeLocalSnapshotFingerprint(state);
  const snapshot = await createLocalSnapshot(
    state,
    (spec as LocalSnapshotSpec | null) ?? undefined,
  );
  await replaceLocalSnapshot(state, snapshot);
  replaceLocalSnapshotFingerprint(state, fingerprint);
  return snapshot;
}

export function serializeLocalSnapshotSpec(
  spec: LocalSandboxSnapshotSpec | null | undefined,
): Record<string, unknown> | null {
  if (!spec) {
    return null;
  }
  if (spec.type === 'remote') {
    return {
      type: 'remote',
      ...(typeof spec.id === 'string' ? { id: spec.id } : {}),
      ...(spec.metadata ? { metadata: structuredClone(spec.metadata) } : {}),
    };
  }
  return structuredClone(spec) as Record<string, unknown>;
}

export function rehydrateLocalSnapshotSpec(
  serialized: unknown,
  configured: LocalSandboxSnapshotSpec | null | undefined,
): LocalSandboxSnapshotSpec | null {
  // Remote SnapshotStore implementations can carry functions or credentials, so
  // serialized state stores only lookup fields and reattaches the live configured store.
  if (!isRecord(serialized)) {
    return null;
  }
  if (serialized.type !== 'remote') {
    return structuredClone(serialized) as LocalSandboxSnapshotSpec;
  }
  if (isRemoteSnapshotSpec(serialized as SnapshotSpec)) {
    return serialized as RemoteSnapshotSpec;
  }
  if (!isRemoteSnapshotSpec(configured)) {
    return null;
  }
  const id = typeof serialized.id === 'string' ? serialized.id : configured.id;
  const metadata = isRecord(serialized.metadata)
    ? (structuredClone(serialized.metadata) as Record<string, unknown>)
    : configured.metadata;
  return {
    type: 'remote',
    store: configured.store,
    ...(id ? { id } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export async function replaceLocalSnapshot<TState extends LocalSnapshotState>(
  state: TState,
  snapshot: LocalSandboxSnapshot | null,
): Promise<void> {
  const previousSnapshot = state.snapshot;
  state.snapshot = snapshot;
  if (
    previousSnapshot?.type === 'local' &&
    previousSnapshot.path !== snapshot?.path &&
    previousSnapshot.path !== state.workspaceRootPath
  ) {
    await rm(previousSnapshot.path, { recursive: true, force: true });
  }
  if (
    previousSnapshot?.type === 'remote' &&
    previousSnapshot.id !== snapshot?.id
  ) {
    const store = remoteSnapshotStoreFromSpec(state);
    await store?.delete?.({ id: previousSnapshot.id }).catch(() => undefined);
  }
}

export async function canReuseLocalSnapshotWorkspace(
  state: LocalSnapshotState,
): Promise<boolean> {
  if (!(await localSnapshotIsRestorable(state))) {
    return true;
  }

  const storedFingerprint = state.snapshotFingerprint;
  const storedVersion = state.snapshotFingerprintVersion;
  if (
    !storedFingerprint ||
    storedVersion !== LOCAL_SNAPSHOT_FINGERPRINT_VERSION
  ) {
    return false;
  }

  const current = await computeLocalSnapshotFingerprint(state).catch(
    () => null,
  );
  // The fingerprint covers the persisted manifest plus durable workspace tree; ephemeral
  // paths are intentionally ignored because they are rebuilt after resume.
  return (
    current?.fingerprint === storedFingerprint &&
    current.version === storedVersion
  );
}

export async function localSnapshotIsRestorable(
  state: LocalSnapshotState,
): Promise<boolean> {
  if (state.snapshot?.type === 'remote') {
    const store = remoteSnapshotStoreFromSpec(state);
    if (!store) {
      return false;
    }
    if (store.exists) {
      return await store.exists({ id: state.snapshot.id });
    }
    return true;
  }
  return Boolean(
    state.snapshot?.type === 'local' && (await pathExists(state.snapshot.path)),
  );
}

export async function restoreLocalSnapshotToWorkspace<
  TState extends LocalSnapshotState,
>(state: TState, workspaceRootPath: string): Promise<TState> {
  if (!(await localSnapshotIsRestorable(state))) {
    throw new UserError('No local snapshot is available to restore.');
  }

  if (state.snapshot?.type === 'remote') {
    const store = remoteSnapshotStoreFromSpec(state);
    if (!store) {
      throw new UserError('No remote snapshot store is available to restore.');
    }
    const restored = await store.load({ id: state.snapshot.id });
    await restoreWorkspaceArchive(restored.data, workspaceRootPath);
  } else {
    await replaceDirectoryContents(state.snapshot!.path, workspaceRootPath);
  }
  state.workspaceRootPath = workspaceRootPath;

  const fingerprint = await computeLocalSnapshotFingerprint(state).catch(
    () => null,
  );
  replaceLocalSnapshotFingerprint(state, fingerprint);
  return state;
}

export async function computeLocalSnapshotFingerprint(
  state: LocalSnapshotState,
): Promise<LocalSnapshotFingerprint> {
  const hash = createHash('sha256');
  appendHashFrame(hash, 'version', LOCAL_SNAPSHOT_FINGERPRINT_VERSION);
  appendHashFrame(
    hash,
    'manifest',
    stableJsonStringify(serializeManifest(state.manifest), {
      encodeBytes: (value) => ({
        type: 'Uint8Array',
        data: Buffer.from(value).toString('base64'),
      }),
    }),
  );
  await hashDirectory(
    hash,
    state.workspaceRootPath,
    state.manifest.ephemeralPersistencePaths(),
  );
  return {
    fingerprint: hash.digest('hex'),
    version: LOCAL_SNAPSHOT_FINGERPRINT_VERSION,
  };
}

export async function copyDirectory(
  sourceRoot: string,
  destinationRoot: string,
  excludedLogicalPaths: Set<string> = new Set(),
  currentRelativePath: string = '',
  expectedSourceStats?: Stats,
  destinationRootPath = destinationRoot,
): Promise<void> {
  const entries = await readStableSnapshotDirectoryEntries(
    sourceRoot,
    expectedSourceStats,
  );
  await assertSafeSnapshotDestinationPath(destinationRootPath, destinationRoot);
  await mkdir(destinationRoot, { recursive: true });
  await assertSafeSnapshotDestinationPath(destinationRootPath, destinationRoot);
  for (const entry of entries) {
    const relativePath = currentRelativePath
      ? `${currentRelativePath}/${entry.name}`
      : entry.name;
    if (shouldSkipSnapshotPath(relativePath, excludedLogicalPaths)) {
      continue;
    }

    const sourcePath = join(sourceRoot, entry.name);
    const destinationPath = join(destinationRoot, entry.name);
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isDirectory()) {
      await copyDirectory(
        sourcePath,
        destinationPath,
        excludedLogicalPaths,
        relativePath,
        sourceStats,
        destinationRootPath,
      );
      continue;
    }

    if (!sourceStats.isFile()) {
      continue;
    }

    await assertSafeSnapshotDestinationPath(
      destinationRootPath,
      dirname(destinationPath),
    );
    await mkdir(dirname(destinationPath), { recursive: true });
    await assertSafeSnapshotDestinationPath(
      destinationRootPath,
      dirname(destinationPath),
    );
    await writeStableSnapshotFile(
      destinationRootPath,
      destinationPath,
      await readStableSnapshotFile(sourcePath, sourceStats),
      sourceStats.mode & 0o777,
    );
    const destinationStats = await lstat(destinationPath);
    if (!destinationStats.isFile()) {
      await rm(destinationPath, { recursive: true, force: true });
    }
  }
}

type WorkspaceArchiveV1 = {
  version: 1;
  directories: string[];
  files: Array<{ path: string; data: string }>;
};

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
): Promise<void> {
  const archive = JSON.parse(
    typeof data === 'string'
      ? data
      : new TextDecoder().decode(workspaceArchiveDataToUint8Array(data)),
  ) as WorkspaceArchiveV1;
  if (archive.version !== 1) {
    throw new UserError('Unsupported remote snapshot archive version.');
  }

  await mkdir(destinationRoot, { recursive: true });
  await clearDirectory(destinationRoot);
  for (const directory of archive.directories) {
    await writeSafeArchiveDirectory(destinationRoot, directory);
  }
  for (const file of archive.files) {
    await writeSafeArchiveFile(destinationRoot, file.path, file.data);
  }
}

function workspaceArchiveDataToUint8Array(
  data: ArrayBuffer | Uint8Array,
): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

async function writeSafeArchiveDirectory(
  destinationRoot: string,
  relativePath: string,
): Promise<void> {
  const destinationPath = safeArchivePath(destinationRoot, relativePath);
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationPath);
  await mkdir(destinationPath, { recursive: true });
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationPath);
}

async function writeSafeArchiveFile(
  destinationRoot: string,
  relativePath: string,
  base64Data: string,
): Promise<void> {
  const destinationPath = safeArchivePath(destinationRoot, relativePath);
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

function safeArchivePath(
  destinationRoot: string,
  relativePath: string,
): string {
  const destinationPath = join(destinationRoot, relativePath);
  if (!isHostPathStrictlyWithinRoot(destinationRoot, destinationPath)) {
    throw new UserError(
      `Remote snapshot archive path escapes root: ${relativePath}`,
    );
  }
  return destinationPath;
}

async function replaceDirectoryContents(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationRoot);
  await mkdir(destinationRoot, { recursive: true });
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationRoot);
  await clearDirectory(destinationRoot);
  await copyDirectory(sourceRoot, destinationRoot);
}

async function clearDirectory(destinationRoot: string): Promise<void> {
  await assertSafeSnapshotDestinationPath(destinationRoot, destinationRoot);
  const entries = await readdir(destinationRoot);
  await Promise.all(
    entries.map(async (entry) => {
      await rm(join(destinationRoot, entry), { recursive: true, force: true });
    }),
  );
}

function replaceLocalSnapshotFingerprint(
  state: LocalSnapshotState,
  fingerprint: LocalSnapshotFingerprint | null,
): void {
  state.snapshotFingerprint = fingerprint?.fingerprint ?? null;
  state.snapshotFingerprintVersion = fingerprint?.version ?? null;
}

async function mkdtempForSnapshot(spec?: LocalSnapshotSpec): Promise<string> {
  const baseDir = spec?.baseDir ?? defaultLocalSnapshotBaseDir();
  await mkdir(baseDir, { recursive: true });
  return await mkdtemp(join(baseDir, 'openai-agents-sandbox-snapshot-'));
}

function shouldSkipSnapshotPath(
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

export function isRemoteSnapshotSpec(
  spec: SnapshotSpec | null | undefined,
): spec is RemoteSnapshotSpec {
  const store = (spec as { store?: unknown } | undefined)?.store;
  return (
    spec?.type === 'remote' &&
    typeof store === 'object' &&
    store !== null &&
    typeof (store as { save?: unknown }).save === 'function' &&
    typeof (store as { load?: unknown }).load === 'function'
  );
}

function remoteSnapshotStoreFromSpec(state: LocalSnapshotState) {
  const spec = state.snapshotSpec;
  return isRemoteSnapshotSpec(spec) ? spec.store : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hashDirectory(
  hash: ReturnType<typeof createHash>,
  rootPath: string,
  excludedLogicalPaths: Set<string>,
  currentRelativePath: string = '',
  expectedSourceStats?: Stats,
): Promise<void> {
  const entries = await readStableSnapshotDirectoryEntries(
    rootPath,
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

    const entryPath = join(rootPath, entry.name);
    const entryStats = await lstat(entryPath);
    if (entryStats.isDirectory()) {
      appendHashFrame(hash, 'dir', relativePath);
      await hashDirectory(
        hash,
        entryPath,
        excludedLogicalPaths,
        relativePath,
        entryStats,
      );
      continue;
    }

    if (!entryStats.isFile()) {
      continue;
    }

    const content = await readStableSnapshotFile(entryPath, entryStats);
    appendHashFrame(hash, 'file', relativePath);
    appendHashFrame(hash, 'bytes', String(content.byteLength));
    hash.update(content);
  }
}

async function readStableSnapshotDirectoryEntries(
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

async function readStableSnapshotFile(
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

async function writeStableSnapshotFile(
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

async function assertSafeSnapshotDestinationPath(
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

function appendHashFrame(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string,
): void {
  // Length-delimited frames avoid collisions such as ["ab", "c"] vs ["a", "bc"].
  hash.update(label);
  hash.update('\0');
  hash.update(String(value.length));
  hash.update('\0');
  hash.update(value);
  hash.update('\0');
}
