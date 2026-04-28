import { UserError } from '@openai/agents-core';
import { existsSync, readFileSync } from 'node:fs';
import {
  dirname as pathDirname,
  join as pathJoin,
  resolve as pathResolve,
} from 'node:path';
import {
  Manifest,
  SandboxLifecycleError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxSessionSerializationOptions,
  type SandboxSessionState,
  type WorkspaceArchiveData,
} from '@openai/agents-core/sandbox';
import {
  assertCoreConcurrencyLimitsUnsupported,
  assertCoreSnapshotUnsupported,
  assertSandboxManifestMetadataSupported,
  assertRunAsUnsupported,
  cloneManifestWithRoot,
  deserializeRemoteSandboxSessionStateValues,
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
  materializeEnvironment,
  posixDirname,
  shellQuote,
  serializeRemoteSandboxSessionState,
  toUint8Array,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecord,
  readOptionalString,
  readString,
  withProviderError,
  withSandboxSpan,
  RemoteSandboxSessionBase,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../shared';

const DEFAULT_VERCEL_WORKSPACE_ROOT = '/vercel/sandbox';

type VercelSdkSandboxClass = typeof import('@vercel/sandbox').Sandbox;
type VercelSdkSandbox = import('@vercel/sandbox').Sandbox;
type VercelSdkCreateParams = Parameters<VercelSdkSandboxClass['create']>[0];
type VercelSdkGetParams = Parameters<VercelSdkSandboxClass['get']>[0];
type VercelSdkRunCommandParams = Parameters<VercelSdkSandbox['runCommand']>[0];
type VercelAuthModule = typeof import('@vercel/sandbox/dist/auth/index.js');

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
};

type VercelSandboxClass = {
  create(params?: VercelSandboxCreateParams): Promise<VercelSandboxInstance>;
  get(params: VercelSandboxGetParams): Promise<VercelSandboxInstance>;
};

type VercelCredentials = Pick<
  VercelSandboxClientOptions,
  'projectId' | 'teamId' | 'token'
>;
type VercelAuth = NonNullable<ReturnType<VercelAuthModule['getAuth']>>;

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
  stop?(params?: { blocking?: boolean }): Promise<unknown>;
  snapshot?(params?: { expiration?: number }): Promise<{ snapshotId?: string }>;
};

type VercelCommandFinishedLike = {
  exitCode: number | null;
  output(stream?: 'stdout' | 'stderr' | 'both'): Promise<string>;
};

export type VercelWorkspacePersistence = 'tar' | 'snapshot';

export interface VercelSandboxClientOptions extends SandboxClientOptions {
  projectId?: string;
  teamId?: string;
  token?: string;
  runtime?: string;
  resources?: Record<string, unknown>;
  exposedPorts?: number[];
  interactive?: boolean;
  networkPolicy?: Record<string, unknown>;
  timeoutMs?: number;
  workspacePersistence?: VercelWorkspacePersistence;
  snapshotExpirationMs?: number;
  env?: Record<string, string>;
}

