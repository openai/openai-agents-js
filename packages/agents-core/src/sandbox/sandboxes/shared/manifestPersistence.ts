import { isMount, type Entry } from '../../entries';
import { UserError } from '../../../errors';
import {
  cloneManifest,
  copyManifestMountCredentialExposurePolicy,
  copyProcessEnvironmentProtection,
  invalidProtectedProcessEnvironmentReferences,
  isEnvValueReference,
  Manifest,
  ProcessEnvValue,
  processEnvironmentDestinationNames,
  type EnvValue,
} from '../../manifest';
import type { SandboxSessionState } from '../../session';
import {
  mergeNamedObjects,
  mergePathKeyedObjects,
} from '../../shared/manifestCollections';
import { hasCustomRemoteMountCommandAllowlist } from '../../shared/remoteMountCommandAllowlist';
import {
  serializeManifestEnvironment,
  type SerializedManifestEnvironment,
} from '../../shared/environment';
import {
  decodeBase64ToUint8Array,
  encodeUint8ArrayToBase64,
} from '../../../utils/base64';
import {
  copyTrustedMountCredentialRebindProvenance,
  recordPersistedMountTopology,
  recordPendingMountCredentialPaths,
  redactMountCredentialsForPersistence,
  sanitizePersistedManifestRecord,
  validateMountCredentialBoundaries,
} from '../../mountSecurity';

export {
  assertMountCredentialsRebound,
  deserializeMountCredentialRedactionMetadata,
  rebindPersistedMountCredentials,
  serializeMountCredentialRedactionMetadata,
} from '../../mountSecurity';

type ManifestPersistenceState = {
  manifest: Manifest;
  environment?: Record<string, string>;
};

const redactedHostPathGrantPathsKey =
  '__openaiAgentsRedactedHostPathGrantPaths';

export function serializeManifest(manifest: Manifest): Manifest {
  return deserializeManifest(serializeManifestRecord(manifest));
}

export function serializeHostPathGrantRedactionMetadata(
  state: SandboxSessionState,
): Record<string, unknown> {
  const paths = new Set(readRedactedHostPathGrantPaths(state));
  for (const grant of state.manifest.extraPathGrants) {
    if (grant.hostPath !== undefined) {
      paths.add(grant.path);
    }
  }
  return paths.size > 0 ? { [redactedHostPathGrantPathsKey]: [...paths] } : {};
}

export function deserializeHostPathGrantRedactionMetadata(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const paths = readRedactedHostPathGrantPaths(state);
  return paths.length > 0 ? { [redactedHostPathGrantPathsKey]: paths } : {};
}

export function rebindPersistedPathGrants<TState extends SandboxSessionState>(
  state: TState,
  trustedManifest: Manifest | undefined,
  options: {
    replaceWithTrustedManifest?: boolean;
    replaceWithTrustedGrantSet?: boolean;
  } = {},
): TState {
  // Native host paths are runtime authority. Only the current manifest may
  // reintroduce them after persisted session state has been deserialized.
  const reboundState: SandboxSessionState = { ...state };
  if (options.replaceWithTrustedManifest && trustedManifest) {
    reboundState.manifest = cloneManifest(trustedManifest);
    copyTrustedMountCredentialRebindProvenance(
      reboundState.manifest,
      state.manifest,
    );
    delete reboundState[redactedHostPathGrantPathsKey];
    return reboundState as TState;
  }

  const trustedGrantsByPath = new Map(
    (trustedManifest?.extraPathGrants ?? []).map((grant) => [
      grant.path,
      grant,
    ]),
  );
  let extraPathGrants: Manifest['extraPathGrants'];
  if (options.replaceWithTrustedGrantSet && trustedManifest) {
    extraPathGrants = trustedManifest.extraPathGrants.map((grant) =>
      structuredClone(grant),
    );
  } else {
    const unmatchedGrantPaths = state.manifest.extraPathGrants
      .filter((grant) => !trustedGrantsByPath.has(grant.path))
      .map((grant) => grant.path);
    if (unmatchedGrantPaths.length > 0) {
      throw new UserError(
        `Sandbox session state contains path grants that are not present in the current trusted manifest: ${unmatchedGrantPaths.join(', ')}. Define each grant in the current manifest before resuming.`,
      );
    }
    extraPathGrants = state.manifest.extraPathGrants.map((grant) => {
      return structuredClone(trustedGrantsByPath.get(grant.path)!);
    });
  }

  reboundState.manifest = new Manifest({
    version: state.manifest.version,
    root: state.manifest.root,
    entries: structuredClone(state.manifest.entries),
    environment: Object.fromEntries(
      Object.entries(state.manifest.environment).map(([key, value]) => [
        key,
        value.init(),
      ]),
    ),
    users: structuredClone(state.manifest.users),
    groups: structuredClone(state.manifest.groups),
    extraPathGrants,
    remoteMountCommandAllowlist: [
      ...state.manifest.remoteMountCommandAllowlist,
    ],
  });
  copyManifestMountCredentialExposurePolicy(
    reboundState.manifest,
    state.manifest,
  );
  copyTrustedMountCredentialRebindProvenance(
    reboundState.manifest,
    state.manifest,
  );

  const reboundGrantsByPath = new Map(
    reboundState.manifest.extraPathGrants.map((grant) => [grant.path, grant]),
  );
  const unresolvedPaths = options.replaceWithTrustedGrantSet
    ? []
    : readRedactedHostPathGrantPaths(state).filter(
        (path) => reboundGrantsByPath.get(path)?.hostPath === undefined,
      );
  if (unresolvedPaths.length > 0) {
    reboundState[redactedHostPathGrantPathsKey] = unresolvedPaths;
  } else {
    delete reboundState[redactedHostPathGrantPathsKey];
  }
  return reboundState as TState;
}

