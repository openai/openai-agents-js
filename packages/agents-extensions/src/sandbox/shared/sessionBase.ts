import { type ToolOutputImage } from '@openai/agents-core';
import {
  type Entry,
  type ExecCommandArgs,
  type ExposedPortEndpoint,
  type Manifest,
  type MaterializeEntryArgs,
  type ReadFileArgs,
  SandboxProviderError,
  type SandboxSession,
  type SandboxSessionState,
  SandboxUnsupportedFeatureError,
  type ViewImageArgs,
  type WorkspaceArchiveData,
} from '@openai/agents-core/sandbox';
import { randomUUID } from 'node:crypto';
import {
  assertTarWorkspacePersistence,
  hydrateRemoteWorkspaceTar,
  persistRemoteWorkspaceTar,
  type RemoteWorkspaceTarIo,
} from './archive';
import { RemoteSandboxEditor } from './editor';
import {
  applyLocalSourceManifestEntryToState,
  applyLocalSourceManifestToState,
  materializeLocalSourceManifest,
} from './localSources';
import type { ManifestMaterializationOptions } from './manifest';
import {
  assertSandboxEntryMetadataSupported,
  assertSandboxManifestMetadataSupported,
  sandboxEntryPermissionsMode,
} from './metadata';
import { imageOutputFromBytes } from './media';
import { elapsedSeconds, formatExecResponse, truncateOutput } from './output';
import {
  resolveSandboxAbsolutePath,
  resolveSandboxWorkdir,
  shellQuote,
  validateRemoteSandboxPathForManifest,
} from './paths';
import {
  assertConfiguredExposedPort,
  getCachedExposedPortEndpoint,
  parseExposedPortEndpoint,
  recordResolvedExposedPortEndpoint,
} from './ports';
import { assertRunAsUnsupported } from './session';
import type {
  RemoteManifestWriter,
  RemoteSandboxPathOptions,
  RemoteSandboxPathResolver,
  SandboxManifestMetadataSupport,
} from './types';

export type RemoteSandboxCommandKind =
  | 'archive'
  | 'exec'
  | 'manifest'
  | 'path'
  | 'running';

export type RemoteSandboxCommandOptions = {
  kind: RemoteSandboxCommandKind;
  workdir: string;
  runAs?: string;
  execArgs?: ExecCommandArgs;
  timeoutMs?: number;
};

export type RemoteSandboxCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

export type RemoteSandboxSessionBaseOptions = {
  providerName: string;
  providerId: string;
};

export abstract class RemoteSandboxSessionBase<
  TState extends SandboxSessionState & { environment: Record<string, string> },
