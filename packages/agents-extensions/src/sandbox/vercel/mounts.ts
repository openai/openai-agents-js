import {
  SandboxMountError,
  SandboxUnsupportedFeatureError,
  type Entry,
  type S3Mount,
} from '@openai/agents-core/sandbox';
import { validateCredentialPair } from '@openai/agents-core/sandbox/internal';
import {
  providerErrorMessage,
  readOptionalString,
  shellQuote,
} from '../shared';

const MOUNTPOINT_S3_MINIMUM_VERSION = [1, 21, 0] as const;
const MOUNTPOINT_S3_PACKAGE = 'mount-s3';
const MOUNTPOINT_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MOUNTPOINT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const MOUNTPOINT_S3_SOURCE = 'mountpoint-s3';
const FINDMNT_RAW_ESCAPE_SEQUENCE = /(?:\\x[0-9a-f]{2})+/giu;
const FINDMNT_RAW_BYTE_ESCAPE = /\\x([0-9a-f]{2})/giu;

export class VercelCloudBucketMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'vercel_cloud_bucket';
}

export type VercelMountCommandOptions = {
  env?: Record<string, string>;
  sudo?: boolean;
  timeoutMs?: number;
};

export type VercelMountCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

export type VercelMountCommand = (
  command: string,
  args: string[],
  options?: VercelMountCommandOptions,
) => Promise<VercelMountCommandResult>;

type VercelS3MountConfig = {
  mount: S3Mount;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  endpointUrl?: string;
  prefix?: string;
};

type VercelMountOwner = {
  uid: string;
  gid: string;
};

export type VercelS3MountCredentials = {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Expiration time for temporary credentials. */
  expiration?: Date;
};

export type VercelS3MountConfiguration = {
  /** Logical manifest entry path relative to the workspace root. */
  logicalPath: string;
  /** Current trusted mount path, absolute or relative to the workspace root. */
  mountPath: string;
  /** Current trusted mount configuration, optionally including credentials. */
  mount: S3Mount;
};

/**
 * Resolves the complete authoritative S3 mount set for a resumed session.
 *
 * `persistedMounts` is untrusted context and must not be returned without
 * validating it against current trusted configuration.
 */
export type VercelS3MountConfigurationResolver = (args: {
  persistedMounts: ReadonlyArray<{
    logicalPath: string;
    mountPath: string;
    mount: Readonly<S3Mount>;
  }>;
}) =>
  | ReadonlyArray<VercelS3MountConfiguration>
  | Promise<ReadonlyArray<VercelS3MountConfiguration>>;

export type VercelS3MountCredentialResolver = (args: {
  mountPath: string;
  mount: Readonly<S3Mount>;
}) =>
  | VercelS3MountCredentials
  | undefined
  | Promise<VercelS3MountCredentials | undefined>;

export function isVercelCloudBucketMountEntry(entry: Entry): entry is S3Mount {
  return (
    entry.type === 's3_mount' &&
    entry.mountStrategy?.type === 'vercel_cloud_bucket'
  );
}

