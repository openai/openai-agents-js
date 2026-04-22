import {
  SandboxMountError,
  SandboxUnsupportedFeatureError,
  type Entry,
  type GCSMount,
  type Mount,
  type R2Mount,
  type S3Mount,
} from '@openai/agents-core/sandbox';
import { createHash } from 'node:crypto';
import {
  safeKillPidFileCommand,
  safePidFileKillFunctionCommand,
  type RemoteMountCommand,
  type RemoteMountCommandResult,
} from '../shared/inContainerMounts';
import { readOptionalString, shellQuote } from '../shared';

const GCSFUSE_VERSION = '3.4.4';
const GCSFUSE_AMD64_DEB_SHA256 =
  '406945ecc736e8cf0eee92a617fd4a038d138c9c31e48980b99862a5f1f55bb5';
const GCSFUSE_ARM64_DEB_SHA256 =
  '8587fe2ee274075d8ec5a363e32761bc523a72c531922a69dd35035a371fdf3a';

export type BlaxelBucketProvider = 's3' | 'r2' | 'gcs';

export type BlaxelCloudBucketMountConfig = {
  provider: BlaxelBucketProvider;
  bucket: string;
  mountPath: string;
  readOnly: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  endpointUrl?: string;
  prefix?: string;
  serviceAccountCredentials?: string;
  serviceAccountFile?: string;
  accessToken?: string;
};

export class BlaxelCloudBucketMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'blaxel_cloud_bucket';
}

export type BlaxelDriveMountConfig = {
  driveName: string;
  mountPath: string;
  drivePath: string;
  readOnly: boolean;
};

export type BlaxelDriveMountInit = {
  driveName: string;
  driveMountPath?: string;
  drivePath?: string;
  driveReadOnly?: boolean;
  source?: string;
  mountPath?: string;
  readOnly?: boolean;
  provider?: Mount['provider'];
  config?: Record<string, unknown>;
  description?: string;
  ephemeral?: boolean;
  group?: Mount['group'];
  permissions?: Mount['permissions'];
  mountStrategy?: BlaxelDriveMountStrategy | { type: 'blaxel_drive' };
};

export type BlaxelMountSecretWriter = (
  path: string,
  content: string,
) => Promise<void>;

export class BlaxelDriveMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'blaxel_drive';
}

export class BlaxelDriveMount implements Mount {
  readonly [key: string]: unknown;
  readonly type = 'mount';
  readonly driveName: string;
  readonly driveMountPath?: string;
  readonly drivePath: string;
  readonly driveReadOnly: boolean;
  readonly mountStrategy: BlaxelDriveMountStrategy | { type: 'blaxel_drive' };
  readonly source?: string;
  readonly mountPath?: string;
  readonly readOnly: boolean;
  readonly provider?: Mount['provider'];
  readonly config?: Record<string, unknown>;
  readonly description?: string;
  readonly ephemeral?: boolean;
  readonly group?: Mount['group'];
  readonly permissions?: Mount['permissions'];

  constructor(init: BlaxelDriveMountInit) {
    this.driveName = init.driveName;
    this.driveMountPath = init.driveMountPath;
    this.drivePath = init.drivePath ?? '/';
    this.driveReadOnly = init.driveReadOnly ?? init.readOnly ?? false;
    this.mountStrategy = init.mountStrategy ?? new BlaxelDriveMountStrategy();
    this.source = init.source;
    this.mountPath = init.mountPath ?? init.driveMountPath;
    this.readOnly = this.driveReadOnly;
    this.provider = init.provider;
    this.config = init.config;
    this.description = init.description;
    this.ephemeral = init.ephemeral;
    this.group = init.group;
    this.permissions = init.permissions;
  }
}

export type BlaxelDriveApi = {
  mount(
    driveName: string,
    mountPath: string,
    drivePath?: string,
    readOnly?: boolean,
  ): Promise<unknown>;
  unmount(mountPath: string): Promise<unknown>;
};

