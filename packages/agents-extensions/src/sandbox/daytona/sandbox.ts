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
  type MaterializeEntryArgs,
  type Mount,
  type SandboxSession,
  type SandboxSessionState,
  type TypedMount,
  type ViewImageArgs,
  type WriteStdinArgs,
  type WorkspaceArchiveData,
} from '@openai/agents-core/sandbox';
import {
  appendPtyOutput,
  assertCoreConcurrencyLimitsUnsupported,
  assertCoreSnapshotUnsupported,
  assertTarWorkspacePersistence,
  createPtyProcessEntry,
  imageOutputFromBytes,
  RemoteSandboxEditor,
  assertSandboxEntryMetadataSupported,
  assertSandboxManifestMetadataSupported,
  MOUNT_MANIFEST_METADATA_SUPPORT,
  assertRunAsUnsupported,
  closeRemoteSessionOnManifestError,
  cloneManifestWithRoot,
  deserializeRemoteSandboxSessionStateValues,
  elapsedSeconds,
  formatExecResponse,
  formatPtyExecUpdate,
  hydrateRemoteWorkspaceTar,
  assertResumeRecreateAllowed,
  materializeEnvironment,
  persistRemoteWorkspaceTar,
  assertConfiguredExposedPort,
  getCachedExposedPortEndpoint,
  parseExposedPortEndpoint,
  recordResolvedExposedPortEndpoint,
  resolveSandboxAbsolutePath,
  resolveSandboxWorkdir,
  posixDirname,
  shellQuote,
  shellCommandForPty,
  serializeRemoteSandboxSessionState,
  truncateOutput,
  validateRemoteSandboxPathForManifest,
  watchPtyProcess,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecord,
  readOptionalString,
  readString,
  withProviderError,
  withSandboxSpan,
  writePtyStdin,
  PtyProcessRegistry,
  type RemoteManifestWriter,
  type RemoteSandboxPathOptions,
  type RemoteSandboxPathResolver,
} from '../shared';
import {
  mountRcloneCloudBucket,
  rclonePatternFromMountStrategy,
  unmountRcloneMount,
  type RemoteMountCommand,
} from '../shared/inContainerMounts';
import { isDaytonaCloudBucketMountEntry } from './mounts';
import {
  applyLocalSourceManifestEntryToState,
  applyLocalSourceManifestToState,
  materializeLocalSourceManifest,
} from '../shared/localSources';

const DEFAULT_WORKSPACE_ROOT = '/home/daytona/workspace';
const DEFAULT_EXPOSED_PORT_URL_TTL_S = 60;
const DAYTONA_DELETE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

