import type {
  AzureBlobMount,
  BoxMount,
  Dir,
  DockerVolumeMountStrategy,
  File,
  GCSMount,
  GitRepo,
  InContainerMountStrategy,
  LocalBindMountStrategy,
  LocalDir,
  LocalFile,
  Mount,
  MountPattern,
  R2Mount,
  S3FilesMount,
  S3Mount,
} from './types';

export function dir(args: Omit<Dir, 'type'> = {}): Dir {
  return {
    type: 'dir',
    ...args,
  };
}

export function file(args: Omit<File, 'type'>): File {
  return {
    type: 'file',
    ...args,
  };
}

export function localFile(args: Omit<LocalFile, 'type'>): LocalFile {
  return {
    type: 'local_file',
    ...args,
  };
}

export function localDir(args: Omit<LocalDir, 'type'>): LocalDir {
  return {
    type: 'local_dir',
    ...args,
  };
}

export function gitRepo(args: Omit<GitRepo, 'type'>): GitRepo {
  return {
    type: 'git_repo',
    ...args,
  };
}

export function mount(args: Omit<Mount, 'type'> = {}): Mount {
  return {
    type: 'mount',
    ...args,
  };
}

export function s3Mount(args: Omit<S3Mount, 'type'>): S3Mount {
  return {
    type: 's3_mount',
    ...args,
  } as S3Mount;
}

export function gcsMount(args: Omit<GCSMount, 'type'>): GCSMount {
  return {
    type: 'gcs_mount',
    ...args,
  } as GCSMount;
}

export function r2Mount(args: Omit<R2Mount, 'type'>): R2Mount {
  return {
    type: 'r2_mount',
    ...args,
  } as R2Mount;
}

export function azureBlobMount(
  args: Omit<AzureBlobMount, 'type'>,
): AzureBlobMount {
  return {
    type: 'azure_blob_mount',
    ...args,
  } as AzureBlobMount;
}

export function boxMount(args: Omit<BoxMount, 'type'> = {}): BoxMount {
  return {
    type: 'box_mount',
    ...args,
  } as BoxMount;
}

export function s3FilesMount(args: Omit<S3FilesMount, 'type'>): S3FilesMount {
  return {
    type: 's3_files_mount',
    ...args,
  } as S3FilesMount;
}

export function inContainerMountStrategy(
  args: Omit<InContainerMountStrategy, 'type'> = {},
): InContainerMountStrategy {
  return {
    type: 'in_container',
    ...args,
  };
}

export function dockerVolumeMountStrategy(
  args: Omit<DockerVolumeMountStrategy, 'type'> = {},
): DockerVolumeMountStrategy {
  return {
    type: 'docker_volume',
    ...args,
  };
}

export function localBindMountStrategy(
  args: Omit<LocalBindMountStrategy, 'type'> = {},
): LocalBindMountStrategy {
  return {
    type: 'local_bind',
    ...args,
  };
}

export function mountPattern<T extends MountPattern>(args: T): T {
  return args;
}