export function isBlaxelCloudBucketMountEntry(
  entry: Entry,
): entry is S3Mount | R2Mount | GCSMount {
  return (
    isBlaxelBucketMount(entry) &&
    entry.mountStrategy?.type === 'blaxel_cloud_bucket'
  );
}

export function isBlaxelDriveMountEntry(
  entry: Entry,
): entry is BlaxelDriveMount {
  const value = entry as {
    type?: string;
    mountStrategy?: { type?: unknown };
  };
  return (
    (value.type === 'mount' || value.type === 'blaxel_drive_mount') &&
    value.mountStrategy?.type === 'blaxel_drive'
  );
}

export async function mountBlaxelCloudBucket(args: {
  entry: Entry;
  mountPath: string;
  runCommand: RemoteMountCommand;
  writeSecretFile: BlaxelMountSecretWriter;
}): Promise<void> {
  if (!isBlaxelCloudBucketMountEntry(args.entry)) {
    throw new SandboxUnsupportedFeatureError(
      'BlaxelSandboxClient only supports BlaxelCloudBucketMountStrategy cloud bucket mount entries.',
      {
        provider: 'blaxel',
        feature: 'entry.mountStrategy',
        mountType: args.entry.type,
        strategyType: mountStrategyType(args.entry),
      },
    );
  }

  const config = buildBlaxelCloudBucketMountConfig(args.entry, args.mountPath);
  await materializeBlaxelCloudBucketSecrets(config, args.writeSecretFile);
  if (config.provider === 'gcs') {
    await runBlaxelMountScript(
      args.runCommand,
      buildGcsFuseMountScript(config),
    );
    return;
  }
  await runBlaxelMountScript(args.runCommand, buildS3FuseMountScript(config));
}

export async function unmountBlaxelFuseMount(args: {
  mountPath: string;
  runCommand: RemoteMountCommand;
}): Promise<void> {
  const tokenServerPrefix = `/tmp/gcs-access-token-${safeId(args.mountPath)}`;
  const tokenPidPath = `${tokenServerPrefix}.pid`;
  const tokenSocketPath = `${tokenServerPrefix}.sock`;
  const tokenServerPath = `${tokenServerPrefix}.py`;
  const tokenPayloadPath = `${tokenServerPrefix}.json`;
  const tokenServerCleanup = [
    safePidFileKillFunctionCommand(),
    `if [ -e ${shellQuote(tokenPidPath)} ]; then ${safeKillPidFileCommand({
      pidFile: shellQuote(tokenPidPath),
      expectedCmdlineFragments: [tokenServerPath, tokenSocketPath],
    })}; rm -f -- ${[
      tokenPidPath,
      tokenSocketPath,
      tokenServerPath,
      tokenPayloadPath,
    ]
      .map(shellQuote)
      .join(' ')}; fi`,
  ].join('; ');
  await args.runCommand(
    [
      `fusermount -u ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
      `fusermount3 -u ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
      `umount ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
      `umount -l ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
      'true',
    ].join(' || ') + ` ; ${tokenServerCleanup}`,
    { timeoutMs: 30_000 },
  );
}

export async function mountBlaxelDrive(args: {
  entry: Entry;
  mountPath: string;
  drives?: BlaxelDriveApi;
}): Promise<BlaxelDriveMountConfig> {
  if (!isBlaxelDriveMountEntry(args.entry)) {
    throw new SandboxUnsupportedFeatureError(
      'BlaxelDriveMountStrategy requires a BlaxelDriveMount entry.',
      {
        provider: 'blaxel',
        feature: 'entry.mountStrategy',
        mountType: args.entry.type,
        strategyType: mountStrategyType(args.entry),
      },
    );
  }
  if (!args.drives?.mount) {
    throw new SandboxMountError(
      'Blaxel drive mounts require the sandbox drives API.',
      {
        provider: 'blaxel',
        mountType: args.entry.type,
      },
    );
  }

  const config = buildBlaxelDriveMountConfig(args.entry, args.mountPath);
  await args.drives.mount(
    config.driveName,
    config.mountPath,
    config.drivePath,
    config.readOnly,
  );
  return config;
}

