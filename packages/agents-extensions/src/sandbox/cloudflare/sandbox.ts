import { UserError, type ToolOutputImage } from '@openai/agents-core';
import { loadEnv } from '@openai/agents-core/_shims';
import {
  Manifest,
  SandboxArchiveError,
  SandboxMountError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  SandboxWorkspaceReadNotFoundError,
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
  assertTarWorkspacePersistence,
  toWorkspaceArchiveBytes,
  validateWorkspaceTarArchive,
} from '../shared/archive';
import { RemoteSandboxEditor } from '../shared/editor';
import {
  assertShellEnvironmentName,
  materializeEnvironment,
} from '../shared/environment';
import {
  applyInlineManifestEntryToState,
  applyInlineManifestToState,
  entryContainsLocalSource,
  manifestContainsLocalSource,
} from '../shared/manifest';
import { imageOutputFromBytes } from '../shared/media';
import {
  assertSandboxEntryMetadataSupported,
  assertSandboxManifestMetadataSupported,
  MOUNT_MANIFEST_METADATA_SUPPORT,
} from '../shared/metadata';
import {
  elapsedSeconds,
  formatExecResponse,
  truncateOutput,
} from '../shared/output';
import { assertConfiguredExposedPort } from '../shared/ports';
import {
  addPtyWebSocketListener,
  appendPtyOutput,
  createPtyProcessEntry,
  formatPtyExecUpdate,
  markPtyDone,
  openPtyWebSocket,
  PtyProcessRegistry,
  shellCommandForPty,
  writePtyStdin,
  type PtyProcessEntry,
  type PtyWebSocket,
} from '../shared/pty';
import {
  posixDirname,
  resolveSandboxWorkdir,
  shellQuote,
  validateRemoteSandboxPathForManifest,
} from '../shared/paths';
import {
  assertCoreConcurrencyLimitsUnsupported,
  assertCoreSnapshotUnsupported,
  assertRunAsUnsupported,
  closeRemoteSessionOnManifestError,
  withProviderError,
  withSandboxSpan,
} from '../shared/session';
import {
  deserializeRemoteSandboxSessionStateValues,
  serializeRemoteSandboxSessionState,
} from '../shared/sessionState';
import {
  isRecord,
  readOptionalNumber,
  readOptionalNumberArray,
  readOptionalRecordArray,
  readString,
} from '../shared/typeGuards';
import {
  type RemoteManifestWriter,
  type RemoteSandboxPathOptions,
  type RemoteSandboxPathResolver,
} from '../shared/types';
import {
  buildCloudflareBucketMountConfig,
  cloudflareBucketMountRequestOptions,
  isCloudflareBucketMountEntry,
  type CloudflareBucketMountRequestOptions,
} from './mounts';

export interface CloudflareSandboxClientOptions extends SandboxClientOptions {
  workerUrl: string;
  apiKey?: string;
  exposedPorts?: number[];
  timeoutMs?: number;
  createTimeoutMs?: number;
  requestTimeoutMs?: number;
  timeouts?: CloudflareSandboxTimeouts;
  mounts?: Array<Record<string, unknown>>;
}

export interface CloudflareSandboxTimeouts {
  execTimeoutMs?: number;
  createTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface CloudflareSandboxSessionState extends SandboxSessionState {
  workerUrl: string;
  sandboxId: string;
  configuredExposedPorts?: number[];
  timeoutMs?: number;
  createTimeoutMs?: number;
  requestTimeoutMs?: number;
  timeouts?: CloudflareSandboxTimeouts;
  mounts?: Array<Record<string, unknown>>;
  environment: Record<string, string>;
}

export class CloudflareSandboxSession implements SandboxSession<CloudflareSandboxSessionState> {
  readonly state: CloudflareSandboxSessionState;
  private readonly apiKey?: string;
  private readonly ptyProcesses = new PtyProcessRegistry();
  private readonly remotePathResolver: RemoteSandboxPathResolver = async (
    path,
    options,
  ) => await this.resolveRemotePath(path, options);

  constructor(args: { state: CloudflareSandboxSessionState; apiKey?: string }) {
    this.state = {
      ...args.state,
      sandboxId: normalizeCloudflarePersistedSandboxId(args.state.sandboxId),
    };
    this.apiKey = args.apiKey;
  }

  createEditor(runAs?: string): RemoteSandboxEditor {
    assertRunAsUnsupported('CloudflareSandboxClient', runAs);
    return new RemoteSandboxEditor({
      resolvePath: this.remotePathResolver,
      pathExists: async (path) => await this.pathExists(path),
      mkdir: async (path) => {
        await this.mkdirPath(path, 'create directory');
      },
      readText: async (path) =>
        new TextDecoder().decode(await this.readFileBytes(path)),
      writeText: async (path, content) => {
        await this.ensureParentDir(path);
        await this.writeFile(path, new TextEncoder().encode(content));
      },
      deletePath: async (path) => {
        const result = await this.execShell(`rm -f -- ${shellQuote(path)}`);
        if (result.exitCode !== 0) {
          throw new SandboxProviderError(
            'CloudflareSandboxClient failed to delete path.',
            {
              provider: 'cloudflare',
              operation: 'delete path',
              sandboxId: this.state.sandboxId,
              path,
              exitCode: result.exitCode,
              output: result.output,
            },
          );
        }
      },
    });
  }

