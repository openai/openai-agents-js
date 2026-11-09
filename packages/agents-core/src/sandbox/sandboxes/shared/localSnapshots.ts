import { UserError } from '../../../errors';
import type { SandboxArchiveLimits } from '../../client';
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
import { lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Manifest } from '../../manifest';
import { stableJsonStringify } from '../../shared/stableJson';
import { isRecord } from '../../shared/typeGuards';
import {
  clearDirectory,
  shouldSkipSnapshotPath,
  readStableSnapshotDirectoryEntries,
  readStableSnapshotFile,
  writeStableSnapshotFile,
  assertSafeSnapshotDestinationPath,
} from './snapshotFilesystem';
import {
  createWorkspaceArchive,
  restoreWorkspaceArchive,
} from './workspaceArchive';
import { defaultLocalSnapshotBaseDir } from './localSnapshotPaths';
import { serializeManifest } from './manifestPersistence';

export const LOCAL_SNAPSHOT_FINGERPRINT_VERSION = 'workspace_tree_sha256_v1';
export type LocalSnapshotFingerprint = {
  fingerprint: string;
  version: typeof LOCAL_SNAPSHOT_FINGERPRINT_VERSION;
};

type LocalSnapshotState = {
  workspaceRootPath: string;
  manifest: Manifest;
  snapshotExcludedPaths?: Iterable<string>;
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
    localSnapshotExcludedPaths(state),
  );
  return {
    id: randomUUID(),
    type: 'local',
    path: snapshotPath,
  };
}

export async function persistLocalSnapshot<TState extends LocalSnapshotState>(
  providerName: string,
  state: TState,
  spec: SnapshotSpec | null,
  capture: <T>(operation: () => Promise<T>) => Promise<T> = (operation) =>
    operation(),
): Promise<LocalSandboxSnapshot | null> {
  if (isNoopSnapshotSpec(spec)) {
    await replaceLocalSnapshot(state, null);
    replaceLocalSnapshotFingerprint(state, null);
    return null;
  }
  if (isRemoteSnapshotSpec(spec)) {
    const { fingerprint, data } = await capture(async () => ({
      fingerprint: await computeLocalSnapshotFingerprint(state),
      data: await createWorkspaceArchive(
        state.workspaceRootPath,
        localSnapshotExcludedPaths(state),
      ),
    }));
    const saved = await spec.store.save({
      id: spec.id,
      data,
      metadata: spec.metadata,
    });
    const snapshot: RemoteSnapshot = {
      id: saved.id,
      type: 'remote',
      ...(saved.metadata ? { metadata: saved.metadata } : {}),
    };
    await replaceLocalSnapshot(state, snapshot);
    replaceLocalSnapshotFingerprint(state, fingerprint);
    return snapshot;
  }
  if (spec && spec.type !== 'local') {
    throw new UserError(
      `${providerName} does not support snapshot specs of type "${spec.type}".`,
    );
  }

  const { fingerprint, snapshot } = await capture(async () => ({
    fingerprint: await computeLocalSnapshotFingerprint(state),
    snapshot: await createLocalSnapshot(
      state,
      (spec as LocalSnapshotSpec | null) ?? undefined,
    ),
  }));
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
>(
  state: TState,
  workspaceRootPath: string,
  options: { archiveLimits?: SandboxArchiveLimits | null } = {},
): Promise<TState> {
  if (!(await localSnapshotIsRestorable(state))) {
    throw new UserError('No local snapshot is available to restore.');
  }

  if (state.snapshot?.type === 'remote') {
    const store = remoteSnapshotStoreFromSpec(state);
    if (!store) {
      throw new UserError('No remote snapshot store is available to restore.');
    }
    const restored = await store.load({ id: state.snapshot.id });
    await restoreWorkspaceArchive(restored.data, workspaceRootPath, options);
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
    localSnapshotExcludedPaths(state),
  );
  return {
    fingerprint: hash.digest('hex'),
    version: LOCAL_SNAPSHOT_FINGERPRINT_VERSION,
  };
}

function localSnapshotExcludedPaths(state: LocalSnapshotState): Set<string> {
  const paths = state.manifest.ephemeralPersistencePaths();
  for (const path of state.snapshotExcludedPaths ?? []) {
    paths.add(path);
  }
  return paths;
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
