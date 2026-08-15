import { UserError } from '../errors';
import { SandboxMountError, SandboxProviderError } from './errors';
import { isMount, type Entry, type Mount, type TypedMount } from './entries';
import {
  cloneManifest,
  Environment,
  manifestAcknowledgesInContainerMountCredentialExposure,
  Manifest,
  MOUNT_CREDENTIAL_EXPOSURE_POLICY_KEYS,
  normalizeRelativePath,
  ProcessEnvValue,
  replaceManifestMountCredentialExposurePolicy,
  withProcessEnvironmentErrorRedaction,
  type InContainerMountCredentialExposureAuthority,
} from './manifest';
import { stableJsonStringify } from './shared/stableJson';
import { validateCredentialPair } from './shared/credentials';
import { isUnderPosixPath, normalizePosixPath } from './shared/posixPath';
import { typedMountProviderConfig } from './shared/typedMountConfig';

export const REDACTED_MOUNT_CREDENTIAL_PATHS_KEY =
  '__openaiAgentsRedactedMountCredentialPaths';
export const NON_RESUMABLE_MOUNT_AUTHORITY_KEY =
  '__openaiAgentsNonResumableMountAuthority';

export type MountCredentialFileReference = {
  field: string;
  path: string;
};

export type EffectiveManifestEntryPath = {
  path: string;
  recursive: boolean;
};

export type MountCredentialExposureDecision = {
  credentialExposureAcknowledged: boolean;
  broadCredentialExposureAcknowledged: boolean;
};

const CREDENTIAL_FIELDS_BY_MOUNT_TYPE: Readonly<
  Record<string, readonly string[]>
> = {
  s3_mount: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
  gcs_mount: [
    'accessId',
    'secretAccessKey',
    'serviceAccountCredentials',
    'serviceAccountFile',
    'accessToken',
  ],
  r2_mount: ['accessKeyId', 'secretAccessKey'],
  azure_blob_mount: ['accountKey', 'identityClientId'],
  box_mount: [
    'clientSecret',
    'accessToken',
    'token',
    'boxConfigFile',
    'configCredentials',
  ],
};

const ALL_CREDENTIAL_FIELDS = [
  ...new Set(Object.values(CREDENTIAL_FIELDS_BY_MOUNT_TYPE).flat()),
];

const STRATEGY_CREDENTIAL_FIELDS = [
  'mountStrategy.driverOptions',
  'mountStrategy.credentialEnvironment',
  'mountStrategy.pattern.configFilePath',
  'mountStrategy.pattern.args',
  'mountStrategy.pattern.extraArgs',
  'mountStrategy.pattern.command',
  'mountStrategy.pattern.options.extraOptions',
] as const;

const INSIDE_SANDBOX_STRATEGIES = new Set([
  'in_container',
  'e2b_cloud_bucket',
  'daytona_cloud_bucket',
  'runloop_cloud_bucket',
  'vercel_cloud_bucket',
  'blaxel_cloud_bucket',
]);

const ENVIRONMENT_CREDENTIAL_STRATEGIES = new Set([
  'in_container',
  'e2b_cloud_bucket',
  'daytona_cloud_bucket',
  'runloop_cloud_bucket',
  'vercel_cloud_bucket',
]);

const OUTSIDE_SANDBOX_STRATEGIES = new Set([
  'docker_volume',
  'local_bind',
  'modal_cloud_bucket',
  'cloudflare_bucket_mount',
  'blaxel_drive',
]);

type InContainerMountCredentialCapability = {
  strategyTypes: readonly string[];
  provider: string;
  patternType?: string;
  mountScopedCredentialFields: readonly string[];
  broadCredentialFields: readonly string[];
  enablesBroadCredentialDiscovery?: boolean;
};

const RCLONE_STRATEGY_TYPES = [
  'in_container',
  'e2b_cloud_bucket',
  'daytona_cloud_bucket',
  'runloop_cloud_bucket',
] as const;

const IN_CONTAINER_MOUNT_CREDENTIAL_CAPABILITIES: readonly InContainerMountCredentialCapability[] =
  [
    {
      strategyTypes: RCLONE_STRATEGY_TYPES,
      provider: 's3',
      patternType: 'rclone',
      mountScopedCredentialFields: [
        'accessKeyId',
        'secretAccessKey',
        'sessionToken',
      ],
      broadCredentialFields: [
        'mountStrategy.credentialEnvironment',
        'mountStrategy.pattern.configFilePath',
      ],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: RCLONE_STRATEGY_TYPES,
      provider: 'r2',
      patternType: 'rclone',
      mountScopedCredentialFields: ['accessKeyId', 'secretAccessKey'],
      broadCredentialFields: [
        'mountStrategy.credentialEnvironment',
        'mountStrategy.pattern.configFilePath',
      ],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: RCLONE_STRATEGY_TYPES,
      provider: 'gcs',
      patternType: 'rclone',
      mountScopedCredentialFields: [
        'accessId',
        'secretAccessKey',
        'serviceAccountCredentials',
        'accessToken',
      ],
      broadCredentialFields: [
        'serviceAccountFile',
        'mountStrategy.credentialEnvironment',
        'mountStrategy.pattern.configFilePath',
      ],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: RCLONE_STRATEGY_TYPES,
      provider: 'azure_blob',
      patternType: 'rclone',
      mountScopedCredentialFields: ['accountKey'],
      broadCredentialFields: [
        'identityClientId',
        'managedIdentity',
        'mountStrategy.credentialEnvironment',
        'mountStrategy.pattern.configFilePath',
      ],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: RCLONE_STRATEGY_TYPES,
      provider: 'box',
      patternType: 'rclone',
      mountScopedCredentialFields: [
        'clientSecret',
        'accessToken',
        'token',
        'configCredentials',
      ],
      broadCredentialFields: [
        'boxConfigFile',
        'mountStrategy.credentialEnvironment',
        'mountStrategy.pattern.configFilePath',
      ],
    },
    {
      strategyTypes: ['in_container'],
      provider: 's3',
      patternType: 'mountpoint',
      mountScopedCredentialFields: [
        'accessKeyId',
        'secretAccessKey',
        'sessionToken',
      ],
      broadCredentialFields: ['mountStrategy.credentialEnvironment'],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: ['in_container'],
      provider: 'gcs',
      patternType: 'mountpoint',
      mountScopedCredentialFields: ['accessId', 'secretAccessKey'],
      broadCredentialFields: [],
    },
    {
      strategyTypes: ['in_container'],
      provider: 'azure_blob',
      patternType: 'fuse',
      mountScopedCredentialFields: ['accountKey'],
      broadCredentialFields: ['identityClientId', 'managedIdentity'],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: ['in_container'],
      provider: 's3_files',
      patternType: 's3files',
      mountScopedCredentialFields: [],
      broadCredentialFields: [
        'workloadIdentity',
        'extraOptions',
        'config.extraOptions',
        'mountStrategy.pattern.options.extraOptions',
      ],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: ['vercel_cloud_bucket'],
      provider: 's3',
      mountScopedCredentialFields: [
        'accessKeyId',
        'secretAccessKey',
        'sessionToken',
      ],
      broadCredentialFields: ['mountStrategy.credentialEnvironment'],
      enablesBroadCredentialDiscovery: true,
    },
    {
      strategyTypes: ['blaxel_cloud_bucket'],
      provider: 's3',
      mountScopedCredentialFields: [
        'accessKeyId',
        'secretAccessKey',
        'sessionToken',
      ],
      broadCredentialFields: [],
    },
    {
      strategyTypes: ['blaxel_cloud_bucket'],
      provider: 'r2',
      mountScopedCredentialFields: ['accessKeyId', 'secretAccessKey'],
      broadCredentialFields: [],
    },
    {
      strategyTypes: ['blaxel_cloud_bucket'],
      provider: 'gcs',
      mountScopedCredentialFields: [
        'accessId',
        'secretAccessKey',
        'serviceAccountCredentials',
        'accessToken',
      ],
      broadCredentialFields: ['serviceAccountFile'],
    },
  ];

const S3_MOUNT_ENVIRONMENT_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SDK_LOAD_CONFIG',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
] as const;

const S3_MOUNT_CREDENTIAL_ENVIRONMENT_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
] as const;

const S3_MOUNT_BROAD_CREDENTIAL_ENVIRONMENT_NAMES = [
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SDK_LOAD_CONFIG',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
] as const;

const GCS_MOUNT_ENVIRONMENT_NAMES = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
] as const;

