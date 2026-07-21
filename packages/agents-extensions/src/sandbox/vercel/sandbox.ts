import { UserError } from '@openai/agents-core';
import { loadEnv } from '@openai/agents-core/_shims';
import {
  Environment,
  isMount,
  Manifest,
  SandboxLifecycleError,
  SandboxMountError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxArchiveLimits,
  type SandboxConcurrencyLimits,
  type Entry,
  type MaterializeEntryArgs,
  type S3Mount,
  type SandboxSessionSerializationOptions,
  type SandboxSessionState,
  type WorkspaceArchiveData,
  type WorkspaceArchiveOptions,
} from '@openai/agents-core/sandbox';
import {
  assertCoreSnapshotUnsupported,
  assertSandboxManifestMetadataSupported,
  assertRunAsUnsupported,
  cloneManifestWithoutMountEntries,
  cloneManifestWithRoot,
  deserializeRemoteSandboxSessionStateValues,
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
  hydrateRemoteWorkspaceTar,
  materializeEnvironment,
  MOUNT_MANIFEST_METADATA_SUPPORT,
  posixDirname,
  persistRemoteWorkspaceTar,
  providerErrorDetails,
  providerErrorMessage,
  resolveSandboxAbsolutePath,
  resolveSandboxRelativePath,
  shellQuote,
  serializeRemoteSandboxSessionState,
  toUint8Array,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecord,
  readOptionalString,
  readString,
  isProviderSandboxNotFoundError,
  withProviderError,
  withSandboxSpan,
  validateRemoteSandboxPathForManifest,
  validateWorkspaceTarArchive,
  RemoteSandboxSessionBase,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../shared';
import {
  hasVercelS3Credentials,
  isVercelCloudBucketMountEntry,
  mountVercelCloudBucket,
  unmountVercelCloudBucket,
  validateVercelCloudBucketMountEntry,
  type VercelMountCommand,
} from './mounts';

const DEFAULT_VERCEL_WORKSPACE_ROOT = '/vercel/sandbox';
const VERCEL_MOUNT_COMMAND_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const VERCEL_S3_CREDENTIAL_ENVIRONMENT_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

type VercelSdkSandboxClass = typeof import('@vercel/sandbox').Sandbox;
type VercelSdkSandbox = import('@vercel/sandbox').Sandbox;
type VercelSdkCreateParams = Parameters<VercelSdkSandboxClass['create']>[0];
type VercelSdkGetParams = Parameters<VercelSdkSandboxClass['get']>[0];
type VercelSdkRunCommandParams = Parameters<VercelSdkSandbox['runCommand']>[0];

type VercelSandboxCreateParams = Record<string, unknown> & {
  source?:
    | {
        type: 'git';
        url: string;
        depth?: number;
        revision?: string;
        username?: string;
        password?: string;
      }
    | {
        type: 'tarball';
        url: string;
      }
    | {
        type: 'snapshot';
        snapshotId: string;
      };
  ports?: number[];
  timeout?: number;
  resources?: Record<string, unknown>;
  runtime?: string;
  networkPolicy?: Record<string, unknown>;
  interactive?: boolean;
  env?: Record<string, string>;
};

type VercelSandboxGetParams = Record<string, unknown> & {
  sandboxId: string;
};

type VercelSandboxRunCommandParams = Record<string, unknown> & {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  detached?: boolean;
  signal?: AbortSignal;
};

type VercelSandboxClass = {
  create(params?: VercelSandboxCreateParams): Promise<VercelSandboxInstance>;
  get(params: VercelSandboxGetParams): Promise<VercelSandboxInstance>;
};

type VercelCredentials = Pick<
  VercelSandboxClientOptions,
  'projectId' | 'teamId' | 'token'
>;
type CompleteVercelCredentials = Required<VercelCredentials>;
type NormalizedVercelCredentials =
  | CompleteVercelCredentials
  | {
      projectId?: undefined;
      teamId?: undefined;
      token?: undefined;
    };

type VercelSandboxInstance = {
  sandboxId: string;
  runCommand(
    params: VercelSandboxRunCommandParams,
  ): Promise<VercelCommandFinishedLike>;
  mkDir(path: string): Promise<void>;
  readFileToBuffer(file: {
    path: string;
    cwd?: string;
  }): Promise<Buffer | Uint8Array | null>;
  writeFiles(
    files: {
      path: string;
      content: string | Uint8Array;
      mode?: number;
    }[],
  ): Promise<void>;
  domain?(port: number): string;
  stop?(): Promise<unknown>;
  snapshot?(params?: { expiration?: number }): Promise<{ snapshotId?: string }>;
};

type VercelCommandFinishedLike = {
  exitCode: number | null;
  output(
    stream?: 'stdout' | 'stderr' | 'both',
    options?: { signal?: AbortSignal },
  ): Promise<string>;
};

class VercelMountOperationMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export type VercelWorkspacePersistence = 'tar' | 'snapshot';

export interface VercelSandboxClientOptions extends SandboxClientOptions {
  /**
   * Vercel project ID. Per-create options override constructor options, which
   * override `VERCEL_PROJECT_ID`. Credentials are forwarded only when the
   * resolved `projectId`, `teamId`, and `token` are all non-empty.
   */
  projectId?: string;
  /**
   * Vercel team ID. Per-create options override constructor options, which
   * override `VERCEL_TEAM_ID`. Credentials are forwarded only when the
   * resolved `projectId`, `teamId`, and `token` are all non-empty.
   */
  teamId?: string;
  /**
   * Vercel access token. Per-create options override constructor options,
   * which override `VERCEL_TOKEN`. Credentials are forwarded only when the
   * resolved `projectId`, `teamId`, and `token` are all non-empty; otherwise
   * authentication is delegated to `@vercel/sandbox`. Resolved tokens are
   * included in serialized session state.
   */
  token?: string;
  runtime?: string;
  resources?: Record<string, unknown>;
  exposedPorts?: number[];
  interactive?: boolean;
  networkPolicy?: Record<string, unknown>;
  timeoutMs?: number;
  workspacePersistence?: VercelWorkspacePersistence;
  archiveLimits?: SandboxArchiveLimits | null;
  snapshotExpirationMs?: number;
  env?: Record<string, string>;
  /**
   * Explicitly allows S3 credentials from mount entries to be forwarded to
   * commands running inside the remote sandbox.
   */
  allowS3CredentialExposure?: boolean;
}

export interface VercelSandboxSessionState extends SandboxSessionState {
  sandboxId: string;
  /**
   * Whether authentication is explicitly configured or delegated to the SDK.
   * Missing values identify session state created before this field existed.
   */
  authenticationMode?: 'explicit' | 'sdk';
  projectId?: string;
  teamId?: string;
  token?: string;
  runtime?: string;
  resources?: Record<string, unknown>;
  configuredExposedPorts?: number[];
  interactive?: boolean;
  networkPolicy?: Record<string, unknown>;
  timeoutMs?: number;
  workspacePersistence: VercelWorkspacePersistence;
  snapshotExpirationMs?: number;
  environment: Record<string, string>;
  snapshotId?: string;
  snapshotSandboxId?: string;
  snapshotSupported?: boolean;
}

export class VercelSandboxSession extends RemoteSandboxSessionBase<VercelSandboxSessionState> {
  private sandbox: VercelSandboxInstance;
  private readonly knownDirs: Set<string>;
  private readonly pendingDirCreates = new Map<string, Promise<void>>();
  private closePromise?: Promise<void>;
  private closeCompleted = false;
  private mountFailure?: string;
  private readonly mountOperationMutex = new VercelMountOperationMutex();
  /**
   * This provider applies the remote mount simplicity boundary by fixing the
   * mount set at creation and keeping it only in memory.
   *
   * Keep the lifecycle limited to create, tar detach/remount, and close. Do not
   * add dynamic mutation, persisted mount reconstruction, credential refresh,
   * or best-effort reconciliation without a trusted provider primitive that
   * makes those transitions unambiguous.
   */
  private readonly activeMounts = new Map<string, S3Mount>();
  private readonly credentials: Pick<
    VercelSandboxClientOptions,
    'projectId' | 'teamId' | 'token'
  >;

  constructor(args: {
    state: VercelSandboxSessionState;
    sandbox: VercelSandboxInstance;
    credentials?: Pick<
      VercelSandboxClientOptions,
      'projectId' | 'teamId' | 'token'
    >;
    concurrencyLimits?: SandboxConcurrencyLimits;
    archiveLimits?: SandboxArchiveLimits | null;
  }) {
    super({
      state: args.state,
      options: {
        providerName: 'VercelSandboxClient',
        providerId: 'vercel',
        concurrencyLimits: args.concurrencyLimits,
        archiveLimits: args.archiveLimits,
      },
    });
    this.sandbox = args.sandbox;
    this.credentials = args.credentials ?? {};
    this.knownDirs = new Set();
    this.resetKnownDirs();
  }

  override supportsPty(): boolean {
    return false;
  }

  protected override assertExecRunAs(runAs?: string): void {
    assertRunAsUnsupported('VercelSandboxClient', runAs);
  }

  protected override assertFilesystemRunAs(runAs?: string): void {
    assertFilesystemRunAs(runAs);
  }

  protected override resolveManifestForApply(manifest: Manifest): Manifest {
    return resolveManifestRoot(manifest);
  }

  protected override manifestMetadataSupport() {
    return MOUNT_MANIFEST_METADATA_SUPPORT;
  }

  protected override async beforeFilesystemMutation(): Promise<void> {
    this.markWorkspaceMutated();
  }

  protected override async beforeExecCommand(): Promise<void> {
    this.markWorkspaceMutated();
    this.resetKnownDirs();
  }

  protected override async beforeMaterializeEntry(
    args: MaterializeEntryArgs,
  ): Promise<void> {
    if (this.activeMounts.size > 0 || isMount(args.entry)) {
      throw new SandboxUnsupportedFeatureError(
        'VercelSandboxClient mount topology is fixed when the sandbox is created.',
        {
          provider: 'vercel',
          feature: 'materializeEntry with mounts',
        },
      );
    }
    this.markWorkspaceMutated();
  }

  protected override async beforeApplyManifest(
    manifest: Manifest,
  ): Promise<void> {
    if (
      this.activeMounts.size > 0 ||
      manifest.mountTargetsForMaterialization().length > 0
    ) {
      throw new SandboxUnsupportedFeatureError(
        'VercelSandboxClient mount topology is fixed when the sandbox is created.',
        {
          provider: 'vercel',
          feature: 'applyManifest with mounts',
        },
      );
    }
    this.markWorkspaceMutated();
  }

  protected override runningWorkdir(): string {
    return '/';
  }

  protected override exposedPortSource(): string {
    return 'domain';
  }

  protected override async resolveRemoteExposedPort(
    requestedPort: number,
  ): Promise<string> {
    if (!this.sandbox.domain) {
      throw new SandboxProviderError(
        'VercelSandboxClient exposed port resolution requires @vercel/sandbox domain(port) support.',
        {
          provider: 'vercel',
          port: requestedPort,
        },
      );
    }

    try {
      return this.sandbox.domain(requestedPort);
    } catch (error) {
      throw new SandboxProviderError(
        `VercelSandboxClient failed to resolve exposed port ${requestedPort}.`,
        {
          provider: 'vercel',
          port: requestedPort,
          cause: providerErrorMessage(error),
        },
      );
    }
  }

  async materializeInitialManifest(manifest: Manifest): Promise<void> {
    this.markWorkspaceMutated();
    await this.materializeManifestEntries(
      cloneManifestWithoutMountEntries(manifest),
    );
    try {
      for (const {
        entry,
        mountPath,
      } of manifest.mountTargetsForMaterialization()) {
        await this.mountInitialEntry(entry, mountPath);
      }
    } catch (error) {
      const rollbackErrors = await this.rollbackInitialMounts();
      if (rollbackErrors.length > 0) {
        throw new UserError(
          `Failed to apply the initial Vercel S3 mounts and roll back partial mounts. Mount error: ${providerErrorMessage(error)} Rollback errors: ${rollbackErrors.join('; ')}`,
        );
      }
      throw error;
    }
  }

  async prepareWorkspaceRoot(): Promise<void> {
    this.markWorkspaceMutated();
    await this.ensureDir(this.state.manifest.root);
  }

  async persistWorkspace(): Promise<Uint8Array> {
    if (this.activeMounts.size > 0) {
      return await this.withMountsDetached(async () => {
        return await persistRemoteWorkspaceTar({
          providerName: 'VercelSandboxClient',
          manifest: this.state.manifest,
          io: this.mountTransitionArchiveIo(),
        });
      });
    }
    if (this.state.workspacePersistence === 'snapshot') {
      await captureVercelSnapshot(this.state, {
        sandbox: this.sandbox,
      });
      const snapshotId = this.state.snapshotId;
      if (!snapshotId) {
        throw new SandboxProviderError(
          'Vercel snapshot persistence did not produce a snapshot id.',
          {
            provider: 'vercel',
            sandboxId: this.state.sandboxId,
          },
        );
      }
      try {
        await this.replaceSandboxFromSnapshot(snapshotId, {
          snapshotFreshAfterRestore: true,
          ignorePreviousStopFailure: true,
        });
      } catch (error) {
        await this.recoverSandboxAfterSnapshotRestoreFailure(snapshotId, error);
      }
      return encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId,
      });
    }

    return await this.persistWorkspaceTar();
  }

  async hydrateWorkspace(
    data: WorkspaceArchiveData,
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    this.markWorkspaceMutated();
    if (this.activeMounts.size > 0) {
      if (decodeNativeSnapshotRef(data)?.provider === 'vercel') {
        throw new SandboxUnsupportedFeatureError(
          'VercelSandboxClient cannot hydrate a native snapshot while S3 mounts are active.',
          {
            provider: 'vercel',
            feature: 'snapshot hydration with mounts',
          },
        );
      }
      validateWorkspaceTarArchive(data, {
        allowSymlinks: false,
        archiveLimits: options.archiveLimits ?? this.getArchiveLimits(),
        rejectRelPaths: [...this.activeMounts.keys()].map((mountPath) =>
          resolveSandboxRelativePath(this.state.manifest.root, mountPath),
        ),
      });
      await this.withMountsDetached(async () => {
        await hydrateRemoteWorkspaceTar({
          providerName: 'VercelSandboxClient',
          manifest: this.state.manifest,
          io: this.mountTransitionArchiveIo(),
          data,
          archiveLimits: options.archiveLimits ?? this.getArchiveLimits(),
        });
      });
      this.resetKnownDirs();
      this.knownDirs.add(this.state.manifest.root);
      return;
    }
    const snapshotRef =
      this.state.workspacePersistence === 'snapshot'
        ? decodeNativeSnapshotRef(data)
        : undefined;
    if (snapshotRef?.provider === 'vercel') {
      await this.replaceSandboxFromSnapshot(snapshotRef.snapshotId);
      return;
    }

    await this.hydrateWorkspaceTar(data, options);
    this.resetKnownDirs();
    this.knownDirs.add(this.state.manifest.root);
  }

  async close(): Promise<void> {
    if (this.closeCompleted) {
      return;
    }
    this.closePromise ??= this.closeOnce().catch((error) => {
      if (!this.closeCompleted) {
        this.closePromise = undefined;
      }
      throw error;
    });
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    if (this.activeMounts.size > 0) {
      await this.closeMountedSandbox();
      return;
    }

    let snapshotError: unknown;
    let snapshotCapturedBeforeStop = false;
    if (
      this.state.workspacePersistence === 'snapshot' &&
      this.sandbox.snapshot &&
      this.state.snapshotSandboxId !== this.sandbox.sandboxId
    ) {
      try {
        await captureVercelSnapshot(this.state, {
          sandbox: this.sandbox,
        });
        snapshotCapturedBeforeStop = true;
      } catch (error) {
        snapshotError = error;
      }
    }

    try {
      await stopVercelSandbox(this.sandbox);
      this.closeCompleted = true;
    } catch (stopError) {
      if (snapshotError) {
        throw new UserError(
          `Failed to capture a Vercel sandbox snapshot and stop the sandbox. Snapshot error: ${providerErrorMessage(snapshotError)} Stop error: ${providerErrorMessage(stopError)}`,
        );
      }
      if (snapshotCapturedBeforeStop) {
        this.closeCompleted = true;
        return;
      }
      throw stopError;
    }
    if (snapshotError) {
      throw snapshotError;
    }
  }

  private async closeMountedSandbox(): Promise<void> {
    await this.mountOperationMutex.runExclusive(async () => {
      if (this.closeCompleted) {
        return;
      }

      let unmountError: unknown;
      try {
        await this.unmountAll();
      } catch (error) {
        unmountError = error;
      }

      let stopError: unknown;
      try {
        await stopVercelSandbox(this.sandbox);
      } catch (error) {
        stopError = error;
      }

      if (!stopError) {
        this.closeCompleted = true;
        this.activeMounts.clear();
      } else {
        this.markMountSessionUnusable(stopError);
      }

      if (unmountError && stopError) {
        throw new UserError(
          `Failed to unmount Vercel S3 buckets and stop the sandbox. Unmount error: ${providerErrorMessage(unmountError)} Stop error: ${providerErrorMessage(stopError)}`,
        );
      }
      if (unmountError) {
        throw unmountError;
      }
      if (stopError) {
        throw stopError;
      }
    });
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  async delete(): Promise<void> {
    await this.close();
  }

  private async mountInitialEntry(
    entry: Entry,
    declaredMountPath: string,
  ): Promise<void> {
    if (!isVercelCloudBucketMountEntry(entry)) {
      throw new SandboxUnsupportedFeatureError(
        'VercelSandboxClient only supports VercelCloudBucketMountStrategy on S3 mount entries.',
        {
          provider: 'vercel',
          feature: 'entry.mountStrategy',
          mountType: entry.type,
          strategyType: (entry as { mountStrategy?: { type?: unknown } })
            .mountStrategy?.type,
        },
      );
    }

    const mountPath = resolveSandboxAbsolutePath(
      this.state.manifest.root,
      declaredMountPath,
    );
    assertNoOverlappingMountPath(this.activeMounts.keys(), mountPath);
    await this.assertCanonicalMountPath(mountPath);
    await mountVercelCloudBucket({
      entry,
      mountPath,
      runCommand: this.mountCommand,
      environment: this.state.environment,
      validateMountPath: async () => {
        await this.assertCanonicalMountPath(mountPath);
      },
    });
    this.activeMounts.set(mountPath, entry);
  }

  private async assertCanonicalMountPath(mountPath: string): Promise<void> {
    const resolvedPath = await this.resolveRemotePath(mountPath, {
      forWrite: true,
    });
    this.assertResolvedMountPath(mountPath, resolvedPath);
  }

  private async assertCanonicalMountPathDuringTransition(
    mountPath: string,
  ): Promise<void> {
    const resolvedPath = await this.resolveRemotePathDirect(mountPath, {
      forWrite: true,
    });
    this.assertResolvedMountPath(mountPath, resolvedPath);
  }

  private assertResolvedMountPath(
    mountPath: string,
    resolvedPath: string,
  ): void {
    if (resolvedPath !== mountPath) {
      throw new SandboxMountError(
        'VercelSandboxClient refuses an S3 mount path that resolves through a symlink.',
        {
          provider: 'vercel',
          mountPath,
          resolvedPath,
        },
        'mount_config_invalid',
      );
    }
  }

  private async rollbackInitialMounts(): Promise<string[]> {
    const errors: string[] = [];
    for (const mountPath of [...this.activeMounts.keys()].reverse()) {
      try {
        await unmountVercelCloudBucket({
          mountPath,
          runCommand: this.mountCommand,
        });
        this.activeMounts.delete(mountPath);
      } catch (error) {
        errors.push(`${mountPath}: ${providerErrorMessage(error)}`);
      }
    }
    return errors;
  }

  private assertMountSessionUsable(): void {
    if (!this.mountFailure) {
      return;
    }
    throw new SandboxLifecycleError(
      'VercelSandboxClient cannot perform workspace operations after a failed S3 mount cleanup.',
      {
        provider: 'vercel',
        sandboxId: this.state.sandboxId,
        cause: this.mountFailure,
      },
    );
  }

  private markMountSessionUnusable(error: unknown): void {
    this.mountFailure ??= providerErrorMessage(error);
  }

  /**
   * Runs tar persistence while external bucket files are outside the workspace.
   *
   * A failed detach or remount stops the sandbox. This fail-closed boundary is
   * deliberate: recovery logic must not guess whether a privileged remote
   * operation completed.
   */
  private async withMountsDetached<T>(operation: () => Promise<T>): Promise<T> {
    return await this.mountOperationMutex.runExclusive(async () => {
      this.assertMountSessionUsable();
      return await this.withMountsDetachedLocked(operation);
    });
  }

  private async withMountsDetachedLocked<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      await this.unmountAll();
    } catch (error) {
      return await this.stopAfterMountTransitionFailure(
        'detach Vercel S3 mounts',
        error,
      );
    }

    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await operation();
    } catch (error) {
      operationError = error;
    }

    try {
      await this.remountAll();
    } catch (error) {
      return await this.stopAfterMountTransitionFailure(
        'restore Vercel S3 mounts',
        error,
        operationError,
      );
    }

    if (operationError) {
      throw operationError;
    }
    return value as T;
  }

  private async unmountAll(): Promise<void> {
    for (const mountPath of [...this.activeMounts.keys()].reverse()) {
      await unmountVercelCloudBucket({
        mountPath,
        runCommand: this.mountCommand,
      });
    }
  }

  private async remountAll(): Promise<void> {
    for (const [mountPath, entry] of this.activeMounts) {
      await this.assertCanonicalMountPathDuringTransition(mountPath);
      await mountVercelCloudBucket({
        entry,
        mountPath,
        runCommand: this.mountCommand,
        environment: this.state.environment,
        validateMountPath: async () => {
          await this.assertCanonicalMountPathDuringTransition(mountPath);
        },
      });
    }
  }

  private async stopAfterMountTransitionFailure(
    operation: string,
    transitionError: unknown,
    precedingError?: unknown,
  ): Promise<never> {
    this.markMountSessionUnusable(transitionError);
    let stopError: unknown;
    try {
      await stopVercelSandbox(this.sandbox);
    } catch (error) {
      stopError = error;
    }

    if (stopError) {
      throw new UserError(
        `VercelSandboxClient failed to ${operation} and could not stop the sandbox. Transition error: ${providerErrorMessage(transitionError)} Stop error: ${providerErrorMessage(stopError)}`,
      );
    }
    this.closeCompleted = true;
    this.activeMounts.clear();
    throw new SandboxLifecycleError(
      `VercelSandboxClient failed to ${operation}; the sandbox was stopped.`,
      {
        provider: 'vercel',
        sandboxId: this.state.sandboxId,
        cause: providerErrorMessage(transitionError),
        ...(precedingError
          ? { precedingCause: providerErrorMessage(precedingError) }
          : {}),
      },
    );
  }

  private readonly mountCommand: VercelMountCommand = async (
    command,
    args,
    options,
  ) => {
    const signal = options?.timeoutMs
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;
    const result = await this.sandbox.runCommand({
      cmd: '/usr/bin/env',
      args: [
        '-i',
        `PATH=${VERCEL_MOUNT_COMMAND_PATH}`,
        ...Object.entries(options?.env ?? {}).map(
          ([name, value]) => `${name}=${value}`,
        ),
        command,
        ...args,
      ],
      env: {},
      ...(options?.sudo ? { sudo: true } : {}),
      ...(signal ? { signal } : {}),
    });
    return {
      status: result.exitCode ?? 1,
      stdout: await result.output('stdout', { signal }),
      stderr: await result.output('stderr', { signal }),
    };
  };

  private mountTransitionArchiveIo() {
    return {
      runCommand: async (command: string) =>
        await this.runRemoteCommandDirect(command, {
          kind: 'archive',
          workdir: this.state.manifest.root,
        }),
      mkdir: async (path: string) => await this.ensureDir(path),
      readFile: async (path: string) => await this.readRemoteFileDirect(path),
      writeFile: async (path: string, content: string | Uint8Array) =>
        await this.writeRemoteFileDirect(path, content),
    };
  }

  private async resolveRemotePathDirect(
    path: string,
    options: { forWrite?: boolean } = {},
  ): Promise<string> {
    return await validateRemoteSandboxPathForManifest({
      manifest: this.state.manifest,
      path,
      options,
      runCommand: async (command) =>
        await this.runRemoteCommandDirect(command, {
          kind: 'path',
          workdir: this.state.manifest.root,
        }),
    });
  }

  private async runWorkspaceOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertMountSessionUsable();
    if (this.activeMounts.size === 0) {
      return await operation();
    }
    return await this.mountOperationMutex.runExclusive(async () => {
      this.assertMountSessionUsable();
      return await operation();
    });
  }

  private async runRemoteCommandDirect(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    const result = await this.execShell(command, options.workdir, undefined);
    return {
      status: result.exitCode,
      stdout: result.output,
      stderr: '',
    };
  }

  private async readRemoteFileDirect(path: string): Promise<Uint8Array> {
    const bytes = await this.sandbox.readFileToBuffer({ path });
    if (!bytes) {
      throw new UserError(`Sandbox path not found: ${path}`);
    }
    return await toUint8Array(bytes);
  }

  private async writeRemoteFileDirect(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.sandbox.writeFiles([
      {
        path,
        content,
      },
    ]);
  }

  private async execShell(
    command: string,
    cwd: string,
    sudo: boolean | undefined,
  ): Promise<{ exitCode: number; output: string }> {
    const result = await this.sandbox.runCommand({
      cmd: '/bin/sh',
      args: ['-lc', command],
      cwd,
      env: this.state.environment,
      ...(sudo ? { sudo: true } : {}),
    });
    return {
      exitCode: result.exitCode ?? 1,
      output: await result.output('both'),
    };
  }

  private async replaceSandboxFromSnapshot(
    snapshotId: string,
    options: {
      snapshotFreshAfterRestore?: boolean;
      ignorePreviousStopFailure?: boolean;
    } = {},
  ): Promise<void> {
    const previousSandbox = this.sandbox;
    const credentials = await this.resolveSnapshotCredentials();
    const sandbox = await this.createAndPrepareSandboxFromSnapshot(
      snapshotId,
      credentials,
    );

    try {
      await stopVercelSandbox(previousSandbox);
    } catch (error) {
      if (
        options.ignorePreviousStopFailure &&
        isVercelSandboxAlreadyStoppedError(error)
      ) {
        this.bindRestoredSandbox(
          sandbox,
          snapshotId,
          options.snapshotFreshAfterRestore,
        );
        return;
      }
      let replacementStopCause: string | undefined;
      try {
        await stopVercelSandbox(sandbox);
      } catch (replacementStopError) {
        replacementStopCause = providerErrorMessage(replacementStopError);
      }
      throw new SandboxProviderError(
        'Vercel snapshot restore created a replacement sandbox, but stopping the previous sandbox failed.',
        {
          provider: 'vercel',
          sandboxId: previousSandbox.sandboxId,
          replacementSandboxId: sandbox.sandboxId,
          cause: providerErrorMessage(error),
          ...(replacementStopCause ? { replacementStopCause } : {}),
        },
      );
    }

    this.bindRestoredSandbox(
      sandbox,
      snapshotId,
      options.snapshotFreshAfterRestore,
    );
  }

  private async recoverSandboxAfterSnapshotRestoreFailure(
    snapshotId: string,
    restoreError: unknown,
  ): Promise<void> {
    try {
      await this.replaceSandboxFromSnapshot(snapshotId, {
        snapshotFreshAfterRestore: true,
        ignorePreviousStopFailure: true,
      });
    } catch (recoveryError) {
      throw new SandboxProviderError(
        'Vercel snapshot persistence captured a snapshot, but restoring the live session failed and recovery also failed.',
        {
          provider: 'vercel',
          sandboxId: this.state.sandboxId,
          snapshotId,
          cause: providerErrorMessage(restoreError),
          recoveryCause: providerErrorMessage(recoveryError),
        },
      );
    }
  }

  private async resolveSnapshotCredentials(): Promise<NormalizedVercelCredentials> {
    return selectVercelSessionCredentials(this.state, this.credentials);
  }

  private async createAndPrepareSandboxFromSnapshot(
    snapshotId: string,
    credentials: NormalizedVercelCredentials,
  ): Promise<VercelSandboxInstance> {
    const sandbox = await this.createSandboxFromSnapshot(
      snapshotId,
      credentials,
    );
    const resolvedCredentials = selectVercelSessionCredentials(
      this.state,
      this.credentials,
    );

    const replacementSession = new VercelSandboxSession({
      credentials: resolvedCredentials,
      sandbox,
      archiveLimits: this.getArchiveLimits(),
      state: {
        ...this.state,
        sandboxId: sandbox.sandboxId,
        snapshotId,
        snapshotSandboxId: undefined,
        snapshotSupported: supportsVercelSnapshot(sandbox),
        exposedPorts: undefined,
      },
    });
    try {
      await waitForVercelSandboxRunning(replacementSession);
      await replacementSession.prepareWorkspaceRoot();
    } catch (error) {
      try {
        await stopVercelSandbox(sandbox);
      } catch (stopError) {
        throw new UserError(
          `Failed to restore a Vercel sandbox from snapshot and stop the replacement sandbox. Restore error: ${providerErrorMessage(error)} Stop error: ${providerErrorMessage(stopError)}`,
        );
      }
      throw error;
    }

    return sandbox;
  }

  private async createSandboxFromSnapshot(
    snapshotId: string,
    credentials: NormalizedVercelCredentials,
  ): Promise<VercelSandboxInstance> {
    const Sandbox = await loadVercelSandboxClass();
    const authentication = await withProviderError(
      'VercelSandboxClient',
      'vercel',
      'restore snapshot',
      async () =>
        await runWithLegacyVercelAuthenticationFallback(
          this.state,
          credentials,
          async (resolvedCredentials) =>
            await Sandbox.create({
              ...resolvedCredentials,
              source: {
                type: 'snapshot',
                snapshotId,
              },
              ...(this.state.runtime ? { runtime: this.state.runtime } : {}),
              ...(this.state.resources
                ? { resources: this.state.resources }
                : {}),
              ...(this.state.configuredExposedPorts
                ? { ports: this.state.configuredExposedPorts }
                : {}),
              ...(typeof this.state.interactive === 'boolean'
                ? { interactive: this.state.interactive }
                : {}),
              ...(this.state.networkPolicy
                ? { networkPolicy: this.state.networkPolicy }
                : {}),
              ...(typeof this.state.timeoutMs === 'number'
                ? { timeout: this.state.timeoutMs }
                : {}),
              env: this.state.environment,
            }),
        ),
      { snapshotId },
    );
    applyVercelAuthentication(this.state, authentication);
    return authentication.value;
  }

  private bindRestoredSandbox(
    sandbox: VercelSandboxInstance,
    snapshotId: string,
    snapshotFreshAfterRestore?: boolean,
  ): void {
    this.sandbox = sandbox;
    this.resetKnownDirs();
    this.knownDirs.add(this.state.manifest.root);
    this.state.sandboxId = sandbox.sandboxId;
    this.state.snapshotId = snapshotId;
    this.state.snapshotSandboxId = snapshotFreshAfterRestore
      ? sandbox.sandboxId
      : undefined;
    this.state.snapshotSupported = supportsVercelSnapshot(sandbox);
    this.clearExposedPortCache();
  }

  private resetKnownDirs(): void {
    this.knownDirs.clear();
    this.pendingDirCreates.clear();
    this.knownDirs.add(DEFAULT_VERCEL_WORKSPACE_ROOT);
  }

  private markWorkspaceMutated(): void {
    if (this.state.workspacePersistence === 'snapshot') {
      this.state.snapshotSandboxId = undefined;
    }
  }

  private clearExposedPortCache(): void {
    this.state.exposedPorts = undefined;
  }

  private async ensureDir(path: string): Promise<void> {
    if (path === '/' || path === '.' || this.knownDirs.has(path)) {
      return;
    }
    const pending = this.pendingDirCreates.get(path);
    if (pending) {
      await pending;
      return;
    }

    const create = (async () => {
      const parent = posixDirname(path);
      if (parent !== path && parent !== '/' && parent !== '.') {
        await this.ensureDir(parent);
      }

      try {
        await this.sandbox.mkDir(path);
      } catch (error) {
        if (!isVercelAlreadyExistsError(error)) {
          throw error;
        }
      }

      this.knownDirs.add(path);
    })();
    this.pendingDirCreates.set(path, create);
    try {
      await create;
    } finally {
      this.pendingDirCreates.delete(path);
    }
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    return await this.runWorkspaceOperation(
      async () => await this.runRemoteCommandDirect(command, options),
    );
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    await this.runWorkspaceOperation(async () => {
      await this.ensureDir(path);
    });
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    return await this.runWorkspaceOperation(
      async () => await this.readRemoteFileDirect(path),
    );
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.runWorkspaceOperation(async () => {
      await this.writeRemoteFileDirect(path, content);
    });
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    await this.runWorkspaceOperation(async () => {
      const result = await this.runRemoteCommandDirect(
        `rm -f -- ${shellQuote(path)}`,
        {
          kind: 'manifest',
          workdir: this.state.manifest.root,
        },
      );
      if (result.status !== 0) {
        throw new SandboxProviderError(
          'VercelSandboxClient failed to delete path.',
          {
            provider: 'vercel',
            operation: 'delete path',
            sandboxId: this.state.sandboxId,
            path,
            exitCode: result.status,
            output: result.stdout ?? '',
          },
        );
      }
    });
  }
}

