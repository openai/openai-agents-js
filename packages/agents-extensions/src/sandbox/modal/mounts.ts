import {
  SandboxMountError,
  SandboxUnsupportedFeatureError,
  type Entry,
  type GCSMount,
  type R2Mount,
  type S3Mount,
  type TypedMount,
} from '@openai/agents-core/sandbox';
import { readOptionalString } from '../shared';

export type ModalCloudBucketMountCredentials = Record<string, string>;

export type ModalCloudBucketMountConfig = {
  bucketName: string;
  bucketEndpointUrl?: string;
  keyPrefix?: string;
  credentials?: ModalCloudBucketMountCredentials;
  secretName?: string;
  secretEnvironmentName?: string;
  readOnly: boolean;
};

export type ModalCloudBucketMountStrategyOptions = {
  secretName?: string;
  secretEnvironmentName?: string;
};

export class ModalCloudBucketMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'modal_cloud_bucket';
  readonly secretName?: string;
  readonly secretEnvironmentName?: string;

  constructor(options: ModalCloudBucketMountStrategyOptions = {}) {
    this.secretName = options.secretName;
    this.secretEnvironmentName = options.secretEnvironmentName;
  }
}

export function buildModalCloudBucketMountConfig(
  mount: Entry,
  options: ModalCloudBucketMountStrategyOptions = {},
): ModalCloudBucketMountConfig {
  validateSecretOptions(mount, options);

  if (isS3Mount(mount)) {
    const accessKeyId = readOptionalString(mount, 'accessKeyId');
    const secretAccessKey = readOptionalString(mount, 'secretAccessKey');
    const sessionToken = readOptionalString(mount, 'sessionToken');
    validateCredentialPair({
      accessKeyId,
      secretAccessKey,
      mountType: mount.type,
    });
    validateSessionTokenCredentials({
      accessKeyId,
      secretAccessKey,
      sessionToken,
      mountType: mount.type,
    });
    const credentials = compactCredentials({
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_SESSION_TOKEN: sessionToken,
    });
    assertNoInlineCredentialsWithSecret(mount, credentials, options.secretName);
    return {
      bucketName: mount.bucket,
      bucketEndpointUrl: mount.endpointUrl,
      keyPrefix: mount.prefix,
      credentials,
      secretName: options.secretName,
      secretEnvironmentName: options.secretEnvironmentName,
      readOnly: mount.readOnly ?? true,
    };
  }

  if (isR2Mount(mount)) {
    const accessKeyId = readOptionalString(mount, 'accessKeyId');
    const secretAccessKey = readOptionalString(mount, 'secretAccessKey');
    validateCredentialPair({
      accessKeyId,
      secretAccessKey,
      mountType: mount.type,
    });
    const credentials = compactCredentials({
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
    });
    assertNoInlineCredentialsWithSecret(mount, credentials, options.secretName);
    const customDomain = readOptionalString(mount, 'customDomain');
    if (!customDomain && !mount.accountId) {
      throw new SandboxMountError(
        'Modal R2 bucket mounts require accountId or customDomain.',
        {
          provider: 'modal',
          mountType: mount.type,
        },
      );
    }
    return {
      bucketName: mount.bucket,
      bucketEndpointUrl:
        customDomain ?? `https://${mount.accountId}.r2.cloudflarestorage.com`,
      keyPrefix: mount.prefix,
      credentials,
      secretName: options.secretName,
      secretEnvironmentName: options.secretEnvironmentName,
      readOnly: mount.readOnly ?? true,
    };
  }

  if (isGCSMount(mount)) {
    const accessId = readOptionalString(mount, 'accessId');
    const secretAccessKey = readOptionalString(mount, 'secretAccessKey');
    const endpointUrl = readOptionalString(mount, 'endpointUrl');
    if ((!accessId || !secretAccessKey) && !options.secretName) {
      throw new SandboxMountError(
        'Modal GCS bucket mounts require accessId and secretAccessKey unless secretName is provided.',
        {
          provider: 'modal',
          mountType: mount.type,
        },
      );
    }
    const credentials =
      accessId && secretAccessKey
        ? {
            GOOGLE_ACCESS_KEY_ID: accessId,
            GOOGLE_ACCESS_KEY_SECRET: secretAccessKey,
          }
        : undefined;
    assertNoInlineCredentialsWithSecret(mount, credentials, options.secretName);
    return {
      bucketName: mount.bucket,
      bucketEndpointUrl: endpointUrl ?? 'https://storage.googleapis.com',
      keyPrefix: mount.prefix,
      credentials,
      secretName: options.secretName,
      secretEnvironmentName: options.secretEnvironmentName,
      readOnly: mount.readOnly ?? true,
    };
  }

  throw new SandboxUnsupportedFeatureError(
    'Modal cloud bucket mounts are not supported for this mount type.',
    {
      provider: 'modal',
      feature: 'entry.mount',
      mountType: String((mount as { type?: unknown }).type ?? 'unknown'),
    },
  );
}

