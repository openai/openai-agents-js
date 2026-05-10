import type {
  ApplyPatchOperation,
  ApplyPatchResult,
  Editor,
} from '../../editor';
import { UserError } from '../../errors';
import type { ToolOutputImage } from '../../tool';
import { applyDiff } from '../../utils/applyDiff';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import type {
  SandboxClient,
  SandboxClientOptions,
  SandboxClientCreateArgs,
  SandboxArchiveLimits,
  SandboxClientResumeOptions,
  SandboxConcurrencyLimits,
} from '../client';
import {
  normalizeSandboxClientCreateArgs,
  validateSandboxArchiveLimits,
} from '../client';
import {
  normalizeExposedPort,
  recordExposedPortEndpoint,
  type ExposedPortEndpoint,
  type ExecCommandArgs,
  type ListDirectoryArgs,
  type MaterializeEntryArgs,
  type ReadFileArgs,
  type SandboxDirectoryEntry,
  type SandboxExecResult,
  type SandboxSession,
  type SandboxSessionState,
  type ViewImageArgs,
  type WriteStdinArgs,
  type WorkspaceArchiveOptions,
} from '../session';
import { Manifest, normalizeRelativePath } from '../manifest';
import { SandboxConfigurationError } from '../errors';
import {
  WorkspacePathPolicy,
  type ResolveSandboxPathOptions,
  type ResolvedSandboxPath,
} from '../workspacePaths';
import type { LocalSandboxSnapshot, LocalSandboxSnapshotSpec } from './types';
import {
  applyOwnershipRecursive,
  assertLocalWorkspaceManifestMetadataSupported,
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
import {
  isHostPathWithinRoot,
  relativeHostPathEscapesRoot,
} from '../shared/hostPath';
import {
  assertViewImageByteLength,
  imageOutputFromBytes,
} from '../shared/media';
import {
  elapsedSeconds,
  formatExecResponse,
  truncateOutput,
} from '../shared/output';
import {
  canReuseLocalSnapshotWorkspace,
  createWorkspaceArchive,
  localSnapshotIsRestorable,
  persistLocalSnapshot,
  restoreLocalSnapshotToWorkspace,
  restoreWorkspaceArchive,
  serializeLocalSnapshotSpec,
} from './shared/localSnapshots';
import { spawnInPseudoTerminal } from './shared/pty';
import { runSandboxProcess } from './shared/runProcess';
import { resolveLocalShellCommand } from './shared/shellCommand';
import {
  deserializeLocalSandboxSessionStateValues,
  normalizeExposedPorts,
} from './shared/sessionStateValues';

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const MAX_ACTIVE_PROCESS_OUTPUT_CHARS = 1024 * 1024;
const RUN_AS_LOOKUP_TIMEOUT_MS = 10_000;
const DEFAULT_SANDBOX_COMMAND_PATH =
  '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export interface UnixLocalSandboxClientOptions extends SandboxClientOptions {
  workspaceBaseDir?: string;
  snapshot?: LocalSandboxSnapshotSpec;
  defaultShell?: string;
  exposedPorts?: number[];
  concurrencyLimits?: SandboxConcurrencyLimits;
  archiveLimits?: SandboxArchiveLimits | null;
}

export interface UnixLocalSandboxSessionState extends SandboxSessionState {
  workspaceRootPath: string;
  workspaceRootOwned: boolean;
  environment: Record<string, string>;
  snapshotSpec?: LocalSandboxSnapshotSpec | null;
  snapshot?: LocalSandboxSnapshot | null;
  snapshotFingerprint?: string | null;
  snapshotFingerprintVersion?: string | null;
  configuredExposedPorts?: number[];
}

type ActiveProcess = {
  child: ChildProcessWithoutNullStreams;
  tty: boolean;
  output: string;
  stdout: string;
  stderr: string;
  droppedOutputChars: number;
  droppedStdoutChars: number;
  droppedStderrChars: number;
  exitCode: number | null;
  done: boolean;
  donePromise: Promise<void>;
  resolveDone: () => void;
  outputClosedPromise: Promise<void>;
  resolveOutputClosed: () => void;
};

type UnixRunAsIdentity = {
  username: string;
  uid: number;
  gid: number;
  isCurrentUser: boolean;
};

export class UnixLocalSandboxSession<
  TState extends UnixLocalSandboxSessionState = UnixLocalSandboxSessionState,
