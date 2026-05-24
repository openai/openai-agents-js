import { UserError, getLogger } from '@openai/agents-core';
import { randomUUID } from 'node:crypto';
import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  type ExecCommandArgs,
  type ExposedPortEndpoint,
  type SandboxArchiveLimits,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxConcurrencyLimits,
  type SandboxSessionLifecycleOptions,
  type SandboxSessionState,
  type WorkspaceArchiveData,
  type WorkspaceArchiveOptions,
  type WriteStdinArgs,
  normalizeSandboxClientCreateArgs,
} from '@openai/agents-core/sandbox';
import {
  appendPtyOutput,
  assertCoreSnapshotUnsupported,
  assertResumeRecreateAllowed,
  assertSandboxManifestMetadataSupported,
  assertTarWorkspacePersistence,
  cloneManifestWithRoot,
  closeRemoteSessionOnManifestError,
  createPtyProcessEntry,
  decodeNativeSnapshotRef,
  deserializeRemoteSandboxSessionStateValues,
  encodeNativeSnapshotRef,
  formatPtyExecUpdate,
  isRecord,
  markPtyDone,
  materializeEnvironment,
  parseExposedPortEndpoint,
  persistRemoteWorkspaceTar,
  providerErrorDetails,
  providerErrorMessage,
  PtyProcessRegistry,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalString,
  readOptionalStringArray,
  readString,
  RemoteSandboxSessionBase,
  serializeRemoteSandboxSessionState,
  shellCommandForPty,
  shellQuote,
  watchPtyProcess,
  withProviderError,
  withSandboxSpan,
  writePtyStdin,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
  type RemoteWorkspaceTarIo,
} from '../shared';

const PROVIDER_NAME = 'TensorlakeSandboxClient';
const PROVIDER_ID = 'tensorlake';

const logger = getLogger('openai-agents:sandbox:tensorlake');

/** Default manifest root. The image runs as non-root tl-user; /workspace is
 *  not writable by that account, but /home/tl-user/workspace is and survives
 *  Tensorlake snapshots. */
export const DEFAULT_TENSORLAKE_WORKSPACE_ROOT = '/home/tl-user/workspace';

const TENSORLAKE_DEFAULT_PROXY_URL = 'https://sandbox.tensorlake.ai';

function resolveProxyBase(): { protocol: string; host: string } {
  const explicit = process.env.TENSORLAKE_SANDBOX_PROXY_URL;
  if (explicit) {
    try {
      const parsed = new URL(explicit);
      return { protocol: parsed.protocol, host: parsed.host };
    } catch {
      // Fall through to the trusted default.
    }
  }
  const parsed = new URL(TENSORLAKE_DEFAULT_PROXY_URL);
  return { protocol: parsed.protocol, host: parsed.host };
}

type TensorlakeRunOptions = {
  args?: string[];
  env?: Record<string, string>;
  workingDir?: string;
  timeout?: number;
  user?: string;
};

type TensorlakeRunResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
};

type TensorlakeListEntry = {
  name?: string;
  path?: string;
  isDir?: boolean;
};

type TensorlakeUpdateOptions = {
  name?: string;
  exposedPorts?: number[];
  allowUnauthenticatedAccess?: boolean;
};

type TensorlakeCheckpointType = 'memory' | 'filesystem';

type TensorlakeCheckpointWaitUntil = 'completed' | 'local_ready';

type TensorlakeCheckpointOptions = {
  checkpointType?: TensorlakeCheckpointType;
  waitUntil?: TensorlakeCheckpointWaitUntil;
  timeout?: number;
};

type TensorlakePtyOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDir?: string;
  cols?: number;
  rows?: number;
  onData?: (data: Uint8Array | string) => void | Promise<void>;
  onExit?: (exitCode: number | null) => void | Promise<void>;
};

type TensorlakePtyHandle = {
  sessionId?: string;
  token?: string;
  sendInput(data: string | Uint8Array): Promise<void>;
  resize?(cols: number, rows: number): Promise<void>;
  wait?(): Promise<number | null>;
  disconnect?(): void | Promise<void>;
  kill?(): Promise<void>;
};

type TensorlakeSandboxInfo = {
  sandboxId?: string;
  sandbox_id?: string;
  sandboxUrl?: string;
  sandbox_url?: string;
};

type TensorlakeSandboxInstance = {
  sandboxId: string;
  name?: string | null;
  run(command: string, options?: TensorlakeRunOptions): Promise<TensorlakeRunResult>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  deleteFile?(path: string): Promise<void>;
  listDirectory?(path: string): Promise<TensorlakeListEntry[]>;
  createPty?(options: TensorlakePtyOptions): Promise<TensorlakePtyHandle>;
  update?(options: TensorlakeUpdateOptions): Promise<unknown>;
  suspend?(): Promise<unknown>;
  resume?(): Promise<unknown>;
  terminate(): Promise<unknown>;
  info?(): Promise<TensorlakeSandboxInfo | undefined>;
  status?(): Promise<unknown>;
  checkpoint?(options?: TensorlakeCheckpointOptions): Promise<{ snapshotId?: string }>;
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// Tensorlake only supports suspend/resume on named sandboxes, so when
// suspendOnExit is requested without a name we mint a stable one.
const GENERATED_TENSORLAKE_NAME_PREFIX = 'openai-agents-';

// `mounts` is disabled because the session does not implement materializeMount.
// `users`/`groups`/`entry*` are advertised so manifests validate, but in the
// default 'collapse' mode the session skips account provisioning and ownership
// commands (which need root); `chmod` still runs.
const TENSORLAKE_MANIFEST_METADATA_SUPPORT = {
  users: true,
  groups: true,
  entryPermissions: true,
  entryGroups: true,
  mounts: false,
} as const;

// Mirrors Tensorlake SDK's default sandbox.checkpoint() poll timeout (300s).
const TENSORLAKE_SDK_DEFAULT_CHECKPOINT_TIMEOUT_SECS = 300;

const TRANSIENT_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_HTTP_RETRY_ATTEMPTS = 3;
const TRANSIENT_HTTP_RETRY_BACKOFF_MS = 250;

/**
 * Per-operation timeouts (seconds).
 * - execTimeoutUnboundedSecs: safety cap for exec() calls without explicit timeout (24h default).
 * - fastOpSecs: short backend ops like mkdir, deleteFile, port updates (30s default).
 * - snapshotTarSecs: tar persist/hydrate (300s default).
 */
export type TensorlakeSandboxTimeouts = {
  execTimeoutUnboundedSecs?: number;
  fastOpSecs?: number;
  snapshotTarSecs?: number;
};

const DEFAULT_TENSORLAKE_TIMEOUTS = {
  execTimeoutUnboundedSecs: 24 * 60 * 60,
  fastOpSecs: 30,
  snapshotTarSecs: 300,
} as const satisfies Required<TensorlakeSandboxTimeouts>;

type ResolvedTensorlakeTimeouts = Required<TensorlakeSandboxTimeouts>;

const TIMEOUT_KEYS = Object.keys(
  DEFAULT_TENSORLAKE_TIMEOUTS,
) as (keyof TensorlakeSandboxTimeouts)[];

function resolveTimeouts(
  input: TensorlakeSandboxTimeouts | undefined,
): ResolvedTensorlakeTimeouts {
  const resolved = { ...DEFAULT_TENSORLAKE_TIMEOUTS } as ResolvedTensorlakeTimeouts;
  for (const key of TIMEOUT_KEYS) {
    if (input?.[key] !== undefined) resolved[key] = input[key]!;
    if (!Number.isFinite(resolved[key]) || resolved[key] <= 0) {
      throw new UserError(
        `${PROVIDER_NAME} timeouts.${key} must be a positive finite number.`,
      );
    }
  }
  return resolved;
}

function extractHttpStatus(error: unknown): number | undefined {
  // providerErrorDetails walks cause/response chains but skips
  // SandboxProviderError.details where wrapped re-throws stash upstream status.
  const wrapped = isRecord(error) ? error.details : undefined;
  for (const bag of [providerErrorDetails(error), isRecord(wrapped) ? wrapped : undefined]) {
    if (!bag) continue;
    for (const key of ['status', 'httpStatus', 'responseStatus']) {
      const value = bag[key];
      if (typeof value === 'number' && Number.isInteger(value)) return value;
    }
  }
  return undefined;
}

async function retryTransientHttp<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = extractHttpStatus(error);
      const transient =
        status !== undefined && TRANSIENT_HTTP_STATUS_CODES.has(status);
      if (!transient || attempt === TRANSIENT_HTTP_RETRY_ATTEMPTS - 1) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, TRANSIENT_HTTP_RETRY_BACKOFF_MS * 2 ** attempt),
      );
    }
  }
}

type TensorlakeSandboxClass = {
  create(options?: Record<string, unknown>): Promise<TensorlakeSandboxInstance>;
  connect(options: { sandboxId: string } & Record<string, unknown>): Promise<TensorlakeSandboxInstance>;
};

