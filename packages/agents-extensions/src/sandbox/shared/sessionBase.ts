import { type ToolOutputImage } from '@openai/agents-core';
import {
  copyManifestMountCredentialExposurePolicy,
  assertExistingMountTopologyPreserved,
  captureLiveMountCredentialAuthority,
  manifestHasInContainerMounts,
  validateMountCredentialBoundaries,
  withExclusiveSandboxManifestMutation,
} from '@openai/agents-core/sandbox/internal';
import {
  cloneManifest,
  type Entry,
  type ExecCommandArgs,
  type ExposedPortEndpoint,
  Manifest,
  type MaterializeEntryArgs,
  type ReadFileArgs,
  type SandboxArchiveLimits,
  type SandboxConcurrencyLimits,
  SandboxProviderError,
  type SandboxSession,
  type SandboxSessionState,
  SandboxUnsupportedFeatureError,
  type ViewImageArgs,
  type WorkspaceArchiveData,
  type WorkspaceArchiveOptions,
  validateSandboxArchiveLimits,
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
import {
  mergeManifestEntryDelta,
  prepareManifestMounts,
  prepareMaterializedManifestTransition,
  type ManifestMaterializationOptions,
} from './manifest';
import {
  assertSandboxEntryMetadataSupported,
  assertSandboxManifestMetadataSupported,
  sandboxEntryPermissionsMode,
} from './metadata';
import { imageOutputFromBytes } from './media';
import { elapsedSeconds, formatExecResponse, truncateOutput } from './output';
import {
  resolveSandboxAbsolutePath,
  resolveRemoteSandboxEffectivePath,
  resolveSandboxRelativePath,
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
import {
  probeRemoteSandboxDirectoryExists,
  probeRemoteSandboxPathExists,
} from './pathProbe';
import { assertRunAsUnsupported } from './session';
import {
  assertRemoteSandboxSessionStateUsable,
  isRemoteSandboxSessionStateUnsafe,
  markRemoteSandboxSessionStateUnsafe,
} from './sessionState';
import type {
  RemoteManifestWriter,
  RemoteSandboxPathOptions,
  RemoteSandboxPathResolver,
  SandboxManifestMetadataSupport,
} from './types';

export type RemoteSandboxCommandKind =
  'archive' | 'exec' | 'manifest' | 'path' | 'running';

export type RemoteSandboxCommandOptions = {
  kind: RemoteSandboxCommandKind;
  workdir: string;
  environment?: Record<string, string>;
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
  concurrencyLimits?: SandboxConcurrencyLimits;
  archiveLimits?: SandboxArchiveLimits | null;
};

export abstract class RemoteSandboxSessionBase<
  TState extends SandboxSessionState & { environment: Record<string, string> },
> implements SandboxSession<TState> {
  readonly state: TState;
  protected readonly providerName: string;
  protected readonly providerId: string;
  private readonly concurrencyLimits?: SandboxConcurrencyLimits;
  private archiveLimits?: SandboxArchiveLimits | null;
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
    this.concurrencyLimits = args.options.concurrencyLimits;
    this.setArchiveLimits(args.options.archiveLimits);
  }

  setArchiveLimits(limits?: SandboxArchiveLimits | null): void {
    validateSandboxArchiveLimits(limits);
    this.archiveLimits = limits;
  }

  protected getArchiveLimits(): SandboxArchiveLimits | null | undefined {
    return this.archiveLimits;
  }

  createEditor(runAs?: string): RemoteSandboxEditor {
    this.assertSessionUsable();
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
    this.assertSessionUsable();
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
    this.assertSessionUsable();
    this.assertFilesystemRunAs(args.runAs);
    const absolutePath = await this.resolveRemotePath(args.path);
    const bytes = args.runAs
      ? await this.readRemoteFileAs(absolutePath, args.runAs)
      : await this.readRemoteFile(absolutePath);
    return imageOutputFromBytes(args.path, bytes);
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    this.assertSessionUsable();
    this.assertFilesystemRunAs(runAs);
    const absolutePath = await this.resolveRemotePath(path);
    return await probeRemoteSandboxPathExists({
      providerName: this.providerName,
      providerId: this.providerId,
      path: absolutePath,
      runCommand: async (command) =>
        await this.runRemoteCommand(command, {
          kind: 'path',
          workdir: this.state.manifest.root,
          runAs,
        }),
    });
  }

  async directoryExists(path: string, runAs?: string): Promise<boolean> {
    this.assertSessionUsable();
    this.assertFilesystemRunAs(runAs);
    const absolutePath = await this.resolveRemotePath(path);
    return await probeRemoteSandboxDirectoryExists({
      providerName: this.providerName,
      providerId: this.providerId,
      path: absolutePath,
      runCommand: async (command) =>
        await this.runRemoteCommand(command, {
          kind: 'path',
          workdir: this.state.manifest.root,
          runAs,
        }),
    });
  }

  async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    this.assertSessionUsable();
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
    if (!this.sessionUsable()) {
      return false;
    }
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
    this.assertSessionUsable();
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
    const entry = structuredClone(args.entry);
    return await withExclusiveSandboxManifestMutation(this.state, async () =>
      this.materializeEntryExclusive({ ...args, entry }),
    );
  }

  private async materializeEntryExclusive(
    args: MaterializeEntryArgs,
  ): Promise<void> {
    this.assertSessionUsable();
    this.assertManifestRunAs(args.runAs);
    const options = this.manifestMaterializationOptionsWithMetadata(args.runAs);
    const logicalPath = resolveSandboxRelativePath(
      this.state.manifest.root,
      args.path,
    );
    const nextManifest = mergeManifestEntryDelta(
      this.state.manifest,
      logicalPath,
      args.entry,
    );
    assertExistingMountTopologyPreserved(this.state.manifest, nextManifest);
    validateMountCredentialBoundaries(nextManifest);
    const mountEnvironment = {
      ...this.state.environment,
      ...options.mountEnvironmentOverrides,
    };
    options.validateManifest?.(nextManifest, mountEnvironment);
    assertSandboxEntryMetadataSupported(
      this.providerName,
      args.path,
      args.entry,
      this.manifestMetadataSupport(),
    );
    const privilegedTransition = manifestHasInContainerMounts(
      new Manifest({
        root: this.state.manifest.root,
        entries: {
          [resolveSandboxRelativePath(this.state.manifest.root, args.path)]:
            args.entry,
        },
      }),
    );
    const entryManifest = new Manifest({
      root: this.state.manifest.root,
      entries: { [logicalPath]: args.entry },
    });
    copyManifestMountCredentialExposurePolicy(entryManifest, nextManifest);
    const preparedMounts = await prepareManifestMounts(
      entryManifest,
      this.remotePathResolver,
      {
        credentialBoundaryManifest: nextManifest,
        environment: mountEnvironment,
        resolveCredentialPath: options.resolveCredentialPath,
      },
    );
    options.preparedMounts = preparedMounts;
    let providerEffectsMayHaveStarted =
      this.beforeMaterializeEntryMayHaveSideEffects();
    try {
      await this.beforeMaterializeEntry({
        ...args,
        entry: structuredClone(args.entry),
      });
      providerEffectsMayHaveStarted = true;
      await applyLocalSourceManifestEntryToState(
        this.state,
        args.path,
        args.entry,
        this.providerId,
        this.manifestWriter(),
        this.remotePathResolver,
        options,
      );
    } catch (error) {
      if (privilegedTransition && providerEffectsMayHaveStarted) {
        await this.invalidateAfterFailedPrivilegedManifestTransition();
      }
      throw error;
    }
    captureLiveMountCredentialAuthority(this.state.manifest);
    this.afterManifestMutationCommitted(
      new Manifest({
        root: this.state.manifest.root,
        entries: {
          [resolveSandboxRelativePath(this.state.manifest.root, args.path)]:
            args.entry,
        },
      }),
    );
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    const manifestSnapshot = cloneManifest(manifest);
    return await withExclusiveSandboxManifestMutation(this.state, async () =>
      this.applyManifestExclusive(manifestSnapshot, runAs),
    );
  }

  private async applyManifestExclusive(
    manifest: Manifest,
    runAs?: string,
  ): Promise<void> {
    this.assertSessionUsable();
    this.assertManifestRunAs(runAs);
    const resolvedManifest = cloneManifest(
      await this.resolveManifestForApply(manifest),
    );
    const options = this.manifestMaterializationOptionsWithMetadata(runAs);
    const preparedTransition = await prepareMaterializedManifestTransition(
      this.state,
      resolvedManifest,
      options,
      this.remotePathResolver,
    );
    assertSandboxManifestMetadataSupported(
      this.providerName,
      resolvedManifest,
      this.manifestMetadataSupport(),
    );
    const privilegedTransition = manifestHasInContainerMounts(resolvedManifest);
    let providerEffectsMayHaveStarted =
      this.beforeApplyManifestMayHaveSideEffects();
    try {
      await this.beforeApplyManifest(resolvedManifest);
      providerEffectsMayHaveStarted = true;
      await this.provisionManifestAccounts(resolvedManifest);
      await applyLocalSourceManifestToState(
        this.state,
        resolvedManifest,
        this.providerId,
        this.manifestWriter(),
        this.remotePathResolver,
        options,
        preparedTransition,
      );
    } catch (error) {
      if (privilegedTransition && providerEffectsMayHaveStarted) {
        await this.invalidateAfterFailedPrivilegedManifestTransition();
      }
      throw error;
    }
    captureLiveMountCredentialAuthority(this.state.manifest);
    this.afterManifestMutationCommitted(preparedTransition.deltaManifest);
  }

  async persistWorkspace(): Promise<Uint8Array> {
    this.assertSessionUsable();
    assertTarWorkspacePersistence(
      this.providerName,
      this.workspacePersistence(),
    );
    return await this.persistWorkspaceTar();
  }

  async hydrateWorkspace(
    data: WorkspaceArchiveData,
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    this.assertSessionUsable();
    assertTarWorkspacePersistence(
      this.providerName,
      this.workspacePersistence(),
    );
    await this.hydrateWorkspaceTar(data, options);
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

  protected afterManifestMutationCommitted(
    _materializedManifest: Manifest,
  ): void {}

  protected assertSessionUsable(): void {
    assertRemoteSandboxSessionStateUsable(this.state);
  }

  protected async execPtyCommand(_args: ExecCommandArgs): Promise<string> {
    throw new SandboxUnsupportedFeatureError(
      `${this.providerName} does not support tty=true yet.`,
      {
        provider: this.providerId,
        feature: 'tty',
      },
    );
  }

  private sessionUsable(): boolean {
    return !isRemoteSandboxSessionStateUnsafe(this.state);
  }

  protected async invalidateAfterFailedPrivilegedManifestTransition(): Promise<void> {
    markRemoteSandboxSessionStateUnsafe(this.state);
    await this.forceTerminateAfterFailedPrivilegedManifestTransition().catch(
      () => {},
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

  protected beforeMaterializeEntryMayHaveSideEffects(): boolean {
    return false;
  }

  protected async beforeApplyManifest(_manifest: Manifest): Promise<void> {}

  protected beforeApplyManifestMayHaveSideEffects(): boolean {
    return false;
  }

  protected async forceTerminateAfterFailedPrivilegedManifestTransition(): Promise<void> {
    const session = this as SandboxSession<TState>;
    if (session.delete) {
      await session.delete({
        reason: 'failed privileged manifest transition',
      });
      return;
    }
    await session.close?.();
  }

  protected resolveManifestForApply(
    manifest: Manifest,
  ): Manifest | Promise<Manifest> {
    return manifest;
  }

  protected manifestMetadataSupport():
    SandboxManifestMetadataSupport | undefined {
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
    this.assertSessionUsable();
    return await validateRemoteSandboxPathForManifest({
      manifest: this.state.manifest,
      path,
      options,
      runCommand: async (command) =>
        await this.runRemoteCommand(command, {
          kind: 'path',
          workdir: this.state.manifest.root,
          environment: {},
        }),
    });
  }

  protected async resolveRemoteCredentialPath(path: string): Promise<string> {
    this.assertSessionUsable();
    return await resolveRemoteSandboxEffectivePath({
      path,
      runCommand: async (command) =>
        await this.runRemoteCommand(command, {
          kind: 'path',
          workdir: this.state.manifest.root,
          environment: {},
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
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    await hydrateRemoteWorkspaceTar({
      providerName: this.providerName,
      manifest: this.state.manifest,
      io: this.archiveIo(),
      data,
      archiveLimits:
        options.archiveLimits === undefined
          ? this.archiveLimits
          : options.archiveLimits,
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
    const options = {
      ...this.manifestMaterializationOptions(),
      concurrencyLimits: this.concurrencyLimits,
      resolveCredentialPath: async (path: string) =>
        await this.resolveRemoteCredentialPath(path),
    };
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