export async function mountVercelCloudBucket(args: {
  entry: Entry;
  mountPath: string;
  runCommand: VercelMountCommand;
  credentials?: VercelS3MountCredentials;
  validateMountPath?: () => Promise<void>;
}): Promise<void> {
  const config = resolveVercelS3MountConfig(args.entry, args.credentials);
  await ensureMountpoint(args.runCommand);

  await runRequiredCommand({
    runCommand: args.runCommand,
    label: 'create the S3 mount directory',
    command: 'mkdir',
    commandArgs: ['-p', '--', args.mountPath],
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
    details: {
      mountPath: args.mountPath,
    },
  });

  const owner =
    (config.mount.readOnly ?? true)
      ? undefined
      : await resolveMountOwner(args.runCommand);
  await assertEmptyMountDirectory(args.runCommand, args.mountPath);
  await args.validateMountPath?.();

  const environment = mountEnvironment(config);
  await runRequiredCommand({
    runCommand: args.runCommand,
    label: 'mount the S3 bucket',
    command: 'mount-s3',
    commandArgs: mountArguments(config, args.mountPath, owner),
    options: {
      env: environment,
      sudo: true,
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
    details: {
      bucket: config.mount.bucket,
      mountPath: args.mountPath,
    },
  });
}

export async function unmountVercelCloudBucket(args: {
  mountPath: string;
  runCommand: VercelMountCommand;
}): Promise<void> {
  if (!(await isVercelCloudBucketMounted(args))) {
    return;
  }
  const commandArgs = [args.mountPath];
  const result = await invokeCommand({
    runCommand: args.runCommand,
    label: 'unmount the S3 bucket',
    command: 'umount',
    commandArgs,
    options: {
      sudo: true,
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
  });
  if (result.status === 0) {
    return;
  }

  const mountpoint = await invokeCommand({
    runCommand: args.runCommand,
    label: 'check the S3 mountpoint',
    command: 'mountpoint',
    commandArgs: ['-q', '--', args.mountPath],
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
  });
  if (mountpoint.status === 1) {
    return;
  }

  throw commandFailure({
    label: 'unmount the S3 bucket',
    command: 'umount',
    commandArgs,
    result,
    details: {
      mountPath: args.mountPath,
    },
  });
}

export async function isVercelCloudBucketMounted(args: {
  mountPath: string;
  runCommand: VercelMountCommand;
}): Promise<boolean> {
  const commandArgs = [
    '--noheadings',
    '--output',
    'SOURCE',
    '--mountpoint',
    args.mountPath,
  ];
  const result = await invokeCommand({
    runCommand: args.runCommand,
    label: 'check the S3 mountpoint source',
    command: 'findmnt',
    commandArgs,
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
  });
  if (result.status === 0) {
    const actualSource = result.stdout?.trim();
    if (actualSource === MOUNTPOINT_S3_SOURCE) {
      return true;
    }
    throw new SandboxMountError(
      'VercelSandboxClient found an unexpected filesystem at the S3 mount path.',
      {
        provider: 'vercel',
        command: displayCommand('findmnt', commandArgs),
        mountPath: args.mountPath,
        mountIdentityMismatch: true,
        expectedSource: MOUNTPOINT_S3_SOURCE,
        actualSource: actualSource ?? '',
      },
      'mount_failed',
    );
  }
  if (result.status === 1) {
    return false;
  }
  throw commandFailure({
    label: 'check the S3 mountpoint source',
    command: 'findmnt',
    commandArgs,
    result,
    details: {
      mountPath: args.mountPath,
    },
  });
}

export async function listVercelCloudBucketMountPaths(args: {
  runCommand: VercelMountCommand;
}): Promise<string[]> {
  const commandArgs = [
    '--noheadings',
    '--raw',
    '--output',
    'TARGET',
    '--source',
    MOUNTPOINT_S3_SOURCE,
  ];
  const result = await invokeCommand({
    runCommand: args.runCommand,
    label: 'list S3 mountpoints',
    command: 'findmnt',
    commandArgs,
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
  });
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    throw commandFailure({
      label: 'list S3 mountpoints',
      command: 'findmnt',
      commandArgs,
      result,
    });
  }
  const mountPaths = (result.stdout ?? '')
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map(decodeFindmntRawValue);
  if (mountPaths.length === 0) {
    throw new SandboxMountError(
      'VercelSandboxClient could not determine the live S3 mount paths.',
      {
        provider: 'vercel',
        command: displayCommand('findmnt', commandArgs),
      },
      'mount_failed',
    );
  }
  return mountPaths;
}

function decodeFindmntRawValue(value: string): string {
  return value.replace(FINDMNT_RAW_ESCAPE_SEQUENCE, (escapedBytes) =>
    new TextDecoder().decode(
      Uint8Array.from(
        [...escapedBytes.matchAll(FINDMNT_RAW_BYTE_ESCAPE)].map((match) =>
          Number.parseInt(match[1]!, 16),
        ),
      ),
    ),
  );
}

export function readVercelS3MountCredentials(
  entry: Entry,
): VercelS3MountCredentials | undefined {
  const credentials = normalizeVercelS3MountCredentials({
    accessKeyId: readOptionalString(entry, 'accessKeyId'),
    secretAccessKey: readOptionalString(entry, 'secretAccessKey'),
    sessionToken: readOptionalString(entry, 'sessionToken'),
  });
  return credentials.accessKeyId ? credentials : undefined;
}

export function normalizeVercelS3MountCredentials(
  credentials: VercelS3MountCredentials = {},
): VercelS3MountCredentials {
  const accessKeyId = readOptionalString(credentials, 'accessKeyId');
  const secretAccessKey = readOptionalString(credentials, 'secretAccessKey');
  const sessionToken = readOptionalString(credentials, 'sessionToken');
  const expiration = credentials.expiration;
  if (
    expiration !== undefined &&
    (!(expiration instanceof Date) || !Number.isFinite(expiration.getTime()))
  ) {
    throw new SandboxMountError(
      'Vercel S3 mount credential expiration must be a valid Date.',
      {
        provider: 'vercel',
        mountType: 's3_mount',
      },
      'mount_config_invalid',
    );
  }
  validateCredentialPair({
    accessKeyId,
    secretAccessKey,
    message:
      'Vercel S3 mounts require both accessKeyId and secretAccessKey when either is provided.',
    details: {
      provider: 'vercel',
      mountType: 's3_mount',
    },
    code: 'mount_config_invalid',
  });
  if (sessionToken && !accessKeyId) {
    throw new SandboxMountError(
      'Vercel S3 mounts require accessKeyId and secretAccessKey when sessionToken is provided.',
      {
        provider: 'vercel',
        mountType: 's3_mount',
      },
      'mount_config_invalid',
    );
  }
  if (expiration && !accessKeyId) {
    throw new SandboxMountError(
      'Vercel S3 mounts require accessKeyId and secretAccessKey when credential expiration is provided.',
      {
        provider: 'vercel',
        mountType: 's3_mount',
      },
      'mount_config_invalid',
    );
  }
  return {
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
    ...(sessionToken ? { sessionToken } : {}),
    ...(expiration ? { expiration: new Date(expiration.getTime()) } : {}),
  };
}

function resolveVercelS3MountConfig(
  entry: Entry,
  credentials?: VercelS3MountCredentials,
): VercelS3MountConfig {
  if (!isVercelCloudBucketMountEntry(entry)) {
    throw new SandboxUnsupportedFeatureError(
      'VercelSandboxClient only supports VercelCloudBucketMountStrategy on S3 mount entries.',
      {
        provider: 'vercel',
        feature: 'entry.mountStrategy',
        mountType: entry.type,
        strategyType: (entry as { mountStrategy?: { type?: unknown } })
          .mountStrategy?.type,
      },
    );
  }

  const normalizedCredentials = normalizeVercelS3MountCredentials(
    credentials ?? readVercelS3MountCredentials(entry),
  );

  return {
    mount: entry,
    ...normalizedCredentials,
    region: readOptionalString(entry, 'region'),
    endpointUrl: readOptionalString(entry, 'endpointUrl'),
    prefix: readOptionalString(entry, 'prefix'),
  };
}

async function ensureMountpoint(runCommand: VercelMountCommand): Promise<void> {
  const check = await invokeCommand({
    runCommand,
    label: 'check for Mountpoint for Amazon S3',
    command: 'sh',
    commandArgs: ['-lc', 'command -v mount-s3 >/dev/null 2>&1'],
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
  });
  if (check.status === 0) {
    await assertMountpointVersion(runCommand);
    return;
  }

  await runRequiredCommand({
    runCommand,
    label: 'install Mountpoint for Amazon S3',
    command: 'dnf',
    commandArgs: [
      'install',
      '-y',
      '--setopt=gpgcheck=1',
      'fuse',
      MOUNTPOINT_S3_PACKAGE,
    ],
    options: {
      sudo: true,
      timeoutMs: MOUNTPOINT_INSTALL_TIMEOUT_MS,
    },
    details: {
      package: 'mount-s3',
    },
  });
  await assertMountpointVersion(runCommand);
}

async function assertMountpointVersion(
  runCommand: VercelMountCommand,
): Promise<void> {
  const result = await runRequiredCommand({
    runCommand,
    label: 'verify the Mountpoint for Amazon S3 version',
    command: 'rpm',
    commandArgs: ['--query', '--queryformat', '%{VERSION}', 'mount-s3'],
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
  });
  const actualVersion = result.stdout?.trim();
  if (isSupportedMountpointVersion(actualVersion)) {
    return;
  }
  throw new SandboxMountError(
    'VercelSandboxClient found an unsupported Mountpoint for Amazon S3 version.',
    {
      provider: 'vercel',
      minimumVersion: MOUNTPOINT_S3_MINIMUM_VERSION.join('.'),
      supportedMajorVersion: MOUNTPOINT_S3_MINIMUM_VERSION[0],
      actualVersion: actualVersion ?? '',
    },
    'mount_failed',
  );
}

function isSupportedMountpointVersion(
  actualVersion: string | undefined,
): boolean {
  const match = actualVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    return false;
  }
  const version = match.slice(1).map(Number);
  const [minimumMajor, minimumMinor, minimumPatch] =
    MOUNTPOINT_S3_MINIMUM_VERSION;
  if (version[0] !== minimumMajor) {
    return false;
  }
  if (version[1] !== minimumMinor) {
    return version[1] > minimumMinor;
  }
  return version[2] >= minimumPatch;
}

