import { UserError } from '@openai/agents-core';
import {
  Manifest,
  SandboxProviderError,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxArchiveLimits,
  type SandboxConcurrencyLimits,
  type ExposedPortEndpoint,
  type SandboxSessionLifecycleOptions,
  type SandboxSessionState,
} from '@openai/agents-core/sandbox';
import {
  assertCoreSnapshotUnsupported,
  assertResumeRecreateAllowed,
  assertSandboxManifestMetadataSupported,
  closeRemoteSessionOnManifestError,
  cloneManifestWithRoot,
  deserializeRemoteSandboxSessionStateValues,
  materializeEnvironment,
  providerErrorMessage,
  serializeRemoteSandboxSessionState,
  shellQuote,
  withProviderError,
  withSandboxSpan,
  readOptionalNumberArray,
  readOptionalString,
  readString,
  RemoteSandboxSessionBase,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../shared';

const PROVIDER_NAME = 'UpstashBoxSandboxClient';
const PROVIDER_ID = 'upstash-box';
const BACKEND_ID = 'upstash-box';

/**
 * Upstash Box uses `/workspace/home` as the default workspace root. Remap the
 * core default manifest root (`/workspace`) so manifests created without an
 * explicit root materialize where the box expects them.
 */
const DEFAULT_WORKSPACE_ROOT = '/workspace/home';

export type UpstashBoxRuntime = 'node' | 'python' | 'golang' | 'ruby' | 'rust';
export type UpstashBoxSize = 'small' | 'medium' | 'large';

export type UpstashBoxNetworkPolicy =
  | { mode: 'allow-all' | 'deny-all' }
  | {
      mode: 'custom';
      allowedDomains?: string[];
      allowedCidrs?: string[];
      deniedCidrs?: string[];
    };

type BoxRunLike = {
  result: string;
  exitCode: number | null;
};

type BoxLike = {
  id: string;
  exec: {
    command(command: string): Promise<BoxRunLike>;
  };
  files: {
    read(path: string, options?: { encoding?: 'base64' }): Promise<string>;
    write(options: {
      path: string;
      content: string;
      encoding?: 'base64';
    }): Promise<void>;
  };
  getPublicURL(
    port: number,
    options?: { bearerToken?: boolean; basicAuth?: boolean },
  ): Promise<{ url: string; port: number }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  delete(): Promise<void>;
};

type BoxStatic = {
  create(config?: Record<string, unknown>): Promise<BoxLike>;
  get(boxId: string, options?: Record<string, unknown>): Promise<BoxLike>;
  fromSnapshot(
    snapshotId: string,
    config?: Record<string, unknown>,
  ): Promise<BoxLike>;
};

export interface UpstashBoxSandboxClientOptions extends SandboxClientOptions {
  /** Upstash Box API key. Falls back to the `UPSTASH_BOX_API_KEY` env var. */
  apiKey?: string;
  /** Base URL of the Box API. Falls back to the `UPSTASH_BOX_BASE_URL` env var. */
  baseUrl?: string;
  /** Human-readable name for the box. */
  name?: string;
  /** Resource size for the box. Defaults to `"small"`. */
  size?: UpstashBoxSize;
  /** Runtime image to provision inside the box. */
  runtime?: UpstashBoxRuntime;
  /** Keep the box alive instead of allowing pause-based idle lifecycle. */
  keepAlive?: boolean;
  /** Network access policy for the box. */
  networkPolicy?: UpstashBoxNetworkPolicy;
  /** GitHub token forwarded to git operations inside the box. */
  gitToken?: string;
  /** Create the box from a saved snapshot instead of a fresh image. */
  snapshotId?: string;
  /** Ports that may be exposed through `resolveExposedPort`. */
  exposedPorts?: number[];
  /** Pause the box on session close instead of deleting it. */
  pauseOnExit?: boolean;
  /** Environment variables injected into the box. */
  env?: Record<string, string>;
  archiveLimits?: SandboxArchiveLimits | null;
}

export interface UpstashBoxSandboxSessionState extends SandboxSessionState {
  boxId: string;
  apiKey?: string;
  baseUrl?: string;
  name?: string;
  size?: UpstashBoxSize;
  runtime?: UpstashBoxRuntime;
  keepAlive: boolean;
  networkPolicy?: UpstashBoxNetworkPolicy;
  gitToken?: string;
  snapshotId?: string;
  configuredExposedPorts?: number[];
  pauseOnExit: boolean;
  environment: Record<string, string>;
}

export class UpstashBoxSandboxSession extends RemoteSandboxSessionBase<UpstashBoxSandboxSessionState> {
  private readonly box: BoxLike;
  private pausePromise?: Promise<void>;
  private deletePromise?: Promise<void>;

  constructor(args: {
    state: UpstashBoxSandboxSessionState;
    box: BoxLike;
    concurrencyLimits?: SandboxConcurrencyLimits;
    archiveLimits?: SandboxArchiveLimits | null;
  }) {
    super({
      state: args.state,
      options: {
        providerName: PROVIDER_NAME,
        providerId: PROVIDER_ID,
        concurrencyLimits: args.concurrencyLimits,
        archiveLimits: args.archiveLimits,
      },
    });
    this.box = args.box;
  }

  async prepareWorkspaceRoot(): Promise<void> {
    const root = this.state.manifest.root;
    const result = await this.runBoxShell(`mkdir -p -- ${shellQuote(root)}`);
    if (result.status !== 0) {
      throw new SandboxProviderError(
        `${PROVIDER_NAME} failed to prepare the workspace root.`,
        {
          provider: PROVIDER_ID,
          operation: 'prepare workspace root',
          boxId: this.state.boxId,
          root,
          stdout: result.stdout ?? '',
        },
      );
    }
  }

  /**
   * Developer-owned close. Honors `pauseOnExit` (pause for later resume) and
   * leaves keep-alive boxes running. The managed runtime drives cleanup through
   * {@link shutdown}/{@link delete} instead, so this path is for code that owns
   * the session directly.
   */
  async close(): Promise<void> {
    await withSandboxSpan(
      'sandbox.stop',
      {
        backend_id: BACKEND_ID,
        sandbox_id: this.state.boxId,
      },
      async () => {
        // Keep-alive boxes stay running and are reconnected to on resume.
        if (this.state.keepAlive) {
          return;
        }
        if (this.state.pauseOnExit) {
          await this.pauseOnce();
          return;
        }
        await this.deleteOnce();
      },
    );
  }

  async shutdown(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await this.cleanup(options);
  }

  async delete(options?: SandboxSessionLifecycleOptions): Promise<void> {
    // An explicit delete (no managed-cleanup reason) always destroys the box,
    // even when pauseOnExit is set.
    if (options?.reason !== 'cleanup') {
      await withSandboxSpan(
        'sandbox.shutdown',
        {
          backend_id: BACKEND_ID,
          sandbox_id: this.state.boxId,
        },
        async () => {
          await this.deleteOnce();
        },
      );
      return;
    }
    await this.cleanup(options);
  }

  /**
   * Managed-cleanup teardown. The runtime calls both `shutdown` and `delete`
   * with the same lifecycle options, so the terminal action is memoized and
   * runs once. When the runtime is preserving owned sessions for reuse, a
   * pausable box is paused instead of deleted; keep-alive boxes are left
   * running for the caller to manage.
   */
  private async cleanup(
    options?: SandboxSessionLifecycleOptions,
  ): Promise<void> {
    await withSandboxSpan(
      'sandbox.shutdown',
      {
        backend_id: BACKEND_ID,
        sandbox_id: this.state.boxId,
      },
      async () => {
        if (this.state.keepAlive) {
          return;
        }
        if (this.shouldPauseOnCleanup(options)) {
          await this.pauseOnce();
          return;
        }
        await this.deleteOnce();
      },
    );
  }

  private shouldPauseOnCleanup(
    options?: SandboxSessionLifecycleOptions,
  ): boolean {
    return (
      options?.reason === 'cleanup' &&
      options?.preserveOwnedSessions === true &&
      this.state.pauseOnExit
    );
  }

  private async pauseOnce(): Promise<void> {
    // Keep-alive boxes cannot be paused; leave them running instead.
    if (this.state.keepAlive) {
      return;
    }
    this.pausePromise ??= this.box.pause();
    await this.pausePromise;
  }

  private async deleteOnce(): Promise<void> {
    this.deletePromise ??= this.box.delete();
    await this.deletePromise;
  }

  protected override exposedPortSource(): string {
    return 'public URL';
  }

  protected override allowOnDemandExposedPorts(): boolean {
    // Box exposes ports on demand, so callers do not have to declare them.
    return true;
  }

  protected override async resolveRemoteExposedPort(
    port: number,
  ): Promise<ExposedPortEndpoint | string> {
    let result: { url: string; port: number };
    try {
      result = await this.box.getPublicURL(port);
    } catch (error) {
      throw new SandboxProviderError(
        `${PROVIDER_NAME} failed to resolve exposed port ${port}.`,
        {
          provider: PROVIDER_ID,
          port,
          cause: providerErrorMessage(error),
        },
      );
    }

    if (typeof result?.url !== 'string') {
      throw new SandboxProviderError(
        `${PROVIDER_NAME} exposed port resolution did not include a URL.`,
        {
          provider: PROVIDER_ID,
          port,
        },
      );
    }

    return result.url;
  }

  protected override resolveManifestForApply(manifest: Manifest): Manifest {
    const resolved = resolveManifestRoot(manifest);
    if (resolved.root !== this.state.manifest.root) {
      throw new UserError(
        `${PROVIDER_NAME} cannot apply a manifest with a different root than the active session. Create or resume a session with the desired root instead.`,
      );
    }
    return resolved;
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    return await this.runBoxShell(
      `cd ${shellQuote(options.workdir)} && ${command}`,
    );
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    const result = await this.runBoxShell(`mkdir -p -- ${shellQuote(path)}`);
    if (result.status !== 0) {
      throw new SandboxProviderError(
        `${PROVIDER_NAME} failed to create directory ${path}.`,
        {
          provider: PROVIDER_ID,
          path,
          stdout: result.stdout ?? '',
        },
      );
    }
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return await this.box.files.read(path);
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    const content = await this.box.files.read(path, { encoding: 'base64' });
    return Uint8Array.from(Buffer.from(content, 'base64'));
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const buffer =
      typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content);
    await this.box.files.write({
      path,
      content: buffer.toString('base64'),
      encoding: 'base64',
    });
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    await this.runBoxShell(`rm -rf -- ${shellQuote(path)}`);
  }

  private async runBoxShell(
    command: string,
  ): Promise<RemoteSandboxCommandResult> {
    const run = await this.box.exec.command(command);
    return {
      status: run.exitCode ?? 1,
      stdout: run.result ?? '',
      stderr: '',
    };
  }
}