export type TensorlakeWorkspacePersistence = true | 'tar' | 'snapshot';

/**
 * How the provider handles manifest identity declarations (users/groups/entry
 * ownership). The default Tensorlake image only ships non-root `tl-user`.
 *
 * - `'collapse'` (default): skip account provisioning and ownership commands;
 *   everything runs as `tl-user`. `chmod` still runs. A single warning is
 *   logged per `applyManifest()` when anything is dropped.
 * - `'provision'`: run `groupadd`/`useradd`/`usermod`/`chown`/`chgrp` as usual.
 *   Requires a custom Tensorlake image that exposes root.
 */
export type TensorlakeManifestIdentitiesMode = 'collapse' | 'provision';

export interface TensorlakeSandboxClientOptions extends SandboxClientOptions {
  /** Sandbox name. Required for suspend/resume; auto-generated when suspendOnExit is true. */
  name?: string;
  /** Sandbox image name or ID. Defaults to the platform default image. */
  image?: string;
  cpus?: number;
  memoryMb?: number;
  /** Root disk size in MB. Uses the SDK default when unset. */
  diskMb?: number;
  /** Auto-suspend (named) or auto-terminate (ephemeral) after this many seconds of idleness. */
  timeoutSecs?: number;
  /** Max seconds to wait for the sandbox to reach Running after create. */
  startupTimeout?: number;
  /** Names of secrets to inject as environment variables. */
  secretNames?: string[];
  entrypoint?: string[];
  allowInternetAccess?: boolean;
  allowOut?: string[];
  denyOut?: string[];
  /** User ports to expose at create-time. Listed entries skip late update. */
  exposedPorts?: number[];
  allowUnauthenticatedAccess?: boolean;
  /** API key override; defaults to process.env.TENSORLAKE_API_KEY. */
  apiKey?: string;
  /** Pool id for pre-warmed sandbox. Mutually exclusive with snapshot restore (snapshot wins). */
  poolId?: string;
  /** Override the sandbox proxy URL (self-hosted/dev). Forwarded to Sandbox.create/connect. */
  proxyUrl?: string;
  /** Override the control-plane API URL. */
  apiUrl?: string;
  /** Tensorlake namespace selector. */
  namespace?: string;
  /** Tensorlake organization id. */
  organizationId?: string;
  /** Tensorlake project id. */
  projectId?: string;
  /** Routing hint for Sandbox.connect on resume. Not used at create time. */
  routingHint?: string;
  /** Per-command default timeout in seconds. */
  commandTimeoutSecs?: number;
  /** Fine-grained per-op timeouts. Defaults: 24h exec cap, 30s fast ops, 300s tar persist. */
  timeouts?: TensorlakeSandboxTimeouts;
  /** Workspace persist mode: 'tar' (default) or 'snapshot' (uses sandbox.checkpoint). */
  workspacePersistence?: TensorlakeWorkspacePersistence;
  /** How to apply manifest identities. 'collapse' (default) skips root-only commands. */
  manifestIdentities?: TensorlakeManifestIdentitiesMode;
  /** Workspace tar archive caps. Defaults from DEFAULT_SANDBOX_ARCHIVE_LIMITS; null disables. */
  archiveLimits?: SandboxArchiveLimits | null;
  /** Checkpoint type used when workspacePersistence === 'snapshot'. */
  snapshotCheckpointType?: TensorlakeCheckpointType;
  /** Timeout (s) forwarded to sandbox.checkpoint() when persistence is 'snapshot'. */
  checkpointTimeoutSecs?: number;
  /**
   * Native checkpoint wait mode. 'local_ready' (default) returns once locally
   * resumable on the same backend; 'completed' additionally blocks for durable
   * remote-storage upload (use only when a durable snapshot_uri is required).
   */
  checkpointWaitUntil?: TensorlakeCheckpointWaitUntil;
  /** Suspend named sandboxes on close instead of terminating. Auto-mints a name when unset. */
  suspendOnExit?: boolean;
  /** Materialized environment variables for sandbox commands. */
  env?: Record<string, string>;
}

type TensorlakeControlPlaneOptions = Pick<
  TensorlakeSandboxClientOptions,
  | 'apiKey'
  | 'proxyUrl'
  | 'apiUrl'
  | 'namespace'
  | 'organizationId'
  | 'projectId'
  | 'routingHint'
>;

// Constructor-supplied options that override session state on resume —
// persisted state may have been tampered with, so trusted in-process options
// win for security-sensitive fields (routing, image, egress, ports). Applied
// at the resume() boundary via withTrustedRecreateOverrides.
type TensorlakeTrustedRecreateOptions = TensorlakeControlPlaneOptions &
  Pick<
    TensorlakeSandboxClientOptions,
    | 'image'
    | 'entrypoint'
    | 'secretNames'
    | 'allowInternetAccess'
    | 'allowOut'
    | 'denyOut'
    | 'exposedPorts'
    | 'allowUnauthenticatedAccess'
  >;

export interface TensorlakeSandboxSessionState extends SandboxSessionState {
  sandboxId: string;
  name?: string;
  image?: string;
  cpus?: number;
  memoryMb?: number;
  diskMb?: number;
  timeoutSecs?: number;
  startupTimeout?: number;
  secretNames?: string[];
  entrypoint?: string[];
  allowInternetAccess?: boolean;
  allowOut?: string[];
  denyOut?: string[];
  configuredExposedPorts?: number[];
  allowUnauthenticatedAccess?: boolean;
  commandTimeoutSecs?: number;
  timeouts?: TensorlakeSandboxTimeouts;
  poolId?: string;
  proxyUrl?: string;
  apiUrl?: string;
  namespace?: string;
  organizationId?: string;
  projectId?: string;
  routingHint?: string;
  workspacePersistence?: TensorlakeWorkspacePersistence;
  manifestIdentities?: TensorlakeManifestIdentitiesMode;
  snapshotCheckpointType?: TensorlakeCheckpointType;
  checkpointTimeoutSecs?: number;
  checkpointWaitUntil?: TensorlakeCheckpointWaitUntil;
  suspendOnExit: boolean;
  environment: Record<string, string>;
  /**
   * Snapshot id from persistWorkspace() that still matches the live workspace
   * — cleared by any mutation (exec, writeFile, deleteFile, mkdir, PTY,
   * hydrate-tar, persist-tar) so resume()'s fast-path never silently restores
   * a stale checkpoint. When unset, resume falls through to a clean recreate
   * from the manifest; callers who stored the persistWorkspace() archive can
   * still call hydrateWorkspace(archive) on the new session for best-effort
   * recovery from the previous snapshot.
   */
  snapshotId?: string;
  /** Workspace root already exists on the backend; skip mkdir -p. */
  workspaceRootProvisioned?: boolean;
  /** Manifest user/group accounts already present (e.g. from snapshot image); skip provisioning. */
  systemSetupPreserved?: boolean;
}

export class TensorlakeSandboxSession extends RemoteSandboxSessionBase<TensorlakeSandboxSessionState> {
  private sandbox: TensorlakeSandboxInstance;
  private readonly ptyProcesses = new PtyProcessRegistry();
  private readonly exposedPortConfigured = new Set<number>();
  private readonly trustedRecreateOptions: TensorlakeTrustedRecreateOptions;
  private cachedProxyHostname: string | null | undefined = undefined;
  private hasWarnedAboutMissingSandboxUrl = false;
  private readonly resolvedTimeouts: ResolvedTensorlakeTimeouts;

