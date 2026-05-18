import { UserError } from '@openai/agents-core';
import {
  Manifest,
  SandboxProviderError,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxSessionLifecycleOptions,
  type SandboxSessionState,
  type SandboxArchiveLimits,
  type SandboxConcurrencyLimits,
} from '@openai/agents-core/sandbox';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RemoteSandboxSessionBase,
  assertCoreSnapshotUnsupported,
  closeRemoteSessionOnManifestError,
  deserializeRemoteSandboxSessionStateValues,
  materializeEnvironment,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readString,
  serializeRemoteSandboxSessionState,
  shellQuote,
  withProviderError,
  withSandboxSpan,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../shared';

/**
 * A minimal structural view of the @northflank/js-client surface we touch.
 * Reproduced here so we don't take a hard type dep on the SDK — it's an
 * optional peer dependency loaded dynamically when the caller doesn't bring
 * their own pre-constructed ApiClient.
 */
type NorthflankApiClient = {
  create: {
    service: {
      deployment: (opts: {
        parameters: { projectId: string; teamId?: string };
        data: Record<string, unknown>;
      }) => Promise<{ data?: { id?: string }; error?: NorthflankApiError }>;
    };
    volume: (opts: {
      parameters: { projectId: string; teamId?: string };
      data: {
        name: string;
        mounts: { containerMountPath: string; volumeMountPath?: string }[];
        spec: {
          accessMode: 'ReadWriteOnce' | 'ReadWriteMany';
          storageClassName?: string;
          storageSize: number;
        };
        attachedObjects?: { id: string; type: 'service' | 'job' }[];
      };
    }) => Promise<{ data?: { id?: string }; error?: NorthflankApiError }>;
  };
  get: {
    service: ((opts: {
      parameters: { projectId: string; serviceId: string; teamId?: string };
    }) => Promise<{
      data?: NorthflankServiceData;
      error?: NorthflankApiError;
    }>) & {
      containers: (opts: {
        parameters: { projectId: string; serviceId: string; teamId?: string };
      }) => Promise<{
        data?: NorthflankContainersData;
        error?: NorthflankApiError;
      }>;
    };
  };
  delete: {
    service: (opts: {
      parameters: { projectId: string; serviceId: string; teamId?: string };
    }) => Promise<{ data?: unknown; error?: NorthflankApiError }>;
    volume: (opts: {
      parameters: { projectId: string; volumeId: string; teamId?: string };
    }) => Promise<{ data?: unknown; error?: NorthflankApiError }>;
  };
  attach: {
    volume: (opts: {
      parameters: { projectId: string; volumeId: string; teamId?: string };
      data: { nfObject: { id: string; type: 'service' | 'job' } };
    }) => Promise<{ data?: unknown; error?: NorthflankApiError }>;
  };
  detach: {
    volume: (opts: {
      parameters: { projectId: string; volumeId: string; teamId?: string };
      data: { nfObject: { id: string; type: 'service' | 'job' } };
    }) => Promise<{ data?: unknown; error?: NorthflankApiError }>;
  };
  pause: {
    service: (opts: {
      parameters: { projectId: string; serviceId: string; teamId?: string };
    }) => Promise<{ data?: unknown; error?: NorthflankApiError }>;
  };
  resume: {
    service: (opts: {
      parameters: { projectId: string; serviceId: string; teamId?: string };
    }) => Promise<{ data?: unknown; error?: NorthflankApiError }>;
  };
  exec: {
    execServiceCommand: (
      params: {
        projectId: string;
        serviceId: string;
        teamId?: string;
      },
      data: {
        command: string | string[];
        shell?: string;
        instanceName?: string;
        containerName?: string;
        user?: string | number;
      },
    ) => Promise<{
      commandResult: {
        exitCode: number | null;
        status: string;
        message?: string;
      };
      stdOut: string;
      stdErr: string;
    }>;
  };
  fileCopy: {
    uploadServiceFiles: (
      params: { projectId: string; serviceId: string; teamId?: string },
      options: {
        localPath: string;
        remotePath?: string;
        instanceName?: string;
        containerName?: string;
      },
    ) => Promise<unknown>;
    downloadServiceFiles: (
      params: { projectId: string; serviceId: string; teamId?: string },
      options: {
        localPath: string;
        remotePath?: string;
        instanceName?: string;
        containerName?: string;
      },
    ) => Promise<unknown>;
  };
};

type NorthflankApiError = {
  status?: number;
  message?: string;
  id?: string;
};

type NorthflankServiceData = {
  id?: string;
  servicePaused?: boolean;
  status?: {
    deployment?: {
      status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    };
  };
};

type NorthflankContainersData = {
  containers?: Array<{
    name: string;
    status: string;
  }>;
};

/**
 * Options for {@link NorthflankSandboxClient}. Two ways to authenticate:
 *
 * 1. Pass an `apiClient` that you've already constructed with your preferred
 *    Northflank context provider (recommended for production).
 * 2. Pass an `apiToken` and the SDK will lazy-construct a default ApiClient.
 *    Convenient for examples and scripts.
 */
export interface NorthflankSandboxClientOptions extends SandboxClientOptions {
  /** Northflank project ID where the sandbox service will live. */
  projectId?: string;

  /** Container image to run, e.g. `'docker.io/library/ubuntu:24.04'`. */
  image?: string;

  /** Pre-constructed `ApiClient` from `@northflank/js-client`. */
  apiClient?: NorthflankApiClient;

  /** API token (used only when `apiClient` is not supplied). */
  apiToken?: string;

