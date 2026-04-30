import { UserError } from '@openai/agents-core';
import {
  isMount,
  deserializeManifest,
  Manifest,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  normalizeRelativePath,
  normalizePosixPath,
  relativePosixPathWithinRoot,
  SandboxUnsupportedFeatureError,
  serializeManifestRecord,
  type Entry,
  type Mount,
  type TypedMount,
} from '@openai/agents-core/sandbox';
import { mergeMaterializedEnvironment } from './environment';
import { resolveSandboxRelativePath } from './paths';
import type { RemoteManifestWriter } from './types';
import type { RemoteSandboxPathResolver } from './types';

export {
  deserializeManifest,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  serializeManifestRecord,
};

export function cloneManifestWithRoot(
  manifest: Manifest,
  root: string,
): Manifest {
  return cloneManifestWithOverrides(manifest, {
    root,
    entries: rebaseManifestEntryPathsForRoot(
      manifest.entries,
      manifest.root,
      root,
    ),
  });
}

export function cloneManifestWithoutMountEntries(manifest: Manifest): Manifest {
  return cloneManifestWithOverrides(manifest, {
    entries: removeMountEntries(manifest.entries),
  });
}

export function manifestContainsLocalSource(manifest: Manifest): boolean {
  for (const { entry } of manifest.iterEntries()) {
    if (isLocalSourceEntry(entry)) {
      return true;
    }
  }
  return false;
}

export function entryContainsLocalSource(entry: Entry): boolean {
  if (isLocalSourceEntry(entry)) {
    return true;
  }
  if (entry.type !== 'dir' || !entry.children) {
    return false;
  }
  return Object.values(entry.children).some((childEntry) =>
    entryContainsLocalSource(childEntry),
  );
}

function isLocalSourceEntry(entry: Entry): boolean {
  return (
    entry.type === 'local_file' ||
    entry.type === 'local_dir' ||
    entry.type === 'git_repo'
  );
}

function cloneManifestWithOverrides(
  manifest: Manifest,
  overrides: {
    root?: string;
    entries?: Record<string, Entry>;
  } = {},
): Manifest {
  return new Manifest({
    version: manifest.version,
    root: overrides.root ?? manifest.root,
    entries: structuredClone(overrides.entries ?? manifest.entries),
    environment: Object.fromEntries(
      Object.entries(manifest.environment).map(([key, value]) => [
        key,
        value.init(),
      ]),
    ),
    users: structuredClone(manifest.users),
    groups: structuredClone(manifest.groups),
    extraPathGrants: structuredClone(manifest.extraPathGrants),
    remoteMountCommandAllowlist: [...manifest.remoteMountCommandAllowlist],
  });
}

function rebaseManifestEntryPathsForRoot(
  entries: Record<string, Entry>,
  fromRoot: string,
  toRoot: string,
): Record<string, Entry> {
  return Object.fromEntries(
    Object.entries(entries).map(([path, entry]) => [
      path,
      rebaseManifestEntryForRoot(entry, fromRoot, toRoot),
    ]),
  );
}

function rebaseManifestEntryForRoot(
  entry: Entry,
  fromRoot: string,
  toRoot: string,
): Entry {
  const cloned = structuredClone(entry);
  if (isMount(cloned) && cloned.mountPath?.startsWith('/')) {
    cloned.mountPath = rebaseAbsolutePathWithinRoot(
      cloned.mountPath,
      fromRoot,
      toRoot,
    );
  }
  if (cloned.type === 'dir' && cloned.children) {
    cloned.children = rebaseManifestEntryPathsForRoot(
      cloned.children,
      fromRoot,
      toRoot,
    );
  }
  return cloned;
}

function rebaseAbsolutePathWithinRoot(
  path: string,
  fromRoot: string,
  toRoot: string,
): string {
  const relativePath = relativePosixPathWithinRoot(
    normalizePosixPath(fromRoot),
    normalizePosixPath(path),
  );
  if (relativePath === null) {
    return path;
  }
  if (!relativePath) {
    return normalizePosixPath(toRoot);
  }
  const normalizedToRoot = normalizePosixPath(toRoot);
  if (normalizedToRoot === '/') {
    return `/${relativePath}`;
  }
  return `${normalizedToRoot}/${relativePath}`;
}

export type ManifestMaterializationOptions = {
  materializeMount?: (
    absolutePath: string,
    entry: Mount | TypedMount,
  ) => Promise<void>;
  applyMetadata?: (absolutePath: string, entry: Entry) => Promise<void>;
  resolvePath?: RemoteSandboxPathResolver;
  logicalPath?: string;
};

type DeferredMountMaterializationOptions = ManifestMaterializationOptions & {
  skipMountEntries?: boolean;
};

export type MaterializedManifestState = {
  manifest: Manifest;
  environment: Record<string, string>;
};

export type MaterializedManifestEntryState = {
  manifest: Manifest;
};

export type ManifestEntryMaterializer<TOptions extends object> = (
  writer: RemoteManifestWriter,
  absolutePath: string,
  entry: Entry,
  providerLabel: string,
  options: TOptions,
) => Promise<void>;

export async function applyInlineManifestEntryToState(
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
    materializeInlineManifestEntry,
    options,
  );
}

export async function applyInlineManifestToState(
  state: MaterializedManifestState,
  manifest: Manifest,
  providerLabel: string,
  writer: RemoteManifestWriter,
  resolvePath: RemoteSandboxPathResolver,
  options: ManifestMaterializationOptions = {},
): Promise<void> {
  await applyMaterializedManifestToState(
    state,
    manifest,
    providerLabel,
    writer,
    resolvePath,
    materializeInlineManifestEntry,
    options,
  );
}