/**
 * @see {@link https://vercel.com/docs/vercel-sandbox | Vercel Sandbox overview}.
 * @see {@link https://vercel.com/docs/vercel-sandbox/sdk-reference | Sandbox SDK reference}.
 * @see {@link https://vercel.com/docs/vercel-sandbox/working-with-sandbox | Working with Sandbox examples}.
 */
export class VercelSandboxClient implements SandboxClient<
  VercelSandboxClientOptions,
  VercelSandboxSessionState
> {
  readonly backendId = 'vercel';
  private readonly options: VercelSandboxClientOptions;

  constructor(options: VercelSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<VercelSandboxClientOptions> | Manifest,
    manifestOptions?: VercelSandboxClientOptions,
  ): Promise<VercelSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported('VercelSandboxClient', createArgs.snapshot);
    const manifest = createArgs.manifest;
    const resolvedOptions = {
      ...this.options,
      ...createArgs.options,
    };
    const resolvedManifest = resolveManifestRoot(manifest);
    assertSandboxManifestMetadataSupported(
      'VercelSandboxClient',
      resolvedManifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    assertVercelMountManifest(
      resolvedManifest,
      resolvedOptions.allowS3CredentialExposure === true,
    );
    const persistentManifest = sanitizeVercelMountManifest(resolvedManifest);

    return await withSandboxSpan(
      'sandbox.start',
      {
        backend_id: this.backendId,
      },
      async () => {
        const Sandbox = await loadVercelSandboxClass();
        const environment = await materializeEnvironment(
          resolvedManifest,
          resolvedOptions.env,
        );
        const credentials = resolveVercelCredentials(
          createArgs.options ?? {},
          this.options,
        );
        const sandbox = await withProviderError(
          'VercelSandboxClient',
          'vercel',
          'create sandbox',
          async () =>
            await Sandbox.create({
              ...credentials,
              ...(resolvedOptions.runtime
                ? { runtime: resolvedOptions.runtime }
                : {}),
              ...(resolvedOptions.resources
                ? { resources: resolvedOptions.resources }
                : {}),
              ...(resolvedOptions.exposedPorts
                ? { ports: resolvedOptions.exposedPorts }
                : {}),
              ...(typeof resolvedOptions.interactive === 'boolean'
                ? { interactive: resolvedOptions.interactive }
                : {}),
              ...(resolvedOptions.networkPolicy
                ? { networkPolicy: resolvedOptions.networkPolicy }
                : {}),
              ...(typeof resolvedOptions.timeoutMs === 'number'
                ? { timeout: resolvedOptions.timeoutMs }
                : {}),
              env: environment,
            }),
          { runtime: resolvedOptions.runtime },
        );

        const session = new VercelSandboxSession({
          sandbox,
          credentials,
          concurrencyLimits: createArgs.concurrencyLimits,
          archiveLimits: createArgs.archiveLimits,
          state: {
            manifest: persistentManifest,
            sandboxId: sandbox.sandboxId,
            authenticationMode: credentials.token ? 'explicit' : 'sdk',
            ...credentials,
            runtime: resolvedOptions.runtime,
            resources: resolvedOptions.resources,
            configuredExposedPorts: resolvedOptions.exposedPorts,
            interactive: resolvedOptions.interactive,
            networkPolicy: resolvedOptions.networkPolicy,
            timeoutMs: resolvedOptions.timeoutMs,
            workspacePersistence: resolvedOptions.workspacePersistence ?? 'tar',
            snapshotExpirationMs: resolvedOptions.snapshotExpirationMs,
            environment,
            snapshotSupported: supportsVercelSnapshot(sandbox),
          },
        });

        try {
          await waitForVercelSandboxRunning(session);
          await session.prepareWorkspaceRoot();
          await session.materializeInitialManifest(resolvedManifest);
        } catch (error) {
          try {
            await stopVercelSandbox(sandbox);
          } catch (stopError) {
            throw new UserError(
              `Failed to apply a Vercel sandbox manifest and stop the sandbox. Manifest error: ${providerErrorMessage(error)} Stop error: ${providerErrorMessage(stopError)}`,
            );
          }
          throw error;
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: VercelSandboxSessionState,
    options?: SandboxSessionSerializationOptions,
  ): Promise<Record<string, unknown>> {
    state.manifest = sanitizeVercelMountManifest(state.manifest);
    const credentials = selectVercelSessionCredentials(state, this.options);
    applyVercelCredentials(state, credentials);
    if (
      !hasVercelMounts(state.manifest) &&
      state.workspacePersistence === 'snapshot' &&
      state.snapshotSupported !== false &&
      state.snapshotSandboxId !== state.sandboxId &&
      (options?.reuseLiveSession === false || options?.willCloseAfterSerialize)
    ) {
      await captureVercelSnapshot(state, {
        options: {
          ...credentials,
        },
      });
    }
    return serializeRemoteSandboxSessionState({
      ...state,
      environment: hasVercelMounts(state.manifest)
        ? omitVercelS3CredentialEnvironment(state.environment)
        : state.environment,
    });
  }

  canPersistOwnedSessionState(state: VercelSandboxSessionState): boolean {
    return (
      !hasVercelMounts(state.manifest) &&
      state.workspacePersistence === 'snapshot' &&
      state.snapshotSupported !== false
    );
  }

  canReusePreservedOwnedSession(state: VercelSandboxSessionState): boolean {
    if (hasVercelMounts(state.manifest)) {
      return true;
    }
    return (
      state.workspacePersistence !== 'snapshot' ||
      state.snapshotSupported === false
    );
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<VercelSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    const manifest = resolveManifestRoot(baseState.manifest);
    assertSandboxManifestMetadataSupported(
      'VercelSandboxClient',
      manifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    const deserializedState: VercelSandboxSessionState = {
      ...state,
      ...baseState,
      manifest: sanitizeVercelMountManifest(manifest),
      sandboxId: readString(state, 'sandboxId'),
      authenticationMode: readVercelAuthenticationMode(state),
      workspacePersistence:
        (state.workspacePersistence as
          VercelWorkspacePersistence | undefined) ?? 'tar',
      projectId: readOptionalString(state, 'projectId'),
      teamId: readOptionalString(state, 'teamId'),
      token: readOptionalString(state, 'token'),
      runtime: readOptionalString(state, 'runtime'),
      resources: readOptionalRecord(state.resources),
      configuredExposedPorts: readOptionalNumberArray(
        state.configuredExposedPorts,
      ),
      interactive: readOptionalBoolean(state, 'interactive'),
      networkPolicy: readOptionalRecord(state.networkPolicy),
      timeoutMs: readOptionalNumber(state, 'timeoutMs'),
      snapshotExpirationMs: readOptionalNumber(state, 'snapshotExpirationMs'),
      snapshotId: readOptionalString(state, 'snapshotId'),
      snapshotSandboxId: readOptionalString(state, 'snapshotSandboxId'),
      snapshotSupported: readOptionalBoolean(state, 'snapshotSupported'),
    };
    applyVercelCredentials(
      deserializedState,
      normalizeVercelCredentials(deserializedState),
    );
    return deserializedState;
  }

  async resume(
    state: VercelSandboxSessionState,
  ): Promise<VercelSandboxSession> {
    if (hasVercelMounts(state.manifest)) {
      // This is an intentional lifecycle boundary, not a missing restore path.
      // A fresh create supplies trusted credentials and mount configuration.
      throw new SandboxUnsupportedFeatureError(
        'VercelSandboxClient does not resume sessions that contain S3 mounts. Create a fresh sandbox with the trusted mount manifest instead.',
        {
          provider: 'vercel',
          feature: 'resume with mounts',
        },
      );
    }
    const Sandbox = await loadVercelSandboxClass();
    const credentials = selectVercelSessionCredentials(state, this.options);
    const resumeFromSnapshot = hasFreshVercelSnapshot(state);
    const authentication = resumeFromSnapshot
      ? await withProviderError(
          'VercelSandboxClient',
          'vercel',
          'resume sandbox from snapshot',
          async () =>
            await runWithLegacyVercelAuthenticationFallback(
              state,
              credentials,
              async (resolvedCredentials) =>
                await Sandbox.create({
                  ...resolvedCredentials,
                  source: {
                    type: 'snapshot',
                    snapshotId: state.snapshotId!,
                  },
                  ...(state.runtime ? { runtime: state.runtime } : {}),
                  ...(state.resources ? { resources: state.resources } : {}),
                  ...(state.configuredExposedPorts
                    ? { ports: state.configuredExposedPorts }
                    : {}),
                  ...(state.interactive !== undefined
                    ? { interactive: state.interactive }
                    : {}),
                  ...(state.networkPolicy
                    ? { networkPolicy: state.networkPolicy }
                    : {}),
                  ...(state.timeoutMs !== undefined
                    ? { timeout: state.timeoutMs }
                    : {}),
                  env: state.environment,
                }),
            ),
          { snapshotId: state.snapshotId, sandboxId: state.sandboxId },
        )
      : await withProviderError(
          'VercelSandboxClient',
          'vercel',
          'resume sandbox',
          async () =>
            await runWithLegacyVercelAuthenticationFallback(
              state,
              credentials,
              async (resolvedCredentials) =>
                await Sandbox.get({
                  sandboxId: state.sandboxId,
                  ...resolvedCredentials,
                }),
            ),
          { sandboxId: state.sandboxId },
        );
    applyVercelAuthentication(state, authentication);
    const sandbox = authentication.value;
    const resolvedCredentials = authentication.credentials;

    const session = new VercelSandboxSession({
      credentials: resolvedCredentials,
      archiveLimits: this.options.archiveLimits,
      state: resumeFromSnapshot
        ? {
            ...state,
            sandboxId: sandbox.sandboxId,
            snapshotSandboxId: undefined,
            snapshotSupported: supportsVercelSnapshot(sandbox),
            exposedPorts: undefined,
          }
        : {
            ...state,
            snapshotSupported: supportsVercelSnapshot(sandbox),
          },
      sandbox,
    });
    try {
      await waitForVercelSandboxRunning(session);
      await session.prepareWorkspaceRoot();
    } catch (error) {
      if (!resumeFromSnapshot) {
        throw error;
      }
      try {
        await stopVercelSandbox(sandbox);
      } catch (stopError) {
        throw new UserError(
          `Failed to resume a Vercel sandbox from snapshot and stop the replacement sandbox. Resume error: ${providerErrorMessage(error)} Stop error: ${providerErrorMessage(stopError)}`,
        );
      }
      throw error;
    }
    return session;
  }
}

async function loadVercelSandboxClass(): Promise<VercelSandboxClass> {
  try {
    const { Sandbox } = await import('@vercel/sandbox');
    if (!Sandbox) {
      throw new Error('Missing Sandbox export from @vercel/sandbox.');
    }
    return adaptVercelSandboxClass(Sandbox);
  } catch (error) {
    throw new UserError(
      `Vercel sandbox support requires the optional \`@vercel/sandbox\` package. Install it before using Vercel-backed sandbox examples. ${(error as Error).message}`,
    );
  }
}

function adaptVercelSandboxClass(
  Sandbox: VercelSdkSandboxClass,
): VercelSandboxClass {
  return {
    create: async (params) =>
      adaptVercelSandbox(await Sandbox.create(params as VercelSdkCreateParams)),
    get: async (params) =>
      adaptVercelSandbox(await Sandbox.get(params as VercelSdkGetParams)),
  };
}

function adaptVercelSandbox(sandbox: VercelSdkSandbox): VercelSandboxInstance {
  const optionalSandbox = sandbox as VercelSdkSandbox & {
    domain?: (port: number) => string;
    stop?: () => Promise<unknown>;
    snapshot?: (params?: {
      expiration?: number;
    }) => Promise<{ snapshotId?: string }>;
  };
  const adapted: VercelSandboxInstance = {
    sandboxId: sandbox.sandboxId,
    runCommand: async (params) =>
      adaptVercelCommandFinished(
        await sandbox.runCommand(params as VercelSdkRunCommandParams),
      ),
    mkDir: async (path) => await sandbox.mkDir(path),
    readFileToBuffer: async (file) => await sandbox.readFileToBuffer(file),
    writeFiles: async (files) => await sandbox.writeFiles(files),
  };
  if (typeof optionalSandbox.domain === 'function') {
    const domain = optionalSandbox.domain.bind(sandbox);
    adapted.domain = (port) => domain(port);
  }
  if (typeof optionalSandbox.stop === 'function') {
    const stop = optionalSandbox.stop.bind(sandbox);
    adapted.stop = async () => await stop();
  }
  if (typeof optionalSandbox.snapshot === 'function') {
    const snapshotFn = optionalSandbox.snapshot.bind(sandbox);
    adapted.snapshot = async (params) => {
      const snapshot = await snapshotFn(params);
      return { snapshotId: snapshot.snapshotId };
    };
  }
  return adapted;
}

function adaptVercelCommandFinished(
  command: import('@vercel/sandbox').CommandFinished,
): VercelCommandFinishedLike {
  return {
    exitCode: command.exitCode,
    output: async (stream, options) => await command.output(stream, options),
  };
}

function assertVercelMountManifest(
  manifest: Manifest,
  allowS3CredentialExposure: boolean,
): void {
  const mountPaths: string[] = [];
  for (const {
    entry,
    mountPath,
  } of manifest.mountTargetsForMaterialization()) {
    validateVercelCloudBucketMountEntry(entry);
    const absoluteMountPath = resolveSandboxAbsolutePath(
      manifest.root,
      mountPath,
    );
    const relativeMountPath = resolveSandboxRelativePath(
      manifest.root,
      absoluteMountPath,
    );
    if (!relativeMountPath) {
      throw new SandboxMountError(
        'VercelSandboxClient does not support mounting an S3 bucket at the workspace root.',
        {
          provider: 'vercel',
          mountPath: absoluteMountPath,
          root: manifest.root,
        },
        'mount_config_invalid',
      );
    }
    assertNoOverlappingMountPath(mountPaths, absoluteMountPath);
    mountPaths.push(absoluteMountPath);

    if (
      isVercelCloudBucketMountEntry(entry) &&
      hasVercelS3Credentials(entry) &&
      !allowS3CredentialExposure
    ) {
      throw new SandboxMountError(
        'VercelSandboxClient requires allowS3CredentialExposure=true before forwarding S3 credentials into the remote sandbox.',
        {
          provider: 'vercel',
          mountPath: absoluteMountPath,
        },
        'mount_config_invalid',
      );
    }
  }
}

function sanitizeVercelMountManifest(manifest: Manifest): Manifest {
  const sanitized = cloneManifestWithRoot(manifest, manifest.root);
  const mountTargets = sanitized.mountTargetsForMaterialization();
  for (const { entry } of mountTargets) {
    if (entry.type !== 's3_mount') {
      continue;
    }
    delete entry.accessKeyId;
    delete entry.secretAccessKey;
    delete entry.sessionToken;
    // Persist topology only for exclusion and rejection checks. It is never
    // authoritative input for remounting a resumed session.
    entry.ephemeral = true;
  }
  if (mountTargets.length > 0) {
    for (const name of VERCEL_S3_CREDENTIAL_ENVIRONMENT_NAMES) {
      const environment = sanitized.environment[name];
      if (environment) {
        sanitized.environment[name] = new Environment({
          ...environment.init(),
          ephemeral: true,
        });
      }
    }
  }
  return sanitized;
}

function hasVercelMounts(manifest: Manifest): boolean {
  return manifest.mountTargetsForMaterialization().length > 0;
}

function omitVercelS3CredentialEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  const serializedEnvironment = { ...environment };
  for (const name of VERCEL_S3_CREDENTIAL_ENVIRONMENT_NAMES) {
    delete serializedEnvironment[name];
  }
  return serializedEnvironment;
}

function assertNoOverlappingMountPath(
  existingMountPaths: Iterable<string>,
  mountPath: string,
): void {
  for (const existingPath of existingMountPaths) {
    if (
      existingPath === mountPath ||
      existingPath.startsWith(`${mountPath}/`) ||
      mountPath.startsWith(`${existingPath}/`)
    ) {
      throw new SandboxMountError(
        'VercelSandboxClient does not support overlapping S3 mount paths.',
        {
          provider: 'vercel',
          mountPath,
          existingMountPath: existingPath,
        },
        'mount_config_invalid',
      );
    }
  }
}

function resolveManifestRoot(manifest: Manifest): Manifest {
  if (manifest.root === '/workspace') {
    return cloneManifestWithRoot(manifest, DEFAULT_VERCEL_WORKSPACE_ROOT);
  }

  if (
    manifest.root === DEFAULT_VERCEL_WORKSPACE_ROOT ||
    manifest.root.startsWith(`${DEFAULT_VERCEL_WORKSPACE_ROOT}/`)
  ) {
    return manifest;
  }

  throw new UserError(
    `Vercel sandboxes require manifest.root to stay within "${DEFAULT_VERCEL_WORKSPACE_ROOT}".`,
  );
}

function normalizeVercelCredentials(
  options: VercelCredentials,
): NormalizedVercelCredentials {
  if (options.projectId && options.teamId && options.token) {
    return {
      projectId: options.projectId,
      teamId: options.teamId,
      token: options.token,
    } satisfies CompleteVercelCredentials;
  }
  return {};
}

function resolveVercelCredentials(
  ...optionLayers: VercelCredentials[]
): NormalizedVercelCredentials {
  const env = loadEnv();
  const layers = [
    ...optionLayers,
    {
      projectId: env.VERCEL_PROJECT_ID,
      teamId: env.VERCEL_TEAM_ID,
      token: env.VERCEL_TOKEN,
    },
  ];
  return normalizeVercelCredentials({
    projectId: resolveVercelCredentialField('projectId', layers),
    teamId: resolveVercelCredentialField('teamId', layers),
    token: resolveVercelCredentialField('token', layers),
  });
}

function resolveVercelCredentialField(
  field: keyof VercelCredentials,
  optionLayers: VercelCredentials[],
): string | undefined {
  for (const options of optionLayers) {
    const value = options[field];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function selectVercelCredentials(
  preferred: VercelCredentials,
  ...fallbackLayers: VercelCredentials[]
): NormalizedVercelCredentials {
  const preferredCredentials = normalizeVercelCredentials(preferred);
  return preferredCredentials.token
    ? preferredCredentials
    : resolveVercelCredentials(...fallbackLayers);
}

function selectVercelSessionCredentials(
  state: VercelSandboxSessionState,
  ...fallbackLayers: VercelCredentials[]
): NormalizedVercelCredentials {
  if (state.authenticationMode === 'sdk') {
    return {};
  }
  return selectVercelCredentials(state, ...fallbackLayers);
}

type VercelAuthenticationResult<T> = {
  value: T;
  credentials: NormalizedVercelCredentials;
  authenticationMode?: VercelSandboxSessionState['authenticationMode'];
};

async function runWithLegacyVercelAuthenticationFallback<T>(
  state: VercelSandboxSessionState,
  credentials: NormalizedVercelCredentials,
  operation: (credentials: NormalizedVercelCredentials) => Promise<T>,
): Promise<VercelAuthenticationResult<T>> {
  const serializedCredentials = normalizeVercelCredentials(state);
  const hasLegacySerializedCredentials =
    state.authenticationMode === undefined &&
    serializedCredentials.token !== undefined;
  const authenticationMode =
    state.authenticationMode ??
    (hasLegacySerializedCredentials
      ? undefined
      : credentials.token
        ? 'explicit'
        : 'sdk');

  try {
    return {
      value: await operation(credentials),
      credentials,
      authenticationMode,
    };
  } catch (error) {
    if (!hasLegacySerializedCredentials || !isVercelUnauthorizedError(error)) {
      throw error;
    }
  }

  const delegatedCredentials = {} satisfies NormalizedVercelCredentials;
  return {
    value: await operation(delegatedCredentials),
    credentials: delegatedCredentials,
    authenticationMode: 'sdk',
  };
}

function isVercelUnauthorizedError(error: unknown): boolean {
  const details = providerErrorDetails(error);
  return [details.status, details.httpStatus, details.responseStatus].some(
    (status) => status === 401 || status === '401',
  );
}

function applyVercelAuthentication<T>(
  state: VercelSandboxSessionState,
  authentication: VercelAuthenticationResult<T>,
): void {
  applyVercelCredentials(state, authentication.credentials);
  if (authentication.authenticationMode === undefined) {
    delete state.authenticationMode;
  } else {
    state.authenticationMode = authentication.authenticationMode;
  }
}

function applyVercelCredentials(
  state: Pick<VercelSandboxSessionState, 'projectId' | 'teamId' | 'token'>,
  credentials: VercelCredentials,
): void {
  delete state.projectId;
  delete state.teamId;
  delete state.token;
  const normalized = normalizeVercelCredentials(credentials);
  if (normalized.token) {
    state.projectId = normalized.projectId;
    state.teamId = normalized.teamId;
    state.token = normalized.token;
  }
}

function readVercelAuthenticationMode(
  state: Record<string, unknown>,
): VercelSandboxSessionState['authenticationMode'] {
  const mode = readOptionalString(state, 'authenticationMode');
  if (mode === undefined || mode === 'explicit' || mode === 'sdk') {
    return mode;
  }
  throw new UserError(
    'Vercel sandbox session authenticationMode must be "explicit" or "sdk".',
  );
}

async function captureVercelSnapshot(
  state: VercelSandboxSessionState,
  args: {
    sandbox?: VercelSandboxInstance;
    options?: Pick<
      VercelSandboxClientOptions,
      'projectId' | 'teamId' | 'token'
    >;
  } = {},
): Promise<void> {
  if (state.workspacePersistence !== 'snapshot') {
    return;
  }

  let sandbox = args.sandbox;
  if (!sandbox) {
    const credentials = selectVercelSessionCredentials(
      state,
      args.options ?? {},
    );
    const authentication = await withProviderError(
      'VercelSandboxClient',
      'vercel',
      'look up sandbox for snapshot',
      async () =>
        await runWithLegacyVercelAuthenticationFallback(
          state,
          credentials,
          async (resolvedCredentials) =>
            await (
              await loadVercelSandboxClass()
            ).get({
              sandboxId: state.sandboxId,
              ...resolvedCredentials,
            }),
        ),
      { sandboxId: state.sandboxId },
    );
    applyVercelAuthentication(state, authentication);
    sandbox = authentication.value;
  }
  state.snapshotSupported = supportsVercelSnapshot(sandbox);
  if (!state.snapshotSupported) {
    throw new UserError(
      'Vercel snapshot persistence requires @vercel/sandbox snapshot support.',
    );
  }

  const snapshot = await withSandboxSpan(
    'sandbox.snapshot',
    {
      backend_id: 'vercel',
      sandbox_id: state.sandboxId,
    },
    async () =>
      await withProviderError(
        'VercelSandboxClient',
        'vercel',
        'capture snapshot',
        async () =>
          await sandbox.snapshot!({
            expiration: state.snapshotExpirationMs,
          }),
        { sandboxId: state.sandboxId },
      ),
  );
  if (!snapshot.snapshotId) {
    throw new UserError(
      'Vercel snapshot persistence did not return a snapshotId.',
    );
  }
  state.snapshotId = snapshot.snapshotId;
  state.snapshotSandboxId = sandbox.sandboxId;
}

function supportsVercelSnapshot(sandbox: VercelSandboxInstance): boolean {
  return typeof sandbox.snapshot === 'function';
}

function hasFreshVercelSnapshot(state: VercelSandboxSessionState): boolean {
  return Boolean(
    state.snapshotId && state.snapshotSandboxId === state.sandboxId,
  );
}

async function stopVercelSandbox(
  sandbox: VercelSandboxInstance,
): Promise<void> {
  if (!sandbox.stop) {
    return;
  }

  await withSandboxSpan(
    'sandbox.stop',
    {
      backend_id: 'vercel',
      sandbox_id: sandbox.sandboxId,
    },
    async () => {
      await sandbox.stop!();
    },
  );
}

async function waitForVercelSandboxRunning(
  session: VercelSandboxSession,
  timeoutMs: number = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await session.running()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new SandboxLifecycleError(
    `Vercel sandbox ${session.state.sandboxId} did not become runnable within ${timeoutMs}ms.`,
    {
      provider: 'vercel',
      sandboxId: session.state.sandboxId,
      timeoutMs,
    },
  );
}

function isVercelSandboxAlreadyStoppedError(error: unknown): boolean {
  if (isProviderSandboxNotFoundError(error)) {
    return true;
  }

  const message = providerErrorMessage(error);
  return (
    /\b(sandbox|sandbox instance|instance)\b.*\b(already\s+)?(stopped|terminated|not running)\b/iu.test(
      message,
    ) ||
    /\b(already\s+)?(stopped|terminated|not running)\b.*\b(sandbox|sandbox instance|instance)\b/iu.test(
      message,
    )
  );
}

function assertFilesystemRunAs(runAs?: string): void {
  if (runAs && runAs !== 'root') {
    assertRunAsUnsupported('VercelSandboxClient', runAs);
  }
  if (runAs === 'root') {
    throw new SandboxUnsupportedFeatureError(
      'VercelSandboxClient does not support runAs for filesystem operations.',
      {
        provider: 'vercel',
        feature: 'runAs',
      },
    );
  }
}

function isVercelAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const json = 'json' in error ? error.json : undefined;
  if (!json || typeof json !== 'object') {
    return false;
  }

  const payload = 'error' in json ? json.error : undefined;
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const code = 'code' in payload ? payload.code : undefined;
  const message = 'message' in payload ? payload.message : undefined;
  return (
    code === 'file_error' &&
    typeof message === 'string' &&
    message.includes('File exists')
  );
}