  /** Northflank team / org scope. */
  teamId?: string;

  /** Northflank deployment plan. Defaults to `'nf-compute-20'`. */
  deploymentPlan?: string;

  /**
   * Prefix for generated service IDs. Each session appends a random suffix.
   * Defaults to `'agent-sandbox'`.
   */
  serviceNamePrefix?: string;

  /**
   * Optional override for the container entrypoint / command. Useful when
   * the image's default CMD exits immediately (e.g. base ubuntu) — set
   * `customEntrypoint: 'sleep', customCommand: 'infinity'` to keep it
   * alive for the duration of the agent run.
   */
  docker?: {
    customEntrypoint?: string;
    customCommand?: string;
  };

  /** Environment variables to set in the container. */
  env?: Record<string, string>;

  /**
   * If true, `close()` pauses the underlying service instead of deleting it
   * so a later `resume(state)` can pick it back up. Defaults to false.
   *
   * Without `workspacePersistence`, Northflank deployment services use
   * ephemeral pod storage — files written during a session do NOT survive
   * a pause cycle and the manifest is re-applied on every `create()`. Set
   * `workspacePersistence` to `'volume'` or `'tar'` to keep the workspace
   * across pause/resume.
   */
  pauseOnExit?: boolean;

  /**
   * How (and whether) the workspace contents persist across pause / resume:
   *
   * - `undefined` (default): ephemeral pod storage. Workspace is lost on
   *   pause; manifest is re-materialized on every `create()`.
   * - `'volume'`: provision a Northflank volume, attach it to the service,
   *   and mount it at `workspaceRoot`. The volume survives pause cycles
   *   and is deleted only when `delete()` runs (and only if this client
   *   created it).
   * - `'tar'`: capture the workspace contents to a tar archive at `stop()`,
   *   store it inline in the session state, and re-extract it on `resume()`.
   *   Convenient for small workspaces; bounded by whatever your runtime is
   *   willing to round-trip through `serializeSessionState`.
   */
  workspacePersistence?: 'volume' | 'tar';

  /**
   * Override the volume created in `'volume'` persistence mode. Ignored for
   * other modes. The default is a 5 GB `ReadWriteMany` volume on the
   * `'nf-multi-rw'` storage class.
   */
  volumeSpec?: {
    /**
     * Volume size in megabytes. Defaults to 5120 (5 GB) — the minimum the
     * default `nf-multi-rw` storage class accepts on Northflank's standard
     * cluster.
     */
    storageSize?: number;
    /**
     * Volume access mode. Defaults to `'ReadWriteMany'` to match the
     * `'nf-multi-rw'` storage class used by default. Override to
     * `'ReadWriteOnce'` when pairing with a single-attach storage class.
     */
    accessMode?: 'ReadWriteOnce' | 'ReadWriteMany';
    /**
     * Storage class. Defaults to `'nf-multi-rw'`, which is available on
     * Northflank's standard cluster and accepts the 5 GB default size
     * above. The cluster default (`nvme`) requires a 6 GB minimum, so we
     * override it here for out-of-the-box compatibility.
     */
    storageClassName?: string;
  };

  /**
   * Reuse an existing Northflank volume in `'volume'` persistence mode
   * instead of provisioning a new one. The volume must already have a
   * mount entry at `workspaceRoot` (mount paths are configured on the
   * volume itself, not on the attach call). The volume is attached to
   * the service on `create()` and is NOT deleted on `delete()` — the
   * caller owns it.
   */
  volumeId?: string;

  /**
   * Maximum time `create()` waits for the deployment to reach `COMPLETED`.
   * Defaults to 5 minutes.
   */
  readyTimeoutMs?: number;

  /**
   * Poll interval (in ms) while waiting for the deployment and
   * container to be ready. Defaults to 100ms — Northflank's API tolerates
   * tight polling without rate-limiting, and the fast cadence keeps cold
   * starts snappy.
   */
  pollIntervalMs?: number;
}

/**
 * Session state persisted across `serializeSessionState` /
 * `deserializeSessionState`. Carries everything {@link NorthflankSandboxClient}
 * needs to find and re-pin the underlying Northflank service.
 */
export interface NorthflankSandboxSessionState extends SandboxSessionState {
  /** Manifest applied to the workspace at startup. */
  manifest: Manifest;

  /** Resolved environment that was passed to `runtimeEnvironment` at create. */
  environment: Record<string, string>;

  /** Northflank project ID. */
  projectId: string;

  /** Northflank service ID. */
  serviceId: string;

  /** Optional team / org scope. */
  teamId?: string;

  /** Image the service was created from (used for diagnostics + resume). */
  image: string;

  /** Northflank deployment plan ID. */
  deploymentPlan: string;

  /** Filesystem root inside the container. */
  workspaceRoot: string;

  /** Whether close() should pause vs. delete. */
  pauseOnExit: boolean;

  /**
   * The currently-running container name (e.g. `<service>-…-abc12`). Every
   * exec / file-copy call is pinned to this instance so successive ops share
   * a filesystem. Re-resolved before each file operation in case the pod
   * cycles mid-session.
   */
  instanceName?: string;

  /**
   * Workspace persistence mode in effect for this session. Mirrors
   * {@link NorthflankSandboxClientOptions.workspacePersistence} and is
   * round-tripped through `serializeSessionState` so a resumed session
   * keeps the same restore strategy.
   */
  workspacePersistence?: 'volume' | 'tar';

  /**
   * ID of the volume attached to the service in `'volume'` mode. Persists
   * across pause/resume; deleted on `delete()` only when this client
   * provisioned it (see {@link volumeProviderCreated}).
   */
  volumeId?: string;

