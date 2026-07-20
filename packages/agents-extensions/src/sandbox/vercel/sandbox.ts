import { UserError } from '@openai/agents-core';
import { loadEnv } from '@openai/agents-core/_shims';
import {
  isMount,
  Manifest,
  SandboxLifecycleError,
  SandboxMountError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type Mount,
  type MaterializeEntryArgs,
  type S3Mount,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxArchiveLimits,
  type SandboxConcurrencyLimits,
  type SandboxSessionSerializationOptions,
  type SandboxSessionState,
  type WorkspaceArchiveData,
  type WorkspaceArchiveOptions,
  type TypedMount,
} from '@openai/agents-core/sandbox';
import {
  assertCoreSnapshotUnsupported,
  assertSandboxManifestMetadataSupported,
  assertRunAsUnsupported,
  cloneManifestWithRoot,
  cloneManifestWithoutMountEntries,
  deserializeRemoteSandboxSessionStateValues,
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
  materializeEnvironment,
  MOUNT_MANIFEST_METADATA_SUPPORT,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  posixDirname,
  hydrateRemoteWorkspaceTar,
  persistRemoteWorkspaceTar,
  providerErrorDetails,
  providerErrorMessage,
  shellQuote,
  serializeRemoteSandboxSessionState,
  toUint8Array,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecord,
  readOptionalString,
  readString,
  resolveSandboxRelativePath,
  validateWorkspaceTarArchive,
  validateRemoteSandboxPathForManifest,
  isProviderSandboxNotFoundError,
  withProviderError,
  withSandboxSpan,
  RemoteSandboxSessionBase,
  type RemoteManifestWriter,
  type RemoteWorkspaceTarIo,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../shared';
import {
  isVercelCloudBucketMounted,
  isVercelCloudBucketMountEntry,
  listVercelCloudBucketMountPaths,
  mountVercelCloudBucket,
  normalizeVercelS3MountCredentials,
  readVercelS3MountCredentials,
  unmountVercelCloudBucket,
  type VercelMountCommand,
  type VercelS3MountConfiguration,
  type VercelS3MountConfigurationResolver,
  type VercelS3MountCredentialResolver,
  type VercelS3MountCredentials,
} from './mounts';

const DEFAULT_VERCEL_WORKSPACE_ROOT = '/vercel/sandbox';
const TRUSTED_VERCEL_MOUNT_COMMAND_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ISOLATED_VERCEL_MOUNT_COMMAND_LABEL = 'vercel-sandbox-mount-command';
const VERCEL_MOUNT_LAUNCHER_ENVIRONMENT_KEYS = [
  'BASHOPTS',
  'BASH_ENV',
  'CDPATH',
  'ENV',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
  'IFS',
  'LD_AUDIT',
  'LD_DEBUG',
  'LD_DEBUG_OUTPUT',
  'LD_DYNAMIC_WEAK',
  'LD_HWCAP_MASK',
  'LD_LIBRARY_PATH',
  'LD_ORIGIN_PATH',
  'LD_PRELOAD',
  'LD_PROFILE',
  'LD_SHOW_AUXV',
  'LD_USE_LOAD_BIAS',
  'LOCPATH',
  'NLSPATH',
  'PS4',
  'SHELLOPTS',
  'TMOUT',
] as const;
const S3_CREDENTIAL_REFRESH_MAX_LEAD_MS = 60_000;
const S3_CREDENTIAL_REFRESH_RETRY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
   * Explicitly acknowledges that AWS credentials supplied to Mountpoint can be
   * extracted by code running in a Vercel sandbox because workloads have sudo
   * access. Enable this only for short-lived credentials whose IAM policy is
   * restricted to the configured bucket, prefix, and read/write mode.
   */
  allowS3CredentialExposure?: boolean;
  /**
   * Resolves S3 mount credentials from current trusted configuration. Resolved
   * credentials are kept in memory and are never serialized into session state.
   * Temporary credentials with an `expiration` are refreshed before expiry.
   * Configure this resolver again when resuming a serialized session that
   * requires explicit S3 credentials. Returning explicit credentials also
   * requires `allowS3CredentialExposure`.
   */
  resolveS3MountCredentials?: VercelS3MountCredentialResolver;
  /**
   * Resolves the complete S3 mount configuration from current trusted
   * configuration. This resolver is required when resuming serialized
   * sessions with S3 mounts because persisted mount metadata is untrusted. The
   * returned array must contain the complete current mount set, including
   * mounts missing from persisted state.
   */
  resolveS3MountConfiguration?: VercelS3MountConfigurationResolver;
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
  mountStateUncertainCommand?: string;
}