const CREDENTIAL_FILE_ENVIRONMENT_NAMES = new Set([
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);

export function isMountCredentialFileEnvironmentName(name: string): boolean {
  return (
    CREDENTIAL_FILE_ENVIRONMENT_NAMES.has(name) ||
    name === 'RCLONE_CONFIG' ||
    (name.startsWith('RCLONE_CONFIG_') &&
      (name.endsWith('_FILE') || name.endsWith('_PATH')))
  );
}

const pendingMountCredentialPaths = new WeakMap<Manifest, readonly string[]>();
const persistedMountTopologyManifests = new WeakSet<Manifest>();
const liveMountCredentialAuthority = new WeakMap<Manifest, Manifest>();
const validatedMountEffectivePaths = new WeakMap<
  Manifest,
  ReadonlyMap<string, string>
>();
const liveMountEnvironmentAuthority = new WeakMap<Manifest, string>();
const liveMountRuntimeAuthority = new WeakMap<
  Manifest,
  ReadonlyMap<symbol, string>
>();
const trustedCredentialReboundManifests = new WeakSet<Manifest>();
const unsafeManifestTransitionStates = new WeakSet<object>();
const pendingManifestMutationCounts = new WeakMap<object, number>();
const sandboxStateAccessTails = new WeakMap<object, Promise<void>>();
const sandboxStateGenerations = new WeakMap<object, number>();

export function markSandboxSessionStateUnsafe(state: object): void {
  unsafeManifestTransitionStates.add(state);
}

export function isSandboxSessionStateUnsafe(state: object): boolean {
  return unsafeManifestTransitionStates.has(state);
}

export function assertSandboxSessionStateUsable(state: object): void {
  if (!isSandboxSessionStateUnsafe(state)) {
    return;
  }
  throw new SandboxProviderError(
    'Sandbox session is unavailable because a privileged manifest transition failed after provider side effects may have started.',
    { operation: 'manifest transition' },
  );
}

export async function withExclusiveSandboxManifestMutation<T>(
  state: { manifest: Manifest },
  operation: () => Promise<T>,
): Promise<T> {
  const pendingCount = pendingManifestMutationCounts.get(state) ?? 0;
  pendingManifestMutationCounts.set(state, pendingCount + 1);
  sandboxStateGenerations.set(state, sandboxStateGeneration(state) + 1);
  try {
    return await withProcessEnvironmentErrorRedaction(
      state.manifest,
      {
        provider: 'sandbox',
        operation: 'manifest mutation',
      },
      async () => await withExclusiveSandboxStateAccess(state, operation),
    );
  } finally {
    const remaining = (pendingManifestMutationCounts.get(state) ?? 1) - 1;
    if (remaining > 0) {
      pendingManifestMutationCounts.set(state, remaining);
    } else {
      pendingManifestMutationCounts.delete(state);
    }
    sandboxStateGenerations.set(state, sandboxStateGeneration(state) + 1);
  }
}

export async function withExclusiveSandboxStateInspection<T>(
  state: object,
  operation: () => Promise<T>,
): Promise<T> {
  return await withExclusiveSandboxStateAccess(state, operation);
}

async function withExclusiveSandboxStateAccess<T>(
  state: object,
  operation: () => Promise<T>,
): Promise<T> {
  assertSandboxSessionStateUsable(state);
  const previous = sandboxStateAccessTails.get(state) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => turn);
  sandboxStateAccessTails.set(state, tail);
  await previous.catch(() => {});
  try {
    assertSandboxSessionStateUsable(state);
    return await operation();
  } finally {
    release();
    if (sandboxStateAccessTails.get(state) === tail) {
      sandboxStateAccessTails.delete(state);
    }
  }
}

export function captureSandboxStateGeneration(state: object): number {
  assertSandboxSessionStateUsable(state);
  if ((pendingManifestMutationCounts.get(state) ?? 0) > 0) {
    throw new UserError(
      'Sandbox state cannot be inspected while a manifest mutation is in progress.',
    );
  }
  return sandboxStateGeneration(state);
}

export function assertSandboxStateGenerationUnchanged(
  state: object,
  generation: number,
): void {
  assertSandboxSessionStateUsable(state);
  if (
    (pendingManifestMutationCounts.get(state) ?? 0) > 0 ||
    sandboxStateGeneration(state) !== generation
  ) {
    throw new UserError(
      'Sandbox manifest changed while session state was being inspected.',
    );
  }
}

function sandboxStateGeneration(state: object): number {
  return sandboxStateGenerations.get(state) ?? 0;
}

export function configuredMountCredentialFields(
  entry: Mount | TypedMount,
): string[] {
  const entryRecord = entry as Record<string, unknown>;
  const configured: string[] = ALL_CREDENTIAL_FIELDS.filter(
    (field) => entryRecord[field] !== undefined && entryRecord[field] !== null,
  ).sort();
  for (const field of STRATEGY_CREDENTIAL_FIELDS) {
    const value = readNestedField(entryRecord, field);
    if (
      value !== undefined &&
      value !== null &&
      strategyFieldContainsCredentials(field, value)
    ) {
      configured.push(field);
    }
  }
  const opaqueCredentialFields = [
    ...(mountConfigContainsOpaqueFields(entry) ? ['config'] : []),
    ...(entry.type === 's3_files_mount'
      ? ['extraOptions', 'config.extraOptions']
      : []),
  ];
  for (const field of opaqueCredentialFields) {
    const value = readNestedField(entryRecord, field);
    if (
      value !== undefined &&
      value !== null &&
      strategyFieldContainsCredentials(field, value)
    ) {
      configured.push(field);
    }
  }
  if (
    entry.type === 'mount' &&
    INSIDE_SANDBOX_STRATEGIES.has(mountStrategyType(entry)) &&
    entryRecord.source !== undefined &&
    entryRecord.source !== null
  ) {
    configured.push('source');
  }
  return [...new Set(configured)].sort();
}

function mountConfigContainsOpaqueFields(entry: Mount | TypedMount): boolean {
  if (!isRecord(entry.config) || Object.keys(entry.config).length === 0) {
    return false;
  }
  if (entry.type === 'mount') {
    return true;
  }
  const topologyFields = new Set(
    Object.keys(typedMountProviderConfig(entry).config),
  );
  return Object.keys(entry.config).some((field) => !topologyFields.has(field));
}

export function manifestHasInContainerMounts(manifest: Manifest): boolean {
  return manifest
    .mountTargets()
    .some(({ entry }) =>
      INSIDE_SANDBOX_STRATEGIES.has(mountStrategyType(entry)),
    );
}

export function manifestHasNonResumableMountAuthority(
  manifest: Manifest,
): boolean {
  return [...mountsByLogicalPath(manifest).values()].some((mount) =>
    mountHasNonResumableAuthority(mount),
  );
}

export function persistedManifestRecordHasNonResumableMountAuthority(
  value: Record<string, unknown>,
): boolean {
  return rawManifestEntriesHaveNonResumableMountAuthority(value.entries);
}

function rawManifestEntriesHaveNonResumableMountAuthority(
  value: unknown,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return (
      mountHasNonResumableAuthority(entry) ||
      rawManifestEntriesHaveNonResumableMountAuthority(entry.children)
    );
  });
}

function mountHasNonResumableAuthority(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const driverOptions = readNestedField(value, 'mountStrategy.driverOptions');
  const pattern = mountStrategyPattern(value.mountStrategy);
  const opaquePatternFields = [
    pattern?.args,
    pattern?.extraArgs,
    readNestedField(pattern ?? {}, 'options.extraOptions'),
  ];
  const opaqueS3FilesOptions =
    value.type === 's3_files_mount'
      ? [value.extraOptions, readNestedField(value, 'config.extraOptions')]
      : [];
  return (
    mountRecordHasOpaqueConfig(value) ||
    (isRecord(driverOptions) && Object.keys(driverOptions).length > 0) ||
    [...opaquePatternFields, ...opaqueS3FilesOptions].some((field) =>
      strategyFieldContainsCredentials('opaque', field),
    ) ||
    (typeof pattern?.command === 'string' && pattern.command.length > 0) ||
    (typeof pattern?.configFilePath === 'string' &&
      pattern.configFilePath.length > 0)
  );
}

function mountRecordHasOpaqueConfig(value: Record<string, unknown>): boolean {
  if (!isRecord(value.config) || Object.keys(value.config).length === 0) {
    return false;
  }
  if (value.type === 'mount') {
    return true;
  }
  if (
    value.type !== 's3_mount' &&
    value.type !== 'gcs_mount' &&
    value.type !== 'r2_mount' &&
    value.type !== 'azure_blob_mount' &&
    value.type !== 'box_mount' &&
    value.type !== 's3_files_mount'
  ) {
    return true;
  }
  const topologyFields = new Set(
    Object.keys(
      typedMountProviderConfig(value as unknown as TypedMount).config,
    ),
  );
  return Object.keys(value.config).some((field) => !topologyFields.has(field));
}