function mountEnvironment(
  config: VercelS3MountConfig,
): Record<string, string> | undefined {
  const environment: Record<string, string> = {};
  if (config.accessKeyId && config.secretAccessKey) {
    environment.AWS_ACCESS_KEY_ID = config.accessKeyId;
    environment.AWS_SECRET_ACCESS_KEY = config.secretAccessKey;
  }
  if (config.sessionToken) {
    environment.AWS_SESSION_TOKEN = config.sessionToken;
  }
  if (config.region) {
    environment.AWS_REGION = config.region;
  }
  return Object.keys(environment).length > 0 ? environment : undefined;
}

function mountArguments(
  config: VercelS3MountConfig,
  mountPath: string,
  owner?: VercelMountOwner,
): string[] {
  const args = [config.mount.bucket, mountPath, '--allow-other'];
  if (config.mount.readOnly ?? true) {
    args.push('--read-only');
  } else {
    args.push('--allow-overwrite', '--allow-delete');
  }
  if (owner) {
    args.push('--uid', owner.uid, '--gid', owner.gid);
  }
  if (config.region) {
    args.push('--region', config.region);
  }
  if (config.endpointUrl) {
    args.push('--endpoint-url', config.endpointUrl);
  }
  if (config.prefix) {
    args.push('--prefix', config.prefix);
  }
  return args;
}

