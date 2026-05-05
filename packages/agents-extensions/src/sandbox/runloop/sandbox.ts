import { UserError } from '@openai/agents-core';
import {
  Manifest,
  SandboxConfigurationError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxConcurrencyLimits,
  type Mount,
  type SandboxSessionState,
  type TypedMount,
  type WorkspaceArchiveData,
} from '@openai/agents-core/sandbox';
import { posix as pathPosix } from 'node:path';
import {
  assertCoreSnapshotUnsupported,
  assertTarWorkspacePersistence,
  assertResumeRecreateAllowed,
  assertRunAsUnsupported,
  assertSandboxManifestMetadataSupported,
  SANDBOX_MANIFEST_METADATA_SUPPORT,
  closeRemoteSessionOnManifestError,
  cloneManifestWithRoot,
  decodeNativeSnapshotRef,
  assertShellEnvironmentName,
  deserializeRemoteSandboxSessionStateValues,
  encodeNativeSnapshotRef,
  materializeEnvironment,
  serializeRemoteSandboxSessionState,
  shellQuote,
  isRecord,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecord,
  readOptionalString,
  readOptionalStringRecord,
  readString,
  withProviderError,
  withSandboxSpan,
  RemoteSandboxSessionBase,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../shared';
import {
  mountRcloneCloudBucket,
  rclonePatternFromMountStrategy,
  unmountRcloneMount,
  type RemoteMountCommand,
} from '../shared/inContainerMounts';
import { isRunloopCloudBucketMountEntry } from './mounts';

export const DEFAULT_RUNLOOP_WORKSPACE_ROOT = '/home/user';
export const DEFAULT_RUNLOOP_ROOT_WORKSPACE_ROOT = '/root';

type RunloopClientLike = {
  devbox: {
    create(
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<RunloopDevboxLike>;
    createFromBlueprintName(
      blueprintName: string,
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<RunloopDevboxLike>;
    createFromSnapshot?(
      snapshotId: string,
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<RunloopDevboxLike>;
    fromId(id: string): RunloopDevboxLike;
  };
  secret?: {
    create(
      params: { name: string; value: string },
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    list?(
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    update(
      secret: string,
      params: { value: string },
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    delete?(
      secret: string,
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  blueprint?: RunloopPlatformResourceLike;
  benchmark?: RunloopBenchmarkResourceLike;
  networkPolicy?: RunloopPlatformResourceLike;
  axon?: RunloopPlatformResourceLike;
  api?: Record<string, Record<string, RunloopPlatformMethodLike>>;
};

type RunloopPlatformMethodLike = (...args: unknown[]) => unknown;

type RunloopPlatformResourceLike = {
  create?: RunloopPlatformMethodLike;
  list?: RunloopPlatformMethodLike;
  fromId?: (id: string) => unknown;
};

type RunloopBenchmarkResourceLike = RunloopPlatformResourceLike & {
  retrieve?: RunloopPlatformMethodLike;
  update?: RunloopPlatformMethodLike;
  startRun?: RunloopPlatformMethodLike;
};

type RunloopDevboxLike = {
  id: string;
  cmd: {
    exec(
      command: string,
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<RunloopExecutionResultLike>;
  };
  file: {
    read(
      params: { file_path: string },
      options?: Record<string, unknown>,
    ): Promise<string>;
    write(
      params: { path: string; contents: string },
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    download(
      params: { path: string },
      options?: Record<string, unknown>,
    ): Promise<{
      buffer?: () => Promise<Buffer>;
      arrayBuffer?: () => Promise<ArrayBuffer>;
    }>;
    upload(
      params: { path: string; file: File | Blob },
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  net?: {
    enableTunnel?(
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  getTunnelUrl?(
    port: number,
    options?: Record<string, unknown>,
  ): Promise<string>;
  snapshotDisk?(
    params?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ id?: string }>;
  resume(options?: Record<string, unknown>): Promise<unknown>;
  suspend(options?: Record<string, unknown>): Promise<unknown>;
  shutdown(options?: Record<string, unknown>): Promise<unknown>;
};

type RunloopExecutionResultLike = {
  exitCode: number | null;
  stdout(numLines?: number): Promise<string>;
  stderr(numLines?: number): Promise<string>;
};

const UNKNOWN_RUNLOOP_EXIT_CODE = 1;
const DEFAULT_RUNLOOP_TUNNEL_PARAMS = {
  auth_mode: 'open',
  http_keep_alive: true,
  wake_on_http: false,
} as const;

export type RunloopUserParameters = {
  uid: number;
  username: string;
};

export interface RunloopSandboxTimeouts {
  execTimeoutMs?: number;
  createTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  fastOperationTimeoutMs?: number;
  fileUploadTimeoutMs?: number;
  fileDownloadTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  suspendTimeoutMs?: number;
  resumeTimeoutMs?: number;
}

export interface RunloopSandboxClientOptions extends SandboxClientOptions {
  blueprintName?: string;
  blueprintId?: string;
  name?: string;
  launchParameters?: Record<string, unknown>;
  exposedPorts?: number[];
  tunnel?: boolean | Record<string, unknown>;
  gateways?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  metadata?: Record<string, string>;
  managedSecrets?: Record<string, string>;
  pauseOnExit?: boolean;
  userParameters?: RunloopUserParameters;
  env?: Record<string, string>;
  apiKey?: string;
  baseUrl?: string;
  createTimeoutMs?: number;
  timeouts?: RunloopSandboxTimeouts;
}

export interface RunloopSandboxSessionState extends SandboxSessionState {
  devboxId: string;
  blueprintName?: string;
  blueprintId?: string;
  name?: string;
  launchParameters?: Record<string, unknown>;
  configuredExposedPorts?: number[];
  tunnel?: boolean | Record<string, unknown>;
  gateways?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  metadata?: Record<string, string>;
  secretRefs?: Record<string, string>;
  pauseOnExit: boolean;
  userParameters?: RunloopUserParameters;
  environment: Record<string, string>;
  baseUrl?: string;
  createTimeoutMs?: number;
  timeouts?: RunloopSandboxTimeouts;
}

type RunloopSandboxResolvedOptions = RunloopSandboxClientOptions & {
  secretRefs?: Record<string, string>;
};

export class RunloopPlatformBlueprintsClient {
  constructor(private readonly sdk: RunloopClientLike) {}

  async list(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'blueprint.list',
      this.sdk.blueprint?.list,
      params,
    );
  }

  async listPublic(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'api.blueprints.listPublic',
      this.sdk.api?.blueprints?.listPublic,
      params,
    );
  }

  get(blueprintId: string): unknown {
    return callRunloopPlatformGetter(
      'blueprint.fromId',
      this.sdk.blueprint?.fromId,
      blueprintId,
    );
  }

  async logs(
    blueprintId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'api.blueprints.logs',
      this.sdk.api?.blueprints?.logs,
      blueprintId,
      params,
    );
  }

  async create(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'blueprint.create',
      this.sdk.blueprint?.create,
      params,
    );
  }

  async awaitBuildComplete(
    blueprintId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'api.blueprints.awaitBuildComplete',
      this.sdk.api?.blueprints?.awaitBuildComplete,
      blueprintId,
      params,
    );
  }

  async delete(
    blueprintId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'blueprint.delete',
      bindRunloopMethod(this.get(blueprintId), 'delete'),
      params,
    );
  }
}

export class RunloopPlatformBenchmarksClient {
  constructor(private readonly sdk: RunloopClientLike) {}

  async list(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'benchmark.list',
      this.sdk.benchmark?.list,
      params,
    );
  }

  async listPublic(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'api.benchmarks.listPublic',
      this.sdk.api?.benchmarks?.listPublic,
      params,
    );
  }

  get(benchmarkId: string): unknown {
    if (this.sdk.benchmark?.retrieve) {
      return callRunloopPlatformMethod(
        'benchmark.retrieve',
        this.sdk.benchmark.retrieve,
        benchmarkId,
      );
    }

    return this.getBenchmarkFacade(benchmarkId);
  }

  async create(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'benchmark.create',
      this.sdk.benchmark?.create,
      params,
    );
  }

  async update(
    benchmarkId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.sdk.benchmark?.update) {
      return await callRunloopPlatformMethod(
        'benchmark.update',
        this.sdk.benchmark.update,
        benchmarkId,
        params,
      );
    }

    return await callRunloopPlatformMethod(
      'benchmark.update',
      bindRunloopMethod(this.getBenchmarkFacade(benchmarkId), 'update'),
      params,
    );
  }

  async definitions(
    benchmarkId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'api.benchmarks.definitions',
      this.sdk.api?.benchmarks?.definitions,
      benchmarkId,
      params,
    );
  }

  async startRun(
    benchmarkId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.sdk.benchmark?.startRun) {
      return await callRunloopPlatformMethod(
        'benchmark.startRun',
        this.sdk.benchmark.startRun,
        {
          ...params,
          benchmark_id: benchmarkId,
        },
      );
    }

    return await callRunloopPlatformMethod(
      'benchmark.startRun',
      bindRunloopMethod(this.getBenchmarkFacade(benchmarkId), 'startRun'),
      params,
    );
  }

  async updateScenarios(
    benchmarkId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'api.benchmarks.updateScenarios',
      this.sdk.api?.benchmarks?.updateScenarios,
      benchmarkId,
      params,
    );
  }

  private getBenchmarkFacade(benchmarkId: string): unknown {
    return callRunloopPlatformGetter(
      'benchmark.fromId',
      this.sdk.benchmark?.fromId,
      benchmarkId,
    );
  }
}

export class RunloopPlatformSecretsClient {
  constructor(private readonly sdk: RunloopClientLike) {}

  async create(params: { name: string; value: string }): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'secret.create',
      this.sdk.secret?.create as RunloopPlatformMethodLike | undefined,
      params,
    );
  }

  async list(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'secret.list',
      (this.sdk.secret as { list?: RunloopPlatformMethodLike } | undefined)
        ?.list,
      params,
    );
  }

  async get(
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'api.secrets.retrieve',
      this.sdk.api?.secrets?.retrieve,
      name,
      params,
    );
  }

  async update(params: { name: string; value: string }): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'secret.update',
      this.sdk.secret?.update as RunloopPlatformMethodLike | undefined,
      params.name,
      { value: params.value },
    );
  }

  async delete(
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'secret.delete',
      (this.sdk.secret as { delete?: RunloopPlatformMethodLike } | undefined)
        ?.delete,
      name,
      params,
    );
  }
}

