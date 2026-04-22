import {
  SandboxMountError,
  SandboxUnsupportedFeatureError,
  type Entry,
  type GCSMount,
  type R2Mount,
  type S3Mount,
  type TypedMount,
} from '@openai/agents-core/sandbox';
import { readOptionalString } from '../shared/typeGuards';

export type CloudflareBucketProvider = 'r2' | 's3' | 'gcs';

export type CloudflareBucketMountCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type CloudflareBucketMountConfig = {
  bucketName: string;
  bucketEndpointUrl: string;
  provider: CloudflareBucketProvider;
  keyPrefix?: string;
  credentials?: CloudflareBucketMountCredentials;
  readOnly: boolean;
};

export type CloudflareBucketMountRequestOptions = {
  endpoint: string;
  provider: CloudflareBucketProvider;
  readOnly: boolean;
  prefix?: string;
  credentials?: CloudflareBucketMountCredentials;
};

export class CloudflareBucketMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'cloudflare_bucket_mount';
}

export function buildCloudflareBucketMountConfig(
  mount: Entry,
): CloudflareBucketMountConfig {
  if (isS3Mount(mount)) {
    const accessKeyId = readOptionalString(mount, 'accessKeyId');
    const secretAccessKey = readOptionalString(mount, 'secretAccessKey');
    const sessionToken = readOptionalString(mount, 'sessionToken');
    validateCredentialPair({
      accessKeyId,
      secretAccessKey,
      mountType: mount.type,
    });
    if (sessionToken) {
      throw new SandboxUnsupportedFeatureError(
        'Cloudflare bucket mounts do not support S3 sessionToken credentials.',
        {
          provider: 'cloudflare',
          feature: 's3.sessionToken',
          mountType: mount.type,
        },
      );
    }
    return {
      bucketName: mount.bucket,
      bucketEndpointUrl:
        mount.endpointUrl ??
        (mount.region
          ? `https://s3.${mount.region}.amazonaws.com`
          : 'https://s3.amazonaws.com'),
      provider: 's3',
      keyPrefix: normalizePrefix(mount.prefix),
      credentials: buildCredentials({
        accessKeyId,
        secretAccessKey,
        mountType: mount.type,
      }),
      readOnly: mount.readOnly ?? true,
    };
  }

  if (isR2Mount(mount)) {
    const accessKeyId = readOptionalString(mount, 'accessKeyId');
    const secretAccessKey = readOptionalString(mount, 'secretAccessKey');
    const customDomain = readOptionalString(mount, 'customDomain');
    validateCredentialPair({
      accessKeyId,
      secretAccessKey,
      mountType: mount.type,
    });
    if (!customDomain && !mount.accountId) {
      throw new SandboxMountError(
        'Cloudflare R2 bucket mounts require accountId or customDomain.',
        {
          provider: 'cloudflare',
          mountType: mount.type,
        },
      );
    }
    return {
      bucketName: mount.bucket,
      bucketEndpointUrl:
        customDomain ?? `https://${mount.accountId}.r2.cloudflarestorage.com`,
      provider: 'r2',
      keyPrefix: normalizePrefix(mount.prefix),
      credentials: buildCredentials({
        accessKeyId,
        secretAccessKey,
        mountType: mount.type,
      }),
      readOnly: mount.readOnly ?? true,
    };
  }

  if (isGCSMount(mount)) {
    const accessId = readOptionalString(mount, 'accessId');
    const secretAccessKey = readOptionalString(mount, 'secretAccessKey');
    const endpointUrl = readOptionalString(mount, 'endpointUrl');
    if (!accessId || !secretAccessKey) {
      throw new SandboxMountError(
        'Cloudflare GCS bucket mounts require accessId and secretAccessKey.',
        {
          provider: 'cloudflare',
          mountType: mount.type,
        },
      );
    }
    return {
      bucketName: mount.bucket,
      bucketEndpointUrl: endpointUrl ?? 'https://storage.googleapis.com',
      provider: 'gcs',
      keyPrefix: normalizePrefix(mount.prefix),
      credentials: {
        accessKeyId: accessId,
        secretAccessKey,
      },
      readOnly: mount.readOnly ?? true,
    };
  }

  throw new SandboxUnsupportedFeatureError(
    'Cloudflare bucket mounts are not supported for this mount type.',
    {
      provider: 'cloudflare',
      feature: 'entry.mount',
      mountType: String((mount as { type?: unknown }).type ?? 'unknown'),
    },
  );
}

export function cloudflareBucketMountRequestOptions(
  config: CloudflareBucketMountConfig,
): CloudflareBucketMountRequestOptions {
  return {
    endpoint: config.bucketEndpointUrl,
    provider: config.provider,
    readOnly: config.readOnly,
    ...(config.keyPrefix ? { prefix: config.keyPrefix } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  };
}

export function isCloudflareBucketMountEntry(
  entry: Entry,
): entry is TypedMount {
  return (
    isTypedBucketMount(entry) &&
    entry.mountStrategy?.type === 'cloudflare_bucket_mount'
  );
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

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) {
    return undefined;
  }
  const trimmed = prefix.replace(/^\/+|\/+$/gu, '');
  return trimmed ? `/${trimmed}/` : '/';
}

function buildCredentials(args: {
  accessKeyId?: string;
  secretAccessKey?: string;
  mountType: string;
}): CloudflareBucketMountCredentials | undefined {
  validateCredentialPair(args);
  if (!args.accessKeyId || !args.secretAccessKey) {
    return undefined;
  }
  return {
    accessKeyId: args.accessKeyId,
    secretAccessKey: args.secretAccessKey,
  };
}

function validateCredentialPair(args: {
  accessKeyId?: string;
  secretAccessKey?: string;
  mountType: string;
}): void {
  if (Boolean(args.accessKeyId) !== Boolean(args.secretAccessKey)) {
    throw new SandboxMountError(
      'Cloudflare bucket mounts require both accessKeyId and secretAccessKey when either is provided.',
      {
        provider: 'cloudflare',
        mountType: args.mountType,
      },
    );
  }
}
