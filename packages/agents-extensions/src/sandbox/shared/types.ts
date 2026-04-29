export type RemoteManifestWriter = {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
};

export type RemoteEditorIo = {
  mkdir?(path: string): Promise<void>;
  resolvePath?(
    path: string,
    options?: RemoteSandboxPathOptions,
  ): Promise<string>;
  pathExists?(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  deletePath(path: string): Promise<void>;
};

export type RemoteSandboxPathOptions = {
  forWrite?: boolean;
};

export type RemoteSandboxPathResolver = (
  path: string,
  options?: RemoteSandboxPathOptions,
) => Promise<string>;

export type SandboxManifestMetadataSupport = {
  users?: boolean;
  groups?: boolean;
  entryPermissions?: boolean;
  entryGroups?: boolean;
  extraPathGrants?: boolean;
  mounts?: boolean;
};