export async function unmountBlaxelDrive(args: {
  mountPath: string;
  drives?: BlaxelDriveApi;
}): Promise<void> {
  if (args.drives?.unmount) {
    await args.drives.unmount(args.mountPath).catch(() => {});
  }
}

export function buildBlaxelCloudBucketMountConfig(
  entry: S3Mount | R2Mount | GCSMount,
  mountPath: string,
): BlaxelCloudBucketMountConfig {
  if (entry.type === 's3_mount') {
    const accessKeyId = readOptionalString(entry, 'accessKeyId');
    const secretAccessKey = readOptionalString(entry, 'secretAccessKey');
    validateCredentialPair({
      accessKeyId,
      secretAccessKey,
      mountType: entry.type,
    });
    return {
      provider: 's3',
      bucket: entry.bucket,
      mountPath,
      readOnly: entry.readOnly ?? true,
      accessKeyId,
      secretAccessKey,
      sessionToken: readOptionalString(entry, 'sessionToken'),
      region: entry.region,
      endpointUrl: entry.endpointUrl,
      prefix: entry.prefix,
    };
  }

  if (entry.type === 'r2_mount') {
    validateCredentialPair({
      accessKeyId: readOptionalString(entry, 'accessKeyId'),
      secretAccessKey: readOptionalString(entry, 'secretAccessKey'),
      mountType: entry.type,
    });
    const customDomain = readOptionalString(entry, 'customDomain');
    if (!customDomain && !entry.accountId) {
      throw new SandboxMountError(
        'Blaxel R2 bucket mounts require accountId or customDomain.',
        {
          provider: 'blaxel',
          mountType: entry.type,
        },
      );
    }
    return {
      provider: 'r2',
      bucket: entry.bucket,
      mountPath,
      readOnly: entry.readOnly ?? true,
      accessKeyId: readOptionalString(entry, 'accessKeyId'),
      secretAccessKey: readOptionalString(entry, 'secretAccessKey'),
      endpointUrl:
        customDomain ?? `https://${entry.accountId}.r2.cloudflarestorage.com`,
      prefix: entry.prefix,
    };
  }

  const accessId = readOptionalString(entry, 'accessId');
  const secretAccessKey = readOptionalString(entry, 'secretAccessKey');
  validateCredentialPair({
    accessKeyId: accessId,
    secretAccessKey,
    mountType: entry.type,
  });
  if (accessId && secretAccessKey) {
    return {
      provider: 's3',
      bucket: entry.bucket,
      mountPath,
      readOnly: entry.readOnly ?? true,
      accessKeyId: accessId,
      secretAccessKey,
      region: entry.region,
      endpointUrl: entry.endpointUrl ?? 'https://storage.googleapis.com',
      prefix: entry.prefix,
    };
  }

  return {
    provider: 'gcs',
    bucket: entry.bucket,
    mountPath,
    readOnly: entry.readOnly ?? true,
    serviceAccountCredentials: readOptionalString(
      entry,
      'serviceAccountCredentials',
    ),
    serviceAccountFile: readOptionalString(entry, 'serviceAccountFile'),
    accessToken: readOptionalString(entry, 'accessToken'),
    prefix: entry.prefix,
  };
}

function buildBlaxelDriveMountConfig(
  entry: BlaxelDriveMount,
  mountPath: string,
): BlaxelDriveMountConfig {
  return {
    driveName: entry.driveName,
    mountPath,
    drivePath: entry.drivePath ?? '/',
    readOnly: entry.driveReadOnly ?? entry.readOnly ?? false,
  };
}