> implements SandboxSession<TState> {
  readonly state: TState;
  protected readonly defaultShell?: string;
  private archiveLimits?: SandboxArchiveLimits | null;
  private readonly activeProcesses = new Map<number, ActiveProcess>();
  private nextSessionId = 1;
  private closed = false;

  constructor(args: {
    state: TState;
    defaultShell?: string;
    archiveLimits?: SandboxArchiveLimits | null;
  }) {
    this.state = args.state;
    this.defaultShell = args.defaultShell;
    this.setArchiveLimits(args.archiveLimits);
  }

  setArchiveLimits(limits?: SandboxArchiveLimits | null): void {
    validateSandboxArchiveLimits(limits);
    this.archiveLimits = limits;
  }

  createEditor(runAs?: string): Editor {
    return new UnixLocalSandboxEditor(this, runAs);
  }

  supportsPty(): boolean {
    return true;
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    const exposedPort = normalizeExposedPort(port);
    const configuredPorts = this.state.configuredExposedPorts ?? [];
    if (configuredPorts.length > 0 && !configuredPorts.includes(exposedPort)) {
      throw new SandboxConfigurationError(
        `UnixLocalSandboxClient was not configured to expose port ${exposedPort}.`,
        {
          provider: 'UnixLocalSandboxClient',
          port: exposedPort,
          configuredPorts,
        },
      );
    }
    return recordExposedPortEndpoint(this.state, {
      host: '127.0.0.1',
      port: exposedPort,
      tls: false,
    });
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    return formatExecResponse(await this.exec(args));
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    const start = Date.now();
    const cwd = this.resolveCommandWorkdir(args.workdir);
    const logicalCwd = this.logicalWorkdirForPath(args.workdir);
    const child = await this.spawnShellCommand(
      this.translateCommandInput(args.cmd),
      {
        cwd,
        logicalCwd,
        shell: args.shell,
        login: args.login ?? true,
        runAs: args.runAs,
        tty: args.tty ?? false,
      },
    );
    const activeProcess = this.trackChildProcess(child, {
      tty: args.tty ?? false,
    });

    if (!args.tty) {
      await waitForProcessOrTimeout(
        activeProcess,
        args.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS,
      );
      const processOutput = consumeActiveProcessOutput(activeProcess);
      if (activeProcess.done) {
        const output = truncateOutput(
          this.translateCommandOutput(processOutput.output),
          args.maxOutputTokens,
        );
        return {
          output: output.text,
          stdout: this.translateCommandOutput(processOutput.stdout),
          stderr: this.translateCommandOutput(processOutput.stderr),
          wallTimeSeconds: elapsedSeconds(start),
          exitCode: activeProcess.exitCode ?? 1,
          originalTokenCount: output.originalTokenCount,
        };
      }

      const output = truncateOutput(
        this.translateCommandOutput(processOutput.output),
        args.maxOutputTokens,
      );
      const sessionId = this.allocateProcessId(activeProcess);
      return {
        output: output.text,
        stdout: this.translateCommandOutput(processOutput.stdout),
        stderr: this.translateCommandOutput(processOutput.stderr),
        wallTimeSeconds: elapsedSeconds(start),
        sessionId,
        originalTokenCount: output.originalTokenCount,
      };
    }

    const yieldTimeMs = args.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;

    await waitForProcessOrTimeout(activeProcess, yieldTimeMs);

    if (activeProcess.done) {
      const processOutput = consumeActiveProcessOutput(activeProcess);
      const output = truncateOutput(
        this.translateCommandOutput(processOutput.output),
        args.maxOutputTokens,
      );
      return {
        output: output.text,
        stdout: this.translateCommandOutput(processOutput.stdout),
        stderr: this.translateCommandOutput(processOutput.stderr),
        wallTimeSeconds: elapsedSeconds(start),
        exitCode: activeProcess.exitCode ?? 1,
        originalTokenCount: output.originalTokenCount,
      };
    }

    const sessionId = this.allocateProcessId(activeProcess);
    const processOutput = consumeActiveProcessOutput(activeProcess);
    const output = truncateOutput(
      this.translateCommandOutput(processOutput.output),
      args.maxOutputTokens,
    );
    return {
      output: output.text,
      stdout: this.translateCommandOutput(processOutput.stdout),
      stderr: this.translateCommandOutput(processOutput.stderr),
      wallTimeSeconds: elapsedSeconds(start),
      sessionId,
      originalTokenCount: output.originalTokenCount,
    };
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    const activeProcess = this.activeProcesses.get(args.sessionId);
    if (!activeProcess) {
      return formatExecResponse({
        output: `write_stdin failed: session not found: ${args.sessionId}`,
        wallTimeSeconds: 0,
        exitCode: 1,
      });
    }

    const start = Date.now();
    const chars = args.chars ?? '';
    if (!activeProcess.tty && chars.includes('\u0003')) {
      activeProcess.child.kill('SIGINT');
    }
    const remainingChars = activeProcess.tty
      ? chars
      : chars.split('\u0003').join('');
    if (remainingChars.length > 0) {
      activeProcess.child.stdin.write(remainingChars);
    }

    await waitForProcessOrTimeout(
      activeProcess,
      args.yieldTimeMs ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
    );

    const processOutput = consumeActiveProcessOutput(activeProcess);
    const output = truncateOutput(
      this.translateCommandOutput(processOutput.output),
      args.maxOutputTokens,
    );
    if (activeProcess.done) {
      this.activeProcesses.delete(args.sessionId);
      return formatExecResponse({
        output: output.text,
        wallTimeSeconds: elapsedSeconds(start),
        exitCode: activeProcess.exitCode ?? 1,
        originalTokenCount: output.originalTokenCount,
      });
    }

    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      sessionId: args.sessionId,
      originalTokenCount: output.originalTokenCount,
    });
  }

  async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    await this.resolveFilesystemRunAs(args.runAs);
    const filePath = this.resolveSandboxPath(args.path);
    const info = await stat(filePath).catch(() => {
      throw new UserError(`Image file not found: ${args.path}`);
    });
    if (!info.isFile()) {
      throw new UserError(`Image path is not a file: ${args.path}`);
    }
    assertViewImageByteLength(args.path, info.size);

    const bytes = await readFile(filePath);
    return imageOutputFromBytes(args.path, bytes);
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    await this.resolveFilesystemRunAs(runAs);
    return await pathExists(this.resolveSandboxPath(path));
  }

  async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    await this.resolveFilesystemRunAs(args.runAs);
    const bytes = await readFile(this.resolveSandboxPath(args.path));
    if (typeof args.maxBytes === 'number' && bytes.byteLength > args.maxBytes) {
      return bytes.subarray(0, args.maxBytes);
    }
    return bytes;
  }

  async listDir(args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]> {
    await this.resolveFilesystemRunAs(args.runAs);
    const logicalPath = this.resolveLogicalPath(args.path);
    const entries = await readdir(this.resolveSandboxPath(args.path), {
      withFileTypes: true,
    });
    return entries.map((entry) => ({
      name: entry.name,
      path: logicalPath ? `${logicalPath}/${entry.name}` : entry.name,
      type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
    }));
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    const runAs = await this.resolveFilesystemRunAs(args.runAs);
    const logicalPath = this.resolveLogicalPath(args.path);
    await materializeLocalWorkspaceManifestEntry(
      this.state.workspaceRootPath,
      logicalPath,
      args.entry,
      {
        localSourceGrants: this.state.manifest.extraPathGrants,
      },
    );
    if (runAs) {
      await applyOwnershipRecursive(
        this.resolveSandboxPath(args.path),
        runAs.uid,
        runAs.gid,
      );
    }
    this.state.manifest = mergeManifestEntryDelta(
      this.state.manifest,
      logicalPath,
      args.entry,
    );
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    assertLocalWorkspaceManifestMetadataSupported(
      'UnixLocalSandboxClient',
      manifest,
    );
    const identity = await this.resolveFilesystemRunAs(runAs);
    await materializeLocalWorkspaceManifest(
      manifest,
      this.state.workspaceRootPath,
    );
    const environment = await manifest.resolveEnvironment();
    if (identity) {
      for (const path of Object.keys(manifest.entries)) {
        await applyOwnershipRecursive(
          this.resolveSandboxPath(path),
          identity.uid,
          identity.gid,
        );
      }
    }
    this.state.environment = {
      ...this.state.environment,
      ...environment,
    };
    this.state.manifest = mergeManifestDelta(this.state.manifest, manifest);
  }

  async persistWorkspace(): Promise<Uint8Array> {
    return await createWorkspaceArchive(
      this.state.workspaceRootPath,
      this.state.manifest.ephemeralPersistencePaths(),
    );
  }

  async hydrateWorkspace(
    data: string | ArrayBuffer | Uint8Array,
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    await restoreWorkspaceArchive(data, this.state.workspaceRootPath, {
      archiveLimits:
        options.archiveLimits === undefined
          ? this.archiveLimits
          : options.archiveLimits,
    });
    await this.materializeRestoredWorkspaceMounts();
  }

  async stop(): Promise<void> {
    await this.stopActiveProcesses();
  }

  async shutdown(): Promise<void> {
    await this.close();
  }

  async delete(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.stopActiveProcesses();

    if (this.state.workspaceRootOwned) {
      await rm(this.state.workspaceRootPath, { recursive: true, force: true });
    }
  }

  private async stopActiveProcesses(): Promise<void> {
    await Promise.all(
      [...this.activeProcesses.values()].map(async (activeProcess) => {
        if (!activeProcess.done) {
          activeProcess.child.kill('SIGTERM');
          await waitForProcessOrTimeout(activeProcess, 250);
        }
        if (!activeProcess.done) {
          activeProcess.child.kill('SIGKILL');
          await activeProcess.donePromise.catch(() => {});
        }
      }),
    );
    this.activeProcesses.clear();
  }

  resolveSandboxPath(
    path?: string,
    options: ResolveSandboxPathOptions = {},
  ): string {
    const resolved = this.resolveSandboxPathTarget(path, options);
    const workspaceRelativePath = resolved.workspaceRelativePath ?? '';
    if (!workspaceRelativePath && !resolved.grant) {
      return this.state.workspaceRootPath;
    }
    if (resolved.grant) {
      return validateResolvedHostPath({
        path,
        resolvedPath: resolved.path,
        allowedRoot: resolved.grant.path,
      });
    }

    const mountPath = this.resolveLocalBindMountPath(
      workspaceRelativePath,
      path,
      options,
    );
    if (mountPath) {
      return mountPath;
    }

    const resolvedPath = resolve(
      this.state.workspaceRootPath,
      workspaceRelativePath,
    );
    const relativeToRoot = relative(this.state.workspaceRootPath, resolvedPath);
    if (relativeHostPathEscapesRoot(relativeToRoot)) {
      throw new UserError(`Sandbox path "${path}" escapes the workspace root.`);
    }
    return validateResolvedHostPath({
      path,
      resolvedPath,
      allowedRoot: this.state.workspaceRootPath,
    });
  }

  protected resolveCommandWorkdir(path?: string): string {
    return this.resolveSandboxPath(path);
  }

  private resolveSandboxPathTarget(
    path?: string,
    options: ResolveSandboxPathOptions = {},
  ): ResolvedSandboxPath {
    return new WorkspacePathPolicy({
      root: this.state.manifest.root,
      extraPathGrants: this.state.manifest.extraPathGrants,
    }).resolve(path, options);
  }

  private resolveLocalBindMountPath(
    workspaceRelativePath: string,
    path: string | undefined,
    options: ResolveSandboxPathOptions,
  ): string | undefined {
    for (const { entry, mountPath } of this.state.manifest.mountTargets()) {
      const source = localBindMountSource(entry);
      if (!source) {
        continue;
      }
      const mountRelativePath = new WorkspacePathPolicy({
        root: this.state.manifest.root,
      }).resolve(mountPath).workspaceRelativePath;
      if (typeof mountRelativePath !== 'string') {
        continue;
      }
      if (!pathWithinLogicalRoot(workspaceRelativePath, mountRelativePath)) {
        continue;
      }
      if (options.forWrite && entry.readOnly !== false) {
        throw new UserError(
          `Sandbox path "${path}" is inside a read-only local bind mount.`,
        );
      }
      const childPath =
        workspaceRelativePath === mountRelativePath
          ? ''
          : workspaceRelativePath.slice(mountRelativePath.length + 1);
      const resolvedPath = childPath ? resolve(source, childPath) : source;
      return validateResolvedHostPath({
        path,
        resolvedPath,
        allowedRoot: source,
      });
    }
    return undefined;
  }

  protected resolveLogicalPath(path?: string): string {
    if (!path || path.trim().length === 0) {
      return '';
    }

    const logicalRoot = this.state.manifest.root;
    const trimmed = path.trim();
    if (trimmed === logicalRoot) {
      return '';
    }

    if (logicalRoot === '/') {
      return normalizeRelativePath(
        trimmed.startsWith('/') ? trimmed.slice(1) : trimmed,
      );
    }

    if (trimmed.startsWith(`${logicalRoot}/`)) {
      return normalizeRelativePath(trimmed.slice(logicalRoot.length + 1));
    }

    if (trimmed.startsWith('/')) {
      throw new UserError(
        `Sandbox path "${path}" must stay within ${logicalRoot}.`,
      );
    }

    return normalizeRelativePath(trimmed);
  }

  protected async spawnShellCommand(
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
    const { shellPath, flag } = resolveLocalShellCommand({
      shell: args.shell,
      defaultShell: this.defaultShell,
      envShell: process.env.SHELL,
      login: args.login,
    });
    const runAs = await this.resolveCommandRunAs(args.runAs);
    const env = buildCommandEnvironment({
      environment: this.state.environment,
      shellPath,
      home: this.state.workspaceRootPath,
      pwd: args.logicalCwd,
    });
    if (args.tty) {
      return spawnInPseudoTerminal(shellPath, [flag, command], {
        cwd: args.cwd,
        env,
        ...(runAs
          ? {
              uid: runAs.uid,
              gid: runAs.gid,
            }
          : {}),
      });
    }

    return spawn(shellPath, [flag, command], {
      cwd: args.cwd,
      env,
      ...(runAs
        ? {
            uid: runAs.uid,
            gid: runAs.gid,
          }
        : {}),
      stdio: 'pipe',
    });
  }

  protected translateCommandInput(command: string): string {
    // Unix-local is not a chroot; command rewriting preserves manifest-root UX while
    // filesystem APIs continue to enforce host-path containment separately.
    if (this.state.manifest.root === '/') {
      return translateRootManifestCommandInput(
        command,
        this.state.workspaceRootPath,
      );
    }
    return translateManifestRootCommandInput(
      command,
      this.state.manifest.root,
      this.state.workspaceRootPath,
    );
  }

  protected translateCommandOutput(output: string): string {
    if (this.state.manifest.root === '/') {
      return translateRootManifestCommandOutput(
        output,
        this.state.workspaceRootPath,
      );
    }
    return translateManifestRootCommandOutput(
      output,
      this.state.manifest.root,
      this.state.workspaceRootPath,
    );
  }

  protected async materializeRestoredWorkspaceMounts(): Promise<void> {
    await materializeLocalWorkspaceManifestMounts(
      this.state.manifest,
      this.state.workspaceRootPath,
    );
  }

  protected logicalWorkdirForPath(path?: string): string {
    return this.resolveSandboxPathTarget(path).path;
  }

  protected async resolveCommandRunAs(
    runAs?: string,
  ): Promise<UnixRunAsIdentity | undefined> {
    const identity = await this.resolveRunAsIdentity(runAs);
    if (!identity || identity.isCurrentUser) {
      return identity;
    }
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      throw new UserError(
        `Unix-local sandbox runAs="${runAs}" requires the host process to run as root or the requested user.`,
      );
    }
    return identity;
  }

  async resolveFilesystemRunAs(
    runAs?: string,
  ): Promise<UnixRunAsIdentity | undefined> {
    const identity = await this.resolveRunAsIdentity(runAs);
    if (!identity || identity.isCurrentUser) {
      return identity;
    }
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      throw new UserError(
        `Unix-local sandbox filesystem operations cannot honor runAs="${runAs}" without root privileges.`,
      );
    }
    return identity;
  }

  protected async resolveRunAsIdentity(
    runAs?: string,
  ): Promise<UnixRunAsIdentity | undefined> {
    if (!runAs || runAs.trim().length === 0) {
      return undefined;
    }

    const requestedUser = runAs.trim();
    const currentUser = userInfo().username;
    const currentUid =
      typeof process.getuid === 'function' ? process.getuid() : undefined;
    const currentGid =
      typeof process.getgid === 'function' ? process.getgid() : undefined;

    if (
      requestedUser === currentUser &&
      currentUid !== undefined &&
      currentGid !== undefined
    ) {
      return {
        username: currentUser,
        uid: currentUid,
        gid: currentGid,
        isCurrentUser: true,
      };
    }

    const [uidResult, gidResult] = await Promise.all([
      runSandboxProcess('id', ['-u', requestedUser], {
        timeoutMs: RUN_AS_LOOKUP_TIMEOUT_MS,
      }),
      runSandboxProcess('id', ['-g', requestedUser], {
        timeoutMs: RUN_AS_LOOKUP_TIMEOUT_MS,
      }),
    ]);
    if (uidResult.status !== 0 || gidResult.status !== 0) {
      throw new UserError(
        `Sandbox runAs user "${requestedUser}" could not be resolved on this host.`,
      );
    }

    const uid = Number(uidResult.stdout.trim());
    const gid = Number(gidResult.stdout.trim());
    return {
      username: requestedUser,
      uid,
      gid,
      isCurrentUser:
        currentUid !== undefined &&
        currentGid !== undefined &&
        uid === currentUid &&
        gid === currentGid,
    };
  }

  private trackChildProcess(
    child: ChildProcessWithoutNullStreams,
    options: { tty?: boolean } = {},
  ): ActiveProcess {
    let resolveDone = () => {};
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let resolveOutputClosed = () => {};
    const outputClosedPromise = new Promise<void>((resolve) => {
      resolveOutputClosed = resolve;
    });

    const activeProcess: ActiveProcess = {
      child,
      tty: options.tty ?? false,
      output: '',
      stdout: '',
      stderr: '',
      droppedOutputChars: 0,
      droppedStdoutChars: 0,
      droppedStderrChars: 0,
      exitCode: null,
      done: false,
      donePromise,
      resolveDone,
      outputClosedPromise,
      resolveOutputClosed,
    };
    let openOutputStreams = 2;
    const markOutputStreamClosed = () => {
      openOutputStreams -= 1;
      if (openOutputStreams === 0) {
        activeProcess.resolveOutputClosed();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      appendActiveProcessOutput(activeProcess, chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: string) => {
      appendActiveProcessOutput(activeProcess, chunk, 'stderr');
    });
    child.stdout.once('close', markOutputStreamClosed);
    child.stderr.once('close', markOutputStreamClosed);
    child.on('close', (code, signal) => {
      activeProcess.exitCode = code ?? signalToExitCode(signal);
      activeProcess.done = true;
      activeProcess.resolveDone();
    });
    child.on('error', (error) => {
      appendActiveProcessOutput(activeProcess, `${error.message}\n`, 'stderr');
      activeProcess.exitCode = 1;
      activeProcess.done = true;
      activeProcess.resolveOutputClosed();
      activeProcess.resolveDone();
    });

    return activeProcess;
  }

  private allocateProcessId(activeProcess: ActiveProcess): number {
    const sessionId = this.nextSessionId++;
    this.activeProcesses.set(sessionId, activeProcess);
    return sessionId;
  }
}

