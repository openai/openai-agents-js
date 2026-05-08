import { UserError } from '../../errors';
import type {
  ApplyPatchOperation,
  ApplyPatchResult,
  Editor,
} from '../../editor';
import type { ToolOutputImage } from '../../tool';
import { applyDiff } from '../../utils/applyDiff';
import {
  SandboxConfigurationError,
  SandboxMountError,
  SandboxUnsupportedFeatureError,
} from '../errors';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type AzureBlobMount,
  type BoxMount,
  type Entry,
  type FuseMountPattern,
  type GCSMount,
  type Mount,
  type MountPattern,
  type MountpointMountPattern,
  type R2Mount,
  type RcloneMountPattern,
  type S3FilesMount,
  type S3FilesMountPattern,
  type S3Mount,
  type TypedMount,
  isMount,
} from '../entries';
import type {
  SandboxClient,
  SandboxClientOptions,
  SandboxClientCreateArgs,
  SandboxConcurrencyLimits,
} from '../client';
import { normalizeSandboxClientCreateArgs } from '../client';
import { Manifest } from '../manifest';
import {
  WorkspacePathPolicy,
  type ResolveSandboxPathOptions,
} from '../workspacePaths';
import {
  getRecordedExposedPortEndpoint,
  normalizeExposedPort,
  recordExposedPortEndpoint,
  type ExposedPortEndpoint,
  type ListDirectoryArgs,
  type MaterializeEntryArgs,
  type ReadFileArgs,
  type SandboxDirectoryEntry,
  type ViewImageArgs,
} from '../session';
import type { LocalSandboxSnapshotSpec } from './types';
import {
  UnixLocalSandboxSession,
  type UnixLocalSandboxSessionState,
} from './unixLocal';
import {
  assertLocalWorkspaceManifestMetadataSupported,
  joinSandboxLogicalPath,
  materializeLocalWorkspaceManifest,
  materializeLocalWorkspaceManifestEntry,
  materializeLocalWorkspaceManifestMounts,
  pathExists,
} from './shared/localWorkspace';
import {
  mergeManifestEntryDelta,
  mergeManifestDelta,
  sanitizeEnvironmentForPersistence,
  serializeManifest,
} from './shared/manifestPersistence';
import { imageOutputFromBytes } from '../shared/media';
import {
  canReuseLocalSnapshotWorkspace,
  localSnapshotIsRestorable,
  persistLocalSnapshot,
  restoreLocalSnapshotToWorkspace,
  serializeLocalSnapshotSpec,
} from './shared/localSnapshots';
import { spawnInPseudoTerminal } from './shared/pty';
import {
  formatSandboxProcessError,
  runSandboxProcess,
  type SandboxProcessResult,
} from './shared/runProcess';
import { resolveFallbackShellCommand } from './shared/shellCommand';
import { shellQuote } from '../shared/shell';
import {
  deserializeLocalSandboxSessionStateValues,
  normalizeExposedPorts,
} from './shared/sessionStateValues';
import {
  readOptionalString,
  readString,
  readStringArray,
} from '../shared/typeGuards';

const DEFAULT_DOCKER_IMAGE = 'python:3.14-slim';
const DEFAULT_CONTAINER_COMMAND =
  'trap "exit 0" TERM INT; while true; do sleep 3600; done';
const DOCKER_FAST_COMMAND_TIMEOUT_MS = 10_000;
const DOCKER_CONTAINER_START_TIMEOUT_MS = 2 * 60_000;
const DOCKER_CONTAINER_REMOVE_TIMEOUT_MS = 30_000;

export interface DockerSandboxClientOptions extends SandboxClientOptions {
  image?: string;
  exposedPorts?: number[];
  workspaceBaseDir?: string;
  snapshot?: LocalSandboxSnapshotSpec;
  concurrencyLimits?: SandboxConcurrencyLimits;
}

export interface DockerSandboxSessionState extends UnixLocalSandboxSessionState {
  containerId: string;
  image: string;
  defaultUser?: string;
  configuredExposedPorts?: number[];
  dockerVolumeNames?: string[];
  snapshotExcludedPaths?: string[];
}

export class DockerSandboxSession extends UnixLocalSandboxSession<DockerSandboxSessionState> {
  private containerClosed = false;

  override async resolveFilesystemRunAs(runAs?: string): Promise<undefined> {
    if (runAs && runAs.trim().length > 0) {
      throw new UserError(
        'DockerSandboxClient does not support runAs for filesystem operations.',
      );
    }
    return undefined;
  }

  override createEditor(runAs?: string): Editor {
    if (!runAs) {
      return super.createEditor();
    }
    return new DockerSandboxEditor(this, runAs);
  }

