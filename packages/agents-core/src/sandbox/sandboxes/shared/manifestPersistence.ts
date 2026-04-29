import { isMount, type Entry } from '../../entries';
import { Manifest } from '../../manifest';
import {
  mergeNamedObjects,
  mergePathKeyedObjects,
} from '../../shared/manifestCollections';
import { hasCustomRemoteMountCommandAllowlist } from '../../shared/remoteMountCommandAllowlist';
import {
  serializeManifestEnvironment,
  type SerializedManifestEnvironment,
} from '../../shared/environment';
import { encodeUint8ArrayToBase64 } from '../../../utils/base64';

type ManifestPersistenceState = {
  manifest: Manifest;
  environment?: Record<string, string>;
};

export function serializeManifest(manifest: Manifest): Manifest {
  return deserializeManifest(serializeManifestRecord(manifest));
}

export function serializeManifestRecord(
  manifest: Manifest,
): Record<string, unknown> {
  return {
    version: manifest.version,
    root: manifest.root,
    entries: sanitizeEntriesForPersistence(manifest.entries),
    environment: serializePersistentManifestEnvironment(manifest),
    users: structuredClone(manifest.users),
    groups: structuredClone(manifest.groups),
    extraPathGrants: structuredClone(manifest.extraPathGrants),
    remoteMountCommandAllowlist: [...manifest.remoteMountCommandAllowlist],
  };
}

export function deserializeManifest(
  value: Record<string, unknown> | undefined,
): Manifest {
  return new Manifest(deserializeManifestRecord(value ?? {}));
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
): SerializedManifestEnvironment {
  const runtimeEnvironment = state.environment ?? {};
  const ephemeralKeys = new Set<string>();
  const serialized: SerializedManifestEnvironment = {};

  for (const [key, value] of Object.entries(state.manifest.environment)) {
    if (value.ephemeral) {
      ephemeralKeys.add(key);
      continue;
    }

    serialized[key] = {
      ...value.normalized(),
      value: runtimeEnvironment[key] ?? value.value,
    };
  }

  for (const [key, value] of Object.entries(runtimeEnvironment)) {
    if (key in state.manifest.environment || ephemeralKeys.has(key)) {
      continue;
    }
    // Provider startup may add runtime env vars that are not in the manifest; keep them
    // unless they collide with an explicitly ephemeral manifest key.
    serialized[key] = { value };
  }

  return serialized;
}

export function mergeManifestDelta(base: Manifest, update: Manifest): Manifest {
  return new Manifest({
    version: update.version ?? base.version,
    root: base.root,
    entries: {
      ...structuredClone(base.entries),
      ...structuredClone(update.entries),
    },
    environment: {
      ...serializeManifestEnvironment(base),
      ...serializeManifestEnvironment(update),
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
    return !effectiveEphemeral || isMount(entry) ? { ...entry } : undefined;
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

function decodeBase64ToUint8Array(value: string): Uint8Array {
  const bufferCtor = (
    globalThis as {
      Buffer?: { from(input: string, encoding: string): Uint8Array };
    }
  ).Buffer;
  if (bufferCtor) {
    return Uint8Array.from(bufferCtor.from(value, 'base64'));
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
