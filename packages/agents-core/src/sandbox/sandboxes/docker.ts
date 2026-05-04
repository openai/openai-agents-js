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
  SandboxUnsupportedFeatureError,
} from '../errors';
import { chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type AzureBlobMount,
  type BoxMount,
  type GCSMount,
  type Mount,
  type R2Mount,
  type S3Mount,
  type TypedMount,
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
    if (!runAs) {
      return await super.pathExists(path);
    }
    const result = await this.runDockerFilesystemCommand(
      `test -e ${shellQuote(this.resolveContainerFilesystemPath(path))}`,
      { runAs },
    );
    return result.status === 0;
  }

  override async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    if (!args.runAs) {
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
    if (!args.runAs) {
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

  override async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
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
    await provisionDockerAccounts(this.state.containerId, manifest);
    await super.applyManifest(stripDockerIdentityMetadata(manifest));
    if (runAs) {
      for (const path of Object.keys(manifest.entries)) {
        await this.chownContainerPath(
          this.resolveContainerFilesystemPath(path),
          runAs,
        );
      }
    }
    this.state.manifest = mergeDockerIdentityMetadata(
      this.state.manifest,
      manifest,
    );
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

  async readDockerFileAs(path: string, runAs: string): Promise<Uint8Array> {
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
    await provisionDockerAccounts(container.containerId, manifest);

    return new DockerSandboxSession({
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
    await provisionDockerAccounts(container.containerId, state.manifest);
    return {
      ...state,
      workspaceRootPath,
      containerId: container.containerId,
      dockerVolumeNames: container.volumeNames,
      exposedPorts: undefined,
    };
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
  return isDockerBindMount(entry) || isDockerVolumeMount(entry);
}

function isSupportedDockerApplyMount(_entry: Mount | TypedMount): boolean {
  return false;
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

function dockerVolumeMountContainingPath(
  manifest: Manifest,
  path?: string,
): string | undefined {
  const resolved = new WorkspacePathPolicy({
    root: manifest.root,
    extraPathGrants: manifest.extraPathGrants,
  }).resolve(path);

  for (const { entry, mountPath } of manifest.mountTargets()) {
    if (!isDockerVolumeMount(entry)) {
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
    's3-provider': 'AWS',
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
  return withDefinedStringValues({
    type: 's3',
    path: joinRemotePath(entry.bucket, entry.prefix),
    's3-provider': 'Cloudflare',
    's3-endpoint':
      entry.customDomain ??
      (entry.accountId
        ? `https://${entry.accountId}.r2.cloudflarestorage.com`
        : undefined),
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
    'azureblob-endpoint': entry.endpointUrl,
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