function buildS3FuseMountScript(config: BlaxelCloudBucketMountConfig): string {
  const credentialPath = `/tmp/s3fs-passwd-${safeId(config.mountPath)}`;
  const credentials =
    config.accessKeyId && config.secretAccessKey
      ? `${config.accessKeyId}:${config.secretAccessKey}${
          config.sessionToken ? `:${config.sessionToken}` : ''
        }`
      : undefined;
  const bucket = config.prefix
    ? `${config.bucket}:/${config.prefix.replace(/^\/+|\/+$/gu, '')}`
    : config.bucket;
  const options = [
    'allow_other',
    'nonempty',
    credentials ? `passwd_file=${credentialPath}` : 'public_bucket=1',
    ...(config.endpointUrl ? [`url=${config.endpointUrl}`] : []),
    ...(!config.endpointUrl && config.region
      ? [
          `url=https://s3.${config.region}.amazonaws.com`,
          `endpoint=${config.region}`,
        ]
      : []),
    ...(config.provider === 'r2' ? ['sigv4'] : []),
    ...(config.readOnly ? ['ro'] : []),
  ];

  const command = [
    ensureBlaxelToolCommand('s3fs'),
    `mkdir -p -- ${shellQuote(config.mountPath)}`,
    ...(credentials ? [`chmod 600 ${shellQuote(credentialPath)}`] : []),
    [
      's3fs',
      shellQuote(bucket),
      shellQuote(config.mountPath),
      '-o',
      shellQuote(options.join(',')),
    ].join(' '),
  ].join(' && ');
  if (!credentials) {
    return command;
  }
  return `${command}; status=$?; rm -f -- ${shellQuote(credentialPath)}; exit $status`;
}

function buildGcsFuseMountScript(config: BlaxelCloudBucketMountConfig): string {
  const keyPath = `/tmp/gcs-creds-${safeId(config.mountPath)}.json`;
  const tokenServerPath = `/tmp/gcs-access-token-${safeId(config.mountPath)}.py`;
  const tokenSocketPath = `/tmp/gcs-access-token-${safeId(config.mountPath)}.sock`;
  const tokenPidPath = `/tmp/gcs-access-token-${safeId(config.mountPath)}.pid`;
  const tokenPayloadPath = `/tmp/gcs-access-token-${safeId(config.mountPath)}.json`;
  const tokenUrl = `unix://${tokenSocketPath}`;
  const hasAuth = hasGcsAuth(config);
  const usesAccessToken = Boolean(
    config.accessToken &&
    !config.serviceAccountCredentials &&
    !config.serviceAccountFile,
  );
  const options = [
    ...(config.serviceAccountCredentials
      ? [`--key-file=${keyPath}`]
      : config.serviceAccountFile
        ? [`--key-file=${config.serviceAccountFile}`]
        : usesAccessToken
          ? [`--token-url=${tokenUrl}`]
          : ['--anonymous-access']),
    ...(config.readOnly ? ['-o', 'ro'] : []),
    ...(config.prefix
      ? [`--only-dir=${config.prefix.replace(/^\/+|\/+$/gu, '')}`]
      : []),
  ];
  const command = [
    ensureBlaxelToolCommand('gcsfuse'),
    `mkdir -p -- ${shellQuote(config.mountPath)}`,
    ...(config.serviceAccountCredentials
      ? [`chmod 600 ${shellQuote(keyPath)}`]
      : []),
    ...(usesAccessToken
      ? buildGcsAccessTokenServerCommands({
          serverPath: tokenServerPath,
          socketPath: tokenSocketPath,
          pidPath: tokenPidPath,
          payloadPath: tokenPayloadPath,
        })
      : []),
    [
      'gcsfuse',
      ...options.map(shellQuote),
      shellQuote(config.bucket),
      shellQuote(config.mountPath),
    ].join(' '),
  ].join(' && ');
  if (!hasAuth || (!config.serviceAccountCredentials && !usesAccessToken)) {
    return command;
  }
  const cleanupCommands = [
    ...(config.serviceAccountCredentials
      ? [`rm -f -- ${shellQuote(keyPath)}`]
      : []),
    ...(usesAccessToken
      ? [
          safePidFileKillFunctionCommand(),
          `if [ "$status" -ne 0 ]; then ${safeKillPidFileCommand({
            pidFile: shellQuote(tokenPidPath),
            expectedCmdlineFragments: [tokenServerPath, tokenSocketPath],
          })}; rm -f -- ${[tokenPidPath, tokenSocketPath, tokenServerPath, tokenPayloadPath].map(shellQuote).join(' ')}; fi`,
        ]
      : []),
  ];
  return `${command}; status=$?; ${cleanupCommands.join('; ')}; exit $status`;
}