export function validateMountCredentialBoundaries(manifest: Manifest): void {
  for (const { entry, mountPath } of manifest.mountTargets()) {
    validateExplicitMountCredentialPairs(entry);
    validateRclonePatternArguments(entry, mountPath);
    const credentialFields = [
      ...configuredMountCredentialFields(entry),
      ...implicitWorkloadIdentityCredentialFields(entry),
    ];
    const strategyType = mountStrategyType(entry);
    if (OUTSIDE_SANDBOX_STRATEGIES.has(strategyType)) {
      if (credentialFields.length > 0) {
        assertMountCredentialFilesAreNotSerializedManifestEntries(
          manifest,
          entry,
          mountPath,
        );
      }
      continue;
    }

    const acknowledgement = mountCredentialExposureAcknowledgement(
      manifest,
      mountPath,
    );
    if (
      credentialFields.length === 0 &&
      !acknowledgement.mount_scoped &&
      !acknowledgement.broad
    ) {
      continue;
    }

    const capability = inContainerMountCredentialCapability(entry);
    const details: Record<string, unknown> = {
      mountPath,
      mountType: entry.type,
      mountStrategy: strategyType,
      mountProvider: sdkOwnedMountProvider(entry),
      mountPattern: resolvedInContainerMountPatternType(entry),
      credentialFields,
    };
    if (!capability) {
      throw new SandboxMountError(
        'Credential-bearing in-container mounts require an SDK-supported strategy, provider, mount type, and pattern combination before exposure can be acknowledged. Use a supported typed mount and strategy, a credentialless helper, or an external or provider-native mount strategy.',
        details,
        'mount_config_invalid',
      );
    }

    const requiredAuthorities = classifyMountCredentialAuthorities(
      capability,
      credentialFields,
      details,
    );
    validateAcknowledgementSupportedByCapability(
      capability,
      acknowledgement,
      details,
    );

    if (credentialFields.length > 0) {
      assertMountCredentialFilesAreNotSerializedManifestEntries(
        manifest,
        entry,
        mountPath,
      );
    }
    for (const authority of requiredAuthorities) {
      if (acknowledgement[authority]) {
        continue;
      }
      const broad = authority === 'broad';
      throw new SandboxMountError(
        broad
          ? 'Broad credential authority cannot be exposed to a helper inside a model-controlled sandbox by default. Use a credentialless or external/provider-native strategy, or explicitly acknowledge broad credential exposure for this exact path with Manifest.withInContainerMountBroadCredentialExposureAcknowledged().'
          : 'Mount-scoped credentials cannot be exposed to a helper inside a model-controlled sandbox by default. Use a credentialless or external/provider-native strategy, or explicitly acknowledge credential exposure for this exact path with Manifest.withInContainerMountCredentialExposureAcknowledged().',
        details,
        'mount_config_invalid',
      );
    }
  }
}

function inContainerMountCredentialCapability(
  entry: Mount | TypedMount,
): InContainerMountCredentialCapability | undefined {
  const strategyType = mountStrategyType(entry);
  const provider = sdkOwnedMountProvider(entry);
  if (!provider) {
    return undefined;
  }
  const patternType = resolvedInContainerMountPatternType(entry);
  return IN_CONTAINER_MOUNT_CREDENTIAL_CAPABILITIES.find(
    (capability) =>
      capability.strategyTypes.includes(strategyType) &&
      capability.provider === provider &&
      capability.patternType === patternType,
  );
}

function sdkOwnedMountProvider(entry: Mount | TypedMount): string | undefined {
  if (entry.type === 'mount') {
    return undefined;
  }
  const provider = typedMountProviderConfig(entry).provider;
  return entry.provider === undefined || entry.provider === provider
    ? provider
    : undefined;
}

function resolvedInContainerMountPatternType(
  entry: Mount | TypedMount,
): string | undefined {
  const patternType = mountStrategyPattern(entry.mountStrategy)?.type;
  if (patternType !== undefined) {
    return typeof patternType === 'string' ? patternType : undefined;
  }
  const strategyType = mountStrategyType(entry);
  if (
    strategyType === 'e2b_cloud_bucket' ||
    strategyType === 'daytona_cloud_bucket' ||
    strategyType === 'runloop_cloud_bucket'
  ) {
    return 'rclone';
  }
  if (strategyType !== 'in_container') {
    return undefined;
  }
  return entry.type === 's3_files_mount'
    ? 's3files'
    : entry.type === 's3_mount' ||
        entry.type === 'r2_mount' ||
        entry.type === 'gcs_mount' ||
        entry.type === 'azure_blob_mount' ||
        entry.type === 'box_mount'
      ? 'rclone'
      : undefined;
}

function classifyMountCredentialAuthorities(
  capability: InContainerMountCredentialCapability,
  credentialFields: readonly string[],
  details: Record<string, unknown>,
): Set<InContainerMountCredentialExposureAuthority> {
  const mountScopedFields = new Set(capability.mountScopedCredentialFields);
  const broadFields = new Set(capability.broadCredentialFields);
  const unsupportedCredentialFields = credentialFields.filter(
    (field) => !mountScopedFields.has(field) && !broadFields.has(field),
  );
  if (unsupportedCredentialFields.length > 0) {
    throw new SandboxMountError(
      'The selected in-container mount capability does not support exposing these credential fields. Use the credential fields supported by this typed mount and strategy, or choose a credentialless or external/provider-native strategy.',
      { ...details, unsupportedCredentialFields },
      'mount_config_invalid',
    );
  }
  const authorities = new Set<InContainerMountCredentialExposureAuthority>();
  if (credentialFields.some((field) => mountScopedFields.has(field))) {
    authorities.add('mount_scoped');
  }
  if (credentialFields.some((field) => broadFields.has(field))) {
    authorities.add('broad');
  }
  return authorities;
}

function validateAcknowledgementSupportedByCapability(
  capability: InContainerMountCredentialCapability,
  acknowledgement: Record<InContainerMountCredentialExposureAuthority, boolean>,
  details: Record<string, unknown>,
): void {
  if (
    acknowledgement.mount_scoped &&
    capability.mountScopedCredentialFields.length === 0
  ) {
    throw new SandboxMountError(
      'The selected in-container mount capability does not support mount-scoped credential exposure acknowledgement.',
      details,
      'mount_config_invalid',
    );
  }
  if (
    acknowledgement.broad &&
    capability.broadCredentialFields.length === 0 &&
    capability.enablesBroadCredentialDiscovery !== true
  ) {
    throw new SandboxMountError(
      'The selected in-container mount capability does not support broad credential exposure acknowledgement.',
      details,
      'mount_config_invalid',
    );
  }
}

function mountCredentialExposureAcknowledgement(
  manifest: Manifest,
  mountPath: string,
): Record<InContainerMountCredentialExposureAuthority, boolean> {
  return {
    mount_scoped: manifestAcknowledgesInContainerMountCredentialExposure(
      manifest,
      mountPath,
      'mount_scoped',
    ),
    broad: manifestAcknowledgesInContainerMountCredentialExposure(
      manifest,
      mountPath,
      'broad',
    ),
  };
}

function validateRclonePatternArguments(
  entry: Mount | TypedMount,
  mountPath: string,
): void {
  const pattern = mountStrategyPattern(entry.mountStrategy);
  if (pattern?.type !== 'rclone') {
    return;
  }
  const unsupportedFields = ['args', 'extraArgs'].flatMap((field) => {
    const value = pattern[field];
    if (value === undefined || isCredentialFreeRcloneArgumentList(value)) {
      return [];
    }
    return [`mountStrategy.pattern.${field}`];
  });
  if (unsupportedFields.length === 0) {
    return;
  }
  throw new SandboxMountError(
    'Unsupported rclone mount args or extraArgs can bypass credential-file validation. Use typed mount options or mountStrategy.pattern.configFilePath instead.',
    { mountPath, mountType: entry.type, credentialFields: unsupportedFields },
    'mount_config_invalid',
  );
}

function isCredentialFreeRcloneArgumentList(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const argument = value[index];
    if (argument === '--vfs-cache-mode') {
      const mode = value[index + 1];
      if (!['off', 'minimal', 'writes', 'full'].includes(mode ?? '')) {
        return false;
      }
      index += 1;
      continue;
    }
    const mode = argument.match(/^--vfs-cache-mode=(.+)$/u)?.[1];
    if (mode && ['off', 'minimal', 'writes', 'full'].includes(mode)) {
      continue;
    }
    return false;
  }
  return true;
}