export interface VercelSandboxSessionState extends SandboxSessionState {
  sandboxId: string;
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
  }) {
    super({
      state: args.state,
      options: {
        providerName: 'VercelSandboxClient',
        providerId: 'vercel',
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

  protected override async beforeFilesystemMutation(): Promise<void> {
    this.markWorkspaceMutated();
  }

  protected override async beforeExecCommand(): Promise<void> {
    this.markWorkspaceMutated();
    this.resetKnownDirs();
  }

  protected override async beforeMaterializeEntry(): Promise<void> {
    this.markWorkspaceMutated();
  }

  protected override async beforeApplyManifest(): Promise<void> {
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
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async materializeInitialManifest(manifest: Manifest): Promise<void> {
    this.markWorkspaceMutated();
    await this.materializeManifestEntries(manifest);
  }

  async prepareWorkspaceRoot(): Promise<void> {
    this.markWorkspaceMutated();
    await this.ensureDir(this.state.manifest.root);
  }

  async persistWorkspace(): Promise<Uint8Array> {
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

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    this.markWorkspaceMutated();
    const snapshotRef =
      this.state.workspacePersistence === 'snapshot'
        ? decodeNativeSnapshotRef(data)
        : undefined;
    if (snapshotRef?.provider === 'vercel') {
      await this.replaceSandboxFromSnapshot(snapshotRef.snapshotId);
      return;
    }

    await this.hydrateWorkspaceTar(data);
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
          `Failed to capture a Vercel sandbox snapshot and stop the sandbox. Snapshot error: ${errorMessage(snapshotError)} Stop error: ${errorMessage(stopError)}`,
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
    const sandbox = await this.createAndPrepareSandboxFromSnapshot(
      snapshotId,
      credentials,
    );

    try {
      await stopVercelSandbox(previousSandbox);
    } catch (error) {
      if (options.ignorePreviousStopFailure) {
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
        replacementStopCause = errorMessage(replacementStopError);
      }
      throw new SandboxProviderError(
        'Vercel snapshot restore created a replacement sandbox, but stopping the previous sandbox failed.',
        {
          provider: 'vercel',
          sandboxId: previousSandbox.sandboxId,
          replacementSandboxId: sandbox.sandboxId,
          cause: errorMessage(error),
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
          cause: errorMessage(restoreError),
          recoveryCause: errorMessage(recoveryError),
        },
      );
    }
  }

  private async resolveSnapshotCredentials(): Promise<Record<string, string>> {
    const credentials = await resolveVercelCredentials({
      ...this.credentials,
      projectId: this.state.projectId ?? this.credentials.projectId,
      teamId: this.state.teamId ?? this.credentials.teamId,
      token: this.state.token ?? this.credentials.token,
    });
    applyResolvedVercelCredentials(this.state, credentials);
    return credentials;
  }

  private async createAndPrepareSandboxFromSnapshot(
    snapshotId: string,
    credentials: Record<string, string>,
  ): Promise<VercelSandboxInstance> {
    const sandbox = await this.createSandboxFromSnapshot(
      snapshotId,
      credentials,
    );

    const replacementSession = new VercelSandboxSession({
      credentials: { ...this.credentials, ...credentials },
      sandbox,
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
          `Failed to restore a Vercel sandbox from snapshot and stop the replacement sandbox. Restore error: ${errorMessage(error)} Stop error: ${errorMessage(stopError)}`,
        );
      }
      throw error;
    }

    return sandbox;
  }

  private async createSandboxFromSnapshot(
    snapshotId: string,
    credentials: Record<string, string>,
  ): Promise<VercelSandboxInstance> {
    const Sandbox = await loadVercelSandboxClass();
    return await withProviderError(
      'VercelSandboxClient',
      'vercel',
      'restore snapshot',
      async () =>
        await Sandbox.create({
          ...credentials,
          source: {
            type: 'snapshot',
            snapshotId,
          },
          ...(this.state.runtime ? { runtime: this.state.runtime } : {}),
          ...(this.state.resources ? { resources: this.state.resources } : {}),
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
      { snapshotId },
    );
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
  }

  protected override async runRemoteCommand(
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

  protected override async mkdirRemote(path: string): Promise<void> {
    await this.ensureDir(path);
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    const bytes = await this.sandbox.readFileToBuffer({ path });
    if (!bytes) {
      throw new UserError(`Sandbox path not found: ${path}`);
    }
    return await toUint8Array(bytes);
  }

  protected override async writeRemoteFile(
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
    assertCoreConcurrencyLimitsUnsupported(
      'VercelSandboxClient',
      createArgs.concurrencyLimits,
    );
    const manifest = createArgs.manifest;
    const resolvedOptions = {
      ...this.options,
      ...createArgs.options,
    };
    const resolvedManifest = resolveManifestRoot(manifest);
    assertSandboxManifestMetadataSupported(
      'VercelSandboxClient',
      resolvedManifest,
    );

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
        const credentials = await resolveVercelCredentials(resolvedOptions);
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
          credentials: { ...resolvedOptions, ...credentials },
          state: {
            manifest: resolvedManifest,
            sandboxId: sandbox.sandboxId,
            projectId: resolvedOptions.projectId ?? credentials.projectId,
            teamId: resolvedOptions.teamId ?? credentials.teamId,
            token: credentials.token,
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
              `Failed to apply a Vercel sandbox manifest and stop the sandbox. Manifest error: ${errorMessage(error)} Stop error: ${errorMessage(stopError)}`,
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
    if (
      state.workspacePersistence === 'snapshot' &&
      state.snapshotSupported !== false &&
      state.snapshotSandboxId !== state.sandboxId &&
      (options?.reuseLiveSession === false || options?.willCloseAfterSerialize)
    ) {
      await captureVercelSnapshot(state, {
        options: {
          ...this.options,
          projectId: state.projectId ?? this.options.projectId,
          teamId: state.teamId ?? this.options.teamId,
          token: state.token ?? this.options.token,
        },
      });
    }
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(state: VercelSandboxSessionState): boolean {
    return (
      state.workspacePersistence === 'snapshot' &&
      state.snapshotSupported !== false
    );
  }

  canReusePreservedOwnedSession(state: VercelSandboxSessionState): boolean {
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
    assertSandboxManifestMetadataSupported('VercelSandboxClient', manifest);
    return {
      ...state,
      ...baseState,
      manifest,
      sandboxId: readString(state, 'sandboxId'),
      workspacePersistence:
        (state.workspacePersistence as
          | VercelWorkspacePersistence
          | undefined) ?? 'tar',
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
  }

  async resume(
    state: VercelSandboxSessionState,
  ): Promise<VercelSandboxSession> {
    const Sandbox = await loadVercelSandboxClass();
    const credentials = await resolveVercelCredentials({
      ...this.options,
      projectId: state.projectId ?? this.options.projectId,
      teamId: state.teamId ?? this.options.teamId,
      token: state.token ?? this.options.token,
    });
    applyResolvedVercelCredentials(state, credentials);
    const resumeFromSnapshot = hasFreshVercelSnapshot(state);
    const sandbox = resumeFromSnapshot
      ? await withProviderError(
          'VercelSandboxClient',
          'vercel',
          'resume sandbox from snapshot',
          async () =>
            await Sandbox.create({
              ...credentials,
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
          { snapshotId: state.snapshotId, sandboxId: state.sandboxId },
        )
      : await withProviderError(
          'VercelSandboxClient',
          'vercel',
          'resume sandbox',
          async () =>
            await Sandbox.get({
              sandboxId: state.sandboxId,
              ...credentials,
            }),
          { sandboxId: state.sandboxId },
        );

    const session = new VercelSandboxSession({
      credentials,
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
          `Failed to resume a Vercel sandbox from snapshot and stop the replacement sandbox. Resume error: ${errorMessage(error)} Stop error: ${errorMessage(stopError)}`,
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
    stop?: (params?: { blocking?: boolean }) => Promise<unknown>;
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
    adapted.stop = async (params) => await stop(params);
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
    output: async (stream) => await command.output(stream),
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

function pickVercelCredentials(
  options: VercelCredentials,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  if (options.projectId) {
    credentials.projectId = options.projectId;
  }
  if (options.teamId) {
    credentials.teamId = options.teamId;
  }
  if (options.token) {
    credentials.token = options.token;
  }
  return credentials;
}

async function resolveVercelCredentials(
  options: VercelCredentials,
): Promise<Record<string, string>> {
  const envOptions = {
    projectId: process.env.VERCEL_PROJECT_ID,
    teamId: process.env.VERCEL_TEAM_ID,
    token: process.env.VERCEL_TOKEN,
  };
  const layeredCredentials = pickVercelCredentials({
    projectId: options.projectId ?? envOptions.projectId,
    teamId: options.teamId ?? envOptions.teamId,
    token: options.token ?? envOptions.token,
  });
  if (layeredCredentials.token) {
    return (
      (await refreshLayeredVercelCliCredentials(layeredCredentials)) ??
      layeredCredentials
    );
  }

  if (Object.keys(layeredCredentials).length > 0) {
    const cliToken = await resolveVercelCliAuthToken();
    if (cliToken) {
      return {
        ...layeredCredentials,
        token: cliToken,
      };
    }
    return {};
  }

  if (hasAnyVercelCredentialOption(options)) {
    return {};
  }

  return (await resolveVercelCliCredentials()) ?? {};
}

function hasAnyVercelCredentialOption(options: VercelCredentials): boolean {
  return Boolean(options.projectId || options.teamId || options.token);
}

async function resolveVercelCliCredentials(): Promise<
  Record<string, string> | undefined
> {
  const token = await resolveVercelCliAuthToken();
  if (!token) {
    return undefined;
  }

  const linkedProject = findLinkedVercelProject();
  if (!linkedProject) {
    return { token };
  }

  return {
    token,
    projectId: linkedProject.projectId,
    teamId: linkedProject.teamId,
  };
}

async function resolveVercelCliAuthToken(): Promise<string | undefined> {
  const authModule = await loadVercelAuthModule();
  if (!authModule) {
    return undefined;
  }

  const auth = await resolveVercelCliAuth(authModule);
  return auth?.token;
}

async function refreshLayeredVercelCliCredentials(
  credentials: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (!credentials.token) {
    return undefined;
  }

  const authModule = await loadVercelAuthModule();
  if (!authModule) {
    return undefined;
  }

  const auth = authModule.getAuth();
  if (!auth?.token || auth.token !== credentials.token) {
    return undefined;
  }

  const resolvedAuth = await resolveVercelCliAuth(authModule, auth);
  if (!resolvedAuth?.token) {
    return undefined;
  }

  return {
    ...credentials,
    token: resolvedAuth.token,
  };
}

async function loadVercelAuthModule(): Promise<VercelAuthModule | undefined> {
  if (process.env.NODE_ENV === 'test' && !process.env.VERCEL_AUTH_CONFIG_DIR) {
    return undefined;
  }

  try {
    return await import('@vercel/sandbox/dist/auth/index.js');
  } catch {
    return undefined;
  }
}

async function resolveVercelCliAuth(
  authModule: VercelAuthModule,
  initialAuth = authModule.getAuth(),
): Promise<VercelAuth | undefined> {
  let auth = initialAuth;
  if (!auth?.token && !auth?.refreshToken) {
    return undefined;
  }

  if (auth?.expiresAt && auth.expiresAt.getTime() <= Date.now()) {
    if (!auth.refreshToken) {
      return undefined;
    }
    const refreshed = await (
      await authModule.OAuth()
    ).refreshToken(auth.refreshToken);
    auth = {
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1_000),
      token: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? auth.refreshToken,
    };
    try {
      authModule.updateAuthConfig(auth);
    } catch {
      // The refreshed token is still usable for this process.
    }
  }

  return auth ?? undefined;
}

function applyResolvedVercelCredentials(
  state: Pick<VercelSandboxSessionState, 'projectId' | 'teamId' | 'token'>,
  credentials: Record<string, string>,
): void {
  if (credentials.projectId) {
    state.projectId = credentials.projectId;
  }
  if (credentials.teamId) {
    state.teamId = credentials.teamId;
  }
  if (credentials.token) {
    state.token = credentials.token;
  }
}

function findLinkedVercelProject():
  | { projectId: string; teamId: string }
  | undefined {
  const candidateCwds = [
    process.env.INIT_CWD,
    process.env.PWD,
    process.cwd(),
  ].filter((value): value is string => Boolean(value));

  for (const cwd of candidateCwds) {
    const projectPath = findUpVercelProjectFile(cwd);
    if (!projectPath) {
      continue;
    }
    try {
      const data = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<
        string,
        unknown
      >;
      if (
        typeof data.projectId === 'string' &&
        typeof data.orgId === 'string'
      ) {
        return {
          projectId: data.projectId,
          teamId: data.orgId,
        };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function findUpVercelProjectFile(startDir: string): string | undefined {
  let current = pathResolve(startDir);
  while (true) {
    const candidate = pathJoin(current, '.vercel', 'project.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = pathDirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
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
    const credentials = await resolveVercelCredentials({
      projectId: state.projectId ?? args.options?.projectId,
      teamId: state.teamId ?? args.options?.teamId,
      token: state.token ?? args.options?.token,
    });
    applyResolvedVercelCredentials(state, credentials);
    sandbox = await withProviderError(
      'VercelSandboxClient',
      'vercel',
      'look up sandbox for snapshot',
      async () =>
        await (
          await loadVercelSandboxClass()
        ).get({
          sandboxId: state.sandboxId,
          ...credentials,
        }),
      { sandboxId: state.sandboxId },
    );
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
      await sandbox.stop!({ blocking: true });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