/**
 * @see {@link https://upstash.com/docs/box | Upstash Box docs}.
 * @see {@link https://www.npmjs.com/package/@upstash/box | `@upstash/box` SDK}.
 */
export class UpstashBoxSandboxClient implements SandboxClient<
  UpstashBoxSandboxClientOptions,
  UpstashBoxSandboxSessionState
> {
  readonly backendId = BACKEND_ID;
  private readonly options: UpstashBoxSandboxClientOptions;

  constructor(options: UpstashBoxSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<UpstashBoxSandboxClientOptions> | Manifest,
    manifestOptions?: UpstashBoxSandboxClientOptions,
  ): Promise<UpstashBoxSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported(PROVIDER_NAME, createArgs.snapshot);
    const resolvedOptions = {
      ...this.options,
      ...createArgs.options,
    };
    const resolvedManifest = resolveManifestRoot(createArgs.manifest);
    assertSandboxManifestMetadataSupported(
      PROVIDER_NAME,
      resolvedManifest,
      undefined,
    );
    const Box = await loadBox();

    return await withSandboxSpan(
      'sandbox.start',
      {
        backend_id: this.backendId,
      },
      async () => {
        const environment = await materializeEnvironment(
          resolvedManifest,
          resolvedOptions.env,
        );
        const box = await createBox(Box, resolvedOptions, environment);

        const session = new UpstashBoxSandboxSession({
          box,
          concurrencyLimits: createArgs.concurrencyLimits,
          archiveLimits: createArgs.archiveLimits,
          state: {
            manifest: resolvedManifest,
            boxId: box.id,
            apiKey: resolvedOptions.apiKey,
            baseUrl: resolvedOptions.baseUrl,
            name: resolvedOptions.name,
            size: resolvedOptions.size,
            runtime: resolvedOptions.runtime,
            keepAlive: resolvedOptions.keepAlive ?? false,
            networkPolicy: resolvedOptions.networkPolicy,
            gitToken: resolvedOptions.gitToken,
            snapshotId: resolvedOptions.snapshotId,
            configuredExposedPorts: resolvedOptions.exposedPorts,
            pauseOnExit: resolvedOptions.pauseOnExit ?? false,
            environment,
          },
        });

        try {
          await session.prepareWorkspaceRoot();
          await session.applyManifest(resolvedManifest);
        } catch (error) {
          session.state.pauseOnExit = false;
          session.state.keepAlive = false;
          await closeRemoteSessionOnManifestError(
            'Upstash Box',
            session,
            error,
          );
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: UpstashBoxSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(state: UpstashBoxSandboxSessionState): boolean {
    return state.pauseOnExit || state.keepAlive;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<UpstashBoxSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    return {
      ...state,
      ...baseState,
      boxId: readString(state, 'boxId'),
      apiKey: readOptionalString(state, 'apiKey'),
      baseUrl: readOptionalString(state, 'baseUrl'),
      name: readOptionalString(state, 'name'),
      size: readOptionalSize(state.size),
      runtime: readOptionalRuntime(state.runtime),
      keepAlive: Boolean(state.keepAlive),
      networkPolicy: state.networkPolicy as UpstashBoxNetworkPolicy | undefined,
      gitToken: readOptionalString(state, 'gitToken'),
      snapshotId: readOptionalString(state, 'snapshotId'),
      configuredExposedPorts: readOptionalNumberArray(
        state.configuredExposedPorts,
      ),
      pauseOnExit: Boolean(state.pauseOnExit),
    };
  }

  async resume(
    state: UpstashBoxSandboxSessionState,
  ): Promise<UpstashBoxSandboxSession> {
    const Box = await loadBox();
    let box: BoxLike;
    try {
      box = await Box.get(state.boxId, connectionOptions(state, this.options));
      if (state.pauseOnExit) {
        await box.resume();
      }
    } catch (error) {
      assertResumeRecreateAllowed(error, {
        providerName: PROVIDER_NAME,
        provider: PROVIDER_ID,
        details: { boxId: state.boxId },
      });
      return await this.recreateFromPersistedState(Box, state);
    }

    const session = new UpstashBoxSandboxSession({
      state,
      box,
      archiveLimits: this.options.archiveLimits,
    });
    await session.prepareWorkspaceRoot();
    return session;
  }

  private async recreateFromPersistedState(
    Box: BoxStatic,
    state: UpstashBoxSandboxSessionState,
  ): Promise<UpstashBoxSandboxSession> {
    const box = await createBox(
      Box,
      {
        ...this.options,
        apiKey: state.apiKey ?? this.options.apiKey,
        baseUrl: state.baseUrl ?? this.options.baseUrl,
        name: state.name,
        size: state.size,
        runtime: state.runtime,
        keepAlive: state.keepAlive,
        networkPolicy: state.networkPolicy,
        gitToken: state.gitToken,
        snapshotId: state.snapshotId,
        exposedPorts: state.configuredExposedPorts,
        pauseOnExit: state.pauseOnExit,
      },
      state.environment,
    );

    const nextState: UpstashBoxSandboxSessionState = {
      ...state,
      boxId: box.id,
      environment: { ...state.environment },
    };
    delete nextState.exposedPorts;

    const session = new UpstashBoxSandboxSession({
      box,
      state: nextState,
      archiveLimits: this.options.archiveLimits,
    });
    try {
      await session.prepareWorkspaceRoot();
      await session.applyManifest(state.manifest);
    } catch (error) {
      session.state.pauseOnExit = false;
      session.state.keepAlive = false;
      await closeRemoteSessionOnManifestError('Upstash Box', session, error);
    }
    return session;
  }
}

function resolveManifestRoot(manifest: Manifest): Manifest {
  if (manifest.root === '/workspace') {
    return cloneManifestWithRoot(manifest, DEFAULT_WORKSPACE_ROOT);
  }
  return manifest;
}

function connectionOptions(
  state: UpstashBoxSandboxSessionState,
  options: UpstashBoxSandboxClientOptions,
): Record<string, unknown> {
  const connection: Record<string, unknown> = {};
  const apiKey = state.apiKey ?? options.apiKey;
  const baseUrl = state.baseUrl ?? options.baseUrl;
  const gitToken = state.gitToken ?? options.gitToken;
  if (apiKey) connection.apiKey = apiKey;
  if (baseUrl) connection.baseUrl = baseUrl;
  if (gitToken) connection.gitToken = gitToken;
  return connection;
}

async function createBox(
  Box: BoxStatic,
  options: UpstashBoxSandboxClientOptions,
  environment: Record<string, string>,
): Promise<BoxLike> {
  const config: Record<string, unknown> = {};
  if (options.apiKey) config.apiKey = options.apiKey;
  if (options.baseUrl) config.baseUrl = options.baseUrl;
  if (options.name) config.name = options.name;
  if (options.size) config.size = options.size;
  if (options.runtime) config.runtime = options.runtime;
  if (options.keepAlive) config.keepAlive = true;
  if (options.networkPolicy) config.networkPolicy = options.networkPolicy;
  if (options.gitToken) config.git = { token: options.gitToken };
  if (Object.keys(environment).length > 0) config.env = environment;

  return await withProviderError(
    PROVIDER_NAME,
    PROVIDER_ID,
    'create box',
    async () =>
      options.snapshotId
        ? await Box.fromSnapshot(options.snapshotId, config)
        : await Box.create(config),
    options.snapshotId ? { snapshotId: options.snapshotId } : undefined,
  );
}

async function loadBox(): Promise<BoxStatic> {
  // Use a variable specifier so the optional peer dependency is resolved at
  // runtime only and does not break builds when it is not installed.
  const moduleName = '@upstash/box';
  try {
    const mod = (await import(moduleName)) as { Box?: BoxStatic };
    if (!mod.Box) {
      throw new Error('Missing `Box` export from `@upstash/box`.');
    }
    return mod.Box;
  } catch (error) {
    throw new UserError(
      `Upstash Box sandbox support requires the optional \`@upstash/box\` package. Install it before using Upstash Box-backed sandbox examples. ${(error as Error).message}`,
    );
  }
}

function readOptionalSize(value: unknown): UpstashBoxSize | undefined {
  return value === 'small' || value === 'medium' || value === 'large'
    ? value
    : undefined;
}

function readOptionalRuntime(value: unknown): UpstashBoxRuntime | undefined {
  return value === 'node' ||
    value === 'python' ||
    value === 'golang' ||
    value === 'ruby' ||
    value === 'rust'
    ? value
    : undefined;
}