export class UnixLocalSandboxClient implements SandboxClient<
  UnixLocalSandboxClientOptions,
  UnixLocalSandboxSessionState
> {
  readonly backendId = 'unix_local';
  readonly supportsDefaultOptions = true;
  private readonly options: UnixLocalSandboxClientOptions;

  constructor(options: UnixLocalSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<UnixLocalSandboxClientOptions> | Manifest,
    manifestOptions?: UnixLocalSandboxClientOptions,
  ): Promise<UnixLocalSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    const manifest = createArgs.manifest;
    const resolvedOptions = {
      ...this.options,
      ...createArgs.options,
      ...(createArgs.snapshot
        ? { snapshot: createArgs.snapshot as LocalSandboxSnapshotSpec }
        : {}),
      ...(createArgs.concurrencyLimits
        ? { concurrencyLimits: createArgs.concurrencyLimits }
        : {}),
      ...(createArgs.archiveLimits !== undefined
        ? { archiveLimits: createArgs.archiveLimits }
        : {}),
    };
    assertLocalWorkspaceManifestMetadataSupported(
      'UnixLocalSandboxClient',
      manifest,
    );
    const workspaceRootPath = await mkdtemp(
      join(
        resolvedOptions.workspaceBaseDir ?? tmpdir(),
        'openai-agents-sandbox-',
      ),
    );

    await materializeLocalWorkspaceManifest(manifest, workspaceRootPath, {
      concurrencyLimits: resolvedOptions.concurrencyLimits,
    });
    const environment = await manifest.resolveEnvironment();
    const configuredExposedPorts = normalizeExposedPorts(
      resolvedOptions.exposedPorts,
    );

    return new UnixLocalSandboxSession({
      state: {
        manifest,
        workspaceRootPath,
        workspaceRootOwned: true,
        environment,
        snapshotSpec: resolvedOptions.snapshot ?? null,
        snapshot: null,
        configuredExposedPorts,
      },
      defaultShell: resolvedOptions.defaultShell,
      archiveLimits: resolvedOptions.archiveLimits,
    });
  }

  async resume(
    state: UnixLocalSandboxSessionState,
    options: SandboxClientResumeOptions = {},
  ): Promise<UnixLocalSandboxSession> {
    const archiveLimits =
      options.archiveLimits === undefined
        ? this.options.archiveLimits
        : options.archiveLimits;
    const restoredState = await this.restoreIfNeeded(state, archiveLimits);
    return new UnixLocalSandboxSession({
      state: restoredState,
      defaultShell: this.options.defaultShell,
      archiveLimits,
    });
  }

  async serializeSessionState(
    state: UnixLocalSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    const snapshotSpec = state.snapshotSpec ?? this.options.snapshot ?? null;
    const snapshot = await persistLocalSnapshot(
      'UnixLocalSandboxClient',
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
      configuredExposedPorts: state.configuredExposedPorts ?? [],
      exposedPorts: state.exposedPorts ?? null,
    };
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<UnixLocalSandboxSessionState> {
    return deserializeLocalSandboxSessionStateValues(
      state,
      this.options.snapshot,
    );
  }

  private async restoreIfNeeded(
    state: UnixLocalSandboxSessionState,
    archiveLimits?: SandboxArchiveLimits | null,
  ): Promise<UnixLocalSandboxSessionState> {
    if (await pathExists(state.workspaceRootPath)) {
      if (await canReuseLocalSnapshotWorkspace(state)) {
        return state;
      }
      if (await localSnapshotIsRestorable(state)) {
        return await restoreSnapshotAndMounts(
          state,
          state.workspaceRootPath,
          archiveLimits,
        );
      }
      return state;
    }

    if (!(await localSnapshotIsRestorable(state))) {
      throw new UserError(
        'UnixLocal sandbox workspace is unavailable and no local snapshot could be restored.',
      );
    }

    const workspaceRootPath = await mkdtemp(
      join(this.options.workspaceBaseDir ?? tmpdir(), 'openai-agents-sandbox-'),
    );

    return await restoreSnapshotAndMounts(
      {
        ...state,
        workspaceRootPath,
        workspaceRootOwned: true,
      },
      workspaceRootPath,
      archiveLimits,
    );
  }
}