  constructor(args: {
    state: TensorlakeSandboxSessionState;
    sandbox: TensorlakeSandboxInstance;
    concurrencyLimits?: SandboxConcurrencyLimits;
    archiveLimits?: SandboxArchiveLimits | null;
    trustedRecreateOptions?: TensorlakeTrustedRecreateOptions;
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
    this.sandbox = args.sandbox;
    this.trustedRecreateOptions = args.trustedRecreateOptions ?? {};
    this.resolvedTimeouts = resolveTimeouts(this.state.timeouts);
    for (const port of this.state.configuredExposedPorts ?? []) {
      this.exposedPortConfigured.add(port);
    }
  }

  override supportsPty(): boolean {
    return typeof this.sandbox.createPty === 'function';
  }

  // tensorlake >=0.5.14 supports per-command user override on run(); PTY
  // runAs is checked separately because createPty() does not expose it.
  protected override assertExecRunAs(_runAs?: string): void {}

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    // PTY keystrokes can mutate the workspace; invalidate so a later resume
    // after sandbox death doesn't fast-restore a pre-keystroke snapshot.
    this.invalidateCachedSnapshot();
    return await writePtyStdin({
      providerName: PROVIDER_NAME,
      registry: this.ptyProcesses,
      sessionId: args.sessionId,
      chars: args.chars,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  protected override manifestMetadataSupport() {
    return TENSORLAKE_MANIFEST_METADATA_SUPPORT;
  }

  protected override exposedPortSource(): string {
    return 'host';
  }

  protected override allowOnDemandExposedPorts(): boolean {
    return true;
  }

  protected override async resolveRemoteExposedPort(
    requestedPort: number,
  ): Promise<ExposedPortEndpoint> {
    if (!this.exposedPortConfigured.has(requestedPort)) {
      const desired = new Set(this.exposedPortConfigured);
      desired.add(requestedPort);
      await updateExposedPorts(this.sandbox, {
        exposedPorts: Array.from(desired),
        allowUnauthenticatedAccess: this.state.allowUnauthenticatedAccess,
        fastOpSecs: this.resolvedTimeouts.fastOpSecs,
        onDemandPort: requestedPort,
      });
      this.exposedPortConfigured.add(requestedPort);
      this.state.configuredExposedPorts = Array.from(
        this.exposedPortConfigured,
      );
    }

    const resolvedHostname = await this.getProxyHostname();
    if (resolvedHostname) {
      return parseExposedPortEndpoint(
        `https://${requestedPort}-${resolvedHostname}`,
        { providerName: PROVIDER_NAME, source: 'host' },
      );
    }
    const base = resolveProxyBase();
    const fallbackHost = `${requestedPort}-${this.state.name ?? this.state.sandboxId}.${base.host}`;
    return parseExposedPortEndpoint(`${base.protocol}//${fallbackHost}`, {
      providerName: PROVIDER_NAME,
      source: 'host',
    });
  }

  private async getProxyHostname(): Promise<string | null> {
    if (this.cachedProxyHostname !== undefined) return this.cachedProxyHostname;
    const sandboxUrl = await this.fetchSandboxUrl();
    const hostname = parseProxyHostname(sandboxUrl);
    this.cachedProxyHostname = hostname;
    if (
      hostname === null &&
      this.usesCustomControlPlane() &&
      !this.hasWarnedAboutMissingSandboxUrl
    ) {
      this.hasWarnedAboutMissingSandboxUrl = true;
      logger.warn(
        'TensorlakeSandboxClient could not resolve a sandbox URL from sandbox.info(); ' +
          "falling back to the public '<port>-<name>.sandbox.tensorlake.ai' template, " +
          'which will not route correctly for this custom proxyUrl/apiUrl deployment.',
      );
    }
    return hostname;
  }

  private usesCustomControlPlane(): boolean {
    const t = this.trustedRecreateOptions;
    return Boolean(t.proxyUrl || t.apiUrl || this.state.proxyUrl || this.state.apiUrl);
  }

  private async fetchSandboxUrl(): Promise<string | undefined> {
    if (!this.sandbox.info) return undefined;
    // Tensorlake's create-time info cache can omit sandbox_url; a status()
    // round-trip forces the SDK to refresh before info() is read. Result is
    // cached by the caller, so the extra round-trip happens at most once.
    if (typeof this.sandbox.status === 'function') {
      try {
        await this.sandbox.status();
      } catch {
        return undefined;
      }
    }
    return await readInfoSandboxUrl(this.sandbox);
  }

  protected override async execPtyCommand(
    args: ExecCommandArgs,
  ): Promise<string> {
    if (args.runAs) {
      throw new SandboxUnsupportedFeatureError(
        `${PROVIDER_NAME} tty=true does not support runAs because the Tensorlake SDK PTY API does not expose a user option.`,
        { provider: PROVIDER_ID, feature: 'tty.runAs' },
      );
    }
    if (!this.sandbox.createPty) {
      throw new SandboxUnsupportedFeatureError(
        `${PROVIDER_NAME} tty=true requires Tensorlake SDK PTY support.`,
        { provider: PROVIDER_ID, feature: 'tty' },
      );
    }

    // An interactive shell can mutate the workspace at any point during its
    // lifetime, so invalidate up front rather than trying to track per-keystroke.
    this.invalidateCachedSnapshot();
    const start = Date.now();
    const command = shellCommandForPty(args);
    const entry = createPtyProcessEntry({ tty: true });
    const handle = await this.sandbox.createPty({
      command: '/bin/bash',
      args: ['-l'],
      cols: 80,
      rows: 24,
      env: this.state.environment,
      workingDir: this.resolveWorkdir(args.workdir),
      onData: (data) => appendPtyOutput(entry, data),
      onExit: (exitCode) => markPtyDone(entry, exitCode ?? null),
    });
    entry.sendInput = async (chars) => {
      await handle.sendInput(chars);
    };
    entry.terminate = async () => {
      try {
        if (handle.kill) {
          await handle.kill();
        } else if (handle.disconnect) {
          await handle.disconnect();
        }
      } catch {
        // best-effort
      }
    };
    if (handle.wait) {
      watchPtyProcess(
        entry,
        async () => await handle.wait!(),
        (result) => (typeof result === 'number' ? result : null),
      );
    }
    try {
      await entry.sendInput(`${command}\n`);
    } catch (error) {
      await entry.terminate?.().catch(() => {});
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

  async prepareWorkspaceRoot(): Promise<void> {
    if (this.state.workspaceRootProvisioned) return;
    await this.mkdirRemote(this.state.manifest.root);
    this.state.workspaceRootProvisioned = true;
  }

  // 'collapse' (default) skips user/group provisioning and ownership commands
  // because the default Tensorlake image ships only tl-user and no root;
  // chmod still runs. 'provision' opts into base-class behavior on custom
  // images with root. Per-process exec `runAs` is independently supported via
  // the SDK's `user:` option (see assertExecRunAs).
  private collapseManifestIdentities(): boolean {
    return (this.state.manifestIdentities ?? 'collapse') === 'collapse';
  }

  protected override manifestAccountsAlreadyProvisioned(): boolean {
    return (
      this.collapseManifestIdentities() ||
      Boolean(this.state.systemSetupPreserved)
    );
  }

  protected override shouldApplyManifestEntryOwnership(): boolean {
    return !this.collapseManifestIdentities();
  }

  protected override async beforeApplyManifest(
    manifest: Manifest,
  ): Promise<void> {
    if (!this.collapseManifestIdentities()) return;
    const dropped: string[] = [];
    if (manifest.users.length > 0) dropped.push(`${manifest.users.length} user(s)`);
    if (manifest.groups.length > 0) dropped.push(`${manifest.groups.length} group(s)`);
    const entriesWithGroup = Object.values(manifest.entries).filter(
      (entry) => entry.group !== undefined,
    ).length;
    if (entriesWithGroup > 0) dropped.push(`${entriesWithGroup} entry ownership setting(s)`);
    if (dropped.length === 0) return;
    logger.warn(
      `${PROVIDER_NAME} is collapsing manifest identities to the default 'tl-user' account because the base image does not expose root; dropping: ${dropped.join(', ')}. File modes (chmod) are still applied. Set manifestIdentities: 'provision' on a custom image with root to enable full provisioning.`,
    );
  }

  // Mark the session as resuming from a backend image that already carries
  // the workspace root and account database (reconnect or snapshot restore).
  markPreservedFromSnapshot(): void {
    this.state.workspaceRootProvisioned = true;
    this.state.systemSetupPreserved = true;
  }

  // Any operation that may have mutated the workspace invalidates the cached
  // snapshotId, because resume()'s fast-path would otherwise silently restore
  // a pre-mutation checkpoint after the sandbox dies. Callers wanting partial
  // recovery can still pass a stored archive to hydrateWorkspace() explicitly.
  private invalidateCachedSnapshot(): void {
    if (this.state.snapshotId !== undefined) {
      this.state.snapshotId = undefined;
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
        PROVIDER_NAME,
        this.state.workspacePersistence,
      );
    }

    return await this.persistWorkspaceTar();
  }

  async hydrateWorkspace(
    data: WorkspaceArchiveData,
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    const snapshotRef = decodeNativeSnapshotRef(data);
    if (snapshotRef?.provider === 'tensorlake') {
      await this.replaceSandboxFromSnapshot(snapshotRef.snapshotId);
      return;
    }
    // Snapshot-mode sessions intentionally accept a tar archive here so a
    // session created before snapshot mode was enabled can still be hydrated;
    // the assertion only fires for unknown future persistence modes.
    if (this.state.workspacePersistence !== 'snapshot') {
      assertTarWorkspacePersistence(
        PROVIDER_NAME,
        this.state.workspacePersistence,
      );
    }
    await this.hydrateWorkspaceTar(data, options);
    // Workspace contents now diverge from any snapshot we still hold, so the
    // cached snapshotId is no longer a valid resume target.
    this.state.snapshotId = undefined;
  }

  private async persistWorkspaceViaNativeSnapshot(): Promise<
    Uint8Array | undefined
  > {
    if (this.state.manifest.ephemeralPersistencePaths().size > 0) return undefined;
    if (!this.sandbox.checkpoint) return undefined;

    // waitUntil='local_ready' is sufficient for same-backend restore via
    // Sandbox.create({ snapshotId }); use 'completed' only when a durable
    // snapshot_uri is required (e.g. cross-host restore).
    const checkpointOptions: TensorlakeCheckpointOptions = {
      waitUntil: this.state.checkpointWaitUntil ?? 'local_ready',
    };
    if (this.state.snapshotCheckpointType) {
      checkpointOptions.checkpointType = this.state.snapshotCheckpointType;
    }
    if (typeof this.state.checkpointTimeoutSecs === 'number') {
      checkpointOptions.timeout = this.state.checkpointTimeoutSecs;
    }
    let snapshot: { snapshotId?: string };
    try {
      snapshot = await this.sandbox.checkpoint(checkpointOptions);
    } catch (error) {
      throw new SandboxProviderError(
        `${PROVIDER_NAME} failed to capture a native workspace snapshot.`,
        {
          provider: PROVIDER_ID,
          sandboxId: this.state.sandboxId,
          cause: providerErrorMessage(error),
        },
      );
    }
    if (!snapshot.snapshotId) {
      throw new SandboxProviderError(
        `${PROVIDER_NAME} native snapshot persistence did not return a snapshot id.`,
        { provider: PROVIDER_ID, sandboxId: this.state.sandboxId },
      );
    }
    // Cache so resume() can fast-path via Sandbox.create({ snapshotId }).
    this.state.snapshotId = snapshot.snapshotId;
    return encodeNativeSnapshotRef({
      provider: PROVIDER_ID,
      snapshotId: snapshot.snapshotId,
    });
  }

  private async replaceSandboxFromSnapshot(snapshotId: string): Promise<void> {
    // Tensorlake names are unique per namespace; we can't create a new named
    // sandbox while the previous is alive. When update() is available we
    // create unnamed → terminate → rename (non-destructive on create failure).
    // Without update() we must terminate first (destructive on create failure).
    const previousSandbox = this.sandbox;
    const desiredName = this.state.name;
    const canRenameAfterCreate =
      Boolean(desiredName) && typeof previousSandbox.update === 'function';
    if (desiredName && !canRenameAfterCreate) {
      await previousSandbox.terminate().catch(() => {});
    }
    const { sandbox, sandboxId: newSandboxId } =
      await restoreSandboxFromSnapshot({
        state: this.state,
        snapshotId,
        apiKey: this.trustedRecreateOptions.apiKey,
        fastOpSecs: this.resolvedTimeouts.fastOpSecs,
        omitName: canRenameAfterCreate,
        wrapCreateErrorMessage: `${PROVIDER_NAME} failed to restore a native workspace snapshot.`,
      });
    try {
      if (canRenameAfterCreate || !desiredName) {
        await previousSandbox.terminate().catch(() => {});
      }
      const renameFailed = canRenameAfterCreate
        ? await this.renameRestoredSandbox(sandbox, desiredName!)
        : false;
      this.adoptRestoredSandbox(sandbox, {
        sandboxId: newSandboxId,
        name: renameFailed ? undefined : (sandbox.name ?? desiredName),
        snapshotId,
      });
    } catch (error) {
      await sandbox.terminate().catch(() => {});
      throw error;
    }
  }

  /**
   * Swap the live sandbox for a restored one and reset session state that is
   * tied to the previous sandbox's identity (URL cache, exposed-port cache,
   * cached snapshot id).
   */
  private adoptRestoredSandbox(
    sandbox: TensorlakeSandboxInstance,
    args: RestoredSandboxIdentity,
  ): void {
    this.sandbox = sandbox;
    applyRestoredSandboxIdentity(this.state, args);
    // Restored sandbox has a new sandbox_url.
    this.cachedProxyHostname = undefined;
    this.exposedPortConfigured.clear();
    for (const port of this.state.configuredExposedPorts ?? []) {
      this.exposedPortConfigured.add(port);
    }
  }

  /**
   * Issue the post-create rename for a restored sandbox. Returns `true` when
   * the rename failed (caller treats the session as ephemeral and disables
   * suspend/resume); `false` on success.
   */
  private async renameRestoredSandbox(
    sandbox: TensorlakeSandboxInstance,
    desiredName: string,
  ): Promise<boolean> {
    try {
      await sandbox.update!({ name: desiredName });
      return false;
    } catch (renameError) {
      // Previous sandbox is already gone, so we can't roll back to it. The
      // new sandbox is functional but ephemeral — log loudly and disable
      // suspendOnExit so the broken named lifecycle is visible rather than
      // silently degrading on close().
      this.state.suspendOnExit = false;
      logger.error(
        `${PROVIDER_NAME} could not rename the restored sandbox to '${desiredName}'; suspend/resume is unavailable for this session. ${providerErrorMessage(renameError)}`,
      );
      return true;
    }
  }

  async close(): Promise<void> {
    await this.stopSession('sandbox.stop', true);
  }

  async shutdown(_options?: SandboxSessionLifecycleOptions): Promise<void> {
    await withSandboxSpan(
      'sandbox.shutdown',
      { backend_id: PROVIDER_ID, sandbox_id: this.state.sandboxId },
      async () => {
        await this.ptyProcesses.terminateAll();
      },
    );
  }

  async delete(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await this.stopSession('sandbox.shutdown', this.shouldSuspend(options));
  }

  private async stopSession(span: string, suspend: boolean): Promise<void> {
    await withSandboxSpan(
      span,
      { backend_id: PROVIDER_ID, sandbox_id: this.state.sandboxId },
      async () => {
        await this.ptyProcesses.terminateAll();
        if (suspend && this.canSuspend()) {
          await this.suspendOrTerminateAfterFailure();
          return;
        }
        await this.sandbox.terminate();
      },
    );
  }

  private canSuspend(): boolean {
    return (
      this.state.suspendOnExit &&
      Boolean(this.state.name) &&
      typeof this.sandbox.suspend === 'function'
    );
  }

  private shouldSuspend(options?: SandboxSessionLifecycleOptions): boolean {
    return options?.reason === 'cleanup' && options.preserveOwnedSessions === true;
  }

  private async suspendOrTerminateAfterFailure(): Promise<void> {
    try {
      await this.sandbox.suspend!();
    } catch (suspendError) {
      try {
        await this.sandbox.terminate();
      } catch (terminateError) {
        throw new SandboxProviderError(
          `${PROVIDER_NAME} failed to suspend and then terminate the sandbox.`,
          {
            provider: PROVIDER_ID,
            sandboxId: this.state.sandboxId,
            suspendCause: providerErrorMessage(suspendError),
            terminateCause: providerErrorMessage(terminateError),
          },
        );
      }
      this.state.suspendOnExit = false;
    }
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    // exec is opaque (could be a read or a write), so treat every command as
    // potentially mutating and invalidate the cached snapshot pre-emptively.
    this.invalidateCachedSnapshot();
    let result: TensorlakeRunResult;
    try {
      // Pass `user` natively so we can skip the `sudo -u <name> --` wrap; the
      // default Tensorlake image often lacks sudo, and the SDK already accepts
      // a per-call user override.
      result = await this.sandbox.run('/bin/bash', {
        args: ['-lc', command],
        env: this.state.environment,
        workingDir: options.workdir,
        timeout: this.commandTimeoutSecs(options),
        ...(options.runAs ? { user: options.runAs } : {}),
      });
    } catch (error) {
      // Preserve upstream HTTP status so the tar-persist retry can still
      // see transient failures after we wrap into SandboxProviderError.
      const status = extractHttpStatus(error);
      throw new SandboxProviderError(`${PROVIDER_NAME} command execution failed.`, {
        provider: PROVIDER_ID,
        sandboxId: this.state.sandboxId,
        command,
        cause: providerErrorMessage(error),
        ...(typeof status === 'number' ? { status } : {}),
      });
    }
    return {
      status: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    this.invalidateCachedSnapshot();
    // Pass argv directly to avoid /bin/bash -lc quoting for unusual paths.
    let result: TensorlakeRunResult;
    try {
      result = await this.sandbox.run('mkdir', {
        args: ['-p', '--', path],
        env: this.state.environment,
        timeout: this.resolvedTimeouts.fastOpSecs,
      });
    } catch (error) {
      throw new SandboxProviderError(`${PROVIDER_NAME} failed to create directory.`, {
        provider: PROVIDER_ID,
        path,
        cause: providerErrorMessage(error),
      });
    }
    if ((result.exitCode ?? 1) !== 0) {
      throw new SandboxProviderError(`${PROVIDER_NAME} failed to create directory.`, {
        provider: PROVIDER_ID,
        path,
        stderr: result.stderr ?? '',
        stdout: result.stdout ?? '',
      });
    }
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    try {
      const bytes = await this.sandbox.readFile(path);
      return bytes instanceof Uint8Array
        ? bytes
        : Uint8Array.from(bytes as ArrayLike<number>);
    } catch (error) {
      throw new UserError(
        `Sandbox path not found: ${path} (${providerErrorMessage(error)})`,
      );
    }
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.invalidateCachedSnapshot();
    const bytes =
      typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await this.sandbox.writeFile(path, bytes);
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    this.invalidateCachedSnapshot();
    if (this.sandbox.deleteFile) {
      try {
        await withTimeout(
          this.sandbox.deleteFile(path),
          this.resolvedTimeouts.fastOpSecs * 1000,
          `${PROVIDER_NAME} deleteFile(${path}) timed out`,
        );
        return;
      } catch {
        // Fall through to shell rm in case the path doesn't exist.
      }
    }
    const result = await this.runRemoteCommand(`rm -rf -- ${shellQuote(path)}`, {
      kind: 'manifest',
      workdir: '/',
    });
    if (result.status !== 0) {
      throw new SandboxProviderError(`${PROVIDER_NAME} failed to delete path.`, {
        provider: PROVIDER_ID,
        path,
        stderr: result.stderr ?? '',
        stdout: result.stdout ?? '',
      });
    }
  }

  // Tar uploads see frequent transient HTTP failures (typically 5xx during
  // large-file streaming), so wrap the shared persist with a bounded retry.
  protected override async persistWorkspaceTar(): Promise<Uint8Array> {
    const baseIo = this.archiveIo();
    const retriedIo: RemoteWorkspaceTarIo = {
      ...baseIo,
      runCommand: async (command) =>
        await retryTransientHttp(async () => await baseIo.runCommand(command)),
    };
    const archive = await persistRemoteWorkspaceTar({
      providerName: PROVIDER_NAME,
      manifest: this.state.manifest,
      io: retriedIo,
    });
    // A tar persist supersedes any prior native snapshot — clear the cached
    // snapshotId so the resume fast-path doesn't restore stale state.
    this.state.snapshotId = undefined;
    return archive;
  }

  private commandTimeoutSecs(
    options: RemoteSandboxCommandOptions,
  ): number | undefined {
    if (typeof options.timeoutMs === 'number') {
      return Math.max(1, Math.ceil(options.timeoutMs / 1000));
    }
    switch (options.kind) {
      case 'exec':
        // Per-call commandTimeoutSecs wins; otherwise apply the 24h unbounded
        // safety cap so a runaway command can't hold the sandbox indefinitely.
        return (
          this.state.commandTimeoutSecs ??
          this.resolvedTimeouts.execTimeoutUnboundedSecs
        );
      case 'archive':
        return this.resolvedTimeouts.snapshotTarSecs;
      case 'manifest':
      case 'path':
      case 'running':
        return this.resolvedTimeouts.fastOpSecs;
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(
      () => reject(new Error(`${message} after ${Math.round(timeoutMs)}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => { clearTimeout(handle); resolve(value); },
      (error) => { clearTimeout(handle); reject(error); },
    );
  });
}

/**
 * Tensorlake sandbox provider.
 *
 * @see {@link https://docs.tensorlake.ai/sandboxes/sdk-reference | Tensorlake SDK reference}
 * @see {@link https://docs.tensorlake.ai/sandboxes/introduction | Sandboxes overview}
 */
export class TensorlakeSandboxClient implements SandboxClient<
  TensorlakeSandboxClientOptions,
  TensorlakeSandboxSessionState
> {
  readonly backendId = 'tensorlake';
  private readonly options: TensorlakeSandboxClientOptions;

  constructor(options: TensorlakeSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<TensorlakeSandboxClientOptions> | Manifest,
    manifestOptions?: TensorlakeSandboxClientOptions,
  ): Promise<TensorlakeSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported(PROVIDER_NAME, createArgs.snapshot);
    const manifest = resolveManifestRoot(createArgs.manifest);
    return await withSandboxSpan(
      'sandbox.start',
      { backend_id: this.backendId },
      async () => {
        const merged: TensorlakeSandboxClientOptions = {
          ...this.options,
          ...createArgs.options,
        };
        // Auto-mint a name when suspendOnExit lacks one (suspend/resume is named-only).
        const resolvedOptions: TensorlakeSandboxClientOptions = {
          ...merged,
          name: resolveLifecycleSandboxName({
            name: merged.name,
            suspendOnExit: merged.suspendOnExit ?? false,
          }),
        };
        validateOptions(resolvedOptions);
        const resolvedTimeouts = resolveTimeouts(resolvedOptions.timeouts);
        assertSandboxManifestMetadataSupported(
          PROVIDER_NAME,
          manifest,
          TENSORLAKE_MANIFEST_METADATA_SUPPORT,
        );

        const Sandbox = await loadTensorlakeSandboxClass();
        const environment = await materializeEnvironment(
          manifest,
          resolvedOptions.env,
        );
        const lifecycleCfg = buildLifecycleConfig(
          resolvedOptions,
          environment,
          resolvedOptions.apiKey,
        );
        const sandbox = await withProviderError(
          PROVIDER_NAME,
          PROVIDER_ID,
          'create sandbox',
          async () => await Sandbox.create(buildCreateKwargs(lifecycleCfg)),
        );

        const sandboxId = await resolveSandboxId(sandbox).catch(
          async (error) => {
            await sandbox.terminate().catch(() => {});
            throw error;
          },
        );

        try {
          await applyPortConfiguration(
            sandbox,
            resolvedOptions,
            resolvedTimeouts.fastOpSecs,
          );
        } catch (error) {
          await sandbox.terminate().catch(() => {});
          throw error;
        }

        const session = new TensorlakeSandboxSession({
          sandbox,
          concurrencyLimits: createArgs.concurrencyLimits,
          archiveLimits: createArgs.archiveLimits,
          trustedRecreateOptions: pickTrustedRecreateOptions(resolvedOptions),
          state: buildSessionStateFromCreate({
            manifest,
            sandboxId,
            sandboxName: sandbox.name ?? resolvedOptions.name,
            environment,
            options: resolvedOptions,
          }),
        });

        try {
          await session.prepareWorkspaceRoot();
          await session.applyManifest(manifest);
        } catch (error) {
          session.state.suspendOnExit = false;
          await closeRemoteSessionOnManifestError('Tensorlake', session, error);
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: TensorlakeSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(state: TensorlakeSandboxSessionState): boolean {
    return state.suspendOnExit && Boolean(state.name);
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<TensorlakeSandboxSessionState> {
    const out: Record<string, unknown> = {
      ...state,
      ...deserializeRemoteSandboxSessionStateValues(state, this.options.env),
      sandboxId: readString(state, 'sandboxId'),
      configuredExposedPorts: readOptionalNumberArray(state.configuredExposedPorts),
      timeouts: readTimeouts(state.timeouts),
      workspacePersistence: readWorkspacePersistence(state.workspacePersistence),
      manifestIdentities: readManifestIdentities(state.manifestIdentities),
      snapshotCheckpointType: readCheckpointType(state.snapshotCheckpointType),
      checkpointWaitUntil: readCheckpointWaitUntil(state.checkpointWaitUntil),
      suspendOnExit: Boolean(state.suspendOnExit),
    };
    for (const f of ['name', 'image', 'poolId', 'proxyUrl', 'apiUrl', 'namespace',
      'organizationId', 'projectId', 'routingHint', 'snapshotId'] as const) {
      out[f] = readOptionalString(state, f);
    }
    for (const f of ['cpus', 'memoryMb', 'diskMb', 'timeoutSecs', 'startupTimeout',
      'commandTimeoutSecs', 'checkpointTimeoutSecs'] as const) {
      out[f] = readOptionalNumber(state, f);
    }
    for (const f of ['allowInternetAccess', 'allowUnauthenticatedAccess',
      'workspaceRootProvisioned', 'systemSetupPreserved'] as const) {
      out[f] = readOptionalBoolean(state, f);
    }
    for (const f of ['secretNames', 'entrypoint', 'allowOut', 'denyOut'] as const) {
      out[f] = readOptionalStringArray(state[f]);
    }
    return out as TensorlakeSandboxSessionState;
  }

  async resume(
    state: TensorlakeSandboxSessionState,
  ): Promise<TensorlakeSandboxSession> {
    const Sandbox = await loadTensorlakeSandboxClass();
    // Normalize state at the resume boundary so downstream code can trust it.
    const trustedRecreateOptions = this.trustedRecreateOptions();
    state = withTrustedRecreateOverrides(state, trustedRecreateOptions);
    try {
      // Sandbox.connect() doesn't contact the server, so probe status() first
      // to convert a `terminated` sandbox into a synthetic 404 (the SDK's
      // resume() would otherwise throw a non-404 that skips the fallback).
      const connectCfg = lifecycleConfigFromState(state, trustedRecreateOptions.apiKey);
      const sandbox = await Sandbox.connect(buildConnectKwargs(connectCfg, state.sandboxId));
      await probeSandboxAlive(sandbox);
      if (state.name && typeof sandbox.resume === 'function') {
        await sandbox.resume();
      }
      const session = new TensorlakeSandboxSession({
        state,
        sandbox,
        archiveLimits: this.options.archiveLimits,
        trustedRecreateOptions,
      });
      session.markPreservedFromSnapshot();
      return session;
    } catch (error) {
      assertResumeRecreateAllowed(error, {
        providerName: PROVIDER_NAME,
        provider: PROVIDER_ID,
        details: { sandboxId: state.sandboxId, name: state.name },
      });
    }

    // Snapshot fast-path: recreate via Sandbox.create({ snapshotId }) directly
    // when the previous session cached one; falls through on missing snapshot.
    if (
      state.workspacePersistence === 'snapshot' &&
      typeof state.snapshotId === 'string' &&
      state.snapshotId.length > 0
    ) {
      const session = await this.recreateFromSnapshotId(state, state.snapshotId);
      if (session) return session;
    }

    return await this.create(state.manifest, {
      ...stateToCreateOptions(state, state.environment),
      env: state.environment,
    });
  }

  private async recreateFromSnapshotId(
    state: TensorlakeSandboxSessionState,
    snapshotId: string,
  ): Promise<TensorlakeSandboxSession | null> {
    const resolvedTimeouts = resolveTimeouts(state.timeouts);
    let result;
    try {
      result = await restoreSandboxFromSnapshot({
        state,
        snapshotId,
        apiKey: this.options.apiKey,
        fastOpSecs: resolvedTimeouts.fastOpSecs,
      });
    } catch (error) {
      // A missing/expired snapshot is recoverable: log and let the caller
      // recreate from scratch. Any other failure (network, auth) must
      // surface so the caller sees the real cause rather than a silent
      // fresh sandbox.
      try {
        assertResumeRecreateAllowed(error, {
          providerName: PROVIDER_NAME,
          provider: PROVIDER_ID,
          details: { snapshotId, sandboxId: state.sandboxId },
        });
      } catch {
        throw error;
      }
      logger.warn(
        `${PROVIDER_NAME} could not restore snapshot '${snapshotId}'; recreating sandbox from scratch.`,
      );
      return null;
    }

    const { sandbox, sandboxId } = result;
    const nextState = { ...state };
    applyRestoredSandboxIdentity(nextState, {
      sandboxId,
      name: sandbox.name ?? state.name,
      snapshotId,
    });
    return new TensorlakeSandboxSession({
      state: nextState,
      sandbox,
      archiveLimits: this.options.archiveLimits,
      trustedRecreateOptions: this.trustedRecreateOptions(),
    });
  }

  private trustedRecreateOptions(): TensorlakeTrustedRecreateOptions {
    return pickTrustedRecreateOptions(this.options);
  }
}

type RestoredSandboxIdentity = {
  sandboxId: string;
  name: string | undefined;
  snapshotId: string;
};

// Mutate state for a snapshot-restored replacement sandbox: swap identity,
// cache new snapshotId, mark workspace/accounts preserved, drop cached ports.
function applyRestoredSandboxIdentity(
  state: TensorlakeSandboxSessionState,
  args: RestoredSandboxIdentity,
): void {
  state.sandboxId = args.sandboxId;
  state.name = args.name;
  state.snapshotId = args.snapshotId;
  state.workspaceRootProvisioned = true;
  state.systemSetupPreserved = true;
  delete state.exposedPorts;
}

async function readInfoSandboxUrl(
  sandbox: TensorlakeSandboxInstance,
): Promise<string | undefined> {
  if (!sandbox.info) return undefined;
  try {
    const info = await sandbox.info();
    return info?.sandboxUrl ?? info?.sandbox_url;
  } catch {
    return undefined;
  }
}

// Forces a backend round-trip so a stale/deleted sandbox surfaces inside
// resume()'s try block. Prefers status() — it always hits the API — and
// falls back to info() when the SDK only exposes the latter. The Tensorlake
// SDK returns a SandboxStatus enum (running/terminated/...) rather than
// throwing for a terminated sandbox, so the dead-state check must inspect
// the returned value and raise an error tagged with `code: 'not_found'`,
// which isProviderSandboxNotFoundError recognizes as a recreate signal.
async function probeSandboxAlive(
  sandbox: TensorlakeSandboxInstance,
): Promise<void> {
  let raw: unknown;
  if (typeof sandbox.status === 'function') {
    raw = await sandbox.status();
  } else if (typeof sandbox.info === 'function') {
    const info = await sandbox.info();
    raw = isRecord(info) ? (info as Record<string, unknown>).status : undefined;
  } else {
    return;
  }
  const status = extractStatusString(raw);
  if (status && status.toLowerCase() === 'terminated') {
    throw Object.assign(new Error('sandbox terminated'), { code: 'not_found' });
  }
}

function extractStatusString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.value === 'string') return value.value;
  if (typeof value.status === 'string') return value.status;
  return undefined;
}

function parseProxyHostname(sandboxUrl: string | undefined): string | null {
  if (!sandboxUrl) return null;
  try {
    const parsed = new URL(sandboxUrl);
    if (!parsed.hostname || LOOPBACK_HOSTNAMES.has(parsed.hostname))
      return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

async function resolveSandboxId(
  sandbox: TensorlakeSandboxInstance,
): Promise<string> {
  // After Sandbox.create({ snapshotId }) the sandboxId property may not be
  // populated until info() seeds the SDK's internal cache.
  if (typeof sandbox.sandboxId === 'string' && sandbox.sandboxId.length > 0) {
    return sandbox.sandboxId;
  }
  if (sandbox.info) {
    try {
      const info = await sandbox.info();
      const id = info?.sandboxId ?? info?.sandbox_id;
      if (typeof id === 'string' && id.length > 0) return id;
    } catch {
      // fall through to error
    }
  }
  throw new SandboxProviderError(
    'TensorlakeSandboxClient could not resolve a sandbox id after create.',
    { provider: PROVIDER_ID },
  );
}

function resolveManifestRoot(manifest: Manifest): Manifest {
  if (manifest.root === '/workspace') {
    return cloneManifestWithRoot(manifest, DEFAULT_TENSORLAKE_WORKSPACE_ROOT);
  }
  return manifest;
}

function validateOptions(options: TensorlakeSandboxClientOptions): void {
  readWorkspacePersistence(options.workspacePersistence);
  readManifestIdentities(options.manifestIdentities);
  readCheckpointType(options.snapshotCheckpointType);
  readCheckpointWaitUntil(options.checkpointWaitUntil);
  for (const field of [
    'cpus',
    'memoryMb',
    'diskMb',
    'startupTimeout',
    'commandTimeoutSecs',
    'checkpointTimeoutSecs',
  ] as const) {
    assertPositive(field, options[field]);
  }
  resolveTimeouts(options.timeouts);

  // `timeoutSecs` is an idle threshold on sandbox-proxy traffic, not a
  // wall-clock lifetime. `sandbox.checkpoint()` polling goes through the
  // control-plane client (no proxied traffic), so if the idle threshold is
  // smaller than the checkpoint poll budget the sandbox can idle-time out
  // mid-poll and orphan the snapshot. `timeoutSecs === 0` requests the plan
  // maximum and is exempt alongside undefined.
  if (
    options.workspacePersistence === 'snapshot' &&
    typeof options.timeoutSecs === 'number' &&
    options.timeoutSecs > 0
  ) {
    const explicitBudget = typeof options.checkpointTimeoutSecs === 'number';
    const budget = explicitBudget
      ? options.checkpointTimeoutSecs!
      : TENSORLAKE_SDK_DEFAULT_CHECKPOINT_TIMEOUT_SECS;
    if (options.timeoutSecs <= budget) {
      const source = explicitBudget
        ? `checkpointTimeoutSecs=${budget}`
        : `the Tensorlake SDK default checkpoint timeout (${budget}s)`;
      throw new UserError(
        `${PROVIDER_NAME} timeoutSecs must be strictly greater than the effective checkpoint poll budget when workspacePersistence='snapshot'; otherwise the sandbox can be auto-terminated during checkpoint polling, orphaning the snapshot. Got timeoutSecs=${options.timeoutSecs}, ${source}.`,
      );
    }
  }
}

function assertPositive(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new UserError(`${PROVIDER_NAME} ${name} must be positive.`);
  }
}

function readTimeouts(value: unknown): TensorlakeSandboxTimeouts | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new UserError(`${PROVIDER_NAME} timeouts must be an object of positive numbers.`);
  }
  const result: TensorlakeSandboxTimeouts = {};
  for (const key of TIMEOUT_KEYS) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'number') {
      throw new UserError(`${PROVIDER_NAME} timeouts.${key} must be a positive finite number.`);
    }
    result[key] = raw;
  }
  if (Object.keys(result).length === 0) return undefined;
  resolveTimeouts(result); // delegates positivity validation
  return result;
}

function resolveLifecycleSandboxName(args: {
  name: string | undefined;
  suspendOnExit: boolean;
}): string | undefined {
  const trimmed = args.name?.trim();
  if (trimmed) return trimmed;
  if (!args.suspendOnExit) return undefined;
  return `${GENERATED_TENSORLAKE_NAME_PREFIX}${randomUUID().replace(/-/g, '')}`;
}

const TRUSTED_RECREATE_KEYS = [
  'apiKey',
  'proxyUrl',
  'apiUrl',
  'namespace',
  'organizationId',
  'projectId',
  'routingHint',
  'image',
  'entrypoint',
  'secretNames',
  'allowInternetAccess',
  'allowOut',
  'denyOut',
  'exposedPorts',
  'allowUnauthenticatedAccess',
] as const satisfies readonly (keyof TensorlakeTrustedRecreateOptions)[];

function pickTrustedRecreateOptions(
  options: TensorlakeSandboxClientOptions,
): TensorlakeTrustedRecreateOptions {
  const picked: Record<string, unknown> = {};
  for (const key of TRUSTED_RECREATE_KEYS) {
    if (options[key] !== undefined) picked[key] = options[key];
  }
  return picked as TensorlakeTrustedRecreateOptions;
}

// Single security boundary for deserialized session state: fold trusted
// in-process options over sensitive fields once at the resume() entry so
// downstream code can read `state` as authoritative.
function withTrustedRecreateOverrides(
  state: TensorlakeSandboxSessionState,
  trusted: TensorlakeTrustedRecreateOptions,
): TensorlakeSandboxSessionState {
  // Keys match state 1:1 except `exposedPorts` → `configuredExposedPorts`.
  const next = { ...state };
  for (const key of TRUSTED_RECREATE_KEYS) {
    if (key === 'apiKey' || key === 'exposedPorts') continue;
    const value = trusted[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  if (trusted.exposedPorts !== undefined) {
    next.configuredExposedPorts = trusted.exposedPorts;
  }
  return next;
}

// Normalized lifecycle config shared by Sandbox.create and Sandbox.connect.
type TensorlakeLifecycleConfig = Pick<
  TensorlakeSandboxClientOptions,
  | 'image' | 'cpus' | 'memoryMb' | 'diskMb' | 'timeoutSecs' | 'name'
  | 'startupTimeout' | 'proxyUrl' | 'apiUrl' | 'namespace' | 'organizationId'
  | 'projectId' | 'routingHint' | 'secretNames' | 'allowOut' | 'denyOut'
  | 'entrypoint' | 'apiKey' | 'poolId'
> & {
  allowInternetAccess: boolean;
  env: Record<string, string>;
};

// Building blocks. routingHint is connect-only; poolId/apiKey/env are inlined
// in buildCreateKwargs because of mutex/empty semantics.
const SANDBOX_CONFIG_SCALAR_FIELDS = [
  'image', 'cpus', 'memoryMb', 'diskMb', 'timeoutSecs', 'name', 'startupTimeout',
] as const satisfies readonly (keyof TensorlakeLifecycleConfig)[];
const CONTROL_PLANE_SCALAR_FIELDS = [
  'proxyUrl', 'apiUrl', 'namespace', 'organizationId', 'projectId',
] as const satisfies readonly (keyof TensorlakeLifecycleConfig)[];
const LIFECYCLE_LIST_FIELDS = [
  'secretNames', 'allowOut', 'denyOut', 'entrypoint',
] as const satisfies readonly (keyof TensorlakeLifecycleConfig)[];
const CREATE_SCALAR_FIELDS = [...SANDBOX_CONFIG_SCALAR_FIELDS, ...CONTROL_PLANE_SCALAR_FIELDS] as const;
const CREATE_LIST_FIELDS = LIFECYCLE_LIST_FIELDS;
const CONNECT_FIELDS = [
  ...CONTROL_PLANE_SCALAR_FIELDS, 'routingHint',
] as const satisfies readonly (keyof TensorlakeLifecycleConfig)[];

// Memory snapshots restore image/resources/entrypoint/secrets from the
// snapshot; passing them at restore is rejected by the backend.
// See https://docs.tensorlake.ai/sandboxes/snapshots.
const MEMORY_SNAPSHOT_RESTORE_EXCLUDED_SCALARS: ReadonlySet<string> = new Set([
  'image', 'cpus', 'memoryMb', 'diskMb',
]);
const MEMORY_SNAPSHOT_RESTORE_EXCLUDED_LISTS: ReadonlySet<string> = new Set([
  'entrypoint', 'secretNames',
]);

// Fields shared by options/state/lifecycle config.
const LIFECYCLE_COMMON_FIELDS = [
  ...SANDBOX_CONFIG_SCALAR_FIELDS, ...CONTROL_PLANE_SCALAR_FIELDS,
  'routingHint', ...LIFECYCLE_LIST_FIELDS, 'poolId',
] as const satisfies readonly (keyof TensorlakeLifecycleConfig)[];

type LifecycleCommonField = (typeof LIFECYCLE_COMMON_FIELDS)[number];

type LifecycleSource = {
  [K in LifecycleCommonField]?: TensorlakeLifecycleConfig[K];
} & { allowInternetAccess?: boolean };

function buildLifecycleConfig(
  source: LifecycleSource,
  env: Record<string, string>,
  apiKey: string | undefined,
): TensorlakeLifecycleConfig {
  const cfg: TensorlakeLifecycleConfig = {
    allowInternetAccess: source.allowInternetAccess ?? true,
    env,
  };
  for (const field of LIFECYCLE_COMMON_FIELDS) {
    const value = source[field];
    if (value !== undefined) {
      (cfg as Record<string, unknown>)[field] = value;
    }
  }
  if (apiKey !== undefined) cfg.apiKey = apiKey;
  return cfg;
}

// Callers passing state must ensure trusted overrides are already applied
// (see withTrustedRecreateOverrides). apiKey is passed separately because it
// is intentionally never carried on persisted state.
function lifecycleConfigFromState(
  state: TensorlakeSandboxSessionState,
  apiKey?: string,
): TensorlakeLifecycleConfig {
  return buildLifecycleConfig(state, state.environment, apiKey);
}

// Derive Sandbox.create(...) kwargs from a lifecycle config. Only includes
// optional fields when set so the SDK can apply its own defaults.
function buildCreateKwargs(
  cfg: TensorlakeLifecycleConfig,
  opts: { snapshotId?: string; memorySnapshot?: boolean } = {},
): Record<string, unknown> {
  // Memory-snapshot restores reject image/resources/entrypoint/secrets.
  const skip = opts.snapshotId && opts.memorySnapshot;
  const skipScalar = (name: string) =>
    !!skip && MEMORY_SNAPSHOT_RESTORE_EXCLUDED_SCALARS.has(name);
  const skipList = (name: string) =>
    !!skip && MEMORY_SNAPSHOT_RESTORE_EXCLUDED_LISTS.has(name);
  const kwargs: Record<string, unknown> = {
    allowInternetAccess: cfg.allowInternetAccess,
  };
  for (const name of CREATE_SCALAR_FIELDS) {
    const value = cfg[name];
    if (skipScalar(name) || value === undefined || value === null || value === '') continue;
    kwargs[name] = value;
  }
  for (const name of CREATE_LIST_FIELDS) {
    const value = cfg[name];
    if (skipList(name) || !Array.isArray(value) || value.length === 0) continue;
    kwargs[name] = value;
  }
  // Sandbox.create() treats snapshotId and poolId as mutually exclusive: when
  // both are set it claims from the pool and silently ignores snapshotId.
  if (opts.snapshotId) {
    kwargs.snapshotId = opts.snapshotId;
    if (cfg.poolId) {
      logger.warn(
        `${PROVIDER_NAME}: ignoring poolId='${cfg.poolId}' because a snapshotId is set; snapshot restore takes precedence.`,
      );
    }
  } else if (cfg.poolId) {
    kwargs.poolId = cfg.poolId;
  }
  if (cfg.apiKey) kwargs.apiKey = cfg.apiKey;
  if (Object.keys(cfg.env).length > 0) kwargs.env = cfg.env;
  return kwargs;
}

function buildConnectKwargs(
  cfg: TensorlakeLifecycleConfig,
  sandboxId: string,
): { sandboxId: string } & Record<string, unknown> {
  const kwargs: { sandboxId: string } & Record<string, unknown> = { sandboxId };
  if (cfg.apiKey) kwargs.apiKey = cfg.apiKey;
  for (const name of CONNECT_FIELDS) {
    const value = cfg[name];
    if (value !== undefined && value !== null && value !== '') {
      kwargs[name] = value;
    }
  }
  return kwargs;
}

// Shared scaffolding for `Sandbox.create({ snapshotId })` used by resume's
// fast-path and in-place hydrate. Errors from create() propagate raw so
// callers can inspect status/code (e.g. for the snapshot-missing fallback),
// unless `wrapCreateErrorMessage` is set, in which case they're wrapped.
async function restoreSandboxFromSnapshot(args: {
  state: TensorlakeSandboxSessionState;
  snapshotId: string;
  apiKey: string | undefined;
  fastOpSecs: number;
  /** When true, omit `name` from create so a later `update({name})` runs. */
  omitName?: boolean;
  /** When set, wrap create() failures into a SandboxProviderError with this message. */
  wrapCreateErrorMessage?: string;
}): Promise<{ sandbox: TensorlakeSandboxInstance; sandboxId: string }> {
  const Sandbox = await loadTensorlakeSandboxClass();
  const cfg = lifecycleConfigFromState(args.state, args.apiKey);
  const createCfg = args.omitName ? { ...cfg, name: undefined } : cfg;
  const createOptions = buildCreateKwargs(createCfg, {
    snapshotId: args.snapshotId,
    memorySnapshot: args.state.snapshotCheckpointType === 'memory',
  });

  let sandbox: TensorlakeSandboxInstance;
  try {
    sandbox = await Sandbox.create(createOptions);
  } catch (error) {
    if (!args.wrapCreateErrorMessage) throw error;
    throw new SandboxProviderError(args.wrapCreateErrorMessage, {
      provider: PROVIDER_ID,
      snapshotId: args.snapshotId,
      cause: providerErrorMessage(error),
    });
  }

  // Tensorlake does not expose ports via Sandbox.create(); restored sandboxes
  // start with no proxy routes. resolveSandboxId() must run first because it
  // seeds the SDK's info() cache that applyPortConfiguration relies on for
  // snapshot-restored sandboxes — so these run in order, not in parallel.
  try {
    const sandboxId = await resolveSandboxId(sandbox);
    await applyPortConfiguration(
      sandbox,
      {
        exposedPorts: args.state.configuredExposedPorts,
        allowUnauthenticatedAccess: args.state.allowUnauthenticatedAccess,
      },
      args.fastOpSecs,
    );
    return { sandbox, sandboxId };
  } catch (error) {
    await sandbox.terminate().catch(() => {});
    throw error;
  }
}

async function applyPortConfiguration(
  sandbox: TensorlakeSandboxInstance,
  options: Pick<
    TensorlakeSandboxClientOptions,
    'exposedPorts' | 'allowUnauthenticatedAccess'
  >,
  fastOpSecs: number,
): Promise<void> {
  const hasExposedPorts = (options.exposedPorts?.length ?? 0) > 0;
  const hasAccessOverride =
    typeof options.allowUnauthenticatedAccess === 'boolean';
  if (!hasExposedPorts && !hasAccessOverride) return;
  await updateExposedPorts(sandbox, {
    exposedPorts: hasExposedPorts ? options.exposedPorts : undefined,
    allowUnauthenticatedAccess: options.allowUnauthenticatedAccess,
    fastOpSecs,
  });
}

// Single entry point for sandbox.update() calls that change exposed ports or
// allowUnauthenticatedAccess. Handles support check, timeout, and error map.
async function updateExposedPorts(
  sandbox: TensorlakeSandboxInstance,
  args: {
    exposedPorts?: number[];
    allowUnauthenticatedAccess?: boolean;
    fastOpSecs: number;
    /** Set when invoked from on-demand `resolveRemoteExposedPort`. */
    onDemandPort?: number;
  },
): Promise<void> {
  const onDemand = args.onDemandPort !== undefined;
  const purpose = onDemand ? 'exposed ports' : 'initial exposed ports';
  if (!sandbox.update) {
    throw new SandboxUnsupportedFeatureError(
      `${PROVIDER_NAME} sandbox.update is required to ${onDemand ? 'expose ports on demand' : 'configure exposed ports'}.`,
      {
        provider: PROVIDER_ID,
        feature: 'exposedPorts',
        ...(onDemand ? { port: args.onDemandPort } : {}),
      },
    );
  }
  const payload: TensorlakeUpdateOptions = {};
  if (args.exposedPorts !== undefined) payload.exposedPorts = args.exposedPorts;
  if (typeof args.allowUnauthenticatedAccess === 'boolean') {
    payload.allowUnauthenticatedAccess = args.allowUnauthenticatedAccess;
  }
  try {
    await withTimeout(
      sandbox.update(payload),
      args.fastOpSecs * 1000,
      `${PROVIDER_NAME} update() (${purpose}) timed out`,
    );
  } catch (error) {
    throw new SandboxProviderError(
      onDemand
        ? `${PROVIDER_NAME} failed to expose port ${args.onDemandPort}.`
        : `${PROVIDER_NAME} failed to configure exposed ports.`,
      {
        provider: PROVIDER_ID,
        cause: providerErrorMessage(error),
        ...(onDemand ? { port: args.onDemandPort } : {}),
        ...(sandbox.sandboxId ? { sandboxId: sandbox.sandboxId } : {}),
      },
    );
  }
}

// Fields shared 1:1 between options and state. `name`, `suspendOnExit`, and
// the renamed pairs (configuredExposedPorts/exposedPorts, environment/env)
// are handled inline by buildSessionStateFromCreate and stateToCreateOptions.
const OPTION_STATE_COMMON_FIELDS = [
  'image',
  'cpus',
  'memoryMb',
  'diskMb',
  'timeoutSecs',
  'startupTimeout',
  'secretNames',
  'entrypoint',
  'allowInternetAccess',
  'allowOut',
  'denyOut',
  'allowUnauthenticatedAccess',
  'commandTimeoutSecs',
  'timeouts',
  'poolId',
  'proxyUrl',
  'apiUrl',
  'namespace',
  'organizationId',
  'projectId',
  'routingHint',
  'workspacePersistence',
  'manifestIdentities',
  'snapshotCheckpointType',
  'checkpointTimeoutSecs',
  'checkpointWaitUntil',
] as const satisfies readonly (keyof TensorlakeSandboxClientOptions &
  keyof TensorlakeSandboxSessionState)[];

function buildSessionStateFromCreate(args: {
  manifest: Manifest;
  sandboxId: string;
  sandboxName: string | undefined;
  environment: Record<string, string>;
  options: TensorlakeSandboxClientOptions;
}): TensorlakeSandboxSessionState {
  const state: TensorlakeSandboxSessionState = {
    manifest: args.manifest,
    sandboxId: args.sandboxId,
    name: args.sandboxName,
    environment: args.environment,
    configuredExposedPorts: args.options.exposedPorts,
    suspendOnExit: args.options.suspendOnExit ?? false,
  };
  for (const field of OPTION_STATE_COMMON_FIELDS) {
    (state as Record<string, unknown>)[field] = args.options[field];
  }
  return state;
}

// Callers must pass state with trusted overrides already applied.
function stateToCreateOptions(
  state: TensorlakeSandboxSessionState,
  environment: Record<string, string>,
): TensorlakeSandboxClientOptions {
  const options: TensorlakeSandboxClientOptions = {
    exposedPorts: state.configuredExposedPorts,
    env: environment,
    suspendOnExit: state.suspendOnExit,
  };
  if (state.name !== undefined) options.name = state.name;
  for (const field of OPTION_STATE_COMMON_FIELDS) {
    const value = state[field];
    if (value !== undefined) (options as Record<string, unknown>)[field] = value;
  }
  return options;
}

function parseEnum<T extends string | boolean>(
  feature: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly unknown[]).includes(value)) return value as T;
  const tokens = allowed.map((v) => (typeof v === 'string' ? `"${v}"` : String(v)));
  const display =
    tokens.length <= 2
      ? tokens.join(' or ')
      : `${tokens.slice(0, -1).join(', ')}, or ${tokens[tokens.length - 1]}`;
  throw new SandboxUnsupportedFeatureError(
    `${PROVIDER_NAME} ${feature} must be ${display}.`,
    { provider: PROVIDER_ID, feature, [feature]: value },
  );
}

const readManifestIdentities = (v: unknown) =>
  parseEnum<TensorlakeManifestIdentitiesMode>('manifestIdentities', v, [
    'collapse',
    'provision',
  ]);
const readWorkspacePersistence = (v: unknown) =>
  parseEnum<TensorlakeWorkspacePersistence>('workspacePersistence', v, [
    true,
    'tar',
    'snapshot',
  ]);
const readCheckpointType = (v: unknown) =>
  parseEnum<TensorlakeCheckpointType>('snapshotCheckpointType', v, [
    'memory',
    'filesystem',
  ]);
const readCheckpointWaitUntil = (v: unknown) =>
  parseEnum<TensorlakeCheckpointWaitUntil>('checkpointWaitUntil', v, [
    'local_ready',
    'completed',
  ]);

async function loadTensorlakeSandboxClass(): Promise<TensorlakeSandboxClass> {
  try {
    const mod = (await import('tensorlake')) as Record<string, unknown>;
    const Sandbox = mod.Sandbox as TensorlakeSandboxClass | undefined;
    if (
      !Sandbox ||
      typeof Sandbox.create !== 'function' ||
      typeof Sandbox.connect !== 'function'
    ) {
      throw new Error('Missing Sandbox export from tensorlake.');
    }
    return Sandbox;
  } catch (error) {
    throw new UserError(
      `Tensorlake sandbox support requires the optional \`tensorlake\` package. Install it before using Tensorlake-backed sandbox examples. ${(error as Error).message}`,
    );
  }
}