  /**
   * `true` when {@link volumeId} was created by this client and should be
   * torn down alongside the service. `false` when the caller passed an
   * existing `volumeId` via options — in that case the volume outlives the
   * session.
   */
  volumeProviderCreated?: boolean;

  /**
   * Base64-encoded gzip tar of the workspace, captured at `stop()` in
   * `'tar'` mode and re-extracted on `resume()`. Empty / undefined while
   * the session is live.
   */
  workspaceTar?: string;
}

const DEFAULT_DEPLOYMENT_PLAN = 'nf-compute-20';
const DEFAULT_WORKSPACE_ROOT = '/workspace';
const DEFAULT_SERVICE_PREFIX = 'agent-sandbox';
const DEFAULT_READY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const INSTANCE_RESOLVE_POLL_INTERVAL_MS = 100;
const INSTANCE_RESOLVE_TIMEOUT_MS = 60_000;
// Matches the minimum size `nf-multi-rw` accepts on Northflank's standard
// cluster — smaller values return HTTP 409 at create time.
const DEFAULT_VOLUME_SIZE_MB = 5120;
const DEFAULT_VOLUME_STORAGE_CLASS = 'nf-multi-rw';
const DEFAULT_VOLUME_ACCESS_MODE: 'ReadWriteOnce' | 'ReadWriteMany' =
  'ReadWriteMany';
const WORKSPACE_TAR_REMOTE_PATH = '/tmp/nf-workspace-snapshot.tar.gz';

/**
 * `RemoteSandboxSessionBase`-backed session that proxies exec + file ops
 * to a Northflank `deployment` service. The base class handles
 * `applyManifest`, `createEditor`, `viewImage`, `materializeEntry`, path
 * resolution and exposed-port plumbing — we only provide the 6 primitives
 * (exec, mkdir, read/write file, delete) plus lifecycle.
 *
 * **Routing pin:** Northflank's exec API can route consecutive calls to
 * different replicas. We resolve a single running container after
 * `create()` and pass its name as `instanceName` on every subsequent
 * exec / file-copy call. The pin is refreshed (`refreshInstanceName`) on
 * each file op so pod restarts mid-session don't leave us talking to a
 * dead pod.
 */
export class NorthflankSandboxSession extends RemoteSandboxSessionBase<NorthflankSandboxSessionState> {
  private readonly client: NorthflankApiClient;
  private readonly refreshInstance?: () => Promise<string>;
  private paused = false;
  private deleted = false;

  constructor(args: {
    state: NorthflankSandboxSessionState;
    client: NorthflankApiClient;
    refreshInstance?: () => Promise<string>;
    concurrencyLimits?: SandboxConcurrencyLimits;
    archiveLimits?: SandboxArchiveLimits | null;
  }) {
    super({
      state: args.state,
      options: {
        providerName: 'NorthflankSandboxClient',
        providerId: 'northflank',
        concurrencyLimits: args.concurrencyLimits,
        archiveLimits: args.archiveLimits,
      },
    });
    this.client = args.client;
    this.refreshInstance = args.refreshInstance;
  }

  /**
   * Ensure the workspace dir exists. Called by `applyManifest` / lazily
   * before file ops; idempotent.
   */
  async prepareWorkspaceRoot(): Promise<void> {
    const root = this.state.manifest.root;
    const result = await this.runRemoteCommand(
      `mkdir -p -- ${shellQuote(root)}`,
      {
        kind: 'manifest',
        workdir: '/',
      },
    );
    if (result.status !== 0) {
      throw new SandboxProviderError(
        'NorthflankSandboxClient failed to prepare the workspace root.',
        {
          provider: 'northflank',
          operation: 'prepare workspace root',
          serviceId: this.state.serviceId,
          root,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        },
      );
    }
  }