function validateExplicitMountCredentialPairs(entry: Mount | TypedMount): void {
  const entryRecord = entry as Record<string, unknown>;
  const accessKeyId = optionalCredentialString(entryRecord.accessKeyId);
  const secretAccessKey = optionalCredentialString(entryRecord.secretAccessKey);
  if (entry.type === 's3_mount' || entry.type === 'r2_mount') {
    validateCredentialPair({
      accessKeyId,
      secretAccessKey,
      message: `${entry.type} requires both accessKeyId and secretAccessKey when either is provided.`,
      details: { mountType: entry.type },
      code: 'mount_config_invalid',
    });
    if (
      optionalCredentialString(entryRecord.sessionToken) !== undefined &&
      (!accessKeyId || !secretAccessKey)
    ) {
      throw new SandboxMountError(
        `${entry.type} requires a complete accessKeyId and secretAccessKey pair when sessionToken is provided.`,
        { mountType: entry.type },
        'mount_config_invalid',
      );
    }
    return;
  }
  if (entry.type === 'gcs_mount') {
    validateCredentialPair({
      accessKeyId: optionalCredentialString(entryRecord.accessId),
      secretAccessKey,
      message:
        'gcs_mount requires both accessId and secretAccessKey when either is provided.',
      details: { mountType: entry.type },
      code: 'mount_config_invalid',
    });
  }
}

function validateMountCredentialEnvironmentPairs(
  entry: Mount | TypedMount,
  environment: Record<string, string>,
): void {
  if (
    entry.type === 's3_mount' ||
    entry.type === 'r2_mount' ||
    entry.type === 's3_files_mount'
  ) {
    const entryRecord = entry as Record<string, unknown>;
    if (!(entryRecord.accessKeyId && entryRecord.secretAccessKey)) {
      const accessKeyId = optionalCredentialString(
        environment.AWS_ACCESS_KEY_ID,
      );
      const secretAccessKey = optionalCredentialString(
        environment.AWS_SECRET_ACCESS_KEY,
      );
      validateCredentialPair({
        accessKeyId,
        secretAccessKey,
        message:
          'S3 mount environment credentials require both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY when either is provided.',
        details: { mountType: entry.type },
        code: 'mount_config_invalid',
      });
      if (
        (optionalCredentialString(environment.AWS_SESSION_TOKEN) !==
          undefined ||
          optionalCredentialString(environment.AWS_SECURITY_TOKEN) !==
            undefined) &&
        (!accessKeyId || !secretAccessKey)
      ) {
        throw new SandboxMountError(
          'S3 mount environment credentials require a complete AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY pair when a session token is provided.',
          { mountType: entry.type },
          'mount_config_invalid',
        );
      }
    }
  }

  const rcloneRemotePrefixes = new Set<string>();
  for (const name of Object.keys(environment)) {
    const prefix = name.match(
      /^(RCLONE_CONFIG_.+)_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN)$/u,
    )?.[1];
    if (prefix) {
      rcloneRemotePrefixes.add(prefix);
    }
  }
  for (const prefix of rcloneRemotePrefixes) {
    const accessKeyId = optionalCredentialString(
      environment[`${prefix}_ACCESS_KEY_ID`],
    );
    const secretAccessKey = optionalCredentialString(
      environment[`${prefix}_SECRET_ACCESS_KEY`],
    );
    validateCredentialPair({
      accessKeyId,
      secretAccessKey,
      message:
        'Rclone remote environment credentials require both ACCESS_KEY_ID and SECRET_ACCESS_KEY when either is provided.',
      details: { mountType: entry.type, remote: prefix },
      code: 'mount_config_invalid',
    });
    if (
      (optionalCredentialString(environment[`${prefix}_SESSION_TOKEN`]) !==
        undefined ||
        optionalCredentialString(environment[`${prefix}_SECURITY_TOKEN`]) !==
          undefined) &&
      (!accessKeyId || !secretAccessKey)
    ) {
      throw new SandboxMountError(
        'Rclone remote environment credentials require a complete ACCESS_KEY_ID and SECRET_ACCESS_KEY pair when a session token is provided.',
        { mountType: entry.type, remote: prefix },
        'mount_config_invalid',
      );
    }
  }
}

function optionalCredentialString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function implicitWorkloadIdentityCredentialFields(
  entry: Mount | TypedMount,
): string[] {
  if (!INSIDE_SANDBOX_STRATEGIES.has(mountStrategyType(entry))) {
    return [];
  }
  if (entry.type === 's3_files_mount') {
    return ['workloadIdentity'];
  }
  if (
    entry.type === 'azure_blob_mount' &&
    mountStrategyPattern(entry.mountStrategy)?.type === 'fuse' &&
    !(entry as Record<string, unknown>).accountKey &&
    !(entry as Record<string, unknown>).identityClientId
  ) {
    return ['managedIdentity'];
  }
  return [];
}

export function validateMountEnvironmentCredentialBoundaries(
  manifest: Manifest,
  environment: Record<string, string>,
): void {
  const effectiveEnvironment = mountEffectiveEnvironment(manifest, environment);
  const candidate = cloneManifest(manifest);
  for (const { entry, mountPath } of candidate.mountTargets()) {
    const credentialEnvironment = mountCredentialEnvironmentForEntry(
      entry,
      effectiveEnvironment,
    );
    validateMountCredentialEnvironmentPairs(entry, credentialEnvironment);
    if (Object.keys(credentialEnvironment).length === 0) {
      continue;
    }
    const strategy = (entry as Record<string, unknown>).mountStrategy;
    if (!isRecord(strategy)) {
      continue;
    }
    strategy.credentialEnvironment = credentialEnvironment;
    assertMountCredentialFilesAreNotSerializedManifestEntries(
      candidate,
      entry,
      mountPath,
      credentialEnvironment,
    );
  }
  validateMountCredentialBoundaries(candidate);
}

export async function resolveAndValidateMountEnvironment(
  manifest: Manifest,
): Promise<Manifest> {
  const resolved = cloneManifest(manifest);
  for (const [name, original] of Object.entries(manifest.environment)) {
    if (original instanceof ProcessEnvValue) {
      resolved.environment[name] = original;
    }
  }
  if (
    !manifest
      .mountTargets()
      .some(({ entry }) =>
        ENVIRONMENT_CREDENTIAL_STRATEGIES.has(mountStrategyType(entry)),
      )
  ) {
    return resolved;
  }
  const environment = await manifest.resolveEnvironment();
  validateMountEnvironmentCredentialBoundaries(manifest, environment);
  for (const [name, original] of Object.entries(manifest.environment)) {
    if (original instanceof ProcessEnvValue) {
      continue;
    }
    resolved.environment[name] = new Environment({
      value: environment[name] ?? '',
      ...(original.ephemeral ? { ephemeral: true } : {}),
      ...(original.description ? { description: original.description } : {}),
    });
  }
  return resolved;
}

export function validateMountCredentialBoundariesAtEffectivePath(
  manifest: Manifest,
  logicalPath: string,
  entry: Mount | TypedMount,
  effectivePath: string,
): MountCredentialExposureDecision {
  const effectiveAcknowledgement = mountCredentialExposureAcknowledgement(
    manifest,
    effectivePath,
  );
  const declaredPath = manifest
    .mountTargets()
    .find((target) => target.logicalPath === logicalPath)?.mountPath;
  const declaredAcknowledgement = declaredPath
    ? mountCredentialExposureAcknowledgement(manifest, declaredPath)
    : { mount_scoped: false, broad: false };
  for (const authority of ['mount_scoped', 'broad'] as const) {
    if (
      declaredAcknowledgement[authority] &&
      !effectiveAcknowledgement[authority]
    ) {
      throw new SandboxMountError(
        'Mount credentials cannot be exposed to a helper inside a model-controlled sandbox because the effective mount path does not match the trusted exact-path acknowledgement.',
        {
          mountType: entry.type,
          mountStrategy: mountStrategyType(entry),
          credentialAuthority: authority,
        },
        'mount_config_invalid',
      );
    }
  }
  if (effectiveAcknowledgement.mount_scoped || effectiveAcknowledgement.broad) {
    const capability = inContainerMountCredentialCapability(entry);
    if (!capability) {
      throw new SandboxMountError(
        'Credential-bearing in-container mounts require an SDK-supported strategy, provider, mount type, and pattern combination before exposure can be acknowledged.',
        {
          mountType: entry.type,
          mountStrategy: mountStrategyType(entry),
          mountProvider: sdkOwnedMountProvider(entry),
          mountPattern: resolvedInContainerMountPatternType(entry),
        },
        'mount_config_invalid',
      );
    }
    validateAcknowledgementSupportedByCapability(
      capability,
      effectiveAcknowledgement,
      {
        mountType: entry.type,
        mountStrategy: mountStrategyType(entry),
        mountProvider: sdkOwnedMountProvider(entry),
        mountPattern: resolvedInContainerMountPatternType(entry),
      },
    );
  }
  const effectivePaths = new Map(
    validatedMountEffectivePaths.get(manifest) ?? [],
  );
  effectivePaths.set(logicalPath, normalizePosixPath(effectivePath));
  validatedMountEffectivePaths.set(manifest, effectivePaths);
  return {
    credentialExposureAcknowledged:
      effectiveAcknowledgement.mount_scoped || effectiveAcknowledgement.broad,
    broadCredentialExposureAcknowledged: effectiveAcknowledgement.broad,
  };
}