function buildGcsAccessTokenServerCommands(args: {
  serverPath: string;
  socketPath: string;
  pidPath: string;
  payloadPath: string;
}): string[] {
  const serverScript = String.raw`import http.server
import os
import socketserver
import sys

socket_path = sys.argv[1]
token_payload_path = sys.argv[2]

with open(token_payload_path, "rb") as handle:
    token_payload = handle.read().rstrip(b"\n")

try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(token_payload)))
        self.end_headers()
        self.wfile.write(token_payload)

    def log_message(self, format, *args):
        pass

with socketserver.UnixStreamServer(socket_path, Handler) as server:
    os.chmod(socket_path, 0o600)
    server.serve_forever()
`;
  const serverSetupAndStart = [
    `{ cat > ${shellQuote(args.serverPath)} <<'OPENAI_AGENTS_GCS_TOKEN_SERVER'\n${serverScript}OPENAI_AGENTS_GCS_TOKEN_SERVER\n}`,
    `chmod 600 ${shellQuote(args.payloadPath)}`,
    `python3 ${shellQuote(args.serverPath)} ${shellQuote(args.socketPath)} ${shellQuote(args.payloadPath)} >/dev/null 2>&1 & printf %s "$!" > ${shellQuote(args.pidPath)}`,
  ].join(' && ');
  return [
    ensurePythonCommand(),
    serverSetupAndStart,
    `for i in 1 2 3 4 5 6 7 8 9 10; do [ -S ${shellQuote(args.socketPath)} ] && break; sleep 0.1; done`,
    `[ -S ${shellQuote(args.socketPath)} ]`,
    `rm -f -- ${shellQuote(args.payloadPath)}`,
  ];
}

async function materializeBlaxelCloudBucketSecrets(
  config: BlaxelCloudBucketMountConfig,
  writeSecretFile: BlaxelMountSecretWriter,
): Promise<void> {
  if (config.provider !== 'gcs') {
    if (config.accessKeyId && config.secretAccessKey) {
      await writeSecretFile(
        `/tmp/s3fs-passwd-${safeId(config.mountPath)}`,
        `${config.accessKeyId}:${config.secretAccessKey}${
          config.sessionToken ? `:${config.sessionToken}` : ''
        }`,
      );
    }
    return;
  }

  if (config.serviceAccountCredentials) {
    await writeSecretFile(
      `/tmp/gcs-creds-${safeId(config.mountPath)}.json`,
      config.serviceAccountCredentials,
    );
  }
  if (
    config.accessToken &&
    !config.serviceAccountCredentials &&
    !config.serviceAccountFile
  ) {
    await writeSecretFile(
      `/tmp/gcs-access-token-${safeId(config.mountPath)}.json`,
      JSON.stringify({
        access_token: config.accessToken,
        token_type: 'Bearer',
      }),
    );
  }
}

function ensurePythonCommand(): string {
  return [
    'command -v python3 >/dev/null 2>&1',
    'if command -v apk >/dev/null 2>&1; then apk add --no-cache python3; else apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3; fi',
  ].join(' || ');
}

function hasGcsAuth(config: BlaxelCloudBucketMountConfig): boolean {
  return Boolean(
    config.serviceAccountCredentials ||
    config.serviceAccountFile ||
    config.accessToken,
  );
}

