import { UserError } from '@openai/agents-core';
import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type ExposedPortEndpoint,
  type ExecCommandArgs,
  type Mount,
  type SandboxSessionLifecycleOptions,
  type SandboxSessionState,
  type TypedMount,
  type WriteStdinArgs,
  type WorkspaceArchiveData,
  normalizeSandboxClientCreateArgs,
} from '@openai/agents-core/sandbox';
import {
  appendPtyOutput,
  assertCoreConcurrencyLimitsUnsupported,
  assertCoreSnapshotUnsupported,
  assertResumeRecreateAllowed,
  assertTarWorkspacePersistence,
  createPtyProcessEntry,
  deserializeRemoteSandboxSessionStateValues,
  formatPtyExecUpdate,
  assertSandboxManifestMetadataSupported,
  SANDBOX_MANIFEST_METADATA_SUPPORT,
  closeRemoteSessionOnManifestError,
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
  materializeEnvironment,
  parseExposedPortEndpoint,
  shellQuote,
  shellCommandForPty,
  serializeRemoteSandboxSessionState,
  watchPtyProcess,
  isRecord,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecord,
  readOptionalString,
  readOptionalStringRecord,
  readString,
  withProviderError,
  withSandboxSpan,
  writePtyStdin,
  PtyProcessRegistry,
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
import { isE2BCloudBucketMountEntry } from './mounts';

type E2BSandboxClass = {
  create(
    templateOrOpts?: string | Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<E2BSandboxInstance>;
  connect?(
    sandboxId: string,
    opts?: Record<string, unknown>,
  ): Promise<E2BSandboxInstance>;
  resume?(
    sandboxId: string,
    opts?: Record<string, unknown>,
  ): Promise<E2BSandboxInstance>;
};

type E2BSandboxInstance = {
  sandboxId: string;
  files: E2BFilesystemApi;
  commands: E2BCommandsApi;
  pty?: E2BPtyApi;
  getHost?(port: number): string | Promise<string>;
  createSnapshot?(): Promise<{ snapshotId?: string }>;
  kill(): Promise<void>;
  pause?(): Promise<boolean>;
};

type E2BFilesystemApi = {
  write(
    path: string | { path: string; data: string | Uint8Array }[],
    data?: string | Uint8Array,
  ): Promise<unknown>;
  read?(
    path: string,
    opts?: { format?: 'text' | 'bytes' },
  ): Promise<string | Uint8Array>;
  remove?(path: string): Promise<unknown>;
  makeDir?(path: string): Promise<unknown>;
};

type E2BCommandResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: string;
};

type E2BCommandHandle = E2BCommandResult & {
  pid: number;
  wait?(): Promise<E2BCommandResult>;
  kill?(): Promise<boolean>;
  disconnect?(): Promise<void>;
};

type E2BCommandsApi = {
  run(
    command: string,
    opts?: {
      background?: boolean;
      cwd?: string;
      envs?: Record<string, string>;
      user?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void | Promise<void>;
      onStderr?: (data: string) => void | Promise<void>;
      stdin?: boolean;
    },
  ): Promise<E2BCommandResult | E2BCommandHandle>;
};
type E2BCommandRunOptions = Parameters<E2BCommandsApi['run']>[1];

type E2BPtyApi = {
  create(opts: {
    cols?: number;
    rows?: number;
    size?: { cols: number; rows: number };
    cwd?: string;
    envs?: Record<string, string>;
    timeoutMs?: number;
    onData?: (data: Uint8Array) => void | Promise<void>;
  }): Promise<E2BCommandHandle>;
  sendInput?(
    pid: number,
    data: Uint8Array,
    opts?: Record<string, unknown>,
  ): Promise<void>;
  kill?(pid: number, opts?: Record<string, unknown>): Promise<boolean>;
};

export type E2BSandboxType = 'e2b' | 'e2b_code_interpreter';
export type E2BWorkspacePersistence = true | 'tar' | 'snapshot';
export type E2BTimeoutAction = 'pause' | 'kill';

export interface E2BSandboxClientOptions extends SandboxClientOptions {
  sandboxType?: E2BSandboxType;
  template?: string;
  timeout?: number;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  onTimeout?: E2BTimeoutAction;
  timeoutAction?: E2BTimeoutAction;
  autoResume?: boolean;
  metadata?: Record<string, string>;
  secure?: boolean;
  allowInternetAccess?: boolean;
  exposedPorts?: number[];
  workspacePersistence?: E2BWorkspacePersistence;
  mcp?: Record<string, unknown>;
  pauseOnExit?: boolean;
  env?: Record<string, string>;
}

export interface E2BSandboxSessionState extends SandboxSessionState {
  sandboxId: string;
  template?: string;
  sandboxType: E2BSandboxType;
  timeout?: number;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  onTimeout?: E2BTimeoutAction;
  timeoutAction?: E2BTimeoutAction;
  autoResume?: boolean;
  metadata?: Record<string, string>;
  secure?: boolean;
  allowInternetAccess?: boolean;
  configuredExposedPorts?: number[];
  workspacePersistence?: E2BWorkspacePersistence;
  mcp?: Record<string, unknown>;
  pauseOnExit: boolean;
  pauseOnExitSupported?: boolean;
  environment: Record<string, string>;
}

export class E2BSandboxSession extends RemoteSandboxSessionBase<E2BSandboxSessionState> {
  private sandbox: E2BSandboxInstance;
  private readonly ptyProcesses = new PtyProcessRegistry();
  private readonly activeMountPaths = new Set<string>();

  constructor(args: {
    state: E2BSandboxSessionState;
    sandbox: E2BSandboxInstance;
  }) {
    super({
      state: args.state,
      options: {
        providerName: 'E2BSandboxClient',
        providerId: 'e2b',
      },
    });
    this.sandbox = args.sandbox;
    this.state.pauseOnExitSupported = canPauseE2BSandbox(args.sandbox);
  }

  override supportsPty(): boolean {
    return typeof this.sandbox.pty?.create === 'function';
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    return await writePtyStdin({
      providerName: 'E2BSandboxClient',
      registry: this.ptyProcesses,
      sessionId: args.sessionId,
      chars: args.chars,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  protected override async execPtyCommand(
    args: ExecCommandArgs,
  ): Promise<string> {
    if (args.runAs) {
      throw new SandboxUnsupportedFeatureError(
        'E2BSandboxClient tty=true does not support runAs because the E2B SDK PTY API does not expose a user option.',
        {
          provider: 'e2b',
          feature: 'tty.runAs',
        },
      );
    }

    const pty = this.sandbox.pty;
    if (!pty?.create) {
      throw new SandboxUnsupportedFeatureError(
        'E2BSandboxClient tty=true requires E2B SDK PTY support.',
        {
          provider: 'e2b',
          feature: 'tty',
        },
      );
    }

    const start = Date.now();
    const command = shellCommandForPty(args);
    const entry = createPtyProcessEntry({ tty: true });
    const timeoutMs =
      typeof this.state.commandTimeoutMs === 'number'
        ? this.state.commandTimeoutMs
        : typeof this.state.timeout === 'number'
          ? Math.max(1, Math.trunc(this.state.timeout * 1000))
          : undefined;
    const handle = await pty.create({
      cols: 80,
      rows: 24,
      size: { cols: 80, rows: 24 },
      cwd: this.resolveWorkdir(args.workdir),
      envs: this.state.environment,
      timeoutMs,
      onData: (data) => appendPtyOutput(entry, data),
    });
    entry.terminate = async () => {
      if (handle.kill) {
        await handle.kill();
      } else if (pty.kill) {
        await pty.kill(handle.pid, {
          requestTimeoutMs: this.state.requestTimeoutMs,
        });
      }
    };
    if (!pty.sendInput) {
      await entry.terminate().catch(() => {});
      throw new SandboxUnsupportedFeatureError(
        'E2BSandboxClient tty=true requires E2B SDK PTY stdin support.',
        {
          provider: 'e2b',
          feature: 'tty.stdin',
        },
      );
    }
    entry.sendInput = async (chars) => {
      await pty.sendInput!(handle.pid, new TextEncoder().encode(chars), {
        requestTimeoutMs: this.state.requestTimeoutMs,
      });
    };
    watchPtyProcess(
      entry,
      async () => (handle.wait ? await handle.wait() : undefined),
      (result, error) =>
        exitCodeFromE2BResult(result) ??
        exitCodeFromE2BResult(error) ??
        exitCodeFromE2BResult(handle),
    );
    try {
      await entry.sendInput(`${command}\n`);
    } catch (error) {
      await entry.terminate().catch(() => {});
      throw error;
    }

    const { sessionId, pruned } = this.ptyProcesses.register(entry);
    if (pruned) {
      await pruned.terminate?.().catch(() => {});
    }

    return await formatPtyExecUpdate({
      registry: this.ptyProcesses,
      sessionId,
      entry,
      startTime: start,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  protected override exposedPortSource(): string {
    return 'host';
  }

  protected override async resolveRemoteExposedPort(
    requestedPort: number,
  ): Promise<ExposedPortEndpoint> {
    if (!this.sandbox.getHost) {
      throw new SandboxProviderError(
        'E2BSandboxClient exposed port resolution requires an E2B SDK getHost(port) API.',
        {
          provider: 'e2b',
          port: requestedPort,
        },
      );
    }

    let host: unknown;
    try {
      host = await this.sandbox.getHost(requestedPort);
    } catch (error) {
      throw new SandboxProviderError(
        `E2BSandboxClient failed to resolve exposed port ${requestedPort}.`,
        {
          provider: 'e2b',
          port: requestedPort,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    if (typeof host !== 'string') {
      throw new SandboxProviderError(
        'E2BSandboxClient exposed port resolution returned a non-string host.',
        {
          provider: 'e2b',
          port: requestedPort,
        },
      );
    }

    return parseExposedPortEndpoint(host, {
      providerName: 'E2BSandboxClient',
      source: 'host',
    });
  }

  async prepareWorkspaceRoot(): Promise<void> {
    const root = this.state.manifest.root;
    await this.ensureDirectory(root);
    const result = await this.sandbox.commands.run(
      `mkdir -p -- ${shellQuote(root)}`,
      {
        cwd: '/',
        envs: this.state.environment,
      },
    );
    if ((result.exitCode ?? 1) !== 0) {
      throw new SandboxProviderError(
        'E2BSandboxClient failed to prepare the workspace root.',
        {
          provider: 'e2b',
          operation: 'prepare workspace root',
          sandboxId: this.state.sandboxId,
          root,
          stderr: result.stderr ?? '',
          stdout: result.stdout ?? '',
        },
      );
    }
  }

  async persistWorkspace(): Promise<Uint8Array> {
    if (this.state.workspacePersistence === 'snapshot') {
      const archive = await this.persistWorkspaceViaNativeSnapshot();
      if (archive) {
        return archive;
      }
    } else {
      assertTarWorkspacePersistence(
        'E2BSandboxClient',
        this.state.workspacePersistence,
      );
    }

    return await this.persistWorkspaceTar();
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    const snapshotRef = decodeNativeSnapshotRef(data);
    if (snapshotRef?.provider === 'e2b') {
      await this.replaceSandboxFromSnapshot(snapshotRef.snapshotId);
      return;
    }

    if (this.state.workspacePersistence !== 'snapshot') {
      assertTarWorkspacePersistence(
        'E2BSandboxClient',
        this.state.workspacePersistence,
      );
    }
    await this.hydrateWorkspaceTar(data);
  }

  private async persistWorkspaceViaNativeSnapshot(): Promise<
    Uint8Array | undefined
  > {
    if (this.nativeSnapshotRequiresTarFallback()) {
      return undefined;
    }
    if (!this.sandbox.createSnapshot) {
      return undefined;
    }

    let snapshot: { snapshotId?: string };
    try {
      snapshot = await this.sandbox.createSnapshot();
    } catch (error) {
      throw new SandboxProviderError(
        'E2BSandboxClient failed to create a native workspace snapshot.',
        {
          provider: 'e2b',
          sandboxId: this.state.sandboxId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    if (!snapshot.snapshotId) {
      throw new SandboxProviderError(
        'E2BSandboxClient native snapshot persistence did not return a snapshot id.',
        {
          provider: 'e2b',
          sandboxId: this.state.sandboxId,
        },
      );
    }

    return encodeNativeSnapshotRef({
      provider: 'e2b',
      snapshotId: snapshot.snapshotId,
    });
  }

  private nativeSnapshotRequiresTarFallback(): boolean {
    return this.state.manifest.ephemeralPersistencePaths().size > 0;
  }

  private async replaceSandboxFromSnapshot(snapshotId: string): Promise<void> {
    const Sandbox = await loadE2BSandboxClass(this.state.sandboxType);
    const previousSandbox = this.sandbox;
    let sandbox: E2BSandboxInstance;
    try {
      sandbox = await createSandboxInstance(
        Sandbox,
        {
          ...stateToCreateOptions(this.state),
          template: snapshotId,
        },
        this.state.environment,
      );
    } catch (error) {
      throw new SandboxProviderError(
        'E2BSandboxClient failed to restore a native workspace snapshot.',
        {
          provider: 'e2b',
          snapshotId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    try {
      await previousSandbox.kill();
    } catch (error) {
      await sandbox.kill().catch(() => {});
      throw new SandboxProviderError(
        'E2BSandboxClient failed to terminate the previous sandbox while restoring a native workspace snapshot.',
        {
          provider: 'e2b',
          operation: 'restore snapshot',
          sandboxId: previousSandbox.sandboxId,
          replacementSandboxId: sandbox.sandboxId,
          snapshotId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    this.sandbox = sandbox;
    this.state.sandboxId = sandbox.sandboxId;
    delete this.state.exposedPorts;
  }

  async close(): Promise<void> {
    await withSandboxSpan(
      'sandbox.stop',
      {
        backend_id: 'e2b',
        sandbox_id: this.state.sandboxId,
      },
      async () => {
        await this.ptyProcesses.terminateAll();
        if (this.state.pauseOnExit && canPauseE2BSandbox(this.sandbox)) {
          await this.pauseOrKillAfterPauseFailure('close');
          return;
        }
        await this.unmountActiveMounts();
        await this.sandbox.kill();
      },
    );
  }

  async shutdown(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await withSandboxSpan(
      'sandbox.shutdown',
      {
        backend_id: 'e2b',
        sandbox_id: this.state.sandboxId,
      },
      async () => {
        await this.ptyProcesses.terminateAll();
        if (this.shouldPauseOnCleanup(options)) {
          return;
        }
        await this.unmountActiveMounts();
      },
    );
  }

  async delete(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await withSandboxSpan(
      'sandbox.shutdown',
      {
        backend_id: 'e2b',
        sandbox_id: this.state.sandboxId,
      },
      async () => {
        await this.ptyProcesses.terminateAll();
        if (this.shouldPauseOnCleanup(options)) {
          await this.pauseOrKillAfterPauseFailure('cleanup');
          return;
        }
        await this.unmountActiveMounts();
        await this.sandbox.kill();
      },
    );
  }

  private shouldPauseOnCleanup(
    options?: SandboxSessionLifecycleOptions,
  ): boolean {
    return (
      options?.reason === 'cleanup' &&
      options.preserveOwnedSessions === true &&
      this.state.pauseOnExit &&
      canPauseE2BSandbox(this.sandbox)
    );
  }

  private async pauseOrKillAfterPauseFailure(
    operation: 'close' | 'cleanup',
  ): Promise<boolean> {
    try {
      await this.sandbox.pause!();
      return true;
    } catch (pauseError) {
      try {
        await this.unmountActiveMounts();
        await this.sandbox.kill();
      } catch (killError) {
        throw new SandboxProviderError(
          'E2BSandboxClient failed to pause and then terminate the sandbox.',
          {
            provider: 'e2b',
            operation,
            sandboxId: this.state.sandboxId,
            pauseCause:
              pauseError instanceof Error
                ? pauseError.message
                : String(pauseError),
            killCause:
              killError instanceof Error
                ? killError.message
                : String(killError),
          },
        );
      }
      this.state.pauseOnExit = false;
      this.state.pauseOnExitSupported = false;
      return false;
    }
  }

  protected override assertExecRunAs(_runAs?: string): void {
    void _runAs;
  }

  protected override assertFilesystemRunAs(_runAs?: string): void {
    void _runAs;
  }

  protected override manifestMetadataSupport() {
    return SANDBOX_MANIFEST_METADATA_SUPPORT;
  }

  protected override manifestMaterializationOptions() {
    return {
      materializeMount: this.materializeMountEntry.bind(this),
    };
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    const result = await this.runCommandForStatus(command, {
      cwd: options.workdir,
      envs: this.state.environment,
      timeoutMs:
        options.timeoutMs ??
        (options.kind === 'exec' ? this.commandTimeoutMs() : undefined),
      user: options.runAs,
    });
    return {
      status: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: [result.stderr ?? '', result.error ?? '']
        .filter((value) => value.trim().length > 0)
        .join('\n'),
    };
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    await this.ensureDirectory(path);
  }

  protected override async readRemoteText(path: string): Promise<string> {
    if (this.sandbox.files.read) {
      const result = await this.sandbox.files.read(path);
      return typeof result === 'string'
        ? result
        : new TextDecoder().decode(result);
    }

    const result = await this.runRemoteCommand(`cat ${shellQuote(path)}`, {
      kind: 'path',
      workdir: this.state.manifest.root,
    });
    if (result.status !== 0) {
      throw new UserError(`Sandbox path not found: ${path}`);
    }
    return result.stdout ?? '';
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    if (this.sandbox.files.read) {
      const result = await this.sandbox.files.read(path, { format: 'bytes' });
      return typeof result === 'string'
        ? new TextEncoder().encode(result)
        : Uint8Array.from(result);
    }

    const encoded = await this.sandbox.commands.run(
      `base64 ${shellQuote(path)}`,
      {
        cwd: this.state.manifest.root,
        envs: this.state.environment,
      },
    );
    if ((encoded.exitCode ?? 1) !== 0 || !encoded.stdout) {
      throw new UserError(`Sandbox path not found: ${path}`);
    }

    return Uint8Array.from(
      Buffer.from(encoded.stdout.replace(/\s+/g, ''), 'base64'),
    );
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.sandbox.files.write(path, content);
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    await this.removeSandboxPath(path);
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (this.sandbox.files.makeDir) {
      await this.sandbox.files.makeDir(path);
      return;
    }
    await this.sandbox.commands.run(`mkdir -p -- ${shellQuote(path)}`, {
      cwd: '/',
      envs: this.state.environment,
    });
  }

  private async removeSandboxPath(path: string): Promise<void> {
    if (this.sandbox.files.remove) {
      await this.sandbox.files.remove(path);
      return;
    }
    await this.sandbox.commands.run(`rm -f -- ${shellQuote(path)}`, {
      cwd: this.state.manifest.root,
      envs: this.state.environment,
    });
  }

  private async materializeMountEntry(
    absolutePath: string,
    entry: Mount | TypedMount,
  ): Promise<void> {
    if (!isE2BCloudBucketMountEntry(entry)) {
      throw new SandboxUnsupportedFeatureError(
        'E2BSandboxClient only supports E2BCloudBucketMountStrategy mount entries.',
        {
          provider: 'e2b',
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
      providerName: 'E2BSandboxClient',
      providerId: 'e2b',
      strategyType: 'e2b_cloud_bucket',
      entry,
      mountPath,
      pattern: rclonePatternFromMountStrategy(entry.mountStrategy),
      runCommand: this.mountCommandRunner(),
      packageManagers: ['apt'],
      installRcloneViaScript: true,
    });
    this.activeMountPaths.add(mountPath);
  }

  private async unmountActiveMounts(): Promise<void> {
    for (const mountPath of [...this.activeMountPaths].reverse()) {
      await unmountRcloneMount({
        providerName: 'E2BSandboxClient',
        providerId: 'e2b',
        mountPath,
        runCommand: this.mountCommandRunner(),
      }).catch(() => {});
      this.activeMountPaths.delete(mountPath);
    }
  }

  private mountCommandRunner(): RemoteMountCommand {
    return async (command, options = {}) => {
      const result = await this.runCommandForStatus(command, {
        cwd: this.state.manifest.root,
        envs: this.state.environment,
        timeoutMs: options.timeoutMs,
        user: options.user,
      });
      return {
        status: result.exitCode ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? result.error ?? '',
      };
    };
  }

  private async runCommandForStatus(
    command: string,
    options?: E2BCommandRunOptions,
  ): Promise<E2BCommandResult> {
    try {
      return await this.sandbox.commands.run(command, options);
    } catch (error) {
      const result = commandResultFromE2BError(error);
      if (!result) {
        throw error;
      }
      return result;
    }
  }

  private commandTimeoutMs(): number | undefined {
    return typeof this.state.commandTimeoutMs === 'number'
      ? this.state.commandTimeoutMs
      : typeof this.state.timeout === 'number'
        ? Math.max(1, Math.trunc(this.state.timeout * 1000))
        : undefined;
  }
}

/**
 * @see {@link https://e2b.dev/docs | E2B docs}.
 * @see {@link https://e2b.dev/docs/sdk-reference/js-sdk/v2.8.0/sandbox | JavaScript SDK Sandbox reference}.
 * @see {@link https://e2b.dev/docs/sdk-reference/code-interpreter-js-sdk/v2.3.2/sandbox | Code Interpreter JavaScript SDK Sandbox reference}.
 */
export class E2BSandboxClient implements SandboxClient<
  E2BSandboxClientOptions,
  E2BSandboxSessionState
> {
  readonly backendId = 'e2b';
  private readonly options: E2BSandboxClientOptions;

  constructor(options: E2BSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<E2BSandboxClientOptions> | Manifest,
    manifestOptions?: E2BSandboxClientOptions,
  ): Promise<E2BSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported('E2BSandboxClient', createArgs.snapshot);
    assertCoreConcurrencyLimitsUnsupported(
      'E2BSandboxClient',
      createArgs.concurrencyLimits,
    );
    const manifest = createArgs.manifest;
    return await withSandboxSpan(
      'sandbox.start',
      {
        backend_id: this.backendId,
      },
      async () => {
        const resolvedOptions = {
          ...this.options,
          ...createArgs.options,
        };
        validateOptions(resolvedOptions);
        assertSandboxManifestMetadataSupported(
          'E2BSandboxClient',
          manifest,
          SANDBOX_MANIFEST_METADATA_SUPPORT,
        );
        const Sandbox = await loadE2BSandboxClass(
          resolvedOptions.sandboxType ?? 'e2b',
        );
        const environment = await materializeEnvironment(
          manifest,
          resolvedOptions.env,
        );
        const sandbox = await createSandboxInstance(
          Sandbox,
          resolvedOptions,
          environment,
        );

        const session = new E2BSandboxSession({
          sandbox,
          state: {
            manifest,
            sandboxId: sandbox.sandboxId,
            template: resolvedOptions.template,
            sandboxType: resolvedOptions.sandboxType ?? 'e2b',
            timeout: resolvedOptions.timeout,
            commandTimeoutMs: resolvedOptions.commandTimeoutMs,
            requestTimeoutMs: resolvedOptions.requestTimeoutMs,
            connectionTimeoutMs: resolvedOptions.connectionTimeoutMs,
            onTimeout: resolveE2BOnTimeout(resolvedOptions),
            timeoutAction: resolvedOptions.timeoutAction,
            autoResume: resolvedOptions.autoResume,
            metadata: resolvedOptions.metadata,
            secure: resolvedOptions.secure,
            allowInternetAccess: resolvedOptions.allowInternetAccess,
            configuredExposedPorts: resolvedOptions.exposedPorts,
            workspacePersistence: resolvedOptions.workspacePersistence,
            mcp: resolvedOptions.mcp,
            pauseOnExit: resolvedOptions.pauseOnExit ?? false,
            environment,
          },
        });

        try {
          await session.prepareWorkspaceRoot();
          await session.applyManifest(manifest);
        } catch (error) {
          session.state.pauseOnExit = false;
          await closeRemoteSessionOnManifestError('E2B', session, error);
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: E2BSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(state: E2BSandboxSessionState): boolean {
    return state.pauseOnExit && state.pauseOnExitSupported === true;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<E2BSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    return {
      ...state,
      ...baseState,
      sandboxId: readString(state, 'sandboxId'),
      template: readOptionalString(state, 'template'),
      sandboxType:
        state.sandboxType === 'e2b_code_interpreter'
          ? 'e2b_code_interpreter'
          : 'e2b',
      timeout: readOptionalNumber(state, 'timeout'),
      commandTimeoutMs: readOptionalNumber(state, 'commandTimeoutMs'),
      requestTimeoutMs: readOptionalNumber(state, 'requestTimeoutMs'),
      connectionTimeoutMs: readOptionalNumber(state, 'connectionTimeoutMs'),
      onTimeout: readOptionalE2BTimeoutAction(
        readOptionalString(state, 'onTimeout') ??
          readOptionalString(state, 'timeoutAction'),
      ),
      timeoutAction: readOptionalE2BTimeoutAction(
        readOptionalString(state, 'timeoutAction'),
      ),
      autoResume: readOptionalBoolean(state, 'autoResume'),
      metadata: readOptionalStringRecord(state.metadata),
      secure: readOptionalBoolean(state, 'secure'),
      allowInternetAccess: readOptionalBoolean(state, 'allowInternetAccess'),
      configuredExposedPorts: readOptionalNumberArray(
        state.configuredExposedPorts,
      ),
      workspacePersistence: readE2BWorkspacePersistence(
        state.workspacePersistence,
      ),
      mcp: readOptionalRecord(state.mcp),
      pauseOnExit: Boolean(state.pauseOnExit),
      pauseOnExitSupported:
        readOptionalBoolean(state, 'pauseOnExitSupported') ?? false,
    };
  }

  async resume(state: E2BSandboxSessionState): Promise<E2BSandboxSession> {
    const Sandbox = await loadE2BSandboxClass(state.sandboxType);
    const connect = Sandbox.connect ?? Sandbox.resume;
    if (connect) {
      try {
        const sandbox = await connect.call(
          Sandbox,
          state.sandboxId,
          e2bReconnectOptions(state),
        );
        return new E2BSandboxSession({ state, sandbox });
      } catch (error) {
        assertResumeRecreateAllowed(error, {
          providerName: 'E2BSandboxClient',
          provider: 'e2b',
          details: { sandboxId: state.sandboxId },
        });
        // Fall through to recreate from serialized state.
      }
    }

    return await this.create(state.manifest, {
      ...stateToCreateOptions(state),
      env: state.environment,
    });
  }
}

function validateOptions(options: E2BSandboxClientOptions): void {
  readE2BWorkspacePersistence(options.workspacePersistence);
  resolveE2BOnTimeout(options);
}

function resolveE2BOnTimeout(
  options: Pick<E2BSandboxClientOptions, 'onTimeout' | 'timeoutAction'>,
): E2BTimeoutAction | undefined {
  return readOptionalE2BTimeoutAction(
    options.onTimeout ?? options.timeoutAction,
  );
}

function readOptionalE2BTimeoutAction(
  value: unknown,
): E2BTimeoutAction | undefined {
  if (value === undefined || value === 'pause' || value === 'kill') {
    return value;
  }

  throw new SandboxUnsupportedFeatureError(
    'E2BSandboxClient onTimeout must be "pause" or "kill".',
    {
      provider: 'E2BSandboxClient',
      feature: 'onTimeout',
      onTimeout: value,
    },
  );
}

function readE2BWorkspacePersistence(
  value: unknown,
): E2BWorkspacePersistence | undefined {
  if (
    value === undefined ||
    value === true ||
    value === 'tar' ||
    value === 'snapshot'
  ) {
    return value;
  }

  throw new SandboxUnsupportedFeatureError(
    'E2BSandboxClient workspacePersistence must be true, "tar", or "snapshot".',
    {
      provider: 'E2BSandboxClient',
      feature: 'workspacePersistence',
      workspacePersistence: value,
    },
  );
}

function stateToCreateOptions(
  state: E2BSandboxSessionState,
): E2BSandboxClientOptions {
  return {
    sandboxType: state.sandboxType,
    template: state.template,
    timeout: state.timeout,
    commandTimeoutMs: state.commandTimeoutMs,
    requestTimeoutMs: state.requestTimeoutMs,
    connectionTimeoutMs: state.connectionTimeoutMs,
    onTimeout: state.onTimeout,
    timeoutAction: state.timeoutAction,
    autoResume: state.autoResume,
    metadata: state.metadata,
    secure: state.secure,
    allowInternetAccess: state.allowInternetAccess,
    exposedPorts: state.configuredExposedPorts,
    workspacePersistence: state.workspacePersistence,
    mcp: state.mcp,
    pauseOnExit: state.pauseOnExit,
  };
}

function e2bReconnectOptions(
  state: E2BSandboxSessionState,
): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (state.timeout !== undefined) {
    options.timeoutMs = Math.max(1, Math.trunc(state.timeout * 1000));
  }
  if (state.requestTimeoutMs !== undefined) {
    options.requestTimeoutMs = state.requestTimeoutMs;
  }
  if (state.connectionTimeoutMs !== undefined) {
    options.connectionTimeoutMs = state.connectionTimeoutMs;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function canPauseE2BSandbox(
  sandbox: E2BSandboxInstance,
): sandbox is E2BSandboxInstance & { pause: () => Promise<boolean> } {
  return typeof sandbox.pause === 'function';
}

async function loadE2BSandboxClass(
  sandboxType: E2BSandboxType,
): Promise<E2BSandboxClass> {
  const moduleName =
    sandboxType === 'e2b_code_interpreter' ? '@e2b/code-interpreter' : 'e2b';

  try {
    const Sandbox =
      sandboxType === 'e2b_code_interpreter'
        ? (await import('@e2b/code-interpreter')).Sandbox
        : (await import('e2b')).Sandbox;
    if (!Sandbox) {
      throw new Error(`Missing Sandbox export from ${moduleName}.`);
    }
    return adaptE2BSandboxClass(Sandbox);
  } catch (error) {
    throw new UserError(
      `E2B sandbox support requires the optional \`${moduleName}\` package. Install it before using E2B-backed sandbox examples. ${(error as Error).message}`,
    );
  }
}

function adaptE2BSandboxClass(
  Sandbox:
    | typeof import('e2b').Sandbox
    | typeof import('@e2b/code-interpreter').Sandbox,
): E2BSandboxClass {
  const sdkSandbox = Sandbox as typeof Sandbox & {
    connect?: E2BSandboxClass['connect'];
    resume?: E2BSandboxClass['resume'];
  };
  const adapted: E2BSandboxClass = {
    create: Sandbox.create.bind(Sandbox) as E2BSandboxClass['create'],
  };
  if (typeof sdkSandbox.connect === 'function') {
    adapted.connect = sdkSandbox.connect.bind(Sandbox);
  }
  if (typeof sdkSandbox.resume === 'function') {
    adapted.resume = sdkSandbox.resume.bind(Sandbox);
  }
  return adapted;
}

async function createSandboxInstance(
  Sandbox: E2BSandboxClass,
  options: E2BSandboxClientOptions,
  environment: Record<string, string>,
): Promise<E2BSandboxInstance> {
  const createOptions: Record<string, unknown> = {};
  if (typeof options.timeout === 'number') {
    createOptions.timeoutMs = Math.max(1, Math.trunc(options.timeout * 1000));
  }
  const onTimeout = resolveE2BOnTimeout(options);
  const lifecycle: Record<string, unknown> = {};
  if (onTimeout !== undefined) {
    lifecycle.onTimeout = onTimeout;
  }
  if (options.autoResume !== undefined && onTimeout === 'pause') {
    lifecycle.autoResume = options.autoResume;
  }
  if (Object.keys(lifecycle).length > 0) {
    createOptions.lifecycle = lifecycle;
  }
  for (const key of [
    'commandTimeoutMs',
    'requestTimeoutMs',
    'connectionTimeoutMs',
    'metadata',
    'secure',
    'allowInternetAccess',
    'mcp',
  ] as const) {
    if (options[key] !== undefined) {
      createOptions[key] = options[key];
    }
  }
  if (options.exposedPorts?.length) {
    createOptions.network = {
      allowPublicTraffic: true,
    };
  }
  if (Object.keys(environment).length > 0) {
    createOptions.envs = environment;
  }

  if (options.template) {
    return await withProviderError(
      'E2BSandboxClient',
      'e2b',
      'create sandbox',
      async () => await Sandbox.create(options.template, createOptions),
      { template: options.template },
    );
  }

  if (Object.keys(createOptions).length > 0) {
    return await withProviderError(
      'E2BSandboxClient',
      'e2b',
      'create sandbox',
      async () => await Sandbox.create(createOptions),
    );
  }

  return await withProviderError(
    'E2BSandboxClient',
    'e2b',
    'create sandbox',
    async () => await Sandbox.create(),
  );
}

function commandResultFromE2BError(
  error: unknown,
): E2BCommandResult | undefined {
  return commandResultFromE2BErrorValue(error, new Set<unknown>());
}

function commandResultFromE2BErrorValue(
  value: unknown,
  seen: Set<unknown>,
): E2BCommandResult | undefined {
  if (!isRecord(value) || seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const directResult = commandResultFromRecord(value);
  if (directResult) {
    return directResult;
  }

  for (const key of ['result', 'context', 'data', 'details', 'cause']) {
    const nestedResult = commandResultFromE2BErrorValue(value[key], seen);
    if (nestedResult) {
      return nestedResult;
    }
  }

  return undefined;
}

function commandResultFromRecord(
  value: Record<string, unknown>,
): E2BCommandResult | undefined {
  const exitCode =
    typeof value.exitCode === 'number' ? value.exitCode : undefined;
  const stdout = typeof value.stdout === 'string' ? value.stdout : undefined;
  const stderr =
    typeof value.stderr === 'string'
      ? value.stderr
      : typeof value.error === 'string'
        ? value.error
        : exitCode !== undefined && typeof value.message === 'string'
          ? value.message
          : undefined;
  if (exitCode === undefined && stdout === undefined && stderr === undefined) {
    return undefined;
  }

  return {
    exitCode: exitCode ?? 1,
    stdout,
    stderr,
  };
}

function exitCodeFromE2BResult(value: unknown): number | null | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.exitCode === 'number' ? value.exitCode : undefined;
}