export function copyValidatedMountEffectivePaths(
  target: Manifest,
  ...sources: Manifest[]
): void {
  const effectivePaths = new Map<string, string>();
  for (const source of sources) {
    for (const [logicalPath, effectivePath] of validatedMountEffectivePaths.get(
      source,
    ) ?? []) {
      effectivePaths.set(logicalPath, effectivePath);
    }
  }
  if (effectivePaths.size > 0) {
    validatedMountEffectivePaths.set(target, effectivePaths);
  }
}

export function sanitizeMountCredentialEnvironmentForPersistence(state: {
  manifest: Manifest;
  environment?: Record<string, string>;
}): { manifest: Manifest; environment: Record<string, string> } {
  const environment = state.environment ?? {};
  const credentialNames = mountCredentialEnvironmentNamesForPersistence(
    state.manifest,
    environment,
  );
  const sanitizedManifest = cloneManifest(state.manifest);
  const sanitizedEnvironment = { ...environment };
  for (const name of credentialNames) {
    delete sanitizedEnvironment[name];
    const manifestEnvironment = sanitizedManifest.environment[name];
    if (manifestEnvironment) {
      sanitizedManifest.environment[name] = new Environment({
        value: '',
        ephemeral: true,
        ...(manifestEnvironment.description
          ? { description: manifestEnvironment.description }
          : {}),
      });
    }
  }
  return { manifest: sanitizedManifest, environment: sanitizedEnvironment };
}

function mountEffectiveEnvironment(
  manifest: Manifest,
  environment: Record<string, string>,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(manifest.environment).map(([name, value]) => [
        name,
        value.value,
      ]),
    ),
    ...environment,
  };
}

export function serializeMountCredentialRedactionMetadata(state: {
  manifest: Manifest;
  [key: string]: unknown;
}): Record<string, unknown> {
  const paths = new Set(readMountCredentialPaths(state));
  for (const [path, mount] of mountsByLogicalPath(state.manifest)) {
    if (configuredMountCredentialFields(mount).length > 0) {
      paths.add(path);
    }
  }
  return {
    ...(paths.size > 0
      ? { [REDACTED_MOUNT_CREDENTIAL_PATHS_KEY]: [...paths] }
      : {}),
    ...(manifestHasNonResumableMountAuthority(state.manifest)
      ? { [NON_RESUMABLE_MOUNT_AUTHORITY_KEY]: true }
      : {}),
  };
}

export function deserializeMountCredentialRedactionMetadata(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const paths = readMountCredentialPaths(state);
  return {
    ...(paths.length > 0
      ? { [REDACTED_MOUNT_CREDENTIAL_PATHS_KEY]: paths }
      : {}),
    ...(state[NON_RESUMABLE_MOUNT_AUTHORITY_KEY] === true
      ? { [NON_RESUMABLE_MOUNT_AUTHORITY_KEY]: true }
      : {}),
  };
}

export function sanitizePersistedManifestRecord(
  value: Record<string, unknown>,
): { record: Record<string, unknown>; credentialPaths: string[] } {
  if (MOUNT_CREDENTIAL_EXPOSURE_POLICY_KEYS.some((key) => key in value)) {
    throw new TypeError(
      'Persisted sandbox manifest cannot configure mount credential exposure policy.',
    );
  }
  const rawEntries = value.entries;
  if (rawEntries === undefined) {
    return { record: { ...value }, credentialPaths: [] };
  }
  if (!isRecord(rawEntries)) {
    throw new TypeError(
      'Persisted sandbox manifest entries must be an object.',
    );
  }
  assertRawPersistedCredentialFilesAreNotManifestEntries(value, rawEntries);
  const entries = structuredClone(rawEntries);
  const record = { ...value, entries };
  const credentialPaths: string[] = [];
  sanitizeRawEntryMapping(entries, '', credentialPaths);
  return { record, credentialPaths: [...new Set(credentialPaths)] };
}

export function recordPendingMountCredentialPaths(
  manifest: Manifest,
  paths: readonly string[],
): void {
  if (paths.length > 0) {
    pendingMountCredentialPaths.set(manifest, [...new Set(paths)]);
  }
}

export function validateMountCredentialRedactionPaths(
  manifest: Manifest,
  paths: readonly string[],
): void {
  assertCredentialPathsReferenceMounts(paths, mountsByLogicalPath(manifest));
}

export function recordPersistedMountTopology(manifest: Manifest): void {
  persistedMountTopologyManifests.add(manifest);
}

export function rebindPersistedMountCredentials<
  TState extends { manifest: Manifest; [key: string]: unknown },
>(state: TState, trustedManifest: Manifest | undefined): TState {
  const paths = [
    ...new Set([
      ...readMountCredentialPaths(state),
      ...(pendingMountCredentialPaths.get(state.manifest) ?? []),
    ]),
  ];
  const persistedMounts = mountsByLogicalPath(state.manifest);
  assertCredentialPathsReferenceMounts(paths, persistedMounts);
  if (!trustedManifest) {
    if (
      paths.length === 0 &&
      (!persistedMountTopologyManifests.has(state.manifest) ||
        persistedMounts.size === 0)
    ) {
      return state;
    }
    throw new SandboxMountError(
      'Sandbox session state contains mount topology that requires a current trusted manifest before resume.',
      undefined,
      'mount_config_invalid',
    );
  }

  const trustedMounts = mountsByLogicalPath(trustedManifest);
  if (
    persistedMountTopologyManifests.has(state.manifest) &&
    manifestHasNonResumableMountAuthority(trustedManifest)
  ) {
    throw new SandboxMountError(
      'Sandbox session state contains opaque mount authority that cannot be validated after persistence. Create a fresh sandbox from current trusted configuration.',
      undefined,
      'mount_config_invalid',
    );
  }
  assertMatchingMountTopology(
    state.manifest,
    trustedManifest,
    persistedMounts,
    trustedMounts,
  );
  for (const path of paths) {
    const trustedMount = trustedMounts.get(path)!;
    if (configuredMountCredentialFields(trustedMount).length === 0) {
      throw new SandboxMountError(
        `Current trusted manifest no longer provides credential authority for persisted mount entry: ${path}. Create a fresh sandbox from current trusted configuration.`,
        undefined,
        'mount_config_invalid',
      );
    }
  }
  const reboundManifest = cloneManifest(state.manifest);
  const reboundMounts = mountsByLogicalPath(reboundManifest);
  for (const [path, mount] of reboundMounts) {
    restoreMountCredentials(mount, trustedMounts.get(path)!);
  }
  replaceManifestMountCredentialExposurePolicy(
    reboundManifest,
    trustedManifest,
  );
  validateMountCredentialBoundaries(reboundManifest);
  trustedCredentialReboundManifests.add(reboundManifest);

  const rebound = { ...state, manifest: reboundManifest };
  delete rebound[REDACTED_MOUNT_CREDENTIAL_PATHS_KEY];
  return rebound as TState;
}

export function recordLiveMountCredentialAuthority(
  target: Manifest,
  source: Manifest,
): void {
  const authoritySource = liveMountCredentialAuthority.get(source) ?? source;
  const authority = cloneManifest(authoritySource);
  copyValidatedMountEffectivePaths(authority, authoritySource);
  liveMountCredentialAuthority.set(target, authority);
  const environmentAuthority = liveMountEnvironmentAuthority.get(source);
  if (environmentAuthority !== undefined) {
    liveMountEnvironmentAuthority.set(target, environmentAuthority);
  }
  const runtimeAuthority = liveMountRuntimeAuthority.get(source);
  if (runtimeAuthority !== undefined) {
    liveMountRuntimeAuthority.set(target, new Map(runtimeAuthority));
  }
}

export function captureLiveMountRuntimeAuthority(
  manifest: Manifest,
  key: symbol,
  signature: string,
): void {
  const authority = new Map(liveMountRuntimeAuthority.get(manifest) ?? []);
  authority.set(key, signature);
  liveMountRuntimeAuthority.set(manifest, authority);
}

