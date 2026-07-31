import { UserError } from '../../errors';
import { isDir, isMount, type Entry } from '../entries';
import { normalizeRelativePath, Manifest } from '../manifest';
import type { SandboxSessionLike, SandboxSessionState } from '../session';
import { arraysEqual, jsonEqual } from '../shared/compare';
import { serializeManifestEnvironment } from '../shared/environment';
import {
  addedOrChangedNamedObjects,
  addedOrChangedPathKeyedObjects,
} from '../shared/manifestCollections';
import { isDefaultRemoteMountCommandAllowlist } from '../shared/remoteMountCommandAllowlist';
import { mergeManifestDelta } from '../sandboxes/shared/manifestPersistence';

export async function applyManifestToProvidedSession(
  session: SandboxSessionLike<SandboxSessionState>,
  manifest: Manifest,
  runAs?: string,
): Promise<void> {
  const currentManifest = session.state.manifest;
  // A provided session may already have long-lived processes, mounts, or provider
  // state, so only additive file materialization is allowed after validation.
  validateProvidedSessionManifestUpdate(currentManifest, manifest);
  const manifestDelta = buildProvidedSessionManifestDelta(
    currentManifest,
    manifest,
  );
  if (isManifestDeltaEmpty(manifestDelta)) {
    return;
  }
  const nextManifest = mergeManifestDelta(currentManifest, manifestDelta);

  if (session.applyManifest) {
    await session.applyManifest(manifestDelta, runAs);
  } else {
    if (Object.keys(manifestDelta.entries).length > 0) {
      if (!session.materializeEntry) {
        throw new UserError(
          'Provided sandbox sessions must support applyManifest() or materializeEntry() when the agent declares manifest entries.',
        );
      }
      for (const [path, entry] of Object.entries(manifestDelta.entries)) {
        await session.materializeEntry({
          path,
          entry,
          runAs,
        });
      }
    }
  }

  session.state.manifest = nextManifest;
}

function validateProvidedSessionManifestUpdate(
  current: Manifest,
  target: Manifest,
): void {
  if (current.root !== target.root) {
    throw new UserError(
      'Live sandbox sessions cannot change manifest.root. Create or resume a session with the desired root instead.',
    );
  }

  validateNoEnvironmentDelta(current, target);
  validateNoAddedOrChangedNamedObjects('users', current.users, target.users);
  validateNoAddedOrChangedNamedObjects('groups', current.groups, target.groups);
  validateProvidedEntryUpdates(current, target);
}

function validateNoEnvironmentDelta(current: Manifest, target: Manifest): void {
  const currentEnvironment = serializeManifestEnvironment(current);
  const targetEnvironment = serializeManifestEnvironment(target);
  const hasDelta = Object.entries(targetEnvironment).some(
    ([key, value]) => !jsonEqual(currentEnvironment[key], value),
  );
  if (hasDelta) {
    throw new UserError(
      'Live sandbox sessions cannot change manifest environment variables. Create or resume a session with the desired environment instead.',
    );
  }
}

function validateNoAddedOrChangedNamedObjects<T extends { name: string }>(
  label: string,
  current: T[],
  target: T[],
): void {
  if (addedOrChangedNamedObjects(current, target).length > 0) {
    throw new UserError(
      `Live sandbox sessions cannot change manifest ${label}. Create or resume a session with the desired ${label} instead.`,
    );
  }
}

function validateProvidedEntryUpdates(
  current: Manifest,
  target: Manifest,
): void {
  const currentEntriesByPath = new Map(
    [...current.iterEntries()].map(({ logicalPath, entry }) => [
      logicalPath,
      entry,
    ]),
  );

  for (const { logicalPath, entry } of target.iterEntries()) {
    const existingEntry = currentEntriesByPath.get(logicalPath);
    if (!existingEntry) {
      if (isMount(entry)) {
        throw new UserError(
          `Live sandbox sessions cannot add mount entries: ${logicalPath || '.'}`,
        );
      }
      continue;
    }

    if (existingEntry.type !== entry.type) {
      throw new UserError(
        `Live sandbox sessions cannot replace manifest entry types: ${logicalPath || '.'}`,
      );
    }
    if (isMount(existingEntry) || isMount(entry)) {
      if (!jsonEqual(existingEntry, entry)) {
        throw new UserError(
          `Live sandbox sessions cannot change mount entries: ${logicalPath || '.'}`,
        );
      }
      continue;
    }
    if (isDir(existingEntry) && isDir(entry)) {
      if (
        !jsonEqual(
          manifestEntryWithoutDirChildren(existingEntry),
          manifestEntryWithoutDirChildren(entry),
        )
      ) {
        throw new UserError(
          `Live sandbox sessions cannot change manifest entries: ${logicalPath || '.'}`,
        );
      }
      continue;
    }
    if (!jsonEqual(existingEntry, entry)) {
      throw new UserError(
        `Live sandbox sessions cannot change manifest entries: ${logicalPath || '.'}`,
      );
    }
  }
}

