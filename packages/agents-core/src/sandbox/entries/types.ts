import type { PermissionsInit, PermissionsValue } from '../permissions';
import type { SandboxEntryGroup } from '../users';

export type EntryBase = {
  description?: string;
  ephemeral?: boolean;
  group?: SandboxEntryGroup;
  permissions?: PermissionsInit | PermissionsValue;
};

export type Dir = EntryBase & {
  type: 'dir';
  children?: Record<string, Entry>;
};

export type File = EntryBase & {
  type: 'file';
  content: string | Uint8Array;
};

export type LocalFile = EntryBase & {
  type: 'local_file';
  src: string;
};

export type LocalDir = EntryBase & {
  type: 'local_dir';
  src: string;
};

export type GitRepo = EntryBase & {
  type: 'git_repo';
  host?: string;
  repo: string;
  ref?: string;
  subpath?: string;
};

export type MountPattern = {
  type: string;
  [key: string]: unknown;
};

export type RcloneMountPattern = MountPattern & {
  type: 'rclone';
  mode?: 'fuse' | 'nfs' | (string & {});
  remoteName?: string;
  extraArgs?: string[];
  configFilePath?: string;
  remote?: string;
  args?: string[];
  nfsAddr?: string;
  nfsMountOptions?: string[];
};

export type FuseMountPattern = MountPattern & {
  type: 'fuse';
  command?: string | string[];
  allowOther?: boolean;
  logType?: string;
  logLevel?: string;
  cacheType?: 'block_cache' | 'file_cache' | (string & {});
  cachePath?: string;
  cacheSizeMb?: number;
  blockCacheBlockSizeMb?: number;
  blockCacheDiskTimeoutSec?: number;
  fileCacheTimeoutSec?: number;
  fileCacheMaxSizeMb?: number;
  attrCacheTimeoutSec?: number;
  entryCacheTimeoutSec?: number;
  negativeEntryCacheTimeoutSec?: number;
};

export type MountpointMountPattern = MountPattern & {
  type: 'mountpoint';
  options?: {
    prefix?: string;
    region?: string;
    endpointUrl?: string;
  };
};

export type S3FilesMountPattern = MountPattern & {
  type: 's3files';
  options?: {
    mountTargetIp?: string;
    accessPoint?: string;
    region?: string;
    extraOptions?: Record<string, string | null>;
  };
};

export type InContainerMountStrategy = {
  type: 'in_container';
  pattern?: MountPattern;
};

export type DockerVolumeMountStrategy = {
  type: 'docker_volume';
  driver?: string;
  driverOptions?: Record<string, string>;
};

export type LocalBindMountStrategy = {
  type: 'local_bind';
};

export type MountStrategy =
  | InContainerMountStrategy
  | DockerVolumeMountStrategy
  | LocalBindMountStrategy
  | {
      type: string;
      [key: string]: unknown;
    };

export type MountProvider =
  | 's3'
  | 'gcs'
  | 'r2'
  | 'azure_blob'
  | 'box'
  | 's3_files'
  | (string & {});

export type MountBase = EntryBase & {
  source?: string;
  mountPath?: string;
  readOnly?: boolean;
  mountStrategy?: MountStrategy;
  provider?: MountProvider;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};

export type Mount = MountBase & {
  type: 'mount';
};

export type S3Mount = MountBase & {
  type: 's3_mount';
  bucket: string;
  prefix?: string;
  region?: string;
  endpointUrl?: string;
  s3Provider?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type GCSMount = MountBase & {
  type: 'gcs_mount';
  bucket: string;
  prefix?: string;
  region?: string;
  endpointUrl?: string;
  accessId?: string;
  secretAccessKey?: string;
  serviceAccountCredentials?: string;
  serviceAccountFile?: string;
  accessToken?: string;
};

export type R2Mount = MountBase & {
  type: 'r2_mount';
  bucket: string;
  prefix?: string;
  accountId: string;
  customDomain?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export type AzureBlobMount = MountBase & {
  type: 'azure_blob_mount';
  container: string;
  prefix?: string;
  account?: string;
  accountName?: string;
  endpoint?: string;
  endpointUrl?: string;
  identityClientId?: string;
  accountKey?: string;
};

export type BoxMount = MountBase & {
  type: 'box_mount';
  path?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  token?: string;
  boxConfigFile?: string;
  configCredentials?: string;
  boxSubType?: 'user' | 'enterprise';
  rootFolderId?: string;
  impersonate?: string;
  ownedBy?: string;
};

export type S3FilesMount = MountBase & {
  type: 's3_files_mount';
  fileSystemId: string;
  subpath?: string;
  mountTargetIp?: string;
  accessPoint?: string;
  region?: string;
  extraOptions?: Record<string, string | null>;
};

export type TypedMount =
  | S3Mount
  | GCSMount
  | R2Mount
  | AzureBlobMount
  | BoxMount
  | S3FilesMount;

export type Entry =
  | Dir
  | File
  | LocalFile
  | LocalDir
  | GitRepo
  | Mount
  | TypedMount;
