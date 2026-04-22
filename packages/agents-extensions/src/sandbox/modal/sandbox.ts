import { UserError, type ToolOutputImage } from '@openai/agents-core';
import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type ExposedPortEndpoint,
  type ExecCommandArgs,
  type Entry,
  isMount,
  type MaterializeEntryArgs,
  type Mount,
  normalizePosixPath,
  relativePosixPathWithinRoot,
  type SandboxSession,
  type SandboxSessionState,
  type TypedMount,
  type ViewImageArgs,
  type WriteStdinArgs,
  type WorkspaceArchiveData,
} from '@openai/agents-core/sandbox';
import { posix as pathPosix } from 'node:path';
import {
  assertCoreConcurrencyLimitsUnsupported,
  assertCoreSnapshotUnsupported,
  imageOutputFromBytes,
  RemoteSandboxEditor,
  assertTarWorkspacePersistence,
  assertSandboxEntryMetadataSupported,
  assertSandboxManifestMetadataSupported,
  MOUNT_MANIFEST_METADATA_SUPPORT,
  assertRunAsUnsupported,
  closeRemoteSessionOnManifestError,
  decodeNativeSnapshotRef,
  deserializeRemoteSandboxSessionStateValues,
  elapsedSeconds,
  encodeNativeSnapshotRef,
  formatExecResponse,
  hydrateRemoteWorkspaceTar,
  materializeEnvironment,
  persistRemoteWorkspaceTar,
  assertConfiguredExposedPort,
  getCachedExposedPortEndpoint,
  recordResolvedExposedPortEndpoint,
  resolveSandboxAbsolutePath,
  resolveSandboxRelativePath,
  resolveSandboxWorkdir,
  cloneManifestWithoutMountEntries,
  serializeRemoteSandboxSessionState,
  truncateOutput,
  validateRemoteSandboxPathForManifest,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalString,
  readString,
  withProviderError,
  withSandboxSpan,
  type RemoteManifestWriter,
  type RemoteSandboxPathOptions,
  type RemoteSandboxPathResolver,
} from '../shared';
import {
  applyLocalSourceManifestEntryToState,
  applyLocalSourceManifestToState,
} from '../shared/localSources';
import {
  buildModalCloudBucketMountConfig,
  isModalCloudBucketMountEntry,
  type ModalCloudBucketMountConfig,
} from './mounts';

const DEFAULT_MODAL_IMAGE_TAG = 'debian:bookworm-slim';
const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const MAX_ACTIVE_PROCESS_OUTPUT_CHARS = 1024 * 1024;
const COMPLETED_ACTIVE_PROCESS_RETENTION_MS = 60_000;

type ModalModule = {
  ModalClient: new (params?: Record<string, unknown>) => ModalClientLike;
  CloudBucketMount?: new (
    bucketName: string,
    params?: Record<string, unknown>,
  ) => ModalCloudBucketMountLike;
  Secret?: {
    fromName(
      name: string,
      params?: { environment?: string },
    ): ModalSecretLike | Promise<ModalSecretLike>;
    fromObject(
      entries: Record<string, string>,
      params?: Record<string, unknown>,
    ): ModalSecretLike | Promise<ModalSecretLike>;
  };
};

type ModalCloudBucketMountLike = {
  toProto?(mountPath: string): unknown;
};

type ModalSecretLike = unknown;

type ModalClientLike = {
  apps: {
    fromName(
      name: string,
      params?: { createIfMissing?: boolean; environment?: string },
    ): Promise<ModalAppLike>;
  };
  images: {
    fromRegistry(tag: string): ModalImageLike;
    fromId?(id: string): ModalImageLike | Promise<ModalImageLike>;
    delete?(id: string): Promise<void>;
  };
  sandboxes: {
    create(
      app: ModalAppLike,
      image: ModalImageLike,
      params?: Record<string, unknown>,
    ): Promise<ModalSandboxLike>;
    fromId(id: string): Promise<ModalSandboxLike>;
  };
  imageBuilderVersion?(version?: string): string;
};

type ModalAppLike = {
  appId?: string;
};

type ModalImageLike = {
  imageId?: string;
  objectId?: string;
  cmd?(command: string[]): ModalImageLike;
};

type ModalSandboxLike = {
  sandboxId: string;
  objectId?: string;
  exec(
    command: string[],
    params?: Record<string, unknown>,
  ): Promise<ModalContainerProcessLike>;
  open(path: string, mode?: string): Promise<ModalSandboxFileLike>;
  terminate(params?: { wait?: boolean }): Promise<void | number>;
  poll(): Promise<number | null>;
  tunnels?(timeoutMs?: number): Promise<Record<number, ModalTunnelLike>>;
  snapshotFilesystem?(
    timeoutMs?: number,
  ): Promise<string | { objectId?: string; imageId?: string; id?: string }>;
  snapshotDirectory?(
    path: string,
  ): Promise<string | { objectId?: string; imageId?: string; id?: string }>;
  mountImage?(path: string, image?: ModalImageLike): Promise<unknown>;
};

type ModalTunnelLike = {
  host?: string;
  port?: number;
};

type ModalSandboxFileLike = {
  read(): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  flush?(): Promise<void>;
  close(): Promise<void>;
};

type ModalContainerProcessLike = {
  stdin?: {
    writeText?(text: string): Promise<void>;
    close?(): Promise<void>;
  };
  stdout: ReadableStream<string>;
  stderr: ReadableStream<string>;
  wait(): Promise<number>;
};