function manifestEntryWithoutDirChildren(entry: Entry): Entry {
  if (!isDir(entry)) {
    return entry;
  }

  const { children: _children, ...rest } = entry;
  return rest as Entry;
}

function buildProvidedSessionManifestDelta(
  current: Manifest,
  target: Manifest,
): Manifest {
  const currentEntriesByPath = new Map(
    [...current.iterEntries()].map(({ logicalPath, entry }) => [
      logicalPath,
      entry,
    ]),
  );
  const currentExistingPaths = new Set<string>();
  for (const path of currentEntriesByPath.keys()) {
    addManifestPathAndParents(currentExistingPaths, path);
  }

  const entries: Record<string, Entry> = {};
  for (const [path, entry] of Object.entries(target.entries)) {
    visitProvidedSessionTargetEntry(
      entries,
      currentEntriesByPath,
      currentExistingPaths,
      normalizeRelativePath(path),
      entry,
    );
  }
  const users = addedOrChangedNamedObjects(current.users, target.users);
  const groups = addedOrChangedNamedObjects(current.groups, target.groups);
  const extraPathGrants = addedOrChangedPathKeyedObjects(
    current.extraPathGrants,
    target.extraPathGrants,
  );
  const hasRemoteMountCommandAllowlistDelta =
    !isDefaultRemoteMountCommandAllowlist(target.remoteMountCommandAllowlist) &&
    !arraysEqual(
      current.remoteMountCommandAllowlist,
      target.remoteMountCommandAllowlist,
    );

  // Avoid sending the default allowlist as a delta because doing so would overwrite a
  // provider's existing customized allowlist on an already-running session.
  return new Manifest({
    root: current.root,
    entries,
    users,
    groups,
    extraPathGrants,
    ...(hasRemoteMountCommandAllowlistDelta
      ? {
          remoteMountCommandAllowlist: [...target.remoteMountCommandAllowlist],
        }
      : {}),
  });
}

function visitProvidedSessionTargetEntry(
  entries: Record<string, Entry>,
  currentEntriesByPath: Map<string, Entry>,
  currentExistingPaths: Set<string>,
  logicalPath: string,
  entry: Entry,
): void {
  if (!currentExistingPaths.has(logicalPath)) {
    entries[logicalPath] = structuredClone(entry);
    return;
  }

  // Existing directories are containers for additive children; their own metadata was
  // already checked by validateProvidedEntryUpdates().
  if (!isDir(entry) || !entry.children) {
    return;
  }

  const currentEntry = currentEntriesByPath.get(logicalPath);
  if (currentEntry && !isDir(currentEntry)) {
    return;
  }

  for (const [childPath, childEntry] of Object.entries(entry.children)) {
    const normalizedChildPath = normalizeRelativePath(childPath);
    const childLogicalPath = logicalPath
      ? `${logicalPath}/${normalizedChildPath}`
      : normalizedChildPath;
    visitProvidedSessionTargetEntry(
      entries,
      currentEntriesByPath,
      currentExistingPaths,
      childLogicalPath,
      childEntry,
    );
  }
}

function addManifestPathAndParents(
  paths: Set<string>,
  logicalPath: string,
): void {
  if (!logicalPath) {
    return;
  }

  const segments = logicalPath.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    paths.add(segments.slice(0, index).join('/'));
  }
}

function isManifestDeltaEmpty(manifest: Manifest): boolean {
  return (
    Object.keys(manifest.entries).length === 0 &&
    Object.keys(manifest.environment).length === 0 &&
    manifest.users.length === 0 &&
    manifest.groups.length === 0 &&
    manifest.extraPathGrants.length === 0 &&
    isDefaultRemoteMountCommandAllowlist(manifest.remoteMountCommandAllowlist)
  );
}
