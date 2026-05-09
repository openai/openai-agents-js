import {
  type Entry,
  isDir,
  isGitRepo,
  isMount,
  type Mount,
  type MountProvider,
  type MountStrategy,
  type TypedMount,
} from './entries';
import {
  normalizePathGrant,
  type SandboxPathGrant,
  type SandboxPathGrantInit,
} from './pathGrants';
import { normalizePermissions } from './permissions';
import {
  normalizeEntryGroup,
  normalizeGroup,
  normalizeUser,
  type SandboxGroup,
  type SandboxGroupInit,
  type SandboxUser,
  type SandboxUserInit,
} from './users';
import { DEFAULT_REMOTE_MOUNT_COMMAND_ALLOWLIST } from './shared/remoteMountCommandAllowlist';
import {
  hasBackslashPathSeparator,
  hasParentPathSegment,
  normalizePosixPath,
  relativePosixPathWithinRoot,
} from './shared/posixPath';
import { isRecord } from './shared/typeGuards';
import { SandboxGitSubpathError } from './errors';

export type EnvResolver = () => string | Promise<string>;

export type EnvValue = {
  value: string;
  resolve?: EnvResolver;
  ephemeral?: boolean;
  description?: string;
};

export type EnvEntry = string | EnvResolver | EnvValue | Environment;

export type RenderManifestDescriptionOptions = {
  depth?: number | null;
  maxLines?: number;
  maxChars?: number;
};

export type ManifestEntries = Record<string, Entry>;

export type ManifestEnvironment = Record<string, EnvEntry>;

type ManifestEnvironmentValues<TEnvironment extends ManifestEnvironment> = {
  [Key in keyof TEnvironment]: Environment;
};

export class Environment {
  readonly value: string;
  readonly resolver?: EnvResolver;
  readonly ephemeral: boolean;
  readonly description?: string;

  constructor(entry: EnvEntry) {
    if (entry instanceof Environment) {
      this.value = entry.value;
      this.resolver = entry.resolver;
      this.ephemeral = entry.ephemeral;
      this.description = entry.description;
      return;
    }

    if (typeof entry === 'string') {
      this.value = entry;
      this.resolver = undefined;
      this.ephemeral = false;
      this.description = undefined;
      return;
    }

    if (typeof entry === 'function') {
      this.value = '';
      this.resolver = entry;
      this.ephemeral = false;
      this.description = undefined;
      return;
    }

    this.value = entry.value;
    this.resolver = entry.resolve;
    this.ephemeral = entry.ephemeral ?? false;
    this.description = entry.description;
  }

  async resolve(): Promise<string> {
    const value = this.resolver ? await this.resolver() : this.value;
    if (typeof value !== 'string') {
      throw new Error('Environment resolvers must return a string.');
    }
    return value;
  }

  init(): EnvValue {
    return {
      ...this.normalized(),
      ...(this.resolver ? { resolve: this.resolver } : {}),
    };
  }

  normalized(): EnvValue {
    return {
      value: this.value,
      ...(this.ephemeral ? { ephemeral: true } : {}),
      ...(this.description ? { description: this.description } : {}),
    };
  }
}

export type ManifestInit<
  TEntries extends ManifestEntries = ManifestEntries,
  TEnvironment extends ManifestEnvironment = ManifestEnvironment,
> = {
  version?: number;
  root?: string;
  entries?: TEntries;
  environment?: TEnvironment;
  users?: SandboxUserInit[];
  groups?: SandboxGroupInit[];
  extraPathGrants?: SandboxPathGrantInit[];
  remoteMountCommandAllowlist?: string[];
};

type IterEntry = {
  logicalPath: string;
  absolutePath: string;
  entry: Entry;
  depth: number;
};

export type ManifestMountTarget = IterEntry & {
  entry: Mount | TypedMount;
  mountPath: string;
};

type RenderedManifestDescription = {
  text: string;
  renderedPaths: number;
  totalPaths: number;
};

export class Manifest<
  TEntries extends ManifestEntries = ManifestEntries,
  TEnvironment extends ManifestEnvironment = ManifestEnvironment,