type ActiveModalProcess = {
  process: ModalContainerProcessLike;
  stdout: string;
  stderr: string;
  droppedStdoutChars: number;
  droppedStderrChars: number;
  done: boolean;
  exitCode: number | null;
  donePromise: Promise<void>;
  stopOutputPumps?: () => Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

type ModalCloudBucketMountsProvider = () => Promise<
  Record<string, ModalCloudBucketMountLike> | undefined
>;

export type ModalWorkspacePersistence =
  | 'tar'
  | 'snapshot_filesystem'
  | 'snapshot_directory';

export type ModalImageSelectorKind = 'image' | 'id' | 'tag';

export class ModalImageSelector {
  readonly kind: ModalImageSelectorKind;
  readonly value: ModalImageLike | string;

  private constructor(
    kind: ModalImageSelectorKind,
    value: ModalImageLike | string,
  ) {
    this.kind = kind;
    this.value = value;
  }

  static fromImage(image: ModalImageLike): ModalImageSelector {
    return new ModalImageSelector('image', image);
  }

  static fromId(imageId: string): ModalImageSelector {
    return new ModalImageSelector('id', imageId);
  }

  static fromTag(imageTag: string): ModalImageSelector {
    return new ModalImageSelector('tag', imageTag);
  }
}

export type ModalSandboxSelectorKind = 'sandbox' | 'id';

export class ModalSandboxSelector {
  readonly kind: ModalSandboxSelectorKind;
  readonly value: ModalSandboxLike | string;

  private constructor(
    kind: ModalSandboxSelectorKind,
    value: ModalSandboxLike | string,
  ) {
    this.kind = kind;
    this.value = value;
  }

  static fromSandbox(sandbox: ModalSandboxLike): ModalSandboxSelector {
    return new ModalSandboxSelector('sandbox', sandbox);
  }

  static fromId(sandboxId: string): ModalSandboxSelector {
    return new ModalSandboxSelector('id', sandboxId);
  }
}

export interface ModalSandboxClientOptions extends SandboxClientOptions {
  appName: string;
  image?: ModalImageSelector;
  sandbox?: ModalSandboxSelector;
  imageTag?: string;
  sandboxCreateTimeoutS?: number;
  workspacePersistence?: ModalWorkspacePersistence;
  snapshotFilesystemTimeoutMs?: number;
  snapshotFilesystemRestoreTimeoutMs?: number;
  env?: Record<string, string>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  gpu?: string;
  exposedPorts?: number[];
  environment?: string;
  endpoint?: string;
  tokenId?: string;
  tokenSecret?: string;
  imageBuilderVersion?: string;
  nativeCloudBucketSecretName?: string;
  useSleepCmd?: boolean;
}

export interface ModalSandboxSessionState extends SandboxSessionState {
  sandboxId?: string;
  ownsSandbox?: boolean;
  appName: string;
  imageId?: string;
  imageTag: string;
  sandboxCreateTimeoutS?: number;
  workspacePersistence: ModalWorkspacePersistence;
  snapshotFilesystemTimeoutMs?: number;
  snapshotFilesystemRestoreTimeoutMs?: number;
  environment: Record<string, string>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  gpu?: string;
  configuredExposedPorts?: number[];
  modalEnvironment?: string;
  endpoint?: string;
  imageBuilderVersion?: string;
  nativeCloudBucketSecretName?: string;
  useSleepCmd: boolean;
}

export class ModalSandboxSession implements SandboxSession<ModalSandboxSessionState> {
  readonly state: ModalSandboxSessionState;
  private readonly modal: ModalClientLike;
  private readonly app: ModalAppLike;
  private readonly cloudBucketMountsProvider?: ModalCloudBucketMountsProvider;
  private cloudBucketMounts?: Record<string, ModalCloudBucketMountLike>;
  private cloudBucketMountsResolved = false;
  private sandbox: ModalSandboxLike;
  private ownsSandbox: boolean;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly activeProcesses = new Map<number, ActiveModalProcess>();
  private readonly remotePathResolver: RemoteSandboxPathResolver = async (
    path,
    options,
  ) => await this.resolveRemotePath(path, options);
  private nextProcessId = 1;

  constructor(args: {
    state: ModalSandboxSessionState;
    modal: ModalClientLike;
    app: ModalAppLike;
    sandbox: ModalSandboxLike;
    ownsSandbox?: boolean;
    cloudBucketMounts?: Record<string, ModalCloudBucketMountLike>;
    cloudBucketMountsProvider?: ModalCloudBucketMountsProvider;
  }) {
    this.state = args.state;
    this.modal = args.modal;
    this.app = args.app;
    this.sandbox = args.sandbox;
    this.ownsSandbox = args.ownsSandbox ?? args.state.ownsSandbox ?? true;
    this.state.ownsSandbox = this.ownsSandbox;
    this.cloudBucketMounts = args.cloudBucketMounts;
    this.cloudBucketMountsProvider = args.cloudBucketMountsProvider;
    this.cloudBucketMountsResolved =
      args.cloudBucketMounts !== undefined || !args.cloudBucketMountsProvider;
  }

  createEditor(runAs?: string): RemoteSandboxEditor {
    assertRunAsUnsupported('ModalSandboxClient', runAs);
    return new RemoteSandboxEditor({
      resolvePath: this.remotePathResolver,
      pathExists: async (path) => await this.pathExists(path),
      readText: async (path) =>
        new TextDecoder().decode(await this.readSandboxFile(path)),
      writeText: async (path, content) => {
        await this.writeSandboxFile(path, content);
      },
      deletePath: async (path) => {
        await this.removeSandboxPath(path);
      },
    });
  }

  supportsPty(): boolean {
    return true;
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    assertRunAsUnsupported('ModalSandboxClient', args.runAs);
    const start = Date.now();
    const command = buildShellCommand(args);
    const process = await this.sandbox.exec(command, {
      mode: 'text',
      workdir: this.resolveWorkdir(args.workdir),
      env: this.state.environment,
      pty: args.tty ?? false,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const activeProcess = createActiveProcess(process);
    await waitForProcessOrTimeout(
      activeProcess,
      args.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS,
    );

    if (activeProcess.done) {
      const output = truncateOutput(
        consumeCommandOutput(activeProcess),
        args.maxOutputTokens,
      );
      return formatExecResponse({
        output: output.text,
        wallTimeSeconds: elapsedSeconds(start),
        exitCode: activeProcess.exitCode ?? 1,
        originalTokenCount: output.originalTokenCount,
      });
    }

    const sessionId = this.nextProcessId++;
    this.registerActiveProcess(sessionId, activeProcess);
    const output = truncateOutput(
      consumeCommandOutput(activeProcess),
      args.maxOutputTokens,
    );
    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      sessionId,
      originalTokenCount: output.originalTokenCount,
    });
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    const activeProcess = this.activeProcesses.get(args.sessionId);
    if (!activeProcess) {
      return formatExecResponse({
        output: `write_stdin failed: session not found: ${args.sessionId}`,
        wallTimeSeconds: 0,
        exitCode: 1,
      });
    }

    const start = Date.now();
    const chars = args.chars ?? '';
    if (chars.length > 0) {
      if (!activeProcess.process.stdin?.writeText) {
        throw new UserError(
          'Modal sandbox process does not expose stdin for write_stdin().',
        );
      }
      await activeProcess.process.stdin.writeText(chars);
    }

    await waitForProcessOrTimeout(
      activeProcess,
      args.yieldTimeMs ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
    );

    const output = truncateOutput(
      consumeCommandOutput(activeProcess),
      args.maxOutputTokens,
    );
    if (activeProcess.done) {
      this.deleteActiveProcess(args.sessionId, activeProcess);
      return formatExecResponse({
        output: output.text,
        wallTimeSeconds: elapsedSeconds(start),
        exitCode: activeProcess.exitCode ?? 1,
      });
    }

    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      sessionId: args.sessionId,
      originalTokenCount: output.originalTokenCount,
    });
  }

  async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    assertRunAsUnsupported('ModalSandboxClient', args.runAs);
    const absolutePath = await this.resolveRemotePath(args.path);
    const bytes = await this.readSandboxFile(absolutePath);
    return imageOutputFromBytes(args.path, bytes);
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    assertRunAsUnsupported('ModalSandboxClient', runAs);
    const absolutePath = await this.resolveRemotePath(path);
    const process = await this.sandbox.exec(['test', '-e', absolutePath], {
      mode: 'text',
      workdir: this.state.manifest.root,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    return (await process.wait()) === 0;
  }

  async running(): Promise<boolean> {
    try {
      return (await this.sandbox.poll()) === null;
    } catch {
      return false;
    }
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    const requestedPort = assertConfiguredExposedPort({
      providerName: 'ModalSandboxClient',
      port,
      configuredPorts: this.state.configuredExposedPorts,
    });
    const cached = getCachedExposedPortEndpoint(this.state, requestedPort);
    if (cached) {
      return cached;
    }
    if (!this.sandbox.tunnels) {
      throw new SandboxProviderError(
        'ModalSandboxClient exposed port resolution requires Modal sandbox tunnels support.',
        {
          provider: 'modal',
          port: requestedPort,
        },
      );
    }

    let tunnels: Record<number, ModalTunnelLike>;
    try {
      tunnels = await this.sandbox.tunnels(10_000);
    } catch (error) {
      throw new SandboxProviderError(
        `ModalSandboxClient failed to look up tunnels for exposed port ${requestedPort}.`,
        {
          provider: 'modal',
          port: requestedPort,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const tunnel = tunnels[requestedPort];
    if (
      typeof tunnel?.host !== 'string' ||
      tunnel.host.length === 0 ||
      typeof tunnel.port !== 'number'
    ) {
      throw new SandboxProviderError(
        `ModalSandboxClient did not expose port ${requestedPort}.`,
        {
          provider: 'modal',
          port: requestedPort,
        },
      );
    }

    return recordResolvedExposedPortEndpoint(this.state, requestedPort, {
      host: tunnel.host,
      port: tunnel.port,
      tls: true,
      query: '',
    });
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    assertRunAsUnsupported('ModalSandboxClient', args.runAs);
    assertSandboxEntryMetadataSupported(
      'ModalSandboxClient',
      args.path,
      args.entry,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    assertModalLiveEntryMountsUnsupported(
      args.entry,
      args.path,
      this.state.manifest,
    );
    await applyLocalSourceManifestEntryToState(
      this.state,
      args.path,
      args.entry,
      'modal',
      this.writer(),
      this.remotePathResolver,
      this.manifestMaterializationOptions,
    );
    this.invalidateCloudBucketMounts();
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    assertRunAsUnsupported('ModalSandboxClient', runAs);
    assertSandboxManifestMetadataSupported(
      'ModalSandboxClient',
      manifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    assertModalLiveManifestMountsUnsupported(manifest, this.state.manifest);
    await applyLocalSourceManifestToState(
      this.state,
      manifest,
      'modal',
      this.writer(),
      this.remotePathResolver,
      this.manifestMaterializationOptions,
    );
    this.invalidateCloudBucketMounts();
  }

  async persistWorkspace(): Promise<Uint8Array> {
    if (this.state.workspacePersistence === 'snapshot_filesystem') {
      const archive = await this.persistSnapshotFilesystem();
      if (archive) {
        return archive;
      }
    } else if (this.state.workspacePersistence === 'snapshot_directory') {
      const archive = await this.persistSnapshotDirectory();
      if (archive) {
        return archive;
      }
    } else {
      assertTarWorkspacePersistence(
        'ModalSandboxClient',
        this.state.workspacePersistence,
      );
    }

    return await persistRemoteWorkspaceTar({
      providerName: 'ModalSandboxClient',
      manifest: this.state.manifest,
      io: this.archiveIo(),
    });
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    const snapshotRef = decodeNativeSnapshotRef(data);
    if (snapshotRef?.provider === 'modal_snapshot_filesystem') {
      this.assertExpectedSnapshotPersistence(
        snapshotRef.workspacePersistence ?? 'snapshot_filesystem',
        'snapshot_filesystem',
      );
      await this.restoreSnapshotFilesystem(snapshotRef.snapshotId);
      return;
    }
    if (snapshotRef?.provider === 'modal_snapshot_directory') {
      this.assertExpectedSnapshotPersistence(
        snapshotRef.workspacePersistence ?? 'snapshot_directory',
        'snapshot_directory',
      );
      await this.restoreSnapshotDirectory(snapshotRef.snapshotId);
      return;
    }

    if (this.state.workspacePersistence === 'tar') {
      assertTarWorkspacePersistence(
        'ModalSandboxClient',
        this.state.workspacePersistence,
      );
    }
    await hydrateRemoteWorkspaceTar({
      providerName: 'ModalSandboxClient',
      manifest: this.state.manifest,
      io: this.archiveIo(),
      data,
    });
  }

  private async persistSnapshotFilesystem(): Promise<Uint8Array | undefined> {
    if (this.nativeSnapshotRequiresTarFallback()) {
      return undefined;
    }
    if (!this.sandbox.snapshotFilesystem) {
      return undefined;
    }

    const snapshotId = snapshotIdFromModalResult(
      await withProviderError(
        'ModalSandboxClient',
        'modal',
        'capture snapshot_filesystem',
        async () =>
          await this.sandbox.snapshotFilesystem!(
            this.state.snapshotFilesystemTimeoutMs,
          ),
        { sandboxId: this.state.sandboxId },
      ),
    );
    if (!snapshotId) {
      throw new SandboxProviderError(
        'Modal snapshot_filesystem persistence did not return a snapshot id.',
        {
          provider: 'modal',
          sandboxId: this.state.sandboxId,
        },
      );
    }

    return encodeNativeSnapshotRef({
      provider: 'modal_snapshot_filesystem',
      snapshotId,
      workspacePersistence: 'snapshot_filesystem',
    });
  }

  private async persistSnapshotDirectory(): Promise<Uint8Array | undefined> {
    if (this.nativeSnapshotRequiresTarFallback()) {
      return undefined;
    }
    if (!this.sandbox.snapshotDirectory) {
      return undefined;
    }

    const snapshotId = snapshotIdFromModalResult(
      await withProviderError(
        'ModalSandboxClient',
        'modal',
        'capture snapshot_directory',
        async () =>
          await withOptionalTimeoutMs(
            this.sandbox.snapshotDirectory!(this.state.manifest.root),
            this.state.snapshotFilesystemTimeoutMs,
            'Modal snapshot_directory persistence timed out.',
            async (snapshot) => {
              await this.deleteSnapshotDirectoryImage(snapshot);
            },
          ),
        { sandboxId: this.state.sandboxId },
      ),
    );
    if (!snapshotId) {
      throw new SandboxProviderError(
        'Modal snapshot_directory persistence did not return a snapshot id.',
        {
          provider: 'modal',
          sandboxId: this.state.sandboxId,
        },
      );
    }

    return encodeNativeSnapshotRef({
      provider: 'modal_snapshot_directory',
      snapshotId,
      workspacePersistence: 'snapshot_directory',
    });
  }

  private nativeSnapshotRequiresTarFallback(): boolean {
    return this.state.manifest.ephemeralPersistencePaths().size > 0;
  }

  private assertExpectedSnapshotPersistence(
    actual: string,
    expected: ModalWorkspacePersistence,
  ): void {
    if (actual !== expected || this.state.workspacePersistence !== expected) {
      throw new SandboxProviderError(
        `Modal snapshot reference uses ${actual}, but this session expects ${this.state.workspacePersistence}.`,
        {
          provider: 'modal',
          workspacePersistence: this.state.workspacePersistence,
          snapshotWorkspacePersistence: actual,
        },
      );
    }
  }

  private async restoreSnapshotFilesystem(snapshotId: string): Promise<void> {
    const previousSandbox = this.sandbox;
    const previousSandboxId = this.state.sandboxId;
    const previousSandboxOwned = this.ownsSandbox;
    const sandbox = await withProviderError(
      'ModalSandboxClient',
      'modal',
      'restore snapshot_filesystem',
      async () =>
        await withOptionalTimeoutMs(
          (async () => {
            const image = maybeSetModalSandboxCmd(
              await this.modalImageFromId(snapshotId),
              this.state.useSleepCmd,
            );
            return await this.modal.sandboxes.create(
              this.app,
              image,
              await this.sandboxCreateParams(),
            );
          })(),
          this.state.snapshotFilesystemRestoreTimeoutMs,
          'Modal snapshot_filesystem restore timed out.',
          terminateModalSandboxAfterTimeout,
        ),
      { sandboxId: previousSandboxId, snapshotId },
    );
    if (previousSandboxOwned) {
      try {
        await previousSandbox.terminate();
      } catch (error) {
        let replacementTerminateCause: string | undefined;
        try {
          await sandbox.terminate();
        } catch (replacementTerminateError) {
          replacementTerminateCause = errorMessage(replacementTerminateError);
        }
        throw new SandboxProviderError(
          'Modal snapshot_filesystem restore created a replacement sandbox, but terminating the previous sandbox failed.',
          {
            provider: 'modal',
            sandboxId: previousSandboxId,
            replacementSandboxId: sandbox.sandboxId,
            cause: errorMessage(error),
            ...(replacementTerminateCause ? { replacementTerminateCause } : {}),
          },
        );
      }
    }
    await this.resetActiveProcesses();
    this.sandbox = sandbox;
    this.ownsSandbox = true;
    this.state.sandboxId = sandbox.sandboxId;
    this.state.ownsSandbox = true;
    delete this.state.exposedPorts;
  }

  private async restoreSnapshotDirectory(snapshotId: string): Promise<void> {
    if (!this.sandbox.mountImage) {
      throw new SandboxProviderError(
        'Modal snapshot_directory restore requires sandbox mountImage(path, image) support.',
        {
          provider: 'modal',
          sandboxId: this.state.sandboxId,
          snapshotId,
        },
      );
    }
    const sandbox = this.sandbox;
    const ownsSandbox = this.ownsSandbox;
    await withProviderError(
      'ModalSandboxClient',
      'modal',
      'restore snapshot_directory',
      async () =>
        await withOptionalTimeoutMs(
          (async () => {
            const image = await this.modalImageFromId(snapshotId);
            await sandbox.mountImage!(this.state.manifest.root, image);
          })(),
          this.state.snapshotFilesystemRestoreTimeoutMs,
          'Modal snapshot_directory restore timed out.',
          async () => {
            if (ownsSandbox) {
              await terminateModalSandboxAfterTimeout(sandbox);
            }
          },
        ),
      { sandboxId: this.state.sandboxId, snapshotId },
    );
  }

  private async deleteSnapshotDirectoryImage(
    snapshot: string | { objectId?: string; imageId?: string; id?: string },
  ): Promise<void> {
    const snapshotId = snapshotIdFromModalResult(snapshot);
    if (!snapshotId || !this.modal.images.delete) {
      return;
    }
    await this.modal.images.delete(snapshotId).catch(() => {});
  }

  private async modalImageFromId(snapshotId: string): Promise<ModalImageLike> {
    return this.modal.images.fromId
      ? await withProviderError(
          'ModalSandboxClient',
          'modal',
          'look up image',
          async () => await this.modal.images.fromId!(snapshotId),
          { imageId: snapshotId },
        )
      : { imageId: snapshotId };
  }

  private async sandboxCreateParams(): Promise<Record<string, unknown>> {
    const cloudBucketMounts = await this.resolveCloudBucketMounts();
    return {
      workdir: this.state.manifest.root,
      env: this.state.environment,
      ...(typeof this.state.timeoutMs === 'number'
        ? { timeoutMs: this.state.timeoutMs }
        : {}),
      ...(typeof this.state.idleTimeoutMs === 'number'
        ? { idleTimeoutMs: this.state.idleTimeoutMs }
        : {}),
      ...(this.state.gpu ? { gpu: this.state.gpu } : {}),
      ...(this.state.configuredExposedPorts
        ? { encryptedPorts: this.state.configuredExposedPorts }
        : {}),
      ...(cloudBucketMounts ? { cloudBucketMounts } : {}),
    };
  }

  private async resolveCloudBucketMounts(): Promise<
    Record<string, ModalCloudBucketMountLike> | undefined
  > {
    if (this.cloudBucketMountsResolved) {
      return this.cloudBucketMounts;
    }
    this.cloudBucketMounts = await this.cloudBucketMountsProvider?.();
    this.cloudBucketMountsResolved = true;
    return this.cloudBucketMounts;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.closePromise) {
      await this.closePromise;
      return;
    }
    this.closePromise = this.closeOnce();
    try {
      await this.closePromise;
      this.closed = true;
    } finally {
      if (!this.closed) {
        this.closePromise = undefined;
      }
    }
  }

  private async closeOnce(): Promise<void> {
    const processes = [...this.activeProcesses.values()];
    const activeProcesses = processes.filter(
      (activeProcess) => !activeProcess.done,
    );
    await Promise.all(
      activeProcesses.map(async (activeProcess) => {
        if (activeProcess.process.stdin?.close) {
          await activeProcess.process.stdin.close().catch(() => {});
        }
      }),
    );
    if (this.ownsSandbox) {
      await this.sandbox.terminate();
      await Promise.all(
        activeProcesses.map(async (activeProcess) => {
          await activeProcess.donePromise.catch(() => {});
        }),
      );
    } else {
      await Promise.all(
        activeProcesses.map(async (activeProcess) => {
          await activeProcess.stopOutputPumps?.().catch(() => {});
        }),
      );
    }
    for (const process of processes) {
      clearActiveProcessCleanup(process);
    }
    this.activeProcesses.clear();
  }

  private async resetActiveProcesses(): Promise<void> {
    const processes = [...this.activeProcesses.values()];
    this.activeProcesses.clear();
    await Promise.all(
      processes.map(async (activeProcess) => {
        clearActiveProcessCleanup(activeProcess);
        if (!activeProcess.done && activeProcess.process.stdin?.close) {
          await activeProcess.process.stdin.close().catch(() => {});
        }
        if (!activeProcess.done) {
          await activeProcess.stopOutputPumps?.().catch(() => {});
        }
      }),
    );
  }

  private readonly manifestMaterializationOptions = {
    materializeMount: async (
      absolutePath: string,
      _entry: Mount | TypedMount,
    ) => {
      throwModalLiveMountsUnsupported([absolutePath]);
    },
  };

  private invalidateCloudBucketMounts(): void {
    if (!this.cloudBucketMountsProvider) {
      return;
    }
    this.cloudBucketMounts = undefined;
    this.cloudBucketMountsResolved = false;
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  async delete(): Promise<void> {
    await this.close();
  }

  private registerActiveProcess(
    sessionId: number,
    activeProcess: ActiveModalProcess,
  ): void {
    this.activeProcesses.set(sessionId, activeProcess);
    activeProcess.donePromise
      .finally(() => {
        activeProcess.cleanupTimer = setTimeout(() => {
          if (this.activeProcesses.get(sessionId) === activeProcess) {
            this.activeProcesses.delete(sessionId);
          }
        }, COMPLETED_ACTIVE_PROCESS_RETENTION_MS);
        unrefTimer(activeProcess.cleanupTimer);
      })
      .catch(() => {});
  }

  private deleteActiveProcess(
    sessionId: number,
    activeProcess: ActiveModalProcess,
  ): void {
    clearActiveProcessCleanup(activeProcess);
    if (this.activeProcesses.get(sessionId) === activeProcess) {
      this.activeProcesses.delete(sessionId);
    }
  }

  resolveAbsolutePath(path?: string): string {
    return resolveSandboxAbsolutePath(this.state.manifest.root, path);
  }

  async resolveRemotePath(
    path?: string,
    options: RemoteSandboxPathOptions = {},
  ): Promise<string> {
    return await validateRemoteSandboxPathForManifest({
      manifest: this.state.manifest,
      path,
      options,
      runCommand: async (command) => {
        const process = await this.sandbox.exec(['/bin/sh', '-lc', command], {
          mode: 'text',
          workdir: this.state.manifest.root,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          readStreamText(process.stdout),
          readStreamText(process.stderr),
          process.wait(),
        ]);
        return { status: exitCode, stdout, stderr };
      },
    });
  }

  resolveWorkdir(path?: string): string {
    return resolveSandboxWorkdir(this.state.manifest.root, path);
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.runDirectCommand(['mkdir', '-p', '--', path]);
  }

  async writeSandboxFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.ensureDirectory(pathPosix.dirname(path));
    const handle = await this.sandbox.open(path, 'w');
    try {
      await handle.write(
        typeof content === 'string'
          ? new TextEncoder().encode(content)
          : content,
      );
      if (handle.flush) {
        await handle.flush();
      }
    } finally {
      await handle.close();
    }
  }

  async readSandboxFile(path: string): Promise<Uint8Array> {
    const handle = await this.sandbox.open(path, 'r');
    try {
      return Uint8Array.from(await handle.read());
    } finally {
      await handle.close();
    }
  }

  async removeSandboxPath(path: string): Promise<void> {
    await this.runDirectCommand(['rm', '-f', '--', path]);
  }

  private writer(): RemoteManifestWriter {
    return {
      mkdir: async (path) => {
        await this.ensureDirectory(path);
      },
      writeFile: async (path, content) => {
        await this.writeSandboxFile(path, content);
      },
    };
  }

  private archiveIo() {
    return {
      runCommand: async (command: string) => {
        const process = await this.sandbox.exec(['/bin/sh', '-lc', command], {
          mode: 'text',
          workdir: this.state.manifest.root,
          env: this.state.environment,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          readStreamText(process.stdout),
          readStreamText(process.stderr),
          process.wait(),
        ]);
        return { status: exitCode, stdout, stderr };
      },
      readFile: async (path: string) => await this.readSandboxFile(path),
      writeFile: async (path: string, content: string | Uint8Array) => {
        await this.writeSandboxFile(path, content);
      },
      mkdir: async (path: string) => {
        await this.ensureDirectory(path);
      },
    };
  }

  private async runDirectCommand(command: string[]): Promise<void> {
    const process = await this.sandbox.exec(command, {
      mode: 'text',
      workdir: this.state.manifest.root,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const stderr = await readStreamText(process.stderr);
    const exitCode = await process.wait();
    if (exitCode !== 0) {
      throw new UserError(
        `Modal sandbox command failed (${command.join(' ')}): ${stderr || `exit ${exitCode}`}`,
      );
    }
  }
}

/**
 * @see {@link https://modal.com/docs/guide/sandboxes | Sandboxes guide}.
 * @see {@link https://modal.com/docs/guide/sdk-javascript-go | JavaScript and Go SDK guide}.
 * @see {@link https://modal.com/docs/reference/modal.Sandbox | Sandbox reference}.
 */
export class ModalSandboxClient implements SandboxClient<
  ModalSandboxClientOptions,
  ModalSandboxSessionState
> {
  readonly backendId = 'modal';
  private readonly options: Partial<ModalSandboxClientOptions>;

  constructor(options: Partial<ModalSandboxClientOptions> = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs | Manifest,
    manifestOptions?: SandboxClientOptions,
  ): Promise<ModalSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(
      args,
      manifestOptions as ModalSandboxClientOptions | undefined,
    );
    assertCoreSnapshotUnsupported('ModalSandboxClient', createArgs.snapshot);
    assertCoreConcurrencyLimitsUnsupported(
      'ModalSandboxClient',
      createArgs.concurrencyLimits,
    );
    const manifest = createArgs.manifest;
    const resolvedOptions = resolveOptions(
      this.options,
      createArgs.options as ModalSandboxClientOptions | undefined,
    );
    validateOptions(resolvedOptions);
    const useSleepCmd = resolvedOptions.useSleepCmd ?? true;
    assertSandboxManifestMetadataSupported(
      'ModalSandboxClient',
      manifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    assertModalManifestMountsSupported(
      manifest,
      resolvedOptions.nativeCloudBucketSecretName,
    );
    assertModalReusableSandboxMountsSupported(
      manifest,
      resolvedOptions.sandbox,
    );

    return await withSandboxSpan(
      'sandbox.start',
      {
        backend_id: this.backendId,
      },
      async () => {
        const modalModule = await loadModalModule();
        const modal = createModalClientFromModule(modalModule, resolvedOptions);
        const workspacePersistence =
          resolvedOptions.workspacePersistence ?? 'tar';
        const app = shouldResolveModalApp({
          ownsSandbox: !resolvedOptions.sandbox,
          workspacePersistence,
        })
          ? await lookupModalApp({
              modal,
              appName: resolvedOptions.appName,
              environment: resolvedOptions.environment,
              createIfMissing: !resolvedOptions.sandbox,
            })
          : {};
        const environment = await materializeEnvironment(
          manifest,
          resolvedOptions.env,
        );
        const imageState = modalImageStateFromOptions(resolvedOptions);
        let cloudBucketMounts:
          | Record<string, ModalCloudBucketMountLike>
          | undefined;
        let sandbox: ModalSandboxLike;
        if (resolvedOptions.sandbox) {
          sandbox = await withProviderError(
            'ModalSandboxClient',
            'modal',
            'resolve sandbox selector',
            async () =>
              await resolveSelectedModalSandbox(
                modal,
                resolvedOptions.sandbox!,
              ),
          );
        } else {
          const { image, imageId, imageTag } = await resolveModalImage(
            modal,
            resolvedOptions,
          );
          imageState.imageId = imageId;
          imageState.imageTag = imageTag;
          const sandboxImage = maybeSetModalSandboxCmd(image, useSleepCmd);
          cloudBucketMounts = await modalCloudBucketMountsForManifest({
            modalModule,
            manifest,
            defaultSecretName: resolvedOptions.nativeCloudBucketSecretName,
          });
          const createParams = {
            workdir: manifest.root,
            env: environment,
            ...(typeof resolvedOptions.timeoutMs === 'number'
              ? { timeoutMs: resolvedOptions.timeoutMs }
              : {}),
            ...(typeof resolvedOptions.idleTimeoutMs === 'number'
              ? { idleTimeoutMs: resolvedOptions.idleTimeoutMs }
              : {}),
            ...(resolvedOptions.gpu ? { gpu: resolvedOptions.gpu } : {}),
            ...(resolvedOptions.exposedPorts
              ? { encryptedPorts: resolvedOptions.exposedPorts }
              : {}),
            ...(cloudBucketMounts ? { cloudBucketMounts } : {}),
          };
          sandbox = await withOptionalTimeout(
            withProviderError(
              'ModalSandboxClient',
              'modal',
              'create sandbox',
              async () =>
                await modal.sandboxes.create(app, sandboxImage, createParams),
              { appName: resolvedOptions.appName },
            ),
            resolvedOptions.sandboxCreateTimeoutS,
            'Modal sandbox creation timed out.',
            terminateModalSandboxAfterTimeout,
          );
        }

        const sessionState: ModalSandboxSessionState = {
          manifest,
          sandboxId: sandbox.sandboxId,
          ownsSandbox: !resolvedOptions.sandbox,
          appName: resolvedOptions.appName,
          imageId: imageState.imageId,
          imageTag: imageState.imageTag,
          sandboxCreateTimeoutS: resolvedOptions.sandboxCreateTimeoutS,
          workspacePersistence,
          snapshotFilesystemTimeoutMs:
            resolvedOptions.snapshotFilesystemTimeoutMs,
          snapshotFilesystemRestoreTimeoutMs:
            resolvedOptions.snapshotFilesystemRestoreTimeoutMs,
          environment,
          timeoutMs: resolvedOptions.timeoutMs,
          idleTimeoutMs: resolvedOptions.idleTimeoutMs,
          gpu: resolvedOptions.gpu,
          configuredExposedPorts: resolvedOptions.exposedPorts,
          modalEnvironment: resolvedOptions.environment,
          endpoint: resolvedOptions.endpoint,
          imageBuilderVersion: resolvedOptions.imageBuilderVersion,
          nativeCloudBucketSecretName:
            resolvedOptions.nativeCloudBucketSecretName,
          useSleepCmd,
        };
        const session = new ModalSandboxSession({
          modal,
          app,
          sandbox,
          ownsSandbox: !resolvedOptions.sandbox,
          state: sessionState,
          cloudBucketMounts,
          cloudBucketMountsProvider: async () =>
            await modalCloudBucketMountsForManifest({
              modalModule,
              manifest: sessionState.manifest,
              defaultSecretName: resolvedOptions.nativeCloudBucketSecretName,
            }),
        });

        try {
          await session.applyManifest(
            cloneManifestWithoutMountEntries(manifest),
          );
        } catch (error) {
          if (resolvedOptions.sandbox) {
            throw error;
          }
          await closeRemoteSessionOnManifestError('Modal', session, error);
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: ModalSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(): boolean {
    return false;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<ModalSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    return {
      ...state,
      ...baseState,
      ownsSandbox: state.ownsSandbox === false ? false : true,
      appName: readString(state, 'appName'),
      imageId: readOptionalString(state, 'imageId'),
      imageTag: readString(state, 'imageTag', DEFAULT_MODAL_IMAGE_TAG),
      workspacePersistence:
        (state.workspacePersistence as ModalWorkspacePersistence | undefined) ??
        'tar',
      snapshotFilesystemTimeoutMs: readOptionalNumber(
        state,
        'snapshotFilesystemTimeoutMs',
      ),
      snapshotFilesystemRestoreTimeoutMs: readOptionalNumber(
        state,
        'snapshotFilesystemRestoreTimeoutMs',
      ),
      timeoutMs: readOptionalNumber(state, 'timeoutMs'),
      idleTimeoutMs: readOptionalNumber(state, 'idleTimeoutMs'),
      gpu: readOptionalString(state, 'gpu'),
      configuredExposedPorts: readOptionalNumberArray(
        state.configuredExposedPorts,
      ),
      modalEnvironment: readOptionalString(state, 'modalEnvironment'),
      endpoint: readOptionalString(state, 'endpoint'),
      nativeCloudBucketSecretName: readOptionalString(
        state,
        'nativeCloudBucketSecretName',
      ),
      imageBuilderVersion: readOptionalString(state, 'imageBuilderVersion'),
      useSleepCmd:
        typeof state.useSleepCmd === 'boolean' ? state.useSleepCmd : true,
    };
  }

  async resume(state: ModalSandboxSessionState): Promise<ModalSandboxSession> {
    if (!state.sandboxId) {
      throw new UserError(
        'Modal sandbox resume requires a persisted sandboxId.',
      );
    }
    const sandboxId = state.sandboxId;

    const modalModule = await loadModalModule();
    const modal = createModalClientFromModule(modalModule, {
      ...this.options,
      appName: state.appName,
      image: state.imageId
        ? ModalImageSelector.fromId(state.imageId)
        : undefined,
      imageTag: state.imageTag,
      sandboxCreateTimeoutS: state.sandboxCreateTimeoutS,
      workspacePersistence: state.workspacePersistence,
      snapshotFilesystemTimeoutMs: state.snapshotFilesystemTimeoutMs,
      snapshotFilesystemRestoreTimeoutMs:
        state.snapshotFilesystemRestoreTimeoutMs,
      timeoutMs: state.timeoutMs,
      idleTimeoutMs: state.idleTimeoutMs,
      gpu: state.gpu,
      exposedPorts: state.configuredExposedPorts,
      environment: state.modalEnvironment ?? this.options.environment,
      endpoint: state.endpoint ?? this.options.endpoint,
      imageBuilderVersion:
        state.imageBuilderVersion ?? this.options.imageBuilderVersion,
      useSleepCmd: state.useSleepCmd,
    });
    const sandbox = await withProviderError(
      'ModalSandboxClient',
      'modal',
      'resume sandbox',
      async () => await modal.sandboxes.fromId(sandboxId),
      { sandboxId },
    );
    const ownsSandbox = state.ownsSandbox !== false;
    const app = shouldResolveModalApp({
      ownsSandbox,
      workspacePersistence: state.workspacePersistence,
    })
      ? await lookupModalApp({
          modal,
          appName: state.appName,
          environment: state.modalEnvironment,
          createIfMissing: ownsSandbox,
        })
      : {};
    const exitCode = await withProviderError(
      'ModalSandboxClient',
      'modal',
      'poll sandbox',
      async () => await sandbox.poll(),
      { sandboxId },
    );
    if (exitCode !== null) {
      throw new UserError(
        `Modal sandbox ${state.sandboxId} is no longer running.`,
      );
    }

    return new ModalSandboxSession({
      state,
      modal,
      app,
      sandbox,
      ownsSandbox,
      cloudBucketMountsProvider: async () =>
        await modalCloudBucketMountsForManifest({
          modalModule,
          manifest: state.manifest,
          defaultSecretName:
            state.nativeCloudBucketSecretName ??
            this.options.nativeCloudBucketSecretName,
        }),
    });
  }
}

async function loadModalModule(): Promise<ModalModule> {
  try {
    return adaptModalModule(await import('modal'));
  } catch (error) {
    throw new UserError(
      `Modal sandbox support requires the optional \`modal\` package. Install it before using Modal-backed sandbox examples. ${(error as Error).message}`,
    );
  }
}

async function lookupModalApp(args: {
  modal: ModalClientLike;
  appName: string;
  environment?: string;
  createIfMissing: boolean;
}): Promise<ModalAppLike> {
  return await withProviderError(
    'ModalSandboxClient',
    'modal',
    'look up app',
    async () =>
      await args.modal.apps.fromName(args.appName, {
        createIfMissing: args.createIfMissing,
        ...(args.environment ? { environment: args.environment } : {}),
      }),
    { appName: args.appName },
  );
}

function shouldResolveModalApp(args: {
  ownsSandbox: boolean;
  workspacePersistence: ModalWorkspacePersistence;
}): boolean {
  return (
    args.ownsSandbox || args.workspacePersistence === 'snapshot_filesystem'
  );
}

function adaptModalModule(modal: typeof import('modal')): ModalModule {
  const secretApi: unknown = modal.Secret;
  const usesClassSecretApi = typeof secretApi === 'function';
  return {
    ModalClient: modal.ModalClient,
    CloudBucketMount: usesClassSecretApi
      ? class implements ModalCloudBucketMountLike {
          private readonly mount: InstanceType<typeof modal.CloudBucketMount>;

          constructor(bucketName: string, params?: Record<string, unknown>) {
            const bucketEndpointUrl = readOptionalString(
              params,
              'bucketEndpointUrl',
            );
            const keyPrefix = readOptionalString(params, 'keyPrefix');
            this.mount = new modal.CloudBucketMount(bucketName, {
              ...(bucketEndpointUrl ? { bucketEndpointUrl } : {}),
              ...(keyPrefix ? { keyPrefix } : {}),
              ...(typeof params?.readOnly === 'boolean'
                ? { readOnly: params.readOnly }
                : {}),
              ...(params?.secret
                ? { secret: params.secret as InstanceType<typeof modal.Secret> }
                : {}),
            });
          }

          toProto(mountPath: string): unknown {
            return this.mount.toProto(mountPath);
          }
        }
      : (modal.CloudBucketMount as ModalModule['CloudBucketMount']),
    Secret: {
      fromName: async (name, params) => {
        if (usesClassSecretApi) {
          return await modal.Secret.fromName(name, {
            ...(params?.environment ? { environment: params.environment } : {}),
          });
        }
        if (isModalSecretModule(secretApi)) {
          return await secretApi.fromName(name, params);
        }
        throw new Error('Missing Secret export from modal.');
      },
      fromObject: async (entries, params) => {
        if (usesClassSecretApi) {
          const environment = readOptionalString(params, 'environment');
          return await modal.Secret.fromObject(entries, {
            ...(environment ? { environment } : {}),
          });
        }
        if (isModalSecretModule(secretApi)) {
          return await secretApi.fromObject(entries, params);
        }
        throw new Error('Missing Secret export from modal.');
      },
    },
  };
}

function isModalSecretModule(
  value: unknown,
): value is NonNullable<ModalModule['Secret']> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fromName' in value &&
    'fromObject' in value
  );
}

function createModalClientFromModule(
  modalModule: ModalModule,
  options: Partial<ModalSandboxClientOptions>,
): ModalClientLike {
  const { ModalClient } = modalModule;
  const client = new ModalClient({
    ...(options.tokenId ? { tokenId: options.tokenId } : {}),
    ...(options.tokenSecret ? { tokenSecret: options.tokenSecret } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  if (options.imageBuilderVersion !== undefined && client.imageBuilderVersion) {
    const originalImageBuilderVersion = client.imageBuilderVersion.bind(client);
    client.imageBuilderVersion = (version?: string) =>
      originalImageBuilderVersion(version ?? options.imageBuilderVersion);
  }
  return client;
}

async function resolveModalImage(
  modal: ModalClientLike,
  options: Pick<ModalSandboxClientOptions, 'image' | 'imageTag'>,
): Promise<{
  image: ModalImageLike;
  imageId?: string;
  imageTag: string;
}> {
  const selector = modalImageSelectorFromOptions(options);
  if (selector.kind === 'image') {
    const image = selector.value as ModalImageLike;
    return {
      image,
      imageId: modalImageId(image),
      imageTag: options.imageTag ?? DEFAULT_MODAL_IMAGE_TAG,
    };
  }
  if (selector.kind === 'id') {
    const imageId = selector.value as string;
    const image = modal.images.fromId
      ? await withProviderError(
          'ModalSandboxClient',
          'modal',
          'look up image',
          async () => await modal.images.fromId!(imageId),
          { imageId },
        )
      : { imageId };
    return {
      image,
      imageId,
      imageTag: options.imageTag ?? DEFAULT_MODAL_IMAGE_TAG,
    };
  }
  const imageTag = selector.value as string;
  const image = await withProviderError(
    'ModalSandboxClient',
    'modal',
    'resolve image',
    async () => modal.images.fromRegistry(imageTag),
    { imageTag },
  );
  return {
    image,
    imageId: modalImageId(image),
    imageTag,
  };
}

function modalImageStateFromOptions(
  options: Pick<ModalSandboxClientOptions, 'image' | 'imageTag'>,
): {
  imageId?: string;
  imageTag: string;
} {
  const selector = modalImageSelectorFromOptions(options);
  if (selector.kind === 'image') {
    return {
      imageId: modalImageId(selector.value as ModalImageLike),
      imageTag: options.imageTag ?? DEFAULT_MODAL_IMAGE_TAG,
    };
  }
  if (selector.kind === 'id') {
    return {
      imageId: selector.value as string,
      imageTag: options.imageTag ?? DEFAULT_MODAL_IMAGE_TAG,
    };
  }
  return {
    imageTag: selector.value as string,
  };
}

function modalImageSelectorFromOptions(
  options: Pick<ModalSandboxClientOptions, 'image' | 'imageTag'>,
): ModalImageSelector {
  return (
    options.image ??
    ModalImageSelector.fromTag(options.imageTag ?? DEFAULT_MODAL_IMAGE_TAG)
  );
}

async function resolveSelectedModalSandbox(
  modal: ModalClientLike,
  selector: ModalSandboxSelector,
): Promise<ModalSandboxLike> {
  if (selector.kind === 'sandbox') {
    return selector.value as ModalSandboxLike;
  }
  return await withProviderError(
    'ModalSandboxClient',
    'modal',
    'resolve sandbox',
    async () => await modal.sandboxes.fromId(selector.value as string),
    { sandboxId: selector.value as string },
  );
}

function modalImageId(image: ModalImageLike): string | undefined {
  return image.imageId ?? image.objectId;
}

function maybeSetModalSandboxCmd(
  image: ModalImageLike,
  useSleepCmd: boolean,
): ModalImageLike {
  if (!useSleepCmd || typeof image.cmd !== 'function') {
    return image;
  }
  return image.cmd(['sleep', 'infinity']);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function modalCloudBucketMountsForManifest(args: {
  modalModule: ModalModule;
  manifest: Manifest;
  defaultSecretName?: string;
}): Promise<Record<string, ModalCloudBucketMountLike> | undefined> {
  const mountEntries = args.manifest
    .mountTargets()
    .filter(({ entry }) => isModalCloudBucketMountEntry(entry));
  if (mountEntries.length === 0) {
    return undefined;
  }
  if (!args.modalModule.CloudBucketMount) {
    throw new SandboxProviderError(
      'Modal cloud bucket mounts require modal.CloudBucketMount support.',
      {
        provider: 'modal',
      },
    );
  }

  const cloudBucketMounts: Record<string, ModalCloudBucketMountLike> = {};
  for (const { entry, mountPath } of mountEntries) {
    const config = buildModalCloudBucketMountConfig(entry, {
      secretName:
        readOptionalString(entry.mountStrategy, 'secretName') ??
        args.defaultSecretName,
      secretEnvironmentName: readOptionalString(
        entry.mountStrategy,
        'secretEnvironmentName',
      ),
    });
    cloudBucketMounts[mountPath] = new args.modalModule.CloudBucketMount(
      config.bucketName,
      {
        ...(config.bucketEndpointUrl
          ? { bucketEndpointUrl: config.bucketEndpointUrl }
          : {}),
        ...(config.keyPrefix ? { keyPrefix: config.keyPrefix } : {}),
        ...(typeof config.readOnly === 'boolean'
          ? { readOnly: config.readOnly }
          : {}),
        ...(await modalCloudBucketMountSecret(args.modalModule, config)),
      },
    );
  }
  return cloudBucketMounts;
}

async function modalCloudBucketMountSecret(
  modalModule: ModalModule,
  config: ModalCloudBucketMountConfig,
): Promise<{ secret?: ModalSecretLike }> {
  if (!config.secretName && !config.credentials) {
    return {};
  }
  const Secret = modalModule.Secret;
  if (!Secret) {
    throw new SandboxProviderError(
      'Modal cloud bucket mounts require modal.Secret support when credentials are configured.',
      {
        provider: 'modal',
        bucketName: config.bucketName,
      },
    );
  }
  const secretName = config.secretName;
  if (secretName) {
    return {
      secret: await withProviderError(
        'ModalSandboxClient',
        'modal',
        'resolve cloud bucket secret',
        async () =>
          await Secret.fromName(secretName, {
            ...(config.secretEnvironmentName
              ? { environment: config.secretEnvironmentName }
              : {}),
          }),
        {
          bucketName: config.bucketName,
          secretName,
        },
      ),
    };
  }
  return {
    secret: await withProviderError(
      'ModalSandboxClient',
      'modal',
      'create cloud bucket secret',
      async () => await Secret.fromObject(config.credentials ?? {}),
      { bucketName: config.bucketName },
    ),
  };
}

function assertModalManifestMountsSupported(
  manifest: Manifest,
  defaultSecretName?: string,
): void {
  for (const { entry, mountPath } of manifest.mountTargets()) {
    assertModalMountEntrySupported(entry, mountPath, defaultSecretName);
  }
}

function assertModalMountEntrySupported(
  entry: Mount | TypedMount,
  mountPath: string,
  defaultSecretName?: string,
): void {
  if (!isModalCloudBucketMountEntry(entry)) {
    throw new SandboxUnsupportedFeatureError(
      'ModalSandboxClient only supports ModalCloudBucketMountStrategy mount entries.',
      {
        provider: 'modal',
        feature: 'entry.mountStrategy',
        path: mountPath,
        mountType: entry.type,
        strategyType: entry.mountStrategy?.type,
      },
    );
  }
  buildModalCloudBucketMountConfig(entry, {
    secretName:
      readOptionalString(entry.mountStrategy, 'secretName') ??
      defaultSecretName,
    secretEnvironmentName: readOptionalString(
      entry.mountStrategy,
      'secretEnvironmentName',
    ),
  });
}

function assertModalLiveManifestMountsUnsupported(
  manifest: Manifest,
  currentManifest: Manifest,
): void {
  const mountPaths = uniqueStrings([
    ...manifest.mountTargets().map(({ mountPath }) => mountPath),
    ...collectExistingModalMountPathsOverlappedByPaths(
      currentManifest,
      collectModalManifestEntryPaths(manifest),
    ),
  ]);
  if (mountPaths.length === 0) {
    return;
  }
  throwModalLiveMountsUnsupported(mountPaths);
}

function assertModalLiveEntryMountsUnsupported(
  entry: Entry,
  path: string,
  currentManifest: Manifest,
): void {
  const mountPaths = uniqueStrings([
    ...collectModalEntryMountPaths(entry, path),
    ...collectExistingModalMountPathsOverlappedByPaths(
      currentManifest,
      collectModalEntryPaths(entry, path, currentManifest.root),
    ),
  ]);
  if (mountPaths.length === 0) {
    return;
  }
  throwModalLiveMountsUnsupported(mountPaths);
}

function collectModalManifestEntryPaths(manifest: Manifest): string[] {
  return [...manifest.iterEntries()].map(({ logicalPath }) => logicalPath);
}

function collectModalEntryPaths(
  entry: Entry,
  path: string,
  root: string,
): string[] {
  const logicalPath = resolveSandboxRelativePath(root, path);
  return collectModalEntryPathsFromRelative(entry, logicalPath);
}

function collectModalEntryPathsFromRelative(
  entry: Entry,
  path: string,
): string[] {
  if (entry.type !== 'dir' || !entry.children) {
    return [normalizeManifestRelativePath(path)];
  }
  const paths = [normalizeManifestRelativePath(path)];
  for (const [childPath, childEntry] of Object.entries(entry.children)) {
    paths.push(
      ...collectModalEntryPathsFromRelative(
        childEntry,
        pathPosix.join(path, childPath),
      ),
    );
  }
  return paths;
}

function collectModalEntryMountPaths(entry: Entry, path: string): string[] {
  if (isMount(entry)) {
    return [entry.mountPath ?? path];
  }
  if (entry.type !== 'dir' || !entry.children) {
    return [];
  }
  const mountPaths: string[] = [];
  for (const [childPath, childEntry] of Object.entries(entry.children)) {
    mountPaths.push(
      ...collectModalEntryMountPaths(
        childEntry,
        pathPosix.join(path, childPath),
      ),
    );
  }
  return mountPaths;
}

function collectExistingModalMountPathsOverlappedByPaths(
  currentManifest: Manifest,
  paths: string[],
): string[] {
  if (paths.length === 0) {
    return [];
  }
  const normalizedPaths = paths.map(normalizeManifestRelativePath);
  const mountPaths: string[] = [];
  for (const target of currentManifest.mountTargets()) {
    const mountedPaths = [
      target.logicalPath,
      existingMountPathRelativeToManifestRoot(
        currentManifest,
        target.mountPath,
      ),
    ].filter((path): path is string => path !== null);
    if (
      mountedPaths.some((mountedPath) =>
        normalizedPaths.some((path) =>
          manifestRelativePathsOverlap(path, mountedPath),
        ),
      )
    ) {
      mountPaths.push(target.mountPath);
    }
  }
  return mountPaths;
}

function existingMountPathRelativeToManifestRoot(
  manifest: Manifest,
  mountPath: string,
): string | null {
  return relativePosixPathWithinRoot(
    normalizePosixPath(manifest.root),
    normalizePosixPath(mountPath),
  );
}

function manifestRelativePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeManifestRelativePath(left);
  const normalizedRight = normalizeManifestRelativePath(right);
  if (normalizedLeft === '' || normalizedRight === '') {
    return true;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function normalizeManifestRelativePath(path: string): string {
  const normalized = normalizePosixPath(path);
  return normalized === '.' ? '' : normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function throwModalLiveMountsUnsupported(mountPaths: string[]): never {
  throw new SandboxUnsupportedFeatureError(
    'ModalSandboxClient cannot apply mount entries to a running sandbox.',
    {
      provider: 'modal',
      feature: 'manifest.mounts',
      mountPaths,
    },
  );
}

function assertModalReusableSandboxMountsSupported(
  manifest: Manifest,
  sandbox?: ModalSandboxSelector,
): void {
  if (!sandbox) {
    return;
  }

  const mountTargets = manifest.mountTargets();
  if (mountTargets.length === 0) {
    return;
  }

  throw new SandboxUnsupportedFeatureError(
    'ModalSandboxClient cannot apply mount entries when reusing an existing sandbox.',
    {
      provider: 'modal',
      feature: 'manifest.mounts',
      mountPaths: mountTargets.map(({ mountPath }) => mountPath),
    },
  );
}

function resolveOptions(
  defaults: Partial<ModalSandboxClientOptions>,
  overrides?: ModalSandboxClientOptions,
): ModalSandboxClientOptions {
  return {
    appName: overrides?.appName ?? defaults.appName ?? '',
    image: overrides?.image ?? defaults.image,
    sandbox: overrides?.sandbox ?? defaults.sandbox,
    imageTag: overrides?.imageTag ?? defaults.imageTag,
    sandboxCreateTimeoutS:
      overrides?.sandboxCreateTimeoutS ?? defaults.sandboxCreateTimeoutS,
    workspacePersistence:
      overrides?.workspacePersistence ?? defaults.workspacePersistence ?? 'tar',
    snapshotFilesystemTimeoutMs:
      overrides?.snapshotFilesystemTimeoutMs ??
      defaults.snapshotFilesystemTimeoutMs,
    snapshotFilesystemRestoreTimeoutMs:
      overrides?.snapshotFilesystemRestoreTimeoutMs ??
      defaults.snapshotFilesystemRestoreTimeoutMs,
    env: {
      ...(defaults.env ?? {}),
      ...(overrides?.env ?? {}),
    },
    timeoutMs: overrides?.timeoutMs ?? defaults.timeoutMs,
    idleTimeoutMs: overrides?.idleTimeoutMs ?? defaults.idleTimeoutMs,
    gpu: overrides?.gpu ?? defaults.gpu,
    exposedPorts: overrides?.exposedPorts ?? defaults.exposedPorts,
    environment: overrides?.environment ?? defaults.environment,
    endpoint: overrides?.endpoint ?? defaults.endpoint,
    tokenId: overrides?.tokenId ?? defaults.tokenId,
    tokenSecret: overrides?.tokenSecret ?? defaults.tokenSecret,
    imageBuilderVersion:
      overrides?.imageBuilderVersion ?? defaults.imageBuilderVersion,
    nativeCloudBucketSecretName:
      overrides?.nativeCloudBucketSecretName ??
      defaults.nativeCloudBucketSecretName,
    useSleepCmd: overrides?.useSleepCmd ?? defaults.useSleepCmd ?? true,
  };
}

function validateOptions(options: ModalSandboxClientOptions): void {
  if (!options.appName || options.appName.trim().length === 0) {
    throw new UserError('ModalSandboxClient requires a non-empty appName.');
  }

  const workspacePersistence = options.workspacePersistence ?? 'tar';
  if (
    !['tar', 'snapshot_filesystem', 'snapshot_directory'].includes(
      workspacePersistence,
    )
  ) {
    throw new SandboxUnsupportedFeatureError(
      'ModalSandboxClient workspacePersistence must be "tar", "snapshot_filesystem", or "snapshot_directory".',
      {
        provider: 'modal',
        feature: 'workspacePersistence',
      },
    );
  }

  if (
    options.nativeCloudBucketSecretName !== undefined &&
    options.nativeCloudBucketSecretName.trim() === ''
  ) {
    throw new SandboxUnsupportedFeatureError(
      'Modal nativeCloudBucketSecretName must be a non-empty string.',
      {
        provider: 'modal',
        feature: 'nativeCloudBucketSecretName',
      },
    );
  }

  if (options.image) {
    validateModalImageSelector(options.image);
  }
  if (options.sandbox) {
    validateModalSandboxSelector(options.sandbox);
  }
  for (const [name, value] of [
    ['sandboxCreateTimeoutS', options.sandboxCreateTimeoutS],
    ['snapshotFilesystemTimeoutMs', options.snapshotFilesystemTimeoutMs],
    [
      'snapshotFilesystemRestoreTimeoutMs',
      options.snapshotFilesystemRestoreTimeoutMs,
    ],
    ['timeoutMs', options.timeoutMs],
    ['idleTimeoutMs', options.idleTimeoutMs],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    ) {
      throw new UserError(
        `ModalSandboxClient ${name} must be a positive number.`,
      );
    }
  }
}

function validateModalImageSelector(selector: ModalImageSelector): void {
  if (selector.kind === 'image') {
    if (!selector.value || typeof selector.value !== 'object') {
      throw new UserError(
        'ModalSandboxClient image selector requires a Modal image object.',
      );
    }
    return;
  }
  if (
    (selector.kind === 'id' || selector.kind === 'tag') &&
    (typeof selector.value !== 'string' || selector.value.trim().length === 0)
  ) {
    throw new UserError(
      'ModalSandboxClient image selector requires a non-empty string value.',
    );
  }
}

function validateModalSandboxSelector(selector: ModalSandboxSelector): void {
  if (selector.kind === 'sandbox') {
    if (!selector.value || typeof selector.value !== 'object') {
      throw new UserError(
        'ModalSandboxClient sandbox selector requires a Modal sandbox object.',
      );
    }
    return;
  }
  if (
    selector.kind === 'id' &&
    (typeof selector.value !== 'string' || selector.value.trim().length === 0)
  ) {
    throw new UserError(
      'ModalSandboxClient sandbox selector requires a non-empty sandbox id.',
    );
  }
}

function snapshotIdFromModalResult(
  snapshot: string | { objectId?: string; imageId?: string; id?: string },
): string | undefined {
  if (typeof snapshot === 'string') {
    return snapshot || undefined;
  }
  return snapshot.objectId ?? snapshot.imageId ?? snapshot.id;
}

function buildShellCommand(args: ExecCommandArgs): string[] {
  const shellPath = args.shell ?? '/bin/sh';
  const flag = (args.login ?? true) ? '-lc' : '-c';
  return [shellPath, flag, args.cmd];
}

function createActiveProcess(
  process: ModalContainerProcessLike,
): ActiveModalProcess {
  const activeProcess: ActiveModalProcess = {
    process,
    stdout: '',
    stderr: '',
    droppedStdoutChars: 0,
    droppedStderrChars: 0,
    done: false,
    exitCode: null,
    donePromise: Promise.resolve(),
  };

  const stdoutPump = startTextStreamPump(process.stdout, (chunk) => {
    appendActiveProcessOutput(activeProcess, chunk, 'stdout');
  });
  const stderrPump = startTextStreamPump(process.stderr, (chunk) => {
    appendActiveProcessOutput(activeProcess, chunk, 'stderr');
  });
  activeProcess.stopOutputPumps = async () => {
    await Promise.allSettled([stdoutPump.cancel(), stderrPump.cancel()]);
  };

  activeProcess.donePromise = (async () => {
    try {
      activeProcess.exitCode = await process.wait();
      await Promise.allSettled([stdoutPump.promise, stderrPump.promise]);
    } finally {
      activeProcess.done = true;
    }
  })();

  return activeProcess;
}

function startTextStreamPump(
  stream: ReadableStream<string>,
  onChunk: (chunk: string) => void,
): {
  promise: Promise<void>;
  cancel: () => Promise<void>;
} {
  const reader = stream.getReader();
  const promise = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (typeof value === 'string') {
          onChunk(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    promise,
    cancel: async () => {
      await reader.cancel().catch(() => {});
      await promise.catch(() => {});
    },
  };
}

function clearActiveProcessCleanup(activeProcess: ActiveModalProcess): void {
  if (activeProcess.cleanupTimer) {
    clearTimeout(activeProcess.cleanupTimer);
    activeProcess.cleanupTimer = undefined;
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}

async function pumpTextStream(
  stream: ReadableStream<string>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  await startTextStreamPump(stream, onChunk).promise;
}

async function readStreamText(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  await pumpTextStream(stream, (chunk) => {
    text += chunk;
  });
  return text;
}

async function waitForProcessOrTimeout(
  activeProcess: ActiveModalProcess,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      activeProcess.donePromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        unrefTimer(timeout);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function joinCommandOutput(activeProcess: ActiveModalProcess): string {
  return [
    withDroppedOutputPrefix(
      activeProcess.stdout,
      activeProcess.droppedStdoutChars,
    ),
    withDroppedOutputPrefix(
      activeProcess.stderr,
      activeProcess.droppedStderrChars,
    ),
  ]
    .filter((value) => value.trim().length > 0)
    .map((value) => value.trimEnd())
    .join('\n');
}

function consumeCommandOutput(activeProcess: ActiveModalProcess): string {
  const output = joinCommandOutput(activeProcess);
  activeProcess.stdout = '';
  activeProcess.stderr = '';
  activeProcess.droppedStdoutChars = 0;
  activeProcess.droppedStderrChars = 0;
  return output;
}

type ActiveProcessOutputStream = 'stdout' | 'stderr';

function appendActiveProcessOutput(
  activeProcess: ActiveModalProcess,
  chunk: string,
  stream: ActiveProcessOutputStream,
): void {
  if (chunk.length === 0) {
    return;
  }

  if (stream === 'stdout') {
    const stdout = appendBoundedOutput(
      activeProcess.stdout,
      activeProcess.droppedStdoutChars,
      chunk,
    );
    activeProcess.stdout = stdout.output;
    activeProcess.droppedStdoutChars = stdout.droppedChars;
    return;
  }

  const stderr = appendBoundedOutput(
    activeProcess.stderr,
    activeProcess.droppedStderrChars,
    chunk,
  );
  activeProcess.stderr = stderr.output;
  activeProcess.droppedStderrChars = stderr.droppedChars;
}

function appendBoundedOutput(
  output: string,
  droppedChars: number,
  chunk: string,
): { output: string; droppedChars: number } {
  const nextLength = output.length + chunk.length;
  if (nextLength <= MAX_ACTIVE_PROCESS_OUTPUT_CHARS) {
    return {
      output: output + chunk,
      droppedChars,
    };
  }

  const nextDroppedChars =
    droppedChars + nextLength - MAX_ACTIVE_PROCESS_OUTPUT_CHARS;
  if (chunk.length >= MAX_ACTIVE_PROCESS_OUTPUT_CHARS) {
    return {
      output: chunk.slice(-MAX_ACTIVE_PROCESS_OUTPUT_CHARS),
      droppedChars: nextDroppedChars,
    };
  }

  const existingCharsToKeep = MAX_ACTIVE_PROCESS_OUTPUT_CHARS - chunk.length;
  return {
    output: output.slice(-existingCharsToKeep) + chunk,
    droppedChars: nextDroppedChars,
  };
}

function withDroppedOutputPrefix(output: string, droppedChars: number): string {
  if (droppedChars === 0) {
    return output;
  }

  return `[...${droppedChars} characters truncated from process output...]\n${output}`;
}

async function withOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutSeconds: number | undefined,
  message: string,
  onLateResolve?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (typeof timeoutSeconds !== 'number') {
    return await promise;
  }
  return await withOptionalTimeoutMs(
    promise,
    timeoutSeconds * 1000,
    message,
    onLateResolve,
  );
}

async function withOptionalTimeoutMs<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
  onLateResolve?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (typeof timeoutMs !== 'number') {
    return await promise;
  }

  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      ),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          if (settled) {
            return;
          }
          promise
            .then(async (value) => {
              await onLateResolve?.(value);
            })
            .catch(() => {});
          reject(new UserError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function terminateModalSandboxAfterTimeout(
  sandbox: ModalSandboxLike,
): Promise<void> {
  await sandbox.terminate().catch(() => {});
}
