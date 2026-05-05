import {
  SandboxMountError,
  SandboxUnsupportedFeatureError,
  type AzureBlobMount,
  type BoxMount,
  type Entry,
  type GCSMount,
  type MountStrategy,
  type R2Mount,
  type RcloneMountPattern,
  type S3Mount,
} from '@openai/agents-core/sandbox';
import { shellQuote } from './paths';
import { readOptionalString } from './typeGuards';

export type RemoteMountCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

export type RemoteMountCommandOptions = {
  timeoutMs?: number;
  user?: string;
};

export type RemoteMountCommand = (
  command: string,
  options?: RemoteMountCommandOptions,
) => Promise<RemoteMountCommandResult>;

export type RemoteMountFileWriter = (
  path: string,
  content: string | Uint8Array,
) => Promise<void>;

export type RcloneCloudBucketMountOptions = {
  providerName: string;
  providerId: string;
  strategyType: string;
  entry: Entry;
  mountPath: string;
  pattern?: RcloneMountPattern;
  runCommand: RemoteMountCommand;
  writeFile: RemoteMountFileWriter;
  packageManagers?: Array<'apt' | 'apk'>;
  installRcloneViaScript?: boolean;
};

type RcloneBucketMount =
  | S3Mount
  | R2Mount
  | GCSMount
  | AzureBlobMount
  | BoxMount;

type RcloneMountConfig = {
  remoteName: string;
  remotePath: string;
  configText: string;
  readOnly: boolean;
  mountType: string;
};

const DEFAULT_PACKAGE_MANAGERS: Array<'apt' | 'apk'> = ['apt'];
const SAFE_PIDFILE_KILL_FUNCTION = String.raw`openai_agents_kill_pidfile() {
  pidfile=$1
  shift
  pid=$(cat "$pidfile" 2>/dev/null || true)
  case "$pid" in
    ''|0|*[!0-9]*) return 0 ;;
  esac
  cmdline=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [ -n "$cmdline" ] || return 0
  for expected in "$@"; do
    case "$cmdline" in
      *"$expected"*) ;;
      *) return 0 ;;
    esac
  done
  kill "$pid" >/dev/null 2>&1 || true
}`;

export function isRcloneCloudBucketMountEntry(
  entry: Entry,
  strategyType: string,
): entry is RcloneBucketMount {
  return (
    isRcloneBucketMount(entry) && entry.mountStrategy?.type === strategyType
  );
}

export function rclonePatternFromMountStrategy(
  strategy: MountStrategy | undefined,
): RcloneMountPattern | undefined {
  const pattern = (strategy as { pattern?: unknown } | undefined)?.pattern;
  if (isRcloneMountPattern(pattern)) {
    return pattern;
  }
  return undefined;
}

export async function mountRcloneCloudBucket(
  options: RcloneCloudBucketMountOptions,
): Promise<void> {
  if (!isRcloneCloudBucketMountEntry(options.entry, options.strategyType)) {
    throw new SandboxUnsupportedFeatureError(
      `${options.providerName} only supports ${options.strategyType} mount entries for in-container cloud bucket mounts.`,
      {
        provider: options.providerId,
        feature: 'entry.mountStrategy',
        mountType: options.entry.type,
        strategyType: mountStrategyType(options.entry),
      },
    );
  }

  const pattern = options.pattern ?? { type: 'rclone', mode: 'fuse' };
  if (pattern.type !== 'rclone') {
    throw new SandboxUnsupportedFeatureError(
      `${options.providerName} cloud bucket mounts require a rclone mount pattern.`,
      {
        provider: options.providerId,
        feature: 'entry.mountStrategy.pattern',
        mountType: options.entry.type,
        patternType: pattern.type,
      },
    );
  }
  const mode = pattern.mode ?? 'fuse';
  if (mode !== 'fuse' && mode !== 'nfs') {
    throw new SandboxUnsupportedFeatureError(
      `${options.providerName} cloud bucket mounts support rclone fuse and nfs modes only.`,
      {
        provider: options.providerId,
        feature: 'entry.mountStrategy.pattern.mode',
        mountType: options.entry.type,
        mode: pattern.mode,
      },
    );
  }
  const remoteName = resolveRcloneRemoteName(pattern, options);

  if (mode === 'fuse') {
    await ensureFuseSupport(options);
  }
  await ensureRclone(options);
  const config = await resolveRcloneMountConfig(options, pattern, remoteName);
  const configPath = `/tmp/openai-agents-${options.providerId}-${config.remoteName}.conf`;

  await runRequiredMountCommand(options, {
    label: 'prepare rclone config',
    command: [
      `mkdir -p -- ${shellQuote(options.mountPath)}`,
      `rm -f -- ${shellQuote(configPath)}`,
      `touch ${shellQuote(configPath)}`,
      `chmod 600 ${shellQuote(configPath)}`,
    ].join(' && '),
    timeoutMs: 30_000,
  });
  await options.writeFile(configPath, config.configText);
  await runRequiredMountCommand(options, {
    label: 'protect rclone config',
    command: `chmod 600 ${shellQuote(configPath)}`,
    timeoutMs: 30_000,
  });

  if (mode === 'nfs') {
    await mountRcloneNfs(options, pattern, config, configPath);
    return;
  }

  await mountRcloneFuse(options, pattern, config, configPath);
}