> {
  readonly version: number;
  readonly root: string;
  readonly entries: TEntries;
  readonly environment: ManifestEnvironmentValues<TEnvironment>;
  readonly users: SandboxUser[];
  readonly groups: SandboxGroup[];
  readonly extraPathGrants: SandboxPathGrant[];
  readonly remoteMountCommandAllowlist: string[];

  constructor(init: ManifestInit<TEntries, TEnvironment> = {}) {
    rejectKnownSnakeCaseKeys(
      init as Record<string, unknown>,
      ['extra_path_grants', 'remote_mount_command_allowlist'],
      'sandbox manifest config',
    );
    this.version = init.version ?? 1;
    this.root = normalizeRoot(init.root ?? '/workspace');
    this.entries = normalizeEntries(init.entries ?? {}) as TEntries;
    this.environment = Object.fromEntries(
      Object.entries(init.environment ?? {}).map(([key, value]) => [
        key,
        new Environment(value),
      ]),
    ) as ManifestEnvironmentValues<TEnvironment>;
    this.users = (init.users ?? []).map((user) => normalizeUser(user));
    this.groups = (init.groups ?? []).map((group) => normalizeGroup(group));
    this.extraPathGrants = (init.extraPathGrants ?? []).map((grant) =>
      normalizePathGrant(grant),
    );
    this.remoteMountCommandAllowlist = [
      ...(init.remoteMountCommandAllowlist ??
        DEFAULT_REMOTE_MOUNT_COMMAND_ALLOWLIST),
    ];
  }

  validatedEntries(): Record<string, Entry> {
    for (const _entry of this.iterEntries()) {
      continue;
    }

    return { ...this.entries };
  }

  *iterEntries(): Generator<IterEntry> {
    const queue = Object.entries(this.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, entry]) => {
        const normalizedPath = normalizeRelativePath(path);
        return {
          logicalPath: normalizedPath,
          absolutePath: joinAbsolutePath(this.root, normalizedPath),
          entry,
          depth: 1,
        };
      });

    while (queue.length > 0) {
      const current = queue.shift()!;
      yield current;

      if (!isDir(current.entry) || !current.entry.children) {
        continue;
      }

      const children = Object.entries(current.entry.children)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childPath, childEntry]) => {
          const normalizedChildPath = normalizeRelativePath(childPath);
          const logicalPath = current.logicalPath
            ? `${current.logicalPath}/${normalizedChildPath}`
            : normalizedChildPath;
          return {
            logicalPath,
            absolutePath: joinAbsolutePath(this.root, logicalPath),
            entry: childEntry,
            depth: current.depth + 1,
          };
        });

      queue.unshift(...children);
    }
  }

  ephemeralEntryPaths(): Set<string> {
    const paths = new Set<string>();

    for (const { logicalPath, entry } of this.iterEntries()) {
      if (entry.ephemeral) {
        paths.add(logicalPath);
      }
    }

    return paths;
  }

  /**
   * Returns mount targets in most-specific-first order for path resolution.
   */
  mountTargets(): ManifestMountTarget[] {
    return collectMountTargets(this).sort(compareMountTargetsForResolution);
  }

  /**
   * Returns mount targets in parent-first order for filesystem materializers.
   */
  mountTargetsForMaterialization(): ManifestMountTarget[] {
    return collectMountTargets(this).sort(
      compareMountTargetsForMaterialization,
    );
  }

  ephemeralMountTargets(): ManifestMountTarget[] {
    return this.mountTargets().filter(({ entry }) => entry.ephemeral);
  }

  ephemeralPersistencePaths(): Set<string> {
    const paths = this.ephemeralEntryPaths();

    // Ephemeral mounts are keyed by their effective mount path because mountPath can
    // differ from the manifest entry's logical path.
    for (const { mountPath } of this.ephemeralMountTargets()) {
      const relativePath = relativePathWithinRoot(this.root, mountPath);
      if (relativePath !== null) {
        paths.add(relativePath);
      }
    }

    return paths;
  }

  async resolveEnvironment(
    overrides: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    return {
      ...Object.fromEntries(
        await Promise.all(
          Object.entries(this.environment).map(async ([key, value]) => [
            key,
            await value.resolve(),
          ]),
        ),
      ),
      ...overrides,
    };
  }

  describe(depth: number = 1): string {
    return renderManifestDescription(this, { depth }).text;
  }
}