function ensureBlaxelToolCommand(tool: 's3fs' | 'gcsfuse'): string {
  if (tool === 's3fs') {
    return [
      'command -v s3fs >/dev/null 2>&1',
      'if command -v apk >/dev/null 2>&1; then apk add --no-cache s3fs-fuse; else apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq s3fs; fi',
    ].join(' || ');
  }

  return [
    'command -v gcsfuse >/dev/null 2>&1',
    buildPinnedGcsFuseInstallCommand(),
  ].join(' || ');
}

function buildPinnedGcsFuseInstallCommand(): string {
  const debPath = '/tmp/gcsfuse.deb';
  const debUrlPrefix = `https://github.com/GoogleCloudPlatform/gcsfuse/releases/download/v${GCSFUSE_VERSION}/gcsfuse_${GCSFUSE_VERSION}_`;
  const selectArch = [
    'case "$(uname -m)" in',
    `x86_64|amd64) GCSFUSE_DEB_ARCH=amd64; GCSFUSE_DEB_SHA256=${shellQuote(GCSFUSE_AMD64_DEB_SHA256)} ;;`,
    `aarch64|arm64) GCSFUSE_DEB_ARCH=arm64; GCSFUSE_DEB_SHA256=${shellQuote(GCSFUSE_ARM64_DEB_SHA256)} ;;`,
    '*) printf "Unsupported gcsfuse architecture: %s\\n" "$(uname -m)" >&2; exit 1 ;;',
    'esac',
  ].join(' ');
  const setUrl = `GCSFUSE_DEB_URL=${shellQuote(debUrlPrefix)}$GCSFUSE_DEB_ARCH.deb`;
  const download = `curl -fsSL "$GCSFUSE_DEB_URL" -o ${shellQuote(debPath)}`;
  const verify = `printf '%s  %s\\n' "$GCSFUSE_DEB_SHA256" ${shellQuote(debPath)} | sha256sum -c -`;
  const cleanup =
    'rm -f /tmp/gcsfuse.deb /tmp/control.tar* /tmp/data.tar* /tmp/debian-binary';
  const alpineInstall = [
    selectArch,
    setUrl,
    'apk add --no-cache fuse curl binutils tar ca-certificates',
    download,
    verify,
    `cd /tmp && ar x ${shellQuote(debPath)} && tar -xf data.tar* -C /`,
    cleanup,
  ].join(' && ');
  const debianInstall = [
    selectArch,
    setUrl,
    'apt-get update -qq',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates',
    download,
    verify,
    `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${shellQuote(debPath)}`,
    cleanup,
  ].join(' && ');
  return `if command -v apk >/dev/null 2>&1; then ${alpineInstall}; else ${debianInstall}; fi`;
}

async function runBlaxelMountScript(
  runCommand: RemoteMountCommand,
  command: string,
): Promise<RemoteMountCommandResult> {
  const result = await runCommand(command, { timeoutMs: 300_000 });
  if (result.status !== 0) {
    throw new SandboxMountError('Blaxel cloud bucket mount failed.', {
      provider: 'blaxel',
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return result;
}

function isBlaxelBucketMount(
  entry: Entry,
): entry is S3Mount | R2Mount | GCSMount {
  return (
    entry.type === 's3_mount' ||
    entry.type === 'r2_mount' ||
    entry.type === 'gcs_mount'
  );
}

function validateCredentialPair(args: {
  accessKeyId?: string;
  secretAccessKey?: string;
  mountType: string;
}): void {
  if (Boolean(args.accessKeyId) !== Boolean(args.secretAccessKey)) {
    throw new SandboxMountError(
      'Blaxel cloud bucket mounts require both accessKeyId and secretAccessKey when either is provided.',
      {
        provider: 'blaxel',
        mountType: args.mountType,
      },
    );
  }
}

function mountStrategyType(entry: Entry): unknown {
  return (entry as { mountStrategy?: { type?: unknown } }).mountStrategy?.type;
}

function safeId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
