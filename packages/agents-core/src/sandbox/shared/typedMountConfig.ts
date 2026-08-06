import type { MountProvider, TypedMount } from '../entries';

export type TypedMountProviderConfig = {
  provider: MountProvider;
  config: Record<string, unknown>;
};

export function typedMountProviderConfig(
  entry: TypedMount,
): TypedMountProviderConfig {
  switch (entry.type) {
    case 's3_mount':
      return {
        provider: 's3',
        config: typedMountConfig(
          { bucket: entry.bucket },
          {
            prefix: entry.prefix,
            region: entry.region,
            endpointUrl: entry.endpointUrl,
            s3Provider: entry.s3Provider,
          },
        ),
      };
    case 'gcs_mount':
      return {
        provider: 'gcs',
        config: typedMountConfig(
          { bucket: entry.bucket },
          {
            prefix: entry.prefix,
            region: entry.region,
            endpointUrl: entry.endpointUrl,
          },
        ),
      };
    case 'r2_mount':
      return {
        provider: 'r2',
        config: typedMountConfig(
          { bucket: entry.bucket },
          {
            prefix: entry.prefix,
            accountId: entry.accountId,
            customDomain: entry.customDomain,
          },
        ),
      };
    case 'azure_blob_mount':
      return {
        provider: 'azure_blob',
        config: typedMountConfig(
          { container: entry.container },
          {
            prefix: entry.prefix,
            account: entry.account,
            accountName: entry.accountName,
            endpoint: entry.endpoint,
            endpointUrl: entry.endpointUrl,
          },
        ),
      };
    case 'box_mount':
      return {
        provider: 'box',
        config: typedMountConfig(
          {},
          {
            path: entry.path,
            boxSubType: entry.boxSubType,
            rootFolderId: entry.rootFolderId,
            impersonate: entry.impersonate,
            ownedBy: entry.ownedBy,
          },
        ),
      };
    case 's3_files_mount':
      return {
        provider: 's3_files',
        config: typedMountConfig(
          { fileSystemId: entry.fileSystemId },
          {
            subpath: entry.subpath,
            mountTargetIp: entry.mountTargetIp,
            accessPoint: entry.accessPoint,
            region: entry.region,
            extraOptions: entry.extraOptions,
          },
        ),
      };
  }
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