export async function materializeInlineManifest(
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
    materializeInlineManifestEntry,
    options,
  );
}

export async function applyMaterializedManifestEntryToState<
  TOptions extends object,
>(
  state: MaterializedManifestEntryState,
  path: string,
  entry: Entry,
  providerLabel: string,
  writer: RemoteManifestWriter,
  resolvePath: RemoteSandboxPathResolver,
  materializeEntry: ManifestEntryMaterializer<TOptions>,
  options: TOptions,
): Promise<void> {
  const logicalPath = resolveSandboxRelativePath(state.manifest.root, path);
  await materializeManifestEntries(
    writer,
    new Manifest({
      root: state.manifest.root,
      entries: {
        [logicalPath]: entry,
      },
    }),
    providerLabel,
    resolvePath,
    materializeEntry,
    options,
  );
  state.manifest = mergeManifestEntryDelta(state.manifest, logicalPath, entry);
}

export async function applyMaterializedManifestToState<TOptions extends object>(
  state: MaterializedManifestState,
  manifest: Manifest,
  providerLabel: string,
  writer: RemoteManifestWriter,
  resolvePath: RemoteSandboxPathResolver,
  materializeEntry: ManifestEntryMaterializer<TOptions>,
  options: TOptions,
): Promise<void> {
  const previousManifest = state.manifest;
  await materializeManifestEntries(
    writer,
    manifest,
    providerLabel,
    resolvePath,
    materializeEntry,
    options,
  );
  state.manifest = mergeManifestDelta(previousManifest, manifest);
  state.environment = await mergeMaterializedEnvironment(
    previousManifest,
    state.manifest,
    state.environment,
  );
}

export async function materializeManifestEntries<TOptions extends object>(
  writer: RemoteManifestWriter,
  manifest: Manifest,
  providerLabel: string,
  resolvePath: RemoteSandboxPathResolver,
  materializeEntry: ManifestEntryMaterializer<TOptions>,
  options: TOptions,
): Promise<void> {
  const deferredOptions = {
    ...options,
    skipMountEntries: true,
  } as TOptions;

  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (isMount(entry)) {
      continue;
    }
    const logicalPath = normalizeRelativePath(path);
    const absolutePath = await resolvePath(logicalPath, { forWrite: true });
    const entryOptions = {
      ...deferredOptions,
      resolvePath,
      logicalPath,
    };
    await materializeEntry(
      writer,
      absolutePath,
      entry,
      providerLabel,
      entryOptions as TOptions,
    );
  }

  for (const {
    mountPath,
    entry,
  } of manifest.mountTargetsForMaterialization()) {
    const logicalPath = resolveSandboxRelativePath(manifest.root, mountPath);
    const absolutePath = await resolvePath(logicalPath, { forWrite: true });
    await materializeEntry(writer, absolutePath, entry, providerLabel, options);
  }
}

export async function materializeInlineManifestEntry(
  writer: RemoteManifestWriter,
  absolutePath: string,
  entry: Entry,
  providerLabel: string,
  options: ManifestMaterializationOptions = {},
): Promise<void> {
  if (isMount(entry)) {
    if ((options as DeferredMountMaterializationOptions).skipMountEntries) {
      return;
    }
    if (options.materializeMount) {
      await options.materializeMount(absolutePath, entry);
      return;
    }
    throw new SandboxUnsupportedFeatureError(
      `${providerLabel} does not support mount entries yet: ${absolutePath}`,
    );
  }

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
          await materializeInlineManifestEntry(
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
    case 'file':
      await writer.writeFile(absolutePath, entry.content);
      break;
    case 'local_file':
    case 'local_dir':
    case 'git_repo':
      // This helper can run in Worker/browser-like runtimes where host filesystem
      // access is unavailable; Node adapters use shared/localSources for these entries.
      throw new UserError(
        `${providerLabel} cannot materialize ${entry.type} entries in this runtime. Use inline file or dir entries, or materialize local sources from a Node-compatible runtime.`,
      );
    default:
      throw new UserError(
        `Unsupported sandbox entry type: ${(entry as Entry).type}`,
      );
  }

  await options.applyMetadata?.(absolutePath, entry);
}

export async function resolveMaterializedChildPath(
  parentAbsolutePath: string,
  childPath: string,
  options: ManifestMaterializationOptions,
): Promise<{ absolutePath: string; logicalPath?: string }> {
  const normalizedChildPath = normalizeRelativePath(childPath);
  const logicalPath =
    options.logicalPath !== undefined
      ? options.logicalPath
        ? `${options.logicalPath}/${normalizedChildPath}`
        : normalizedChildPath
      : undefined;

  if (options.resolvePath && logicalPath !== undefined) {
    return {
      absolutePath: await options.resolvePath(logicalPath, { forWrite: true }),
      logicalPath,
    };
  }

  return {
    absolutePath: `${parentAbsolutePath}/${normalizedChildPath}`,
    logicalPath,
  };
}

function removeMountEntries(
  entries: Record<string, Entry>,
): Record<string, Entry> {
  const result: Record<string, Entry> = {};
  for (const [path, entry] of Object.entries(entries)) {
    if (isMount(entry)) {
      continue;
    }
    if (entry.type === 'dir' && entry.children) {
      result[path] = {
        ...structuredClone(entry),
        children: removeMountEntries(entry.children),
      };
      continue;
    }
    result[path] = structuredClone(entry);
  }
  return result;
}