export async function unmountRcloneMount(args: {
  providerName: string;
  providerId: string;
  mountPath: string;
  runCommand: RemoteMountCommand;
}): Promise<void> {
  const pidPathGlob = `/tmp/openai-agents-${args.providerId}-*.nfs.pid`;
  const unmountCommand = [
    `fusermount3 -u ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
    `fusermount -u ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
    `umount ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
    `umount -l ${shellQuote(args.mountPath)} >/dev/null 2>&1`,
    'true',
  ].join(' || ');
  const command = [
    unmountCommand,
    safePidFileKillFunctionCommand(),
    `for pidfile in ${pidPathGlob}; do [ -e "$pidfile" ] || continue; ${safeKillPidFileCommand(
      {
        pidFile: '$pidfile',
        expectedCmdlineFragments: ['rclone', 'serve', 'nfs'],
      },
    )}; rm -f -- "$pidfile"; done`,
  ].join(' ; ');
  await args.runCommand(command, { timeoutMs: 30_000 });
}

export function safePidFileKillFunctionCommand(): string {
  return SAFE_PIDFILE_KILL_FUNCTION;
}

export function safeKillPidFileCommand(args: {
  pidFile: string;
  expectedCmdlineFragments: string[];
}): string {
  return [
    'openai_agents_kill_pidfile',
    args.pidFile,
    ...args.expectedCmdlineFragments.map(shellQuote),
  ].join(' ');
}

async function mountRcloneFuse(
  options: RcloneCloudBucketMountOptions,
  pattern: RcloneMountPattern,
  config: RcloneMountConfig,
  configPath: string,
): Promise<void> {
  const userIds = await defaultUserIds(options.runCommand);
  // rclone FUSE needs stable uid/gid options so files appear owned by the sandbox's
  // default user instead of root when the provider image supports id lookup.
  const mountArgs = [
    'rclone',
    'mount',
    `${config.remoteName}:${config.remotePath}`,
    options.mountPath,
    '--config',
    configPath,
    '--daemon',
    '--allow-other',
    ...(userIds ? ['--uid', userIds.uid, '--gid', userIds.gid] : []),
    ...(config.readOnly ? ['--read-only'] : []),
    ...rclonePatternArgs(pattern),
  ];

  try {
    // The config file can contain credentials, so delete it immediately after the
    // daemonized mount command has consumed it.
    await runRequiredMountCommand(options, {
      label: 'rclone mount',
      command: joinShellArgs(mountArgs),
      timeoutMs: 60_000,
    });
  } finally {
    await options
      .runCommand(`rm -f -- ${shellQuote(configPath)}`, {
        timeoutMs: 30_000,
      })
      .catch(() => {});
  }
}

async function mountRcloneNfs(
  options: RcloneCloudBucketMountOptions,
  pattern: RcloneMountPattern,
  config: RcloneMountConfig,
  configPath: string,
): Promise<void> {
  await runRequiredMountCommand(options, {
    label: 'check rclone nfs server support',
    command:
      '/usr/local/bin/rclone serve nfs --help >/dev/null 2>&1 || rclone serve nfs --help >/dev/null 2>&1',
    timeoutMs: 30_000,
  });

  const nfsAddr = rclonePatternString(pattern, 'nfsAddr') ?? '127.0.0.1:2049';
  const pidPath = `/tmp/openai-agents-${options.providerId}-${config.remoteName}.nfs.pid`;
  const logPath = `/tmp/openai-agents-${options.providerId}-${config.remoteName}.nfs.log`;
  const serverArgs = [
    'rclone',
    'serve',
    'nfs',
    `${config.remoteName}:${config.remotePath}`,
    '--addr',
    nfsAddr,
    '--config',
    configPath,
    ...(config.readOnly ? ['--read-only'] : []),
    ...rclonePatternArgs(pattern),
  ];
  await runRequiredMountCommand(options, {
    label: 'start rclone nfs server',
    command: `(${joinShellArgs(serverArgs)} > ${shellQuote(logPath)} 2>&1 & pid=$!; printf %s "$pid" > ${shellQuote(pidPath)}; (sleep 2; rm -f -- ${shellQuote(configPath)}) >/dev/null 2>&1 &)`,
    timeoutMs: 30_000,
  });

  try {
    // Keep parity with Python: attempt the mount even when /proc/filesystems does
    // not advertise NFS support because some sandbox images expose it late.
    await options.runCommand('grep -qw nfs /proc/filesystems', {
      timeoutMs: 30_000,
    });

    const timeoutCheck = await options.runCommand(
      'command -v timeout >/dev/null 2>&1',
      { timeoutMs: 30_000 },
    );
    const timeoutPrefix = timeoutCheck.status === 0 ? 'timeout 10s ' : '';
    const { host, port } = splitNfsAddr(nfsAddr);
    const mountOptions = rclonePatternStringArray(
      pattern,
      'nfsMountOptions',
    ) ?? ['vers=4.1', 'tcp', `port=${port}`, 'soft', 'timeo=50', 'retrans=1'];
    await runRequiredMountCommand(options, {
      label: 'mount rclone nfs client',
      command: [
        'for i in 1 2 3; do',
        `${timeoutPrefix}mount -v -t nfs -o ${shellQuote(mountOptions.join(','))} ${shellQuote(`${host}:/`)} ${shellQuote(options.mountPath)}`,
        '&& exit 0; sleep 1; done; exit 1',
      ].join(' '),
      timeoutMs: 60_000,
      user: 'root',
    });
  } catch (error) {
    await stopRcloneNfsServer(options, pidPath, configPath);
    throw error;
  }
}

function buildRcloneMountConfig(
  entry: RcloneBucketMount,
  options: { remoteName: string },
): RcloneMountConfig {
  switch (entry.type) {
    case 's3_mount':
      return {
        remoteName: options.remoteName,
        remotePath: joinRemotePath(entry.bucket, entry.prefix),
        configText: [
          `[${options.remoteName}]`,
          'type = s3',
          `provider = ${entry.s3Provider ?? 'AWS'}`,
          ...(entry.endpointUrl ? [`endpoint = ${entry.endpointUrl}`] : []),
          ...(entry.region ? [`region = ${entry.region}`] : []),
          ...s3CredentialLines(entry),
          '',
        ].join('\n'),
        readOnly: entry.readOnly ?? true,
        mountType: entry.type,
      };
    case 'r2_mount':
      validateCredentialPair({
        provider: 'R2',
        mountType: entry.type,
        accessKeyId: readOptionalString(entry, 'accessKeyId'),
        secretAccessKey: readOptionalString(entry, 'secretAccessKey'),
      });
      if (!entry.accountId) {
        throw new SandboxMountError(
          'R2 cloud bucket mounts require accountId.',
          {
            mountType: entry.type,
          },
        );
      }
      return {
        remoteName: options.remoteName,
        remotePath: joinRemotePath(entry.bucket, entry.prefix),
        configText: [
          `[${options.remoteName}]`,
          'type = s3',
          'provider = Cloudflare',
          `endpoint = ${
            readOptionalString(entry, 'customDomain') ??
            `https://${entry.accountId}.r2.cloudflarestorage.com`
          }`,
          'acl = private',
          ...r2CredentialLines(entry),
          '',
        ].join('\n'),
        readOnly: entry.readOnly ?? true,
        mountType: entry.type,
      };
    case 'gcs_mount':
      return buildGcsRcloneMountConfig(entry, options.remoteName);
    case 'azure_blob_mount':
      return buildAzureBlobRcloneMountConfig(entry, options.remoteName);
    case 'box_mount':
      return buildBoxRcloneMountConfig(entry, options.remoteName);
    default:
      throw new SandboxUnsupportedFeatureError(
        'Unsupported rclone cloud bucket mount type.',
        {
          mountType: (entry as Entry).type,
        },
      );
  }
}

async function resolveRcloneMountConfig(
  options: RcloneCloudBucketMountOptions,
  pattern: RcloneMountPattern,
  remoteName: string,
): Promise<RcloneMountConfig> {
  const config = buildRcloneMountConfig(options.entry as RcloneBucketMount, {
    remoteName,
  });
  const configFilePath = rclonePatternString(pattern, 'configFilePath');
  if (!configFilePath) {
    return config;
  }
  const result = await options.runCommand(
    `cat -- ${shellQuote(configFilePath)}`,
    {
      timeoutMs: 30_000,
    },
  );
  if (result.status !== 0) {
    throw new SandboxMountError(
      `${options.providerName} failed to read rclone config file.`,
      {
        provider: options.providerId,
        mountType: config.mountType,
        path: configFilePath,
        stderr: result.stderr,
      },
    );
  }
  return {
    ...config,
    configText: supplementRcloneConfigText(
      result.stdout ?? '',
      remoteName,
      config.configText,
      config.mountType,
      options,
    ),
  };
}

function supplementRcloneConfigText(
  configText: string,
  remoteName: string,
  requiredConfigText: string,
  mountType: string,
  options: RcloneCloudBucketMountOptions,
): string {
  const escapedRemote = remoteName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const sectionPattern = new RegExp(`^\\s*\\[${escapedRemote}\\]\\s*$`, 'mu');
  const match = sectionPattern.exec(configText);
  if (!match) {
    throw new SandboxMountError(
      `${options.providerName} rclone config file is missing the required remote section.`,
      {
        provider: options.providerId,
        mountType,
        remoteName,
      },
    );
  }
  const sectionStart = match.index;
  const sectionEnd = match.index + match[0].length;
  const nextSection = /^\s*\[.+\]\s*$/mu.exec(configText.slice(sectionEnd));
  const sectionBodyEnd = nextSection
    ? sectionEnd + nextSection.index
    : configText.length;
  const before = configText.slice(0, sectionStart);
  const sectionBody = configText.slice(sectionStart, sectionBodyEnd).trimEnd();
  const after = configText.slice(sectionBodyEnd);
  const requiredLines = requiredConfigText.trimEnd().split('\n').slice(1);
  const supplement =
    requiredLines.length > 0 ? `\n${requiredLines.join('\n')}` : '';
  return `${before}${sectionBody}${supplement}\n${after}`;
}

function buildGcsRcloneMountConfig(
  entry: GCSMount,
  remoteName: string,
): RcloneMountConfig {
  const accessId = readOptionalString(entry, 'accessId');
  const secretAccessKey = readOptionalString(entry, 'secretAccessKey');
  if (accessId && secretAccessKey) {
    return {
      remoteName,
      remotePath: joinRemotePath(entry.bucket, entry.prefix),
      configText: [
        `[${remoteName}]`,
        'type = s3',
        'provider = GCS',
        'env_auth = false',
        `access_key_id = ${accessId}`,
        `secret_access_key = ${secretAccessKey}`,
        `endpoint = ${entry.endpointUrl ?? 'https://storage.googleapis.com'}`,
        ...(entry.region ? [`region = ${entry.region}`] : []),
        '',
      ].join('\n'),
      readOnly: entry.readOnly ?? true,
      mountType: entry.type,
    };
  }

  return {
    remoteName,
    remotePath: joinRemotePath(entry.bucket, entry.prefix),
    configText: [
      `[${remoteName}]`,
      'type = google cloud storage',
      ...(entry.serviceAccountFile
        ? [`service_account_file = ${entry.serviceAccountFile}`]
        : []),
      ...(entry.serviceAccountCredentials
        ? [`service_account_credentials = ${entry.serviceAccountCredentials}`]
        : []),
      ...(entry.accessToken ? [`access_token = ${entry.accessToken}`] : []),
      entry.serviceAccountFile ||
      entry.serviceAccountCredentials ||
      entry.accessToken
        ? 'env_auth = false'
        : 'env_auth = true',
      '',
    ].join('\n'),
    readOnly: entry.readOnly ?? true,
    mountType: entry.type,
  };
}

function buildAzureBlobRcloneMountConfig(
  entry: AzureBlobMount,
  remoteName: string,
): RcloneMountConfig {
  const account = entry.account ?? entry.accountName;
  if (!account) {
    throw new SandboxMountError(
      'Azure Blob mounts require account or accountName.',
      {
        mountType: entry.type,
      },
    );
  }
  return {
    remoteName,
    remotePath: joinRemotePath(entry.container, entry.prefix),
    configText: [
      `[${remoteName}]`,
      'type = azureblob',
      `account = ${account}`,
      ...(azureBlobEndpoint(entry)
        ? [`endpoint = ${azureBlobEndpoint(entry)}`]
        : []),
      ...(entry.accountKey
        ? [`key = ${entry.accountKey}`]
        : [
            'use_msi = true',
            ...(entry.identityClientId
              ? [`msi_client_id = ${entry.identityClientId}`]
              : []),
          ]),
      '',
    ].join('\n'),
    readOnly: entry.readOnly ?? true,
    mountType: entry.type,
  };
}

function azureBlobEndpoint(entry: AzureBlobMount): string | undefined {
  return entry.endpointUrl ?? entry.endpoint;
}

function buildBoxRcloneMountConfig(
  entry: BoxMount,
  remoteName: string,
): RcloneMountConfig {
  return {
    remoteName,
    remotePath: normalizeBoxRemotePath(entry.path),
    configText: [
      `[${remoteName}]`,
      'type = box',
      ...boxCredentialLines(entry),
      ...(entry.boxSubType && entry.boxSubType !== 'user'
        ? [`box_sub_type = ${entry.boxSubType}`]
        : []),
      ...(entry.rootFolderId ? [`root_folder_id = ${entry.rootFolderId}`] : []),
      ...(entry.impersonate ? [`impersonate = ${entry.impersonate}`] : []),
      ...(entry.ownedBy ? [`owned_by = ${entry.ownedBy}`] : []),
      '',
    ].join('\n'),
    readOnly: entry.readOnly ?? true,
    mountType: entry.type,
  };
}

function s3CredentialLines(entry: S3Mount): string[] {
  const accessKeyId = readOptionalString(entry, 'accessKeyId');
  const secretAccessKey = readOptionalString(entry, 'secretAccessKey');
  if (!accessKeyId || !secretAccessKey) {
    return ['env_auth = true'];
  }
  return [
    'env_auth = false',
    `access_key_id = ${accessKeyId}`,
    `secret_access_key = ${secretAccessKey}`,
    ...(entry.sessionToken ? [`session_token = ${entry.sessionToken}`] : []),
  ];
}

function r2CredentialLines(entry: R2Mount): string[] {
  const accessKeyId = readOptionalString(entry, 'accessKeyId');
  const secretAccessKey = readOptionalString(entry, 'secretAccessKey');
  if (!accessKeyId || !secretAccessKey) {
    return ['env_auth = true'];
  }
  return [
    'env_auth = false',
    `access_key_id = ${accessKeyId}`,
    `secret_access_key = ${secretAccessKey}`,
  ];
}

function boxCredentialLines(entry: BoxMount): string[] {
  return [
    ...(entry.clientId ? [`client_id = ${entry.clientId}`] : []),
    ...(entry.clientSecret ? [`client_secret = ${entry.clientSecret}`] : []),
    ...(entry.boxConfigFile
      ? [`box_config_file = ${entry.boxConfigFile}`]
      : []),
    ...(entry.configCredentials
      ? [`config_credentials = ${entry.configCredentials}`]
      : []),
    ...(entry.accessToken ? [`access_token = ${entry.accessToken}`] : []),
    ...(entry.token ? [`token = ${entry.token}`] : []),
  ];
}

async function ensureFuseSupport(
  options: RcloneCloudBucketMountOptions,
): Promise<void> {
  await runRequiredMountCommand(options, {
    label: 'check /dev/fuse',
    command: 'test -c /dev/fuse',
    timeoutMs: 30_000,
  });
  await runRequiredMountCommand(options, {
    label: 'check fuse filesystem support',
    command: 'grep -qw fuse /proc/filesystems',
    timeoutMs: 30_000,
  });
  const fusermount = await options.runCommand(
    'command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1',
    { timeoutMs: 30_000 },
  );
  if (fusermount.status !== 0) {
    await installPackage(options, 'fuse3', 'fusermount');
    await runRequiredMountCommand(options, {
      label: 'check fusermount after install',
      command:
        'command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1',
      timeoutMs: 30_000,
    });
  }
  await runRequiredMountCommand(options, {
    label: 'enable FUSE allow_other',
    command:
      "chmod a+rw /dev/fuse && touch /etc/fuse.conf && (grep -qxF user_allow_other /etc/fuse.conf || printf '\\nuser_allow_other\\n' >> /etc/fuse.conf)",
    timeoutMs: 30_000,
    user: 'root',
  });
}

async function ensureRclone(
  options: RcloneCloudBucketMountOptions,
): Promise<void> {
  const check = await options.runCommand(
    'command -v rclone >/dev/null 2>&1 || test -x /usr/local/bin/rclone',
    { timeoutMs: 30_000 },
  );
  if (check.status === 0) {
    return;
  }

  if (options.installRcloneViaScript) {
    await installRcloneViaScript(options);
  } else {
    await installPackage(options, 'rclone', 'rclone');
  }

  await runRequiredMountCommand(options, {
    label: 'check rclone after install',
    command:
      'command -v rclone >/dev/null 2>&1 || test -x /usr/local/bin/rclone',
    timeoutMs: 30_000,
  });
}

async function installRcloneViaScript(
  options: RcloneCloudBucketMountOptions,
): Promise<void> {
  await runRequiredMountCommand(options, {
    label: 'check apt-get for rclone install',
    command: 'command -v apt-get >/dev/null 2>&1',
    timeoutMs: 30_000,
  });
  await runRequiredMountCommand(options, {
    label: 'install rclone prerequisites',
    command:
      'DEBIAN_FRONTEND=noninteractive DEBCONF_NOWARNINGS=yes apt-get -o Dpkg::Use-Pty=0 update -qq && DEBIAN_FRONTEND=noninteractive DEBCONF_NOWARNINGS=yes apt-get -o Dpkg::Use-Pty=0 install -y -qq curl unzip ca-certificates',
    timeoutMs: 300_000,
    user: 'root',
  });
  await runRequiredMountCommand(options, {
    label: 'install rclone',
    command: 'curl -fsSL https://rclone.org/install.sh | bash',
    timeoutMs: 300_000,
    user: 'root',
  });
}

async function installPackage(
  options: RcloneCloudBucketMountOptions,
  packageName: string,
  label: string,
): Promise<void> {
  const managers = options.packageManagers ?? DEFAULT_PACKAGE_MANAGERS;
  if (managers.includes('apt')) {
    const apt = await options.runCommand('command -v apt-get >/dev/null 2>&1', {
      timeoutMs: 30_000,
    });
    if (apt.status === 0) {
      await runRequiredMountCommand(options, {
        label: `install ${label}`,
        command: `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${shellQuote(packageName)}`,
        timeoutMs: 300_000,
        user: 'root',
      });
      return;
    }
  }

  if (managers.includes('apk')) {
    const apk = await options.runCommand('command -v apk >/dev/null 2>&1', {
      timeoutMs: 30_000,
    });
    if (apk.status === 0) {
      await runRequiredMountCommand(options, {
        label: `install ${label}`,
        command: `apk add --no-cache ${shellQuote(packageName)}`,
        timeoutMs: 300_000,
        user: 'root',
      });
      return;
    }
  }

  throw new SandboxMountError(
    `${options.providerName} cloud bucket mounts require ${label}, but no supported package manager is available.`,
    {
      provider: options.providerId,
      package: packageName,
    },
  );
}

async function defaultUserIds(
  runCommand: RemoteMountCommand,
): Promise<{ uid: string; gid: string } | undefined> {
  const result = await runCommand('id -u; id -g', { timeoutMs: 30_000 });
  if (result.status !== 0) {
    return undefined;
  }
  const [uid, gid] = (result.stdout ?? '').trim().split(/\r?\n/u);
  if (!uid || !gid || !/^\d+$/u.test(uid) || !/^\d+$/u.test(gid)) {
    return undefined;
  }
  return { uid, gid };
}

async function runRequiredMountCommand(
  options: RcloneCloudBucketMountOptions,
  command: {
    label: string;
    command: string;
    timeoutMs?: number;
    user?: string;
  },
): Promise<RemoteMountCommandResult> {
  const result = await options.runCommand(command.command, {
    timeoutMs: command.timeoutMs,
    user: command.user,
  });
  if (result.status !== 0) {
    throw new SandboxMountError(
      `${options.providerName} cloud bucket mount failed while trying to ${command.label}.`,
      {
        provider: options.providerId,
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      },
    );
  }
  return result;
}

function joinShellArgs(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

function joinRemotePath(base: string, prefix: string | undefined): string {
  const normalizedPrefix = prefix?.replace(/^\/+|\/+$/gu, '');
  return normalizedPrefix ? `${base}/${normalizedPrefix}` : base;
}

function resolveRcloneRemoteName(
  pattern: RcloneMountPattern,
  options: RcloneCloudBucketMountOptions,
): string {
  const remoteName =
    rclonePatternString(pattern, 'remoteName') ??
    rclonePatternString(pattern, 'remote');
  if (typeof remoteName !== 'undefined') {
    if (
      typeof remoteName !== 'string' ||
      !/^[A-Za-z0-9_-]+$/u.test(remoteName)
    ) {
      throw new SandboxMountError(
        `${options.providerName} cloud bucket mounts require remoteName to contain only letters, numbers, underscores, and hyphens.`,
        {
          provider: options.providerId,
          remoteName,
        },
      );
    }
    return remoteName;
  }

  return `sandbox_${sanitizeRemoteName(options.providerId)}_${sanitizeRemoteName(options.mountPath)}`;
}

async function stopRcloneNfsServer(
  options: RcloneCloudBucketMountOptions,
  pidPath: string,
  configPath: string,
): Promise<void> {
  await options
    .runCommand(
      [
        safePidFileKillFunctionCommand(),
        `if [ -f ${shellQuote(pidPath)} ]; then ${safeKillPidFileCommand({
          pidFile: shellQuote(pidPath),
          expectedCmdlineFragments: ['rclone', 'serve', 'nfs'],
        })}; fi`,
        `rm -f -- ${shellQuote(pidPath)} ${shellQuote(configPath)}`,
      ].join(' ; '),
      { timeoutMs: 30_000 },
    )
    .catch(() => {});
}

function splitNfsAddr(addr: string): { host: string; port: string } {
  if (addr === '::') {
    return { host: '127.0.0.1', port: '2049' };
  }
  const index = addr.lastIndexOf(':');
  const rawHost = index === -1 ? addr : addr.slice(0, index);
  const port = index === -1 ? '2049' : addr.slice(index + 1) || '2049';
  const host =
    rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  return { host: host || '127.0.0.1', port };
}

function rclonePatternString(
  pattern: RcloneMountPattern,
  key: string,
): string | undefined {
  const value = pattern[key];
  return typeof value === 'string' && value ? value : undefined;
}

function rclonePatternStringArray(
  pattern: RcloneMountPattern,
  key: string,
): string[] | undefined {
  const value = pattern[key];
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined;
}

function rclonePatternArgs(pattern: RcloneMountPattern): string[] {
  return [
    ...(rclonePatternStringArray(pattern, 'args') ?? []),
    ...(rclonePatternStringArray(pattern, 'extraArgs') ?? []),
  ];
}

function isRcloneBucketMount(entry: Entry): entry is RcloneBucketMount {
  return (
    entry.type === 's3_mount' ||
    entry.type === 'r2_mount' ||
    entry.type === 'gcs_mount' ||
    entry.type === 'azure_blob_mount' ||
    entry.type === 'box_mount'
  );
}

function isRcloneMountPattern(value: unknown): value is RcloneMountPattern {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'rclone'
  );
}

function validateCredentialPair(args: {
  provider: string;
  mountType: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): void {
  if (Boolean(args.accessKeyId) !== Boolean(args.secretAccessKey)) {
    throw new SandboxMountError(
      `${args.provider} cloud bucket mounts require both accessKeyId and secretAccessKey when either is provided.`,
      {
        mountType: args.mountType,
      },
    );
  }
}

function mountStrategyType(entry: Entry): unknown {
  return (entry as { mountStrategy?: { type?: unknown } }).mountStrategy?.type;
}

function sanitizeRemoteName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '');
  return safe || 'mount';
}

function normalizeBoxRemotePath(path: string | undefined): string {
  return path?.replace(/^\/+/gu, '') ?? '';
}