async function restoreSnapshotAndMounts(
  state: UnixLocalSandboxSessionState,
  workspaceRootPath: string,
  archiveLimits?: SandboxArchiveLimits | null,
): Promise<UnixLocalSandboxSessionState> {
  const restoredState = await restoreLocalSnapshotToWorkspace(
    state,
    workspaceRootPath,
    { archiveLimits },
  );
  await materializeLocalWorkspaceManifestMounts(
    restoredState.manifest,
    restoredState.workspaceRootPath,
  );
  return restoredState;
}

function localBindMountSource(entry: {
  mountStrategy?: { type: string };
  source?: unknown;
  type: string;
}): string | undefined {
  if (entry.type !== 'mount' || typeof entry.source !== 'string') {
    return undefined;
  }
  if (
    entry.mountStrategy !== undefined &&
    entry.mountStrategy.type !== 'local_bind'
  ) {
    return undefined;
  }
  return isAbsolute(entry.source) ? entry.source : undefined;
}

function pathWithinLogicalRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function validateResolvedHostPath(args: {
  path?: string;
  resolvedPath: string;
  allowedRoot: string;
}): string {
  const allowedRootRealPath = realpathForValidation(
    args.allowedRoot,
    args.path,
  );
  const existingPath = nearestExistingPath(args.resolvedPath);
  if (!existingPath) {
    throw new UserError(
      `Sandbox path "${args.path}" escapes the workspace root.`,
    );
  }
  const realPath = realpathForValidation(existingPath, args.path);
  if (!isHostPathWithinRoot(allowedRootRealPath, realPath)) {
    throw new UserError(
      `Sandbox path "${args.path}" escapes the workspace root.`,
    );
  }
  return args.resolvedPath;
}