export function liveMountRuntimeAuthorityMatches(
  manifest: Manifest,
  key: symbol,
  signature: string,
): boolean {
  return liveMountRuntimeAuthority.get(manifest)?.get(key) === signature;
}

export function captureLiveMountCredentialAuthority(
  manifest: Manifest,
  environment?: Record<string, string>,
): void {
  const authority = cloneManifest(manifest);
  copyValidatedMountEffectivePaths(authority, manifest);
  liveMountCredentialAuthority.set(manifest, authority);
  if (environment) {
    captureLiveMountEnvironmentAuthority(manifest, environment);
  }
}

export function captureLiveMountEnvironmentAuthority(
  manifest: Manifest,
  environment: Record<string, string>,
): void {
  liveMountEnvironmentAuthority.set(
    manifest,
    mountCredentialEnvironmentAuthoritySignature(manifest, environment),
  );
}

export function captureLiveMountCredentialAuthorityIfAbsent(
  manifest: Manifest,
  environment?: Record<string, string>,
): void {
  if (!liveMountCredentialAuthority.has(manifest)) {
    captureLiveMountCredentialAuthority(manifest, environment);
  } else if (environment && !liveMountEnvironmentAuthority.has(manifest)) {
    liveMountEnvironmentAuthority.set(
      manifest,
      mountCredentialEnvironmentAuthoritySignature(manifest, environment),
    );
  }
}

export function copyTrustedMountCredentialRebindProvenance(
  target: Manifest,
  source: Manifest,
): void {
  if (trustedCredentialReboundManifests.has(source)) {
    trustedCredentialReboundManifests.add(target);
  }
}

export function liveMountCredentialAuthorityMatches(
  liveManifest: Manifest,
  trustedManifest: Manifest,
): boolean {
  const liveMounts = mountsByLogicalPath(liveManifest);
  const trustedMounts = mountsByLogicalPath(trustedManifest);
  try {
    assertMatchingMountTopology(
      liveManifest,
      trustedManifest,
      liveMounts,
      trustedMounts,
    );
  } catch (error) {
    if (error instanceof SandboxMountError) {
      return false;
    }
    throw error;
  }
  const authority =
    liveMountCredentialAuthority.get(liveManifest) ?? liveManifest;
  return (
    mountCredentialAuthoritySignature(authority, authority) ===
    mountCredentialAuthoritySignature(trustedManifest, authority)
  );
}

export function assertLiveMountCredentialAuthorityMatches(
  liveManifest: Manifest,
  candidateManifest: Manifest,
): void {
  if (liveMountCredentialAuthorityMatches(liveManifest, candidateManifest)) {
    return;
  }
  throw new SandboxMountError(
    'Sandbox mount authority does not match the active session. Route topology changes through materializeEntry() or applyManifest(), or create a fresh sandbox session.',
    undefined,
    'mount_config_invalid',
  );
}

export function liveMountEnvironmentAuthorityMatches(
  liveManifest: Manifest,
  trustedManifest: Manifest,
  trustedEnvironment: Record<string, string>,
): boolean {
  const trustedAuthority = mountCredentialEnvironmentAuthoritySignature(
    trustedManifest,
    trustedEnvironment,
  );
  return (
    (liveMountEnvironmentAuthority.get(liveManifest) ??
      mountCredentialEnvironmentAuthoritySignature(liveManifest, {})) ===
    trustedAuthority
  );
}

export function assertLiveMountEnvironmentAuthorityMatches(
  liveManifest: Manifest,
  trustedManifest: Manifest,
  trustedEnvironment: Record<string, string>,
): void {
  if (
    liveMountEnvironmentAuthorityMatches(
      liveManifest,
      trustedManifest,
      trustedEnvironment,
    )
  ) {
    return;
  }
  throw new SandboxMountError(
    'Sandbox mount environment authority does not match the active session. Create a fresh sandbox session from current trusted configuration.',
    undefined,
    'mount_config_invalid',
  );
}

export function assertExistingMountTopologyPreserved(
  currentManifest: Manifest,
  nextManifest: Manifest,
): void {
  const currentMounts = mountsByLogicalPath(currentManifest);
  if (currentMounts.size === 0) {
    return;
  }
  const nextMounts = mountsByLogicalPath(nextManifest);
  const changedPaths = [...currentMounts]
    .filter(([path, currentMount]) => {
      const nextMount = nextMounts.get(path);
      return (
        nextMount === undefined ||
        stableJsonStringify(
          redactMountCredentialsForPersistence(currentMount),
        ) !==
          stableJsonStringify(redactMountCredentialsForPersistence(nextMount))
      );
    })
    .map(([path]) => path)
    .sort();
  if (currentManifest.root !== nextManifest.root || changedPaths.length > 0) {
    throw new SandboxMountError(
      `Active sandbox mounts cannot be removed or replaced by a manifest mutation${
        changedPaths.length > 0 ? `: ${changedPaths.join(', ')}` : ''
      }. Create a fresh sandbox session instead.`,
      undefined,
      'mount_config_invalid',
    );
  }
}

export function assertMountCredentialsRebound(state: {
  manifest: Manifest;
  [key: string]: unknown;
}): void {
  if (state[NON_RESUMABLE_MOUNT_AUTHORITY_KEY] === true) {
    throw new SandboxMountError(
      'Sandbox session state contains non-resumable mount authority. Create a fresh sandbox from current trusted configuration.',
      undefined,
      'mount_config_invalid',
    );
  }
  const paths = [
    ...new Set([
      ...readMountCredentialPaths(state),
      ...(pendingMountCredentialPaths.get(state.manifest) ?? []),
    ]),
  ];
  if (paths.length > 0) {
    throw new SandboxMountError(
      `Sandbox session state requires trusted mount credentials for these entry paths: ${paths.join(', ')}. Resume it through the Runner with a current manifest that defines each mount.`,
      undefined,
      'mount_config_invalid',
    );
  }
  if (manifestHasInContainerMounts(state.manifest)) {
    throw new SandboxMountError(
      'Sandbox session state with in-container mounts cannot be resumed safely. Create a fresh sandbox so mount helpers are recreated from current trusted configuration.',
      undefined,
      'mount_config_invalid',
    );
  }
  const mounts = mountsByLogicalPath(state.manifest);
  const requiresTrustedRebind =
    (persistedMountTopologyManifests.has(state.manifest) && mounts.size > 0) ||
    [...mounts.values()].some(
      (mount) => configuredMountCredentialFields(mount).length > 0,
    );
  if (
    requiresTrustedRebind &&
    !trustedCredentialReboundManifests.has(state.manifest)
  ) {
    throw new SandboxMountError(
      'Persisted sandbox mount topology must be rebound from a current trusted manifest before resume.',
      undefined,
      'mount_config_invalid',
    );
  }
}

function readMountCredentialPaths(state: Record<string, unknown>): string[] {
  const value = state[REDACTED_MOUNT_CREDENTIAL_PATHS_KEY];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((path) => typeof path === 'string')
  ) {
    throw new TypeError(
      'Persisted sandbox mount credential marker must be an array of strings.',
    );
  }
  return value;
}

function sanitizeRawEntryMapping(
  entries: Record<string, unknown>,
  prefix: string,
  credentialPaths: string[],
): void {
  for (const [name, rawEntry] of Object.entries(entries)) {
    if (!isRecord(rawEntry)) {
      throw new TypeError(
        'Persisted sandbox manifest entries must contain objects.',
      );
    }
    const path = prefix ? `${prefix}/${name}` : name;
    const type = typeof rawEntry.type === 'string' ? rawEntry.type : '';
    const looksLikeMount =
      type === 'mount' ||
      type.endsWith('_mount') ||
      'mountStrategy' in rawEntry;
    let removed = false;
    if (looksLikeMount) {
      const fields = configuredMountCredentialFields(
        rawEntry as unknown as Mount | TypedMount,
      );
      for (const field of fields) {
        const value = readNestedField(rawEntry, field);
        if (value !== undefined && value !== null) {
          removed = true;
        }
        deleteNestedField(rawEntry, field);
      }
    }
    if (removed) {
      credentialPaths.push(path);
    }
    if (type === 'dir' && rawEntry.children !== undefined) {
      if (!isRecord(rawEntry.children)) {
        throw new TypeError(
          'Persisted sandbox directory children must be an object.',
        );
      }
      sanitizeRawEntryMapping(rawEntry.children, path, credentialPaths);
    }
  }
}