export class RunloopPlatformNetworkPoliciesClient {
  constructor(private readonly sdk: RunloopClientLike) {}

  async create(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'networkPolicy.create',
      this.sdk.networkPolicy?.create,
      params,
    );
  }

  async list(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'networkPolicy.list',
      this.sdk.networkPolicy?.list,
      params,
    );
  }

  get(networkPolicyId: string): unknown {
    return callRunloopPlatformGetter(
      'networkPolicy.fromId',
      this.sdk.networkPolicy?.fromId,
      networkPolicyId,
    );
  }

  async update(
    networkPolicyId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'networkPolicy.update',
      bindRunloopMethod(this.get(networkPolicyId), 'update'),
      params,
    );
  }

  async delete(
    networkPolicyId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'networkPolicy.delete',
      bindRunloopMethod(this.get(networkPolicyId), 'delete'),
      params,
    );
  }
}

export class RunloopPlatformAxonsClient {
  constructor(private readonly sdk: RunloopClientLike) {}

  async create(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'axon.create',
      this.sdk.axon?.create,
      params,
    );
  }

  async list(params: Record<string, unknown> = {}): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'axon.list',
      this.sdk.axon?.list,
      params,
    );
  }

  get(axonId: string): unknown {
    return callRunloopPlatformGetter(
      'axon.fromId',
      this.sdk.axon?.fromId,
      axonId,
    );
  }

  async publish(
    axonId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await callRunloopPlatformMethod(
      'axon.publish',
      bindRunloopMethod(this.get(axonId), 'publish'),
      params,
    );
  }

  async querySql(
    axonId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const axon = this.get(axonId) as {
      sql?: unknown;
    };
    return await callRunloopPlatformMethod(
      'axon.sql.query',
      bindRunloopMethod(axon.sql, 'query'),
      params,
    );
  }

  async batchSql(
    axonId: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const axon = this.get(axonId) as {
      sql?: unknown;
    };
    return await callRunloopPlatformMethod(
      'axon.sql.batch',
      bindRunloopMethod(axon.sql, 'batch'),
      params,
    );
  }
}

export class RunloopPlatformClient {
  constructor(private readonly sdk: RunloopClientLike) {}

  get blueprints(): RunloopPlatformBlueprintsClient {
    return new RunloopPlatformBlueprintsClient(this.sdk);
  }

  get benchmarks(): RunloopPlatformBenchmarksClient {
    return new RunloopPlatformBenchmarksClient(this.sdk);
  }

  get secrets(): RunloopPlatformSecretsClient {
    return new RunloopPlatformSecretsClient(this.sdk);
  }

  get networkPolicies(): RunloopPlatformNetworkPoliciesClient {
    return new RunloopPlatformNetworkPoliciesClient(this.sdk);
  }

  get axons(): RunloopPlatformAxonsClient {
    return new RunloopPlatformAxonsClient(this.sdk);
  }
}

export class RunloopSandboxSession extends RemoteSandboxSessionBase<RunloopSandboxSessionState> {
  private readonly sdk: RunloopClientLike;
  private devbox: RunloopDevboxLike;
  private readonly activeMountPaths = new Set<string>();

  constructor(args: {
    state: RunloopSandboxSessionState;
    sdk: RunloopClientLike;
    devbox: RunloopDevboxLike;
    concurrencyLimits?: SandboxConcurrencyLimits;
  }) {
    super({
      state: args.state,
      options: {
        providerName: 'RunloopSandboxClient',
        providerId: 'runloop',
        concurrencyLimits: args.concurrencyLimits,
      },
    });
    this.sdk = args.sdk;
    this.devbox = args.devbox;
  }

  override supportsPty(): boolean {
    return false;
  }

  protected override exposedPortSource(): string {
    return 'tunnel URL';
  }

  protected override async resolveRemoteExposedPort(
    port: number,
  ): Promise<string> {
    return await this.ensureTunnelUrl(port);
  }

  protected override resolveManifestForApply(manifest: Manifest): Manifest {
    return resolveRunloopManifestRoot(
      manifest,
      this.state.userParameters,
      true,
    );
  }

  protected override async beforeApplyManifest(
    manifest: Manifest,
  ): Promise<void> {
    await this.ensureManifestRoot(manifest.root);
  }

  async persistWorkspace(): Promise<Uint8Array> {
    const snapshot = await this.persistWorkspaceViaNativeSnapshot();
    if (snapshot) {
      return snapshot;
    }

    assertTarWorkspacePersistence('RunloopSandboxClient', 'tar');
    return await this.persistWorkspaceTar();
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    const snapshotRef = decodeNativeSnapshotRef(data);
    if (snapshotRef?.provider === 'runloop') {
      await this.replaceDevboxFromSnapshot(snapshotRef.snapshotId);
      return;
    }

    assertTarWorkspacePersistence('RunloopSandboxClient', 'tar');
    await this.hydrateWorkspaceTar(data);
  }