  override async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    if (!args.runAs) {
      return await super.viewImage(args);
    }
    const bytes = await this.readDockerFileAs(
      this.resolveContainerFilesystemPath(args.path),
      args.runAs,
    );
    return imageOutputFromBytes(args.path, bytes);
  }

  override async pathExists(path: string, runAs?: string): Promise<boolean> {
    if (!runAs && !this.pathRequiresDockerFilesystem(path)) {
      return await super.pathExists(path);
    }
    const result = await this.runDockerFilesystemCommand(
      `test -e ${shellQuote(this.resolveContainerFilesystemPath(path))}`,
      { runAs },
    );
    return result.status === 0;
  }

  override async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    if (!args.runAs && !this.pathRequiresDockerFilesystem(args.path)) {
      return await super.readFile(args);
    }
    const bytes = await this.readDockerFileAs(
      this.resolveContainerFilesystemPath(args.path),
      args.runAs,
    );
    if (typeof args.maxBytes === 'number' && bytes.byteLength > args.maxBytes) {
      return bytes.subarray(0, args.maxBytes);
    }
    return bytes;
  }

  override async listDir(
    args: ListDirectoryArgs,
  ): Promise<SandboxDirectoryEntry[]> {
    if (!args.runAs && !this.pathRequiresDockerFilesystem(args.path)) {
      return await super.listDir(args);
    }
    const absolutePath = this.resolveContainerFilesystemPath(args.path);
    const output = await this.runCheckedDockerFilesystemCommand(
      [
        `find ${shellQuote(absolutePath)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n'`,
      ].join(' && '),
      { runAs: args.runAs },
      `list directory ${absolutePath}`,
    );
    const logicalPath = this.resolveLogicalPath(args.path);
    return output
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const separator = line.indexOf('\t');
        const kind = separator >= 0 ? line.slice(0, separator) : '';
        const name = separator >= 0 ? line.slice(separator + 1) : line;
        return {
          name,
          path: logicalPath ? `${logicalPath}/${name}` : name,
          type: kind === 'd' ? 'dir' : kind === 'f' ? 'file' : 'other',
        };
      });
  }

  private pathRequiresDockerFilesystem(path?: string): boolean {
    return Boolean(
      dockerInContainerMountContainingPath(this.state.manifest, path),
    );
  }

  override async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    if (isMount(args.entry) && isDockerInContainerMount(args.entry)) {
      const logicalPath = this.resolveLogicalPath(args.path);
      assertDockerCanApplyInContainerMounts(
        this.state.manifest,
        new Manifest({
          entries: {
            [logicalPath]: args.entry,
          },
        }),
      );
      assertLocalWorkspaceManifestMetadataSupported(
        'DockerSandboxClient',
        new Manifest({
          entries: {
            [logicalPath]: args.entry,
          },
        }),
        {
          allowLocalBindMounts: false,
          allowIdentityMetadata: true,
          supportsMount: isSupportedDockerApplyMount,
        },
      );
      await materializeDockerMountPoint(
        this.state.workspaceRootPath,
        this.state.manifest.root,
        logicalPath,
        args.entry,
      );
      if (args.runAs) {
        const mountPath = resolveDockerMountPath(
          this.state.manifest.root,
          logicalPath,
          args.entry,
        );
        await this.mkdirDockerPathAs(mountPath, 'root');
        await this.chownContainerPath(mountPath, args.runAs);
      }
      await applyDockerInContainerMount(this, logicalPath, args.entry);
      this.state.manifest = mergeManifestEntryDelta(
        this.state.manifest,
        logicalPath,
        args.entry,
      );
      return;
    }

    if (!args.runAs) {
      await super.materializeEntry(args);
      return;
    }
    const logicalPath = this.resolveLogicalPath(args.path);
    assertLocalWorkspaceManifestMetadataSupported(
      'DockerSandboxClient',
      new Manifest({
        entries: {
          [logicalPath]: args.entry,
        },
      }),
      {
        allowLocalBindMounts: false,
        allowIdentityMetadata: true,
        supportsMount: isSupportedDockerApplyMount,
      },
    );
    await materializeLocalWorkspaceManifestEntry(
      this.state.workspaceRootPath,
      logicalPath,
      args.entry,
      {
        localSourceGrants: this.state.manifest.extraPathGrants,
      },
    );
    await this.chownContainerPath(
      this.resolveContainerFilesystemPath(args.path),
      args.runAs,
    );
    this.state.manifest = mergeManifestEntryDelta(
      this.state.manifest,
      logicalPath,
      args.entry,
    );
  }

  override async applyManifest(
    manifest: Manifest,
    runAs?: string,
  ): Promise<void> {
    assertDockerManifestDeltaSupported(manifest);
    assertDockerCanApplyInContainerMounts(this.state.manifest, manifest);
    const environment = await manifest.resolveEnvironment();
    const previousEnvironment = this.state.environment;
    const nextEnvironment = {
      ...this.state.environment,
      ...environment,
    };
    this.state.environment = nextEnvironment;
    try {
      await provisionDockerAccounts(this.state.containerId, manifest);
      const materializedManifest = stripDockerIdentityMetadata(manifest);
      await materializeLocalWorkspaceManifest(
        materializedManifest,
        this.state.workspaceRootPath,
        {
          allowLocalBindMounts: false,
          allowIdentityMetadata: true,
          supportsMount: isSupportedDockerApplyMount,
          materializeMount: async ({ logicalPath, entry }) => {
            await materializeDockerMountPoint(
              this.state.workspaceRootPath,
              this.state.manifest.root,
              logicalPath,
              entry,
            );
          },
        },
      );
      if (runAs) {
        for (const [path, entry] of Object.entries(manifest.entries)) {
          if (isMount(entry)) {
            const mountPath = resolveDockerMountPath(
              this.state.manifest.root,
              path,
              entry,
            );
            await this.mkdirDockerPathAs(mountPath, 'root');
            await this.chownContainerPath(mountPath, runAs);
          } else {
            await this.chownContainerPath(
              this.resolveContainerFilesystemPath(path),
              runAs,
            );
          }
        }
      }
      await applyDockerInContainerMounts(this, manifest);
      this.state.manifest = mergeDockerIdentityMetadata(
        mergeManifestDelta(this.state.manifest, materializedManifest),
        manifest,
      );
    } catch (error) {
      this.state.environment = previousEnvironment;
      throw error;
    }
  }

  override async resolveExposedPort(
    port: number,
  ): Promise<ExposedPortEndpoint> {
    const containerPort = normalizeExposedPort(port);
    const configuredPorts = this.state.configuredExposedPorts ?? [];
    if (
      configuredPorts.length > 0 &&
      !configuredPorts.includes(containerPort)
    ) {
      throw new SandboxConfigurationError(
        `DockerSandboxClient was not configured to expose port ${containerPort}.`,
        {
          provider: 'DockerSandboxClient',
          port: containerPort,
          configuredPorts,
        },
      );
    }

    const recorded = getRecordedExposedPortEndpoint(this.state, containerPort);
    if (recorded) {
      return recorded;
    }

    const result = await runSandboxProcess(
      'docker',
      ['port', this.state.containerId, `${containerPort}/tcp`],
      {
        timeoutMs: DOCKER_FAST_COMMAND_TIMEOUT_MS,
      },
    );
    if (result.status !== 0) {
      throw new UserError(
        `Failed to resolve Docker exposed port ${containerPort}: ${formatSandboxProcessError(result)}`,
      );
    }

    return recordExposedPortEndpoint(
      this.state,
      {
        ...parseDockerPortBinding(result.stdout, containerPort),
        tls: false,
      },
      containerPort,
    );
  }

  protected override resolveCommandWorkdir(path?: string): string {
    const logicalPath = this.resolveLogicalPath(path);
    return joinSandboxLogicalPath(this.state.manifest.root, logicalPath);
  }

  protected override async spawnShellCommand(
    command: string,
    args: {
      cwd: string;
      logicalCwd: string;
      shell?: string;
      login: boolean;
      runAs?: string;
      tty?: boolean;
    },
  ): Promise<ChildProcessWithoutNullStreams> {
    const { shellPath, flag } = resolveFallbackShellCommand({
      shell: args.shell,
      defaultShell: this.defaultShell,
      login: args.login,
    });
    const dockerArgs = ['exec', '-i', '-w', args.cwd];
    if (args.tty) {
      dockerArgs.splice(2, 0, '-t');
    }
    for (const [key, value] of Object.entries(this.state.environment)) {
      dockerArgs.push('-e', `${key}=${value}`);
    }
    const runAs = args.runAs ?? this.state.defaultUser;
    if (runAs) {
      dockerArgs.push('-u', runAs);
    }
    dockerArgs.push(this.state.containerId, shellPath, flag, command);

    if (args.tty) {
      return spawnInPseudoTerminal('docker', dockerArgs);
    }

    return spawn('docker', dockerArgs, {
      stdio: 'pipe',
    });
  }

  protected override translateCommandInput(command: string): string {
    return command;
  }

  protected override translateCommandOutput(output: string): string {
    return output;
  }

  protected override async materializeRestoredWorkspaceMounts(): Promise<void> {
    await prepareDockerWorkspaceRoot(
      this.state.workspaceRootPath,
      this.state.manifest,
    );
    await materializeLocalWorkspaceManifestMounts(
      this.state.manifest,
      this.state.workspaceRootPath,
      {
        allowLocalBindMounts: false,
        allowIdentityMetadata: true,
        supportsMount: isSupportedDockerCreateMount,
        materializeMount: async ({ logicalPath, entry }) => {
          await materializeDockerMountPoint(
            this.state.workspaceRootPath,
            this.state.manifest.root,
            logicalPath,
            entry,
          );
        },
      },
    );
    await applyDockerInContainerMounts(this, this.state.manifest);
  }

  override resolveSandboxPath(
    path?: string,
    options: ResolveSandboxPathOptions = {},
  ): string {
    const mountPath = dockerVolumeMountContainingPath(
      this.state.manifest,
      path,
    );
    if (mountPath) {
      throw new UserError(
        `DockerSandboxClient filesystem operations cannot access Docker volume mount path "${path ?? mountPath}". Use execCommand for container-visible paths under "${mountPath}".`,
      );
    }
    const inContainerMountPath = dockerInContainerMountContainingPath(
      this.state.manifest,
      path,
    );
    if (inContainerMountPath) {
      throw new UserError(
        `DockerSandboxClient host filesystem operations cannot access in-container mount path "${path ?? inContainerMountPath}". Use execCommand for container-visible paths under "${inContainerMountPath}".`,
      );
    }
    return super.resolveSandboxPath(path, options);
  }

  resolveContainerFilesystemPath(
    path?: string,
    options: ResolveSandboxPathOptions = {},
  ): string {
    const resolved = new WorkspacePathPolicy({
      root: this.state.manifest.root,
      extraPathGrants: this.state.manifest.extraPathGrants,
    }).resolve(path, options);
    return resolved.path;
  }

  async readDockerFileAs(path: string, runAs?: string): Promise<Uint8Array> {
    const output = await this.runCheckedDockerFilesystemCommand(
      `base64 -- ${shellQuote(path)}`,
      { runAs },
      `read file ${path}`,
    );
    return Buffer.from(output.replace(/\s+/gu, ''), 'base64');
  }

  async writeDockerTextFileAs(
    path: string,
    content: string,
    runAs: string,
  ): Promise<void> {
    const parent = dockerPosixDirname(path);
    await this.runCheckedDockerFilesystemCommand(
      parent === '/' || parent === '.'
        ? `cat > ${shellQuote(path)}`
        : `mkdir -p -- ${shellQuote(parent)} && cat > ${shellQuote(path)}`,
      { runAs, input: content },
      `write file ${path}`,
    );
  }

  async deleteDockerPathAs(path: string, runAs: string): Promise<void> {
    await this.runCheckedDockerFilesystemCommand(
      `rm -f -- ${shellQuote(path)}`,
      { runAs },
      `delete path ${path}`,
    );
  }

  async mkdirDockerPathAs(path: string, runAs: string): Promise<void> {
    await this.runCheckedDockerFilesystemCommand(
      `mkdir -p -- ${shellQuote(path)}`,
      { runAs },
      `create directory ${path}`,
    );
  }

  async runDockerMountCommand(
    command: string,
    action: string,
    options: { input?: string | Uint8Array } = {},
  ): Promise<string> {
    return await this.runCheckedDockerFilesystemCommand(
      command,
      { runAs: 'root', input: options.input },
      action,
    );
  }

  private async chownContainerPath(path: string, runAs: string): Promise<void> {
    await this.runCheckedDockerFilesystemCommand(
      `chown -R ${shellQuote(runAs)}:${shellQuote(runAs)} -- ${shellQuote(path)}`,
      { runAs: 'root' },
      `set ownership on ${path}`,
    );
  }

  private async runCheckedDockerFilesystemCommand(
    command: string,
    options: { runAs?: string; input?: string | Uint8Array } = {},
    action: string,
  ): Promise<string> {
    const result = await this.runDockerFilesystemCommand(command, options);
    if (result.status !== 0) {
      throw new UserError(
        `DockerSandboxClient failed to ${action}: ${formatSandboxProcessError(result)}`,
      );
    }
    return result.stdout;
  }

  private async runDockerFilesystemCommand(
    command: string,
    options: { runAs?: string; input?: string | Uint8Array } = {},
  ): Promise<SandboxProcessResult> {
    const dockerArgs = ['exec', '-i', '-w', '/'];
    for (const [key, value] of Object.entries(this.state.environment)) {
      dockerArgs.push('-e', `${key}=${value}`);
    }
    const runAs = options.runAs ?? this.state.defaultUser;
    if (runAs) {
      dockerArgs.push('-u', runAs);
    }
    dockerArgs.push(this.state.containerId, '/bin/sh', '-lc', command);

    return await runDockerProcess(dockerArgs, options.input);
  }

  override async close(): Promise<void> {
    let cleanupError: unknown;
    if (!this.containerClosed) {
      try {
        await removeDockerContainer(this.state.containerId, {
          ignoreMissing: true,
        });
        this.containerClosed = true;
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await removeDockerVolumes(this.state.dockerVolumeNames ?? []);
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await super.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

class DockerSandboxEditor implements Editor {
  constructor(
    private readonly session: DockerSandboxSession,
    private readonly runAs: string,
  ) {}

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult> {
    const path = this.session.resolveContainerFilesystemPath(operation.path, {
      forWrite: true,
    });
    if (await this.session.pathExists(operation.path, this.runAs)) {
      throw new UserError(
        `Cannot create file because it already exists: ${path}`,
      );
    }
    const content = applyDiff('', operation.diff, 'create');
    const parent = dockerPosixDirname(path);
    if (parent !== '.' && parent !== '/') {
      await this.session.mkdirDockerPathAs(parent, this.runAs);
    }
    await this.session.writeDockerTextFileAs(path, content, this.runAs);
    return {};
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult> {
    const path = this.session.resolveContainerFilesystemPath(operation.path, {
      forWrite: true,
    });
    const destination = operation.moveTo
      ? this.session.resolveContainerFilesystemPath(operation.moveTo, {
          forWrite: true,
        })
      : path;
    const current = new TextDecoder().decode(
      await this.session.readDockerFileAs(path, this.runAs),
    );
    const next = applyDiff(current, operation.diff);
    const parent = dockerPosixDirname(destination);
    if (parent !== '.' && parent !== '/') {
      await this.session.mkdirDockerPathAs(parent, this.runAs);
    }
    await this.session.writeDockerTextFileAs(destination, next, this.runAs);
    if (operation.moveTo && destination !== path) {
      await this.session.deleteDockerPathAs(path, this.runAs);
    }
    return {};
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult> {
    await this.session.deleteDockerPathAs(
      this.session.resolveContainerFilesystemPath(operation.path, {
        forWrite: true,
      }),
      this.runAs,
    );
    return {};
  }
}

export class DockerSandboxClient implements SandboxClient<
  DockerSandboxClientOptions,
  DockerSandboxSessionState
> {
  readonly backendId = 'docker';
  readonly supportsDefaultOptions = true;
  private readonly options: DockerSandboxClientOptions;

  constructor(options: DockerSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<DockerSandboxClientOptions> | Manifest,
    manifestOptions?: DockerSandboxClientOptions,
  ): Promise<DockerSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    const manifest = createArgs.manifest;
    assertDockerManifestSupported(manifest);
    await ensureDockerAvailable();
    const resolvedOptions = {
      ...this.options,
      ...createArgs.options,
      ...(createArgs.snapshot
        ? { snapshot: createArgs.snapshot as LocalSandboxSnapshotSpec }
        : {}),
      ...(createArgs.concurrencyLimits
        ? { concurrencyLimits: createArgs.concurrencyLimits }
        : {}),
    };
    const workspaceRootPath = await mkdtemp(
      join(
        resolvedOptions.workspaceBaseDir ?? tmpdir(),
        'openai-agents-docker-sandbox-',
      ),
    );

    await materializeLocalWorkspaceManifest(manifest, workspaceRootPath, {
      concurrencyLimits: resolvedOptions.concurrencyLimits,
      allowLocalBindMounts: false,
      allowIdentityMetadata: true,
      supportsMount: isSupportedDockerCreateMount,
      materializeMount: async ({ logicalPath, entry }) => {
        await materializeDockerMountPoint(
          workspaceRootPath,
          manifest.root,
          logicalPath,
          entry,
        );
      },
    });
    await prepareDockerWorkspaceRoot(workspaceRootPath, manifest);
    const image = resolvedOptions.image ?? DEFAULT_DOCKER_IMAGE;
    const environment = await manifest.resolveEnvironment();
    const defaultUser = getHostDockerUser();
    const configuredExposedPorts = normalizeExposedPorts(
      resolvedOptions.exposedPorts,
    );
    const container = await startDockerContainer({
      image,
      manifest,
      manifestRoot: manifest.root,
      workspaceRootPath,
      environment,
      defaultUser,
      exposedPorts: configuredExposedPorts,
    });
    const session = new DockerSandboxSession({
      state: {
        manifest,
        workspaceRootPath,
        workspaceRootOwned: true,
        environment,
        snapshotSpec: resolvedOptions.snapshot ?? null,
        snapshot: null,
        image,
        containerId: container.containerId,
        defaultUser,
        configuredExposedPorts,
        dockerVolumeNames: container.volumeNames,
      },
    });
    try {
      await provisionDockerAccounts(container.containerId, manifest);
      await applyDockerInContainerMounts(session, manifest);
    } catch (error) {
      await cleanupStartedDockerContainer({
        containerId: container.containerId,
        volumeNames: container.volumeNames,
        workspaceRootPath,
        removeWorkspace: true,
      });
      throw error;
    }

    return session;
  }

  async resume(
    state: DockerSandboxSessionState,
  ): Promise<DockerSandboxSession> {
    assertDockerManifestSupported(state.manifest);
    await ensureDockerAvailable();
    const restoredState = await this.restoreIfNeeded(state);

    return new DockerSandboxSession({
      state: restoredState,
    });
  }

  async serializeSessionState(
    state: DockerSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    const snapshotSpec = state.snapshotSpec ?? this.options.snapshot ?? null;
    attachDockerSnapshotExcludedPaths(state);
    const snapshot = await persistLocalSnapshot(
      'DockerSandboxClient',
      state,
      snapshotSpec,
    );
    state.snapshotSpec = snapshotSpec;

    return {
      manifest: serializeManifest(state.manifest),
      workspaceRootPath: state.workspaceRootPath,
      workspaceRootOwned: state.workspaceRootOwned,
      environment: sanitizeEnvironmentForPersistence(state),
      snapshotSpec: serializeLocalSnapshotSpec(snapshotSpec),
      snapshot,
      snapshotFingerprint: state.snapshotFingerprint ?? null,
      snapshotFingerprintVersion: state.snapshotFingerprintVersion ?? null,
      image: state.image,
      containerId: state.containerId,
      defaultUser: state.defaultUser,
      configuredExposedPorts: state.configuredExposedPorts ?? [],
      dockerVolumeNames: state.dockerVolumeNames ?? [],
      exposedPorts: state.exposedPorts ?? null,
    };
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<DockerSandboxSessionState> {
    const baseState = deserializeLocalSandboxSessionStateValues(
      state,
      this.options.snapshot,
    );
    return {
      ...baseState,
      image: readString(state, 'image'),
      containerId: readString(state, 'containerId'),
      defaultUser:
        readOptionalString(state, 'defaultUser') ?? getHostDockerUser(),
      dockerVolumeNames: readStringArray(state.dockerVolumeNames),
    };
  }

  private async restoreIfNeeded(
    state: DockerSandboxSessionState,
  ): Promise<DockerSandboxSessionState> {
    attachDockerSnapshotExcludedPaths(state);
    const containerRunning = await inspectContainerRunning(state.containerId);
    const workspaceExists = await pathExists(state.workspaceRootPath);

    if (workspaceExists) {
      if (containerRunning) {
        return state;
      }
      if (await canReuseLocalSnapshotWorkspace(state)) {
        await this.cleanupDockerResources(state);
        return await this.restartContainer(state, state.workspaceRootPath);
      }
      if (await localSnapshotIsRestorable(state)) {
        const restoredState = await restoreLocalSnapshotToWorkspace(
          state,
          state.workspaceRootPath,
        );
        await this.cleanupDockerResources(state);
        return await this.restartContainer(
          restoredState,
          restoredState.workspaceRootPath,
        );
      }
    }

    if (!(await localSnapshotIsRestorable(state))) {
      throw new UserError(
        'Docker sandbox resources are unavailable and no local snapshot could be restored.',
      );
    }
    await this.cleanupDockerResources(state);

    const workspaceRootPath = await mkdtemp(
      join(
        this.options.workspaceBaseDir ?? tmpdir(),
        'openai-agents-docker-sandbox-',
      ),
    );
    const restoredState = await restoreLocalSnapshotToWorkspace(
      {
        ...state,
        workspaceRootPath,
        workspaceRootOwned: true,
      },
      workspaceRootPath,
    );

    return await this.restartContainer(restoredState, workspaceRootPath);
  }

  private async cleanupDockerResources(
    state: DockerSandboxSessionState,
  ): Promise<void> {
    await removeDockerContainer(state.containerId, { ignoreMissing: true });
    await removeDockerVolumes(state.dockerVolumeNames ?? []);
  }

  private async restartContainer(
    state: DockerSandboxSessionState,
    workspaceRootPath: string,
  ): Promise<DockerSandboxSessionState> {
    await materializeLocalWorkspaceManifestMounts(
      state.manifest,
      workspaceRootPath,
      {
        allowLocalBindMounts: false,
        allowIdentityMetadata: true,
        supportsMount: isSupportedDockerCreateMount,
        materializeMount: async ({ logicalPath, entry }) => {
          await materializeDockerMountPoint(
            workspaceRootPath,
            state.manifest.root,
            logicalPath,
            entry,
          );
        },
      },
    );
    await prepareDockerWorkspaceRoot(workspaceRootPath, state.manifest);
    const container = await startDockerContainer({
      image: state.image,
      manifest: state.manifest,
      manifestRoot: state.manifest.root,
      workspaceRootPath,
      environment: state.environment,
      defaultUser: state.defaultUser,
      exposedPorts: state.configuredExposedPorts,
    });
    const nextState = {
      ...state,
      workspaceRootPath,
      containerId: container.containerId,
      dockerVolumeNames: container.volumeNames,
      exposedPorts: undefined,
    };
    const session = new DockerSandboxSession({ state: nextState });
    try {
      await provisionDockerAccounts(container.containerId, state.manifest);
      await applyDockerInContainerMounts(session, state.manifest);
    } catch (error) {
      await cleanupStartedDockerContainer({
        containerId: container.containerId,
        volumeNames: container.volumeNames,
        workspaceRootPath,
        removeWorkspace: false,
      });
      throw error;
    }
    return nextState;
  }
}

async function cleanupStartedDockerContainer(args: {
  containerId: string;
  volumeNames: string[];
  workspaceRootPath: string;
  removeWorkspace: boolean;
}): Promise<void> {
  await removeDockerContainer(args.containerId, { ignoreMissing: true }).catch(
    () => undefined,
  );
  await removeDockerVolumes(args.volumeNames);
  if (args.removeWorkspace) {
    await rm(args.workspaceRootPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function assertDockerManifestSupported(manifest: Manifest): void {
  assertDockerManifestRootSupported(manifest);
  assertLocalWorkspaceManifestMetadataSupported(
    'DockerSandboxClient',
    manifest,
    {
      allowLocalBindMounts: false,
      allowIdentityMetadata: true,
      supportsMount: isSupportedDockerCreateMount,
    },
  );
}

function assertDockerManifestDeltaSupported(manifest: Manifest): void {
  assertLocalWorkspaceManifestMetadataSupported(
    'DockerSandboxClient',
    manifest,
    {
      allowLocalBindMounts: false,
      allowIdentityMetadata: true,
      supportsMount: isSupportedDockerApplyMount,
    },
  );
}

function assertDockerManifestRootSupported(manifest: Manifest): void {
  // Docker maps the host workspace as a bind mount at manifest.root; mounting it
  // over "/" would hide the image filesystem rather than emulate root confinement.
  if (manifest.root === '/') {
    throw new UserError(
      'DockerSandboxClient does not support manifest root "/".',
    );
  }
}

async function prepareDockerWorkspaceRoot(
  workspaceRootPath: string,
  manifest: Manifest,
): Promise<void> {
  if (manifest.users.length === 0 && manifest.groups.length === 0) {
    return;
  }
  await chmod(workspaceRootPath, 0o755);
}

async function provisionDockerAccounts(
  containerId: string,
  manifest: Manifest,
): Promise<void> {
  for (const command of dockerAccountProvisionCommands(manifest)) {
    const result = await runSandboxProcess(
      'docker',
      ['exec', '-u', 'root', containerId, '/bin/sh', '-c', command],
      {
        timeoutMs: DOCKER_FAST_COMMAND_TIMEOUT_MS,
      },
    );
    if (result.status !== 0) {
      throw new UserError(
        `Failed to provision Docker sandbox manifest accounts: ${formatSandboxProcessError(result)}`,
      );
    }
  }
}

function dockerAccountProvisionCommands(manifest: Manifest): string[] {
  const commands: string[] = [];
  const users = new Set(manifest.users.map((user) => user.name));
  for (const group of manifest.groups) {
    commands.push(
      `getent group ${shellQuote(group.name)} >/dev/null 2>&1 || groupadd ${shellQuote(group.name)}`,
    );
    for (const user of group.users ?? []) {
      users.add(user.name);
    }
  }

  for (const user of users) {
    const quotedUser = shellQuote(user);
    commands.push(
      [
        `if id -u ${quotedUser} >/dev/null 2>&1; then exit 0; fi`,
        `if getent group ${quotedUser} >/dev/null 2>&1; then useradd -M -s /usr/sbin/nologin -g ${quotedUser} ${quotedUser}; else useradd -U -M -s /usr/sbin/nologin ${quotedUser}; fi`,
      ].join('; '),
    );
  }

  for (const group of manifest.groups) {
    for (const user of group.users ?? []) {
      commands.push(
        `usermod -aG ${shellQuote(group.name)} ${shellQuote(user.name)}`,
      );
    }
  }

  return commands;
}

function stripDockerIdentityMetadata(manifest: Manifest): Manifest {
  return new Manifest({
    version: manifest.version,
    root: manifest.root,
    entries: manifest.entries,
    environment: Object.fromEntries(
      Object.entries(manifest.environment).map(([key, value]) => [
        key,
        value.init(),
      ]),
    ),
    extraPathGrants: manifest.extraPathGrants,
    remoteMountCommandAllowlist: manifest.remoteMountCommandAllowlist,
  });
}

function mergeDockerIdentityMetadata(
  current: Manifest,
  delta: Manifest,
): Manifest {
  return mergeManifestDelta(
    current,
    new Manifest({
      users: delta.users,
      groups: delta.groups,
    }),
  );
}

async function ensureDockerAvailable(): Promise<void> {
  const result = await runSandboxProcess('docker', ['version'], {
    timeoutMs: DOCKER_FAST_COMMAND_TIMEOUT_MS,
  });

  if (result.status !== 0) {
    throw new UserError(
      'Docker sandbox execution requires a working Docker CLI and daemon.',
    );
  }
}

async function inspectContainerRunning(containerId: string): Promise<boolean> {
  const result = await runSandboxProcess(
    'docker',
    [
      'inspect',
      '--type',
      'container',
      '--format',
      '{{.State.Running}}',
      containerId,
    ],
    {
      timeoutMs: DOCKER_FAST_COMMAND_TIMEOUT_MS,
    },
  );

  return result.status === 0 && result.stdout.trim() === 'true';
}

async function runDockerProcess(
  args: string[],
  input?: string | Uint8Array,
): Promise<SandboxProcessResult> {
  const child = spawn('docker', args, {
    stdio: 'pipe',
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const closed = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
    child.on('error', (error) => {
      stderrChunks.push(Buffer.from(error.message));
      resolve(1);
    });
  });
  if (input !== undefined) {
    child.stdin.write(input);
  }
  child.stdin.end();

  return {
    status: await closed,
    signal: null,
    timedOut: false,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  };
}

async function removeDockerContainer(
  containerId: string,
  options: { ignoreMissing?: boolean } = {},
): Promise<void> {
  const result = await runSandboxProcess('docker', ['rm', '-f', containerId], {
    timeoutMs: DOCKER_CONTAINER_REMOVE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    if (options.ignoreMissing && isMissingDockerContainerError(result)) {
      return;
    }
    throw new UserError(
      `Failed to remove Docker sandbox container: ${formatSandboxProcessError(result)}`,
    );
  }
}

function isMissingDockerContainerError(result: SandboxProcessResult): boolean {
  const message = formatSandboxProcessError(result).toLowerCase();
  return (
    message.includes('no such container') || message.includes('no such object')
  );
}

async function startDockerContainer(args: {
  image: string;
  manifest: Manifest;
  manifestRoot: string;
  workspaceRootPath: string;
  environment: Record<string, string>;
  defaultUser?: string;
  exposedPorts?: number[];
}): Promise<{ containerId: string; volumeNames: string[] }> {
  const envArgs = Object.entries(args.environment).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]);
  const userArgs = args.defaultUser ? ['--user', args.defaultUser] : [];
  const portArgs = normalizeExposedPorts(args.exposedPorts).flatMap((port) => [
    '-p',
    `127.0.0.1::${port}`,
  ]);
  const containerName = `openai-agents-sandbox-${randomUUID().slice(0, 8)}`;
  const { mountArgs, volumeNames } = dockerMountArgsForManifest(
    args.manifest,
    containerName,
  );
  const privilegeArgs = dockerInContainerMountPrivilegeArgs(args.manifest);
  const result = await runSandboxProcess(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      'openai-agents-sandbox=true',
      '-v',
      `${args.workspaceRootPath}:${args.manifestRoot}`,
      ...dockerExtraPathGrantMountArgs(args.manifest),
      ...mountArgs,
      ...privilegeArgs,
      '-w',
      args.manifestRoot,
      ...portArgs,
      ...userArgs,
      ...envArgs,
      args.image,
      '/bin/sh',
      '-c',
      DEFAULT_CONTAINER_COMMAND,
    ],
    {
      timeoutMs: DOCKER_CONTAINER_START_TIMEOUT_MS,
    },
  );

  if (result.status !== 0) {
    throw new UserError(
      `Failed to start Docker sandbox container: ${formatSandboxProcessError(result)}`,
    );
  }

  return {
    containerId: result.stdout.trim(),
    volumeNames,
  };
}

async function materializeDockerMountPoint(
  workspaceRootPath: string,
  manifestRoot: string,
  logicalPath: string,
  entry: Mount | TypedMount,
): Promise<void> {
  const relativePath = resolveDockerMountWorkspaceRelativePath(
    manifestRoot,
    logicalPath,
    entry,
  );
  if (!relativePath) {
    return;
  }
  await mkdir(resolve(workspaceRootPath, relativePath), { recursive: true });
}

function isSupportedDockerCreateMount(entry: Mount | TypedMount): boolean {
  return (
    isDockerBindMount(entry) ||
    isDockerVolumeMount(entry) ||
    isSupportedDockerInContainerMount(entry)
  );
}

function isSupportedDockerApplyMount(entry: Mount | TypedMount): boolean {
  return isSupportedDockerInContainerMount(entry);
}

function isDockerBindMount(
  entry: Mount | TypedMount,
): entry is Mount & { source: string } {
  return (
    entry.type === 'mount' &&
    typeof entry.source === 'string' &&
    isAbsolute(entry.source) &&
    (entry.mountStrategy === undefined ||
      entry.mountStrategy.type === 'local_bind')
  );
}

function isDockerVolumeMount(entry: Mount | TypedMount): boolean {
  return Boolean(dockerVolumeDriverConfig(entry));
}

function isDockerInContainerMount(
  entry: Mount | TypedMount,
): entry is Mount | TypedMount {
  return entry.mountStrategy?.type === 'in_container';
}

function isSupportedDockerInContainerMount(entry: Mount | TypedMount): boolean {
  if (!isDockerInContainerMount(entry)) {
    return false;
  }
  let pattern: MountPattern;
  try {
    pattern = dockerInContainerMountPattern(entry);
  } catch {
    return false;
  }
  switch (pattern.type) {
    case 'rclone':
      return dockerRcloneMountTypes.has(entry.type);
    case 'mountpoint':
      return entry.type === 's3_mount' || entry.type === 'gcs_mount';
    case 's3files':
      return entry.type === 's3_files_mount';
    case 'fuse':
      return entry.type === 'azure_blob_mount' || Boolean(pattern.command);
    default:
      return false;
  }
}

function assertDockerCanApplyInContainerMounts(
  currentManifest: Manifest,
  deltaManifest: Manifest,
): void {
  const currentPrivilege = dockerInContainerMountPrivilege(currentManifest);
  const requiredPrivilege = dockerInContainerMountPrivilege(deltaManifest);
  if (dockerPrivilegeSatisfies(currentPrivilege, requiredPrivilege)) {
    return;
  }
  throw new SandboxUnsupportedFeatureError(
    'DockerSandboxClient cannot add this in-container mount to an already-running container because it requires Docker privileges that were not granted at container start.',
    {
      provider: 'DockerSandboxClient',
      currentPrivilege,
      requiredPrivilege,
    },
  );
}

function dockerPrivilegeSatisfies(
  current: 'none' | 'fuse' | 'sys_admin',
  required: 'none' | 'fuse' | 'sys_admin',
): boolean {
  if (required === 'none' || current === required) {
    return true;
  }
  return current === 'fuse' && required === 'sys_admin';
}

function dockerVolumeMountContainingPath(
  manifest: Manifest,
  path?: string,
): string | undefined {
  return dockerMountContainingPath(manifest, path, isDockerVolumeMount);
}

function dockerInContainerMountContainingPath(
  manifest: Manifest,
  path?: string,
): string | undefined {
  return dockerMountContainingPath(manifest, path, isDockerInContainerMount);
}

function dockerMountContainingPath(
  manifest: Manifest,
  path: string | undefined,
  predicate: (entry: Mount | TypedMount) => boolean,
): string | undefined {
  const resolved = new WorkspacePathPolicy({
    root: manifest.root,
    extraPathGrants: manifest.extraPathGrants,
  }).resolve(path);

  for (const { entry, mountPath } of manifest.mountTargets()) {
    if (!predicate(entry)) {
      continue;
    }
    if (pathWithinDockerMount(resolved.path, mountPath)) {
      return mountPath;
    }
  }
  return undefined;
}

function pathWithinDockerMount(path: string, mountPath: string): boolean {
  if (mountPath === '/') {
    return true;
  }
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

async function applyDockerInContainerMounts(
  session: DockerSandboxSession,
  manifest: Manifest,
): Promise<void> {
  const appliedMountPaths: string[] = [];
  for (const {
    logicalPath,
    entry,
  } of manifest.mountTargetsForMaterialization()) {
    if (!isDockerInContainerMount(entry)) {
      continue;
    }
    try {
      appliedMountPaths.push(
        await applyDockerInContainerMount(session, logicalPath, entry),
      );
    } catch (error) {
      await cleanupDockerAppliedMounts(session, appliedMountPaths);
      throw error;
    }
  }
}

async function applyDockerInContainerMount(
  session: DockerSandboxSession,
  logicalPath: string,
  entry: Mount | TypedMount,
): Promise<string> {
  const mountPath = resolveDockerMountPath(
    session.state.manifest.root,
    logicalPath,
    entry,
  );
  const pattern = dockerInContainerMountPattern(entry);
  try {
    switch (pattern.type) {
      case 'rclone':
        await applyDockerRcloneMount(
          session,
          entry,
          mountPath,
          pattern as RcloneMountPattern,
        );
        return mountPath;
      case 'mountpoint':
        await applyDockerMountpointMount(
          session,
          entry,
          mountPath,
          pattern as MountpointMountPattern,
        );
        return mountPath;
      case 's3files':
        await applyDockerS3FilesMount(
          session,
          entry,
          mountPath,
          pattern as S3FilesMountPattern,
        );
        return mountPath;
      case 'fuse':
        await applyDockerFuseMount(
          session,
          entry,
          mountPath,
          pattern as FuseMountPattern,
        );
        return mountPath;
      default:
        throw new SandboxUnsupportedFeatureError(
          'DockerSandboxClient does not support this in-container mount pattern.',
          {
            provider: 'DockerSandboxClient',
            feature: 'entry.mountStrategy.pattern',
            mountType: entry.type,
            patternType: pattern.type,
          },
        );
    }
  } catch (error) {
    await cleanupDockerAppliedMounts(session, [mountPath]);
    throw error;
  }
}

async function cleanupDockerAppliedMounts(
  session: DockerSandboxSession,
  mountPaths: string[],
): Promise<void> {
  for (const mountPath of [...mountPaths].reverse()) {
    await session
      .runDockerMountCommand(
        [
          `fusermount3 -u ${shellQuote(mountPath)} >/dev/null 2>&1 || true`,
          `fusermount -u ${shellQuote(mountPath)} >/dev/null 2>&1 || true`,
          `umount ${shellQuote(mountPath)} >/dev/null 2>&1 || true`,
          `umount -l ${shellQuote(mountPath)} >/dev/null 2>&1 || true`,
          dockerSafeKillRcloneNfsPidFileCommand(
            dockerRcloneNfsPidPath(session, mountPath),
          ),
        ].join(' ; '),
        `cleanup Docker mount ${mountPath}`,
      )
      .catch(() => undefined);
  }
}

function dockerInContainerMountPattern(
  entry: Mount | TypedMount,
): MountPattern {
  const pattern = (
    entry.mountStrategy as { pattern?: MountPattern } | undefined
  )?.pattern;
  if (pattern) {
    return pattern;
  }
  if (entry.type === 's3_files_mount') {
    return { type: 's3files' } satisfies S3FilesMountPattern;
  }
  if (dockerRcloneMountTypes.has(entry.type)) {
    return { type: 'rclone', mode: 'fuse' } satisfies RcloneMountPattern;
  }
  throw new SandboxUnsupportedFeatureError(
    'DockerSandboxClient in-container mounts require a mount strategy pattern for this mount type.',
    {
      provider: 'DockerSandboxClient',
      feature: 'entry.mountStrategy.pattern',
      mountType: entry.type,
    },
  );
}

function attachDockerSnapshotExcludedPaths(
  state: DockerSandboxSessionState,
): void {
  state.snapshotExcludedPaths = dockerInternalSnapshotExcludedPaths(
    state.manifest,
  );
}

function dockerInternalSnapshotExcludedPaths(manifest: Manifest): string[] {
  const paths = new Set<string>();
  for (const { entry } of manifest.mountTargetsForMaterialization()) {
    if (!isDockerInContainerMount(entry)) {
      continue;
    }
    const pattern = dockerInContainerMountPattern(entry);
    if (entry.type === 'azure_blob_mount' && pattern.type === 'fuse') {
      paths.add('.sandbox-blobfuse-config');
      paths.add('.sandbox-blobfuse-cache');
      const cachePath = dockerBlobfuseWorkspaceCachePath(
        pattern as FuseMountPattern,
      );
      if (cachePath) {
        paths.add(cachePath);
      }
    }
  }
  return [...paths];
}

async function applyDockerRcloneMount(
  session: DockerSandboxSession,
  entry: Mount | TypedMount,
  mountPath: string,
  pattern: RcloneMountPattern,
): Promise<void> {
  const mode = pattern.mode ?? 'fuse';
  if (mode !== 'fuse' && mode !== 'nfs') {
    throw new SandboxUnsupportedFeatureError(
      'DockerSandboxClient rclone mounts support fuse and nfs modes only.',
      {
        provider: 'DockerSandboxClient',
        feature: 'entry.mountStrategy.pattern.mode',
        mode,
      },
    );
  }
  const config = await dockerRcloneMountConfig(
    session,
    entry,
    pattern,
    mountPath,
  );
  const configDir = `/tmp/openai-agents-docker-mounts-${dockerPathHash(
    `${session.state.containerId}:${mountPath}`,
  )}`;
  const configPath = `${configDir}/${config.remoteName}.conf`;
  const baseCommand = [
    `mkdir -p -- ${shellQuote(mountPath)}`,
    `rm -rf -- ${shellQuote(configDir)}`,
    `trap ${shellQuote(`rm -rf -- ${shellQuote(configDir)}`)} EXIT`,
    `install -d -m 700 -- ${shellQuote(configDir)}`,
    `(umask 077 && cat > ${shellQuote(configPath)})`,
  ];
  if (mode === 'nfs') {
    const nfsAddr = rclonePatternString(pattern, 'nfsAddr') ?? '127.0.0.1:2049';
    const pidPath = dockerRcloneNfsPidPath(session, mountPath);
    const [host, port] = splitDockerNfsAddr(nfsAddr);
    const serverArgs = [
      'rclone',
      'serve',
      'nfs',
      `${config.remoteName}:${config.remotePath}`,
      '--addr',
      nfsAddr,
      '--config',
      configPath,
      ...(config.readOnly ? ['--read-only'] : []),
      ...dockerRclonePatternArgs(pattern),
    ];
    const mountOptions = rclonePatternStringArray(
      pattern,
      'nfsMountOptions',
    ) ?? ['vers=4.1', 'tcp', `port=${port}`, 'soft', 'timeo=50', 'retrans=1'];
    const mountCommand = [
      '{ mounted=0',
      `for i in 1 2 3; do if mount -v -t nfs -o ${shellQuote(mountOptions.join(','))} ${shellQuote(`${host}:/`)} ${shellQuote(mountPath)}; then mounted=1; break; fi; sleep 1; done`,
      `if [ "$mounted" = 1 ]; then rm -rf -- ${shellQuote(configDir)}; exit 0; fi`,
      dockerSafeKillRcloneNfsPidFileCommand(pidPath),
      `rm -rf -- ${shellQuote(configDir)}`,
      'exit 1',
      '}',
    ].join('; ');
    await session.runDockerMountCommand(
      [
        ...baseCommand,
        `(${shellCommand(serverArgs)} & printf %s "$!" > ${shellQuote(pidPath)}) && ${mountCommand}`,
      ].join(' && '),
      `mount rclone ${entry.type}`,
      { input: config.configText },
    );
    return;
  }

  const mountArgs = [
    'rclone',
    'mount',
    `${config.remoteName}:${config.remotePath}`,
    mountPath,
    ...(config.readOnly ? ['--read-only'] : []),
    ...dockerRcloneFuseAccessArgs(session),
    '--config',
    configPath,
    '--daemon',
    ...dockerRclonePatternArgs(pattern),
  ];
  await session.runDockerMountCommand(
    [
      ...baseCommand,
      dockerEnableFuseAllowOtherCommand(),
      shellCommand(mountArgs),
      `rm -rf -- ${shellQuote(configDir)}`,
    ].join(' && '),
    `mount rclone ${entry.type}`,
    { input: config.configText },
  );
}

function dockerRcloneNfsPidPath(
  session: DockerSandboxSession,
  mountPath: string,
): string {
  return `/tmp/openai-agents-rclone-nfs-${dockerPathHash(
    `${session.state.containerId}:${mountPath}`,
  )}.pid`;
}

function dockerSafeKillRcloneNfsPidFileCommand(pidPath: string): string {
  return [
    `pid=$(cat ${shellQuote(pidPath)} 2>/dev/null || true)`,
    `case "$pid" in ''|0|*[!0-9]*) ;; *) cmdline=$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true); case "$cmdline" in *rclone*serve\\ nfs*) kill "$pid" >/dev/null 2>&1 || true ;; esac ;; esac`,
    `rm -f -- ${shellQuote(pidPath)}`,
  ].join('; ');
}

function dockerEnableFuseAllowOtherCommand(): string {
  return "touch /etc/fuse.conf && (grep -qxF user_allow_other /etc/fuse.conf || printf '\\nuser_allow_other\\n' >> /etc/fuse.conf)";
}

function dockerRcloneFuseAccessArgs(session: DockerSandboxSession): string[] {
  const user = session.state.defaultUser;
  const match = /^(\d+):(\d+)$/u.exec(user ?? '');
  return [
    '--allow-other',
    ...(match ? ['--uid', match[1], '--gid', match[2]] : []),
  ];
}

async function applyDockerMountpointMount(
  session: DockerSandboxSession,
  entry: Mount | TypedMount,
  mountPath: string,
  pattern: MountpointMountPattern,
): Promise<void> {
  if (entry.type !== 's3_mount' && entry.type !== 'gcs_mount') {
    throw new SandboxUnsupportedFeatureError(
      'DockerSandboxClient mountpoint mounts support S3 and GCS mount entries only.',
      {
        provider: 'DockerSandboxClient',
        mountType: entry.type,
      },
    );
  }
  const options = dockerMountpointPatternOptions(pattern);
  const endpointUrl =
    entry.endpointUrl ??
    options.endpointUrl ??
    (entry.type === 'gcs_mount' ? 'https://storage.googleapis.com' : undefined);
  const mountArgs = [
    'mount-s3',
    ...((entry.readOnly ?? true)
      ? ['--read-only']
      : ['--allow-overwrite', '--allow-delete']),
    ...((entry.region ?? options.region)
      ? ['--region', entry.region ?? options.region!]
      : []),
    ...(endpointUrl ? ['--endpoint-url', endpointUrl] : []),
    ...(entry.type === 'gcs_mount' ? ['--upload-checksums', 'off'] : []),
    ...((entry.prefix ?? options.prefix)
      ? ['--prefix', entry.prefix ?? options.prefix!]
      : []),
    entry.bucket,
    mountPath,
  ];
  const envText =
    entry.type === 's3_mount'
      ? dockerMountpointAwsEnv(
          entry.accessKeyId,
          entry.secretAccessKey,
          entry.sessionToken,
        )
      : dockerMountpointAwsEnv(
          readOptionalString(entry, 'accessId'),
          readOptionalString(entry, 'secretAccessKey'),
        );
  const envDir = `/tmp/openai-agents-mountpoint-env-${dockerPathHash(
    `${session.state.containerId}:${mountPath}`,
  )}`;
  const envPath = `${envDir}/credentials.env`;
  const command = envText
    ? [
        `rm -rf -- ${shellQuote(envDir)}`,
        `install -d -m 700 -- ${shellQuote(envDir)}`,
        `(umask 077 && cat > ${shellQuote(envPath)})`,
        `set -a && . ${shellQuote(envPath)} && set +a`,
        `rm -rf -- ${shellQuote(envDir)}`,
        shellCommand(mountArgs),
      ].join(' && ')
    : shellCommand(mountArgs);
  await session.runDockerMountCommand(
    [`mkdir -p -- ${shellQuote(mountPath)}`, command].join(' && '),
    `mount mountpoint ${entry.type}`,
    envText ? { input: envText } : {},
  );
}

async function applyDockerS3FilesMount(
  session: DockerSandboxSession,
  entry: Mount | TypedMount,
  mountPath: string,
  pattern: S3FilesMountPattern,
): Promise<void> {
  if (entry.type !== 's3_files_mount') {
    throw new SandboxUnsupportedFeatureError(
      'DockerSandboxClient s3files mounts require an s3FilesMount() entry.',
      {
        provider: 'DockerSandboxClient',
        mountType: entry.type,
      },
    );
  }
  const s3Files = entry as S3FilesMount;
  if (!s3Files.fileSystemId) {
    throw new SandboxMountError(
      's3FilesMount() requires fileSystemId for Docker in-container mounts.',
      { mountType: entry.type },
      'mount_config_invalid',
    );
  }
  const patternOptions = dockerS3FilesPatternOptions(pattern);
  const options: Record<string, string | null> = {
    ...readStringNullRecord(patternOptions.extraOptions),
    ...readStringNullRecord(s3Files.extraOptions),
  };
  if (entry.readOnly ?? true) {
    options.ro = null;
  }
  const mountTargetIp = s3Files.mountTargetIp ?? patternOptions.mountTargetIp;
  const accessPoint = s3Files.accessPoint ?? patternOptions.accessPoint;
  const region = s3Files.region ?? patternOptions.region;
  if (mountTargetIp) {
    options.mounttargetip = mountTargetIp;
  }
  if (accessPoint) {
    options.accesspoint = accessPoint;
  }
  if (region) {
    options.region = region;
  }
  const device = s3Files.subpath
    ? `${s3Files.fileSystemId}:${s3Files.subpath}`
    : s3Files.fileSystemId;
  const mountArgs = [
    'mount',
    '-t',
    's3files',
    ...(Object.keys(options).length > 0
      ? ['-o', dockerMountOptions(options)]
      : []),
    device,
    mountPath,
  ];
  await session.runDockerMountCommand(
    [`mkdir -p -- ${shellQuote(mountPath)}`, shellCommand(mountArgs)].join(
      ' && ',
    ),
    `mount s3files ${entry.type}`,
  );
}

async function applyDockerFuseMount(
  session: DockerSandboxSession,
  entry: Mount | TypedMount,
  mountPath: string,
  pattern: FuseMountPattern,
): Promise<void> {
  if (entry.type === 'azure_blob_mount') {
    await applyDockerAzureBlobFuseMount(session, entry, mountPath, pattern);
    return;
  }
  if (!pattern.command) {
    throw new SandboxUnsupportedFeatureError(
      'DockerSandboxClient fuse command mounts require pattern.command.',
      {
        provider: 'DockerSandboxClient',
        mountType: entry.type,
      },
    );
  }
  const command = Array.isArray(pattern.command)
    ? shellCommand(pattern.command)
    : pattern.command;
  await session.runDockerMountCommand(
    [
      `mkdir -p -- ${shellQuote(mountPath)}`,
      [
        `export OPENAI_AGENTS_MOUNT_PATH=${shellQuote(mountPath)}`,
        ...(entry.source
          ? [`export OPENAI_AGENTS_MOUNT_SOURCE=${shellQuote(entry.source)}`]
          : []),
        command,
      ].join('; '),
    ].join(' && '),
    `mount fuse command ${entry.type}`,
  );
}

async function applyDockerAzureBlobFuseMount(
  session: DockerSandboxSession,
  entry: AzureBlobMount,
  mountPath: string,
  pattern: FuseMountPattern,
): Promise<void> {
  const account = entry.account ?? entry.accountName;
  if (!account) {
    throw new SandboxMountError(
      'azureBlobMount() requires account or accountName for Docker fuse mounts.',
      { mountType: entry.type },
      'mount_config_invalid',
    );
  }
  if (entry.prefix) {
    throw new SandboxUnsupportedFeatureError(
      'DockerSandboxClient blobfuse mounts do not support azureBlobMount().prefix. Use an rclone mount pattern for prefix-scoped Azure Blob mounts.',
      {
        provider: 'DockerSandboxClient',
        mountType: entry.type,
      },
    );
  }

  const cacheType = dockerFusePatternString(
    pattern,
    'cacheType',
    'block_cache',
  );
  if (cacheType !== 'block_cache' && cacheType !== 'file_cache') {
    throw new SandboxMountError(
      'blobfuse cacheType must be "block_cache" or "file_cache".',
      { mountType: entry.type, cacheType },
      'mount_config_invalid',
    );
  }
  const workspaceRoot = session.state.manifest.root;
  const cacheDir = resolveDockerBlobfuseCacheDir(
    workspaceRoot,
    pattern,
    session.state.containerId,
    account,
    entry.container,
  );
  if (pathWithinDockerMount(cacheDir, mountPath)) {
    throw new SandboxMountError(
      'blobfuse cachePath must be outside the mount path.',
      {
        mountPath,
        cachePath: cacheDir,
      },
      'mount_config_invalid',
    );
  }
  const configDir = `/tmp/openai-agents-blobfuse-config-${dockerPathHash(
    `${session.state.containerId}:${mountPath}`,
  )}`;
  const configName = `${sanitizeDockerMountName(account)}_${sanitizeDockerMountName(entry.container)}.yaml`;
  const configPath = `${configDir}/${configName}`;
  const configText = dockerBlobfuseConfigText({
    account,
    container: entry.container,
    endpoint:
      azureBlobEndpoint(entry) ?? `https://${account}.blob.core.windows.net`,
    cacheType,
    cacheSizeMb:
      dockerFusePatternNumber(pattern, 'cacheSizeMb') ??
      (cacheType === 'block_cache' ? 50_000 : 4_096),
    blockCacheBlockSizeMb:
      dockerFusePatternNumber(pattern, 'blockCacheBlockSizeMb') ?? 16,
    blockCacheDiskTimeoutSec:
      dockerFusePatternNumber(pattern, 'blockCacheDiskTimeoutSec') ?? 3600,
    fileCacheTimeoutSec:
      dockerFusePatternNumber(pattern, 'fileCacheTimeoutSec') ?? 120,
    fileCacheMaxSizeMb: dockerFusePatternNumber(pattern, 'fileCacheMaxSizeMb'),
    cacheDir,
    allowOther: dockerFusePatternBoolean(pattern, 'allowOther', true),
    logType: dockerFusePatternString(pattern, 'logType', 'syslog'),
    logLevel: dockerFusePatternString(pattern, 'logLevel', 'log_debug'),
    entryCacheTimeoutSec: dockerFusePatternNumber(
      pattern,
      'entryCacheTimeoutSec',
    ),
    negativeEntryCacheTimeoutSec: dockerFusePatternNumber(
      pattern,
      'negativeEntryCacheTimeoutSec',
    ),
    attrCacheTimeoutSec: dockerFusePatternNumber(
      pattern,
      'attrCacheTimeoutSec',
    ),
    identityClientId: entry.identityClientId,
    accountKey: entry.accountKey,
  });
  const mountArgs = [
    'blobfuse2',
    'mount',
    ...((entry.readOnly ?? true) ? ['--read-only'] : []),
    '--config-file',
    configPath,
    mountPath,
  ];
  await session.runDockerMountCommand(
    [
      'command -v blobfuse2 >/dev/null 2>&1',
      `mkdir -p -- ${shellQuote(mountPath)} ${shellQuote(cacheDir)}`,
      `rm -rf -- ${shellQuote(configDir)}`,
      `trap ${shellQuote(`rm -rf -- ${shellQuote(configDir)}`)} EXIT`,
      `install -d -m 700 -- ${shellQuote(configDir)}`,
      `(umask 077 && cat > ${shellQuote(configPath)})`,
      dockerEnableFuseAllowOtherCommand(),
      shellCommand(mountArgs),
      `rm -rf -- ${shellQuote(configDir)}`,
    ].join(' && '),
    `mount blobfuse ${entry.type}`,
    { input: configText },
  );
}

function resolveDockerBlobfuseCacheDir(
  workspaceRoot: string,
  pattern: FuseMountPattern,
  containerId: string,
  account: string,
  container: string,
): string {
  const configuredCachePath = dockerFusePatternString(pattern, 'cachePath');
  if (configuredCachePath) {
    return joinSandboxLogicalPath(
      workspaceRoot,
      normalizeDockerBlobfuseCachePath(configuredCachePath),
    );
  }
  return joinSandboxLogicalPath(
    workspaceRoot,
    [
      '.sandbox-blobfuse-cache',
      dockerPathHash(containerId),
      sanitizeDockerMountName(account),
      sanitizeDockerMountName(container),
    ].join('/'),
  );
}

function dockerBlobfuseWorkspaceCachePath(
  pattern: FuseMountPattern,
): string | undefined {
  const configuredCachePath = dockerFusePatternString(pattern, 'cachePath');
  return configuredCachePath
    ? normalizeDockerBlobfuseCachePath(configuredCachePath)
    : undefined;
}

function normalizeDockerBlobfuseCachePath(cachePath: string): string {
  const normalized = cachePath.replace(/\\/gu, '/');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized === '.' ||
    parts.includes('..')
  ) {
    throw new SandboxMountError(
      'blobfuse cachePath must be relative to the workspace root.',
      { cachePath },
      'mount_config_invalid',
    );
  }
  return normalized.replace(/^\.\/+/u, '');
}

function dockerBlobfuseConfigText(args: {
  account: string;
  container: string;
  endpoint: string;
  cacheType: 'block_cache' | 'file_cache';
  cacheSizeMb: number;
  blockCacheBlockSizeMb: number;
  blockCacheDiskTimeoutSec: number;
  fileCacheTimeoutSec: number;
  fileCacheMaxSizeMb?: number;
  cacheDir: string;
  allowOther: boolean;
  logType: string;
  logLevel: string;
  entryCacheTimeoutSec?: number;
  negativeEntryCacheTimeoutSec?: number;
  attrCacheTimeoutSec?: number;
  identityClientId?: string;
  accountKey?: string;
}): string {
  const lines: string[] = [];
  if (args.allowOther) {
    lines.push('allow-other: true', '');
  }
  lines.push(
    'logging:',
    `  type: ${args.logType}`,
    `  level: ${args.logLevel}`,
    '',
    'components:',
    '  - libfuse',
    `  - ${args.cacheType}`,
    '  - attr_cache',
    '  - azstorage',
    '',
  );

  const libfuseLines: string[] = [];
  if (args.entryCacheTimeoutSec !== undefined) {
    libfuseLines.push(`  entry-expiration-sec: ${args.entryCacheTimeoutSec}`);
  }
  if (args.negativeEntryCacheTimeoutSec !== undefined) {
    libfuseLines.push(
      `  negative-entry-expiration-sec: ${args.negativeEntryCacheTimeoutSec}`,
    );
  }
  if (libfuseLines.length > 0) {
    lines.push('libfuse:', ...libfuseLines, '');
  }

  if (args.cacheType === 'block_cache') {
    lines.push(
      'block_cache:',
      `  block-size-mb: ${args.blockCacheBlockSizeMb}`,
      `  mem-size-mb: ${args.cacheSizeMb}`,
      `  path: ${args.cacheDir}`,
      `  disk-size-mb: ${args.cacheSizeMb}`,
      `  disk-timeout-sec: ${args.blockCacheDiskTimeoutSec}`,
      '',
    );
  } else {
    lines.push(
      'file_cache:',
      `  path: ${args.cacheDir}`,
      `  timeout-sec: ${args.fileCacheTimeoutSec}`,
      `  max-size-mb: ${args.fileCacheMaxSizeMb ?? args.cacheSizeMb}`,
      '',
    );
  }

  lines.push(
    'attr_cache:',
    `  timeout-sec: ${args.attrCacheTimeoutSec ?? 7200}`,
    '',
    'azstorage:',
    '  type: block',
    `  account-name: ${args.account}`,
    `  container: ${args.container}`,
    `  endpoint: ${args.endpoint}`,
  );
  if (args.accountKey) {
    lines.push('  auth-type: key', `  account-key: ${args.accountKey}`);
  } else {
    lines.push('  mode: msi');
  }
  if (args.identityClientId) {
    lines.push(`  identity-client-id: ${args.identityClientId}`);
  }
  lines.push('');
  return lines.join('\n');
}

function dockerFusePatternString(
  pattern: FuseMountPattern,
  key: string,
  fallback?: string,
): string {
  const value = pattern[key];
  return typeof value === 'string' ? value : (fallback ?? '');
}

function dockerFusePatternNumber(
  pattern: FuseMountPattern,
  key: string,
  fallback?: number,
): number | undefined {
  const value = pattern[key];
  return typeof value === 'number' ? value : fallback;
}

function dockerFusePatternBoolean(
  pattern: FuseMountPattern,
  key: string,
  fallback: boolean,
): boolean {
  const value = pattern[key];
  return typeof value === 'boolean' ? value : fallback;
}

function dockerMountArgsForManifest(
  manifest: Manifest,
  containerName: string,
): { mountArgs: string[]; volumeNames: string[] } {
  const mountArgs: string[] = [];
  const volumeNames: string[] = [];
  for (const {
    mountPath,
    entry,
  } of manifest.mountTargetsForMaterialization()) {
    if (isDockerBindMount(entry)) {
      mountArgs.push(
        '--mount',
        dockerMountArg({
          type: 'bind',
          source: entry.source,
          target: mountPath,
          readOnly: entry.readOnly ?? true,
        }),
      );
      continue;
    }

    const volumeConfig = dockerVolumeDriverConfig(entry);
    if (!volumeConfig) {
      continue;
    }
    const volumeName = dockerVolumeName(containerName, mountPath);
    volumeNames.push(volumeName);
    mountArgs.push(
      '--mount',
      dockerMountArg({
        type: 'volume',
        source: volumeName,
        target: mountPath,
        readOnly: volumeConfig.readOnly,
        volumeDriver: volumeConfig.driver,
        volumeOptions: volumeConfig.options,
      }),
    );
  }
  return { mountArgs, volumeNames };
}

function dockerExtraPathGrantMountArgs(manifest: Manifest): string[] {
  return manifest.extraPathGrants.flatMap((grant) => [
    '--mount',
    dockerMountArg({
      type: 'bind',
      source: grant.path,
      target: grant.path,
      readOnly: grant.readOnly,
    }),
  ]);
}

function dockerVolumeDriverConfig(
  entry: Mount | TypedMount,
):
  | { driver: string; options: Record<string, string>; readOnly: boolean }
  | undefined {
  if (entry.mountStrategy?.type !== 'docker_volume') {
    return undefined;
  }
  const driver = entry.mountStrategy.driver ?? 'local';
  const driverOptions = entry.mountStrategy.driverOptions ?? {};
  const readOnly = entry.readOnly ?? true;
  switch (entry.type) {
    case 's3_mount':
      if (driver !== 'rclone' && driver !== 'mountpoint') {
        return undefined;
      }
      return {
        driver,
        options: {
          ...(driver === 'rclone'
            ? dockerRcloneS3Options(entry)
            : dockerMountpointS3Options(entry)),
          ...driverOptions,
        },
        readOnly,
      };
    case 'gcs_mount':
      if (driver !== 'rclone' && driver !== 'mountpoint') {
        return undefined;
      }
      return {
        driver,
        options: {
          ...(driver === 'rclone'
            ? dockerRcloneGcsOptions(entry)
            : dockerMountpointGcsOptions(entry)),
          ...driverOptions,
        },
        readOnly,
      };
    case 'r2_mount':
      if (driver !== 'rclone') {
        return undefined;
      }
      return {
        driver,
        options: {
          ...dockerRcloneR2Options(entry),
          ...driverOptions,
        },
        readOnly,
      };
    case 'azure_blob_mount':
      if (driver !== 'rclone') {
        return undefined;
      }
      return {
        driver,
        options: {
          ...dockerRcloneAzureBlobOptions(entry),
          ...driverOptions,
        },
        readOnly,
      };
    case 'box_mount':
      if (driver !== 'rclone') {
        return undefined;
      }
      return {
        driver,
        options: {
          ...dockerRcloneBoxOptions(entry),
          ...driverOptions,
        },
        readOnly,
      };
    default:
      return undefined;
  }
}

const dockerRcloneMountTypes = new Set<string>([
  's3_mount',
  'r2_mount',
  'gcs_mount',
  'azure_blob_mount',
  'box_mount',
]);

type DockerRcloneMountConfig = {
  remoteName: string;
  remotePath: string;
  configText: string;
  readOnly: boolean;
};

async function dockerRcloneMountConfig(
  session: DockerSandboxSession,
  entry: Mount | TypedMount,
  pattern: RcloneMountPattern,
  mountPath: string,
): Promise<DockerRcloneMountConfig> {
  const remoteName = dockerRcloneRemoteName(entry, pattern, mountPath);
  const withConfigText = async (
    config: DockerRcloneMountConfig,
  ): Promise<DockerRcloneMountConfig> => {
    const configFilePath = rclonePatternString(pattern, 'configFilePath');
    if (!configFilePath) {
      return config;
    }
    const sourcePath = resolveDockerRcloneConfigPath(
      session.state.manifest,
      configFilePath,
    );
    const encodedConfig = await session.runDockerMountCommand(
      `base64 -- ${shellQuote(sourcePath)}`,
      `read rclone config ${sourcePath}`,
    );
    const sourceConfigText = Buffer.from(
      encodedConfig.replace(/\s+/gu, ''),
      'base64',
    ).toString('utf8');
    return {
      ...config,
      configText: supplementDockerRcloneConfigText(
        sourceConfigText,
        remoteName,
        config.configText,
        entry.type,
      ),
    };
  };
  switch (entry.type) {
    case 's3_mount':
      return await withConfigText({
        remoteName,
        remotePath: joinRemotePath(entry.bucket, entry.prefix),
        configText: [
          `[${remoteName}]`,
          'type = s3',
          `provider = ${entry.s3Provider ?? 'AWS'}`,
          ...(entry.endpointUrl ? [`endpoint = ${entry.endpointUrl}`] : []),
          ...(entry.region ? [`region = ${entry.region}`] : []),
          ...s3CredentialLines(entry),
          '',
        ].join('\n'),
        readOnly: entry.readOnly ?? true,
      });
    case 'r2_mount':
      validateCredentialPair(
        'R2',
        entry.type,
        entry.accessKeyId,
        entry.secretAccessKey,
      );
      if (!entry.accountId) {
        throw new SandboxMountError(
          'R2 mounts require accountId.',
          { mountType: entry.type },
          'mount_config_invalid',
        );
      }
      return await withConfigText({
        remoteName,
        remotePath: joinRemotePath(entry.bucket, entry.prefix),
        configText: [
          `[${remoteName}]`,
          'type = s3',
          'provider = Cloudflare',
          `endpoint = ${entry.customDomain ?? `https://${entry.accountId}.r2.cloudflarestorage.com`}`,
          'acl = private',
          ...(entry.accessKeyId && entry.secretAccessKey
            ? [
                'env_auth = false',
                `access_key_id = ${entry.accessKeyId}`,
                `secret_access_key = ${entry.secretAccessKey}`,
              ]
            : ['env_auth = true']),
          '',
        ].join('\n'),
        readOnly: entry.readOnly ?? true,
      });
    case 'gcs_mount':
      return await withConfigText(
        dockerGcsRcloneMountConfig(entry, remoteName),
      );
    case 'azure_blob_mount':
      return await withConfigText(
        dockerAzureBlobRcloneMountConfig(entry, remoteName),
      );
    case 'box_mount':
      return await withConfigText({
        remoteName,
        remotePath: normalizeBoxRemotePath(entry.path),
        configText: [
          `[${remoteName}]`,
          'type = box',
          ...(entry.clientId ? [`client_id = ${entry.clientId}`] : []),
          ...(entry.clientSecret
            ? [`client_secret = ${entry.clientSecret}`]
            : []),
          ...(entry.accessToken ? [`access_token = ${entry.accessToken}`] : []),
          ...(entry.token ? [`token = ${entry.token}`] : []),
          ...(entry.boxConfigFile
            ? [`box_config_file = ${entry.boxConfigFile}`]
            : []),
          ...(entry.configCredentials
            ? [`config_credentials = ${entry.configCredentials}`]
            : []),
          ...(entry.boxSubType && entry.boxSubType !== 'user'
            ? [`box_sub_type = ${entry.boxSubType}`]
            : []),
          ...(entry.rootFolderId
            ? [`root_folder_id = ${entry.rootFolderId}`]
            : []),
          ...(entry.impersonate ? [`impersonate = ${entry.impersonate}`] : []),
          ...(entry.ownedBy ? [`owned_by = ${entry.ownedBy}`] : []),
          '',
        ].join('\n'),
        readOnly: entry.readOnly ?? true,
      });
    default:
      throw new SandboxUnsupportedFeatureError(
        'DockerSandboxClient rclone mounts do not support this mount entry.',
        {
          provider: 'DockerSandboxClient',
          mountType: (entry as Entry).type,
        },
      );
  }
}

function dockerAzureBlobRcloneMountConfig(
  entry: AzureBlobMount,
  remoteName: string,
): DockerRcloneMountConfig {
  const account = entry.account ?? entry.accountName;
  if (!account) {
    throw new SandboxMountError(
      'Azure Blob mounts require account or accountName.',
      { mountType: entry.type },
      'mount_config_invalid',
    );
  }
  return {
    remoteName,
    remotePath: joinRemotePath(entry.container, entry.prefix),
    configText: [
      `[${remoteName}]`,
      'type = azureblob',
      `account = ${account}`,
      ...(azureBlobEndpoint(entry)
        ? [`endpoint = ${azureBlobEndpoint(entry)}`]
        : []),
      ...(entry.accountKey
        ? [`key = ${entry.accountKey}`]
        : [
            'use_msi = true',
            ...(entry.identityClientId
              ? [`msi_client_id = ${entry.identityClientId}`]
              : []),
          ]),
      '',
    ].join('\n'),
    readOnly: entry.readOnly ?? true,
  };
}

function azureBlobEndpoint(entry: AzureBlobMount): string | undefined {
  return entry.endpointUrl ?? entry.endpoint;
}

function dockerGcsRcloneMountConfig(
  entry: GCSMount,
  remoteName: string,
): DockerRcloneMountConfig {
  const accessId = readOptionalString(entry, 'accessId');
  const secretAccessKey = readOptionalString(entry, 'secretAccessKey');
  if (accessId && secretAccessKey) {
    return {
      remoteName,
      remotePath: joinRemotePath(entry.bucket, entry.prefix),
      configText: [
        `[${remoteName}]`,
        'type = s3',
        'provider = GCS',
        'env_auth = false',
        `access_key_id = ${accessId}`,
        `secret_access_key = ${secretAccessKey}`,
        `endpoint = ${entry.endpointUrl ?? 'https://storage.googleapis.com'}`,
        ...(entry.region ? [`region = ${entry.region}`] : []),
        '',
      ].join('\n'),
      readOnly: entry.readOnly ?? true,
    };
  }
  return {
    remoteName,
    remotePath: joinRemotePath(entry.bucket, entry.prefix),
    configText: [
      `[${remoteName}]`,
      'type = google cloud storage',
      ...(entry.serviceAccountFile
        ? [`service_account_file = ${entry.serviceAccountFile}`]
        : []),
      ...(entry.serviceAccountCredentials
        ? [`service_account_credentials = ${entry.serviceAccountCredentials}`]
        : []),
      ...(entry.accessToken ? [`access_token = ${entry.accessToken}`] : []),
      entry.serviceAccountFile ||
      entry.serviceAccountCredentials ||
      entry.accessToken
        ? 'env_auth = false'
        : 'env_auth = true',
      '',
    ].join('\n'),
    readOnly: entry.readOnly ?? true,
  };
}

function dockerInContainerMountPrivilegeArgs(manifest: Manifest): string[] {
  const privilege = dockerInContainerMountPrivilege(manifest);
  if (privilege === 'fuse') {
    return [
      '--device',
      '/dev/fuse',
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'apparmor:unconfined',
    ];
  }
  if (privilege === 'sys_admin') {
    return ['--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor:unconfined'];
  }
  return [];
}

function dockerInContainerMountPrivilege(
  manifest: Manifest,
): 'none' | 'fuse' | 'sys_admin' {
  let needsSysAdmin = false;
  for (const { entry } of manifest.mountTargetsForMaterialization()) {
    if (!isDockerInContainerMount(entry)) {
      continue;
    }
    const pattern = dockerInContainerMountPattern(entry);
    if (
      pattern.type === 'fuse' ||
      pattern.type === 'mountpoint' ||
      (pattern.type === 'rclone' && (pattern.mode ?? 'fuse') === 'fuse')
    ) {
      return 'fuse';
    }
    if (
      pattern.type === 's3files' ||
      (pattern.type === 'rclone' && pattern.mode === 'nfs')
    ) {
      needsSysAdmin = true;
    }
  }
  return needsSysAdmin ? 'sys_admin' : 'none';
}

function s3CredentialLines(entry: S3Mount): string[] {
  const lines: string[] = [];
  if (entry.accessKeyId && entry.secretAccessKey) {
    lines.push('env_auth = false');
    lines.push(`access_key_id = ${entry.accessKeyId}`);
    lines.push(`secret_access_key = ${entry.secretAccessKey}`);
    if (entry.sessionToken) {
      lines.push(`session_token = ${entry.sessionToken}`);
    }
  } else {
    lines.push('env_auth = true');
  }
  return lines;
}

function validateCredentialPair(
  provider: string,
  mountType: string,
  accessKeyId?: string,
  secretAccessKey?: string,
): void {
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new SandboxMountError(
      `${provider} mounts require both accessKeyId and secretAccessKey when either is provided.`,
      { mountType },
      'mount_config_invalid',
    );
  }
}

function dockerMountpointAwsEnv(
  accessKeyId?: string,
  secretAccessKey?: string,
  sessionToken?: string,
): string {
  if (!accessKeyId || !secretAccessKey) {
    return '';
  }
  return [
    `AWS_ACCESS_KEY_ID=${shellQuote(accessKeyId)}`,
    `AWS_SECRET_ACCESS_KEY=${shellQuote(secretAccessKey)}`,
    ...(sessionToken ? [`AWS_SESSION_TOKEN=${shellQuote(sessionToken)}`] : []),
    '',
  ].join('\n');
}

function splitDockerNfsAddr(value: string): [string, string] {
  const index = value.lastIndexOf(':');
  if (index < 0) {
    return [
      value === '0.0.0.0' || value === '::' ? '127.0.0.1' : value,
      '2049',
    ];
  }
  const host = value.slice(0, index);
  return [
    host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host,
    value.slice(index + 1),
  ];
}

function dockerMountpointPatternOptions(pattern: MountpointMountPattern): {
  prefix?: string;
  region?: string;
  endpointUrl?: string;
} {
  const options = readRecord(pattern.options);
  return {
    prefix: readOptionalString(options, 'prefix'),
    region: readOptionalString(options, 'region'),
    endpointUrl: readOptionalString(options, 'endpointUrl'),
  };
}

function dockerS3FilesPatternOptions(pattern: S3FilesMountPattern): {
  mountTargetIp?: string;
  accessPoint?: string;
  region?: string;
  extraOptions?: Record<string, string | null>;
} {
  const options = readRecord(pattern.options);
  return {
    mountTargetIp: readOptionalString(options, 'mountTargetIp'),
    accessPoint: readOptionalString(options, 'accessPoint'),
    region: readOptionalString(options, 'region'),
    extraOptions: readStringNullRecord(options.extraOptions),
  };
}

function dockerRcloneRemoteName(
  entry: Mount | TypedMount,
  pattern: RcloneMountPattern,
  mountPath: string,
): string {
  const remoteName =
    rclonePatternString(pattern, 'remoteName') ??
    rclonePatternString(pattern, 'remote');
  if (!remoteName) {
    return `sandbox_${sanitizeDockerMountName(entry.type)}_${dockerPathHash(mountPath)}`;
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(remoteName)) {
    throw new SandboxMountError(
      'DockerSandboxClient rclone mounts require remoteName to contain only letters, numbers, underscores, and hyphens.',
      {
        mountType: entry.type,
        remoteName,
      },
      'mount_config_invalid',
    );
  }
  return remoteName;
}

function resolveDockerRcloneConfigPath(
  manifest: Manifest,
  configFilePath: string,
): string {
  return new WorkspacePathPolicy({
    root: manifest.root,
    extraPathGrants: manifest.extraPathGrants,
  }).resolve(configFilePath).path;
}

function supplementDockerRcloneConfigText(
  configText: string,
  remoteName: string,
  requiredConfigText: string,
  mountType: string,
): string {
  const escapedRemote = remoteName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const sectionPattern = new RegExp(`^\\s*\\[${escapedRemote}\\]\\s*$`, 'mu');
  const match = sectionPattern.exec(configText);
  if (!match) {
    throw new SandboxMountError(
      'DockerSandboxClient rclone config file is missing the required remote section.',
      {
        mountType,
        remoteName,
      },
      'mount_config_invalid',
    );
  }
  const sectionStart = match.index;
  const sectionEnd = match.index + match[0].length;
  const nextSection = /^\s*\[.+\]\s*$/mu.exec(configText.slice(sectionEnd));
  const sectionBodyEnd = nextSection
    ? sectionEnd + nextSection.index
    : configText.length;
  const before = configText.slice(0, sectionStart);
  const sectionBody = configText.slice(sectionStart, sectionBodyEnd).trimEnd();
  const after = configText.slice(sectionBodyEnd);
  const requiredLines = requiredConfigText.trimEnd().split('\n').slice(1);
  const supplement =
    requiredLines.length > 0 ? `\n${requiredLines.join('\n')}` : '';
  return `${before}${sectionBody}${supplement}\n${after}`;
}

function dockerRclonePatternArgs(pattern: RcloneMountPattern): string[] {
  return [
    ...(rclonePatternStringArray(pattern, 'args') ?? []),
    ...(rclonePatternStringArray(pattern, 'extraArgs') ?? []),
  ];
}

function rclonePatternString(
  pattern: RcloneMountPattern,
  key: string,
): string | undefined {
  return readOptionalString(pattern, key);
}

function rclonePatternStringArray(
  pattern: RcloneMountPattern,
  key: string,
): string[] | undefined {
  const value = readStringArray(pattern[key]);
  return value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringNullRecord(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | null] =>
        typeof entry[1] === 'string' || entry[1] === null,
    ),
  );
}

function dockerMountOptions(options: Record<string, string | null>): string {
  return Object.entries(options)
    .map(([key, value]) => (value === null ? key : `${key}=${value}`))
    .join(',');
}

function shellCommand(parts: string[]): string {
  return parts.map((part) => shellQuote(part)).join(' ');
}

function sanitizeDockerMountName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_');
}

function dockerPathHash(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

function dockerPosixDirname(path: string): string {
  const index = path.lastIndexOf('/');
  if (index <= 0) {
    return index === 0 ? '/' : '.';
  }
  return path.slice(0, index);
}

function resolveDockerMountPath(
  manifestRoot: string,
  logicalPath: string,
  entry: Mount | TypedMount,
): string {
  if (entry.mountPath?.startsWith('/')) {
    return entry.mountPath;
  }
  const mountPath = entry.mountPath ?? logicalPath;
  return joinSandboxLogicalPath(manifestRoot, mountPath);
}

function resolveDockerMountWorkspaceRelativePath(
  manifestRoot: string,
  logicalPath: string,
  entry: Mount | TypedMount,
): string | null {
  const target = resolveDockerMountPath(manifestRoot, logicalPath, entry);
  if (target === '/') {
    throw new SandboxUnsupportedFeatureError(
      'DockerSandboxClient does not support mounting over the container root.',
    );
  }
  try {
    const resolved = new WorkspacePathPolicy({ root: manifestRoot }).resolve(
      target,
      { forWrite: true },
    );
    return resolved.workspaceRelativePath ?? null;
  } catch {
    return null;
  }
}

function dockerMountArg(args: {
  type: 'bind' | 'volume';
  source: string;
  target: string;
  readOnly?: boolean;
  volumeDriver?: string;
  volumeOptions?: Record<string, string>;
}): string {
  return [
    dockerMountField('type', args.type),
    dockerMountField('source', args.source),
    dockerMountField('target', args.target),
    ...(args.readOnly ? ['readonly'] : []),
    ...(args.volumeDriver
      ? [dockerMountField('volume-driver', args.volumeDriver)]
      : []),
    ...Object.entries(args.volumeOptions ?? {}).map(([key, value]) =>
      dockerMountField('volume-opt', `${key}=${value}`),
    ),
  ].join(',');
}

function dockerMountField(key: string, value: string): string {
  return dockerMountCsvField(`${key}=${value}`);
}

function dockerMountCsvField(field: string): string {
  if (!/[",\n\r]/u.test(field)) {
    return field;
  }
  return `"${field.replace(/"/gu, '""')}"`;
}

function dockerVolumeName(containerName: string, mountPath: string): string {
  const pathHash = createHash('sha256')
    .update(mountPath)
    .digest('hex')
    .slice(0, 12);
  const safePath =
    mountPath.replace(/[^A-Za-z0-9_.-]+/gu, '_').replace(/^_+|_+$/gu, '') ||
    'workspace';
  return `${containerName}-${pathHash}-${safePath.slice(0, 80)}`;
}

async function removeDockerVolumes(volumeNames: string[]): Promise<void> {
  await Promise.all(
    volumeNames.map(async (volumeName) => {
      await runSandboxProcess('docker', ['volume', 'rm', '-f', volumeName], {
        timeoutMs: DOCKER_FAST_COMMAND_TIMEOUT_MS,
      }).catch(() => undefined);
    }),
  );
}

function dockerRcloneS3Options(entry: S3Mount): Record<string, string> {
  return withDefinedStringValues({
    type: 's3',
    's3-provider': entry.s3Provider ?? 'AWS',
    path: joinRemotePath(entry.bucket, entry.prefix),
    's3-access-key-id': entry.accessKeyId,
    's3-secret-access-key': entry.secretAccessKey,
    's3-session-token': entry.sessionToken,
    's3-endpoint': entry.endpointUrl,
    's3-region': entry.region,
  });
}

function dockerMountpointS3Options(entry: S3Mount): Record<string, string> {
  return withDefinedStringValues({
    bucket: entry.bucket,
    access_key_id: entry.accessKeyId,
    secret_access_key: entry.secretAccessKey,
    session_token: entry.sessionToken,
    endpoint_url: entry.endpointUrl,
    region: entry.region,
    prefix: entry.prefix,
  });
}

function dockerRcloneGcsOptions(entry: GCSMount): Record<string, string> {
  if (entry.accessId && entry.secretAccessKey) {
    return withDefinedStringValues({
      type: 's3',
      path: joinRemotePath(entry.bucket, entry.prefix),
      's3-provider': 'GCS',
      's3-access-key-id': entry.accessId,
      's3-secret-access-key': entry.secretAccessKey,
      's3-endpoint': entry.endpointUrl ?? 'https://storage.googleapis.com',
      's3-region': entry.region,
    });
  }
  return withDefinedStringValues({
    type: 'google cloud storage',
    path: joinRemotePath(entry.bucket, entry.prefix),
    'gcs-service-account-file': entry.serviceAccountFile,
    'gcs-service-account-credentials': entry.serviceAccountCredentials,
    'gcs-access-token': entry.accessToken,
  });
}

function dockerMountpointGcsOptions(entry: GCSMount): Record<string, string> {
  return withDefinedStringValues({
    bucket: entry.bucket,
    endpoint_url: entry.endpointUrl ?? 'https://storage.googleapis.com',
    access_key_id: entry.accessId,
    secret_access_key: entry.secretAccessKey,
    region: entry.region,
    prefix: entry.prefix,
  });
}

function dockerRcloneR2Options(entry: R2Mount): Record<string, string> {
  validateCredentialPair(
    'R2',
    entry.type,
    entry.accessKeyId,
    entry.secretAccessKey,
  );
  if (!entry.accountId) {
    throw new SandboxMountError(
      'R2 Docker volume mounts require accountId.',
      { mountType: entry.type },
      'mount_config_invalid',
    );
  }
  return withDefinedStringValues({
    type: 's3',
    path: joinRemotePath(entry.bucket, entry.prefix),
    's3-provider': 'Cloudflare',
    's3-endpoint':
      entry.customDomain ??
      `https://${entry.accountId}.r2.cloudflarestorage.com`,
    's3-access-key-id': entry.accessKeyId,
    's3-secret-access-key': entry.secretAccessKey,
  });
}

function dockerRcloneAzureBlobOptions(
  entry: AzureBlobMount,
): Record<string, string> {
  return withDefinedStringValues({
    type: 'azureblob',
    path: joinRemotePath(entry.container, entry.prefix),
    'azureblob-account': entry.account ?? entry.accountName,
    'azureblob-endpoint': azureBlobEndpoint(entry),
    'azureblob-msi-client-id': entry.identityClientId,
    'azureblob-key': entry.accountKey,
  });
}

function dockerRcloneBoxOptions(entry: BoxMount): Record<string, string> {
  return withDefinedStringValues({
    type: 'box',
    path: normalizeBoxRemotePath(entry.path),
    'box-client-id': entry.clientId,
    'box-client-secret': entry.clientSecret,
    'box-access-token': entry.accessToken,
    'box-token': entry.token,
    'box-box-config-file': entry.boxConfigFile,
    'box-config-credentials': entry.configCredentials,
    'box-box-sub-type':
      entry.boxSubType && entry.boxSubType !== 'user'
        ? entry.boxSubType
        : undefined,
    'box-root-folder-id': entry.rootFolderId,
    'box-impersonate': entry.impersonate,
    'box-owned-by': entry.ownedBy,
  });
}

function joinRemotePath(base: string, prefix: string | undefined): string {
  const normalizedPrefix = prefix?.replace(/^\/+|\/+$/gu, '');
  return normalizedPrefix ? `${base}/${normalizedPrefix}` : base;
}

function normalizeBoxRemotePath(path: string | undefined): string {
  return path?.replace(/^\/+/gu, '') ?? '';
}

function withDefinedStringValues(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function parseDockerPortBinding(
  stdout: string,
  containerPort: number,
): { host: string; port: number } {
  const line = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) {
    throw new UserError(
      `Docker did not report a host binding for exposed port ${containerPort}.`,
    );
  }

  const bracketMatch = line.match(/^\[([^\]]+)\]:(\d+)$/u);
  const match = bracketMatch ?? line.match(/^(.+):(\d+)$/u);
  if (!match) {
    throw new UserError(
      `Docker reported an unrecognized host binding for exposed port ${containerPort}: ${line}`,
    );
  }

  const rawHost = match[1];
  return {
    host: normalizeDockerBindingHost(rawHost),
    port: normalizeExposedPort(Number(match[2])),
  };
}

function normalizeDockerBindingHost(host: string): string {
  if (host === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (host === '::' || host === '') {
    return '::1';
  }
  return host;
}

function getHostDockerUser(): string | undefined {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.getgid !== 'function'
  ) {
    return undefined;
  }

  return `${process.getuid()}:${process.getgid()}`;
}