export type ManifestInput<
  TEntries extends ManifestEntries = ManifestEntries,
  TEnvironment extends ManifestEnvironment = ManifestEnvironment,
> = Manifest<TEntries, TEnvironment> | ManifestInit<TEntries, TEnvironment>;

export function cloneManifest(manifest: ManifestInput): Manifest {
  return new Manifest({
    version: manifest.version,
    root: manifest.root,
    entries: structuredClone(manifest.entries ?? {}),
    environment: Object.fromEntries(
      Object.entries(manifest.environment ?? {}).map(([key, value]) => [
        key,
        value instanceof Environment ? value.init() : value,
      ]),
    ),
    users: structuredClone(manifest.users ?? []),
    groups: structuredClone(manifest.groups ?? []),
    extraPathGrants: structuredClone(manifest.extraPathGrants ?? []),
    remoteMountCommandAllowlist: structuredClone(
      manifest.remoteMountCommandAllowlist ??
        DEFAULT_REMOTE_MOUNT_COMMAND_ALLOWLIST,
    ),
  });
}

export function normalizeRelativePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') {
    return '';
  }
  if (hasBackslashPathSeparator(path)) {
    throw new Error(`Manifest path "${path}" must use "/" separators.`);
  }
  if (trimmed.startsWith('/')) {
    throw new Error(`Manifest path "${path}" must be relative.`);
  }
  if (hasParentPathSegment(path)) {
    throw new Error(
      `Manifest path "${path}" must not contain parent segments.`,
    );
  }

  const normalized = normalizePosixPath(path);
  return normalized === '.' ? '' : normalized;
}

function normalizeGitRepoSubpath(repo: string, subpath: string): string {
  const trimmed = subpath.trim();
  let reason:
    | 'absolute'
    | 'empty'
    | 'parent_traversal'
    | 'windows_path'
    | undefined;

  if (subpath === '' || normalizePosixPath(trimmed) === '.') {
    return '';
  }

  if (!trimmed) {
    reason = 'empty';
  } else if (
    hasBackslashPathSeparator(subpath) ||
    /^[A-Za-z]:($|\/)/.test(trimmed)
  ) {
    reason = 'windows_path';
  } else if (trimmed.startsWith('/')) {
    reason = 'absolute';
  } else if (hasParentPathSegment(subpath)) {
    reason = 'parent_traversal';
  }

  if (reason) {
    throw new SandboxGitSubpathError(
      `git_repo subpath must be a relative path inside the repository: ${subpath}`,
      { repo, subpath, reason },
    );
  }

  return normalizePosixPath(trimmed);
}

export function renderManifestDescription(
  manifest: Manifest,
  options: RenderManifestDescriptionOptions = {},
): RenderedManifestDescription {
  const maxDepth = options.depth ?? null;
  const maxLines = options.maxLines ?? 120;
  const maxChars = options.maxChars ?? 12_000;
  const lines: string[] = [manifest.root];
  let renderedChars = manifest.root.length;

  const entries = [...manifest.iterEntries()];
  let renderedPaths = 0;

  for (const { logicalPath, absolutePath, entry, depth } of entries) {
    if (maxDepth !== null && depth > maxDepth) {
      continue;
    }
    if (lines.length >= maxLines) {
      break;
    }

    const indent = depth <= 1 ? '' : '  '.repeat(depth - 1);
    const name = logicalPath.split('/').pop() ?? logicalPath;
    const label = entry.type === 'dir' ? `${name}/` : name;
    const description = entry.description ? ` - ${entry.description}` : '';
    const line = `${indent}${label} # ${absolutePath}${description}`;
    if (!lineFits(lines, line, maxChars, renderedChars)) {
      break;
    }
    lines.push(line);
    renderedChars += lineCharCost(lines, line);
    renderedPaths += 1;
  }

  const totalPaths = entries.filter(
    ({ depth }) => maxDepth === null || depth <= maxDepth,
  ).length;

  if (renderedPaths < totalPaths) {
    renderedChars = appendLineIfFits(
      lines,
      `... (truncated ${totalPaths - renderedPaths} additional paths)`,
      maxChars,
      renderedChars,
    );
    appendLineIfFits(
      lines,
      `Hint: increase depth, maxLines, or maxChars to see more of the manifest layout.`,
      maxChars,
      renderedChars,
    );
  }

  return {
    text: lines.join('\n'),
    renderedPaths,
    totalPaths,
  };
}