export function assertHostPathGrantsRebound(state: SandboxSessionState): void {
  const paths = readRedactedHostPathGrantPaths(state);
  if (paths.length === 0) {
    return;
  }
  throw new UserError(
    `Sandbox session state requires trusted hostPath values for these path grants: ${paths.join(', ')}. Resume it through the Runner with a current manifest that defines each hostPath.`,
  );
}

function readRedactedHostPathGrantPaths(
  state: Record<string, unknown>,
): string[] {
  const value = state[redactedHostPathGrantPathsKey];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function serializeManifestRecord(
  manifest: Manifest,
): Record<string, unknown> {
  validateMountCredentialBoundaries(manifest);
  assertProcessEnvironmentReferencesSerializable(manifest);
  return {
    version: manifest.version,
    root: manifest.root,
    entries: sanitizeEntriesForPersistence(manifest.entries),
    environment: serializePersistentManifestEnvironment(manifest),
    users: structuredClone(manifest.users),
    groups: structuredClone(manifest.groups),
    // Native host paths are rebound from trusted current configuration on resume.
    extraPathGrants: manifest.extraPathGrants.map((grant) => {
      const { hostPath: _hostPath, ...persistentGrant } = grant;
      return structuredClone(persistentGrant);
    }),
    remoteMountCommandAllowlist: [...manifest.remoteMountCommandAllowlist],
  };
}

export function assertProcessEnvironmentReferencesSerializable(
  manifest: Manifest,
): void {
  const invalidProcessEnvironmentReferences =
    invalidProtectedProcessEnvironmentReferences(manifest);
  if (invalidProcessEnvironmentReferences.length > 0) {
    throw new UserError(
      `Sandbox session state cannot be serialized because protected ProcessEnvValue references changed after binding: ${invalidProcessEnvironmentReferences.join(', ')}. Create a fresh Docker sandbox session instead.`,
    );
  }
}

export function deserializeManifest(
  value: Record<string, unknown> | undefined,
): Manifest {
  const { record, credentialPaths } = sanitizePersistedManifestRecord(
    value ?? {},
  );
  const manifest = new Manifest(deserializeManifestRecord(record));
  recordPersistedMountTopology(manifest);
  recordPendingMountCredentialPaths(manifest, credentialPaths);
  return manifest;
}

export function sanitizeEnvironmentForPersistence(
  state: ManifestPersistenceState,
): Record<string, string> {
  const environment = serializeEnvironmentForPersistence(state);
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, value.value]),
  );
}

export function serializeEnvironmentForPersistence(
  state: ManifestPersistenceState,
): Record<string, EnvValue> {
  const runtimeEnvironment = state.environment ?? {};
  const ephemeralKeys = new Set<string>();
  const protectedKeys = new Set(
    processEnvironmentDestinationNames(state.manifest),
  );
  const serialized: Record<string, EnvValue> = {};

  for (const [key, value] of Object.entries(state.manifest.environment)) {
    if (
      protectedKeys.has(key) ||
      value.ephemeral ||
      isEnvValueReference(value)
    ) {
      ephemeralKeys.add(key);
      continue;
    }

    serialized[key] = {
      ...value.normalized(),
      value: runtimeEnvironment[key] ?? value.value,
    };
  }

  for (const [key, value] of Object.entries(runtimeEnvironment)) {
    if (
      key in state.manifest.environment ||
      ephemeralKeys.has(key) ||
      protectedKeys.has(key)
    ) {
      continue;
    }
    // Provider startup may add runtime env vars that are not in the manifest; keep them
    // unless they collide with an explicitly ephemeral manifest key.
    serialized[key] = { value };
  }

  return serialized;
}

export function mergeManifestDelta(base: Manifest, update: Manifest): Manifest {
  const merged = new Manifest({
    version: update.version ?? base.version,
    root: base.root,
    entries: {
      ...structuredClone(base.entries),
      ...structuredClone(update.entries),
    },
    environment: {
      ...cloneManifestEnvironment(base),
      ...cloneManifestEnvironment(update),
    },
    users: mergeNamedObjects(base.users, update.users),
    groups: mergeNamedObjects(base.groups, update.groups),
    extraPathGrants: mergePathKeyedObjects(
      base.extraPathGrants,
      update.extraPathGrants,
    ),
    remoteMountCommandAllowlist: shouldMergeRemoteMountCommandAllowlist(update)
      ? update.remoteMountCommandAllowlist
      : base.remoteMountCommandAllowlist,
  });
  copyManifestMountCredentialExposurePolicy(merged, base, update);
  copyProcessEnvironmentProtection(merged, base, update);
  return merged;
}