function nearestExistingPath(path: string): string | undefined {
  let current = path;
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function realpathForValidation(path: string, originalPath?: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new UserError(
      `Sandbox path "${originalPath}" escapes the workspace root.`,
    );
  }
}

class UnixLocalSandboxEditor implements Editor {
  private readonly session: UnixLocalSandboxSession;
  private readonly runAs?: string;

  constructor(session: UnixLocalSandboxSession, runAs?: string) {
    this.session = session;
    this.runAs = runAs;
  }

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult> {
    const identity = await this.session.resolveFilesystemRunAs(this.runAs);
    const filePath = this.session.resolveSandboxPath(operation.path, {
      forWrite: true,
    });
    await mkdir(dirname(filePath), { recursive: true });
    const content = applyDiff('', operation.diff, 'create');
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    if (identity) {
      await applyOwnershipRecursive(filePath, identity.uid, identity.gid);
    }
    return {};
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult> {
    const identity = await this.session.resolveFilesystemRunAs(this.runAs);
    const moveTo = operation.moveTo;
    const filePath = this.session.resolveSandboxPath(operation.path, {
      forWrite: true,
    });
    const destinationPath = moveTo
      ? this.session.resolveSandboxPath(moveTo, { forWrite: true })
      : filePath;
    const current = await readFile(filePath, 'utf8');
    const next = applyDiff(current, operation.diff);
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, next, 'utf8');
    if (moveTo && destinationPath !== filePath) {
      await unlink(filePath);
    }
    if (identity) {
      await applyOwnershipRecursive(
        destinationPath,
        identity.uid,
        identity.gid,
      );
    }
    return {};
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult> {
    await this.session.resolveFilesystemRunAs(this.runAs);
    const filePath = this.session.resolveSandboxPath(operation.path, {
      forWrite: true,
    });
    await unlink(filePath);
    return {};
  }
}

function buildCommandEnvironment(args: {
  environment: Record<string, string>;
  shellPath: string;
  home: string;
  pwd: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: DEFAULT_SANDBOX_COMMAND_PATH,
    HOME: args.home,
    USER: 'sandbox',
    LOGNAME: 'sandbox',
    SHELL: args.shellPath,
    TMPDIR: '/tmp',
    ...args.environment,
    PWD: args.pwd,
  };
}

function translateRootManifestCommandInput(
  command: string,
  workspaceRootPath: string,
): string {
  return command.replace(
    /(^|[\s"'=<>])\/([^\s"'|&;<>(){}]*)/g,
    (_match, prefix: string, pathSuffix: string) =>
      `${prefix}${workspaceRootPath}/${pathSuffix}`,
  );
}

function translateManifestRootCommandInput(
  command: string,
  manifestRoot: string,
  workspaceRootPath: string,
): string {
  const escapedManifestRoot = escapeRegExp(manifestRoot);
  const pathPrefix = String.raw`(^|[\s"'=<>])`;
  const pathSuffix = String.raw`(?=$|[\/\s"'|&;<>(){}])`;
  return command.replace(
    new RegExp(`${pathPrefix}${escapedManifestRoot}${pathSuffix}`, 'g'),
    (_match, prefix: string) => `${prefix}${workspaceRootPath}`,
  );
}

function translateRootManifestCommandOutput(
  output: string,
  workspaceRootPath: string,
): string {
  return translateWorkspaceRootCommandOutput(output, '/', workspaceRootPath);
}

function translateManifestRootCommandOutput(
  output: string,
  manifestRoot: string,
  workspaceRootPath: string,
): string {
  return translateWorkspaceRootCommandOutput(
    output,
    manifestRoot,
    workspaceRootPath,
  );
}

function translateWorkspaceRootCommandOutput(
  output: string,
  manifestRoot: string,
  workspaceRootPath: string,
): string {
  const nestedPathReplacement = manifestRoot === '/' ? '/' : `${manifestRoot}/`;
  let translated = output;
  for (const path of workspaceRootOutputPaths(workspaceRootPath)) {
    translated = translated
      .split(`${path}/`)
      .join(nestedPathReplacement)
      .split(path)
      .join(manifestRoot);
  }
  return translated;
}

function workspaceRootOutputPaths(workspaceRootPath: string): string[] {
  const paths = [workspaceRootPath];
  try {
    paths.push(realpathSync(workspaceRootPath));
  } catch {
    return paths;
  }
  return Array.from(new Set(paths)).sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type ActiveProcessOutputStream = 'stdout' | 'stderr';

type ConsumedActiveProcessOutput = {
  output: string;
  stdout: string;
  stderr: string;
};

function appendActiveProcessOutput(
  activeProcess: ActiveProcess,
  chunk: string,
  stream: ActiveProcessOutputStream,
): void {
  if (chunk.length === 0) {
    return;
  }

  const combined = appendBoundedOutput(
    activeProcess.output,
    activeProcess.droppedOutputChars,
    chunk,
  );
  activeProcess.output = combined.output;
  activeProcess.droppedOutputChars = combined.droppedChars;

  if (stream === 'stdout') {
    const stdout = appendBoundedOutput(
      activeProcess.stdout,
      activeProcess.droppedStdoutChars,
      chunk,
    );
    activeProcess.stdout = stdout.output;
    activeProcess.droppedStdoutChars = stdout.droppedChars;
    return;
  }

  const stderr = appendBoundedOutput(
    activeProcess.stderr,
    activeProcess.droppedStderrChars,
    chunk,
  );
  activeProcess.stderr = stderr.output;
  activeProcess.droppedStderrChars = stderr.droppedChars;
}

function appendBoundedOutput(
  output: string,
  droppedChars: number,
  chunk: string,
): { output: string; droppedChars: number } {
  const nextLength = output.length + chunk.length;
  if (nextLength <= MAX_ACTIVE_PROCESS_OUTPUT_CHARS) {
    return {
      output: output + chunk,
      droppedChars,
    };
  }

  const nextDroppedChars =
    droppedChars + nextLength - MAX_ACTIVE_PROCESS_OUTPUT_CHARS;
  if (chunk.length >= MAX_ACTIVE_PROCESS_OUTPUT_CHARS) {
    return {
      output: chunk.slice(-MAX_ACTIVE_PROCESS_OUTPUT_CHARS),
      droppedChars: nextDroppedChars,
    };
  }

  const existingCharsToKeep = MAX_ACTIVE_PROCESS_OUTPUT_CHARS - chunk.length;
  return {
    output: output.slice(-existingCharsToKeep) + chunk,
    droppedChars: nextDroppedChars,
  };
}

function consumeActiveProcessOutput(
  activeProcess: ActiveProcess,
): ConsumedActiveProcessOutput {
  const output = withDroppedOutputPrefix(
    activeProcess.output,
    activeProcess.droppedOutputChars,
  );
  const stdout = withDroppedOutputPrefix(
    activeProcess.stdout,
    activeProcess.droppedStdoutChars,
  );
  const stderr = withDroppedOutputPrefix(
    activeProcess.stderr,
    activeProcess.droppedStderrChars,
  );
  activeProcess.output = '';
  activeProcess.stdout = '';
  activeProcess.stderr = '';
  activeProcess.droppedOutputChars = 0;
  activeProcess.droppedStdoutChars = 0;
  activeProcess.droppedStderrChars = 0;

  return { output, stdout, stderr };
}

function withDroppedOutputPrefix(output: string, droppedChars: number): string {
  if (droppedChars === 0) {
    return output;
  }

  return `[...${droppedChars} characters truncated from process output...]\n${output}`;
}

async function waitForProcessOrTimeout(
  activeProcess: ActiveProcess,
  timeoutMs: number,
): Promise<void> {
  if (activeProcess.done) {
    return;
  }

  await Promise.race([
    activeProcess.donePromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (activeProcess.done) {
    await activeProcess.outputClosedPromise;
  }
}

function signalToExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') {
    return 130;
  }
  return 1;
}