  // --- Required abstract methods --------------------------------------

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    // Wrap as `sh -c <line>` so pipes / `&&` / redirects behave. Prefix
    // with `cd <workdir>` to honour the manifest root the caller passed.
    const line = `cd ${shellQuote(options.workdir)} && ${command}`;
    const response = await this.client.exec.execServiceCommand(
      this.serviceParams(),
      {
        command: ['sh', '-c', line],
        shell: 'none',
        ...(this.state.instanceName
          ? { instanceName: this.state.instanceName }
          : {}),
        ...(options.runAs ? { user: options.runAs } : {}),
      },
    );
    return {
      status: response.commandResult.exitCode ?? 1,
      stdout: response.stdOut ?? '',
      stderr: response.stdErr ?? '',
    };
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    const result = await this.runRemoteCommand(
      `mkdir -p -- ${shellQuote(path)}`,
      {
        kind: 'manifest',
        workdir: '/',
      },
    );
    if (result.status !== 0) {
      throw new SandboxProviderError(
        `NorthflankSandboxClient failed to create directory ${path}.`,
        {
          provider: 'northflank',
          operation: 'mkdir',
          path,
          stderr: result.stderr ?? '',
        },
      );
    }
  }

  protected override async readRemoteText(path: string): Promise<string> {
    const bytes = await this.readRemoteFile(path);
    return new TextDecoder().decode(bytes);
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    await this.refreshInstanceName();
    // Northflank's downloadServiceFiles treats `localPath` as a *target
    // directory* and extracts the remote file as `<localPath>/<basename>`.
    // Use a fresh tmp dir to receive it.
    const tmpDir = joinPath(tmpdir(), `nf-sandbox-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    try {
      await this.client.fileCopy.downloadServiceFiles(this.serviceParams(), {
        remotePath: path,
        localPath: tmpDir,
        ...(this.state.instanceName
          ? { instanceName: this.state.instanceName }
          : {}),
      });
      const bytes = await fs.readFile(joinPath(tmpDir, posix.basename(path)));
      return new Uint8Array(bytes);
    } finally {
      await fs
        .rm(tmpDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.refreshInstanceName();
    const buf =
      typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content);
    // Match the local basename to the remote basename so the tar-based
    // copy lands the file at `dirname(remotePath)/<basename(remotePath)>`
    // reliably (the JS client's path-rewrite hook is best-effort for
    // arbitrary characters).
    const remoteName = posix.basename(path);
    const tmpDir = joinPath(tmpdir(), `nf-sandbox-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = joinPath(tmpDir, remoteName);
    await fs.writeFile(tmpFile, buf);
    try {
      await this.client.fileCopy.uploadServiceFiles(this.serviceParams(), {
        localPath: tmpFile,
        remotePath: path,
        ...(this.state.instanceName
          ? { instanceName: this.state.instanceName }
          : {}),
      });
    } finally {
      await fs
        .rm(tmpDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    const result = await this.runRemoteCommand(
      `rm -rf -- ${shellQuote(path)}`,
      {
        kind: 'manifest',
        workdir: '/',
      },
    );
    if (result.status !== 0) {
      throw new SandboxProviderError(
        `NorthflankSandboxClient failed to remove ${path}.`,
        {
          provider: 'northflank',
          operation: 'delete',
          path,
          stderr: result.stderr ?? '',
        },
      );
    }
  }

  // --- Lifecycle ------------------------------------------------------

  /**
   * Last-resort cleanup invoked when the runtime can't use the standard
   * `stop()`/`delete()` lifecycle. Pauses if the session is configured to
   * survive (pauseOnExit or any `workspacePersistence` mode), deletes
   * otherwise.
   */
  async close(): Promise<void> {
    if (
      this.state.pauseOnExit ||
      this.state.workspacePersistence !== undefined
    ) {
      await this.pauseSession();
    } else {
      await this.delete();
    }
  }

  /**
   * Non-destructive idle. In `'tar'` persistence mode, captures the
   * workspace into `state.workspaceTar` first so `serializeSessionState`
   * carries the snapshot. In `'volume'` mode (or no persistence), simply
   * pauses the service when `pauseOnExit` is set.
   */
  async stop(_options?: SandboxSessionLifecycleOptions): Promise<void> {
    if (this.deleted) return;
    if (this.state.workspacePersistence === 'tar') {
      this.state.workspaceTar = await this.captureWorkspaceTar();
    }
    if (!this.state.pauseOnExit) return;
    await this.pauseSession();
  }

  /**
   * Hard-delete the underlying service. Idempotent. Also tears down the
   * attached workspace volume when this client provisioned it; volumes
   * supplied via `options.volumeId` are left in place for the caller to
   * manage.
   *
   * The Agents runtime calls `stop()` then `delete()` during cleanup with
   * `{ reason: 'cleanup', preserveOwnedSessions: true }`. When the session
   * is configured to survive that cycle (`pauseOnExit` or any
   * `workspacePersistence`), `delete()` pauses instead of tearing down so
   * the serialized state remains resumable. Direct user calls (no cleanup
   * options) always hard-delete.
   */
  async delete(options?: SandboxSessionLifecycleOptions): Promise<void> {
    if (this.deleted) return;
    if (this.shouldPauseOnCleanup(options)) {
      await this.pauseSession();
      return;
    }
    await withSandboxSpan(
      'sandbox.delete',
      { backend_id: 'northflank', sandbox_id: this.state.serviceId },
      async () => {
        const response = await this.client.delete.service({
          parameters: this.serviceParams(),
        });
        assertApiOk(response, 'delete.service');
        this.deleted = true;
      },
    );
    if (this.state.volumeId && this.state.volumeProviderCreated) {
      // Northflank rejects `delete.volume` while it is still attached to a
      // service. Detaching is idempotent — when the service is already gone
      // it 404s — so swallow errors and let `delete.volume` surface the
      // real failure if one remains.
      await this.client.detach
        .volume({
          parameters: {
            projectId: this.state.projectId,
            volumeId: this.state.volumeId,
            ...(this.state.teamId ? { teamId: this.state.teamId } : {}),
          },
          data: {
            nfObject: { id: this.state.serviceId, type: 'service' },
          },
        })
        .catch(() => undefined);
      const volumeResponse = await this.client.delete.volume({
        parameters: {
          projectId: this.state.projectId,
          volumeId: this.state.volumeId,
          ...(this.state.teamId ? { teamId: this.state.teamId } : {}),
        },
      });
      assertApiOk(volumeResponse, 'delete.volume');
      this.state.volumeId = undefined;
      this.state.volumeProviderCreated = undefined;
    }
  }

  /**
   * Tar+gzip the current workspace and return the archive base64-encoded.
   * Used by `'tar'` persistence mode to roll the workspace into session
   * state on stop().
   */
  async captureWorkspaceTar(): Promise<string> {
    await this.refreshInstanceName();
    const root = this.state.workspaceRoot;
    const remotePath = WORKSPACE_TAR_REMOTE_PATH;
    const tar = await this.runRemoteCommand(
      `tar czf ${shellQuote(remotePath)} -C ${shellQuote(root)} .`,
      { kind: 'manifest', workdir: '/' },
    );
    if (tar.status !== 0) {
      throw new SandboxProviderError(
        'NorthflankSandboxClient failed to archive the workspace for tar persistence.',
        {
          provider: 'northflank',
          operation: 'capture workspace tar',
          stderr: tar.stderr ?? '',
        },
      );
    }
    try {
      const bytes = await this.readRemoteFile(remotePath);
      return Buffer.from(bytes).toString('base64');
    } finally {
      await this.runRemoteCommand(`rm -f -- ${shellQuote(remotePath)}`, {
        kind: 'manifest',
        workdir: '/',
      }).catch(() => undefined);
    }
  }

  /**
   * Reverse of {@link captureWorkspaceTar}: decode a base64 gzip tar and
   * extract it into `state.workspaceRoot`. Called by
   * `NorthflankSandboxClient.resume()`.
   *
   * Session state is round-tripped through `serializeSessionState`, so the
   * tar may have been mutated between sessions. Before extracting, we list
   * the archive contents and reject any entry that could escape
   * `workspaceRoot` — absolute paths, parent-traversal components, or
   * symlinks/hardlinks (whose targets aren't constrained to the archive).
   */
  async restoreWorkspaceFromTar(base64Tar: string): Promise<void> {
    const remotePath = WORKSPACE_TAR_REMOTE_PATH;
    const buf = Buffer.from(base64Tar, 'base64');
    await this.writeRemoteFile(remotePath, new Uint8Array(buf));
    try {
      await this.assertTarSafe(remotePath);
      const extract = await this.runRemoteCommand(
        `tar xzf ${shellQuote(remotePath)} -C ${shellQuote(
          this.state.workspaceRoot,
        )}`,
        { kind: 'manifest', workdir: '/' },
      );
      if (extract.status !== 0) {
        throw new SandboxProviderError(
          'NorthflankSandboxClient failed to extract the workspace tar on resume.',
          {
            provider: 'northflank',
            operation: 'restore workspace tar',
            stderr: extract.stderr ?? '',
          },
        );
      }
    } finally {
      await this.runRemoteCommand(`rm -f -- ${shellQuote(remotePath)}`, {
        kind: 'manifest',
        workdir: '/',
      }).catch(() => undefined);
    }
  }

  /**
   * Validate that a workspace tar restored from session state cannot
   * escape `workspaceRoot`. Throws a `SandboxProviderError` on the first
   * unsafe entry.
   */
  private async assertTarSafe(remoteArchive: string): Promise<void> {
    const listing = await this.runRemoteCommand(
      `tar -tzf ${shellQuote(remoteArchive)}`,
      { kind: 'manifest', workdir: '/' },
    );
    if (listing.status !== 0) {
      throw new SandboxProviderError(
        'NorthflankSandboxClient failed to list workspace tar contents during the safety check.',
        {
          provider: 'northflank',
          operation: 'validate workspace tar',
          stderr: listing.stderr ?? '',
        },
      );
    }
    for (const raw of (listing.stdout ?? '').split('\n')) {
      const entry = raw.trim();
      if (!entry) continue;
      if (entry.startsWith('/')) {
        throw new SandboxProviderError(
          `NorthflankSandboxClient rejected workspace tar: contains absolute path "${entry}".`,
          {
            provider: 'northflank',
            operation: 'validate workspace tar',
            entry,
          },
        );
      }
      const parts = entry.split('/');
      if (parts.includes('..')) {
        throw new SandboxProviderError(
          `NorthflankSandboxClient rejected workspace tar: contains parent-traversal path "${entry}".`,
          {
            provider: 'northflank',
            operation: 'validate workspace tar',
            entry,
          },
        );
      }
    }
    const verbose = await this.runRemoteCommand(
      `tar -tvzf ${shellQuote(remoteArchive)}`,
      { kind: 'manifest', workdir: '/' },
    );
    if (verbose.status !== 0) return;
    for (const raw of (verbose.stdout ?? '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const typeChar = line[0];
      if (typeChar === 'l' || typeChar === 'h') {
        throw new SandboxProviderError(
          `NorthflankSandboxClient rejected workspace tar: contains unsupported link entry "${line}".`,
          {
            provider: 'northflank',
            operation: 'validate workspace tar',
            entry: line,
          },
        );
      }
    }
  }

  /**
   * Returns `true` when the runtime is cleaning up an owned session it
   * wants preserved (so `delete()` should pause instead of tearing the
   * service down). Mirrors the contract `canPersistOwnedSessionState`
   * advertises to the runtime.
   */
  private shouldPauseOnCleanup(
    options?: SandboxSessionLifecycleOptions,
  ): boolean {
    if (options?.reason !== 'cleanup') return false;
    const preserve = (options as { preserveOwnedSessions?: unknown })
      .preserveOwnedSessions;
    if (preserve !== true) return false;
    return (
      this.state.pauseOnExit === true ||
      this.state.workspacePersistence !== undefined
    );
  }

  private async pauseSession(): Promise<void> {
    if (this.paused || this.deleted) return;
    await withSandboxSpan(
      'sandbox.pause',
      { backend_id: 'northflank', sandbox_id: this.state.serviceId },
      async () => {
        const response = await this.client.pause.service({
          parameters: this.serviceParams(),
        });
        assertApiOk(response, 'pause.service');
        this.paused = true;
      },
    );
  }

  // --- Internals ------------------------------------------------------

  private serviceParams(): {
    projectId: string;
    serviceId: string;
    teamId?: string;
  } {
    return {
      projectId: this.state.projectId,
      serviceId: this.state.serviceId,
      ...(this.state.teamId ? { teamId: this.state.teamId } : {}),
    };
  }

  private async refreshInstanceName(): Promise<void> {
    if (this.refreshInstance) {
      this.state.instanceName = await this.refreshInstance();
    }
  }
}

/**
 * Provisions Northflank-backed sandbox sessions. Each session spins up a
 * dedicated `deployment`-type service running the configured container
 * image; the manifest is materialised after the deployment reaches
 * `COMPLETED`.
 */
export class NorthflankSandboxClient implements SandboxClient<
  NorthflankSandboxClientOptions,
  NorthflankSandboxSessionState
> {
  readonly backendId = 'northflank';
  private readonly options: NorthflankSandboxClientOptions;
  private cachedClient?: NorthflankApiClient;

  constructor(options: NorthflankSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<NorthflankSandboxClientOptions> | Manifest,
    manifestOptions?: NorthflankSandboxClientOptions,
  ): Promise<NorthflankSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported(
      'NorthflankSandboxClient',
      createArgs.snapshot,
    );

    const effective: NorthflankSandboxClientOptions = {
      ...this.options,
      ...(createArgs.options ?? {}),
    };
    const projectId = requireOption(effective.projectId, 'projectId');
    const image = requireOption(effective.image, 'image');
    const manifest = createArgs.manifest ?? new Manifest({});

    // If both options.workspaceRoot and a non-default manifest.root are set
    // and disagree, fail fast — silently preferring one would surprise.
    const customWorkspaceRoot = (effective as { workspaceRoot?: string })
      .workspaceRoot;
    if (
      customWorkspaceRoot &&
      manifest.root !== DEFAULT_WORKSPACE_ROOT &&
      manifest.root !== customWorkspaceRoot
    ) {
      throw new UserError(
        `NorthflankSandboxClient: workspaceRoot conflict — options.workspaceRoot="${customWorkspaceRoot}" vs manifest.root="${manifest.root}".`,
      );
    }
    const workspaceRoot =
      customWorkspaceRoot ?? manifest.root ?? DEFAULT_WORKSPACE_ROOT;

    return await withSandboxSpan(
      'sandbox.start',
      { backend_id: this.backendId },
      async () => {
        const client = await this.resolveClient(effective);
        // materializeEnvironment() lays the manifest environment on top of
        // the base options.env, matching the precedence the other providers
        // rely on (manifest wins). Don't re-spread effective.env after — it
        // would invert that.
        const env = assertSafeEnv(
          await materializeEnvironment(manifest, effective.env ?? {}),
        );

        const serviceId = await this.createService(
          client,
          effective,
          env,
          projectId,
          image,
        );
        const state: NorthflankSandboxSessionState = {
          manifest: new Manifest({ ...manifest, root: workspaceRoot }),
          environment: env,
          projectId,
          serviceId,
          teamId: effective.teamId,
          image,
          deploymentPlan: effective.deploymentPlan ?? DEFAULT_DEPLOYMENT_PLAN,
          workspaceRoot,
          pauseOnExit: effective.pauseOnExit ?? false,
          workspacePersistence: effective.workspacePersistence,
        };

        const session = new NorthflankSandboxSession({
          state,
          client,
          refreshInstance: () =>
            this.resolveRunningInstance(client, state, effective),
          concurrencyLimits: createArgs.concurrencyLimits,
          archiveLimits: createArgs.archiveLimits,
        });

        try {
          await this.waitUntilReady(client, state, effective);
          if (effective.workspacePersistence === 'volume') {
            await this.attachWorkspaceVolume(
              client,
              state,
              effective,
              workspaceRoot,
            );
            // Mounting a volume triggers a redeployment — wait for the
            // service to settle and re-resolve the running container.
            await this.waitUntilReady(client, state, effective);
          }
          state.instanceName = await this.resolveRunningInstance(
            client,
            state,
            effective,
          );
          await session.prepareWorkspaceRoot();
          await session.applyManifest(manifest);
        } catch (error) {
          // Best-effort cleanup of the partial service.
          await closeRemoteSessionOnManifestError(
            'NorthflankSandboxClient',
            session,
            error,
          );
        }
        return session;
      },
    );
  }

  async resume(
    state: NorthflankSandboxSessionState,
  ): Promise<NorthflankSandboxSession> {
    const client = await this.resolveClient(this.options);

    const current = await client.get.service({
      parameters: paramsFromState(state),
    });
    assertApiOk(current, 'get.service');

    if (current.data?.servicePaused) {
      const resumed = await client.resume.service({
        parameters: paramsFromState(state),
      });
      assertApiOk(resumed, 'resume.service');
      await this.waitUntilReady(client, state, this.options);
    }

    state.instanceName = await this.resolveRunningInstance(
      client,
      state,
      this.options,
    );

    const session = new NorthflankSandboxSession({
      state,
      client,
      refreshInstance: () =>
        this.resolveRunningInstance(client, state, this.options),
      archiveLimits: this.options.archiveLimits as
        | SandboxArchiveLimits
        | null
        | undefined,
    });
    await session.prepareWorkspaceRoot();
    if (state.workspacePersistence === 'tar' && state.workspaceTar) {
      await session.restoreWorkspaceFromTar(state.workspaceTar);
      // Snapshot consumed — clear so a fresh stop() captures the latest state.
      state.workspaceTar = undefined;
    }
    return session;
  }

  async serializeSessionState(
    state: NorthflankSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<NorthflankSandboxSessionState> {
    const { manifest, environment } =
      deserializeRemoteSandboxSessionStateValues(state, this.options.env);
    const persistence = readOptionalString(state, 'workspacePersistence');
    return {
      manifest,
      environment,
      projectId: readString(state, 'projectId'),
      serviceId: readString(state, 'serviceId'),
      teamId: readOptionalString(state, 'teamId'),
      image: readString(state, 'image'),
      deploymentPlan: readString(state, 'deploymentPlan'),
      workspaceRoot: readString(state, 'workspaceRoot'),
      pauseOnExit: readOptionalBoolean(state, 'pauseOnExit') ?? false,
      instanceName: readOptionalString(state, 'instanceName'),
      workspacePersistence:
        persistence === 'volume' || persistence === 'tar'
          ? persistence
          : undefined,
      volumeId: readOptionalString(state, 'volumeId'),
      volumeProviderCreated: readOptionalBoolean(
        state,
        'volumeProviderCreated',
      ),
      workspaceTar: readOptionalString(state, 'workspaceTar'),
      ...spreadOptionalExposedPorts(state),
    } as NorthflankSandboxSessionState;
  }

  canPersistOwnedSessionState(state: NorthflankSandboxSessionState): boolean {
    return state.pauseOnExit === true || state.workspacePersistence === 'tar';
  }

  // --- Internals ------------------------------------------------------

  private async createService(
    client: NorthflankApiClient,
    options: NorthflankSandboxClientOptions,
    env: Record<string, string>,
    projectId: string,
    image: string,
  ): Promise<string> {
    const requestedId = generateServiceId(options.serviceNamePrefix);
    return await withProviderError(
      'NorthflankSandboxClient',
      'northflank',
      'create sandbox service',
      async () => {
        const response = await client.create.service.deployment({
          parameters: {
            projectId,
            ...(options.teamId ? { teamId: options.teamId } : {}),
          },
          data: {
            name: requestedId,
            billing: {
              deploymentPlan: options.deploymentPlan ?? DEFAULT_DEPLOYMENT_PLAN,
            },
            deployment: {
              // Pinned to 1 — multiple replicas would split exec/file
              // ops across pods and the agent would see flapping state.
              instances: 1,
              external: { imagePath: image },
              ...(options.docker
                ? {
                    docker: {
                      configType: dockerConfigType(options.docker),
                      ...options.docker,
                    },
                  }
                : {}),
            },
            runtimeEnvironment: env,
          },
        });
        assertApiOk(response, 'create.service.deployment');
        return response.data?.id ?? requestedId;
      },
      { projectId, image },
    );
  }

  /**
   * In `'volume'` persistence mode, ensure a Northflank volume is attached
   * to the freshly-created service at `workspaceRoot`. Reuses
   * `options.volumeId` when provided (the caller owns it) — otherwise
   * provisions a new volume and flags it for deletion on `delete()`.
   */
  private async attachWorkspaceVolume(
    client: NorthflankApiClient,
    state: NorthflankSandboxSessionState,
    options: NorthflankSandboxClientOptions,
    workspaceRoot: string,
  ): Promise<void> {
    if (options.volumeId) {
      const callerVolumeId = options.volumeId;
      state.volumeId = callerVolumeId;
      state.volumeProviderCreated = false;
      // The caller's volume already has its own mount configuration baked
      // in at create time. We only attach it to the freshly-created service
      // — Northflank then re-rolls the service with the volume mounted.
      // Cleanup leaves the volume alone (caller owns it).
      await withProviderError(
        'NorthflankSandboxClient',
        'northflank',
        'attach workspace volume',
        async () => {
          const response = await client.attach.volume({
            parameters: {
              projectId: state.projectId,
              volumeId: callerVolumeId,
              ...(state.teamId ? { teamId: state.teamId } : {}),
            },
            data: {
              nfObject: { id: state.serviceId, type: 'service' },
            },
          });
          assertApiOk(response, 'attach.volume');
        },
        { volumeId: callerVolumeId },
      );
      return;
    }
    const spec = options.volumeSpec ?? {};
    const data = {
      name: state.serviceId,
      mounts: [{ containerMountPath: workspaceRoot }],
      spec: {
        accessMode: spec.accessMode ?? DEFAULT_VOLUME_ACCESS_MODE,
        storageSize: spec.storageSize ?? DEFAULT_VOLUME_SIZE_MB,
        storageClassName: spec.storageClassName ?? DEFAULT_VOLUME_STORAGE_CLASS,
      },
      attachedObjects: [{ id: state.serviceId, type: 'service' as const }],
    };
    await withProviderError(
      'NorthflankSandboxClient',
      'northflank',
      'create workspace volume',
      async () => {
        const response = await client.create.volume({
          parameters: {
            projectId: state.projectId,
            ...(state.teamId ? { teamId: state.teamId } : {}),
          },
          data,
        });
        assertApiOk(response, 'create.volume');
        const id = response.data?.id;
        if (!id) {
          throw new SandboxProviderError(
            'NorthflankSandboxClient: create.volume returned without an id.',
            { provider: 'northflank', operation: 'create.volume' },
          );
        }
        state.volumeId = id;
        state.volumeProviderCreated = true;
      },
      { workspaceRoot },
    );
  }

  private async waitUntilReady(
    client: NorthflankApiClient,
    state: NorthflankSandboxSessionState,
    options: NorthflankSandboxClientOptions,
  ): Promise<void> {
    const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await client.get.service({
        parameters: paramsFromState(state),
      });
      assertApiOk(response, 'get.service');
      const status = response.data?.status?.deployment?.status;
      if (status === 'COMPLETED') return;
      if (status === 'FAILED') {
        throw new SandboxProviderError(
          `Northflank service ${state.serviceId} deployment failed.`,
          { provider: 'northflank', operation: 'wait until ready', status },
        );
      }
      await sleep(intervalMs);
    }
    throw new SandboxProviderError(
      `Northflank service ${state.serviceId} did not become ready within ${timeoutMs}ms.`,
      { provider: 'northflank', operation: 'wait until ready', timeoutMs },
    );
  }

  /**
   * Find the currently-running container so we can pin every exec /
   * file-copy call to it. Northflank's exec API doesn't sticky-route by
   * default — without this, two consecutive calls during a deployment roll
   * can land on different pods.
   */
  private async resolveRunningInstance(
    client: NorthflankApiClient,
    state: NorthflankSandboxSessionState,
    options: NorthflankSandboxClientOptions,
  ): Promise<string> {
    const intervalMs =
      options.pollIntervalMs ?? INSTANCE_RESOLVE_POLL_INTERVAL_MS;
    const deadline = Date.now() + INSTANCE_RESOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await client.get.service.containers({
        parameters: paramsFromState(state),
      });
      assertApiOk(response, 'get.service.containers');
      const running = response.data?.containers?.find(
        (c) => c.status === 'TASK_RUNNING',
      );
      if (running) return running.name;
      await sleep(intervalMs);
    }
    throw new SandboxProviderError(
      `Northflank service ${state.serviceId} has no TASK_RUNNING container.`,
      { provider: 'northflank', operation: 'resolve running instance' },
    );
  }

  private async resolveClient(
    options: NorthflankSandboxClientOptions,
  ): Promise<NorthflankApiClient> {
    if (options.apiClient) return options.apiClient;
    if (this.cachedClient) return this.cachedClient;
    if (!options.apiToken) {
      throw new UserError(
        'NorthflankSandboxClient requires either `apiClient` or `apiToken`.',
      );
    }
    this.cachedClient = await buildDefaultApiClient(options.apiToken);
    return this.cachedClient;
  }
}

// --- helpers ----------------------------------------------------------

function requireOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new UserError(`NorthflankSandboxClient requires \`${name}\`.`);
  }
  return value;
}