function assertRawPersistedCredentialFilesAreNotManifestEntries(
  manifestRecord: Record<string, unknown>,
  entries: Record<string, unknown>,
): void {
  const entriesByPath = new Map<string, Record<string, unknown>>();
  collectRawEntries(entries, '', entriesByPath);
  const root =
    typeof manifestRecord.root === 'string'
      ? manifestRecord.root
      : '/workspace';
  const environment = rawPersistedEnvironment(manifestRecord.environment);
  for (const [logicalPath, entry] of entriesByPath) {
    const type = typeof entry.type === 'string' ? entry.type : '';
    const looksLikeMount =
      type === 'mount' || type.endsWith('_mount') || 'mountStrategy' in entry;
    if (!looksLikeMount) {
      continue;
    }
    const credentialEnvironment = mountCredentialEnvironmentForEntry(
      entry as unknown as Mount | TypedMount,
      environment,
    );
    const pattern = mountStrategyPattern(entry.mountStrategy);
    const credentialFiles = new Map<string, string>();
    for (const [field, value] of [
      ['serviceAccountFile', entry.serviceAccountFile],
      ['boxConfigFile', entry.boxConfigFile],
      ['mountStrategy.pattern.configFilePath', pattern?.configFilePath],
    ] as const) {
      if (typeof value === 'string' && value.trim() !== '') {
        credentialFiles.set(field, value);
      }
    }
    for (const [name, value] of Object.entries(credentialEnvironment)) {
      if (isMountCredentialFileEnvironmentName(name) && value.trim() !== '') {
        credentialFiles.set(`environment.${name}`, value);
      }
    }
    const serializedCredentialFields = [...credentialFiles]
      .filter(([, value]) =>
        rawCredentialFileReferenceMatchesEntry(value, root, entriesByPath),
      )
      .map(([field]) => field)
      .sort();
    if (serializedCredentialFields.length > 0) {
      throw new SandboxMountError(
        'Mount credential files cannot come from a serialized manifest entry.',
        {
          mountPath: normalizePosixPath(`${root}/${logicalPath}`),
          mountType: type,
          credentialFields: serializedCredentialFields,
        },
        'mount_config_invalid',
      );
    }
  }
}

function collectRawEntries(
  entries: Record<string, unknown>,
  prefix: string,
  output: Map<string, Record<string, unknown>>,
): void {
  for (const [name, value] of Object.entries(entries)) {
    if (!isRecord(value)) {
      continue;
    }
    const path = prefix ? `${prefix}/${name}` : name;
    output.set(path, value);
    if (value.type === 'dir' && isRecord(value.children)) {
      collectRawEntries(value.children, path, output);
    }
  }
}

function rawPersistedEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, rawValue]) => {
      if (typeof rawValue === 'string') {
        return [[name, rawValue]];
      }
      if (isRecord(rawValue) && typeof rawValue.value === 'string') {
        return [[name, rawValue.value]];
      }
      return [];
    }),
  );
}

function rawCredentialFileReferenceMatchesEntry(
  value: string,
  root: string,
  entriesByPath: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  const normalizedReference = value.startsWith('/')
    ? normalizePosixPath(value)
    : normalizeRelativePath(value);
  for (const [logicalPath, entry] of entriesByPath) {
    const entryPath = value.startsWith('/')
      ? normalizePosixPath(`${root}/${logicalPath}`)
      : logicalPath;
    if (
      entryPath === normalizedReference ||
      (entryIsRecursiveSource(entry) &&
        isUnderPosixPath(normalizedReference, entryPath))
    ) {
      return true;
    }
  }
  return false;
}

export function redactMountCredentialsForPersistence(
  entry: Mount | TypedMount,
): Entry {
  const redacted = structuredClone(entry) as Record<string, unknown>;
  if (entry.type !== 'mount') {
    // Typed mount topology is also represented by canonical top-level fields and
    // is regenerated during manifest normalization. Dropping config here keeps
    // residual provider authority out of persisted state and topology checks.
    delete redacted.config;
  }
  for (const field of configuredMountCredentialFields(entry)) {
    deleteNestedField(redacted, field);
  }
  return redacted as Entry;
}

function restoreMountCredentials(
  target: Mount | TypedMount,
  trusted: Mount | TypedMount,
): void {
  const targetRecord = target as Record<string, unknown>;
  const trustedRecord = trusted as Record<string, unknown>;
  const fields = new Set([
    ...configuredMountCredentialFields(target),
    ...configuredMountCredentialFields(trusted),
  ]);
  for (const field of fields) {
    const trustedValue = readNestedField(trustedRecord, field);
    if (trustedValue !== undefined) {
      writeNestedField(targetRecord, field, structuredClone(trustedValue));
    } else {
      deleteNestedField(targetRecord, field);
    }
  }
}

function assertMatchingMountTopology(
  persistedManifest: Manifest,
  trustedManifest: Manifest,
  persisted: Map<string, Mount | TypedMount>,
  trusted: Map<string, Mount | TypedMount>,
): void {
  if (persistedManifest.root !== trustedManifest.root) {
    throw new SandboxMountError(
      'Sandbox session state mount root does not match current trusted configuration.',
      undefined,
      'mount_config_invalid',
    );
  }
  const allPaths = new Set([...persisted.keys(), ...trusted.keys()]);
  const topologyMismatch = [...allPaths]
    .filter((path) => !persisted.has(path) || !trusted.has(path))
    .sort();
  if (topologyMismatch.length > 0) {
    throw new SandboxMountError(
      `Sandbox session state mount topology does not match current trusted configuration for these entry paths: ${topologyMismatch.join(', ')}.`,
      undefined,
      'mount_config_invalid',
    );
  }
  const configMismatch = [...persisted.keys()]
    .filter(
      (path) =>
        stableJsonStringify(
          redactMountCredentialsForPersistence(persisted.get(path)!),
        ) !==
        stableJsonStringify(
          redactMountCredentialsForPersistence(trusted.get(path)!),
        ),
    )
    .sort();
  if (configMismatch.length > 0) {
    throw new SandboxMountError(
      `Sandbox session state mount configuration does not match current trusted configuration for these entry paths: ${configMismatch.join(', ')}.`,
      undefined,
      'mount_config_invalid',
    );
  }
}

function assertCredentialPathsReferenceMounts(
  paths: readonly string[],
  mounts: Map<string, Mount | TypedMount>,
): void {
  if (paths.some((path) => !mounts.has(path))) {
    throw new TypeError(
      'Persisted sandbox mount credential marker contains an invalid path.',
    );
  }
}

function mountsByLogicalPath(
  manifest: Manifest,
): Map<string, Mount | TypedMount> {
  return new Map(
    [...manifest.iterEntries()]
      .filter(({ entry }) => isMount(entry))
      .map(({ logicalPath, entry }) => [
        logicalPath,
        entry as Mount | TypedMount,
      ]),
  );
}

function mountCredentialAuthoritySignature(
  manifest: Manifest,
  effectivePathSource: Manifest,
): string {
  const effectivePaths = validatedMountEffectivePaths.get(effectivePathSource);
  return stableJsonStringify(
    manifest
      .mountTargets()
      .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
      .map(({ logicalPath, mountPath, entry: mount }) => {
        const mountRecord = mount as Record<string, unknown>;
        const effectivePath =
          effectivePaths?.get(logicalPath) ?? normalizePosixPath(mountPath);
        const credentials = Object.fromEntries(
          configuredMountCredentialFields(mount).map((field) => [
            field,
            readNestedField(mountRecord, field),
          ]),
        );
        return {
          path: logicalPath,
          effectivePath,
          credentials,
          inContainerExposureAcknowledgement:
            mountCredentialExposureAcknowledgement(manifest, effectivePath),
        };
      }),
  );
}

function assertMountCredentialFilesAreNotSerializedManifestEntries(
  manifest: Manifest,
  entry: Mount | TypedMount,
  mountPath: string,
  credentialEnvironment: Record<string, string> = {},
): void {
  const credentialFiles = mountCredentialFileReferences(
    manifest,
    entry,
    credentialEnvironment,
  );
  const manifestEntries = [...manifest.iterEntries()];
  const serializedCredentialFields = credentialFiles
    .filter(({ path }) => {
      const normalized = path.startsWith('/')
        ? normalizePosixPath(path)
        : normalizeRelativePath(path);
      return manifestEntries.some(({ logicalPath, absolutePath, entry }) => {
        const entryPath = path.startsWith('/') ? absolutePath : logicalPath;
        return (
          entryPath === normalized ||
          (entryIsRecursiveSource(entry) &&
            isUnderPosixPath(normalized, entryPath))
        );
      });
    })
    .map(({ field }) => field)
    .sort();
  if (serializedCredentialFields.length === 0) {
    return;
  }
  throw new SandboxMountError(
    'Mount credential files cannot come from a serialized manifest entry.',
    {
      mountPath,
      mountType: entry.type,
      credentialFields: serializedCredentialFields,
    },
    'mount_config_invalid',
  );
}