export class VercelSandboxSession extends RemoteSandboxSessionBase<VercelSandboxSessionState> {
  private sandbox: VercelSandboxInstance;
  private readonly activeMounts = new Map<string, S3Mount>();
  private readonly detachedMounts = new Map<string, S3Mount>();
  private readonly inlineMountCredentials: Map<
    string,
    VercelS3MountCredentials
  >;
  private readonly resolveS3MountCredentials?: VercelS3MountCredentialResolver;
  private readonly resolveS3MountConfiguration?: VercelS3MountConfigurationResolver;
  private readonly allowS3CredentialExposure: boolean;
  private mountLifecycleTail: Promise<void> = Promise.resolve();
  private credentialRefreshTimer?: ReturnType<typeof setTimeout>;
  private credentialRefreshGeneration = 0;
  private remoteOperationsSuspended = false;
  private activeRemoteOperations = 0;
  private remoteOperationsDrained?: {
    promise: Promise<void>;
    resolve: () => void;
  };
  private readonly uncertainMountMutations = new Map<string, string>();
  private readonly pendingMountVerifications = new Set<string>();
  private protectedMountPathsDuringMaterialization?: ReadonlySet<string>;
  private readonly knownDirs: Set<string>;
  private readonly pendingDirCreates = new Map<string, Promise<void>>();
  private closePromise?: Promise<void>;
  private closeCompleted = false;
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
    inlineMountCredentials?: ReadonlyMap<string, VercelS3MountCredentials>;
    resolveS3MountCredentials?: VercelS3MountCredentialResolver;
    resolveS3MountConfiguration?: VercelS3MountConfigurationResolver;
    allowS3CredentialExposure?: boolean;
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
    this.inlineMountCredentials = new Map(args.inlineMountCredentials);
    this.resolveS3MountCredentials = args.resolveS3MountCredentials;
    this.resolveS3MountConfiguration = args.resolveS3MountConfiguration;
    this.allowS3CredentialExposure = args.allowS3CredentialExposure === true;
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
    this.assertMountsReady();
    return resolveManifestRoot(manifest);
  }

  protected override manifestMaterializationOptions() {
    return {
      materializeMount: this.materializeMountEntry.bind(this),
    };
  }

  protected override archiveIo(): RemoteWorkspaceTarIo {
    return {
      runCommand: async (command) => {
        const result = await this.execShell(
          command,
          this.state.manifest.root,
          undefined,
        );
        return {
          status: result.exitCode,
          stdout: result.output,
          stderr: '',
        };
      },
      readFile: async (path) => {
        const bytes = await this.sandbox.readFileToBuffer({ path });
        if (!bytes) {
          throw new UserError(`Sandbox path not found: ${path}`);
        }
        return await toUint8Array(bytes);
      },
      writeFile: async (path, content) => {
        const parent = posixDirname(path);
        if (parent !== '/' && parent !== '.') {
          await this.ensureDir(parent);
        }
        await this.sandbox.writeFiles([{ path, content }]);
      },
      mkdir: async (path) => await this.ensureDir(path),
    };
  }

  protected override manifestMetadataSupport() {
    return MOUNT_MANIFEST_METADATA_SUPPORT;
  }

  protected override manifestWriter(): RemoteManifestWriter {
    const writer = super.manifestWriter();
    return {
      mkdir: async (path) => {
        this.assertResolvedPathDoesNotOverlapActiveMounts(path);
        await writer.mkdir(path);
      },
      writeFile: async (path, content) => {
        this.assertResolvedPathDoesNotOverlapActiveMounts(path);
        await writer.writeFile(path, content);
      },
    };
  }

  protected override async beforeFilesystemMutation(): Promise<void> {
    this.assertMountsReady();
    this.markWorkspaceMutated();
  }

  protected override async beforeExecCommand(): Promise<void> {
    this.assertMountsReady();
    this.markWorkspaceMutated();
    this.resetKnownDirs();
  }

  protected override async beforeMaterializeEntry(
    args: MaterializeEntryArgs,
  ): Promise<void> {
    this.assertMountsReady();
    const manifest = new Manifest({
      root: this.state.manifest.root,
      entries: {
        [resolveSandboxRelativePath(this.state.manifest.root, args.path)]:
          structuredClone(args.entry),
      },
    });
    assertVercelManifestMountsSupported(manifest);
    await this.assertManifestMountTargetsDoNotCoverEntries(
      mergeManifestDelta(this.state.manifest, manifest),
    );
    await this.assertManifestDoesNotOverlapActiveMounts(manifest);
    this.markWorkspaceMutated();
  }

  protected override async beforeApplyManifest(
    manifest: Manifest,
  ): Promise<void> {
    this.assertMountsReady();
    assertVercelManifestMountsSupported(manifest);
    await this.assertManifestMountTargetsDoNotCoverEntries(
      mergeManifestDelta(this.state.manifest, manifest),
    );
    await this.assertManifestMountTargetsDistinct(manifest);
    await this.assertManifestDoesNotOverlapActiveMounts(manifest);
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
    this.assertMountsReady();
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
    await this.withMountLifecycleMutation(async () => {
      this.assertMountsReady();
      await this.assertManifestMountTargetsDoNotCoverEntries(manifest);
      await this.assertManifestMountTargetsDistinct(manifest);
      const mountPathsBefore = new Set(this.activeMounts.keys());
      const inlineCredentialsBefore = new Map(this.inlineMountCredentials);
      this.protectedMountPathsDuringMaterialization = mountPathsBefore;
      this.markWorkspaceMutated();
      try {
        await this.materializeManifestEntries(manifest);
      } catch (error) {
        await this.withRemoteOperationsSuspended(
          async () =>
            await this.rollbackNewMounts(
              mountPathsBefore,
              inlineCredentialsBefore,
              error,
            ),
        );
        throw error;
      } finally {
        this.state.manifest = stripVercelS3MountCredentialsFromManifest(
          this.state.manifest,
        );
        this.protectedMountPathsDuringMaterialization = undefined;
      }
    });
  }

  async prepareWorkspaceRoot(): Promise<void> {
    this.assertMountsReady();
    this.markWorkspaceMutated();
    await this.ensureDir(this.state.manifest.root);
  }

  override async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    await this.withMountLifecycleMutation(async () => {
      this.assertMountsReady();
      const mountPathsBefore = new Set(this.activeMounts.keys());
      const inlineCredentialsBefore = new Map(this.inlineMountCredentials);
      this.protectedMountPathsDuringMaterialization = mountPathsBefore;
      try {
        await super.materializeEntry(args);
      } catch (error) {
        await this.withRemoteOperationsSuspended(
          async () =>
            await this.rollbackNewMounts(
              mountPathsBefore,
              inlineCredentialsBefore,
              error,
            ),
        );
        throw error;
      } finally {
        this.state.manifest = stripVercelS3MountCredentialsFromManifest(
          this.state.manifest,
        );
        this.protectedMountPathsDuringMaterialization = undefined;
      }
    });
  }

  override async applyManifest(
    manifest: Manifest,
    runAs?: string,
  ): Promise<void> {
    await this.withMountLifecycleMutation(async () => {
      this.assertMountsReady();
      const mountPathsBefore = new Set(this.activeMounts.keys());
      const inlineCredentialsBefore = new Map(this.inlineMountCredentials);
      this.protectedMountPathsDuringMaterialization = mountPathsBefore;
      try {
        await super.applyManifest(manifest, runAs);
      } catch (error) {
        await this.withRemoteOperationsSuspended(
          async () =>
            await this.rollbackNewMounts(
              mountPathsBefore,
              inlineCredentialsBefore,
              error,
            ),
        );
        throw error;
      } finally {
        this.state.manifest = stripVercelS3MountCredentialsFromManifest(
          this.state.manifest,
        );
        this.protectedMountPathsDuringMaterialization = undefined;
      }
    });
  }

  async persistWorkspace(): Promise<Uint8Array> {
    return await this.withMountLifecycleMutation(async () => {
      return await this.withRemoteOperationsSuspended(async () => {
        this.assertMountsReady();
        if (
          this.state.workspacePersistence === 'snapshot' &&
          !this.nativeSnapshotRequiresTarFallback()
        ) {
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
            await this.recoverSandboxAfterSnapshotRestoreFailure(
              snapshotId,
              error,
            );
          }
          return encodeNativeSnapshotRef({
            provider: 'vercel',
            snapshotId,
          });
        }

        const resolvedMountPaths = [...this.activeMounts.keys()].map(
          (mountPath) =>
            resolveSandboxRelativePath(this.state.manifest.root, mountPath),
        );
        const oneFileSystem = resolvedMountPaths.length > 0;
        return await this.withDetachedMounts(
          async () =>
            await persistRemoteWorkspaceTar({
              providerName: this.providerName,
              manifest: this.state.manifest,
              io: this.archiveIo(),
              skipRelPaths: resolvedMountPaths,
              rootAnchoredExcludes: true,
              oneFileSystem,
            }),
        );
      });
    });
  }

  async hydrateWorkspace(
    data: WorkspaceArchiveData,
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    await this.withMountLifecycleMutation(async () => {
      await this.withRemoteOperationsSuspended(async () => {
        this.assertMountsReady();
        this.markWorkspaceMutated();
        const snapshotRef =
          this.state.workspacePersistence === 'snapshot'
            ? decodeNativeSnapshotRef(data)
            : undefined;
        if (snapshotRef?.provider === 'vercel') {
          await this.replaceSandboxFromSnapshot(snapshotRef.snapshotId);
          return;
        }

        const protectedMountPaths = new Set(
          [
            ...this.activeMounts.keys(),
            ...this.state.manifest
              .mountTargetsForMaterialization()
              .map(({ mountPath }) => mountPath),
          ].map((mountPath) =>
            resolveSandboxRelativePath(this.state.manifest.root, mountPath),
          ),
        );
        validateWorkspaceTarArchive(data, {
          allowSymlinks: false,
          rejectRelPaths: protectedMountPaths,
          archiveLimits:
            options.archiveLimits === undefined
              ? this.getArchiveLimits()
              : options.archiveLimits,
        });
        const oneFileSystem = this.activeMounts.size > 0;
        await this.withDetachedMounts(
          async () =>
            await hydrateRemoteWorkspaceTar({
              providerName: this.providerName,
              manifest: this.state.manifest,
              io: this.archiveIo(),
              data,
              archiveLimits:
                options.archiveLimits === undefined
                  ? this.getArchiveLimits()
                  : options.archiveLimits,
              oneFileSystem,
            }),
          { resolveDeclaredPaths: true },
        );
        this.resetKnownDirs();
        this.knownDirs.add(this.state.manifest.root);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closeCompleted) {
      return;
    }
    this.closePromise ??= this.withMountLifecycleMutation(
      async () => await this.closeOnce(),
    ).catch((error) => {
      if (!this.closeCompleted) {
        this.closePromise = undefined;
        this.scheduleCredentialRefresh();
      }
      throw error;
    });
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.clearCredentialRefreshTimer();
    if (!this.hasTrackedMountState()) {
      await this.closeOnceAfterOptionalMountDrain();
      return;
    }
    await this.withRemoteOperationsSuspended(
      async () => await this.closeOnceAfterOptionalMountDrain(),
    );
  }

  private hasTrackedMountState(): boolean {
    return (
      this.activeMounts.size > 0 ||
      this.detachedMounts.size > 0 ||
      this.pendingMountVerifications.size > 0 ||
      this.uncertainMountMutations.size > 0 ||
      this.state.mountStateUncertainCommand !== undefined
    );
  }

  private async closeOnceAfterOptionalMountDrain(): Promise<void> {
    let snapshotError: unknown;
    let mountError: unknown;
    let snapshotCapturedBeforeStop = false;
    if (
      this.state.workspacePersistence === 'snapshot' &&
      !this.nativeSnapshotRequiresTarFallback() &&
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
      await this.unmountActiveMounts();
    } catch (error) {
      mountError = error;
    }

    try {
      await stopVercelSandbox(this.sandbox);
      this.closeCompleted = true;
    } catch (stopError) {
      if (snapshotError || mountError) {
        throw new UserError(
          `Failed to prepare and stop a Vercel sandbox. ${snapshotError ? `Snapshot error: ${providerErrorMessage(snapshotError)} ` : ''}${mountError ? `Mount error: ${providerErrorMessage(mountError)} ` : ''}Stop error: ${providerErrorMessage(stopError)}`,
        );
      }
      if (snapshotCapturedBeforeStop && !mountError) {
        this.closeCompleted = true;
        return;
      }
      throw stopError;
    }
    if (snapshotError) {
      throw snapshotError;
    }
    if (mountError) {
      throw mountError;
    }
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  async delete(): Promise<void> {
    await this.close();
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
    const replacementSession = await this.createAndPrepareSandboxFromSnapshot(
      snapshotId,
      credentials,
      [...this.activeMounts.entries()].map(([mountPath, entry]) => ({
        mountPath,
        entry,
      })),
    );
    const sandbox = replacementSession.sandbox;

    try {
      await stopVercelSandbox(previousSandbox);
    } catch (error) {
      if (
        options.ignorePreviousStopFailure &&
        isVercelSandboxAlreadyStoppedError(error)
      ) {
        this.bindRestoredSession(
          replacementSession,
          snapshotId,
          options.snapshotFreshAfterRestore,
        );
        return;
      }
      replacementSession.clearCredentialRefreshTimer();
      let replacementUnmountError: unknown;
      try {
        await replacementSession.withRemoteOperationsSuspended(
          async () => await replacementSession.unmountActiveMounts(),
        );
      } catch (unmountError) {
        replacementUnmountError = unmountError;
      }
      let replacementStopError: unknown;
      try {
        await stopVercelSandbox(sandbox);
      } catch (stopError) {
        replacementStopError = stopError;
      }
      throw new SandboxProviderError(
        'Vercel snapshot restore created a replacement sandbox, but stopping the previous sandbox failed.',
        {
          provider: 'vercel',
          sandboxId: previousSandbox.sandboxId,
          replacementSandboxId: sandbox.sandboxId,
          cause: providerErrorMessage(error),
          ...(replacementUnmountError
            ? {
                replacementUnmountCause: providerErrorMessage(
                  replacementUnmountError,
                ),
                ...(replacementUnmountError instanceof SandboxMountError &&
                replacementUnmountError.details
                  ? {
                      replacementUnmountDetails:
                        replacementUnmountError.details,
                    }
                  : {}),
              }
            : {}),
          ...(replacementStopError
            ? {
                replacementStopCause:
                  providerErrorMessage(replacementStopError),
              }
            : {}),
        },
      );
    }

    this.bindRestoredSession(
      replacementSession,
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
    mounts: Array<{ mountPath: string; entry: S3Mount }>,
  ): Promise<VercelSandboxSession> {
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
      inlineMountCredentials: this.inlineMountCredentials,
      resolveS3MountCredentials: this.resolveS3MountCredentials,
      resolveS3MountConfiguration: this.resolveS3MountConfiguration,
      allowS3CredentialExposure: this.allowS3CredentialExposure,
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
      await replacementSession.rematerializeManifestMounts(mounts);
    } catch (error) {
      replacementSession.cancelCredentialRefreshForDiscard();
      try {
        await stopVercelSandbox(sandbox);
      } catch (stopError) {
        throw new SandboxLifecycleError(
          'VercelSandboxClient failed to restore a snapshot and stop the replacement sandbox.',
          {
            provider: 'vercel',
            sandboxId: sandbox.sandboxId,
            restoreCause: providerErrorMessage(error),
            ...(error instanceof SandboxMountError && error.details
              ? { restoreDetails: error.details }
              : {}),
            stopCause: providerErrorMessage(stopError),
          },
        );
      }
      throw error;
    }

    return replacementSession;
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

  private bindRestoredSession(
    replacementSession: VercelSandboxSession,
    snapshotId: string,
    snapshotFreshAfterRestore?: boolean,
  ): void {
    replacementSession.clearCredentialRefreshTimer();
    const sandbox = replacementSession.sandbox;
    this.sandbox = sandbox;
    this.state.mountStateUncertainCommand = undefined;
    this.activeMounts.clear();
    for (const [mountPath, entry] of replacementSession.activeMounts) {
      this.activeMounts.set(mountPath, entry);
    }
    this.detachedMounts.clear();
    for (const [mountPath, entry] of replacementSession.detachedMounts) {
      this.detachedMounts.set(mountPath, entry);
    }
    this.inlineMountCredentials.clear();
    for (const [
      mountPath,
      mountCredentials,
    ] of replacementSession.inlineMountCredentials) {
      this.inlineMountCredentials.set(mountPath, mountCredentials);
    }
    this.resetKnownDirs();
    this.knownDirs.add(this.state.manifest.root);
    this.state.sandboxId = sandbox.sandboxId;
    this.state.snapshotId = snapshotId;
    this.state.snapshotSandboxId = snapshotFreshAfterRestore
      ? sandbox.sandboxId
      : undefined;
    this.state.snapshotSupported = supportsVercelSnapshot(sandbox);
    this.clearExposedPortCache();
    this.scheduleCredentialRefresh();
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

  private nativeSnapshotRequiresTarFallback(): boolean {
    return vercelNativeSnapshotRequiresTarFallback(this.state.manifest);
  }

  private async assertManifestDoesNotOverlapActiveMounts(
    manifest: Manifest,
  ): Promise<void> {
    if (this.activeMounts.size === 0) {
      return;
    }
    const protectedMountPaths = [
      ...[...this.activeMounts.keys()].map((mountPath) => ({
        comparePath: mountPath,
        mountPath,
      })),
      ...this.state.manifest
        .mountTargetsForMaterialization()
        .flatMap(({ absolutePath, mountPath }) => [
          {
            comparePath: absolutePath,
            mountPath,
          },
          {
            comparePath: mountPath,
            mountPath,
          },
        ]),
    ];
    const candidatePaths = new Set(
      [...manifest.iterEntries()].map(({ absolutePath }) => absolutePath),
    );
    for (const { mountPath } of manifest.mountTargetsForMaterialization()) {
      candidatePaths.add(mountPath);
    }

    for (const candidatePath of candidatePaths) {
      const resolvedPath = await this.resolveRemotePath(candidatePath, {
        forWrite: true,
      });
      for (const { comparePath, mountPath } of protectedMountPaths) {
        if (
          !sandboxPathsOverlap(candidatePath, comparePath) &&
          !sandboxPathsOverlap(resolvedPath, comparePath)
        ) {
          continue;
        }
        throw new SandboxMountError(
          'VercelSandboxClient cannot materialize manifest entries that overlap an active S3 mount.',
          {
            provider: 'vercel',
            path: resolvedPath,
            mountPath,
          },
          'mount_config_invalid',
        );
      }
    }
  }

  private async assertManifestMountTargetsDistinct(
    manifest: Manifest,
  ): Promise<void> {
    const mountTargets = manifest.mountTargetsForMaterialization();
    const resolvedMountPaths = new Map<string, string>();
    for (const { mountPath } of mountTargets) {
      if (
        mountTargets.some(
          ({ mountPath: candidateParentPath }) =>
            candidateParentPath !== mountPath &&
            isSameOrDescendantSandboxPath(mountPath, candidateParentPath),
        )
      ) {
        continue;
      }
      const resolvedMountPath = await this.resolveRemotePath(mountPath, {
        forWrite: true,
      });
      this.assertResolvedMountPathSupported(resolvedMountPath);
      const duplicateMountPath = resolvedMountPaths.get(resolvedMountPath);
      if (duplicateMountPath) {
        throw new SandboxMountError(
          'VercelSandboxClient cannot materialize multiple mounts that resolve to the same path.',
          {
            provider: 'vercel',
            mountPath: resolvedMountPath,
            declaredMountPaths: [duplicateMountPath, mountPath],
          },
          'mount_config_invalid',
        );
      }
      resolvedMountPaths.set(resolvedMountPath, mountPath);
    }
  }

  private async assertManifestMountTargetsDoNotCoverEntries(
    manifest: Manifest,
  ): Promise<void> {
    const resolvedMountTargets = [];
    for (const { mountPath } of manifest.mountTargetsForMaterialization()) {
      const resolvedMountPath = await this.resolveRemotePath(mountPath, {
        forWrite: true,
      });
      this.assertResolvedMountPathSupported(resolvedMountPath);
      resolvedMountTargets.push({
        declaredMountPath: mountPath,
        mountPath: resolvedMountPath,
      });
    }

    for (const { absolutePath, entry } of manifest.iterEntries()) {
      if (isMount(entry)) {
        continue;
      }
      const resolvedPath = await this.resolveRemotePath(absolutePath, {
        forWrite: true,
      });
      for (const { declaredMountPath, mountPath } of resolvedMountTargets) {
        if (
          !isSameOrDescendantSandboxPath(absolutePath, declaredMountPath) &&
          !isSameOrDescendantSandboxPath(absolutePath, mountPath) &&
          !isSameOrDescendantSandboxPath(resolvedPath, declaredMountPath) &&
          !isSameOrDescendantSandboxPath(resolvedPath, mountPath)
        ) {
          continue;
        }
        throw new SandboxMountError(
          'VercelSandboxClient cannot materialize manifest entries that are covered by an S3 mount.',
          {
            provider: 'vercel',
            path: resolvedPath,
            mountPath,
          },
          'mount_config_invalid',
        );
      }
    }
  }

  private assertResolvedPathDoesNotOverlapActiveMounts(
    resolvedPath: string,
  ): void {
    const protectedMountPaths =
      this.protectedMountPathsDuringMaterialization ?? this.activeMounts.keys();
    for (const mountPath of protectedMountPaths) {
      if (!sandboxPathsOverlap(resolvedPath, mountPath)) {
        continue;
      }
      throw new SandboxMountError(
        'VercelSandboxClient cannot materialize manifest entries that overlap an active S3 mount.',
        {
          provider: 'vercel',
          path: resolvedPath,
          mountPath,
        },
        'mount_config_invalid',
      );
    }
  }

  private async materializeMountEntry(
    absolutePath: string,
    entry: Mount | TypedMount,
    declaredMountPath?: string,
  ): Promise<void> {
    await this.withRemoteOperationsSuspended(async () => {
      assertVercelCloudBucketMountEntry(entry, absolutePath);
      const materializedEntry = structuredClone(entry);
      materializedEntry.mountPath =
        entry.mountPath ?? declaredMountPath ?? absolutePath;
      const mountPath = await this.resolveRemotePathDuringMountTransition(
        materializedEntry.mountPath,
      );
      this.assertResolvedMountPathSupported(mountPath);
      this.assertResolvedPathDoesNotOverlapActiveMounts(mountPath);
      if (mountPath !== absolutePath) {
        throw new SandboxMountError(
          'VercelSandboxClient mount target changed while the manifest was being materialized.',
          {
            provider: 'vercel',
            declaredMountPath: materializedEntry.mountPath,
            expectedMountPath: absolutePath,
            mountPath,
          },
          'mount_config_invalid',
        );
      }
      const inlineCredentials = readVercelS3MountCredentials(materializedEntry);
      if (inlineCredentials) {
        this.inlineMountCredentials.set(mountPath, inlineCredentials);
      }
      const credentials = await this.resolveCredentialsForMount(
        mountPath,
        materializedEntry,
        { refresh: false },
      );
      await this.mountResolvedS3Entry(
        mountPath,
        materializedEntry,
        credentials,
      );
    });
  }

  private async mountResolvedS3Entry(
    mountPath: string,
    entry: S3Mount,
    credentials: VercelS3MountCredentials | undefined,
    detachedMountPath: string = mountPath,
  ): Promise<void> {
    this.pendingMountVerifications.add(mountPath);
    await mountVercelCloudBucket({
      entry,
      mountPath,
      runCommand: this.mountCommandRunner(),
      credentials,
      validateMountPath: this.mountPathValidator(mountPath, entry),
    });
    const liveMountPaths = await this.assertNoUnexpectedLiveMounts([
      ...this.activeMounts.keys(),
      mountPath,
    ]);
    if (!liveMountPaths.has(mountPath)) {
      throw new SandboxMountError(
        'VercelSandboxClient could not verify the S3 mount at its trusted path.',
        {
          provider: 'vercel',
          mountPath,
          liveMountPaths: [...liveMountPaths],
        },
        'mount_failed',
      );
    }
    const persistentEntry = stripS3MountCredentials(entry);
    this.detachedMounts.delete(detachedMountPath);
    this.activeMounts.set(mountPath, persistentEntry);
    this.pendingMountVerifications.delete(mountPath);
    this.scheduleCredentialRefresh();
  }

  async rematerializeManifestMounts(
    trustedMounts?: Array<{ mountPath: string; entry: S3Mount }>,
  ): Promise<void> {
    await this.withMountLifecycleMutation(async () => {
      this.assertMountsReady();
      const mountPathsBefore = new Set(this.activeMounts.keys());
      const inlineCredentialsBefore = new Map(this.inlineMountCredentials);
      const mounts: Array<{
        mountPath: string;
        declaredMountPath: string;
        previousMountPath?: string;
        entry: S3Mount;
        inlineCredentials?: VercelS3MountCredentials;
      }> =
        trustedMounts === undefined
          ? await this.resolveTrustedManifestMounts({
              requirePersistedTopologyMatch: false,
              deferPathResolution: true,
            })
          : await this.resolveTransferredMounts(trustedMounts);
      const liveMountPaths = await this.assertNoUnexpectedLiveMounts(
        this.activeMounts.keys(),
      );
      try {
        for (const mountPath of [...liveMountPaths].sort(
          compareMountPathsForUnmount,
        )) {
          await unmountVercelCloudBucket({
            mountPath,
            runCommand: this.mountCommandRunner(),
          });
        }
        const preparedMounts =
          await this.materializeRematerializedMounts(mounts);
        this.replaceInlineMountCredentialKeys(preparedMounts);
        this.scheduleCredentialRefresh();
      } catch (error) {
        await this.rollbackNewMounts(
          mountPathsBefore,
          inlineCredentialsBefore,
          error,
        );
        throw error;
      }
    });
  }

  async verifyOrRestoreManifestMounts(): Promise<void> {
    await this.withMountLifecycleMutation(async () => {
      this.assertMountsReady();
      const mountTargets = await this.resolveTrustedManifestMounts({
        requirePersistedTopologyMatch: true,
      });
      await this.assertNoUnexpectedLiveMounts(
        mountTargets.map(({ mountPath }) => mountPath),
      );
      const mountPathsBefore = new Set<string>();
      const inlineCredentialsBefore = new Map(this.inlineMountCredentials);
      let physicalMountStateMutated = false;

      try {
        const preparedMounts = [];
        const mountedPaths = [];
        for (const { mountPath, entry } of mountTargets) {
          const mounted = await isVercelCloudBucketMounted({
            mountPath,
            runCommand: this.mountCommandRunner(),
          });
          if (mounted) {
            mountedPaths.push(mountPath);
          }
          const credentials = await this.resolveCredentialsForMountTransition(
            mountPath,
            entry,
            this.inlineMountCredentials.get(mountPath),
          );
          preparedMounts.push({ mountPath, entry, credentials });
        }

        this.activeMounts.clear();
        this.detachedMounts.clear();
        for (const mountPath of mountedPaths.sort(
          compareMountPathsForUnmount,
        )) {
          await unmountVercelCloudBucket({
            mountPath,
            runCommand: this.mountCommandRunner(),
          });
          physicalMountStateMutated = true;
        }
        for (const { mountPath, entry, credentials } of preparedMounts) {
          await this.mountResolvedS3Entry(
            mountPath,
            structuredClone(entry),
            credentials,
          );
          physicalMountStateMutated = true;
        }
        this.replaceInlineMountCredentialKeys(preparedMounts);
        this.scheduleCredentialRefresh();
      } catch (error) {
        if (physicalMountStateMutated) {
          failedLiveResumeMountMutations.add(this);
        }
        await this.rollbackNewMounts(
          mountPathsBefore,
          inlineCredentialsBefore,
          error,
        );
        throw error;
      }
    });
  }

  private async resolveTrustedManifestMounts(options: {
    requirePersistedTopologyMatch: boolean;
    deferPathResolution?: boolean;
  }): Promise<
    Array<{
      mountPath: string;
      declaredMountPath: string;
      entry: S3Mount;
      inlineCredentials?: VercelS3MountCredentials;
    }>
  > {
    const targets = this.state.manifest.mountTargetsForMaterialization();
    for (const { entry, mountPath } of targets) {
      assertVercelCloudBucketMountEntry(entry, mountPath);
      resolveSandboxRelativePath(
        this.state.manifest.root,
        entry.mountPath ?? mountPath,
      );
    }
    const resolver = this.resolveS3MountConfiguration;
    if (!resolver) {
      if (targets.length === 0) {
        return [];
      }
      throw new SandboxMountError(
        'VercelSandboxClient requires resolveS3MountConfiguration to resume a session with S3 mounts.',
        {
          provider: 'vercel',
          mountPaths: targets.map(({ mountPath }) => mountPath),
        },
        'mount_config_invalid',
      );
    }

    const persistedMounts = targets.map(({ entry, logicalPath, mountPath }) => {
      assertVercelCloudBucketMountEntry(entry, mountPath);
      return {
        logicalPath,
        mountPath,
        mount: stripS3MountCredentials(entry),
      };
    });
    const configurations = await resolver({ persistedMounts });
    const resolved: Array<{
      logicalPath: string;
      declaredMountPath: string;
      mountPath: string;
      entry: S3Mount;
      credentials: VercelS3MountCredentials | undefined;
    }> = [];
    const logicalPaths = new Set<string>();
    const resolvedMountPaths = new Set<string>();
    for (const configuration of configurations) {
      const logicalPath = resolveSandboxRelativePath(
        this.state.manifest.root,
        configuration.logicalPath,
      );
      if (!logicalPath || logicalPaths.has(logicalPath)) {
        throw new SandboxMountError(
          'VercelSandboxClient trusted S3 mount configuration contains a duplicate or empty logical path.',
          {
            provider: 'vercel',
            logicalPath,
          },
          'mount_config_invalid',
        );
      }
      logicalPaths.add(logicalPath);
      const declaredMountPath = trustedConfigurationMountPath(
        this.state.manifest.root,
        logicalPath,
        configuration,
      );
      assertVercelCloudBucketMountEntry(configuration.mount, declaredMountPath);
      const resolvedMountPath = options.deferPathResolution
        ? declaredMountPath
        : await this.resolveRemotePath(declaredMountPath, {
            forWrite: true,
          });
      this.assertResolvedMountPathSupported(resolvedMountPath);
      if (resolvedMountPaths.has(resolvedMountPath)) {
        throw new SandboxMountError(
          'VercelSandboxClient trusted S3 mount configuration resolves multiple mounts to the same path.',
          {
            provider: 'vercel',
            mountPath: resolvedMountPath,
          },
          'mount_config_invalid',
        );
      }
      resolvedMountPaths.add(resolvedMountPath);
      const trustedEntry = structuredClone(configuration.mount);
      trustedEntry.mountPath = declaredMountPath;
      resolved.push({
        logicalPath,
        declaredMountPath,
        mountPath: resolvedMountPath,
        entry: trustedEntry,
        credentials: readVercelS3MountCredentials(trustedEntry),
      });
    }

    if (options.requirePersistedTopologyMatch) {
      assertTrustedMountTopologyMatchesPersisted(targets, resolved);
    }

    let trustedManifest = cloneManifestWithoutMountEntries(this.state.manifest);
    this.inlineMountCredentials.clear();
    for (const { logicalPath, mountPath, entry, credentials } of resolved) {
      trustedManifest = mergeManifestEntryDelta(
        trustedManifest,
        logicalPath,
        stripS3MountCredentials(entry),
      );
      if (credentials) {
        this.inlineMountCredentials.set(mountPath, credentials);
      }
    }
    await this.assertManifestMountTargetsDoNotCoverEntries(trustedManifest);
    this.state.manifest = trustedManifest;
    return resolved
      .map(({ declaredMountPath, mountPath, entry, credentials }) => ({
        declaredMountPath,
        mountPath,
        entry,
        inlineCredentials: credentials,
      }))
      .sort(compareResolvedMountsForMaterialization);
  }

  private async resolveTransferredMounts(
    mounts: Array<{ mountPath: string; entry: S3Mount }>,
  ): Promise<
    Array<{
      mountPath: string;
      declaredMountPath: string;
      previousMountPath: string;
      entry: S3Mount;
      inlineCredentials?: VercelS3MountCredentials;
    }>
  > {
    const inlineCredentials = new Map(this.inlineMountCredentials);
    const declaredMountPaths = new Set<string>();
    const resolved: Array<{
      mountPath: string;
      declaredMountPath: string;
      previousMountPath: string;
      entry: S3Mount;
      inlineCredentials?: VercelS3MountCredentials;
    }> = [];
    for (const { mountPath: previousMountPath, entry } of mounts) {
      const transferredEntry = structuredClone(entry);
      transferredEntry.mountPath ??= previousMountPath;
      const declaredMountPath = transferredEntry.mountPath;
      this.assertResolvedMountPathSupported(declaredMountPath);
      if (declaredMountPaths.has(declaredMountPath)) {
        throw new SandboxMountError(
          'VercelSandboxClient transferred S3 mounts declare the same path.',
          {
            provider: 'vercel',
            mountPath: declaredMountPath,
          },
          'mount_config_invalid',
        );
      }
      declaredMountPaths.add(declaredMountPath);
      resolved.push({
        mountPath: declaredMountPath,
        declaredMountPath,
        previousMountPath,
        entry: transferredEntry,
        inlineCredentials: inlineCredentials.get(previousMountPath),
      });
    }
    await this.assertManifestMountTargetsDoNotCoverEntries(this.state.manifest);
    return resolved.sort(compareResolvedMountsForMaterialization);
  }

  private async materializeRematerializedMounts(
    mounts: Array<{
      mountPath: string;
      declaredMountPath: string;
      previousMountPath?: string;
      entry: S3Mount;
      inlineCredentials?: VercelS3MountCredentials;
    }>,
  ): Promise<
    Array<{
      mountPath: string;
      previousMountPath?: string;
      credentials?: VercelS3MountCredentials;
    }>
  > {
    const remaining = [...mounts];
    const materializedMountPaths = new Map<string, string>();
    const preparedMounts = [];
    while (remaining.length > 0) {
      const resolved = [];
      for (const mount of remaining) {
        const mountPath = await this.resolveRemotePathDuringMountTransition(
          mount.declaredMountPath,
        );
        this.assertResolvedMountPathSupported(mountPath);
        resolved.push({ mountPath, mount });
      }
      resolved.sort(compareRematerializedMountTargets);
      const next = resolved[0]!;
      remaining.splice(remaining.indexOf(next.mount), 1);
      const duplicateMountPath = materializedMountPaths.get(next.mountPath);
      if (duplicateMountPath) {
        throw new SandboxMountError(
          'VercelSandboxClient rematerialized S3 mounts resolve to the same path.',
          {
            provider: 'vercel',
            mountPath: next.mountPath,
            declaredMountPaths: [
              duplicateMountPath,
              next.mount.declaredMountPath,
            ],
          },
          'mount_config_invalid',
        );
      }
      const credentials = await this.resolveCredentialsForMountTransition(
        next.mountPath,
        next.mount.entry,
        next.mount.inlineCredentials ??
          this.inlineMountCredentials.get(
            next.mount.previousMountPath ?? next.mount.mountPath,
          ),
      );
      await this.mountResolvedS3Entry(
        next.mountPath,
        structuredClone(next.mount.entry),
        credentials,
        next.mount.previousMountPath,
      );
      materializedMountPaths.set(next.mountPath, next.mount.declaredMountPath);
      preparedMounts.push({
        mountPath: next.mountPath,
        previousMountPath: next.mount.previousMountPath,
        credentials,
      });
    }
    return preparedMounts;
  }

  private async assertNoUnexpectedLiveMounts(
    trustedMountPaths: Iterable<string>,
  ): Promise<Set<string>> {
    const trusted = new Set(trustedMountPaths);
    const liveMountPaths = await listVercelCloudBucketMountPaths({
      runCommand: this.mountCommandRunner(),
    });
    const unexpectedMountPaths = liveMountPaths.filter(
      (mountPath) => !trusted.has(mountPath),
    );
    if (unexpectedMountPaths.length > 0) {
      throw new SandboxMountError(
        'VercelSandboxClient found live S3 mounts outside the trusted mount set.',
        {
          provider: 'vercel',
          mountPaths: unexpectedMountPaths,
          trustedMountPaths: [...trusted],
        },
        'mount_config_invalid',
      );
    }
    return new Set(liveMountPaths);
  }

  private async withDetachedMounts<T>(
    operation: () => Promise<T>,
    options: { resolveDeclaredPaths?: boolean } = {},
  ): Promise<T> {
    this.assertMountsReady();
    const detached = await this.detachActiveMounts();
    let result!: T;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    try {
      await this.restoreMounts(detached, options);
    } catch (restoreError) {
      if (operationError) {
        throw new SandboxMountError(
          'VercelSandboxClient failed to restore S3 mounts after a workspace operation failed.',
          {
            provider: 'vercel',
            operationCause: providerErrorMessage(operationError),
            restoreCause: providerErrorMessage(restoreError),
          },
          'mount_failed',
        );
      }
      throw restoreError;
    }

    if (operationError) {
      throw operationError;
    }
    return result;
  }

  private async detachActiveMounts(): Promise<
    Array<{ mountPath: string; entry: S3Mount }>
  > {
    const trackedMountPaths = new Set(this.activeMounts.keys());
    const detached: Array<{ mountPath: string; entry: S3Mount }> = [];
    for (const [mountPath, entry] of [
      ...this.activeMounts.entries(),
    ].reverse()) {
      try {
        await unmountVercelCloudBucket({
          mountPath,
          runCommand: this.mountCommandRunner(),
        });
        this.activeMounts.delete(mountPath);
        this.detachedMounts.set(mountPath, entry);
        detached.unshift({ mountPath, entry });
      } catch (error) {
        if (isUnexpectedMountIdentityError(error)) {
          this.state.mountStateUncertainCommand ??= 'findmnt';
        }
        if (isUnmountMutation(this.uncertainMountMutations.get(mountPath))) {
          throw error;
        }
        try {
          await this.restoreMounts(detached);
        } catch (restoreError) {
          throw new SandboxMountError(
            'VercelSandboxClient failed to detach S3 mounts and restore the mounts already detached.',
            {
              provider: 'vercel',
              detachCause: providerErrorMessage(error),
              restoreCause: providerErrorMessage(restoreError),
            },
            'mount_failed',
          );
        }
        throw error;
      }
    }
    const cleanupFailures = await this.cleanupTrackedLiveMounts(
      trackedMountPaths,
      new Set(),
    );
    if (cleanupFailures.length > 0) {
      throw new SandboxMountError(
        'VercelSandboxClient found live S3 mounts after detaching the workspace mounts.',
        {
          provider: 'vercel',
          mountPaths: cleanupFailures.map(({ mountPath }) => mountPath),
          cleanupFailures: cleanupFailures.map(({ mountPath, error }) => ({
            mountPath,
            cause: providerErrorMessage(error),
          })),
        },
        'mount_failed',
      );
    }
    return detached;
  }

  private async restoreMounts(
    mounts: Array<{ mountPath: string; entry: S3Mount }>,
    options: { resolveDeclaredPaths?: boolean } = {},
  ): Promise<void> {
    const inlineCredentials = new Map(this.inlineMountCredentials);
    const resolvedMountPaths = new Set<string>();
    const preparedMounts = [];
    for (const { mountPath, entry } of mounts) {
      const restoredMountPath = options.resolveDeclaredPaths
        ? await this.resolveRemotePathDuringMountTransition(
            entry.mountPath ?? mountPath,
          )
        : mountPath;
      this.assertResolvedMountPathSupported(restoredMountPath);
      if (resolvedMountPaths.has(restoredMountPath)) {
        throw new SandboxMountError(
          'VercelSandboxClient detached S3 mounts resolve to the same path.',
          {
            provider: 'vercel',
            mountPath: restoredMountPath,
          },
          'mount_config_invalid',
        );
      }
      resolvedMountPaths.add(restoredMountPath);
      const credentials = await this.resolveCredentialsForMountTransition(
        restoredMountPath,
        entry,
        inlineCredentials.get(mountPath),
      );
      preparedMounts.push({
        mountPath: restoredMountPath,
        previousMountPath: mountPath,
        entry,
        credentials,
      });
    }

    preparedMounts.sort(compareResolvedMountsForMaterialization);
    for (const {
      mountPath,
      previousMountPath,
      entry,
      credentials,
    } of preparedMounts) {
      await this.mountResolvedS3Entry(
        mountPath,
        entry,
        credentials,
        previousMountPath,
      );
    }
    this.replaceInlineMountCredentialKeys(preparedMounts);
    this.scheduleCredentialRefresh();
  }

  private async resolveRemotePathDuringMountTransition(
    path: string,
  ): Promise<string> {
    return await validateRemoteSandboxPathForManifest({
      manifest: this.state.manifest,
      path,
      options: { forWrite: true },
      runCommand: async (command) => {
        const result = await this.execShell(
          command,
          this.state.manifest.root,
          undefined,
        );
        return {
          status: result.exitCode,
          stdout: result.output,
          stderr: '',
        };
      },
    });
  }

  private assertResolvedMountPathSupported(mountPath: string): void {
    assertVercelMountPathBelowWorkspaceRoot(
      this.state.manifest.root,
      mountPath,
    );
  }

  private mountPathValidator(
    expectedMountPath: string,
    entry: S3Mount,
  ): () => Promise<void> {
    return async () => {
      const mountPath = await this.resolveRemotePathDuringMountTransition(
        entry.mountPath ?? expectedMountPath,
      );
      this.assertResolvedMountPathSupported(mountPath);
      if (mountPath !== expectedMountPath) {
        throw new SandboxMountError(
          'VercelSandboxClient mount target changed while the S3 mount was being prepared.',
          {
            provider: 'vercel',
            expectedMountPath,
            mountPath,
          },
          'mount_config_invalid',
        );
      }
    };
  }

  private async rollbackNewMounts(
    mountPathsBefore: ReadonlySet<string>,
    inlineCredentialsBefore: ReadonlyMap<string, VercelS3MountCredentials>,
    operationError: unknown,
  ): Promise<void> {
    const addedMountPaths = [...this.activeMounts.keys()]
      .filter((mountPath) => !mountPathsBefore.has(mountPath))
      .reverse();
    const rollbackMountPaths = [
      ...new Set([
        ...addedMountPaths,
        ...this.pendingMountVerifications,
        ...[...this.uncertainMountMutations.entries()]
          .filter(([, command]) => command === 'mount-s3')
          .map(([mountPath]) => mountPath),
      ]),
    ].sort(compareMountPathsForUnmount);
    const rollbackFailures: Array<{
      mountPath: string;
      error: unknown;
    }> = [];
    for (const mountPath of rollbackMountPaths) {
      try {
        await unmountVercelCloudBucket({
          mountPath,
          runCommand: this.mountCommandRunner(),
        });
        this.activeMounts.delete(mountPath);
        this.detachedMounts.delete(mountPath);
        this.pendingMountVerifications.delete(mountPath);
      } catch (error) {
        rollbackFailures.push({ mountPath, error });
        this.markUncertainUnmountPath(mountPath);
      }
    }
    for (const cleanupFailure of await this.cleanupTrackedLiveMounts(
      new Set(rollbackMountPaths),
      mountPathsBefore,
    )) {
      if (
        rollbackFailures.some(
          ({ mountPath }) => mountPath === cleanupFailure.mountPath,
        )
      ) {
        continue;
      }
      rollbackFailures.push(cleanupFailure);
    }

    this.inlineMountCredentials.clear();
    for (const [mountPath, credentials] of inlineCredentialsBefore) {
      this.inlineMountCredentials.set(mountPath, credentials);
    }
    this.scheduleCredentialRefresh();

    if (rollbackFailures.length > 0) {
      const firstRollbackFailure = rollbackFailures[0]!;
      throw new SandboxMountError(
        'VercelSandboxClient failed to roll back S3 mounts after manifest materialization failed.',
        {
          provider: 'vercel',
          materializationCause: providerErrorMessage(operationError),
          ...(operationError instanceof SandboxMountError &&
          operationError.details
            ? { materializationDetails: operationError.details }
            : {}),
          rollbackCause: providerErrorMessage(firstRollbackFailure.error),
          ...(firstRollbackFailure.error instanceof SandboxMountError &&
          firstRollbackFailure.error.details
            ? { rollbackDetails: firstRollbackFailure.error.details }
            : {}),
          rollbackFailures: rollbackFailures.map(({ mountPath, error }) => ({
            mountPath,
            cause: providerErrorMessage(error),
            ...(error instanceof SandboxMountError && error.details
              ? { details: error.details }
              : {}),
          })),
          addedMountPaths: rollbackMountPaths,
        },
        'mount_failed',
      );
    }
  }

  private async unmountActiveMounts(): Promise<void> {
    const mountPaths = [
      ...new Set([
        ...this.activeMounts.keys(),
        ...this.pendingMountVerifications,
        ...this.uncertainMountMutations.keys(),
      ]),
    ].reverse();
    if (mountPaths.length === 0) {
      return;
    }
    const unmountFailures: Array<{ mountPath: string; error: unknown }> = [];
    for (const mountPath of mountPaths) {
      const entry = this.activeMounts.get(mountPath);
      try {
        await unmountVercelCloudBucket({
          mountPath,
          runCommand: this.mountCommandRunner(),
        });
        this.activeMounts.delete(mountPath);
        this.pendingMountVerifications.delete(mountPath);
        if (entry) {
          this.detachedMounts.set(mountPath, entry);
        }
      } catch (error) {
        this.markUncertainUnmountPath(mountPath);
        unmountFailures.push({ mountPath, error });
      }
    }
    unmountFailures.push(
      ...(await this.cleanupTrackedLiveMounts(new Set(mountPaths), new Set())),
    );
    if (unmountFailures.length > 0) {
      throw new SandboxMountError(
        'VercelSandboxClient failed to unmount one or more active S3 mounts.',
        {
          provider: 'vercel',
          unmountFailures: unmountFailures.map(({ mountPath, error }) => ({
            mountPath,
            cause: providerErrorMessage(error),
            ...(error instanceof SandboxMountError && error.details
              ? { details: error.details }
              : {}),
          })),
        },
        'mount_failed',
      );
    }
  }

  private async cleanupTrackedLiveMounts(
    trackedMountPaths: ReadonlySet<string>,
    allowedMountPaths: ReadonlySet<string>,
  ): Promise<Array<{ mountPath: string; error: unknown }>> {
    const failures: Array<{ mountPath: string; error: unknown }> = [];
    let unexpectedMountPaths: string[];
    try {
      unexpectedMountPaths = (
        await listVercelCloudBucketMountPaths({
          runCommand: this.mountCommandRunner(),
        })
      ).filter(
        (mountPath) =>
          trackedMountPaths.has(mountPath) && !allowedMountPaths.has(mountPath),
      );
    } catch (error) {
      this.state.mountStateUncertainCommand ??= 'findmnt';
      return [{ mountPath: '<unknown>', error }];
    }

    for (const mountPath of unexpectedMountPaths.sort(
      compareMountPathsForUnmount,
    )) {
      try {
        await unmountVercelCloudBucket({
          mountPath,
          runCommand: this.mountCommandRunner(),
        });
      } catch (error) {
        failures.push({ mountPath, error });
        this.markUncertainUnmountPath(mountPath);
      }
    }

    let remainingMountPaths: string[];
    try {
      remainingMountPaths = (
        await listVercelCloudBucketMountPaths({
          runCommand: this.mountCommandRunner(),
        })
      ).filter(
        (mountPath) =>
          trackedMountPaths.has(mountPath) && !allowedMountPaths.has(mountPath),
      );
    } catch (error) {
      this.state.mountStateUncertainCommand ??= 'findmnt';
      failures.push({ mountPath: '<unknown>', error });
      return failures;
    }

    for (const mountPath of remainingMountPaths) {
      this.markUncertainUnmountPath(mountPath);
      if (failures.some((failure) => failure.mountPath === mountPath)) {
        continue;
      }
      failures.push({
        mountPath,
        error: new SandboxMountError(
          'VercelSandboxClient found a live S3 mount after cleanup.',
          {
            provider: 'vercel',
            mountPath,
          },
          'mount_failed',
        ),
      });
    }
    return failures;
  }

  private markUncertainUnmountPath(mountPath: string): void {
    this.state.mountStateUncertainCommand ??= 'umount';
    this.uncertainMountMutations.set(mountPath, 'umount');
  }

  private assertMountsReady(): void {
    assertVercelMountStateCertain(this.state);
    if (this.detachedMounts.size === 0) {
      return;
    }
    throw new SandboxMountError(
      'VercelSandboxClient session is unusable while S3 mounts remain detached after a failed restore.',
      {
        provider: 'vercel',
        detachedMountPaths: [...this.detachedMounts.keys()],
      },
      'mount_failed',
    );
  }

  private clearCredentialRefreshTimer(): void {
    this.credentialRefreshGeneration += 1;
    if (this.credentialRefreshTimer === undefined) {
      return;
    }
    clearTimeout(this.credentialRefreshTimer);
    this.credentialRefreshTimer = undefined;
  }

  /** @internal */
  cancelCredentialRefreshForDiscard(): void {
    this.clearCredentialRefreshTimer();
  }

  private scheduleCredentialRefresh(delayOverrideMs?: number): void {
    this.clearCredentialRefreshTimer();
    if (
      !this.resolveS3MountCredentials ||
      this.closeCompleted ||
      this.activeMounts.size === 0
    ) {
      return;
    }
    const expirationMs = this.earliestActiveCredentialExpirationMs();
    if (expirationMs === undefined) {
      return;
    }
    const remainingMs = expirationMs - Date.now();
    const leadMs = Math.min(
      S3_CREDENTIAL_REFRESH_MAX_LEAD_MS,
      Math.max(1, Math.floor(remainingMs / 5)),
    );
    const requestedDelayMs =
      delayOverrideMs ??
      (remainingMs <= 0 ? 0 : Math.max(1, remainingMs - leadMs));
    const delayMs = Math.min(requestedDelayMs, MAX_TIMER_DELAY_MS);
    const refreshOnWake = delayMs === requestedDelayMs;
    const generation = this.credentialRefreshGeneration;
    const timer = setTimeout(() => {
      if (this.credentialRefreshTimer === timer) {
        this.credentialRefreshTimer = undefined;
      }
      if (!refreshOnWake) {
        this.scheduleCredentialRefresh();
        return;
      }
      void this.refreshExpiringMountCredentials(expirationMs, generation);
    }, delayMs);
    this.credentialRefreshTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private earliestActiveCredentialExpirationMs(): number | undefined {
    let earliest: number | undefined;
    for (const mountPath of this.activeMounts.keys()) {
      const expirationMs = this.inlineMountCredentials
        .get(mountPath)
        ?.expiration?.getTime();
      if (
        expirationMs !== undefined &&
        (earliest === undefined || expirationMs < earliest)
      ) {
        earliest = expirationMs;
      }
    }
    return earliest;
  }

  private async refreshExpiringMountCredentials(
    expectedExpirationMs: number,
    generation: number,
  ): Promise<void> {
    if (generation !== this.credentialRefreshGeneration) {
      return;
    }
    try {
      await this.withMountLifecycleMutation(async () => {
        if (
          generation !== this.credentialRefreshGeneration ||
          this.closeCompleted
        ) {
          return;
        }
        await this.withRemoteOperationsSuspended(async () => {
          this.assertMountsReady();
          const currentExpirationMs =
            this.earliestActiveCredentialExpirationMs();
          if (
            currentExpirationMs === undefined ||
            currentExpirationMs > expectedExpirationMs
          ) {
            this.scheduleCredentialRefresh();
            return;
          }
          await this.remountActiveMountsWithFreshCredentials(
            currentExpirationMs,
          );
        });
      });
    } catch {
      if (generation !== this.credentialRefreshGeneration) {
        return;
      }
      const expirationMs = this.earliestActiveCredentialExpirationMs();
      if (
        this.detachedMounts.size === 0 &&
        expirationMs !== undefined &&
        expirationMs > Date.now()
      ) {
        this.scheduleCredentialRefresh(
          Math.min(
            S3_CREDENTIAL_REFRESH_RETRY_MS,
            Math.max(1, Math.floor((expirationMs - Date.now()) / 2)),
          ),
        );
        return;
      }
      this.state.mountStateUncertainCommand ??= 'credential-refresh';
    }
  }

  private async remountActiveMountsWithFreshCredentials(
    previousExpirationMs: number,
  ): Promise<void> {
    const mounts = [...this.activeMounts.entries()].map(
      ([mountPath, entry]) => ({ mountPath, entry }),
    );
    const preparedMounts = [];
    for (const { mountPath, entry } of mounts) {
      const credentials = await this.resolveCredentialsForMountTransition(
        mountPath,
        entry,
        this.inlineMountCredentials.get(mountPath),
      );
      preparedMounts.push({ mountPath, entry, credentials });
    }
    const nextExpirations = preparedMounts
      .map(({ credentials }) => credentials?.expiration?.getTime())
      .filter((expiration): expiration is number => expiration !== undefined);
    if (
      nextExpirations.length > 0 &&
      Math.min(...nextExpirations) <= previousExpirationMs
    ) {
      throw new SandboxMountError(
        'VercelSandboxClient credential resolver did not return credentials with a later expiration.',
        {
          provider: 'vercel',
        },
        'mount_failed',
      );
    }

    await this.detachActiveMounts();
    for (const { mountPath, entry, credentials } of preparedMounts) {
      await this.mountResolvedS3Entry(mountPath, entry, credentials);
    }
    this.replaceInlineMountCredentialKeys(preparedMounts);
    this.scheduleCredentialRefresh();
  }

  private markMountStateUncertain(command: string, args: string[]): void {
    this.state.mountStateUncertainCommand ??= command;
    const mountPath = mutatingMountCommandPath(command, args);
    if (mountPath) {
      this.uncertainMountMutations.set(mountPath, command);
    }
  }

  private async withMountLifecycleMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mountLifecycleTail;
    let release!: () => void;
    this.mountLifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withRemoteOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.remoteOperationsSuspended) {
      this.assertMountsReady();
      throw new SandboxMountError(
        'VercelSandboxClient cannot run workspace operations while S3 mounts are transitioning.',
        {
          provider: 'vercel',
        },
        'mount_failed',
      );
    }
    this.activeRemoteOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeRemoteOperations -= 1;
      if (this.activeRemoteOperations === 0) {
        this.remoteOperationsDrained?.resolve();
        this.remoteOperationsDrained = undefined;
      }
    }
  }

  private async withRemoteOperationsSuspended<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.remoteOperationsSuspended) {
      throw new SandboxMountError(
        'VercelSandboxClient encountered a nested S3 mount transition.',
        {
          provider: 'vercel',
        },
        'mount_failed',
      );
    }
    this.remoteOperationsSuspended = true;
    try {
      if (this.activeRemoteOperations > 0) {
        this.remoteOperationsDrained ??= createDeferredSignal();
        await this.remoteOperationsDrained.promise;
      }
      return await operation();
    } finally {
      this.remoteOperationsSuspended = false;
    }
  }

  private async resolveCredentialsForMount(
    mountPath: string,
    entry: S3Mount,
    options: {
      refresh?: boolean;
    } = {},
  ): Promise<VercelS3MountCredentials | undefined> {
    if (options.refresh && this.resolveS3MountCredentials) {
      return await this.resolveAndCacheMountCredentials(mountPath, entry);
    }
    const inlineCredentials = this.inlineMountCredentials.get(mountPath);
    if (inlineCredentials) {
      return this.assertS3CredentialExposureAllowed(
        mountPath,
        inlineCredentials,
      );
    }
    if (!this.resolveS3MountCredentials) {
      return undefined;
    }
    return await this.resolveAndCacheMountCredentials(mountPath, entry);
  }

  private async resolveAndCacheMountCredentials(
    mountPath: string,
    entry: S3Mount,
  ): Promise<VercelS3MountCredentials | undefined> {
    const resolver = this.resolveS3MountCredentials;
    if (!resolver) {
      return undefined;
    }
    const credentials = normalizeVercelS3MountCredentials(
      await resolver({
        mountPath,
        mount: entry,
      }),
    );
    this.assertS3CredentialExposureAllowed(mountPath, credentials);
    if (credentials.accessKeyId) {
      this.inlineMountCredentials.set(mountPath, credentials);
      return credentials;
    }
    this.inlineMountCredentials.delete(mountPath);
    return undefined;
  }

  private async resolveCredentialsForMountTransition(
    mountPath: string,
    entry: S3Mount,
    fallbackCredentials?: VercelS3MountCredentials,
  ): Promise<VercelS3MountCredentials | undefined> {
    const resolver = this.resolveS3MountCredentials;
    if (!resolver) {
      return this.assertS3CredentialExposureAllowed(
        mountPath,
        fallbackCredentials,
      );
    }
    const credentials = normalizeVercelS3MountCredentials(
      await resolver({
        mountPath,
        mount: entry,
      }),
    );
    this.assertS3CredentialExposureAllowed(mountPath, credentials);
    return credentials.accessKeyId ? credentials : undefined;
  }

  private assertS3CredentialExposureAllowed(
    mountPath: string,
    credentials: VercelS3MountCredentials | undefined,
  ): VercelS3MountCredentials | undefined {
    assertVercelS3CredentialExposureAllowed(
      credentials,
      this.allowS3CredentialExposure,
      mountPath,
    );
    return credentials;
  }

  private replaceInlineMountCredentialKeys(
    mounts: ReadonlyArray<{
      mountPath: string;
      previousMountPath?: string;
      credentials?: VercelS3MountCredentials;
    }>,
  ): void {
    const nextCredentials = new Map(this.inlineMountCredentials);
    for (const { mountPath, previousMountPath } of mounts) {
      nextCredentials.delete(mountPath);
      if (previousMountPath) {
        nextCredentials.delete(previousMountPath);
      }
    }
    for (const { mountPath, credentials } of mounts) {
      if (credentials?.accessKeyId) {
        nextCredentials.set(mountPath, credentials);
      }
    }
    this.inlineMountCredentials.clear();
    for (const [mountPath, credentials] of nextCredentials) {
      this.inlineMountCredentials.set(mountPath, credentials);
    }
  }

  private mountCommandRunner(): VercelMountCommand {
    return async (command, args, options = {}) => {
      const signal =
        typeof options.timeoutMs === 'number'
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined;
      const trustedEnvironment = {
        ...(options.env ?? {}),
        PATH: TRUSTED_VERCEL_MOUNT_COMMAND_PATH,
      };
      // Vercel merges command env into the sandbox defaults, so clear every
      // persisted key before rebuilding a minimal child environment.
      const inheritedEnvironmentOverrides = Object.fromEntries(
        [
          ...Object.keys(this.state.environment),
          ...VERCEL_MOUNT_LAUNCHER_ENVIRONMENT_KEYS,
        ].map((name) => [name, '']),
      );
      const trustedEnvironmentAssignments = Object.keys(trustedEnvironment)
        .map((name) => `${name}="$${name}"`)
        .join(' ');
      let result: VercelCommandFinishedLike;
      try {
        result = await this.sandbox.runCommand({
          cmd: '/bin/sh',
          args: [
            '-c',
            `exec /usr/bin/env -i ${trustedEnvironmentAssignments} "$@"`,
            ISOLATED_VERCEL_MOUNT_COMMAND_LABEL,
            command,
            ...args,
          ],
          env: {
            ...inheritedEnvironmentOverrides,
            ...trustedEnvironment,
          },
          ...(options.sudo ? { sudo: true } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isMutatingMountCommand(command)) {
          this.markMountStateUncertain(command, args);
        }
        throw error;
      }

      if (result.exitCode === null) {
        if (
          isMutatingMountCommand(command) ||
          isMountStateProbeCommand(command)
        ) {
          this.markMountStateUncertain(command, args);
        }
        throw new SandboxMountError(
          'VercelSandboxClient received no exit status for a mount lifecycle command.',
          {
            provider: 'vercel',
            command: [command, ...args].map(shellQuote).join(' '),
          },
          'mount_failed',
        );
      }
      const status = result.exitCode ?? 1;
      try {
        const [stdout, stderr] = await Promise.all([
          result.output('stdout', { signal }),
          result.output('stderr', { signal }),
        ]);
        return {
          status,
          stdout,
          stderr,
        };
      } catch {
        return { status };
      }
    };
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    return await this.withRemoteOperation(async () => {
      this.assertMountsReady();
      const result = await this.execShell(command, options.workdir, undefined);
      return {
        status: result.exitCode,
        stdout: result.output,
        stderr: '',
      };
    });
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    await this.withRemoteOperation(async () => {
      this.assertMountsReady();
      await this.ensureDir(path);
    });
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    return await this.withRemoteOperation(async () => {
      this.assertMountsReady();
      const bytes = await this.sandbox.readFileToBuffer({ path });
      if (!bytes) {
        throw new UserError(`Sandbox path not found: ${path}`);
      }
      return await toUint8Array(bytes);
    });
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.withRemoteOperation(async () => {
      this.assertMountsReady();
      await this.sandbox.writeFiles([
        {
          path,
          content,
        },
      ]);
    });
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    const result = await this.runRemoteCommand(`rm -f -- ${shellQuote(path)}`, {
      kind: 'manifest',
      workdir: this.state.manifest.root,
    });
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
  }
}

const failedLiveResumeMountMutations = new WeakSet<VercelSandboxSession>();

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
    assertVercelManifestMountsSupported(resolvedManifest);
    assertManifestS3CredentialExposureAllowed(
      resolvedManifest,
      resolvedOptions.allowS3CredentialExposure === true,
    );
    const persistentManifest =
      stripVercelS3MountCredentialsFromManifest(resolvedManifest);

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
          resolveS3MountCredentials: resolvedOptions.resolveS3MountCredentials,
          resolveS3MountConfiguration:
            resolvedOptions.resolveS3MountConfiguration,
          allowS3CredentialExposure: resolvedOptions.allowS3CredentialExposure,
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
          session.cancelCredentialRefreshForDiscard();
          try {
            await stopVercelSandbox(sandbox);
          } catch (stopError) {
            throw new SandboxLifecycleError(
              'VercelSandboxClient failed to apply the initial manifest and stop the sandbox.',
              {
                provider: 'vercel',
                sandboxId: sandbox.sandboxId,
                manifestCause: providerErrorMessage(error),
                ...(error instanceof SandboxMountError && error.details
                  ? { manifestDetails: error.details }
                  : {}),
                stopCause: providerErrorMessage(stopError),
              },
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
    assertVercelMountStateCertain(state);
    const credentials = selectVercelSessionCredentials(state, this.options);
    applyVercelCredentials(state, credentials);
    if (
      state.workspacePersistence === 'snapshot' &&
      state.snapshotSupported !== false &&
      !vercelNativeSnapshotRequiresTarFallback(state.manifest) &&
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
      manifest: stripVercelS3MountCredentialsFromManifest(state.manifest),
    });
  }

  canPersistOwnedSessionState(state: VercelSandboxSessionState): boolean {
    return (
      state.workspacePersistence === 'snapshot' &&
      state.snapshotSupported !== false &&
      !vercelNativeSnapshotRequiresTarFallback(state.manifest)
    );
  }

  canReusePreservedOwnedSession(state: VercelSandboxSessionState): boolean {
    return (
      state.workspacePersistence !== 'snapshot' ||
      state.snapshotSupported === false ||
      vercelNativeSnapshotRequiresTarFallback(state.manifest)
    );
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<VercelSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    const manifest = stripVercelS3MountCredentialsFromManifest(
      resolveManifestRoot(baseState.manifest),
    );
    assertSandboxManifestMetadataSupported(
      'VercelSandboxClient',
      manifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    const deserializedState: VercelSandboxSessionState = {
      ...state,
      ...baseState,
      manifest,
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
      mountStateUncertainCommand: readOptionalString(
        state,
        'mountStateUncertainCommand',
      ),
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
    assertVercelMountStateCertain(state);
    state.manifest = stripVercelS3MountCredentialsFromManifest(state.manifest);
    assertVercelManifestMountsSupported(state.manifest);
    assertVercelResumeMountConfigurationAvailable(
      state.manifest,
      this.options.resolveS3MountConfiguration,
    );
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
      resolveS3MountCredentials: this.options.resolveS3MountCredentials,
      resolveS3MountConfiguration: this.options.resolveS3MountConfiguration,
      allowS3CredentialExposure: this.options.allowS3CredentialExposure,
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
      if (resumeFromSnapshot) {
        await session.rematerializeManifestMounts();
      } else {
        await session.verifyOrRestoreManifestMounts();
      }
    } catch (error) {
      session.cancelCredentialRefreshForDiscard();
      if (!resumeFromSnapshot) {
        const mountStateUncertain =
          session.state.mountStateUncertainCommand !== undefined;
        if (session.state.mountStateUncertainCommand) {
          state.mountStateUncertainCommand =
            session.state.mountStateUncertainCommand;
        }
        if (
          mountStateUncertain ||
          failedLiveResumeMountMutations.has(session)
        ) {
          try {
            await stopVercelSandbox(sandbox);
          } catch (stopError) {
            throw new SandboxLifecycleError(
              'VercelSandboxClient failed to resume a live sandbox after a mount mutation and stop it.',
              {
                provider: 'vercel',
                sandboxId: sandbox.sandboxId,
                resumeCause: providerErrorMessage(error),
                ...(error instanceof SandboxMountError && error.details
                  ? { resumeDetails: error.details }
                  : {}),
                stopCause: providerErrorMessage(stopError),
              },
            );
          }
        }
        throw error;
      }
      try {
        await stopVercelSandbox(sandbox);
      } catch (stopError) {
        throw new SandboxLifecycleError(
          'VercelSandboxClient failed to resume a snapshot and stop the replacement sandbox.',
          {
            provider: 'vercel',
            sandboxId: sandbox.sandboxId,
            resumeCause: providerErrorMessage(error),
            ...(error instanceof SandboxMountError && error.details
              ? { resumeDetails: error.details }
              : {}),
            stopCause: providerErrorMessage(stopError),
          },
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

function stripVercelS3MountCredentialsFromManifest(
  manifest: Manifest,
): Manifest {
  const persistentManifest = cloneManifestWithRoot(manifest, manifest.root);
  for (const { entry } of persistentManifest.mountTargets()) {
    if (entry.type !== 's3_mount') {
      continue;
    }
    delete entry.accessKeyId;
    delete entry.secretAccessKey;
    delete entry.sessionToken;
  }
  return persistentManifest;
}

function stripS3MountCredentials(entry: S3Mount): S3Mount {
  const persistentEntry = structuredClone(entry);
  delete persistentEntry.accessKeyId;
  delete persistentEntry.secretAccessKey;
  delete persistentEntry.sessionToken;
  return persistentEntry;
}

function trustedConfigurationMountPath(
  root: string,
  logicalPath: string,
  configuration: VercelS3MountConfiguration,
): string {
  const declaredMountPath = configuration.mountPath.trim();
  if (!declaredMountPath) {
    throw new SandboxMountError(
      'VercelSandboxClient trusted S3 mount configuration contains an empty mount path.',
      {
        provider: 'vercel',
        logicalPath,
      },
      'mount_config_invalid',
    );
  }

  const effectiveMountPath = effectiveManifestMountPath(
    root,
    logicalPath,
    declaredMountPath,
  );
  assertVercelMountPathBelowWorkspaceRoot(root, effectiveMountPath);
  if (configuration.mount.mountPath) {
    const entryMountPath = effectiveManifestMountPath(
      root,
      logicalPath,
      configuration.mount.mountPath,
    );
    if (entryMountPath !== effectiveMountPath) {
      throw new SandboxMountError(
        'VercelSandboxClient trusted S3 mount configuration contains conflicting mount paths.',
        {
          provider: 'vercel',
          logicalPath,
          mountPath: effectiveMountPath,
          entryMountPath,
        },
        'mount_config_invalid',
      );
    }
  }
  return effectiveMountPath;
}

function effectiveManifestMountPath(
  root: string,
  logicalPath: string,
  mountPath: string,
): string {
  const manifest = new Manifest({
    root,
    entries: {
      [logicalPath]: {
        type: 's3_mount',
        bucket: 'mount-path-validation',
        mountPath,
      },
    },
  });
  const target = manifest.mountTargetsForMaterialization()[0];
  if (!target) {
    throw new SandboxMountError(
      'VercelSandboxClient trusted S3 mount configuration did not produce a mount target.',
      {
        provider: 'vercel',
        logicalPath,
        mountPath,
      },
      'mount_config_invalid',
    );
  }
  return target.mountPath;
}

function assertTrustedMountTopologyMatchesPersisted(
  persisted: ReadonlyArray<{ logicalPath: string; mountPath: string }>,
  trusted: ReadonlyArray<{
    logicalPath: string;
    declaredMountPath: string;
  }>,
): void {
  const persistedTopology = persisted
    .map(({ logicalPath, mountPath }) => ({ logicalPath, mountPath }))
    .sort(compareMountTopology);
  const trustedTopology = trusted
    .map(({ logicalPath, declaredMountPath }) => ({
      logicalPath,
      mountPath: declaredMountPath,
    }))
    .sort(compareMountTopology);
  if (
    persistedTopology.length === trustedTopology.length &&
    persistedTopology.every(
      (entry, index) =>
        entry.logicalPath === trustedTopology[index]?.logicalPath &&
        entry.mountPath === trustedTopology[index]?.mountPath,
    )
  ) {
    return;
  }
  throw new SandboxMountError(
    'VercelSandboxClient cannot change the S3 mount topology while resuming a live sandbox.',
    {
      provider: 'vercel',
      persistedTopology,
      trustedTopology,
    },
    'mount_config_invalid',
  );
}

function compareMountTopology(
  left: { logicalPath: string; mountPath: string },
  right: { logicalPath: string; mountPath: string },
): number {
  return (
    left.logicalPath.localeCompare(right.logicalPath) ||
    left.mountPath.localeCompare(right.mountPath)
  );
}

function compareResolvedMountsForMaterialization(
  left: { mountPath: string },
  right: { mountPath: string },
): number {
  const depthDelta =
    mountPathDepth(left.mountPath) - mountPathDepth(right.mountPath);
  return depthDelta || left.mountPath.localeCompare(right.mountPath);
}

function compareRematerializedMountTargets(
  left: {
    mountPath: string;
    mount: { declaredMountPath: string };
  },
  right: {
    mountPath: string;
    mount: { declaredMountPath: string };
  },
): number {
  if (
    left.mount.declaredMountPath !== right.mount.declaredMountPath &&
    isSameOrDescendantSandboxPath(
      right.mount.declaredMountPath,
      left.mount.declaredMountPath,
    )
  ) {
    return -1;
  }
  if (
    left.mount.declaredMountPath !== right.mount.declaredMountPath &&
    isSameOrDescendantSandboxPath(
      left.mount.declaredMountPath,
      right.mount.declaredMountPath,
    )
  ) {
    return 1;
  }
  return compareResolvedMountsForMaterialization(left, right);
}

function compareMountPathsForUnmount(left: string, right: string): number {
  const depthDelta = mountPathDepth(right) - mountPathDepth(left);
  return depthDelta || left.localeCompare(right);
}

function mountPathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function assertVercelCloudBucketMountEntry(
  entry: Mount | TypedMount,
  path: string,
): asserts entry is S3Mount {
  if (isVercelCloudBucketMountEntry(entry)) {
    return;
  }
  throw new SandboxUnsupportedFeatureError(
    'VercelSandboxClient only supports VercelCloudBucketMountStrategy on S3 mount entries.',
    {
      provider: 'vercel',
      feature: 'entry.mountStrategy',
      path,
      mountType: entry.type,
      strategyType: entry.mountStrategy?.type,
    },
  );
}

function assertVercelManifestMountsSupported(manifest: Manifest): void {
  for (const {
    entry,
    mountPath,
  } of manifest.mountTargetsForMaterialization()) {
    assertVercelCloudBucketMountEntry(entry, mountPath);
    assertVercelMountPathBelowWorkspaceRoot(
      manifest.root,
      entry.mountPath ?? mountPath,
    );
    readVercelS3MountCredentials(entry);
  }
}

function assertManifestS3CredentialExposureAllowed(
  manifest: Manifest,
  allowS3CredentialExposure: boolean,
): void {
  for (const {
    entry,
    mountPath,
  } of manifest.mountTargetsForMaterialization()) {
    if (!isVercelCloudBucketMountEntry(entry)) {
      continue;
    }
    assertVercelS3CredentialExposureAllowed(
      readVercelS3MountCredentials(entry),
      allowS3CredentialExposure,
      mountPath,
    );
  }
}

function assertVercelS3CredentialExposureAllowed(
  credentials: VercelS3MountCredentials | undefined,
  allowS3CredentialExposure: boolean,
  mountPath: string,
): void {
  if (!credentials?.accessKeyId || allowS3CredentialExposure) {
    return;
  }
  throw new SandboxMountError(
    'Vercel S3 mount credentials are accessible to root-capable sandbox workloads. Set allowS3CredentialExposure only when using short-lived IAM credentials restricted to this mount.',
    {
      provider: 'vercel',
      mountPath,
    },
    'mount_config_invalid',
  );
}

function assertVercelMountPathBelowWorkspaceRoot(
  root: string,
  mountPath: string,
): void {
  const relativeMountPath = resolveSandboxRelativePath(root, mountPath);
  if (relativeMountPath) {
    return;
  }
  throw new SandboxMountError(
    'VercelSandboxClient does not support mounting an S3 bucket at the workspace root.',
    {
      provider: 'vercel',
      mountPath,
      root,
    },
    'mount_config_invalid',
  );
}

function assertVercelResumeMountConfigurationAvailable(
  manifest: Manifest,
  resolver: VercelS3MountConfigurationResolver | undefined,
): void {
  const targets = manifest.mountTargetsForMaterialization();
  if (targets.length === 0 || resolver) {
    return;
  }
  throw new SandboxMountError(
    'VercelSandboxClient requires resolveS3MountConfiguration to resume a session with S3 mounts.',
    {
      provider: 'vercel',
      mountPaths: targets.map(({ mountPath }) => mountPath),
    },
    'mount_config_invalid',
  );
}

function sandboxPathsOverlap(left: string, right: string): boolean {
  return (
    isSameOrDescendantSandboxPath(left, right) ||
    isSameOrDescendantSandboxPath(right, left)
  );
}

function isSameOrDescendantSandboxPath(
  path: string,
  ancestor: string,
): boolean {
  return (
    path === ancestor ||
    (ancestor === '/' ? path.startsWith('/') : path.startsWith(`${ancestor}/`))
  );
}

function assertVercelMountStateCertain(
  state: Pick<VercelSandboxSessionState, 'mountStateUncertainCommand'>,
): void {
  if (!state.mountStateUncertainCommand) {
    return;
  }
  throw new SandboxMountError(
    'VercelSandboxClient session is unusable because a failed or timed-out mount command left the physical mount state uncertain.',
    {
      provider: 'vercel',
      command: state.mountStateUncertainCommand,
    },
    'mount_failed',
  );
}

function isMutatingMountCommand(command: string): boolean {
  return command === 'mount-s3' || command === 'umount';
}

function isMountStateProbeCommand(command: string): boolean {
  return command === 'findmnt' || command === 'mountpoint';
}

function isUnmountMutation(command: string | undefined): boolean {
  return command === 'umount';
}

function isUnexpectedMountIdentityError(error: unknown): boolean {
  return (
    error instanceof SandboxMountError &&
    error.details?.mountIdentityMismatch === true
  );
}

function mutatingMountCommandPath(
  command: string,
  args: string[],
): string | undefined {
  if (command === 'mount-s3') {
    return args[1];
  }
  if (command === 'umount') {
    return args[0];
  }
  return undefined;
}

function createDeferredSignal(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function vercelNativeSnapshotRequiresTarFallback(manifest: Manifest): boolean {
  return manifest
    .mountTargets()
    .some(({ entry }) => isVercelCloudBucketMountEntry(entry));
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