function appendLineIfFits(
  lines: string[],
  line: string,
  maxChars: number,
  currentChars: number,
): number {
  if (!lineFits(lines, line, maxChars, currentChars)) {
    return currentChars;
  }
  lines.push(line);
  return currentChars + lineCharCost(lines, line);
}

function lineFits(
  lines: string[],
  line: string,
  maxChars: number,
  currentChars: number,
): boolean {
  return currentChars + lineCharCost(lines, line) <= maxChars;
}

function lineCharCost(lines: string[], line: string): number {
  return (lines.length > 0 ? 1 : 0) + line.length;
}

function normalizeRoot(root: string): string {
  const trimmed = root.trim();
  if (hasBackslashPathSeparator(root)) {
    throw new Error(`Manifest root "${root}" must use "/" separators.`);
  }
  if (!trimmed.startsWith('/')) {
    throw new Error(`Manifest root "${root}" must be absolute.`);
  }
  if (hasParentPathSegment(root)) {
    throw new Error(
      `Manifest root "${root}" must not contain parent segments.`,
    );
  }

  return normalizePosixPath(root);
}

function joinAbsolutePath(root: string, relativePath: string): string {
  const normalizedRoot = normalizeRoot(root);
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  if (!normalizedRelativePath) {
    return normalizedRoot;
  }
  if (normalizedRoot === '/') {
    return `/${normalizedRelativePath}`;
  }
  return `${normalizedRoot}/${normalizedRelativePath}`;
}

function resolveMountPathForRoot(
  root: string,
  absolutePath: string,
  mountPath?: string,
): string {
  if (mountPath === undefined) {
    return absolutePath;
  }
  if (mountPath.startsWith('/')) {
    return normalizeRoot(mountPath);
  }
  return joinAbsolutePath(root, mountPath);
}

function relativePathWithinRoot(root: string, path: string): string | null {
  const normalizedRoot = normalizeRoot(root);
  const normalizedPath = normalizeRoot(path);
  return relativePosixPathWithinRoot(normalizedRoot, normalizedPath);
}

function collectMountTargets(manifest: Manifest): ManifestMountTarget[] {
  const targets: ManifestMountTarget[] = [];

  for (const iterEntry of manifest.iterEntries()) {
    if (!isMount(iterEntry.entry)) {
      continue;
    }
    targets.push({
      ...iterEntry,
      entry: iterEntry.entry,
      mountPath: resolveMountPathForRoot(
        manifest.root,
        iterEntry.absolutePath,
        iterEntry.entry.mountPath,
      ),
    });
  }

  return targets;
}

function compareMountTargetsForResolution(
  left: ManifestMountTarget,
  right: ManifestMountTarget,
): number {
  // Path resolution needs the most specific nested mount before its parent.
  const depthDelta =
    mountPathDepth(right.mountPath) - mountPathDepth(left.mountPath);
  return depthDelta || left.mountPath.localeCompare(right.mountPath);
}

function compareMountTargetsForMaterialization(
  left: ManifestMountTarget,
  right: ManifestMountTarget,
): number {
  // Mount creation needs parents first so broader targets do not replace children.
  const depthDelta =
    mountPathDepth(left.mountPath) - mountPathDepth(right.mountPath);
  return depthDelta || left.mountPath.localeCompare(right.mountPath);
}

function mountPathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function normalizeEntries(
  entries: ManifestEntries,
  parentPath = '',
  seenPaths: Set<string> = new Set(),
): ManifestEntries {
  const normalizedEntries: ManifestEntries = {};
  for (const [path, entry] of Object.entries(entries)) {
    const normalizedPath = normalizeRelativePath(path);
    const logicalPath = parentPath
      ? `${parentPath}/${normalizedPath}`
      : normalizedPath;
    if (seenPaths.has(logicalPath)) {
      throw new Error(
        `Manifest path "${path}" duplicates normalized path "${logicalPath}".`,
      );
    }
    seenPaths.add(logicalPath);
    if (
      Object.prototype.hasOwnProperty.call(normalizedEntries, normalizedPath)
    ) {
      throw new Error(
        `Manifest path "${path}" duplicates normalized path "${normalizedPath}".`,
      );
    }
    normalizedEntries[normalizedPath] = normalizeEntry(
      entry,
      logicalPath,
      seenPaths,
    );
  }
  return normalizedEntries;
}

function normalizeEntry(
  entry: Entry,
  logicalPath: string,
  seenPaths: Set<string>,
): Entry {
  const normalized = structuredClone(entry) as Entry;
  if (normalized.permissions !== undefined) {
    normalized.permissions = normalizePermissions(normalized.permissions);
  }
  if (normalized.group !== undefined) {
    normalized.group = normalizeEntryGroup(normalized.group);
  }
  if (isDir(normalized) && normalized.children) {
    normalized.children = normalizeEntries(
      normalized.children,
      logicalPath,
      seenPaths,
    );
  }
  if (isGitRepo(normalized)) {
    const repo = normalized.repo;
    if (!repo || typeof repo !== 'string' || !repo.trim()) {
      throw new Error('git_repo entries must include a non-empty repo.');
    }
    normalized.repo = repo.trim();
    normalized.host = normalizeGitHost(normalized.host);
    if (normalized.subpath !== undefined) {
      normalized.subpath = normalizeGitRepoSubpath(
        normalized.repo,
        normalized.subpath,
      );
    }
  }
  if (isMount(normalized)) {
    normalized.ephemeral = normalized.ephemeral ?? true;
    rejectKnownSnakeCaseMountKeys(normalized);
    if (normalized.mountPath !== undefined) {
      normalized.mountPath = normalizeMountPath(normalized.mountPath);
    }

    normalized.readOnly = normalized.readOnly ?? true;

    if (normalized.mountStrategy !== undefined) {
      normalized.mountStrategy = normalizeMountStrategy(
        normalized.mountStrategy,
      );
    }
    normalizeTypedMountProvider(normalized);
  }
  return normalized;
}

function normalizeGitHost(host: string | undefined): string {
  const normalizedHost = (host ?? 'github.com').trim();
  if (!normalizedHost) {
    throw new Error('git_repo host must be non-empty.');
  }
  return normalizedHost;
}

function normalizeMountPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('Mount path must not be empty.');
  }
  if (hasBackslashPathSeparator(path)) {
    throw new Error('Mount path must use "/" separators.');
  }
  if (!trimmed.startsWith('/')) {
    return normalizeRelativePath(trimmed);
  }

  return normalizeRoot(trimmed);
}

function normalizeMountStrategy(strategy: unknown): MountStrategy {
  if (!isRecord(strategy)) {
    throw new Error('Mount strategy must be an object.');
  }
  if (typeof strategy.type !== 'string' || !strategy.type.trim()) {
    throw new Error('Mount strategy must include a non-empty type.');
  }

  const normalized: Record<string, unknown> & { type: string } = {
    ...strategy,
    type: strategy.type.trim(),
  };
  rejectKnownSnakeCaseKeys(normalized, ['driver_options'], 'mount strategy');
  if (isRecord(normalized.pattern)) {
    rejectKnownSnakeCaseKeys(
      normalized.pattern,
      [
        'remote_name',
        'extra_args',
        'config_file_path',
        'nfs_addr',
        'nfs_mount_options',
        'allow_other',
        'log_type',
        'log_level',
        'cache_type',
        'cache_path',
        'cache_size_mb',
        'block_cache_block_size_mb',
        'block_cache_disk_timeout_sec',
        'file_cache_timeout_sec',
        'file_cache_max_size_mb',
        'attr_cache_timeout_sec',
        'entry_cache_timeout_sec',
        'negative_entry_cache_timeout_sec',
      ],
      'mount strategy pattern',
    );
    if (isRecord(normalized.pattern.options)) {
      rejectKnownSnakeCaseKeys(
        normalized.pattern.options,
        ['endpoint_url', 'mount_target_ip', 'access_point', 'extra_options'],
        'mount strategy pattern options',
      );
    }
  }

  return normalized as MountStrategy;
}