async function resolveMountOwner(
  runCommand: VercelMountCommand,
): Promise<VercelMountOwner> {
  return {
    uid: await readNumericIdentity(runCommand, '-u', 'user'),
    gid: await readNumericIdentity(runCommand, '-g', 'group'),
  };
}

async function readNumericIdentity(
  runCommand: VercelMountCommand,
  flag: '-u' | '-g',
  identity: 'user' | 'group',
): Promise<string> {
  const result = await runRequiredCommand({
    runCommand,
    label: `resolve the sandbox ${identity} ID`,
    command: 'id',
    commandArgs: [flag],
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
  });
  const value = result.stdout?.trim() ?? '';
  if (!/^\d+$/u.test(value)) {
    throw new SandboxMountError(
      `VercelSandboxClient received an invalid sandbox ${identity} ID.`,
      {
        provider: 'vercel',
        command: displayCommand('id', [flag]),
      },
      'mount_failed',
    );
  }
  return value;
}

async function assertEmptyMountDirectory(
  runCommand: VercelMountCommand,
  mountPath: string,
): Promise<void> {
  const commandArgs = [
    mountPath,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-print',
    '-quit',
  ];
  const result = await runRequiredCommand({
    runCommand,
    label: 'inspect the S3 mount directory',
    command: 'find',
    commandArgs,
    options: {
      timeoutMs: MOUNTPOINT_COMMAND_TIMEOUT_MS,
    },
    details: {
      mountPath,
    },
  });
  if (result.stdout === undefined) {
    throw new SandboxMountError(
      'VercelSandboxClient could not inspect the S3 mount directory.',
      {
        provider: 'vercel',
        command: displayCommand('find', commandArgs),
        mountPath,
      },
      'mount_failed',
    );
  }
  if (result.stdout.trim()) {
    throw new SandboxMountError(
      'VercelSandboxClient requires an empty S3 mount directory.',
      {
        provider: 'vercel',
        mountPath,
      },
      'mount_config_invalid',
    );
  }
}

async function runRequiredCommand(args: {
  runCommand: VercelMountCommand;
  label: string;
  command: string;
  commandArgs: string[];
  options?: VercelMountCommandOptions;
  details?: Record<string, unknown>;
}): Promise<VercelMountCommandResult> {
  const result = await invokeCommand(args);
  if (result.status !== 0) {
    throw commandFailure({
      ...args,
      result,
    });
  }
  return result;
}

async function invokeCommand(args: {
  runCommand: VercelMountCommand;
  label: string;
  command: string;
  commandArgs: string[];
  options?: VercelMountCommandOptions;
}): Promise<VercelMountCommandResult> {
  try {
    return await args.runCommand(args.command, args.commandArgs, args.options);
  } catch (error) {
    if (error instanceof SandboxMountError) {
      throw error;
    }
    const sensitiveValues = Object.values(args.options?.env ?? {});
    throw new SandboxMountError(
      `VercelSandboxClient failed to ${args.label}.`,
      {
        provider: 'vercel',
        command: displayCommand(args.command, args.commandArgs),
        cause: redactSensitiveValues(
          providerErrorMessage(error),
          sensitiveValues,
        ),
      },
      'mount_failed',
    );
  }
}

function commandFailure(args: {
  label: string;
  command: string;
  commandArgs: string[];
  result: VercelMountCommandResult;
  options?: VercelMountCommandOptions;
  details?: Record<string, unknown>;
}): SandboxMountError {
  const sensitiveValues = Object.values(args.options?.env ?? {});
  return new SandboxMountError(
    `VercelSandboxClient failed to ${args.label}.`,
    {
      provider: 'vercel',
      command: displayCommand(args.command, args.commandArgs),
      exitCode: args.result.status,
      stderr: redactSensitiveValues(args.result.stderr ?? '', sensitiveValues),
      ...args.details,
    },
    'mount_failed',
  );
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function redactSensitiveValues(
  text: string,
  sensitiveValues: string[],
): string {
  let redacted = text;
  for (const value of sensitiveValues) {
    if (value) {
      redacted = redacted.split(value).join('REDACTED');
    }
  }
  return redacted;
}