> implements SandboxSession<TState> {
  readonly state: TState;
  protected readonly providerName: string;
  protected readonly providerId: string;
  protected readonly remotePathResolver: RemoteSandboxPathResolver = async (
    path,
    options,
  ) => await this.resolveRemotePath(path, options);

  protected constructor(args: {
    state: TState;
    options: RemoteSandboxSessionBaseOptions;
  }) {
    this.state = args.state;
    this.providerName = args.options.providerName;
    this.providerId = args.options.providerId;
  }

  createEditor(runAs?: string): RemoteSandboxEditor {
    this.assertFilesystemRunAs(runAs);
    if (runAs) {
      return this.createRunAsEditor(runAs);
    }
    return new RemoteSandboxEditor({
      resolvePath: this.remotePathResolver,
      mkdir: async (path) => {
        await this.beforeFilesystemMutation();
        await this.mkdirRemote(path);
      },
      pathExists: async (path) => await this.pathExists(path),
      readText: async (path) => await this.readRemoteText(path),
      writeText: async (path, content) => {
        await this.beforeFilesystemMutation();
        await this.ensureParentDir(path);
        await this.writeRemoteFile(path, content);
      },
      deletePath: async (path) => {
        await this.beforeFilesystemMutation();
        await this.deleteRemotePath(path);
      },
    });
  }

  supportsPty(): boolean {
    return false;
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    if (args.tty) {
      return await this.execPtyCommand(args);
    }
    this.assertExecRunAs(args.runAs);
    await this.beforeExecCommand(args);

    const start = Date.now();
    const result = await this.runRemoteCommand(args.cmd, {
      kind: 'exec',
      workdir: this.resolveWorkdir(args.workdir),
      runAs: args.runAs,
      execArgs: args,
    });
    const output = truncateOutput(
      joinRemoteCommandOutput(result),
      args.maxOutputTokens,
    );

    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      exitCode: result.status,
      originalTokenCount: output.originalTokenCount,
    });
  }

  async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    this.assertFilesystemRunAs(args.runAs);
    const absolutePath = await this.resolveRemotePath(args.path);
    const bytes = args.runAs
      ? await this.readRemoteFileAs(absolutePath, args.runAs)
      : await this.readRemoteFile(absolutePath);
    return imageOutputFromBytes(args.path, bytes);
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    this.assertFilesystemRunAs(runAs);
    const absolutePath = await this.resolveRemotePath(path);
    const result = await this.runRemoteCommand(
      `test -e ${shellQuote(absolutePath)}`,
      {
        kind: 'path',
        workdir: this.state.manifest.root,
        runAs,
      },
    );
    return result.status === 0;
  }

  async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    this.assertFilesystemRunAs(args.runAs);
    const absolutePath = await this.resolveRemotePath(args.path);
    const bytes = args.runAs
      ? await this.readRemoteFileAs(absolutePath, args.runAs)
      : await this.readRemoteFile(absolutePath);
    if (typeof args.maxBytes === 'number' && bytes.byteLength > args.maxBytes) {
      return bytes.subarray(0, args.maxBytes);
    }
    return bytes;
  }

  async running(): Promise<boolean> {
    try {
      const result = await this.runRemoteCommand('true', {
        kind: 'running',
        workdir: this.runningWorkdir(),
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    const requestedPort = assertConfiguredExposedPort({
      providerName: this.providerName,
      port,
      configuredPorts: this.configuredExposedPorts(),
      allowOnDemand: this.allowOnDemandExposedPorts(),
    });
    const cached = getCachedExposedPortEndpoint(this.state, requestedPort);
    if (cached && this.useCachedExposedPortEndpoint(requestedPort)) {
      return cached;
    }

    const endpoint = await this.resolveRemoteExposedPort(requestedPort);
    return recordResolvedExposedPortEndpoint(
      this.state,
      requestedPort,
      typeof endpoint === 'string'
        ? parseExposedPortEndpoint(endpoint, {
            providerName: this.providerName,
            source: this.exposedPortSource(),
          })
        : endpoint,
    );
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    this.assertManifestRunAs(args.runAs);
    assertSandboxEntryMetadataSupported(
      this.providerName,
      args.path,
      args.entry,
      this.manifestMetadataSupport(),
    );
    await this.beforeMaterializeEntry(args);
    await applyLocalSourceManifestEntryToState(
      this.state,
      args.path,
      args.entry,
      this.providerId,
      this.manifestWriter(),
      this.remotePathResolver,
      this.manifestMaterializationOptionsWithMetadata(args.runAs),
    );
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    this.assertManifestRunAs(runAs);
    const resolvedManifest = await this.resolveManifestForApply(manifest);
    assertSandboxManifestMetadataSupported(
      this.providerName,
      resolvedManifest,
      this.manifestMetadataSupport(),
    );
    await this.beforeApplyManifest(resolvedManifest);
    await this.provisionManifestAccounts(resolvedManifest);
    await applyLocalSourceManifestToState(
      this.state,
      resolvedManifest,
      this.providerId,
      this.manifestWriter(),
      this.remotePathResolver,
      this.manifestMaterializationOptionsWithMetadata(runAs),
    );
  }

  async persistWorkspace(): Promise<Uint8Array> {
    assertTarWorkspacePersistence(
      this.providerName,
      this.workspacePersistence(),
    );
    return await this.persistWorkspaceTar();
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    assertTarWorkspacePersistence(
      this.providerName,
      this.workspacePersistence(),
    );
    await this.hydrateWorkspaceTar(data);
  }

  protected abstract runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult>;

  protected abstract mkdirRemote(path: string): Promise<void>;

  protected abstract readRemoteText(path: string): Promise<string>;

  protected abstract readRemoteFile(path: string): Promise<Uint8Array>;

  protected abstract writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void>;

  protected abstract deleteRemotePath(path: string): Promise<void>;

  protected async execPtyCommand(_args: ExecCommandArgs): Promise<string> {
    throw new SandboxUnsupportedFeatureError(
      `${this.providerName} does not support tty=true yet.`,
      {
        provider: this.providerId,
        feature: 'tty',
      },
    );
  }

  protected assertExecRunAs(runAs?: string): void {
    assertRunAsUnsupported(this.providerName, runAs);
  }

  protected assertFilesystemRunAs(runAs?: string): void {
    assertRunAsUnsupported(this.providerName, runAs);
  }

  protected assertManifestRunAs(runAs?: string): void {
    this.assertFilesystemRunAs(runAs);
  }

  protected async beforeExecCommand(_args: ExecCommandArgs): Promise<void> {}

  protected async beforeFilesystemMutation(): Promise<void> {}

  protected async beforeMaterializeEntry(
    _args: MaterializeEntryArgs,
  ): Promise<void> {}

  protected async beforeApplyManifest(_manifest: Manifest): Promise<void> {}

  protected resolveManifestForApply(
    manifest: Manifest,
  ): Manifest | Promise<Manifest> {
    return manifest;
  }

  protected manifestMetadataSupport():
    | SandboxManifestMetadataSupport
    | undefined {
    return undefined;
  }

  protected manifestMaterializationOptions(): ManifestMaterializationOptions {
    return {};
  }

  protected workspacePersistence(): unknown {
    return this.state.workspacePersistence;
  }

  protected configuredExposedPorts(): number[] | undefined {
    const configured = this.state.configuredExposedPorts;
    return Array.isArray(configured) ? configured : undefined;
  }

  protected allowOnDemandExposedPorts(): boolean {
    return false;
  }

  protected useCachedExposedPortEndpoint(_port: number): boolean {
    return true;
  }

  protected exposedPortSource(): string {
    return 'endpoint';
  }

  protected async resolveRemoteExposedPort(
    port: number,
  ): Promise<string | ExposedPortEndpoint> {
    throw new SandboxProviderError(
      `${this.providerName} exposed port resolution is not configured.`,
      {
        provider: this.providerId,
        port,
      },
    );
  }

  protected runningWorkdir(): string {
    return this.state.manifest.root;
  }

  protected resolveWorkdir(path?: string): string {
    return resolveSandboxWorkdir(this.state.manifest.root, path);
  }

  protected resolveAbsolutePath(path?: string): string {
    return resolveSandboxAbsolutePath(this.state.manifest.root, path);
  }

  protected async resolveRemotePath(
    path?: string,
    options: RemoteSandboxPathOptions = {},
  ): Promise<string> {
    return await validateRemoteSandboxPathForManifest({
      manifest: this.state.manifest,
      path,
      options,
      runCommand: async (command) =>
        await this.runRemoteCommand(command, {
          kind: 'path',
          workdir: this.state.manifest.root,
        }),
    });
  }

  protected async ensureParentDir(path: string): Promise<void> {
    const parent = this.parentDir(path);
    if (parent !== '/' && parent !== '.') {
      await this.mkdirRemote(parent);
    }
  }

  protected async persistWorkspaceTar(): Promise<Uint8Array> {
    return await persistRemoteWorkspaceTar({
      providerName: this.providerName,
      manifest: this.state.manifest,
      io: this.archiveIo(),
    });
  }

  protected async hydrateWorkspaceTar(
    data: WorkspaceArchiveData,
  ): Promise<void> {
    await hydrateRemoteWorkspaceTar({
      providerName: this.providerName,
      manifest: this.state.manifest,
      io: this.archiveIo(),
      data,
    });
  }

  protected manifestWriter(): RemoteManifestWriter {
    return {
      mkdir: async (path) => {
        await this.beforeFilesystemMutation();
        await this.mkdirRemote(path);
      },
      writeFile: async (path, content) => {
        await this.beforeFilesystemMutation();
        await this.ensureParentDir(path);
        await this.writeRemoteFile(path, content);
      },
    };
  }

  protected async materializeManifestEntries(
    manifest: Manifest,
  ): Promise<void> {
    await materializeLocalSourceManifest(
      this.manifestWriter(),
      manifest,
      this.providerId,
      this.remotePathResolver,
      this.manifestMaterializationOptionsWithMetadata(),
    );
  }

  protected archiveIo(): RemoteWorkspaceTarIo {
    return {
      runCommand: async (command) =>
        await this.runRemoteCommand(command, {
          kind: 'archive',
          workdir: this.state.manifest.root,
        }),
      readFile: async (path) => await this.readRemoteFile(path),
      writeFile: async (path, content) => {
        await this.beforeFilesystemMutation();
        await this.ensureParentDir(path);
        await this.writeRemoteFile(path, content);
      },
      mkdir: async (path) => {
        await this.beforeFilesystemMutation();
        await this.mkdirRemote(path);
      },
    };
  }

  private parentDir(path: string): string {
    const index = path.lastIndexOf('/');
    if (index <= 0) {
      return index === 0 ? '/' : '.';
    }
    return path.slice(0, index);
  }

  private createRunAsEditor(runAs: string): RemoteSandboxEditor {
    return new RemoteSandboxEditor({
      resolvePath: this.remotePathResolver,
      mkdir: async (path) => {
        await this.beforeFilesystemMutation();
        await this.runCheckedRemoteCommand(
          `mkdir -p -- ${shellQuote(path)}`,
          {
            kind: 'manifest',
            workdir: '/',
            runAs,
          },
          `create directory ${path}`,
        );
      },
      readText: async (path) =>
        await this.runCheckedRemoteCommand(
          `cat -- ${shellQuote(path)}`,
          {
            kind: 'path',
            workdir: '/',
            runAs,
          },
          `read file ${path}`,
        ),
      pathExists: async (path) => await this.pathExists(path, runAs),
      writeText: async (path, content) => {
        await this.beforeFilesystemMutation();
        await this.writeRemoteTextAs(path, content, runAs);
      },
      deletePath: async (path) => {
        await this.beforeFilesystemMutation();
        await this.runCheckedRemoteCommand(
          `rm -f -- ${shellQuote(path)}`,
          {
            kind: 'manifest',
            workdir: '/',
            runAs,
          },
          `delete path ${path}`,
        );
      },
    });
  }

  private async readRemoteFileAs(
    path: string,
    runAs: string,
  ): Promise<Uint8Array> {
    const output = await this.runCheckedRemoteCommand(
      `base64 -- ${shellQuote(path)}`,
      {
        kind: 'path',
        workdir: '/',
        runAs,
      },
      `read file ${path}`,
    );
    return Buffer.from(output.replace(/\s+/gu, ''), 'base64');
  }

  private async writeRemoteTextAs(
    path: string,
    content: string,
    runAs: string,
  ): Promise<void> {
    const tempPath = `/tmp/openai-agents-${randomUUID()}`;
    try {
      await this.writeRemoteFile(tempPath, content);
      await this.runCheckedRemoteCommand(
        [
          `chmod 0644 -- ${shellQuote(tempPath)}`,
          `chown ${shellQuote(runAs)}:${shellQuote(runAs)} -- ${shellQuote(tempPath)}`,
        ].join(' && '),
        {
          kind: 'manifest',
          workdir: '/',
        },
        `prepare temporary file ${tempPath}`,
      );
      await this.runCheckedRemoteCommand(
        `cat -- ${shellQuote(tempPath)} > ${shellQuote(path)}`,
        {
          kind: 'manifest',
          workdir: '/',
          runAs,
        },
        `write file ${path}`,
      );
    } finally {
      await this.runRemoteCommand(`rm -f -- ${shellQuote(tempPath)}`, {
        kind: 'manifest',
        workdir: '/',
      }).catch(() => {});
    }
  }

  private manifestMaterializationOptionsWithMetadata(
    runAs?: string,
  ): ManifestMaterializationOptions {
    const options = this.manifestMaterializationOptions();
    const support = this.manifestMetadataSupport();
    if (!support?.entryGroups && !support?.entryPermissions && !runAs) {
      return options;
    }
    return {
      ...options,
      applyMetadata: async (absolutePath, entry) => {
        await options.applyMetadata?.(absolutePath, entry);
        await this.applyManifestEntryMetadata(absolutePath, entry, runAs);
      },
    };
  }

  private async provisionManifestAccounts(manifest: Manifest): Promise<void> {
    const support = this.manifestMetadataSupport();
    if (!support?.users && !support?.groups) {
      return;
    }

    const users = new Set(manifest.users.map((user) => user.name));
    for (const group of manifest.groups) {
      if (support.groups) {
        await this.runCheckedRemoteCommand(
          `getent group ${shellQuote(group.name)} >/dev/null 2>&1 || groupadd ${shellQuote(group.name)}`,
          {
            kind: 'manifest',
            workdir: '/',
          },
          `create group ${group.name}`,
        );
      }
      for (const user of group.users ?? []) {
        users.add(user.name);
      }
    }

    if (support.users) {
      for (const user of users) {
        const quotedUser = shellQuote(user);
        await this.runCheckedRemoteCommand(
          [
            `if id -u ${quotedUser} >/dev/null 2>&1; then exit 0; fi`,
            `if getent group ${quotedUser} >/dev/null 2>&1; then useradd -M -s /usr/sbin/nologin -g ${quotedUser} ${quotedUser}; else useradd -U -M -s /usr/sbin/nologin ${quotedUser}; fi`,
          ].join('; '),
          {
            kind: 'manifest',
            workdir: '/',
          },
          `create user ${user}`,
        );
      }
    }

    if (support.groups) {
      for (const group of manifest.groups) {
        for (const user of group.users ?? []) {
          await this.runCheckedRemoteCommand(
            `usermod -aG ${shellQuote(group.name)} ${shellQuote(user.name)}`,
            {
              kind: 'manifest',
              workdir: '/',
            },
            `add user ${user.name} to group ${group.name}`,
          );
        }
      }
    }
  }

  private async applyManifestEntryMetadata(
    absolutePath: string,
    entry: Entry,
    runAs?: string,
  ): Promise<void> {
    const support = this.manifestMetadataSupport();
    const commands: string[] = [];
    if (runAs) {
      commands.push(
        `chown ${shellQuote(runAs)}:${shellQuote(runAs)} -- ${shellQuote(absolutePath)}`,
      );
    }
    if (support?.entryGroups && entry.group) {
      commands.push(
        `chgrp ${shellQuote(entry.group.name)} -- ${shellQuote(absolutePath)}`,
      );
    }
    if (support?.entryPermissions) {
      commands.push(
        `chmod ${sandboxEntryPermissionsMode(entry)} -- ${shellQuote(absolutePath)}`,
      );
    }
    if (commands.length === 0) {
      return;
    }
    await this.runCheckedRemoteCommand(
      commands.join(' && '),
      {
        kind: 'manifest',
        workdir: '/',
      },
      `apply metadata to ${absolutePath}`,
    );
  }

  private async runCheckedRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
    action: string,
  ): Promise<string> {
    const result = await this.runRemoteCommand(command, options);
    if (result.status !== 0) {
      const output = joinRemoteCommandOutput(result);
      throw new SandboxProviderError(
        `${this.providerName} failed to ${action}${output ? `: ${output}` : ''}`,
        {
          provider: this.providerId,
        },
      );
    }
    return result.stdout ?? '';
  }
}

function joinRemoteCommandOutput(result: RemoteSandboxCommandResult): string {
  return [result.stdout ?? '', result.stderr ?? '']
    .filter((value) => value.trim().length > 0)
    .join('\n');
}