export function assertProcessEnvironmentDestinationsPreserved(
  base: Manifest,
  update: Manifest,
): void {
  const protectedDestinations = new Set(
    processEnvironmentDestinationNames(base),
  );
  const rejectedDestinations = Object.entries(update.environment)
    .filter(
      ([key, value]) =>
        protectedDestinations.has(key) || value instanceof ProcessEnvValue,
    )
    .map(([key]) => key);
  if (rejectedDestinations.length > 0) {
    throw new UserError(
      `Sandbox manifests cannot add or replace protected process environment destinations: ${rejectedDestinations.join(', ')}. Start a new Docker sandbox session instead.`,
    );
  }
}

function cloneManifestEnvironment(
  manifest: Manifest,
): Record<string, EnvValue> {
  return Object.fromEntries(
    Object.entries(manifest.environment).map(([key, value]) => [
      key,
      value.init(),
    ]),
  );
}

export function mergeManifestEntryDelta(
  base: Manifest,
  path: string,
  entry: Entry,
): Manifest {
  return mergeManifestDelta(
    base,
    new Manifest({
      root: base.root,
      entries: {
        [path]: structuredClone(entry),
      },
    }),
  );
}

function serializePersistentManifestEnvironment(
  manifest: Manifest,
): SerializedManifestEnvironment {
  const environment = serializeManifestEnvironment(manifest);
  // Ephemeral envs are runtime-only and must not be persisted.
  // Persisting them would leak values into snapshots.
  // Resume would also depend on regenerated data.
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !manifest.environment[key]?.ephemeral,
    ),
  );
}

function shouldMergeRemoteMountCommandAllowlist(update: Manifest): boolean {
  return hasCustomRemoteMountCommandAllowlist(
    update.remoteMountCommandAllowlist,
  );
}

function sanitizeEntriesForPersistence(
  entries: Record<string, Entry>,
  ancestorEphemeral = false,
): Record<string, Entry> {
  const sanitizedEntries: Record<string, Entry> = {};

  for (const [path, entry] of Object.entries(entries)) {
    const sanitizedEntry = sanitizeEntryForPersistence(
      entry,
      ancestorEphemeral,
    );
    if (sanitizedEntry) {
      sanitizedEntries[path] = sanitizedEntry;
    }
  }

  return sanitizedEntries;
}

function sanitizeEntryForPersistence(
  entry: Entry,
  ancestorEphemeral: boolean,
): Entry | undefined {
  const effectiveEphemeral = ancestorEphemeral || Boolean(entry.ephemeral);

  if (entry.type === 'file') {
    return !effectiveEphemeral
      ? ({
          ...entry,
          content: serializeFileContentForPersistence(entry.content),
        } as unknown as Entry)
      : undefined;
  }

  if (entry.type !== 'dir' || !entry.children) {
    if (effectiveEphemeral && !isMount(entry)) {
      return undefined;
    }
    return isMount(entry)
      ? redactMountCredentialsForPersistence(entry)
      : { ...entry };
  }

  const children = sanitizeEntriesForPersistence(
    entry.children,
    effectiveEphemeral,
  );
  if (effectiveEphemeral && Object.keys(children).length === 0) {
    return undefined;
  }

  return {
    ...entry,
    children,
  };
}

function deserializeManifestRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...value,
    entries: deserializeEntriesForRuntime(
      value.entries as Record<string, Entry> | undefined,
    ),
    extraPathGrants: Array.isArray(value.extraPathGrants)
      ? value.extraPathGrants.map((grant) => {
          if (typeof grant !== 'object' || grant === null) {
            return grant;
          }
          const { hostPath: _hostPath, ...persistentGrant } = grant as Record<
            string,
            unknown
          >;
          return persistentGrant;
        })
      : value.extraPathGrants,
  };
}

function deserializeEntriesForRuntime(
  entries: Record<string, Entry> | undefined,
): Record<string, Entry> {
  if (!entries) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(entries).map(([path, entry]) => [
      path,
      deserializeEntryForRuntime(entry),
    ]),
  );
}

function deserializeEntryForRuntime(entry: Entry): Entry {
  if (entry.type === 'file') {
    const content = (entry as { content?: unknown }).content;
    return {
      ...entry,
      content: isSerializedFileContent(content)
        ? decodeBase64ToUint8Array(content.data)
        : entry.content,
    };
  }

  if (entry.type === 'dir' && entry.children) {
    return {
      ...entry,
      children: deserializeEntriesForRuntime(entry.children),
    };
  }

  return { ...entry };
}

type SerializedFileContent = {
  type: 'base64';
  data: string;
};

function serializeFileContentForPersistence(
  content: string | Uint8Array,
): string | SerializedFileContent {
  return typeof content === 'string'
    ? content
    : {
        type: 'base64',
        data: encodeUint8ArrayToBase64(content),
      };
}

function isSerializedFileContent(
  value: unknown,
): value is SerializedFileContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'base64' &&
    typeof (value as { data?: unknown }).data === 'string'
  );
}