function normalizeTypedMountProvider(entry: Entry): void {
  if (!isMount(entry) || entry.type === 'mount') {
    return;
  }

  switch (entry.type) {
    case 's3_mount':
      setTypedMountProviderConfig(
        entry,
        's3',
        typedMountConfig(
          { bucket: entry.bucket },
          {
            prefix: entry.prefix,
            region: entry.region,
            endpointUrl: entry.endpointUrl,
            s3Provider: entry.s3Provider,
          },
        ),
      );
      return;
    case 'gcs_mount':
      setTypedMountProviderConfig(
        entry,
        'gcs',
        typedMountConfig(
          { bucket: entry.bucket },
          {
            prefix: entry.prefix,
            region: entry.region,
            endpointUrl: entry.endpointUrl,
          },
        ),
      );
      return;
    case 'r2_mount':
      setTypedMountProviderConfig(
        entry,
        'r2',
        typedMountConfig(
          { bucket: entry.bucket },
          {
            prefix: entry.prefix,
            accountId: entry.accountId,
            customDomain: entry.customDomain,
          },
        ),
      );
      return;
    case 'azure_blob_mount':
      setTypedMountProviderConfig(
        entry,
        'azure_blob',
        typedMountConfig(
          { container: entry.container },
          {
            prefix: entry.prefix,
            account: entry.account,
            accountName: entry.accountName,
            endpoint: entry.endpoint,
            endpointUrl: entry.endpointUrl,
          },
        ),
      );
      return;
    case 'box_mount':
      setTypedMountProviderConfig(
        entry,
        'box',
        typedMountConfig(
          {},
          {
            path: entry.path,
            boxSubType: entry.boxSubType,
            rootFolderId: entry.rootFolderId,
            impersonate: entry.impersonate,
            ownedBy: entry.ownedBy,
          },
        ),
      );
      return;
    case 's3_files_mount':
      setTypedMountProviderConfig(
        entry,
        's3_files',
        typedMountConfig(
          { fileSystemId: entry.fileSystemId },
          {
            subpath: entry.subpath,
            mountTargetIp: entry.mountTargetIp,
            accessPoint: entry.accessPoint,
            region: entry.region,
            extraOptions: entry.extraOptions,
          },
        ),
      );
      return;
    default:
      return;
  }
}

function setTypedMountProviderConfig(
  entry: TypedMount,
  provider: MountProvider,
  config: Record<string, unknown>,
): void {
  entry.provider = entry.provider ?? provider;
  entry.config = {
    ...(entry.config ?? {}),
    ...config,
  };
}

function typedMountConfig(
  required: Record<string, string>,
  optional: Record<string, unknown | undefined> = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...required };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}

function rejectKnownSnakeCaseMountKeys(entry: Entry): void {
  rejectKnownSnakeCaseKeys(
    entry as unknown as Record<string, unknown>,
    [
      'mount_path',
      'read_only',
      'mount_strategy',
      'client_id',
      'client_secret',
      'access_id',
      'access_key_id',
      'access_token',
      'secret_access_key',
      'session_token',
      'service_account_credentials',
      'service_account_file',
      'endpoint_url',
      'account_id',
      'account_name',
      'account_key',
      'custom_domain',
      'file_system_id',
      'mount_target_ip',
      'access_point',
      'extra_options',
      's3_provider',
      'identity_client_id',
      'box_config_file',
      'config_credentials',
      'box_sub_type',
      'root_folder_id',
      'owned_by',
    ],
    'sandbox manifest entries',
  );
}

function rejectKnownSnakeCaseKeys(
  value: Record<string, unknown>,
  keys: string[],
  source: string,
): void {
  const found = keys.find((key) => key in value);
  if (!found) {
    return;
  }
  throw new Error(
    `Use camelCase config keys in ${source}; snake_case key "${found}" is not supported.`,
  );
}