  supportsPty(): boolean {
    return true;
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    if (args.tty) {
      return await this.execPtyCommand(args);
    }
    assertRunAsUnsupported('CloudflareSandboxClient', args.runAs);

    const start = Date.now();
    const wrapped = buildShellCommand(
      args.cmd,
      this.state.environment,
      resolveSandboxWorkdir(this.state.manifest.root, args.workdir),
    );
    const result = await this.execShell(wrapped);
    const output = truncateOutput(result.output, args.maxOutputTokens);

    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      exitCode: result.exitCode,
      originalTokenCount: output.originalTokenCount,
    });
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    return await writePtyStdin({
      providerName: 'CloudflareSandboxClient',
      registry: this.ptyProcesses,
      sessionId: args.sessionId,
      chars: args.chars,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  private async execPtyCommand(args: ExecCommandArgs): Promise<string> {
    assertRunAsUnsupported('CloudflareSandboxClient', args.runAs);
    const start = Date.now();
    const entry = createPtyProcessEntry({ tty: true });
    let readyPromise: Promise<void> = Promise.resolve();
    let removeMessageListener = () => {};
    const socket = await openPtyWebSocket({
      url: buildCloudflarePtyWebSocketUrl(this.state),
      providerName: 'CloudflareSandboxClient',
      headers: buildCloudflarePtyWebSocketHeaders(this.apiKey),
      configure: (pendingSocket) => {
        removeMessageListener = addPtyWebSocketListener(
          pendingSocket,
          'message',
          (event) => handleCloudflarePtyMessage(entry, event),
        );
        readyPromise = waitForCloudflarePtyReady(pendingSocket);
        readyPromise.catch(() => {});
      },
    });
    const removeCloseListener = addPtyWebSocketListener(socket, 'close', () => {
      if (!entry.done) {
        markPtyDone(entry);
      }
    });
    const removeErrorListener = addPtyWebSocketListener(socket, 'error', () => {
      if (!entry.done) {
        markPtyDone(entry, 1);
      }
    });

    try {
      await readyPromise;
    } catch (error) {
      socket.close();
      throw error;
    }

    entry.sendInput = async (chars) => {
      socket.send(new TextEncoder().encode(chars));
    };
    entry.terminate = async () => {
      removeMessageListener();
      removeCloseListener();
      removeErrorListener();
      socket.close();
    };
    let registered = false;
    let sessionId: number;
    try {
      const command = shellCommandForPty({
        ...args,
        cmd: buildShellCommand(
          args.cmd,
          this.state.environment,
          resolveSandboxWorkdir(this.state.manifest.root, args.workdir),
        ),
      });
      await entry.sendInput(`${command}\n`);

      const registeredProcess = this.ptyProcesses.register(entry);
      registered = true;
      sessionId = registeredProcess.sessionId;
      if (registeredProcess.pruned) {
        await registeredProcess.pruned.terminate?.().catch(() => {});
      }
    } catch (error) {
      if (!registered) {
        await entry.terminate?.().catch(() => {});
      }
      throw error;
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

  async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    assertRunAsUnsupported('CloudflareSandboxClient', args.runAs);
    const absolutePath = await this.resolveRemotePath(args.path);
    const bytes = await this.readFileBytes(absolutePath);
    return imageOutputFromBytes(args.path, bytes);
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    assertRunAsUnsupported('CloudflareSandboxClient', runAs);
    const absolutePath = await this.resolveRemotePath(path);
    const result = await this.execShell(`test -e ${shellQuote(absolutePath)}`);
    return result.exitCode === 0;
  }

  async running(): Promise<boolean> {
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/running`,
      {
        method: 'GET',
      },
    );
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw cloudflareProviderHttpError('check running state', response, {
        sandboxId: this.state.sandboxId,
      });
    }
    const payload = (await response.json().catch(() => ({}))) as {
      running?: unknown;
    };
    return Boolean(payload.running);
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    const requestedPort = assertConfiguredExposedPort({
      providerName: 'CloudflareSandboxClient',
      port,
      configuredPorts: this.state.configuredExposedPorts,
    });
    throw new SandboxUnsupportedFeatureError(
      'CloudflareSandboxClient does not support exposed port resolution until the worker deployment exposes a port-resolution endpoint.',
      {
        provider: 'cloudflare',
        port: requestedPort,
      },
    );
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    assertRunAsUnsupported('CloudflareSandboxClient', args.runAs);
    assertSandboxEntryMetadataSupported(
      'CloudflareSandboxClient',
      args.path,
      args.entry,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    if (entryContainsLocalSource(args.entry)) {
      const { applyLocalSourceManifestEntryToState } =
        await import('../shared/localSources');
      await applyLocalSourceManifestEntryToState(
        this.state,
        args.path,
        args.entry,
        'cloudflare',
        this.writer(),
        this.remotePathResolver,
        this.manifestMaterializationOptions,
      );
      return;
    }

    await applyInlineManifestEntryToState(
      this.state,
      args.path,
      args.entry,
      'cloudflare',
      this.writer(),
      this.remotePathResolver,
      this.manifestMaterializationOptions,
    );
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    assertRunAsUnsupported('CloudflareSandboxClient', runAs);
    assertCloudflareManifestRoot(manifest);
    assertSandboxManifestMetadataSupported(
      'CloudflareSandboxClient',
      manifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    assertCloudflareManifestMountsSupported(manifest);
    if (manifestContainsLocalSource(manifest)) {
      const { applyLocalSourceManifestToState } =
        await import('../shared/localSources');
      await applyLocalSourceManifestToState(
        this.state,
        manifest,
        'cloudflare',
        this.writer(),
        this.remotePathResolver,
        this.manifestMaterializationOptions,
      );
      return;
    }

    await applyInlineManifestToState(
      this.state,
      manifest,
      'cloudflare',
      this.writer(),
      this.remotePathResolver,
      this.manifestMaterializationOptions,
    );
  }

  async mountBucket(args: {
    bucket: string;
    mountPath: string;
    options: CloudflareBucketMountRequestOptions;
  }): Promise<void> {
    const mountPath = await this.resolveRemotePath(args.mountPath, {
      forWrite: true,
    });
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/mount`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucket: args.bucket,
          mountPath,
          options: args.options,
        }),
      },
    );
    if (!response.ok) {
      throw await cloudflareMountError({
        response,
        message: 'Cloudflare bucket mount failed.',
        mountPath,
        bucket: args.bucket,
      });
    }
  }

  async unmountBucket(mountPath: string): Promise<void> {
    const resolvedMountPath = await this.resolveRemotePath(mountPath, {
      forWrite: true,
    });
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/unmount`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mountPath: resolvedMountPath,
        }),
      },
    );
    if (!response.ok) {
      throw await cloudflareMountError({
        response,
        message: 'Cloudflare bucket unmount failed.',
        mountPath: resolvedMountPath,
      });
    }
  }

  async persistWorkspace(): Promise<Uint8Array> {
    assertTarWorkspacePersistence('CloudflareSandboxClient', 'tar');
    const excludes = [...this.state.manifest.ephemeralPersistencePaths()]
      .filter((path) => path.length > 0)
      .sort((left, right) => left.localeCompare(right))
      .join(',');
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/persist${
        excludes ? `?excludes=${encodeURIComponent(excludes)}` : ''
      }`,
      {
        method: 'POST',
      },
    );
    if (!response.ok) {
      throw new SandboxArchiveError(
        `Cloudflare sandbox persist failed with HTTP ${response.status}.`,
        {
          provider: 'cloudflare',
          sandboxId: this.state.sandboxId,
          status: response.status,
        },
      );
    }
    const archive = decodeStreamedPayload(
      new Uint8Array(await response.arrayBuffer()),
      response.headers,
    );
    validateWorkspaceTarArchive(archive);
    return archive;
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    assertTarWorkspacePersistence('CloudflareSandboxClient', 'tar');
    const archive = toWorkspaceArchiveBytes(data);
    validateWorkspaceTarArchive(archive);
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/hydrate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: toArrayBuffer(archive),
      },
    );
    if (!response.ok) {
      throw new SandboxArchiveError(
        `Cloudflare sandbox hydrate failed with HTTP ${response.status}.`,
        {
          provider: 'cloudflare',
          sandboxId: this.state.sandboxId,
          status: response.status,
        },
      );
    }
  }

  async close(): Promise<void> {
    await this.ptyProcesses.terminateAll();
    await withSandboxSpan(
      'sandbox.stop',
      {
        backend_id: 'cloudflare',
        sandbox_id: this.state.sandboxId,
      },
      async () => {
        const response = await this.fetch(
          `/v1/sandbox/${this.state.sandboxId}`,
          {
            method: 'DELETE',
          },
        );
        if (!response.ok && response.status !== 404) {
          throw cloudflareProviderHttpError('delete sandbox', response, {
            sandboxId: this.state.sandboxId,
          });
        }
      },
    );
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  async delete(): Promise<void> {
    await this.close();
  }

  private writer(): RemoteManifestWriter {
    return {
      mkdir: async (path) => {
        await this.mkdirPath(path, 'create directory');
      },
      writeFile: async (path, content) => {
        await this.ensureParentDir(path);
        await this.writeFile(
          path,
          typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content,
        );
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
    if (!isCloudflareBucketMountEntry(entry)) {
      throw new SandboxUnsupportedFeatureError(
        'CloudflareSandboxClient only supports CloudflareBucketMountStrategy mount entries.',
        {
          provider: 'cloudflare',
          feature: 'entry.mountStrategy',
          path: absolutePath,
          mountType: entry.type,
          strategyType: entry.mountStrategy?.type,
        },
      );
    }
    const config = buildCloudflareBucketMountConfig(entry);
    await this.mountBucket({
      bucket: config.bucketName,
      mountPath: entry.mountPath ?? absolutePath,
      options: cloudflareBucketMountRequestOptions(config),
    });
  }

  private async execShell(
    shellCommand: string,
  ): Promise<{ exitCode: number; output: string }> {
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/exec`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          argv: ['/bin/sh', '-lc', shellCommand],
          ...(typeof this.state.timeouts?.execTimeoutMs === 'number' ||
          typeof this.state.timeoutMs === 'number'
            ? {
                timeoutMs:
                  this.state.timeouts?.execTimeoutMs ?? this.state.timeoutMs,
              }
            : {}),
        }),
      },
    );
    if (!response.ok) {
      throw cloudflareProviderHttpError('execute command', response, {
        sandboxId: this.state.sandboxId,
      });
    }
    if (!response.body) {
      throw new SandboxProviderError(
        'CloudflareSandboxClient failed to execute command.',
        {
          provider: 'cloudflare',
          operation: 'execute command',
          sandboxId: this.state.sandboxId,
          cause: 'missing response body',
        },
      );
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let stdout = '';
    let stderr = '';
    let exitCode: number | undefined;
    const processEvent = (event: { event: string; data: string }): void => {
      if (event.event === 'stdout') {
        stdout += decodeBase64Text(event.data);
        return;
      }
      if (event.event === 'stderr') {
        stderr += decodeBase64Text(event.data);
        return;
      }
      if (event.event === 'exit') {
        try {
          const payload = JSON.parse(event.data) as { exit_code?: number };
          exitCode =
            typeof payload.exit_code === 'number' &&
            Number.isFinite(payload.exit_code)
              ? Math.trunc(payload.exit_code)
              : 1;
        } catch {
          exitCode = 1;
        }
        return;
      }
      if (event.event === 'error') {
        throw new SandboxProviderError(
          'CloudflareSandboxClient failed to execute command.',
          {
            provider: 'cloudflare',
            operation: 'execute command',
            sandboxId: this.state.sandboxId,
            cause: event.data || 'unknown error',
          },
        );
      }
    };

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const { events, remaining } = splitCompleteSseEvents(buffer);
      buffer = remaining;
      for (const part of events) {
        const event = parseSseEvent(part);
        if (!event) {
          continue;
        }
        processEvent(event);
      }
    }
    buffer += decoder.decode();
    for (const part of collectSseEvents(buffer)) {
      const event = parseSseEvent(part);
      if (event) {
        processEvent(event);
      }
    }

    return {
      exitCode: exitCode ?? 1,
      output: [stdout.trimEnd(), stderr.trimEnd()]
        .filter((value) => value.length > 0)
        .join('\n'),
    };
  }

  private async readFileBytes(path: string): Promise<Uint8Array> {
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/file/${encodeSandboxPath(path)}`,
      {
        method: 'GET',
      },
    );
    if (response.status === 404) {
      throw new SandboxWorkspaceReadNotFoundError(
        `Cloudflare sandbox path not found: ${path}.`,
        {
          provider: 'cloudflare',
          sandboxId: this.state.sandboxId,
          path,
          status: response.status,
        },
      );
    }
    if (!response.ok) {
      throw cloudflareProviderHttpError('read file', response, {
        sandboxId: this.state.sandboxId,
        path,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return decodeStreamedPayload(bytes, response.headers);
  }

  private async writeFile(path: string, content: Uint8Array): Promise<void> {
    const response = await this.fetch(
      `/v1/sandbox/${this.state.sandboxId}/file/${encodeSandboxPath(path)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: toArrayBuffer(content),
      },
    );
    if (!response.ok) {
      throw cloudflareProviderHttpError('write file', response, {
        sandboxId: this.state.sandboxId,
        path,
      });
    }
  }

  private async ensureParentDir(path: string): Promise<void> {
    const parent = posixDirname(path);
    if (parent !== '.' && parent !== '/') {
      await this.mkdirPath(parent, 'create parent directory');
    }
  }

  private async mkdirPath(path: string, operation: string): Promise<void> {
    const result = await this.execShell(`mkdir -p -- ${shellQuote(path)}`);
    if (result.exitCode !== 0) {
      throw new SandboxProviderError(
        'CloudflareSandboxClient failed to create directory.',
        {
          provider: 'cloudflare',
          operation,
          sandboxId: this.state.sandboxId,
          path,
          exitCode: result.exitCode,
          output: result.output,
        },
      );
    }
  }

  private async fetch(
    path: string,
    init: RequestInit,
    timeoutMs?: number,
  ): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    const apiKey = this.apiKey ?? loadEnv().CLOUDFLARE_SANDBOX_API_KEY;
    if (apiKey) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    const requestTimeoutMs =
      timeoutMs ??
      this.state.timeouts?.requestTimeoutMs ??
      this.state.requestTimeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    if (typeof requestTimeoutMs === 'number' && !init.signal) {
      controller = new AbortController();
      timeoutId = setTimeout(() => {
        controller?.abort();
      }, requestTimeoutMs);
    }
    try {
      return await withProviderError(
        'CloudflareSandboxClient',
        'cloudflare',
        'request worker',
        async () =>
          await fetch(`${this.state.workerUrl}${path}`, {
            ...init,
            headers,
            ...(controller ? { signal: controller.signal } : {}),
          }),
        {
          sandboxId: this.state.sandboxId,
          path,
          method: init.method ?? 'GET',
        },
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
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
        const result = await this.execShell(command);
        return {
          status: result.exitCode,
          stdout: result.output,
          stderr: '',
        };
      },
    });
  }
}

/**
 * @see {@link https://developers.cloudflare.com/sandbox/ | Sandbox SDK overview}.
 * @see {@link https://developers.cloudflare.com/sandbox/get-started/ | Getting started}.
 * @see {@link https://developers.cloudflare.com/sandbox/concepts/architecture/ | Sandbox architecture}.
 */
export class CloudflareSandboxClient implements SandboxClient<
  CloudflareSandboxClientOptions,
  CloudflareSandboxSessionState
> {
  readonly backendId = 'cloudflare';
  private readonly options: Partial<CloudflareSandboxClientOptions>;

  constructor(options: Partial<CloudflareSandboxClientOptions> = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs | Manifest,
    manifestOptions?: SandboxClientOptions,
  ): Promise<CloudflareSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(
      args,
      manifestOptions as CloudflareSandboxClientOptions | undefined,
    );
    assertCoreSnapshotUnsupported(
      'CloudflareSandboxClient',
      createArgs.snapshot,
    );
    assertCoreConcurrencyLimitsUnsupported(
      'CloudflareSandboxClient',
      createArgs.concurrencyLimits,
    );
    const manifest = createArgs.manifest;
    const resolvedOptions = {
      ...this.options,
      ...(createArgs.options as Partial<CloudflareSandboxClientOptions>),
    };
    const timeouts = resolveCloudflareTimeouts(resolvedOptions);
    const workerUrl = resolvedOptions.workerUrl;
    if (!workerUrl) {
      throw new UserError(
        'CloudflareSandboxClient requires options.workerUrl.',
      );
    }
    assertCloudflareManifestRoot(manifest);
    assertSandboxManifestMetadataSupported(
      'CloudflareSandboxClient',
      manifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    assertCloudflareManifestMountsSupported(manifest);

    return await withSandboxSpan(
      'sandbox.start',
      {
        backend_id: this.backendId,
      },
      async () => {
        const environment = await materializeEnvironment(manifest);
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        const apiKey =
          resolvedOptions.apiKey ?? loadEnv().CLOUDFLARE_SANDBOX_API_KEY;
        if (apiKey) {
          headers.set('Authorization', `Bearer ${apiKey}`);
        }

        const normalizedWorkerUrl = normalizeCloudflareWorkerUrl(
          workerUrl,
          'options.workerUrl',
        );
        const response = await withProviderError(
          'CloudflareSandboxClient',
          'cloudflare',
          'create sandbox',
          async () =>
            await fetchWithOptionalTimeout(
              `${normalizedWorkerUrl}/v1/sandbox`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  ...(resolvedOptions.exposedPorts
                    ? { exposedPorts: resolvedOptions.exposedPorts }
                    : {}),
                  ...(typeof timeouts.execTimeoutMs === 'number'
                    ? { timeoutMs: timeouts.execTimeoutMs }
                    : {}),
                  ...(typeof timeouts.createTimeoutMs === 'number'
                    ? { createTimeoutMs: timeouts.createTimeoutMs }
                    : {}),
                  ...(resolvedOptions.mounts
                    ? { mounts: resolvedOptions.mounts }
                    : {}),
                }),
              },
              timeouts.createTimeoutMs ?? timeouts.requestTimeoutMs,
            ),
          { workerUrl: normalizedWorkerUrl },
        );
        if (!response.ok) {
          throw cloudflareProviderHttpError('create sandbox', response, {
            workerUrl: normalizedWorkerUrl,
          });
        }
        const payload = await withProviderError(
          'CloudflareSandboxClient',
          'cloudflare',
          'parse create response',
          async () => (await response.json()) as { id?: unknown },
          { workerUrl: normalizedWorkerUrl },
        );
        const sandboxId = normalizeCloudflareCreatedSandboxId(
          payload.id,
          normalizedWorkerUrl,
        );

        const session = new CloudflareSandboxSession({
          apiKey,
          state: {
            manifest,
            workerUrl: normalizedWorkerUrl,
            sandboxId,
            configuredExposedPorts: resolvedOptions.exposedPorts,
            timeoutMs: resolvedOptions.timeoutMs,
            createTimeoutMs: timeouts.createTimeoutMs,
            requestTimeoutMs: timeouts.requestTimeoutMs,
            timeouts,
            mounts: resolvedOptions.mounts,
            environment,
          },
        });
        try {
          await session.applyManifest(manifest);
        } catch (error) {
          await closeRemoteSessionOnManifestError('Cloudflare', session, error);
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: CloudflareSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(): boolean {
    return false;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<CloudflareSandboxSessionState> {
    const baseState = deserializeRemoteSandboxSessionStateValues(state);
    return {
      ...state,
      ...baseState,
      workerUrl: readString(state, 'workerUrl'),
      sandboxId: readString(state, 'sandboxId'),
      configuredExposedPorts: readOptionalNumberArray(
        state.configuredExposedPorts,
      ),
      timeoutMs: readOptionalNumber(state, 'timeoutMs'),
      createTimeoutMs: readOptionalNumber(state, 'createTimeoutMs'),
      requestTimeoutMs: readOptionalNumber(state, 'requestTimeoutMs'),
      timeouts: resolveCloudflareTimeouts({
        timeoutMs: readOptionalNumber(state, 'timeoutMs'),
        createTimeoutMs: readOptionalNumber(state, 'createTimeoutMs'),
        requestTimeoutMs: readOptionalNumber(state, 'requestTimeoutMs'),
        timeouts: isRecord(state.timeouts)
          ? (state.timeouts as CloudflareSandboxTimeouts)
          : undefined,
      }),
      mounts: readOptionalRecordArray(state.mounts),
    };
  }

  async resume(
    state: CloudflareSandboxSessionState,
  ): Promise<CloudflareSandboxSession> {
    const sandboxId = normalizeCloudflarePersistedSandboxId(
      (state as Record<string, unknown>).sandboxId,
    );
    const workerUrl = normalizeCloudflareWorkerUrl(
      state.workerUrl,
      'persisted workerUrl',
    );
    assertCloudflareManifestRoot(state.manifest);
    assertSandboxManifestMetadataSupported(
      'CloudflareSandboxClient',
      state.manifest,
      MOUNT_MANIFEST_METADATA_SUPPORT,
    );
    assertCloudflareManifestMountsSupported(state.manifest);

    const session = new CloudflareSandboxSession({
      state: {
        ...state,
        sandboxId,
        workerUrl,
      },
      apiKey: this.options.apiKey ?? loadEnv().CLOUDFLARE_SANDBOX_API_KEY,
    });
    if (!(await session.running())) {
      throw new UserError(
        `Cloudflare sandbox ${sandboxId} is no longer running.`,
      );
    }
    return session;
  }
}

function buildShellCommand(
  command: string,
  environment: Record<string, string>,
  cwd: string,
): string {
  const exports = Object.entries(environment).map(([key, value]) => {
    assertShellEnvironmentName(key);
    return `export ${key}=${shellQuote(value)}`;
  });
  return [`cd ${shellQuote(cwd)}`, ...exports, command].join(' && ');
}

function encodeSandboxPath(path: string): string {
  return path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
}

function resolveCloudflareTimeouts(
  options: Pick<
    CloudflareSandboxClientOptions,
    'timeoutMs' | 'createTimeoutMs' | 'requestTimeoutMs' | 'timeouts'
  >,
): CloudflareSandboxTimeouts {
  return {
    ...options.timeouts,
    execTimeoutMs: options.timeouts?.execTimeoutMs ?? options.timeoutMs,
    createTimeoutMs:
      options.timeouts?.createTimeoutMs ?? options.createTimeoutMs,
    requestTimeoutMs:
      options.timeouts?.requestTimeoutMs ?? options.requestTimeoutMs,
  };
}

function normalizeCloudflareWorkerUrl(
  workerUrl: string,
  source: string,
): string {
  let url: URL;
  try {
    url = new URL(workerUrl);
  } catch {
    throw new UserError(
      `Cloudflare sandbox ${source} must be an absolute http(s) URL.`,
    );
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.search ||
    url.hash
  ) {
    throw new UserError(
      `Cloudflare sandbox ${source} must be an absolute http(s) URL.`,
    );
  }
  return url.href.replace(/\/$/u, '');
}

const CLOUDFLARE_SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

function normalizeCloudflareCreatedSandboxId(
  sandboxId: unknown,
  workerUrl: string,
): string {
  if (isValidCloudflareSandboxId(sandboxId)) {
    return sandboxId;
  }
  throw new SandboxProviderError(
    'CloudflareSandboxClient failed to create sandbox.',
    {
      provider: 'cloudflare',
      operation: 'create sandbox',
      workerUrl,
      cause: 'invalid sandbox id',
    },
  );
}

function normalizeCloudflarePersistedSandboxId(sandboxId: unknown): string {
  if (sandboxId === undefined || sandboxId === null || sandboxId === '') {
    throw new UserError(
      'Cloudflare sandbox resume requires a persisted sandboxId.',
    );
  }
  if (isValidCloudflareSandboxId(sandboxId)) {
    return sandboxId;
  }
  throw new UserError(
    'Cloudflare sandbox persisted sandboxId must be a safe path segment.',
  );
}

function isValidCloudflareSandboxId(sandboxId: unknown): sandboxId is string {
  return (
    typeof sandboxId === 'string' &&
    CLOUDFLARE_SANDBOX_ID_PATTERN.test(sandboxId)
  );
}

async function fetchWithOptionalTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number | undefined,
): Promise<Response> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  if (typeof timeoutMs === 'number' && !init.signal) {
    controller = new AbortController();
    timeoutId = setTimeout(() => {
      controller?.abort();
    }, timeoutMs);
  }
  try {
    return await fetch(input, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildCloudflarePtyWebSocketUrl(
  state: CloudflareSandboxSessionState,
): string {
  const base = state.workerUrl.replace(/\/$/u, '');
  const wsBase = base.replace(/^https:/u, 'wss:').replace(/^http:/u, 'ws:');
  const url = new URL(`${wsBase}/v1/sandbox/${state.sandboxId}/pty`);
  url.searchParams.set('cols', '80');
  url.searchParams.set('rows', '24');
  return url.toString();
}

function buildCloudflarePtyWebSocketHeaders(
  apiKey?: string,
): Record<string, string> | undefined {
  if (apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
    };
  }
  return undefined;
}

function assertCloudflareManifestRoot(manifest: Manifest): void {
  if (manifest.root !== '/workspace') {
    throw new UserError(
      'Cloudflare sandboxes currently require manifest.root="/workspace".',
    );
  }
}

function assertCloudflareManifestMountsSupported(manifest: Manifest): void {
  for (const { entry, mountPath } of manifest.mountTargets()) {
    if (!isCloudflareBucketMountEntry(entry)) {
      throw new SandboxUnsupportedFeatureError(
        'CloudflareSandboxClient only supports CloudflareBucketMountStrategy mount entries.',
        {
          provider: 'cloudflare',
          feature: 'entry.mountStrategy',
          path: mountPath,
          mountType: entry.type,
          strategyType: entry.mountStrategy?.type,
        },
      );
    }
    buildCloudflareBucketMountConfig(entry);
  }
}

async function cloudflareMountError(args: {
  response: Response;
  message: string;
  mountPath: string;
  bucket?: string;
}): Promise<SandboxMountError> {
  const payload = (await args.response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  return new SandboxMountError(args.message, {
    provider: 'cloudflare',
    mountPath: args.mountPath,
    ...(args.bucket ? { bucket: args.bucket } : {}),
    status: args.response.status,
    reason:
      typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${args.response.status}`,
  });
}

function cloudflareProviderHttpError(
  operation: string,
  response: Response,
  context: Record<string, unknown> = {},
): SandboxProviderError {
  return new SandboxProviderError(
    `CloudflareSandboxClient failed to ${operation}.`,
    {
      provider: 'cloudflare',
      operation,
      status: response.status,
      ...context,
    },
  );
}

function waitForCloudflarePtyReady(socket: PtyWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    let removeMessage = () => {};
    let removeClose = () => {};
    let removeError = () => {};
    const timer = setTimeout(() => {
      cleanup();
      reject(new UserError('CloudflareSandboxClient PTY ready timed out.'));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      removeMessage();
      removeClose();
      removeError();
    };
    removeMessage = addPtyWebSocketListener(socket, 'message', (event) => {
      const payload = parseCloudflarePtyControlPayload(event);
      if (isRecord(payload)) {
        if (payload.type === 'ready') {
          cleanup();
          resolve();
          return;
        }
        if (payload.type === 'error') {
          cleanup();
          reject(new UserError(cloudflarePtyReadyErrorMessage(payload)));
        }
      }
    });
    removeClose = addPtyWebSocketListener(socket, 'close', () => {
      cleanup();
      reject(
        new UserError(
          'CloudflareSandboxClient PTY WebSocket closed before ready.',
        ),
      );
    });
    removeError = addPtyWebSocketListener(socket, 'error', () => {
      cleanup();
      reject(new UserError('CloudflareSandboxClient PTY WebSocket failed.'));
    });
  });
}

function cloudflarePtyReadyErrorMessage(
  payload: Record<string, unknown>,
): string {
  const message = payload.message;
  return typeof message === 'string' && message.length > 0
    ? `CloudflareSandboxClient PTY failed before ready: ${message}`
    : 'CloudflareSandboxClient PTY failed before ready.';
}

function handleCloudflarePtyMessage(
  entry: PtyProcessEntry,
  event: unknown,
): void {
  const payload = parseCloudflarePtyControlPayload(event);
  if (isRecord(payload)) {
    if (payload.type === 'ready') {
      return;
    }
    if (payload.type === 'exit') {
      markPtyDone(
        entry,
        typeof payload.code === 'number' ? payload.code : null,
      );
      return;
    }
    if (payload.type === 'error') {
      const message = payload.message;
      if (typeof message === 'string') {
        appendPtyOutput(entry, message);
      }
      if (!entry.done) {
        markPtyDone(entry, 1);
      }
      return;
    }
  }

  const data = webSocketEventData(event);
  if (typeof data === 'string') {
    appendPtyOutput(entry, data);
    return;
  }
  if (data instanceof ArrayBuffer) {
    appendPtyOutput(entry, data);
    return;
  }
  if (ArrayBuffer.isView(data)) {
    appendPtyOutput(
      entry,
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
}

function parseCloudflarePtyControlPayload(event: unknown): unknown {
  const text = webSocketEventText(event);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseSseEvent(chunk: string): { event: string; data: string } | null {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  let event = 'message';
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trim());
    }
  }
  return {
    event,
    data: data.join('\n'),
  };
}

function splitCompleteSseEvents(buffer: string): {
  events: string[];
  remaining: string;
} {
  const events: string[] = [];
  const delimiterPattern = /\r\n\r\n|\n\n|\r\r/gu;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = delimiterPattern.exec(buffer))) {
    events.push(buffer.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return {
    events,
    remaining: buffer.slice(start),
  };
}

function collectSseEvents(text: string): string[] {
  const { events, remaining } = splitCompleteSseEvents(text);
  if (remaining.trim().length > 0) {
    events.push(remaining);
  }
  return events;
}

function decodeBase64Text(value: string): string {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

const STREAMED_PAYLOAD_SSE_SNIFF_BYTES = 256;

function decodeStreamedPayload(
  body: Uint8Array,
  headers?: Headers,
): Uint8Array {
  if (!shouldParseStreamedPayloadAsSse(body, headers)) {
    return body;
  }

  const text = new TextDecoder().decode(body);
  if (!startsWithSseFrame(text)) {
    return body;
  }
  const events = collectSseEvents(text);
  const chunkData: string[] = [];
  let isBinary = false;

  for (const rawEvent of events) {
    const event = parseSseEvent(rawEvent);
    if (!event) {
      continue;
    }
    if (event.event === 'metadata') {
      try {
        const payload = JSON.parse(event.data) as { isBinary?: boolean };
        isBinary = Boolean(payload.isBinary);
      } catch {
        // Ignore malformed metadata and fall back to treating the payload as text.
      }
      continue;
    }
    if (event.event === 'chunk') {
      chunkData.push(event.data);
    }
  }

  if (!isBinary || chunkData.length === 0) {
    return body;
  }

  let chunks: Uint8Array[];
  try {
    chunks = chunkData.map((data) => decodeBase64Bytes(data));
  } catch (error) {
    throw new SandboxProviderError(
      'CloudflareSandboxClient received an invalid binary stream payload.',
      {
        provider: 'cloudflare',
        operation: 'decode streamed payload',
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function shouldParseStreamedPayloadAsSse(
  body: Uint8Array,
  headers?: Headers,
): boolean {
  const contentType = headers?.get('Content-Type')?.toLowerCase() ?? '';
  if (contentType.split(';', 1)[0]?.trim() === 'text/event-stream') {
    return true;
  }
  const prefix = body.subarray(
    0,
    Math.min(body.byteLength, STREAMED_PAYLOAD_SSE_SNIFF_BYTES),
  );
  return startsWithSseFrame(new TextDecoder().decode(prefix));
}

function startsWithSseFrame(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(':') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('event:') ||
    trimmed.startsWith('id:') ||
    trimmed.startsWith('retry:')
  );
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/gu, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function webSocketEventData(event: unknown): unknown {
  return event && typeof event === 'object' && 'data' in event
    ? (event as { data?: unknown }).data
    : event;
}

function webSocketEventText(event: unknown): string | undefined {
  const data = webSocketEventData(event);
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return undefined;
}
