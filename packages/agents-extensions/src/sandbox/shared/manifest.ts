import { UserError } from '@openai/agents-core';
import {
  Environment,
  isEnvValueReference,
  isMount,
  Manifest,
  normalizeRelativePath,
  type SandboxConcurrencyLimits,
  SandboxMountError,
  SandboxUnsupportedFeatureError,
  type Entry,
  type Mount,
  type TypedMount,
} from '@openai/agents-core/sandbox';
import {
  assertExistingMountTopologyPreserved,
  assertProcessEnvironmentDestinationsPreserved,
  captureLiveMountCredentialAuthority,
  copyValidatedMountEffectivePaths,
  copyManifestMountCredentialExposurePolicy,
  copyProcessEnvironmentProtection,
  deserializeManifest,
  mountCredentialFileReferences,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  normalizePosixPath,
  relativePosixPathWithinRoot,
  serializeManifestRecord,
  stableJsonStringify,
  validateMountCredentialBoundariesAtEffectivePath,
  validateMountCredentialBoundaries,
  validateMountCredentialFileEffectivePaths,
} from '@openai/agents-core/sandbox/internal';
import { mergeMaterializedEnvironment } from './environment';
import {
  resolveSandboxAbsolutePath,
  resolveSandboxRelativePath,
} from './paths';
import type { RemoteManifestWriter } from './types';
import type {
  RemoteSandboxCredentialPathResolver,
  RemoteSandboxPathResolver,
} from './types';

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