  async close(): Promise<void> {
    if (this.state.pauseOnExit) {
      await withSandboxSpan(
        'sandbox.stop',
        {
          backend_id: 'runloop',
          devbox_id: this.state.devboxId,
        },
        async () => {
          await this.devbox.suspend(
            runloopRequestOptions(this.state.timeouts?.suspendTimeoutMs),
          );
        },
      );
      return;
    }

    await withSandboxSpan(
      'sandbox.shutdown',
      {
        backend_id: 'runloop',
        devbox_id: this.state.devboxId,
      },
      async () => {
        await this.unmountActiveMounts();
        await this.devbox.shutdown(
          runloopRequestOptions(this.state.timeouts?.cleanupTimeoutMs),
        );
      },
    );
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  async delete(): Promise<void> {
    await withSandboxSpan(
      'sandbox.shutdown',
      {
        backend_id: 'runloop',
        devbox_id: this.state.devboxId,
      },
      async () => {
        await this.unmountActiveMounts();
        await this.devbox.shutdown(
          runloopRequestOptions(this.state.timeouts?.cleanupTimeoutMs),
        );
      },
    );
  }

  private async persistWorkspaceViaNativeSnapshot(): Promise<
    Uint8Array | undefined
  > {
    if (this.nativeSnapshotRequiresTarFallback()) {
      return undefined;
    }
    if (!this.devbox.snapshotDisk) {
      return undefined;
    }

    let snapshot: { id?: string };
    try {
      const snapshotOptions = runloopLongPollOptions(
        this.state.timeouts?.snapshotTimeoutMs,
      );
      const snapshotParams = {
        name: `sandbox-${this.state.devboxId}`,
        metadata: {
          openai_agents_devbox_id: this.state.devboxId,
        },
      };
      snapshot = snapshotOptions
        ? await this.devbox.snapshotDisk(snapshotParams, snapshotOptions)
        : await this.devbox.snapshotDisk(snapshotParams);
    } catch (error) {
      throw new SandboxProviderError(
        'RunloopSandboxClient failed to create a native disk snapshot.',
        {
          provider: 'runloop',
          devboxId: this.state.devboxId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    if (!snapshot.id) {
      throw new SandboxProviderError(
        'RunloopSandboxClient native disk snapshot did not return a snapshot id.',
        {
          provider: 'runloop',
          devboxId: this.state.devboxId,
        },
      );
    }

    return encodeNativeSnapshotRef({
      provider: 'runloop',
      snapshotId: snapshot.id,
    });
  }

  private nativeSnapshotRequiresTarFallback(): boolean {
    return this.state.manifest.ephemeralPersistencePaths().size > 0;
  }

  private async replaceDevboxFromSnapshot(snapshotId: string): Promise<void> {
    if (!this.sdk.devbox.createFromSnapshot) {
      throw new SandboxProviderError(
        'RunloopSandboxClient native snapshot restore requires createFromSnapshot(snapshotId).',
        {
          provider: 'runloop',
          snapshotId,
        },
      );
    }

    const previousDevbox = this.devbox;
    const previousActiveMountPaths = new Set(this.activeMountPaths);
    let devbox: RunloopDevboxLike;
    try {
      devbox = await this.sdk.devbox.createFromSnapshot(
        snapshotId,
        createRunloopParams(this.state, this.state.environment, {
          includeBlueprint: false,
          includeSecrets: false,
        }),
        createRunloopOptions(this.state),
      );
    } catch (error) {
      throw new SandboxProviderError(
        'RunloopSandboxClient failed to restore a native disk snapshot.',
        {
          provider: 'runloop',
          snapshotId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const previousDevboxId = this.state.devboxId;
    this.devbox = devbox;
    this.state.devboxId = devbox.id;
    this.activeMountPaths.clear();
    invalidateRunloopRuntimeCaches(this.state);
    try {
      await rematerializeRunloopManifestMounts(this, this.state.manifest);
    } catch (error) {
      let replacementCleanupCause: string | undefined;
      try {
        await this.unmountActiveMounts();
      } catch (unmountError) {
        replacementCleanupCause = errorMessage(unmountError);
      }
      try {
        await devbox.shutdown();
      } catch (shutdownError) {
        replacementCleanupCause = replacementCleanupCause
          ? `${replacementCleanupCause}; ${errorMessage(shutdownError)}`
          : errorMessage(shutdownError);
      }
      this.devbox = previousDevbox;
      this.state.devboxId = previousDevboxId;
      this.activeMountPaths.clear();
      for (const mountPath of previousActiveMountPaths) {
        this.activeMountPaths.add(mountPath);
      }
      invalidateRunloopRuntimeCaches(this.state);
      throw new SandboxProviderError(
        'RunloopSandboxClient native snapshot restore failed while rematerializing mounts.',
        {
          provider: 'runloop',
          devboxId: previousDevboxId,
          replacementDevboxId: devbox.id,
          snapshotId,
          cause: errorMessage(error),
          ...(replacementCleanupCause ? { replacementCleanupCause } : {}),
        },
      );
    }

    try {
      await previousDevbox.shutdown();
    } catch (error) {
      let replacementShutdownCause: string | undefined;
      try {
        await this.unmountActiveMounts();
      } catch (unmountError) {
        replacementShutdownCause = errorMessage(unmountError);
      }
      try {
        await devbox.shutdown();
      } catch (replacementShutdownError) {
        replacementShutdownCause = replacementShutdownCause
          ? `${replacementShutdownCause}; ${errorMessage(replacementShutdownError)}`
          : errorMessage(replacementShutdownError);
      }
      this.devbox = previousDevbox;
      this.state.devboxId = previousDevboxId;
      this.activeMountPaths.clear();
      for (const mountPath of previousActiveMountPaths) {
        this.activeMountPaths.add(mountPath);
      }
      invalidateRunloopRuntimeCaches(this.state);
      throw new SandboxProviderError(
        'RunloopSandboxClient native snapshot restore created a replacement devbox, but shutting down the previous devbox failed.',
        {
          provider: 'runloop',
          devboxId: previousDevbox.id,
          replacementDevboxId: devbox.id,
          snapshotId,
          cause: errorMessage(error),
          ...(replacementShutdownCause ? { replacementShutdownCause } : {}),
        },
      );
    }
  }

  protected override manifestMetadataSupport() {
    return SANDBOX_MANIFEST_METADATA_SUPPORT;
  }

  protected override manifestMaterializationOptions() {
    return {
      materializeMount: this.materializeMountEntry.bind(this),
    };
  }

  protected override assertExecRunAs(_runAs?: string): void {
    void _runAs;
  }

  protected override assertFilesystemRunAs(_runAs?: string): void {
    assertRunAsUnsupported('RunloopSandboxClient', _runAs);
  }

  private async materializeMountEntry(
    absolutePath: string,
    entry: Mount | TypedMount,
  ): Promise<void> {
    if (!isRunloopCloudBucketMountEntry(entry)) {
      throw new SandboxUnsupportedFeatureError(
        'RunloopSandboxClient only supports RunloopCloudBucketMountStrategy mount entries.',
        {
          provider: 'runloop',
          feature: 'entry.mountStrategy',
          path: absolutePath,
          mountType: entry.type,
          strategyType: entry.mountStrategy?.type,
        },
      );
    }
    const mountPath = await this.resolveRemotePath(
      entry.mountPath ?? absolutePath,
      { forWrite: true },
    );
    await mountRcloneCloudBucket({
      providerName: 'RunloopSandboxClient',
      providerId: 'runloop',
      strategyType: 'runloop_cloud_bucket',
      entry,
      mountPath,
      pattern: rclonePatternFromMountStrategy(entry.mountStrategy),
      runCommand: this.mountCommandRunner(),
      writeFile: this.writeRemoteFile.bind(this),
      packageManagers: ['apt'],
      installRcloneViaScript: true,
    });
    this.activeMountPaths.add(mountPath);
  }

  async rematerializeManifestMounts(manifest: Manifest): Promise<void> {
    for (const {
      absolutePath,
      entry,
    } of manifest.mountTargetsForMaterialization()) {
      await this.materializeMountEntry(absolutePath, structuredClone(entry));
    }
  }

  async cleanupAfterFailedResume(): Promise<void> {
    await this.unmountActiveMounts().catch(() => {});
    if (this.state.pauseOnExit) {
      await this.devbox
        .suspend(runloopRequestOptions(this.state.timeouts?.suspendTimeoutMs))
        .catch(() => {});
      return;
    }
    await this.devbox
      .shutdown(runloopRequestOptions(this.state.timeouts?.cleanupTimeoutMs))
      .catch(() => {});
  }

  async ensureCurrentManifestRoot(): Promise<void> {
    await this.ensureManifestRoot(this.state.manifest.root);
  }

  private async unmountActiveMounts(): Promise<void> {
    for (const mountPath of [...this.activeMountPaths].reverse()) {
      await unmountRcloneMount({
        providerName: 'RunloopSandboxClient',
        providerId: 'runloop',
        mountPath,
        runCommand: this.mountCommandRunner(),
      }).catch(() => {});
      this.activeMountPaths.delete(mountPath);
    }
  }

  private mountCommandRunner(): RemoteMountCommand {
    return async (command, options = {}) => {
      const result = await this.execShellWithEnvironment(
        command,
        undefined,
        options.timeoutMs ?? this.state.timeouts?.fastOperationTimeoutMs,
        mountCommandEnvironment(
          this.state.environment,
          options.user,
          this.state.userParameters,
        ),
        options.user,
      );
      return {
        status: runloopExitStatus(result),
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      };
    };
  }

  private async ensureManifestRoot(root: string): Promise<void> {
    const home = effectiveRunloopHome(this.state.userParameters);
    const rootParent = root === home ? root : pathPosix.dirname(root);
    const result = await this.execShellInWorkdir(
      [
        `home_real=$(cd -- ${shellQuote(home)} && pwd -P)`,
        `root_ancestor=${shellQuote(rootParent)}`,
        'while [ ! -e "$root_ancestor" ]; do parent=$(dirname -- "$root_ancestor"); [ "$parent" = "$root_ancestor" ] && break; root_ancestor="$parent"; done',
        'ancestor_real=$(cd -- "$root_ancestor" && pwd -P)',
        `printf 'OPENAI_AGENTS_REALPATH_HOME=%s\\nOPENAI_AGENTS_REALPATH_ANCESTOR=%s\\n' "$home_real" "$ancestor_real"`,
        'case "$ancestor_real" in "$home_real"|"$home_real"/*) ancestor_confined=1 ;; *) ancestor_confined=0 ;; esac',
        `if [ "$home_real" = / ] || [ "$ancestor_confined" != 1 ]; then printf 'OPENAI_AGENTS_REALPATH_ROOT=%s\\n' ''; exit 0; fi`,
        `mkdir -p -- ${shellQuote(root)}`,
        `root_real=$(cd -- ${shellQuote(root)} && pwd -P)`,
        `printf 'OPENAI_AGENTS_REALPATH_ROOT=%s\\n' "$root_real"`,
      ].join(' && '),
      home,
      this.state.timeouts?.fastOperationTimeoutMs,
      {},
    );
    if (!runloopSucceeded(result)) {
      throw new SandboxProviderError(
        'RunloopSandboxClient failed to prepare the workspace root.',
        {
          provider: 'runloop',
          root,
          exitCode: runloopExitStatus(result),
          stderr: await result.stderr(),
        },
      );
    }
    assertRunloopManifestRootRealPath(root, home, await result.stdout());
  }

  private async execShellWithEnvironment(
    command: string,
    workdir: string | undefined,
    timeoutMs: number | undefined,
    environment: Record<string, string>,
    user?: string,
  ): Promise<RunloopExecutionResultLike> {
    return await this.execShellInWorkdir(
      command,
      this.resolveWorkdir(workdir),
      timeoutMs,
      environment,
      user,
    );
  }

  private async execShellInWorkdir(
    command: string,
    workdir: string,
    timeoutMs: number | undefined,
    environment: Record<string, string>,
    user?: string,
  ): Promise<RunloopExecutionResultLike> {
    const shellCommand = buildShellCommand(
      command,
      environment,
      workdir,
      user,
      this.state.userParameters,
    );
    const params = {
      last_n: '2000',
    };
    const options = runloopLongPollOptions(timeoutMs);
    return options
      ? await this.devbox.cmd.exec(shellCommand, params, options)
      : await this.devbox.cmd.exec(shellCommand, params);
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    const result = await this.execShellInWorkdir(
      command,
      options.workdir,
      options.timeoutMs ?? this.timeoutForCommand(options),
      remoteCommandEnvironment(this.state.environment, options),
      options.runAs,
    );
    return {
      status: runloopExitStatus(result),
      stdout: await result.stdout(),
      stderr: await result.stderr(),
    };
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    const result = await this.runRemoteCommand(
      `mkdir -p -- ${shellQuote(path)}`,
      {
        kind: 'manifest',
        workdir: this.state.manifest.root,
        timeoutMs: this.state.timeouts?.fastOperationTimeoutMs,
      },
    );
    this.assertRemoteCommandSucceeded(result, 'create directory', path);
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return await this.devbox.file.read({
      file_path: path,
    });
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    const downloadOptions = runloopRequestOptions(
      this.state.timeouts?.fileDownloadTimeoutMs,
    );
    const response = downloadOptions
      ? await this.devbox.file.download({ path }, downloadOptions)
      : await this.devbox.file.download({ path });
    if (response.buffer) {
      return Uint8Array.from(await response.buffer());
    }
    return new Uint8Array(await response.arrayBuffer!());
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const uploadOptions = runloopRequestOptions(
      this.state.timeouts?.fileUploadTimeoutMs,
    );
    const uploadParams = {
      path,
      file: new File(
        [typeof content === 'string' ? content : Uint8Array.from(content)],
        basename(path),
      ),
    };
    if (uploadOptions) {
      await this.devbox.file.upload(uploadParams, uploadOptions);
    } else {
      await this.devbox.file.upload(uploadParams);
    }
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    const result = await this.runRemoteCommand(`rm -f -- ${shellQuote(path)}`, {
      kind: 'manifest',
      workdir: this.state.manifest.root,
      timeoutMs: this.state.timeouts?.fastOperationTimeoutMs,
    });
    this.assertRemoteCommandSucceeded(result, 'delete path', path);
  }

  private assertRemoteCommandSucceeded(
    result: RemoteSandboxCommandResult,
    operation: string,
    path: string,
  ): void {
    if (result.status === 0) {
      return;
    }
    throw new SandboxProviderError(
      `RunloopSandboxClient failed to ${operation}.`,
      {
        provider: 'runloop',
        operation,
        devboxId: this.state.devboxId,
        path,
        exitCode: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      },
    );
  }

  private timeoutForCommand(
    options: RemoteSandboxCommandOptions,
  ): number | undefined {
    if (options.kind === 'exec') {
      return this.state.timeouts?.execTimeoutMs;
    }
    if (options.kind === 'running') {
      return this.state.timeouts?.keepAliveTimeoutMs;
    }
    if (options.kind === 'archive') {
      return this.state.timeouts?.snapshotTimeoutMs;
    }
    if (options.kind === 'path' || options.kind === 'manifest') {
      return this.state.timeouts?.fastOperationTimeoutMs;
    }
    return undefined;
  }

  private async ensureTunnelUrl(port: number): Promise<string> {
    const existingUrl = await this.getTunnelUrl(port);
    if (existingUrl) {
      return existingUrl;
    }

    if (!this.devbox.net?.enableTunnel) {
      throw new SandboxProviderError(
        'RunloopSandboxClient exposed port resolution requires a Runloop tunnel API.',
        {
          provider: 'runloop',
          port,
        },
      );
    }

    try {
      const tunnelOptions = runloopRequestOptions(
        this.state.timeouts?.fastOperationTimeoutMs,
      );
      const tunnelParams = runloopTunnelEnableParams(this.state.tunnel);
      if (!tunnelParams) {
        throw new SandboxProviderError(
          `RunloopSandboxClient cannot enable a tunnel for exposed port ${port} because tunnel is disabled.`,
          {
            provider: 'runloop',
            port,
          },
        );
      }
      if (tunnelOptions) {
        await this.devbox.net.enableTunnel(tunnelParams, tunnelOptions);
      } else {
        await this.devbox.net.enableTunnel(tunnelParams);
      }
    } catch (error) {
      throw new SandboxProviderError(
        `RunloopSandboxClient failed to enable a tunnel for exposed port ${port}.`,
        {
          provider: 'runloop',
          port,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const enabledUrl = await this.getTunnelUrl(port);
    if (!enabledUrl) {
      throw new SandboxProviderError(
        `RunloopSandboxClient did not return a tunnel URL for exposed port ${port}.`,
        {
          provider: 'runloop',
          port,
        },
      );
    }
    return enabledUrl;
  }

  private async getTunnelUrl(port: number): Promise<string | undefined> {
    if (!this.devbox.getTunnelUrl) {
      throw new SandboxProviderError(
        'RunloopSandboxClient exposed port resolution requires getTunnelUrl(port).',
        {
          provider: 'runloop',
          port,
        },
      );
    }

    try {
      const tunnelOptions = runloopRequestOptions(
        this.state.timeouts?.fastOperationTimeoutMs,
      );
      const url = tunnelOptions
        ? await this.devbox.getTunnelUrl(port, tunnelOptions)
        : await this.devbox.getTunnelUrl(port);
      return typeof url === 'string' && url ? url : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * @see {@link https://docs.runloop.ai/docs/devboxes/overview | Devbox overview}.
 * @see {@link https://docs.runloop.ai/docs/devboxes/start-stop | Devbox lifecycle}.
 * @see {@link https://runloopai.github.io/api-client-ts/stable/classes/sdk.DevboxOps.html | TypeScript SDK Devbox reference}.
 */
export class RunloopSandboxClient implements SandboxClient<
  RunloopSandboxClientOptions,
  RunloopSandboxSessionState
> {
  readonly backendId = 'runloop';
  private readonly options: RunloopSandboxClientOptions;

  constructor(options: RunloopSandboxClientOptions = {}) {
    this.options = options;
  }

  async platform(): Promise<RunloopPlatformClient> {
    return new RunloopPlatformClient(await createRunloopClient(this.options));
  }

  async create(
    args?: SandboxClientCreateArgs<RunloopSandboxClientOptions> | Manifest,
    manifestOptions?: RunloopSandboxClientOptions,
  ): Promise<RunloopSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported('RunloopSandboxClient', createArgs.snapshot);
    const resolvedOptions: RunloopSandboxResolvedOptions = {
      ...this.options,
      ...createArgs.options,
    };
    const timeouts = resolveRunloopTimeouts(resolvedOptions);
    const manifest = resolveRunloopManifestRoot(
      createArgs.manifest,
      resolvedOptions.userParameters,
      false,
    );
    assertSandboxManifestMetadataSupported(
      'RunloopSandboxClient',
      manifest,
      SANDBOX_MANIFEST_METADATA_SUPPORT,
    );
    const sdk = await createRunloopClient(resolvedOptions);

    return await withSandboxSpan(
      'sandbox.start',
      {
        backend_id: this.backendId,
      },
      async () => {
        const environment = await materializeEnvironment(
          manifest,
          resolvedOptions.env,
        );
        const createParams: Record<string, unknown> = {
          environment_variables: environment,
        };
        const createBlueprintId = resolvedOptions.blueprintName
          ? undefined
          : resolvedOptions.blueprintId;
        for (const key of [
          'blueprintId',
          'name',
          'exposedPorts',
          'tunnel',
          'gateways',
          'mcp',
          'metadata',
        ] as const) {
          const value =
            key === 'blueprintId' ? createBlueprintId : resolvedOptions[key];
          if (value !== undefined) {
            createParams[toSnakeCase(key)] = value;
          }
        }

        if (
          resolvedOptions.userParameters ||
          resolvedOptions.launchParameters
        ) {
          createParams.launch_parameters = {
            ...(resolvedOptions.launchParameters ?? {}),
            user_parameters: resolvedOptions.userParameters,
          };
        }

        const createOptions = runloopLongPollOptions(timeouts.createTimeoutMs);
        const secretRefs =
          resolvedOptions.secretRefs ??
          (await upsertRunloopManagedSecrets(
            sdk,
            resolvedOptions.managedSecrets,
            runloopRequestOptions(timeouts.fastOperationTimeoutMs) ??
              createOptions,
          ));
        const persistedSecretRefs =
          Object.keys(secretRefs).length > 0 ? secretRefs : undefined;
        if (persistedSecretRefs) {
          createParams.secrets = persistedSecretRefs;
        }
        const devbox = await withProviderError(
          'RunloopSandboxClient',
          'runloop',
          'create devbox',
          async () =>
            resolvedOptions.blueprintName
              ? await sdk.devbox.createFromBlueprintName(
                  resolvedOptions.blueprintName,
                  createParams,
                  createOptions,
                )
              : await sdk.devbox.create(createParams, createOptions),
          {
            blueprintName: resolvedOptions.blueprintName,
            blueprintId: createBlueprintId,
          },
        );

        const session = new RunloopSandboxSession({
          sdk,
          devbox,
          concurrencyLimits: createArgs.concurrencyLimits,
          state: {
            manifest,
            devboxId: devbox.id,
            blueprintName: resolvedOptions.blueprintName,
            blueprintId: createBlueprintId,
            name: resolvedOptions.name,
            launchParameters: resolvedOptions.launchParameters,
            configuredExposedPorts: resolvedOptions.exposedPorts,
            tunnel: resolvedOptions.tunnel,
            gateways: resolvedOptions.gateways,
            mcp: resolvedOptions.mcp,
            metadata: resolvedOptions.metadata,
            secretRefs: persistedSecretRefs,
            pauseOnExit: resolvedOptions.pauseOnExit ?? false,
            userParameters: resolvedOptions.userParameters,
            environment,
            baseUrl: resolvedOptions.baseUrl,
            createTimeoutMs: timeouts.createTimeoutMs,
            timeouts,
          },
        });

        try {
          await session.applyManifest(manifest);
        } catch (error) {
          session.state.pauseOnExit = false;
          await closeRemoteSessionOnManifestError('Runloop', session, error);
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: RunloopSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    const { managedSecrets: _managedSecrets, ...serializableState } =
      state as RunloopSandboxSessionState & {
        managedSecrets?: Record<string, string>;
      };
    return serializeRemoteSandboxSessionState(serializableState);
  }

  canPersistOwnedSessionState(state: RunloopSandboxSessionState): boolean {
    return state.pauseOnExit;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<RunloopSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    const { managedSecrets: _managedSecrets, ...rest } = state;
    return {
      ...rest,
      ...baseState,
      devboxId: readString(state, 'devboxId'),
      blueprintName: readOptionalString(state, 'blueprintName'),
      blueprintId: readOptionalString(state, 'blueprintId'),
      name: readOptionalString(state, 'name'),
      launchParameters: readOptionalRecord(state.launchParameters),
      configuredExposedPorts: readOptionalNumberArray(
        state.configuredExposedPorts,
      ),
      tunnel:
        typeof state.tunnel === 'boolean' || isRecord(state.tunnel)
          ? (state.tunnel as boolean | Record<string, unknown>)
          : undefined,
      gateways: readOptionalRecord(state.gateways),
      mcp: readOptionalRecord(state.mcp),
      metadata: readOptionalStringRecord(state.metadata),
      secretRefs: readOptionalStringRecord(state.secretRefs),
      pauseOnExit: Boolean(state.pauseOnExit),
      userParameters:
        typeof state.userParameters === 'object' && state.userParameters
          ? (state.userParameters as RunloopUserParameters)
          : undefined,
      baseUrl: readOptionalString(state, 'baseUrl'),
      createTimeoutMs: readOptionalNumber(state, 'createTimeoutMs'),
      timeouts: resolveRunloopTimeouts({
        createTimeoutMs: readOptionalNumber(state, 'createTimeoutMs'),
        timeouts: isRecord(state.timeouts)
          ? (state.timeouts as RunloopSandboxTimeouts)
          : undefined,
      }),
    };
  }

  async resume(
    state: RunloopSandboxSessionState,
  ): Promise<RunloopSandboxSession> {
    const resumeState: RunloopSandboxSessionState = {
      ...state,
      baseUrl: this.options.baseUrl,
      launchParameters: this.options.launchParameters,
      userParameters: this.options.userParameters,
      manifest: resolveRunloopManifestRoot(
        state.manifest,
        this.options.userParameters,
        true,
      ),
    };
    const sdk = await createRunloopClient(this.options);
    try {
      const devbox = sdk.devbox.fromId(resumeState.devboxId);
      if (resumeState.pauseOnExit) {
        await devbox.resume(
          runloopLongPollOptions(resumeState.timeouts?.resumeTimeoutMs),
        );
      }
      invalidateRunloopRuntimeCaches(resumeState);
      const session = new RunloopSandboxSession({
        state: resumeState,
        sdk,
        devbox,
      });
      try {
        await session.ensureCurrentManifestRoot();
        await rematerializeRunloopManifestMounts(session, resumeState.manifest);
      } catch (error) {
        await session.cleanupAfterFailedResume();
        throw error;
      }
      return session;
    } catch (error) {
      assertResumeRecreateAllowed(error, {
        providerName: 'RunloopSandboxClient',
        provider: 'runloop',
        details: { devboxId: resumeState.devboxId },
      });
      assertRunloopResumeRecreateSecretRefsTrusted(resumeState, this.options);
      const recreateOptions: RunloopSandboxResolvedOptions = {
        blueprintName: this.options.blueprintName,
        blueprintId: this.options.blueprintId,
        name: resumeState.name,
        launchParameters: this.options.launchParameters,
        exposedPorts: resumeState.configuredExposedPorts,
        tunnel: resumeState.tunnel,
        gateways: resumeState.gateways,
        mcp: resumeState.mcp,
        metadata: resumeState.metadata,
        managedSecrets: this.options.managedSecrets,
        pauseOnExit: resumeState.pauseOnExit,
        userParameters: this.options.userParameters,
        env: this.options.env,
        baseUrl: this.options.baseUrl,
        createTimeoutMs: resumeState.createTimeoutMs,
        timeouts: resumeState.timeouts,
      };
      return await this.create(resumeState.manifest, recreateOptions);
    }
  }
}

async function createRunloopClient(
  options: Pick<RunloopSandboxClientOptions, 'apiKey' | 'baseUrl'>,
): Promise<RunloopClientLike> {
  try {
    const { RunloopSDK } = await import('@runloop/api-client');
    return adaptRunloopClient(
      new RunloopSDK({
        ...(options.apiKey ? { bearerToken: options.apiKey } : {}),
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      }),
    );
  } catch (error) {
    throw new UserError(
      `Runloop sandbox support requires the optional \`@runloop/api-client\` package. Install it before using Runloop-backed sandbox examples. ${(error as Error).message}`,
    );
  }
}

function adaptRunloopClient(
  sdk: import('@runloop/api-client').RunloopSDK,
): RunloopClientLike {
  const createFromSnapshot = bindRunloopMethod(
    sdk.devbox,
    'createFromSnapshot',
  );
  const secretList = bindRunloopMethod(sdk.secret, 'list');
  const secretDelete = bindRunloopMethod(sdk.secret, 'delete');
  return {
    devbox: {
      create: async (params, options) =>
        adaptRunloopDevbox(
          await sdk.devbox.create(
            params as Parameters<typeof sdk.devbox.create>[0],
            options as Parameters<typeof sdk.devbox.create>[1],
          ),
        ),
      createFromBlueprintName: async (blueprintName, params, options) =>
        adaptRunloopDevbox(
          await sdk.devbox.createFromBlueprintName(
            blueprintName,
            params as Parameters<typeof sdk.devbox.createFromBlueprintName>[1],
            options as Parameters<typeof sdk.devbox.createFromBlueprintName>[2],
          ),
        ),
      ...(createFromSnapshot
        ? {
            createFromSnapshot: async (snapshotId, params, options) =>
              adaptRunloopDevbox(
                (await createFromSnapshot(
                  snapshotId,
                  params,
                  options,
                )) as import('@runloop/api-client').Devbox,
              ),
          }
        : {}),
      fromId: (id) => adaptRunloopDevbox(sdk.devbox.fromId(id)),
    },
    secret: {
      create: async (...args) => {
        const [params, options] = args;
        const createParams = params as Parameters<typeof sdk.secret.create>[0];
        return args.length > 1
          ? await sdk.secret.create(
              createParams,
              options as Parameters<typeof sdk.secret.create>[1],
            )
          : await sdk.secret.create(createParams);
      },
      update: async (...args) => {
        const [secret, params, options] = args;
        const updateParams = params as Parameters<typeof sdk.secret.update>[1];
        return args.length > 2
          ? await sdk.secret.update(
              secret,
              updateParams,
              options as Parameters<typeof sdk.secret.update>[2],
            )
          : await sdk.secret.update(secret, updateParams);
      },
      ...(secretList
        ? {
            list: async (...args) => {
              const [params, options] = args;
              return args.length > 1
                ? await secretList(params, options)
                : await secretList(params);
            },
          }
        : {}),
      ...(secretDelete
        ? {
            delete: async (...args) => {
              const [secret, params, options] = args;
              return args.length > 2
                ? await secretDelete(secret, params, options)
                : await secretDelete(secret, params);
            },
          }
        : {}),
    },
    blueprint: adaptRunloopPlatformResource(sdk.blueprint),
    benchmark: adaptRunloopBenchmarkResource(sdk),
    networkPolicy: adaptRunloopPlatformResource(sdk.networkPolicy),
    axon: adaptRunloopPlatformResource(sdk.axon),
    api: adaptRunloopApi(sdk),
  };
}

function adaptRunloopDevbox(
  devbox: import('@runloop/api-client').Devbox,
): RunloopDevboxLike {
  const enableTunnel = bindRunloopMethod(
    (devbox as { net?: unknown }).net,
    'enableTunnel',
  );
  const getTunnelUrl = bindRunloopMethod(devbox, 'getTunnelUrl');
  const snapshotDisk = bindRunloopMethod(devbox, 'snapshotDisk');

  return {
    id: devbox.id,
    cmd: {
      exec: async (...args) => {
        const [command, params, options] = args;
        if (args.length > 2) {
          return await devbox.cmd.exec(
            command,
            params as Parameters<typeof devbox.cmd.exec>[1],
            options as Parameters<typeof devbox.cmd.exec>[2],
          );
        }
        return args.length > 1
          ? await devbox.cmd.exec(
              command,
              params as Parameters<typeof devbox.cmd.exec>[1],
            )
          : await devbox.cmd.exec(command);
      },
    },
    file: {
      read: async (params, options) =>
        await devbox.file.read(
          params as Parameters<typeof devbox.file.read>[0],
          options as Parameters<typeof devbox.file.read>[1],
        ),
      write: async (params, options) =>
        await devbox.file.write(
          {
            file_path: params.path,
            contents: params.contents,
          },
          options as Parameters<typeof devbox.file.write>[1],
        ),
      download: async (params, options) =>
        await devbox.file.download(
          params as Parameters<typeof devbox.file.download>[0],
          options as Parameters<typeof devbox.file.download>[1],
        ),
      upload: async (params, options) => {
        const uploadParams = params as Parameters<typeof devbox.file.upload>[0];
        return options
          ? await devbox.file.upload(
              uploadParams,
              options as Parameters<typeof devbox.file.upload>[1],
            )
          : await devbox.file.upload(uploadParams);
      },
    },
    ...(enableTunnel
      ? {
          net: {
            enableTunnel: async (params, options) =>
              options
                ? await enableTunnel(params, options)
                : await enableTunnel(params),
          },
        }
      : {}),
    ...(getTunnelUrl
      ? {
          getTunnelUrl: async (port, options) =>
            (options
              ? await getTunnelUrl(port, options)
              : await getTunnelUrl(port)) as string,
        }
      : {}),
    ...(snapshotDisk
      ? {
          snapshotDisk: async (params, options) =>
            (options
              ? await snapshotDisk(params, options)
              : await snapshotDisk(params)) as { id?: string },
        }
      : {}),
    resume: async (options) =>
      await devbox.resume(options as Parameters<typeof devbox.resume>[0]),
    suspend: async (options) =>
      await devbox.suspend(options as Parameters<typeof devbox.suspend>[0]),
    shutdown: async (options) =>
      await devbox.shutdown(options as Parameters<typeof devbox.shutdown>[0]),
  };
}

function adaptRunloopPlatformResource(
  resource: unknown,
): RunloopPlatformResourceLike | undefined {
  if (!isRecord(resource)) {
    return undefined;
  }
  const fromId = resource.fromId;
  return {
    create: bindRunloopMethod(resource, 'create'),
    list: bindRunloopMethod(resource, 'list'),
    fromId:
      typeof fromId === 'function'
        ? (id) => fromId.call(resource, id)
        : undefined,
  };
}

function adaptRunloopBenchmarkResource(
  sdk: import('@runloop/api-client').RunloopSDK,
): RunloopBenchmarkResourceLike | undefined {
  const apiBenchmarks = (sdk as { api?: { benchmarks?: unknown } }).api
    ?.benchmarks;
  const apiResource = adaptRunloopApiBenchmarkResource(apiBenchmarks);
  if (apiResource) {
    return apiResource;
  }
  return adaptRunloopPlatformResource(
    (sdk as { benchmark?: unknown }).benchmark,
  );
}

function adaptRunloopApiBenchmarkResource(
  resource: unknown,
): RunloopBenchmarkResourceLike | undefined {
  if (!isRecord(resource)) {
    return undefined;
  }
  const adapted: RunloopBenchmarkResourceLike = {
    create: bindRunloopMethod(resource, 'create'),
    list: bindRunloopMethod(resource, 'list'),
    retrieve: bindRunloopMethod(resource, 'retrieve'),
    update: bindRunloopMethod(resource, 'update'),
    startRun: bindRunloopMethod(resource, 'startRun'),
  };
  return Object.values(adapted).some((value) => typeof value === 'function')
    ? adapted
    : undefined;
}

function adaptRunloopApi(
  sdk: import('@runloop/api-client').RunloopSDK,
): Record<string, Record<string, RunloopPlatformMethodLike>> {
  const apiClient = (sdk as { api?: unknown }).api;
  if (!isRecord(apiClient)) {
    return {};
  }
  const api: Record<string, Record<string, RunloopPlatformMethodLike>> = {};
  const blueprintsResource = apiClient.blueprints;
  const benchmarksResource = apiClient.benchmarks;
  const secretsResource = apiClient.secrets;
  const blueprints = runloopApiResource({
    listPublic: bindRunloopMethod(blueprintsResource, 'listPublic'),
    logs: bindRunloopMethod(blueprintsResource, 'logs'),
    awaitBuildComplete: bindRunloopMethod(
      blueprintsResource,
      'awaitBuildComplete',
    ),
  });
  if (Object.keys(blueprints).length > 0) {
    api.blueprints = blueprints;
  }

  const benchmarks = runloopApiResource({
    listPublic: bindRunloopMethod(benchmarksResource, 'listPublic'),
    definitions: bindRunloopMethod(benchmarksResource, 'definitions'),
    updateScenarios: bindRunloopMethod(benchmarksResource, 'updateScenarios'),
  });
  if (Object.keys(benchmarks).length > 0) {
    api.benchmarks = benchmarks;
  }

  const secrets = runloopApiResource({
    retrieve: bindRunloopMethod(secretsResource, 'retrieve'),
  });
  if (Object.keys(secrets).length > 0) {
    api.secrets = secrets;
  }

  return api;
}

function runloopApiResource(
  methods: Record<string, RunloopPlatformMethodLike | undefined>,
): Record<string, RunloopPlatformMethodLike> {
  return Object.fromEntries(
    Object.entries(methods).filter(
      (entry): entry is [string, RunloopPlatformMethodLike] =>
        typeof entry[1] === 'function',
    ),
  );
}

function bindRunloopMethod(
  target: unknown,
  methodName: string,
): RunloopPlatformMethodLike | undefined {
  if (!isRecord(target)) {
    return undefined;
  }
  const method = target[methodName];
  return typeof method === 'function'
    ? (method.bind(target) as RunloopPlatformMethodLike)
    : undefined;
}

async function upsertRunloopManagedSecrets(
  sdk: RunloopClientLike,
  managedSecrets: Record<string, string> | undefined,
  options: Record<string, unknown> | undefined,
): Promise<Record<string, string>> {
  if (!managedSecrets || Object.keys(managedSecrets).length === 0) {
    return {};
  }
  if (!sdk.secret?.create || !sdk.secret.update) {
    throw new SandboxProviderError(
      'RunloopSandboxClient managedSecrets require the Runloop SDK secret API.',
      {
        provider: 'runloop',
      },
    );
  }

  const refs: Record<string, string> = {};
  for (const [name, value] of Object.entries(managedSecrets).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    try {
      await sdk.secret.create({ name, value }, options);
    } catch (error) {
      if (!isRunloopConflictError(error)) {
        throw new SandboxProviderError(
          `RunloopSandboxClient failed to create managed secret ${name}.`,
          {
            provider: 'runloop',
            secretName: name,
            cause: formatRunloopSecretErrorCause(error, value),
          },
        );
      }
      try {
        await sdk.secret.update(name, { value }, options);
      } catch (updateError) {
        throw new SandboxProviderError(
          `RunloopSandboxClient failed to update managed secret ${name}.`,
          {
            provider: 'runloop',
            secretName: name,
            cause: formatRunloopSecretErrorCause(updateError, value),
          },
        );
      }
    }
    refs[name] = name;
  }
  return refs;
}

function isRunloopConflictError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const status = error.status ?? error.statusCode;
  if (status === 409 || status === '409') {
    return true;
  }
  const code = error.code;
  if (code === 409 || code === '409') {
    return true;
  }
  const text = `${String(error.name ?? '')} ${String(error.message ?? '')}`;
  return /\b(conflict|already exists)\b/iu.test(text);
}

function formatRunloopSecretErrorCause(
  error: unknown,
  secretValue: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return secretValue ? message.split(secretValue).join('[redacted]') : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function callRunloopPlatformMethod(
  methodName: string,
  method: RunloopPlatformMethodLike | undefined,
  ...args: unknown[]
): Promise<unknown> {
  if (!method) {
    throw new SandboxUnsupportedFeatureError(
      `Runloop platform method ${methodName} is not available in the installed Runloop SDK.`,
      {
        provider: 'runloop',
        feature: `platform.${methodName}`,
      },
    );
  }
  return await withProviderError(
    'RunloopSandboxClient',
    'runloop',
    `call platform method ${methodName}`,
    async () => await method(...args),
  );
}

function callRunloopPlatformGetter(
  methodName: string,
  method: ((id: string) => unknown) | undefined,
  id: string,
): unknown {
  if (!method) {
    throw new SandboxUnsupportedFeatureError(
      `Runloop platform method ${methodName} is not available in the installed Runloop SDK.`,
      {
        provider: 'runloop',
        feature: `platform.${methodName}`,
      },
    );
  }
  try {
    return method(id);
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    throw new SandboxProviderError(
      `RunloopSandboxClient failed to call platform method ${methodName}.`,
      {
        provider: 'runloop',
        operation: `call platform method ${methodName}`,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function createRunloopParams(
  state: RunloopSandboxSessionState,
  environment: Record<string, string>,
  options: {
    includeBlueprint?: boolean;
    includeSecrets?: boolean;
  } = {},
): Record<string, unknown> {
  const createParams: Record<string, unknown> = {
    environment_variables: environment,
  };
  const includeBlueprint = options.includeBlueprint ?? true;
  const includeSecrets = options.includeSecrets ?? true;
  const values = {
    blueprintId: includeBlueprint ? state.blueprintId : undefined,
    name: state.name,
    exposedPorts: state.configuredExposedPorts,
    tunnel: state.tunnel,
    gateways: state.gateways,
    mcp: state.mcp,
    metadata: state.metadata,
    secrets: includeSecrets ? state.secretRefs : undefined,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      createParams[toSnakeCase(key)] = value;
    }
  }

  if (state.userParameters || state.launchParameters) {
    createParams.launch_parameters = {
      ...(state.launchParameters ?? {}),
      user_parameters: state.userParameters,
    };
  }

  return createParams;
}

function resolveRunloopManifestRoot(
  manifest: Manifest,
  userParameters: RunloopUserParameters | undefined,
  preserveDefaultRoot: boolean,
): Manifest {
  const effectiveHome = effectiveRunloopHome(userParameters);
  const resolvedManifest =
    !preserveDefaultRoot && manifest.root === '/workspace'
      ? cloneManifestWithRoot(manifest, effectiveHome)
      : manifest;
  validateRunloopManifestRoot(resolvedManifest, effectiveHome);
  return resolvedManifest;
}

function effectiveRunloopHome(
  userParameters: RunloopUserParameters | undefined,
): string {
  if (!userParameters) {
    return DEFAULT_RUNLOOP_WORKSPACE_ROOT;
  }
  validateRunloopUsername(userParameters.username);
  if (userParameters.username === 'root' && userParameters.uid === 0) {
    return DEFAULT_RUNLOOP_ROOT_WORKSPACE_ROOT;
  }
  return `/home/${userParameters.username}`;
}

function validateRunloopUsername(username: string): void {
  if (
    username.length > 0 &&
    username !== '.' &&
    !username.includes('/') &&
    !username.includes('..') &&
    !username.includes('\0')
  ) {
    return;
  }

  throw new SandboxConfigurationError(
    'RunloopSandboxClient userParameters.username must be non-empty and must not contain "/", "..", or NUL bytes.',
    {
      provider: 'runloop',
      username,
    },
  );
}

function validateRunloopManifestRoot(manifest: Manifest, home: string): void {
  const root = pathPosix.normalize(manifest.root);
  if (root === home || root.startsWith(`${home}/`)) {
    return;
  }
  throw new SandboxConfigurationError(
    `RunloopSandboxClient requires manifest.root to be the effective Runloop home (${home}) or a subdirectory of it.`,
    {
      provider: 'runloop',
      root: manifest.root,
      effectiveHome: home,
    },
  );
}

function assertRunloopManifestRootRealPath(
  root: string,
  home: string,
  stdout: string,
): void {
  const values = new Map(
    stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) =>
        line.match(/^(OPENAI_AGENTS_REALPATH_(?:ANCESTOR|HOME|ROOT))=(.*)$/u),
      )
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], pathPosix.normalize(match[2] ?? '')]),
  );
  const realHome = values.get('OPENAI_AGENTS_REALPATH_HOME');
  const realAncestor = values.get('OPENAI_AGENTS_REALPATH_ANCESTOR');
  const realRoot = values.get('OPENAI_AGENTS_REALPATH_ROOT');
  const normalizedHome = pathPosix.normalize(home);
  const realHomeIsConfined =
    realHome &&
    realHome !== '/' &&
    (realHome === normalizedHome || realHome.startsWith(`${normalizedHome}/`));
  const realAncestorIsConfined =
    realHome &&
    realAncestor &&
    (realAncestor === realHome || realAncestor.startsWith(`${realHome}/`));
  const realRootIsConfined =
    realHome &&
    realRoot &&
    (realRoot === realHome || realRoot.startsWith(`${realHome}/`));
  if (realHomeIsConfined && realAncestorIsConfined && realRootIsConfined) {
    return;
  }
  throw new SandboxConfigurationError(
    `RunloopSandboxClient requires manifest.root to resolve to the effective Runloop home (${home}) or a subdirectory of it.`,
    {
      provider: 'runloop',
      root,
      effectiveHome: home,
      resolvedRoot: realRoot,
      resolvedHome: realHome,
      resolvedAncestor: realAncestor,
    },
  );
}

function createRunloopOptions(
  state: Pick<RunloopSandboxSessionState, 'createTimeoutMs' | 'timeouts'>,
): Record<string, unknown> | undefined {
  return runloopLongPollOptions(
    state.timeouts?.createTimeoutMs ?? state.createTimeoutMs,
  );
}

function resolveRunloopTimeouts(
  options: Pick<RunloopSandboxClientOptions, 'createTimeoutMs' | 'timeouts'>,
): RunloopSandboxTimeouts {
  return {
    ...options.timeouts,
    createTimeoutMs:
      options.timeouts?.createTimeoutMs ?? options.createTimeoutMs,
    fastOperationTimeoutMs:
      options.timeouts?.fastOperationTimeoutMs ?? options.createTimeoutMs,
  };
}

function runloopRequestOptions(
  timeoutMs: number | undefined,
): Record<string, unknown> | undefined {
  return typeof timeoutMs === 'number' ? { timeout: timeoutMs } : undefined;
}

function runloopLongPollOptions(
  timeoutMs: number | undefined,
): Record<string, unknown> | undefined {
  return typeof timeoutMs === 'number'
    ? { timeout: timeoutMs, longPoll: { timeoutMs } }
    : undefined;
}

function runloopTunnelEnableParams(
  tunnel: boolean | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (tunnel === false) {
    return undefined;
  }
  if (isRecord(tunnel)) {
    return {
      ...DEFAULT_RUNLOOP_TUNNEL_PARAMS,
      ...tunnel,
    };
  }
  return { ...DEFAULT_RUNLOOP_TUNNEL_PARAMS };
}

function runloopExitStatus(result: RunloopExecutionResultLike): number {
  return result.exitCode ?? UNKNOWN_RUNLOOP_EXIT_CODE;
}

function runloopSucceeded(result: RunloopExecutionResultLike): boolean {
  return result.exitCode === 0;
}

function invalidateRunloopRuntimeCaches(
  state: RunloopSandboxSessionState,
): void {
  delete state.exposedPorts;
}

function remoteCommandEnvironment(
  environment: Record<string, string>,
  options: RemoteSandboxCommandOptions,
): Record<string, string> {
  return options.kind === 'exec' ? environment : {};
}

function assertRunloopResumeRecreateSecretRefsTrusted(
  state: RunloopSandboxSessionState,
  options: RunloopSandboxClientOptions,
): void {
  if (!state.secretRefs || Object.keys(state.secretRefs).length === 0) {
    return;
  }
  if (
    options.managedSecrets &&
    Object.keys(options.managedSecrets).length > 0
  ) {
    return;
  }
  throw new UserError(
    'RunloopSandboxClient cannot recreate a missing devbox with persisted secretRefs. Configure managedSecrets on the client to recreate secrets from trusted input.',
  );
}

async function rematerializeRunloopManifestMounts(
  session: RunloopSandboxSession,
  manifest: Manifest,
): Promise<void> {
  await session.rematerializeManifestMounts(manifest);
}

function mountCommandEnvironment(
  environment: Record<string, string>,
  user?: string,
  userParameters?: RunloopUserParameters,
): Record<string, string> {
  const effectiveUser = user ?? effectiveRunloopUsername(userParameters);
  return effectiveUser === 'root' ? {} : environment;
}

function buildShellCommand(
  command: string,
  environment: Record<string, string>,
  cwd: string,
  user?: string,
  userParameters?: RunloopUserParameters,
): string {
  const exports = Object.entries(environment).map(([key, value]) => {
    assertShellEnvironmentName(key);
    return `export ${key}=${shellQuote(value)}`;
  });
  const shellCommand = [`cd ${shellQuote(cwd)}`, ...exports, command].join(
    ' && ',
  );
  return runloopShellCommandForUser(shellCommand, user, userParameters);
}

function runloopShellCommandForUser(
  command: string,
  user?: string,
  userParameters?: RunloopUserParameters,
): string {
  if (!user || user === effectiveRunloopUsername(userParameters)) {
    return command;
  }
  return `sudo -n -u ${shellQuote(user)} -- sh -lc ${shellQuote(command)}`;
}

function effectiveRunloopUsername(
  userParameters: RunloopUserParameters | undefined,
): string {
  return userParameters?.username ?? 'user';
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`);
}

function basename(path: string): string {
  return path.split('/').pop() || 'file';
}