export function mountCredentialFileReferences(
  manifest: Manifest,
  entry: Mount | TypedMount,
  environment: Record<string, string> = {},
): MountCredentialFileReference[] {
  const pattern = mountStrategyPattern(
    (entry as Record<string, unknown>).mountStrategy,
  );
  const entryRecord = entry as Record<string, unknown>;
  const credentialFiles = new Map<string, string>();
  for (const [field, value] of [
    ['serviceAccountFile', entryRecord.serviceAccountFile],
    ['boxConfigFile', entryRecord.boxConfigFile],
    ['mountStrategy.pattern.configFilePath', pattern?.configFilePath],
  ] as const) {
    if (typeof value === 'string' && value.trim() !== '') {
      credentialFiles.set(field, value);
    }
  }
  const credentialEnvironment = mountCredentialEnvironmentForEntry(
    entry,
    mountEffectiveEnvironment(manifest, environment),
  );
  for (const [name, value] of Object.entries(credentialEnvironment)) {
    if (isMountCredentialFileEnvironmentName(name) && value.trim() !== '') {
      credentialFiles.set(`environment.${name}`, value);
    }
  }
  return [...credentialFiles].map(([field, path]) => ({ field, path }));
}

export function validateMountCredentialFileEffectivePaths(args: {
  entry: Mount | TypedMount;
  mountPath: string;
  credentialFiles: readonly MountCredentialFileReference[];
  manifestEntries: readonly EffectiveManifestEntryPath[];
}): void {
  const serializedCredentialFields = args.credentialFiles
    .filter(({ path }) =>
      args.manifestEntries.some(
        (entry) =>
          entry.path === path ||
          (entry.recursive && isUnderPosixPath(path, entry.path)),
      ),
    )
    .map(({ field }) => field)
    .sort();
  if (serializedCredentialFields.length === 0) {
    return;
  }
  throw new SandboxMountError(
    'Mount credential files cannot resolve to a serialized manifest entry.',
    {
      mountPath: args.mountPath,
      mountType: args.entry.type,
      credentialFields: serializedCredentialFields,
    },
    'mount_config_invalid',
  );
}

function entryIsRecursiveSource(entry: { type?: unknown }): boolean {
  return entry.type === 'local_dir' || entry.type === 'git_repo';
}

function mountCredentialEnvironmentNamesForPersistence(
  manifest: Manifest,
  environment: Record<string, string>,
): Set<string> {
  const names = new Set<string>();
  const configuredNames = new Set([
    ...Object.keys(manifest.environment),
    ...Object.keys(environment),
  ]);
  for (const { entry } of manifest.mountTargets()) {
    if (
      !isMount(entry) ||
      !ENVIRONMENT_CREDENTIAL_STRATEGIES.has(mountStrategyType(entry))
    ) {
      continue;
    }
    if (mountUsesRcloneEnvironment(entry)) {
      for (const name of configuredNames) {
        if (name === 'RCLONE_CONFIG' || name.startsWith('RCLONE_CONFIG_')) {
          names.add(name);
        }
      }
    }
    if (
      entry.type === 's3_mount' ||
      entry.type === 'r2_mount' ||
      entry.type === 's3_files_mount'
    ) {
      for (const name of [
        ...S3_MOUNT_CREDENTIAL_ENVIRONMENT_NAMES,
        ...S3_MOUNT_BROAD_CREDENTIAL_ENVIRONMENT_NAMES,
      ]) {
        if (configuredNames.has(name)) {
          names.add(name);
        }
      }
    }
    if (entry.type === 'gcs_mount') {
      for (const name of GCS_MOUNT_ENVIRONMENT_NAMES) {
        if (configuredNames.has(name)) {
          names.add(name);
        }
      }
    }
  }
  return names;
}

export function mountCredentialEnvironmentForEntry(
  entry: Entry,
  environment: Record<string, string>,
): Record<string, string> {
  if (!isMount(entry)) {
    return {};
  }
  if (!ENVIRONMENT_CREDENTIAL_STRATEGIES.has(mountStrategyType(entry))) {
    return {};
  }
  const names = new Set<string>();
  if (mountUsesRcloneEnvironment(entry)) {
    for (const name of Object.keys(environment)) {
      if (name === 'RCLONE_CONFIG' || name.startsWith('RCLONE_CONFIG_')) {
        names.add(name);
      }
    }
  }
  const entryRecord = entry as Record<string, unknown>;
  const usesS3EntryCredentialPair = Boolean(
    entryRecord.accessKeyId && entryRecord.secretAccessKey,
  );
  const exposesShadowedCredentialEnvironment =
    mountUsesRcloneEnvironment(entry);
  const usesS3CredentialEnvironment =
    ((!usesS3EntryCredentialPair || exposesShadowedCredentialEnvironment) &&
      S3_MOUNT_CREDENTIAL_ENVIRONMENT_NAMES.some(
        (name) => environment[name] !== undefined,
      )) ||
    S3_MOUNT_BROAD_CREDENTIAL_ENVIRONMENT_NAMES.some(
      (name) => environment[name] !== undefined,
    );
  if (
    (entry.type === 's3_mount' ||
      entry.type === 'r2_mount' ||
      entry.type === 's3_files_mount') &&
    usesS3CredentialEnvironment
  ) {
    const environmentNames =
      usesS3EntryCredentialPair && !exposesShadowedCredentialEnvironment
        ? S3_MOUNT_BROAD_CREDENTIAL_ENVIRONMENT_NAMES
        : S3_MOUNT_ENVIRONMENT_NAMES;
    for (const name of environmentNames) {
      names.add(name);
    }
  }
  const usesGcsEntryCredentials = Boolean(
    (entryRecord.accessId && entryRecord.secretAccessKey) ||
    entryRecord.serviceAccountCredentials ||
    entryRecord.serviceAccountFile ||
    entryRecord.accessToken,
  );
  if (
    entry.type === 'gcs_mount' &&
    (!usesGcsEntryCredentials || exposesShadowedCredentialEnvironment) &&
    environment.GOOGLE_APPLICATION_CREDENTIALS !== undefined
  ) {
    for (const name of GCS_MOUNT_ENVIRONMENT_NAMES) {
      names.add(name);
    }
  }
  return Object.fromEntries(
    [...names].flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );
}

function mountCredentialEnvironmentAuthoritySignature(
  manifest: Manifest,
  environment: Record<string, string>,
): string {
  return stableJsonStringify(
    manifest
      .mountTargets()
      .map(({ mountPath, entry }) => ({
        mountPath,
        environment: mountCredentialEnvironmentForEntry(entry, environment),
      }))
      .filter(({ environment: authority }) => Object.keys(authority).length > 0)
      .sort(({ mountPath: left }, { mountPath: right }) =>
        left.localeCompare(right),
      ),
  );
}

function mountStrategyType(entry: Mount | TypedMount): string {
  const type = (entry.mountStrategy as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' ? type : '<unknown>';
}

function mountStrategyPattern(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return isRecord(value.pattern) ? value.pattern : undefined;
}

function mountUsesRcloneEnvironment(entry: Mount | TypedMount): boolean {
  const strategyType = mountStrategyType(entry);
  if (strategyType === 'vercel_cloud_bucket') {
    return false;
  }
  if (
    strategyType === 'e2b_cloud_bucket' ||
    strategyType === 'daytona_cloud_bucket' ||
    strategyType === 'runloop_cloud_bucket'
  ) {
    return true;
  }
  const patternType = mountStrategyPattern(entry.mountStrategy)?.type;
  if (patternType !== undefined) {
    return patternType === 'rclone';
  }
  return (
    strategyType === 'in_container' &&
    (entry.type === 's3_mount' ||
      entry.type === 'r2_mount' ||
      entry.type === 'gcs_mount' ||
      entry.type === 'azure_blob_mount' ||
      entry.type === 'box_mount')
  );
}

function strategyFieldContainsCredentials(
  field: string,
  value: unknown,
): boolean {
  if (
    field === 'mountStrategy.pattern.args' ||
    field === 'mountStrategy.pattern.extraArgs'
  ) {
    return !isCredentialFreeRcloneArgumentList(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return field.endsWith('configFilePath') || value !== undefined;
}

function readNestedField(
  record: Record<string, unknown>,
  field: string,
): unknown {
  let current: unknown = record;
  for (const segment of field.split('.')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function writeNestedField(
  record: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  const segments = field.split('.');
  let current = record;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function deleteNestedField(
  record: Record<string, unknown>,
  field: string,
): void {
  const segments = field.split('.');
  let current: Record<string, unknown> = record;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) {
      return;
    }
    current = current[segment] as Record<string, unknown>;
  }
  delete current[segments.at(-1)!];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