export function isModalCloudBucketMountEntry(
  entry: Entry,
): entry is TypedMount {
  return (
    isTypedBucketMount(entry) &&
    entry.mountStrategy?.type === 'modal_cloud_bucket'
  );
}

function validateSecretOptions(
  mount: Entry,
  options: ModalCloudBucketMountStrategyOptions,
): void {
  if (options.secretName !== undefined && options.secretName.trim() === '') {
    throw new SandboxMountError(
      'Modal cloud bucket secretName must be a non-empty string.',
      {
        provider: 'modal',
        mountType: mount.type,
      },
    );
  }
  if (
    options.secretEnvironmentName !== undefined &&
    options.secretEnvironmentName.trim() === ''
  ) {
    throw new SandboxMountError(
      'Modal cloud bucket secretEnvironmentName must be a non-empty string.',
      {
        provider: 'modal',
        mountType: mount.type,
      },
    );
  }
  if (options.secretEnvironmentName !== undefined && !options.secretName) {
    throw new SandboxMountError(
      'Modal cloud bucket secretEnvironmentName requires secretName.',
      {
        provider: 'modal',
        mountType: mount.type,
      },
    );
  }
}

function assertNoInlineCredentialsWithSecret(
  mount: Entry,
  credentials: ModalCloudBucketMountCredentials | undefined,
  secretName: string | undefined,
): void {
  if (secretName && credentials && Object.keys(credentials).length > 0) {
    throw new SandboxMountError(
      'Modal cloud bucket mounts do not support both inline credentials and secretName.',
      {
        provider: 'modal',
        mountType: mount.type,
      },
    );
  }
}

function compactCredentials(
  credentials: Record<string, string | undefined>,
): ModalCloudBucketMountCredentials | undefined {
  const compact = Object.fromEntries(
    Object.entries(credentials).filter(([, value]) => value !== undefined),
  ) as ModalCloudBucketMountCredentials;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function validateCredentialPair(args: {
  accessKeyId?: string;
  secretAccessKey?: string;
  mountType: string;
}): void {
  if (Boolean(args.accessKeyId) !== Boolean(args.secretAccessKey)) {
    throw new SandboxMountError(
      'Modal cloud bucket mounts require both accessKeyId and secretAccessKey when either is provided.',
      {
        provider: 'modal',
        mountType: args.mountType,
      },
    );
  }
}

function validateSessionTokenCredentials(args: {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  mountType: string;
}): void {
  if (args.sessionToken && (!args.accessKeyId || !args.secretAccessKey)) {
    throw new SandboxMountError(
      'Modal S3 bucket mounts require accessKeyId and secretAccessKey when sessionToken is provided.',
      {
        provider: 'modal',
        mountType: args.mountType,
      },
    );
  }
}

function isTypedBucketMount(
  entry: Entry,
): entry is S3Mount | R2Mount | GCSMount {
  return (
    entry.type === 's3_mount' ||
    entry.type === 'r2_mount' ||
    entry.type === 'gcs_mount'
  );
}

function isS3Mount(entry: Entry): entry is S3Mount {
  return entry.type === 's3_mount';
}

function isR2Mount(entry: Entry): entry is R2Mount {
  return entry.type === 'r2_mount';
}

function isGCSMount(entry: Entry): entry is GCSMount {
  return entry.type === 'gcs_mount';
}