type DaytonaClientLike = {
  create(
    params?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<DaytonaSandboxLike>;
  get(idOrName: string): Promise<DaytonaSandboxLike>;
};

type DaytonaSandboxLike = {
  id: string;
  start(timeout?: number): Promise<void>;
  stop(timeout?: number, force?: boolean): Promise<void>;
  delete(timeout?: number): Promise<void>;
  fs: {
    createFolder(path: string, mode: string): Promise<void>;
    uploadFile(
      source: Buffer | string,
      remotePath: string,
      timeout?: number,
    ): Promise<void>;
    downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
    deleteFile(path: string, recursive?: boolean): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<DaytonaExecuteResponse>;
    createPty?(options?: {
      id?: string;
      cwd?: string;
      envs?: Record<string, string>;
      cols?: number;
      rows?: number;
      onData?: (data: Uint8Array | string) => void | Promise<void>;
    }): Promise<DaytonaPtyHandle>;
    killPtySession?(id: string): Promise<void>;
  };
  getSignedPreviewUrl?(
    port: number,
    expiresInSeconds?: number,
  ): Promise<DaytonaPreviewUrlLike>;
};

type DaytonaExecuteResponse = {
  exitCode: number;
  result: string;
  artifacts?: {
    stdout?: string;
  };
};

type DaytonaPreviewUrlLike = string | { url?: string };

type DaytonaPtyHandle = {
  sessionId?: string;
  waitForConnection?(): Promise<void>;
  sendInput?(data: string | Uint8Array): Promise<void>;
  wait?(): Promise<{ exitCode?: number; error?: string }>;
  kill?(): Promise<void>;
  disconnect?(): Promise<void>;
  exitCode?: number;
  error?: string;
};

export interface DaytonaSandboxClientOptions extends SandboxClientOptions {
  image?: string;
  resources?: Record<string, unknown>;
  env?: Record<string, string>;
  pauseOnExit?: boolean;
  createTimeoutSec?: number;
  startTimeoutSec?: number;
  timeoutSec?: number;
  sandboxSnapshotName?: string;
  exposedPorts?: number[];
  exposedPortUrlTtlS?: number;
  name?: string;
  autoStopInterval?: number;
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

export interface DaytonaSandboxSessionState extends SandboxSessionState {
  sandboxId: string;
  image?: string;
  resources?: Record<string, unknown>;
  pauseOnExit: boolean;
  createTimeoutSec?: number;
  startTimeoutSec?: number;
  timeoutSec?: number;
  sandboxSnapshotName?: string;
  configuredExposedPorts?: number[];
  exposedPortUrlTtlS?: number;
  name?: string;
  autoStopInterval?: number;
  environment: Record<string, string>;
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

export class DaytonaSandboxSession implements SandboxSession<DaytonaSandboxSessionState> {
  readonly state: DaytonaSandboxSessionState;
  private readonly sandbox: DaytonaSandboxLike;
  private readonly ptyProcesses = new PtyProcessRegistry();
  private readonly remotePathResolver: RemoteSandboxPathResolver = async (
    path,
    options,
  ) => await this.resolveRemotePath(path, options);
  private readonly activeMountPaths = new Set<string>();
  private stopPromise?: Promise<void>;
  private deletePromise?: Promise<void>;

  constructor(args: {
    state: DaytonaSandboxSessionState;
    sandbox: DaytonaSandboxLike;
  }) {
    this.state = args.state;
    this.sandbox = args.sandbox;
  }

  createEditor(runAs?: string): RemoteSandboxEditor {
    assertRunAsUnsupported('DaytonaSandboxClient', runAs);
    return new RemoteSandboxEditor({
      resolvePath: this.remotePathResolver,
      pathExists: async (path) => await this.pathExists(path),
      mkdir: async (path) => {
        await this.mkdirEditorPath(path);
      },
      readText: async (path) => {
        return await this.readEditorText(path);
      },
      writeText: async (path, content) => {
        await this.writeEditorText(path, content);
      },
      deletePath: async (path) => {
        await this.deleteEditorPath(path);
      },
    });
  }

  supportsPty(): boolean {
    return typeof this.sandbox.process.createPty === 'function';
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    if (args.tty) {
      return await this.execPtyCommand(args);
    }
    assertRunAsUnsupported('DaytonaSandboxClient', args.runAs);

    const start = Date.now();
    const result = await this.sandbox.process.executeCommand(
      args.cmd,
      resolveSandboxWorkdir(this.state.manifest.root, args.workdir),
      this.state.environment,
    );
    const combinedOutput = result.artifacts?.stdout ?? result.result ?? '';
    const output = truncateOutput(combinedOutput, args.maxOutputTokens);

    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      exitCode: result.exitCode,
      originalTokenCount: output.originalTokenCount,
    });
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    return await writePtyStdin({
      providerName: 'DaytonaSandboxClient',
      registry: this.ptyProcesses,
      sessionId: args.sessionId,
      chars: args.chars,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  private async execPtyCommand(args: ExecCommandArgs): Promise<string> {
    assertRunAsUnsupported('DaytonaSandboxClient', args.runAs);
    if (!this.sandbox.process.createPty) {
      throw new SandboxUnsupportedFeatureError(
        'DaytonaSandboxClient tty=true requires Daytona SDK PTY support.',
        {
          provider: 'daytona',
          feature: 'tty',
        },
      );
    }

    const start = Date.now();
    const command = shellCommandForPty(args);
    const entry = createPtyProcessEntry({ tty: true });
    const providerSessionId = `sandbox-${Math.random().toString(16).slice(2, 14)}`;
    const handle = await this.sandbox.process.createPty({
      id: providerSessionId,
      cwd: resolveSandboxWorkdir(this.state.manifest.root, args.workdir),
      envs: this.state.environment,
      cols: 80,
      rows: 24,
      onData: (data: Uint8Array | string) => appendPtyOutput(entry, data),
    });
    if (handle.waitForConnection) {
      await handle.waitForConnection();
    }

    if (!handle.sendInput) {
      await this.terminatePtyHandle(handle, providerSessionId);
      throw new SandboxUnsupportedFeatureError(
        'DaytonaSandboxClient tty=true requires Daytona SDK PTY stdin support.',
        {
          provider: 'daytona',
          feature: 'tty.stdin',
        },
      );
    }
    if (!handle.wait) {
      await this.terminatePtyHandle(handle, providerSessionId);
      throw new SandboxUnsupportedFeatureError(
        'DaytonaSandboxClient tty=true requires Daytona SDK PTY wait support.',
        {
          provider: 'daytona',
          feature: 'tty.wait',
        },
      );
    }
    const waitForExit = handle.wait.bind(handle);
    entry.sendInput = async (chars) => {
      await handle.sendInput!(chars);
    };
    entry.terminate = async () => {
      if (handle.kill) {
        await handle.kill();
      } else {
        await this.sandbox.process.killPtySession?.(
          handle.sessionId ?? providerSessionId,
        );
      }
      await handle.disconnect?.();
    };
    const { sessionId, pruned } = this.ptyProcesses.register(entry);
    if (pruned) {
      await pruned.terminate?.().catch(() => {});
    }
    watchPtyProcess(
      entry,
      async () => await waitForExit(),
      (result, error) =>
        exitCodeFromDaytonaResult(result) ??
        exitCodeFromDaytonaResult(error) ??
        exitCodeFromDaytonaResult(handle),
    );
    await entry.sendInput(`${command}\n`);

    return await formatPtyExecUpdate({
      registry: this.ptyProcesses,
      sessionId,
      entry,
      startTime: start,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  private async terminatePtyHandle(
    handle: DaytonaPtyHandle,
    providerSessionId: string,
  ): Promise<void> {
    if (handle.kill) {
      try {
        await handle.kill();
      } catch {
        // Ignore best-effort PTY cleanup failures.
      }
    } else {
      try {
        await this.sandbox.process.killPtySession?.(
          handle.sessionId ?? providerSessionId,
        );
      } catch {
        // Ignore best-effort PTY cleanup failures.
      }
    }
    try {
      await handle.disconnect?.();
    } catch {
      // Ignore best-effort PTY cleanup failures.
    }
  }

  async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    assertRunAsUnsupported('DaytonaSandboxClient', args.runAs);
    const bytes = await this.readFileBytes(args.path);
    return imageOutputFromBytes(args.path, bytes);
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    assertRunAsUnsupported('DaytonaSandboxClient', runAs);
    const absolutePath = await this.resolveRemotePath(path);
    const result = await this.sandbox.process.executeCommand(
      `test -e ${shellQuote(absolutePath)}`,
      this.state.manifest.root,
      this.state.environment,
      5,
    );
    return result.exitCode === 0;
  }

  async running(): Promise<boolean> {
    try {
      const result = await this.sandbox.process.executeCommand(
        'true',
        this.state.manifest.root,
        this.state.environment,
        5,
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    const requestedPort = assertConfiguredExposedPort({
      providerName: 'DaytonaSandboxClient',
      port,
      configuredPorts: this.state.configuredExposedPorts,
    });
    const cached = getUsableDaytonaCachedExposedPortEndpoint(
      this.state,
      requestedPort,
    );
    if (cached) {
      return cached;
    }

    const preview = await this.createSignedPreviewUrl(requestedPort);
    const url = typeof preview === 'string' ? preview : preview.url;
    if (typeof url !== 'string') {
      throw new SandboxProviderError(
        'DaytonaSandboxClient exposed port preview did not include a URL.',
        {
          provider: 'daytona',
          port: requestedPort,
        },
      );
    }

    return recordResolvedExposedPortEndpoint(
      this.state,
      requestedPort,
      withDaytonaPreviewExpiration(
        parseExposedPortEndpoint(url, {
          providerName: 'DaytonaSandboxClient',
          source: 'preview URL',
        }),
        this.state.exposedPortUrlTtlS,
      ),
    );
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    assertRunAsUnsupported('DaytonaSandboxClient', args.runAs);
    assertSandboxEntryMetadataSupported(
      'DaytonaSandboxClient',
      args.path,
      args.entry,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    await applyLocalSourceManifestEntryToState(
      this.state,
      args.path,
      args.entry,
      'daytona',
      this.writer(),
      this.remotePathResolver,
      this.manifestMaterializationOptions,
    );
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    assertRunAsUnsupported('DaytonaSandboxClient', runAs);
    const resolvedManifest = resolveManifestRoot(manifest);
    if (resolvedManifest.root !== this.state.manifest.root) {
      throw new UserError(
        'DaytonaSandboxClient cannot apply a manifest with a different root than the active session. Create or resume a session with the desired root instead.',
      );
    }
    assertSandboxManifestMetadataSupported(
      'DaytonaSandboxClient',
      resolvedManifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    await applyLocalSourceManifestToState(
      this.state,
      resolvedManifest,
      'daytona',
      this.writer(),
      this.remotePathResolver,
      this.manifestMaterializationOptions,
    );
  }

  async materializeInitialManifest(manifest: Manifest): Promise<void> {
    await materializeLocalSourceManifest(
      this.writer(),
      manifest,
      'daytona',
      this.remotePathResolver,
      this.manifestMaterializationOptions,
    );
  }

  async rematerializeMountEntries(): Promise<void> {
    const targets: Array<{
      mountPath: string;
      entry: Mount | TypedMount;
      resolvedMountPath: string;
    }> = [];
    for (const target of this.state.manifest.mountTargetsForMaterialization()) {
      targets.push({
        ...target,
        resolvedMountPath: await this.resolveMountEntryPath(
          target.mountPath,
          target.entry,
        ),
      });
    }

    for (const { resolvedMountPath } of [...targets].reverse()) {
      await this.unmountMountPath(resolvedMountPath);
    }
    this.activeMountPaths.clear();

    for (const { mountPath, entry } of targets) {
      await this.materializeMountEntry(mountPath, entry);
    }
  }

  async prepareWorkspaceRoot(): Promise<void> {
    const root = this.state.manifest.root;
    const result = await this.sandbox.process.executeCommand(
      `mkdir -p -- ${shellQuote(root)}`,
      '/',
      this.state.environment,
    );
    if (result.exitCode !== 0) {
      throw new SandboxProviderError(
        'DaytonaSandboxClient failed to prepare the workspace root.',
        {
          provider: 'daytona',
          operation: 'prepare workspace root',
          sandboxId: this.state.sandboxId,
          root,
          stdout: result.artifacts?.stdout ?? result.result ?? '',
        },
      );
    }
  }

  async persistWorkspace(): Promise<Uint8Array> {
    assertTarWorkspacePersistence('DaytonaSandboxClient', 'tar');
    return await persistRemoteWorkspaceTar({
      providerName: 'DaytonaSandboxClient',
      manifest: this.state.manifest,
      io: this.archiveIo(),
    });
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    assertTarWorkspacePersistence('DaytonaSandboxClient', 'tar');
    await hydrateRemoteWorkspaceTar({
      providerName: 'DaytonaSandboxClient',
      manifest: this.state.manifest,
      io: this.archiveIo(),
      data,
    });
  }

  async close(): Promise<void> {
    if (this.state.pauseOnExit) {
      await this.stopOnce();
      return;
    }
    await this.deleteOnce();
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  async delete(): Promise<void> {
    await this.deleteOnce();
  }

  private async stopOnce(): Promise<void> {
    this.stopPromise ??= (async () => {
      await this.ptyProcesses.terminateAll();
      await withSandboxSpan(
        'sandbox.stop',
        {
          backend_id: 'daytona',
          sandbox_id: this.state.sandboxId,
        },
        async () => {
          await this.sandbox.stop();
        },
      );
    })();
    await this.stopPromise;
  }

  private async deleteOnce(): Promise<void> {
    this.deletePromise ??= (async () => {
      await this.ptyProcesses.terminateAll();
      await withSandboxSpan(
        'sandbox.shutdown',
        {
          backend_id: 'daytona',
          sandbox_id: this.state.sandboxId,
        },
        async () => {
          await this.unmountActiveMounts();
          await deleteDaytonaSandboxWithRetry(async () => {
            await this.sandbox.delete();
          });
        },
      );
    })();
    await this.deletePromise;
  }

  private writer(): RemoteManifestWriter {
    return {
      mkdir: async (path) => {
        await this.sandbox.fs.createFolder(path, '755');
      },
      writeFile: async (path, content) => {
        await this.ensureParentDir(path);
        await this.sandbox.fs.uploadFile(Buffer.from(content), path);
      },
    };
  }

  private readonly manifestMaterializationOptions = {
    materializeMount: this.materializeMountEntry.bind(this),
  };

  private async materializeMountEntry(
    absolutePath: string,
    entry: Mount | TypedMount,
  ): Promise<void> {
    if (!isDaytonaCloudBucketMountEntry(entry)) {
      throw new SandboxUnsupportedFeatureError(
        'DaytonaSandboxClient only supports DaytonaCloudBucketMountStrategy mount entries.',
        {
          provider: 'daytona',
          feature: 'entry.mountStrategy',
          path: absolutePath,
          mountType: entry.type,
          strategyType: entry.mountStrategy?.type,
        },
      );
    }
    const mountPath = await this.resolveMountEntryPath(absolutePath, entry);
    await mountRcloneCloudBucket({
      providerName: 'DaytonaSandboxClient',
      providerId: 'daytona',
      strategyType: 'daytona_cloud_bucket',
      entry,
      mountPath,
      pattern: rclonePatternFromMountStrategy(entry.mountStrategy),
      runCommand: this.mountCommandRunner(),
      packageManagers: ['apt', 'apk'],
    });
    this.activeMountPaths.add(mountPath);
  }

  private async unmountActiveMounts(): Promise<void> {
    for (const mountPath of [...this.activeMountPaths].reverse()) {
      await this.unmountMountPath(mountPath);
    }
  }

  private async unmountMountPath(mountPath: string): Promise<void> {
    await unmountRcloneMount({
      providerName: 'DaytonaSandboxClient',
      providerId: 'daytona',
      mountPath,
      runCommand: this.mountCommandRunner(),
    }).catch(() => {});
    this.activeMountPaths.delete(mountPath);
  }

  private async resolveMountEntryPath(
    absolutePath: string,
    entry: Mount | TypedMount,
  ): Promise<string> {
    return await this.resolveRemotePath(entry.mountPath ?? absolutePath, {
      forWrite: true,
    });
  }

  private mountCommandRunner(): RemoteMountCommand {
    return async (command, options = {}) => {
      const commandToRun = commandForDaytonaUser(command, options.user);
      const result = await this.sandbox.process.executeCommand(
        commandToRun,
        this.state.manifest.root,
        this.state.environment,
        options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
      );
      return {
        status: result.exitCode,
        stdout: result.artifacts?.stdout ?? result.result ?? '',
        stderr: '',
      };
    };
  }

  private archiveIo() {
    return {
      runCommand: async (command: string) => {
        const result = await this.sandbox.process.executeCommand(
          command,
          this.state.manifest.root,
          this.state.environment,
          this.state.timeoutSec,
        );
        return {
          status: result.exitCode,
          stdout: result.artifacts?.stdout ?? result.result ?? '',
          stderr: '',
        };
      },
      readFile: async (path: string) =>
        Uint8Array.from(await this.sandbox.fs.downloadFile(path)),
      writeFile: async (path: string, content: string | Uint8Array) => {
        await this.ensureParentDir(path);
        await this.sandbox.fs.uploadFile(Buffer.from(content), path);
      },
      mkdir: async (path: string) => {
        await this.sandbox.fs.createFolder(path, '755');
      },
    };
  }

  private async readFileBytes(path: string): Promise<Uint8Array> {
    const absolutePath = this.resolveEditorPath(path);
    const output = await this.runEditorFileCommand(
      [
        'set -eu',
        `root=${shellQuote(this.state.manifest.root)}`,
        `path=${shellQuote(absolutePath)}`,
        'resolved_root=$(realpath -m -- "$root")',
        'resolved=$(readlink -f -- "$path")',
        'case "$resolved" in "$resolved_root"|"$resolved_root"/*) ;; *) printf "workspace escape: %s\\n" "$resolved" >&2; exit 111 ;; esac',
        '[ -f "$resolved" ] || { printf "not a regular file: %s\\n" "$resolved" >&2; exit 112; }',
        'exec 3< "$resolved"',
        'resolved=$(readlink -f "/proc/$$/fd/3")',
        'case "$resolved" in "$resolved_root"|"$resolved_root"/*) ;; *) printf "workspace escape: %s\\n" "$resolved" >&2; exit 111 ;; esac',
        'base64 <&3',
      ].join('\n'),
    );
    return Buffer.from(output.replace(/\s+/gu, ''), 'base64');
  }

  private async readEditorText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBytes(path));
  }

  private async mkdirEditorPath(path: string): Promise<void> {
    const absolutePath = this.resolveEditorPath(path, { forWrite: true });
    await this.runEditorFileCommand(
      [
        'set -eu',
        `root=${shellQuote(this.state.manifest.root)}`,
        `path=${shellQuote(absolutePath)}`,
        'resolved_root=$(realpath -m -- "$root")',
        'resolved_path=$(realpath -m -- "$path")',
        'case "$resolved_path" in "$resolved_root"|"$resolved_root"/*) ;; *) printf "workspace escape: %s\\n" "$resolved_path" >&2; exit 111 ;; esac',
        'mkdir -p -- "$resolved_path"',
        'resolved_created=$(realpath -m -- "$resolved_path")',
        'case "$resolved_created" in "$resolved_root"|"$resolved_root"/*) ;; *) printf "workspace escape: %s\\n" "$resolved_created" >&2; exit 111 ;; esac',
        '[ -d "$resolved_created" ] || { printf "not a directory: %s\\n" "$resolved_created" >&2; exit 112; }',
      ].join('\n'),
    );
  }

  private async writeEditorText(path: string, content: string): Promise<void> {
    const absolutePath = this.resolveEditorPath(path, { forWrite: true });
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    await this.runEditorFileCommand(
      [
        'set -eu',
        `root=${shellQuote(this.state.manifest.root)}`,
        `path=${shellQuote(absolutePath)}`,
        'resolved_root=$(realpath -m -- "$root")',
        'parent=$(dirname -- "$path")',
        'base=$(basename -- "$path")',
        'resolved_parent=$(realpath -m -- "$parent")',
        'case "$resolved_parent" in "$resolved_root"|"$resolved_root"/*) ;; *) printf "workspace escape: %s\\n" "$resolved_parent" >&2; exit 111 ;; esac',
        'target="$resolved_parent/$base"',
        'if [ -d "$target" ]; then printf "directory target: %s\\n" "$target" >&2; exit 112; fi',
        'tmp=$(mktemp "$resolved_parent/.openai-agents-write.XXXXXX")',
        'cleanup() { rm -f -- "$tmp"; }',
        'trap cleanup EXIT HUP INT TERM',
        'base64 -d > "$tmp" <<\'OPENAI_AGENTS_CONTENT\'',
        encoded,
        'OPENAI_AGENTS_CONTENT',
        'chmod 644 "$tmp"',
        'mv -f -- "$tmp" "$target"',
        'trap - EXIT',
      ].join('\n'),
    );
  }

  private async deleteEditorPath(path: string): Promise<void> {
    const absolutePath = this.resolveEditorPath(path, { forWrite: true });
    await this.runEditorFileCommand(
      [
        'set -eu',
        `root=${shellQuote(this.state.manifest.root)}`,
        `path=${shellQuote(absolutePath)}`,
        'resolved_root=$(realpath -m -- "$root")',
        'parent=$(dirname -- "$path")',
        'base=$(basename -- "$path")',
        'resolved_parent=$(realpath -m -- "$parent")',
        'case "$resolved_parent" in "$resolved_root"|"$resolved_root"/*) ;; *) printf "workspace escape: %s\\n" "$resolved_parent" >&2; exit 111 ;; esac',
        'rm -f -- "$resolved_parent/$base"',
      ].join('\n'),
    );
  }

  private async runEditorFileCommand(command: string): Promise<string> {
    const result = await this.sandbox.process.executeCommand(
      command,
      this.state.manifest.root,
      this.state.environment,
      this.state.timeoutSec,
    );
    if (result.exitCode !== 0) {
      throw new UserError(
        (
          result.artifacts?.stdout ||
          result.result ||
          'remote editor operation failed'
        )
          .trim()
          .split(/\r?\n/u)
          .join('; '),
      );
    }
    return result.artifacts?.stdout ?? result.result ?? '';
  }

  private resolveEditorPath(
    path?: string,
    options: RemoteSandboxPathOptions = {},
  ): string {
    return resolveSandboxAbsolutePath(this.state.manifest.root, path, options);
  }

  private async ensureParentDir(path: string): Promise<void> {
    const parent = posixDirname(path);
    if (parent !== '.' && parent !== '/') {
      await this.sandbox.fs.createFolder(parent, '755');
    }
  }

  private async resolveRemotePath(
    path?: string,
    options: RemoteSandboxPathOptions = {},
  ): Promise<string> {
    return await validateRemoteSandboxPathForManifest({
      manifest: this.state.manifest,
      path,
      options,
      runCommand: async (command) => {
        const result = await this.sandbox.process.executeCommand(
          command,
          this.state.manifest.root,
          this.state.environment,
        );
        return {
          status: result.exitCode,
          stdout: result.artifacts?.stdout ?? result.result ?? '',
          stderr: '',
        };
      },
    });
  }

  private async createSignedPreviewUrl(
    port: number,
  ): Promise<DaytonaPreviewUrlLike> {
    try {
      if (this.sandbox.getSignedPreviewUrl) {
        return await this.sandbox.getSignedPreviewUrl(
          port,
          this.state.exposedPortUrlTtlS,
        );
      }
    } catch (error) {
      throw new SandboxProviderError(
        `DaytonaSandboxClient failed to resolve exposed port ${port}.`,
        {
          provider: 'daytona',
          port,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    throw new SandboxProviderError(
      'DaytonaSandboxClient exposed port resolution requires a Daytona signed preview URL API.',
      {
        provider: 'daytona',
        port,
      },
    );
  }
}

/**
 * @see {@link https://www.daytona.io/docs/ | Daytona docs}.
 * @see {@link https://www.daytona.io/docs/en/getting-started/ | Getting started}.
 * @see {@link https://www.daytona.io/docs/en/typescript-sdk/sandbox/ | TypeScript SDK Sandbox reference}.
 */
export class DaytonaSandboxClient implements SandboxClient<
  DaytonaSandboxClientOptions,
  DaytonaSandboxSessionState
> {
  readonly backendId = 'daytona';
  private readonly options: DaytonaSandboxClientOptions;

  constructor(options: DaytonaSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<DaytonaSandboxClientOptions> | Manifest,
    manifestOptions?: DaytonaSandboxClientOptions,
  ): Promise<DaytonaSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported('DaytonaSandboxClient', createArgs.snapshot);
    assertCoreConcurrencyLimitsUnsupported(
      'DaytonaSandboxClient',
      createArgs.concurrencyLimits,
    );
    const manifest = createArgs.manifest;
    const resolvedOptions = {
      ...this.options,
      ...createArgs.options,
    };
    const resolvedManifest = resolveManifestRoot(manifest);
    assertSandboxManifestMetadataSupported(
      'DaytonaSandboxClient',
      resolvedManifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    const client = await createDaytonaClient(resolvedOptions);

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
        const sandbox = await withProviderError(
          'DaytonaSandboxClient',
          'daytona',
          'create sandbox',
          async () =>
            await client.create(
              {
                ...(resolvedOptions.sandboxSnapshotName
                  ? { snapshot: resolvedOptions.sandboxSnapshotName }
                  : { image: resolvedOptions.image ?? 'debian:12.9' }),
                ...(!resolvedOptions.sandboxSnapshotName &&
                resolvedOptions.resources
                  ? { resources: resolvedOptions.resources }
                  : {}),
                ...(resolvedOptions.name ? { name: resolvedOptions.name } : {}),
                ...(typeof resolvedOptions.autoStopInterval === 'number'
                  ? { autoStopInterval: resolvedOptions.autoStopInterval }
                  : {}),
                ...(typeof resolvedOptions.startTimeoutSec === 'number'
                  ? { startTimeoutSec: resolvedOptions.startTimeoutSec }
                  : {}),
                ...(typeof resolvedOptions.timeoutSec === 'number'
                  ? { timeoutSec: resolvedOptions.timeoutSec }
                  : {}),
                ...(resolvedOptions.exposedPorts
                  ? { exposedPorts: resolvedOptions.exposedPorts }
                  : {}),
                ...(typeof resolvedOptions.exposedPortUrlTtlS === 'number'
                  ? { exposedPortUrlTtlS: resolvedOptions.exposedPortUrlTtlS }
                  : {}),
                envVars: environment,
              },
              ...(typeof resolvedOptions.createTimeoutSec === 'number'
                ? [{ timeout: resolvedOptions.createTimeoutSec }]
                : []),
            ),
          resolvedOptions.sandboxSnapshotName
            ? { snapshot: resolvedOptions.sandboxSnapshotName }
            : { image: resolvedOptions.image ?? 'debian:12.9' },
        );

        const session = new DaytonaSandboxSession({
          sandbox,
          state: {
            manifest: resolvedManifest,
            sandboxId: sandbox.id,
            image: resolvedOptions.image,
            resources: resolvedOptions.resources,
            pauseOnExit: resolvedOptions.pauseOnExit ?? false,
            createTimeoutSec: resolvedOptions.createTimeoutSec,
            startTimeoutSec: resolvedOptions.startTimeoutSec,
            timeoutSec: resolvedOptions.timeoutSec,
            sandboxSnapshotName: resolvedOptions.sandboxSnapshotName,
            configuredExposedPorts: resolvedOptions.exposedPorts,
            exposedPortUrlTtlS: resolvedOptions.exposedPortUrlTtlS,
            name: resolvedOptions.name,
            autoStopInterval: resolvedOptions.autoStopInterval,
            environment,
            apiKey: resolvedOptions.apiKey,
            apiUrl: resolvedOptions.apiUrl,
            target: resolvedOptions.target,
          },
        });

        try {
          await session.prepareWorkspaceRoot();
          await session.materializeInitialManifest(resolvedManifest);
        } catch (error) {
          session.state.pauseOnExit = false;
          await closeRemoteSessionOnManifestError('Daytona', session, error);
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: DaytonaSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(state: DaytonaSandboxSessionState): boolean {
    return state.pauseOnExit;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<DaytonaSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    return {
      ...state,
      ...baseState,
      sandboxId: readString(state, 'sandboxId'),
      pauseOnExit: Boolean(state.pauseOnExit),
      image: readOptionalString(state, 'image'),
      resources: readOptionalRecord(state.resources),
      createTimeoutSec: readOptionalNumber(state, 'createTimeoutSec'),
      startTimeoutSec: readOptionalNumber(state, 'startTimeoutSec'),
      timeoutSec: readOptionalNumber(state, 'timeoutSec'),
      sandboxSnapshotName: readOptionalString(state, 'sandboxSnapshotName'),
      configuredExposedPorts: readOptionalNumberArray(
        state.configuredExposedPorts,
      ),
      exposedPortUrlTtlS: readOptionalNumber(state, 'exposedPortUrlTtlS'),
      name: readOptionalString(state, 'name'),
      autoStopInterval: readOptionalNumber(state, 'autoStopInterval'),
      apiKey: readOptionalString(state, 'apiKey'),
      apiUrl: readOptionalString(state, 'apiUrl'),
      target: readOptionalString(state, 'target'),
    };
  }

  async resume(
    state: DaytonaSandboxSessionState,
  ): Promise<DaytonaSandboxSession> {
    const client = await createDaytonaClient({
      ...this.options,
      apiKey: state.apiKey ?? this.options.apiKey,
      apiUrl: state.apiUrl ?? this.options.apiUrl,
      target: state.target ?? this.options.target,
    });
    let sandbox: DaytonaSandboxLike;
    try {
      sandbox = await client.get(state.sandboxId);
      await sandbox.start(state.startTimeoutSec);
    } catch (error) {
      assertResumeRecreateAllowed(error, {
        providerName: 'DaytonaSandboxClient',
        provider: 'daytona',
        details: { sandboxId: state.sandboxId },
      });
      return await this.recreateFromPersistedState(client, state);
    }
    const session = new DaytonaSandboxSession({ state, sandbox });
    await session.prepareWorkspaceRoot();
    await session.rematerializeMountEntries();
    return session;
  }

  private async recreateFromPersistedState(
    client: DaytonaClientLike,
    state: DaytonaSandboxSessionState,
  ): Promise<DaytonaSandboxSession> {
    const sandbox = await withProviderError(
      'DaytonaSandboxClient',
      'daytona',
      'create sandbox',
      async () =>
        await client.create(
          {
            ...(state.sandboxSnapshotName
              ? { snapshot: state.sandboxSnapshotName }
              : { image: state.image ?? 'debian:12.9' }),
            ...(!state.sandboxSnapshotName && state.resources
              ? { resources: state.resources }
              : {}),
            ...(state.name ? { name: state.name } : {}),
            ...(typeof state.autoStopInterval === 'number'
              ? { autoStopInterval: state.autoStopInterval }
              : {}),
            ...(typeof state.startTimeoutSec === 'number'
              ? { startTimeoutSec: state.startTimeoutSec }
              : {}),
            ...(typeof state.timeoutSec === 'number'
              ? { timeoutSec: state.timeoutSec }
              : {}),
            ...(state.configuredExposedPorts
              ? { exposedPorts: state.configuredExposedPorts }
              : {}),
            ...(typeof state.exposedPortUrlTtlS === 'number'
              ? { exposedPortUrlTtlS: state.exposedPortUrlTtlS }
              : {}),
            envVars: state.environment,
          },
          ...(typeof state.createTimeoutSec === 'number'
            ? [{ timeout: state.createTimeoutSec }]
            : []),
        ),
      state.sandboxSnapshotName
        ? { snapshot: state.sandboxSnapshotName }
        : { image: state.image ?? 'debian:12.9' },
    );
    const nextState: DaytonaSandboxSessionState = {
      ...state,
      sandboxId: sandbox.id,
      environment: { ...state.environment },
    };
    delete nextState.exposedPorts;
    const session = new DaytonaSandboxSession({
      sandbox,
      state: nextState,
    });
    try {
      await session.prepareWorkspaceRoot();
      await session.materializeInitialManifest(state.manifest);
    } catch (error) {
      session.state.pauseOnExit = false;
      await closeRemoteSessionOnManifestError('Daytona', session, error);
    }
    return session;
  }
}

function getUsableDaytonaCachedExposedPortEndpoint(
  state: DaytonaSandboxSessionState,
  requestedPort: number,
): ExposedPortEndpoint | undefined {
  const cached = getCachedExposedPortEndpoint(state, requestedPort);
  if (!cached) {
    return undefined;
  }

  const expiresAtMs = cached.daytonaExpiresAtMs;
  return typeof expiresAtMs === 'number' &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now()
    ? cached
    : undefined;
}

function withDaytonaPreviewExpiration(
  endpoint: ExposedPortEndpoint,
  ttlS: number | undefined,
): ExposedPortEndpoint {
  const resolvedTtlS =
    typeof ttlS === 'number' ? ttlS : DEFAULT_EXPOSED_PORT_URL_TTL_S;
  if (!Number.isFinite(resolvedTtlS) || resolvedTtlS <= 0) {
    return endpoint;
  }
  return {
    ...endpoint,
    daytonaExpiresAtMs: Date.now() + resolvedTtlS * 1000,
  };
}

async function createDaytonaClient(
  options: Pick<DaytonaSandboxClientOptions, 'apiKey' | 'apiUrl' | 'target'>,
): Promise<DaytonaClientLike> {
  try {
    const { Daytona } = await import('@daytonaio/sdk');
    return adaptDaytonaClient(
      new Daytona({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.target ? { target: options.target } : {}),
      }),
    );
  } catch (error) {
    throw new UserError(
      `Daytona sandbox support requires the optional \`@daytonaio/sdk\` package. Install it before using Daytona-backed sandbox examples. ${(error as Error).message}`,
    );
  }
}

function adaptDaytonaClient(
  client: import('@daytonaio/sdk').Daytona,
): DaytonaClientLike {
  return {
    create: async (params, options) =>
      adaptDaytonaSandbox(
        await client.create(
          params as Parameters<typeof client.create>[0],
          options as Parameters<typeof client.create>[1],
        ),
      ),
    get: async (idOrName) => adaptDaytonaSandbox(await client.get(idOrName)),
  };
}

function adaptDaytonaSandbox(
  sandbox: import('@daytonaio/sdk').Sandbox,
): DaytonaSandboxLike {
  return {
    id: sandbox.id,
    start: async (timeout) => await sandbox.start(timeout),
    stop: async (timeout, force) => await sandbox.stop(timeout, force),
    delete: async (timeout) => await sandbox.delete(timeout),
    fs: {
      createFolder: async (path, mode) =>
        await sandbox.fs.createFolder(path, mode),
      uploadFile: async (source, remotePath, timeout) => {
        if (typeof source === 'string') {
          if (typeof timeout === 'number') {
            await sandbox.fs.uploadFile(source, remotePath, timeout);
          } else {
            await sandbox.fs.uploadFile(source, remotePath);
          }
          return;
        }
        if (typeof timeout === 'number') {
          await sandbox.fs.uploadFile(source, remotePath, timeout);
        } else {
          await sandbox.fs.uploadFile(source, remotePath);
        }
      },
      downloadFile: async (remotePath, timeout) =>
        await sandbox.fs.downloadFile(remotePath, timeout),
      deleteFile: async (path, recursive) =>
        await sandbox.fs.deleteFile(path, recursive),
    },
    process: {
      executeCommand: async (command, cwd, env, timeout) =>
        typeof timeout === 'number'
          ? await sandbox.process.executeCommand(command, cwd, env, timeout)
          : await sandbox.process.executeCommand(command, cwd, env),
      ...(typeof sandbox.process.createPty === 'function'
        ? {
            createPty: async (options) =>
              await sandbox.process.createPty(
                options as Parameters<typeof sandbox.process.createPty>[0],
              ),
          }
        : {}),
      ...(typeof sandbox.process.killPtySession === 'function'
        ? {
            killPtySession: async (id) =>
              await sandbox.process.killPtySession(id),
          }
        : {}),
    },
    getSignedPreviewUrl: async (port, expiresInSeconds) =>
      await sandbox.getSignedPreviewUrl(port, expiresInSeconds),
  };
}

function resolveManifestRoot(manifest: Manifest): Manifest {
  if (manifest.root === '/workspace') {
    return cloneManifestWithRoot(manifest, DEFAULT_WORKSPACE_ROOT);
  }

  return manifest;
}

function commandForDaytonaUser(command: string, user?: string): string {
  if (!user) {
    return command;
  }
  return [
    `target_user=${shellQuote(user)}`,
    'current_uid="$(id -u)"',
    'current_user="$(id -un 2>/dev/null || id -u)"',
    'if [ "$current_uid" = "$target_user" ] || [ "$current_user" = "$target_user" ]; then',
    `  sh -lc ${shellQuote(command)}`,
    'elif [ "$current_uid" -eq 0 ]; then',
    `  su -s /bin/sh "$target_user" -c ${shellQuote(command)}`,
    'else',
    `  sudo -n -u "$target_user" -- sh -lc ${shellQuote(command)}`,
    'fi',
  ].join('\n');
}

async function deleteDaytonaSandboxWithRetry(
  deleteSandbox: () => Promise<void>,
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await deleteSandbox();
      return;
    } catch (error) {
      const delayMs = DAYTONA_DELETE_RETRY_DELAYS_MS[attempt];
      if (
        !isDaytonaStateChangeInProgressError(error) ||
        delayMs === undefined
      ) {
        throw error;
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function isDaytonaStateChangeInProgressError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  return (
    record.statusCode === 409 &&
    error instanceof Error &&
    /state change in progress/i.test(error.message)
  );
}

function exitCodeFromDaytonaResult(value: unknown): number | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.exitCode === 'number' ? record.exitCode : undefined;
}