function paramsFromState(state: NorthflankSandboxSessionState): {
  projectId: string;
  serviceId: string;
  teamId?: string;
} {
  return {
    projectId: state.projectId,
    serviceId: state.serviceId,
    ...(state.teamId ? { teamId: state.teamId } : {}),
  };
}

function assertApiOk(
  response: { error?: NorthflankApiError | undefined },
  label: string,
): void {
  const err = response.error;
  if (!err) return;
  const status = err.status ? `HTTP ${err.status} ` : '';
  throw new SandboxProviderError(
    `NorthflankSandboxClient: ${label} failed: ${status}${err.message ?? 'unknown API error'}`,
    {
      provider: 'northflank',
      operation: label,
      status: err.status,
      id: err.id,
    },
  );
}

/**
 * Reject env keys that contain shell metacharacters. They'd flow into
 * `export <key>=<value>` inside every exec command otherwise — a key like
 * `FOO; rm -rf /` would be a textbook shell-injection sink.
 */
function assertSafeEnv(env: Record<string, string>): Record<string, string> {
  const validKey = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const key of Object.keys(env)) {
    if (!validKey.test(key)) {
      throw new UserError(
        `Invalid environment variable name "${key}". Names must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
      );
    }
  }
  return env;
}

function dockerConfigType(docker: {
  customEntrypoint?: string;
  customCommand?: string;
}):
  | 'default'
  | 'customEntrypoint'
  | 'customCommand'
  | 'customEntrypointCustomCommand' {
  const hasEntry = Boolean(docker.customEntrypoint);
  const hasCommand = Boolean(docker.customCommand);
  if (hasEntry && hasCommand) return 'customEntrypointCustomCommand';
  if (hasEntry) return 'customEntrypoint';
  if (hasCommand) return 'customCommand';
  return 'default';
}

function generateServiceId(prefix?: string): string {
  const base =
    (prefix ?? DEFAULT_SERVICE_PREFIX)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || DEFAULT_SERVICE_PREFIX;
  const suffix = randomUUID().split('-')[0];
  return `${base}-${suffix}`;
}

function spreadOptionalExposedPorts(
  state: Record<string, unknown>,
): Pick<SandboxSessionState, 'exposedPorts'> {
  const ports = state.exposedPorts;
  return ports !== undefined
    ? { exposedPorts: ports as SandboxSessionState['exposedPorts'] }
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lazy-load `@northflank/js-client` and construct a minimal default
 * `ApiClient`. Used only when the caller doesn't supply their own
 * `apiClient` instance.
 */
async function buildDefaultApiClient(
  apiToken: string,
): Promise<NorthflankApiClient> {
  let mod: typeof import('@northflank/js-client');
  try {
    mod = await import('@northflank/js-client');
  } catch (error) {
    throw new UserError(
      `Northflank sandbox support requires the optional \`@northflank/js-client\` package. Install it before using Northflank-backed sandbox examples. ${(error as Error).message}`,
    );
  }
  const { ApiClient, ApiClientInMemoryContextProvider } = mod;
  const ctx = new ApiClientInMemoryContextProvider();
  await ctx.addContext({ name: 'default', token: apiToken });
  return new ApiClient(ctx, {
    throwErrorOnHttpErrorCode: false,
  }) as unknown as NorthflankApiClient;
}

// readOptionalNumber is exported by shared/ for callers that want to add
// more numeric state fields; keep the import alive even though the current
// deserializer doesn't use it.
void readOptionalNumber;