export function manifestWithMaterializedEnvironmentReferences(
  manifest: Manifest,
  environment: Record<string, string>,
): Manifest {
  const materializedManifest = cloneManifestWithOverrides(manifest);
  for (const [key, value] of Object.entries(manifest.environment)) {
    if (isEnvValueReference(value) && typeof environment[key] === 'string') {
      materializedManifest.environment[key] = new Environment({
        value: environment[key],
        ...(value.ephemeral ? { ephemeral: true } : {}),
        ...(value.description ? { description: value.description } : {}),
      });
    }
  }
  return materializedManifest;
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
  const cloned = new Manifest({
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
  // Preserve runtime-only trusted mount policy while cloning provider manifests.
  copyManifestMountCredentialExposurePolicy(cloned, manifest);
  copyProcessEnvironmentProtection(cloned, manifest);
  return cloned;
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
    context: ManifestMountMaterializationContext,
  ) => Promise<void>;
  applyMetadata?: (absolutePath: string, entry: Entry) => Promise<void>;
  concurrencyLimits?: SandboxConcurrencyLimits;
  localSourceBaseDir?: string;
  localSourceGrants?: Manifest['extraPathGrants'];
  resolvePath?: RemoteSandboxPathResolver;
  logicalPath?: string;
  validateManifest?: (
    manifest: Manifest,
    environment: Record<string, string>,
  ) => void;
  preparedMounts?: readonly PreparedManifestMount[];
  resolveCredentialPath?: RemoteSandboxCredentialPathResolver;
  mountEnvironmentOverrides?: Readonly<Record<string, string>>;
};

export type PreparedManifestMount = {
  logicalPath: string;
  absolutePath: string;
  entry: Mount | TypedMount;
  credentialExposureAcknowledged: boolean;
  broadCredentialExposureAcknowledged: boolean;
  environment?: Readonly<Record<string, string>>;
  revalidateMountAuthority: () => Promise<void>;
};

export type ManifestMountMaterializationContext = {
  environment?: Readonly<Record<string, string>>;
  allowAmbientCredentials?: boolean;
  revalidateMountAuthority?: () => Promise<void>;
};

type DeferredMountMaterializationOptions = ManifestMaterializationOptions & {
  skipMountEntries?: boolean;
  materializationEnvironment?: Readonly<Record<string, string>>;
  preparedMountEnvironment?: Readonly<Record<string, string>>;
  broadCredentialExposureAcknowledged?: boolean;
  revalidateMountAuthority?: () => Promise<void>;
};

export type MaterializedManifestState = {
  manifest: Manifest;
  environment: Record<string, string>;
};

export type MaterializedManifestEntryState = {
  manifest: Manifest;
  environment?: Record<string, string>;
};

export type PreparedMaterializedManifestTransition = {
  previousManifest: Manifest;
  deltaManifest: Manifest;
  nextManifest: Manifest;
  nextEnvironment: Record<string, string>;
  materializedManifest: Manifest;
  preparedMounts: readonly PreparedManifestMount[];
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
  TOptions extends ManifestMaterializationOptions,
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
  const nextManifest = mergeManifestEntryDelta(
    state.manifest,
    logicalPath,
    entry,
  );
  assertExistingMountTopologyPreserved(state.manifest, nextManifest);
  validateMountCredentialBoundaries(nextManifest);
  options.validateManifest?.(nextManifest, state.environment ?? {});
  const entryManifest = new Manifest({
    root: state.manifest.root,
    entries: {
      [logicalPath]: entry,
    },
  });
  copyManifestMountCredentialExposurePolicy(entryManifest, nextManifest);
  const materializationOptions = {
    ...options,
    preparedMounts:
      options.preparedMounts ??
      (await prepareManifestMounts(entryManifest, resolvePath, {
        credentialBoundaryManifest: nextManifest,
        environment: state.environment ?? {},
        resolveCredentialPath: options.resolveCredentialPath,
      })),
    materializationEnvironment: state.environment ?? {},
  } as TOptions & DeferredMountMaterializationOptions;
  await materializeManifestEntries(
    writer,
    entryManifest,
    providerLabel,
    resolvePath,
    materializeEntry,
    materializationOptions,
  );
  copyValidatedMountEffectivePaths(nextManifest, state.manifest, entryManifest);
  state.manifest = nextManifest;
  captureLiveMountCredentialAuthority(state.manifest);
}

export async function applyMaterializedManifestToState<
  TOptions extends ManifestMaterializationOptions,
>(
  state: MaterializedManifestState,
  manifest: Manifest,
  providerLabel: string,
  writer: RemoteManifestWriter,
  resolvePath: RemoteSandboxPathResolver,
  materializeEntry: ManifestEntryMaterializer<TOptions>,
  options: TOptions,
  preparedTransition?: PreparedMaterializedManifestTransition,
): Promise<void> {
  const transition =
    preparedTransition ??
    (await prepareMaterializedManifestTransition(
      state,
      manifest,
      options,
      resolvePath,
    ));
  if (transition.previousManifest !== state.manifest) {
    throw new UserError(
      'Sandbox manifest changed while a manifest transition was being prepared.',
    );
  }
  const materializationOptions = {
    ...options,
    preparedMounts: transition.preparedMounts,
    materializationEnvironment: transition.nextEnvironment,
  } as TOptions & DeferredMountMaterializationOptions;
  await materializeManifestEntries(
    writer,
    transition.materializedManifest,
    providerLabel,
    resolvePath,
    materializeEntry,
    materializationOptions,
  );
  copyValidatedMountEffectivePaths(
    transition.nextManifest,
    transition.previousManifest,
    transition.materializedManifest,
  );
  state.manifest = transition.nextManifest;
  captureLiveMountCredentialAuthority(state.manifest);
  state.environment = transition.nextEnvironment;
}

export async function prepareMaterializedManifestTransition<
  TOptions extends ManifestMaterializationOptions,
>(
  state: MaterializedManifestState,
  manifest: Manifest,
  options: TOptions,
  resolvePath: RemoteSandboxPathResolver,
): Promise<PreparedMaterializedManifestTransition> {
  const previousManifest = state.manifest;
  const deltaManifest = cloneManifestWithOverrides(manifest);
  assertProcessEnvironmentDestinationsPreserved(
    previousManifest,
    deltaManifest,
  );
  const nextManifest = mergeManifestDelta(previousManifest, deltaManifest);
  assertExistingMountTopologyPreserved(previousManifest, nextManifest);
  const nextEnvironment = await mergeMaterializedEnvironment(
    previousManifest,
    nextManifest,
    state.environment,
  );
  validateMountCredentialBoundaries(nextManifest);
  const mountEnvironment = {
    ...nextEnvironment,
    ...options.mountEnvironmentOverrides,
  };
  options.validateManifest?.(nextManifest, mountEnvironment);
  const materializedManifest = cloneManifestWithOverrides(deltaManifest);
  copyManifestMountCredentialExposurePolicy(
    materializedManifest,
    previousManifest,
    deltaManifest,
  );
  const preparedMounts = await prepareManifestMounts(
    materializedManifest,
    resolvePath,
    {
      credentialBoundaryManifest: nextManifest,
      environment: mountEnvironment,
      resolveCredentialPath: options.resolveCredentialPath,
    },
  );
  return {
    previousManifest,
    deltaManifest,
    nextManifest,
    nextEnvironment,
    materializedManifest,
    preparedMounts,
  };
}

export async function prepareManifestMounts(
  manifest: Manifest,
  resolvePath: RemoteSandboxPathResolver,
  options: {
    credentialBoundaryManifest?: Manifest;
    environment?: Record<string, string>;
    resolveCredentialPath?: RemoteSandboxCredentialPathResolver;
  } = {},
): Promise<PreparedManifestMount[]> {
  validateMountCredentialBoundaries(manifest);
  const credentialBoundaryManifest =
    options.credentialBoundaryManifest ?? manifest;
  const preparedMounts: PreparedManifestMount[] = [];
  const preparedLogicalPaths = new Set<string>();
  for (const {
    logicalPath,
    mountPath,
    entry,
  } of manifest.mountTargetsForMaterialization()) {
    const resolvedPath = resolveSandboxRelativePath(manifest.root, mountPath);
    const prepareCandidate = async () => {
      const absolutePath = await resolvePath(resolvedPath, { forWrite: true });
      const preparedCredentialFiles = await prepareMountCredentialFiles({
        manifest: credentialBoundaryManifest,
        entry,
        mountPath,
        environment: options.environment ?? {},
        resolvePath,
        resolveCredentialPath:
          options.resolveCredentialPath ??
          (async (path) => await resolvePath(path, { forWrite: false })),
      });
      return {
        absolutePath,
        entry: preparedCredentialFiles.entry,
        ...validateMountCredentialBoundariesAtEffectivePath(
          manifest,
          logicalPath,
          entry,
          absolutePath,
        ),
        environment: preparedCredentialFiles.environment,
      };
    };
    const candidate = await prepareCandidate();
    const preparedMount: PreparedManifestMount = {
      logicalPath,
      ...candidate,
      revalidateMountAuthority: async () => {
        if (!candidate.credentialExposureAcknowledged) {
          return;
        }
        const current = await prepareCandidate();
        if (
          current.absolutePath !== candidate.absolutePath ||
          current.credentialExposureAcknowledged !==
            candidate.credentialExposureAcknowledged ||
          current.broadCredentialExposureAcknowledged !==
            candidate.broadCredentialExposureAcknowledged ||
          stableJsonStringify(current.entry) !==
            stableJsonStringify(candidate.entry) ||
          stableJsonStringify(current.environment) !==
            stableJsonStringify(candidate.environment)
        ) {
          throw new SandboxMountError(
            'Sandbox mount authority changed after validation. Retry from current trusted configuration.',
            { mountType: entry.type },
            'mount_config_invalid',
          );
        }
      },
    };
    preparedMounts.push(preparedMount);
    preparedLogicalPaths.add(logicalPath);
  }
  for (const {
    logicalPath,
    mountPath,
    entry,
  } of credentialBoundaryManifest.mountTargetsForMaterialization()) {
    if (preparedLogicalPaths.has(logicalPath)) {
      continue;
    }
    await prepareMountCredentialFiles({
      manifest: credentialBoundaryManifest,
      entry,
      mountPath,
      environment: options.environment ?? {},
      resolvePath,
      resolveCredentialPath:
        options.resolveCredentialPath ??
        (async (path) => await resolvePath(path, { forWrite: false })),
    });
  }
  return preparedMounts;
}

async function prepareMountCredentialFiles(args: {
  manifest: Manifest;
  entry: Mount | TypedMount;
  mountPath: string;
  environment: Record<string, string>;
  resolvePath: RemoteSandboxPathResolver;
  resolveCredentialPath: RemoteSandboxCredentialPathResolver;
}): Promise<{
  entry: Mount | TypedMount;
  environment?: Readonly<Record<string, string>>;
}> {
  const references = mountCredentialFileReferences(
    args.manifest,
    args.entry,
    args.environment,
  );
  if (references.length === 0) {
    return { entry: structuredClone(args.entry) };
  }
  const manifestEntries = await Promise.all(
    [...args.manifest.iterEntries()]
      .filter(({ entry }) => !isMount(entry))
      .map(async ({ logicalPath, entry }) => ({
        path: await args.resolveCredentialPath(
          resolveSandboxAbsolutePath(args.manifest.root, logicalPath, {
            forWrite: true,
            extraPathGrants: args.manifest.extraPathGrants,
          }),
        ),
        recursive: entry.type === 'local_dir' || entry.type === 'git_repo',
      })),
  );
  const resolvedReferences = await Promise.all(
    references.map(async ({ field, path }) => ({
      field,
      path: await args.resolveCredentialPath(path),
    })),
  );
  validateMountCredentialFileEffectivePaths({
    entry: args.entry,
    mountPath: args.mountPath,
    credentialFiles: resolvedReferences,
    manifestEntries,
  });
  const preparedEntry = structuredClone(args.entry) as Record<string, unknown>;
  let preparedEnvironment: Record<string, string> | undefined;
  for (const reference of resolvedReferences) {
    if (reference.field.startsWith('environment.')) {
      preparedEnvironment ??= { ...args.environment };
      preparedEnvironment[reference.field.slice('environment.'.length)] =
        reference.path;
      continue;
    }
    writeNestedField(preparedEntry, reference.field, reference.path);
  }
  return {
    entry: preparedEntry as Mount | TypedMount,
    environment: preparedEnvironment,
  };
}

function writeNestedField(
  record: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  const segments = field.split('.');
  let current = record;
  for (const segment of segments.slice(0, -1)) {
    if (typeof current[segment] !== 'object' || current[segment] === null) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

export async function materializeManifestEntries<TOptions extends object>(
  writer: RemoteManifestWriter,
  manifest: Manifest,
  providerLabel: string,
  resolvePath: RemoteSandboxPathResolver,
  materializeEntry: ManifestEntryMaterializer<TOptions>,
  options: TOptions,
): Promise<void> {
  validateMountCredentialBoundaries(manifest);
  const deferredOptions = {
    ...options,
    skipMountEntries: true,
  } as TOptions;
  const resolvedMounts = await preparedMountsForManifest(
    manifest,
    resolvePath,
    options as DeferredMountMaterializationOptions,
  );

  const entries = Object.entries(manifest.entries).filter(
    ([, entry]) => !isMount(entry),
  );
  await runLimited(
    entries,
    resolveManifestEntryConcurrency(
      (options as ManifestMaterializationOptions).concurrencyLimits,
    ),
    async ([path, entry]) => {
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
    },
  );

  for (const {
    absolutePath,
    entry,
    broadCredentialExposureAcknowledged,
    environment,
    revalidateMountAuthority,
  } of resolvedMounts) {
    await revalidateMountAuthority();
    await materializeEntry(writer, absolutePath, entry, providerLabel, {
      ...options,
      broadCredentialExposureAcknowledged,
      preparedMountEnvironment: environment,
      revalidateMountAuthority,
    });
  }
}

async function preparedMountsForManifest(
  manifest: Manifest,
  resolvePath: RemoteSandboxPathResolver,
  options: DeferredMountMaterializationOptions,
): Promise<PreparedManifestMount[]> {
  const preparedMounts = options.preparedMounts;
  if (!preparedMounts) {
    return await prepareManifestMounts(manifest, resolvePath, {
      credentialBoundaryManifest: manifest,
      environment: {
        ...(options.materializationEnvironment ?? {}),
      },
      resolveCredentialPath: options.resolveCredentialPath,
    });
  }
  const targets = new Map(
    manifest
      .mountTargetsForMaterialization()
      .map((target) => [target.logicalPath, target]),
  );
  if (targets.size !== preparedMounts.length) {
    throw new UserError(
      'Prepared sandbox mount candidates do not match the materialized manifest.',
    );
  }
  return preparedMounts.map((prepared) => {
    const target = targets.get(prepared.logicalPath);
    if (!target) {
      throw new UserError(
        'Prepared sandbox mount candidate no longer exists in the materialized manifest.',
      );
    }
    return {
      ...prepared,
      ...validateMountCredentialBoundariesAtEffectivePath(
        manifest,
        target.logicalPath,
        target.entry,
        prepared.absolutePath,
      ),
    };
  });
}

export async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
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

export function resolveManifestEntryConcurrency(
  limits?: SandboxConcurrencyLimits,
): number {
  return normalizeConcurrencyLimit(limits?.manifestEntries, 4);
}

export function resolveLocalDirFileConcurrency(
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
      await options.materializeMount(absolutePath, entry, {
        environment:
          (options as DeferredMountMaterializationOptions)
            .preparedMountEnvironment ??
          (options as DeferredMountMaterializationOptions)
            .materializationEnvironment,
        allowAmbientCredentials: (
          options as DeferredMountMaterializationOptions
        ).broadCredentialExposureAcknowledged,
        revalidateMountAuthority: (
          options as DeferredMountMaterializationOptions
        ).revalidateMountAuthority,
      });
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
