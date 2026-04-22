import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  E2BCloudBucketMountStrategy,
  E2BSandboxClient,
  type E2BSandboxClientOptions,
} from '../../src/sandbox/e2b';
import { decodeNativeSnapshotRef } from '../../src/sandbox/shared';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const processMocks = vi.hoisted(() => ({
  runSandboxProcess: vi.fn(),
}));
const createMock = vi.fn();
const connectMock = vi.fn();
const runMock = vi.fn();
const writeMock = vi.fn();
const readMock = vi.fn();
const removeMock = vi.fn();
const makeDirMock = vi.fn();
const getHostMock = vi.fn();
const createSnapshotMock = vi.fn();
const killMock = vi.fn();
const pauseMock = vi.fn();
const files = new Map<string, string | Uint8Array>();

vi.mock('e2b', () => ({
  Sandbox: {
    create: createMock,
    connect: connectMock,
  },
}));

vi.mock('../../src/sandbox/shared/process', () => ({
  runSandboxProcess: processMocks.runSandboxProcess,
  formatSandboxProcessError: (result: {
    stderr?: string;
    stdout?: string;
    error?: Error;
  }) => result.stderr || result.stdout || result.error?.message || 'failed',
}));

const processSuccess = (stdout = '') => ({
  status: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
});

const processFailure = (stderr: string) => ({
  status: 1,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false,
});

describe('E2BSandboxClient', () => {
  beforeEach(() => {
    files.clear();
    createMock.mockReset();
    connectMock.mockReset();
    runMock.mockReset();
    writeMock.mockReset();
    readMock.mockReset();
    removeMock.mockReset();
    makeDirMock.mockReset();
    getHostMock.mockReset();
    createSnapshotMock.mockReset();
    killMock.mockReset();
    pauseMock.mockReset();
    processMocks.runSandboxProcess.mockReset();

    writeMock.mockImplementation(
      async (path: string, data: string | Uint8Array) => {
        files.set(path, data);
      },
    );
    readMock.mockImplementation(
      async (path: string, opts?: { format?: 'text' | 'bytes' }) => {
        const value = files.get(path) ?? '';
        if (opts?.format === 'bytes') {
          return typeof value === 'string'
            ? new TextEncoder().encode(value)
            : value;
        }
        return typeof value === 'string'
          ? value
          : new TextDecoder().decode(value);
      },
    );
    removeMock.mockImplementation(async (path: string) => {
      files.delete(path);
    });
    createMock.mockResolvedValue({
      sandboxId: 'sbx_test',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: killMock,
      pause: pauseMock,
    });
    connectMock.mockResolvedValue({
      sandboxId: 'sbx_test',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: killMock,
      pause: pauseMock,
    });
    runMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return {
          stdout: `${resolvedPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (command === 'ls') {
        return {
          stdout: 'README.md\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.startsWith('test -e ')) {
        const path = command.match(/^test -e '(.+)'$/)?.[1] ?? '';
        return {
          stdout: '',
          stderr: '',
          exitCode: files.has(path) ? 0 : 1,
        };
      }
      if (command.startsWith('base64 -- ')) {
        const path = command.match(/^base64 -- '(.+)'$/)?.[1] ?? '';
        const value = files.get(path) ?? new Uint8Array();
        const bytes =
          typeof value === 'string' ? new TextEncoder().encode(value) : value;
        return {
          stdout: `${Buffer.from(bytes).toString('base64')}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    });
    pauseMock.mockResolvedValue(true);
    createSnapshotMock.mockResolvedValue({ snapshotId: 'snap_test' });
    killMock.mockResolvedValue(undefined);
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new E2BSandboxClient();

    await expect(
      client.create({
        manifest: new Manifest(),
        snapshot: { type: 'remote' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    await expect(
      client.create({
        manifest: new Manifest(),
        concurrencyLimits: { manifestEntries: 2 },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('creates a sandbox, materializes the manifest, and executes commands', async () => {
    const client = new E2BSandboxClient();
    const manifest = new Manifest({
      entries: {
        'README.md': {
          type: 'file',
          content: '# Hello\n',
        },
      },
    });

    const session = await client.create(manifest);
    const output = await session.execCommand({ cmd: 'ls' });

    expect(createMock).toHaveBeenCalledOnce();
    expect(makeDirMock).toHaveBeenCalledWith('/workspace');
    expect(runMock).toHaveBeenCalledWith("mkdir -p -- '/workspace'", {
      cwd: '/',
      envs: {},
    });
    expect(writeMock).toHaveBeenCalledWith('/workspace/README.md', '# Hello\n');
    expect(runMock).toHaveBeenCalledWith('ls', {
      cwd: '/workspace',
      envs: {},
      timeoutMs: undefined,
      user: undefined,
    });
    expect(output).toContain('Process exited with code 0');
    expect(output).toContain('README.md');
  });

  test('treats missing command exit codes as failures', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());
    runMock.mockResolvedValueOnce({
      stdout: 'lost exit\n',
      stderr: '',
      exitCode: null,
    });

    const output = await session.execCommand({ cmd: 'lost-exit' });

    expect(output).toContain('Process exited with code 1');
    expect(output).toContain('lost exit');
  });

  test('formats non-zero command errors returned by the E2B SDK', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());
    runMock.mockRejectedValueOnce(
      Object.assign(new Error('command failed'), {
        stdout: 'partial\n',
        stderr: 'boom\n',
        exitCode: 2,
      }),
    );

    const output = await session.execCommand({ cmd: 'bad-command' });

    expect(output).toContain('Process exited with code 2');
    expect(output).toContain('partial');
    expect(output).toContain('boom');
  });

  test('materializes git_repo file subpaths as files', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === '--version') {
          return processSuccess('git version 2.0.0');
        }
        if (args[0] === 'clone') {
          const tempDir = args[args.length - 1];
          await mkdir(join(tempDir, 'nested'), { recursive: true });
          await writeFile(join(tempDir, 'nested', 'selected.txt'), 'selected');
          return processSuccess();
        }
        return processFailure('unexpected command');
      },
    );
    const client = new E2BSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          'selected.txt': {
            type: 'git_repo',
            repo: 'https://example.test/repo.git',
            subpath: 'nested/selected.txt',
          },
        },
      }),
    );

    expect(Buffer.from(files.get('/workspace/selected.txt')!)).toEqual(
      Buffer.from('selected'),
    );
  });

  test('passes template, timeout, and pauseOnExit options through', async () => {
    const client = new E2BSandboxClient({
      template: 'base',
      timeout: 30,
      pauseOnExit: true,
    } satisfies E2BSandboxClientOptions);
    const manifest = new Manifest();

    const session = await client.create(manifest);
    await session.close();

    expect(createMock).toHaveBeenCalledWith('base', {
      timeoutMs: 30000,
      lifecycle: {
        onTimeout: 'pause',
        autoResume: true,
      },
    });
    expect(pauseMock).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
  });

  test('delete terminates even when pauseOnExit is enabled', async () => {
    const client = new E2BSandboxClient({
      pauseOnExit: true,
    } satisfies E2BSandboxClientOptions);
    const session = await client.create(new Manifest());

    await session.delete();

    expect(pauseMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledOnce();
  });

  test('cleanup lifecycle pauses persistable sessions instead of killing them', async () => {
    const client = new E2BSandboxClient({
      pauseOnExit: true,
    } satisfies E2BSandboxClientOptions);
    const session = await client.create(new Manifest());

    await session.shutdown({ reason: 'cleanup' });
    await session.delete({ reason: 'cleanup' });

    expect(pauseMock).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
  });

  test('kills the sandbox when close cannot pause a persistable session', async () => {
    pauseMock.mockRejectedValueOnce(new Error('pause failed'));
    const client = new E2BSandboxClient({
      pauseOnExit: true,
    } satisfies E2BSandboxClientOptions);
    const session = await client.create(new Manifest());

    await session.close();

    expect(pauseMock).toHaveBeenCalledOnce();
    expect(killMock).toHaveBeenCalledOnce();
  });

  test('kills the sandbox when cleanup delete cannot pause a persistable session', async () => {
    pauseMock.mockRejectedValueOnce(new Error('pause failed'));
    const client = new E2BSandboxClient({
      pauseOnExit: true,
    } satisfies E2BSandboxClientOptions);
    const session = await client.create(new Manifest());

    await session.delete({ reason: 'cleanup' });

    expect(pauseMock).toHaveBeenCalledOnce();
    expect(killMock).toHaveBeenCalledOnce();
  });

  test('does not persist owned state when pauseOnExit is unsupported', async () => {
    createMock.mockResolvedValueOnce({
      sandboxId: 'sbx_test',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: killMock,
    });
    const client = new E2BSandboxClient({
      pauseOnExit: true,
    } satisfies E2BSandboxClientOptions);
    const session = await client.create(new Manifest());

    expect(session.state.pauseOnExitSupported).toBe(false);
    expect(client.canPersistOwnedSessionState(session.state)).toBe(false);

    await session.close();

    expect(pauseMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledOnce();
  });

  test('does not terminate twice across shutdown and delete lifecycle', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());

    await session.shutdown();
    await session.delete();

    expect(killMock).toHaveBeenCalledOnce();
  });

  test('passes SDK create options through without forwarding workspace persistence', async () => {
    const client = new E2BSandboxClient({
      workspacePersistence: 'tar',
      metadata: { owner: 'tests' },
      secure: true,
      allowInternetAccess: false,
      exposedPorts: [3000],
      onTimeout: 'pause',
      autoResume: true,
      mcp: { servers: [] },
      requestTimeoutMs: 1000,
      connectionTimeoutMs: 2000,
      commandTimeoutMs: 3000,
    } satisfies E2BSandboxClientOptions);

    const session = await client.create(new Manifest());
    await session.execCommand({ cmd: 'ls' });

    expect(createMock).toHaveBeenCalledWith({
      metadata: { owner: 'tests' },
      secure: true,
      allowInternetAccess: false,
      network: { allowPublicTraffic: true },
      lifecycle: {
        onTimeout: 'pause',
        autoResume: true,
      },
      mcp: { servers: [] },
      requestTimeoutMs: 1000,
      connectionTimeoutMs: 2000,
      commandTimeoutMs: 3000,
    });
    expect(runMock).toHaveBeenLastCalledWith('ls', {
      cwd: '/workspace',
      envs: {},
      timeoutMs: 3000,
      user: undefined,
    });
  });

  test('maps legacy timeoutAction to lifecycle and omits autoResume for kill', async () => {
    const client = new E2BSandboxClient({
      timeoutAction: 'kill',
      autoResume: true,
    } satisfies E2BSandboxClientOptions);

    await client.create(new Manifest());

    expect(createMock).toHaveBeenCalledWith({
      lifecycle: {
        onTimeout: 'kill',
      },
    });
  });

  test('rejects invalid workspace persistence before creating a sandbox', async () => {
    const client = new E2BSandboxClient({
      workspacePersistence: 'native',
    } as unknown as E2BSandboxClientOptions);

    await expect(client.create(new Manifest())).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects unsupported PTY execution with a typed error', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'sh', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('supports PTY execution and stdin when the E2B SDK exposes PTY APIs', async () => {
    let onData!: (data: Uint8Array) => void;
    let finishWait!: (result: { exitCode: number }) => void;
    const ptyCreateMock = vi.fn(async (options: Record<string, unknown>) => {
      onData = options.onData as (data: Uint8Array) => void;
      return {
        pid: 42,
        wait: async () =>
          await new Promise<{ exitCode: number }>((resolve) => {
            finishWait = resolve;
          }),
        kill: async () => true,
      };
    });
    const ptySendInputMock = vi.fn(async (_pid: number, data: Uint8Array) => {
      onData(new TextEncoder().encode(new TextDecoder().decode(data)));
    });
    createMock.mockResolvedValueOnce({
      sandboxId: 'sbx_test',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      pty: {
        create: ptyCreateMock,
        sendInput: ptySendInputMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: killMock,
      pause: pauseMock,
    });
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());

    const started = await session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const next = await session.writeStdin({
      sessionId,
      chars: 'echo next\n',
      yieldTimeMs: 250,
    });
    finishWait({ exitCode: 0 });
    const done = await session.writeStdin({
      sessionId,
      yieldTimeMs: 250,
    });

    expect(next).toContain('echo next');
    expect(done).toContain('Process exited with code 0');
    expect(ptyCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspace',
        envs: {},
      }),
    );
    expect(ptySendInputMock).toHaveBeenCalledWith(
      42,
      new TextEncoder().encode("/bin/sh -c 'echo ready'\n"),
      expect.objectContaining({
        requestTimeoutMs: undefined,
      }),
    );
  });

  test('terminates PTY execution when the initial stdin write fails', async () => {
    const handleKillMock = vi.fn(async () => true);
    const ptyCreateMock = vi.fn(async () => ({
      pid: 42,
      wait: async () => ({ exitCode: 1 }),
      kill: handleKillMock,
    }));
    const ptySendInputMock = vi.fn(async () => {
      throw new Error('stdin unavailable');
    });
    createMock.mockResolvedValueOnce({
      sandboxId: 'sbx_test',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      pty: {
        create: ptyCreateMock,
        sendInput: ptySendInputMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: killMock,
      pause: pauseMock,
    });
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'echo ready', tty: true }),
    ).rejects.toThrow('stdin unavailable');

    expect(ptySendInputMock).toHaveBeenCalledOnce();
    expect(handleKillMock).toHaveBeenCalledOnce();
  });

  test('rejects runAs for PTY execution', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'id', tty: true, runAs: 'root' }),
    ).rejects.toMatchObject({
      details: {
        provider: 'e2b',
        feature: 'tty.runAs',
      },
    });
  });

  test('serializes state and reconnects paused sandboxes by id', async () => {
    const client = new E2BSandboxClient({
      pauseOnExit: true,
      env: {
        CLIENT_ONLY: 'override',
      },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          MANIFEST_FLAG: 'enabled',
        },
      }),
    );

    const serialized = await client.serializeSessionState(session.state);
    const restored = await client.deserializeSessionState(serialized);
    const resumed = await client.resume(restored);

    expect(client.canPersistOwnedSessionState(session.state)).toBe(true);
    expect(restored.pauseOnExitSupported).toBe(true);
    expect(connectMock).toHaveBeenCalledWith('sbx_test', undefined);
    expect(resumed.state.environment).toEqual({
      CLIENT_ONLY: 'override',
      MANIFEST_FLAG: 'enabled',
    });
  });

  test('recreates sandboxes when reconnect reports missing sandbox', async () => {
    const client = new E2BSandboxClient({
      pauseOnExit: true,
      template: 'base',
    });
    const session = await client.create(new Manifest());
    createMock.mockClear();
    connectMock.mockRejectedValueOnce(new Error('not found'));

    const recreated = await client.resume(session.state);

    expect(connectMock).toHaveBeenCalledWith('sbx_test', undefined);
    expect(createMock).toHaveBeenCalledWith('base', {
      lifecycle: {
        onTimeout: 'pause',
        autoResume: true,
      },
    });
    expect(recreated.state.sandboxId).toBe('sbx_test');
  });

  test('fails fast when reconnect fails with a provider error', async () => {
    const client = new E2BSandboxClient({
      pauseOnExit: true,
      template: 'base',
    });
    const session = await client.create(new Manifest());
    createMock.mockClear();
    connectMock.mockRejectedValueOnce(new Error('request timeout'));

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'e2b',
      operation: 'resume',
      sandboxId: 'sbx_test',
      cause: 'request timeout',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  test('persists and hydrates tar workspaces', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    runMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return {
          stdout: `${resolvedPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      const archivePath = command.match(/-cf '([^']+)'/)?.[1];
      if (archivePath) {
        files.set(archivePath, archive);
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    });
    const client = new E2BSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(new Manifest());

    await expect(session.persistWorkspace()).resolves.toEqual(archive);
    await session.hydrateWorkspace(archive);

    expect(readMock).toHaveBeenCalledWith(expect.any(String), {
      format: 'bytes',
    });
    expect(writeMock).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/openai-agents-e2bsandboxclient-'),
      archive,
    );
    expect(
      runMock.mock.calls.some(([command]) =>
        String(command).includes('tar -C'),
      ),
    ).toBe(true);
  });

  test('persists native snapshots and restores them through E2B templates', async () => {
    const client = new E2BSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(new Manifest());

    const ref = decodeNativeSnapshotRef(await session.persistWorkspace());

    expect(ref).toEqual({
      provider: 'e2b',
      snapshotId: 'snap_test',
      workspacePersistence: undefined,
    });

    createMock.mockResolvedValueOnce({
      sandboxId: 'sbx_restored',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: killMock,
      pause: pauseMock,
    });

    await session.hydrateWorkspace(await session.persistWorkspace());

    expect(createMock).toHaveBeenLastCalledWith('snap_test', {
      lifecycle: {
        onTimeout: 'pause',
        autoResume: true,
      },
    });
    expect(session.state.sandboxId).toBe('sbx_restored');
    expect(killMock).toHaveBeenCalledOnce();
  });

  test('clears cached exposed ports after restoring a native snapshot sandbox', async () => {
    getHostMock
      .mockReturnValueOnce('3000-sbx-test.e2b.dev')
      .mockReturnValueOnce('3000-sbx-restored.e2b.dev');
    const client = new E2BSandboxClient({
      exposedPorts: [3000],
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(new Manifest());
    const initialEndpoint = await session.resolveExposedPort(3000);
    const snapshot = await session.persistWorkspace();
    createMock.mockResolvedValueOnce({
      sandboxId: 'sbx_restored',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: killMock,
      pause: pauseMock,
    });

    await session.hydrateWorkspace(snapshot);
    const restoredEndpoint = await session.resolveExposedPort(3000);

    expect(initialEndpoint.host).toBe('3000-sbx-test.e2b.dev');
    expect(session.state.sandboxId).toBe('sbx_restored');
    expect(restoredEndpoint.host).toBe('3000-sbx-restored.e2b.dev');
    expect(getHostMock).toHaveBeenCalledTimes(2);
    expect(session.state.exposedPorts?.['3000']).toBe(restoredEndpoint);
  });

  test('keeps previous sandbox state when native snapshot restore cannot kill the old sandbox', async () => {
    const client = new E2BSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(new Manifest());
    const snapshot = await session.persistWorkspace();
    const restoredKillMock = vi.fn().mockResolvedValue(undefined);
    createMock.mockResolvedValueOnce({
      sandboxId: 'sbx_restored',
      commands: {
        run: runMock,
      },
      files: {
        write: writeMock,
        read: readMock,
        remove: removeMock,
        makeDir: makeDirMock,
      },
      getHost: getHostMock,
      createSnapshot: createSnapshotMock,
      kill: restoredKillMock,
      pause: pauseMock,
    });
    killMock.mockRejectedValueOnce(new Error('kill failed'));

    await expect(session.hydrateWorkspace(snapshot)).rejects.toMatchObject({
      details: {
        provider: 'e2b',
        operation: 'restore snapshot',
        sandboxId: 'sbx_test',
        replacementSandboxId: 'sbx_restored',
        snapshotId: 'snap_test',
        cause: 'kill failed',
      },
    });

    expect(restoredKillMock).toHaveBeenCalledOnce();
    expect(session.state.sandboxId).toBe('sbx_test');
    await session.execCommand({ cmd: 'ls' });
    expect(runMock).toHaveBeenLastCalledWith('ls', {
      cwd: '/workspace',
      envs: {},
      timeoutMs: undefined,
      user: undefined,
    });
  });

  test('falls back to tar snapshots when native snapshots cannot exclude ephemeral paths', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    runMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return {
          stdout: `${resolvedPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      const archivePath = command.match(/-cf '([^']+)'/)?.[1];
      if (archivePath) {
        files.set(archivePath, archive);
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    });
    const client = new E2BSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'tmp.txt': {
            type: 'file',
            content: 'tmp',
            ephemeral: true,
          },
        },
      }),
    );

    await expect(session.persistWorkspace()).resolves.toEqual(archive);
    expect(createSnapshotMock).not.toHaveBeenCalled();
  });

  test('falls back to tar snapshots when the workspace root is ephemeral', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    runMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return {
          stdout: `${resolvedPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      const archivePath = command.match(/-cf '([^']+)'/)?.[1];
      if (archivePath) {
        files.set(archivePath, archive);
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    });
    const client = new E2BSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          '': {
            type: 'dir',
            ephemeral: true,
          },
        },
      }),
    );

    await expect(session.persistWorkspace()).resolves.toEqual(archive);
    expect(createSnapshotMock).not.toHaveBeenCalled();
  });

  test('resolves configured exposed ports through E2B hosts', async () => {
    getHostMock.mockReturnValue('3000-sbx-test.e2b.dev');
    const client = new E2BSandboxClient({
      exposedPorts: [3000],
    });

    const session = await client.create(new Manifest());
    const endpoint = await session.resolveExposedPort(3000);
    const cachedEndpoint = await session.resolveExposedPort(3000);

    expect(createMock).toHaveBeenCalledWith({
      lifecycle: {
        onTimeout: 'pause',
        autoResume: true,
      },
      network: { allowPublicTraffic: true },
    });
    expect(getHostMock).toHaveBeenCalledWith(3000);
    expect(getHostMock).toHaveBeenCalledOnce();
    expect(endpoint).toMatchObject({
      host: '3000-sbx-test.e2b.dev',
      port: 443,
      tls: true,
    });
    expect(cachedEndpoint).toBe(endpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('rejects unsupported manifest metadata before creating a sandbox', async () => {
    const client = new E2BSandboxClient();

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
      ),
    ).rejects.toThrow(/does not support extra path grants yet/);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('provisions manifest accounts and applies entry metadata', async () => {
    const client = new E2BSandboxClient();

    await client.create(
      new Manifest({
        users: [{ name: 'sandbox-user' }],
        groups: [
          {
            name: 'sandbox-group',
            users: [{ name: 'sandbox-user' }],
          },
        ],
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'hello\n',
            group: { name: 'sandbox-group' },
            permissions: '-rw-r-----',
          },
        },
      }),
    );

    const commands = runMock.mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => command.includes('groupadd'))).toBe(true);
    expect(commands.some((command) => command.includes('useradd'))).toBe(true);
    expect(commands.some((command) => command.includes('usermod'))).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("chgrp 'sandbox-group'") &&
          command.includes("chmod 0640 -- '/workspace/notes.txt'"),
      ),
    ).toBe(true);
    expect(writeMock).toHaveBeenCalledWith('/workspace/notes.txt', 'hello\n');
  });

  test('preserves client env while manifest values take precedence', async () => {
    const client = new E2BSandboxClient({
      env: {
        CLIENT_ONLY: 'override',
        TOKEN: 'client',
      },
    });
    const manifest = new Manifest({
      environment: {
        MANIFEST_FLAG: 'enabled',
        TOKEN: 'manifest',
      },
    });

    const session = await client.create(manifest);
    expect(createMock).toHaveBeenCalledWith({
      lifecycle: {
        onTimeout: 'pause',
        autoResume: true,
      },
      envs: {
        CLIENT_ONLY: 'override',
        MANIFEST_FLAG: 'enabled',
        TOKEN: 'manifest',
      },
    });

    await session.applyManifest(
      new Manifest({
        environment: {
          MANIFEST_FLAG: 'updated',
          EXTRA_FLAG: 'present',
          TOKEN: 'manifest-updated',
        },
      }),
    );
    await session.execCommand({ cmd: 'ls' });

    expect(runMock).toHaveBeenCalledWith('ls', {
      cwd: '/workspace',
      envs: {
        CLIENT_ONLY: 'override',
        MANIFEST_FLAG: 'updated',
        EXTRA_FLAG: 'present',
        TOKEN: 'manifest-updated',
      },
      timeoutMs: undefined,
      user: undefined,
    });
  });

  test('materializes a single lazy skill entry', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(
      new Manifest({
        remoteMountCommandAllowlist: ['cat'],
      }),
    );

    await session.materializeEntry?.({
      path: '.agents/lazy/SKILL.md',
      entry: {
        type: 'file',
        content: '# Lazy\n',
      },
    });

    expect(writeMock).toHaveBeenLastCalledWith(
      '/workspace/.agents/lazy/SKILL.md',
      '# Lazy\n',
    );
    expect(await session.pathExists('.agents/lazy/SKILL.md')).toBe(true);
    expect(session.state.manifest.remoteMountCommandAllowlist).toEqual(['cat']);
  });

  test('returns false when E2B throws for missing path existence checks', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());
    runMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return {
          stdout: `${resolvedPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.startsWith('test -e ')) {
        throw Object.assign(new Error('missing path'), {
          exitCode: 1,
          stderr: 'missing path',
        });
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    });

    await expect(session.pathExists('missing.txt')).resolves.toBe(false);
  });

  test('mounts cloud buckets with the E2B rclone mount strategy', async () => {
    const client = new E2BSandboxClient();

    const session = await client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'agent-logs',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountPath: 'mounted/logs',
            mountStrategy: new E2BCloudBucketMountStrategy(),
          },
        },
      }),
    );
    await session.close();

    expect(
      runMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
    expect(
      runMock.mock.calls.some(([command]) =>
        String(command).includes('/workspace/mounted/logs'),
      ),
    ).toBe(true);
    expect(
      runMock.mock.calls.some(([command]) =>
        String(command).includes('fusermount3 -u'),
      ),
    ).toBe(true);
  });

  test('continues mount setup when E2B throws for install probes', async () => {
    let rcloneProbeFailures = 0;
    runMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return {
          stdout: `${resolvedPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (
        command.includes('command -v rclone') &&
        rcloneProbeFailures++ === 0
      ) {
        throw Object.assign(new Error('rclone missing'), {
          exitCode: 1,
          stderr: 'rclone missing',
        });
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    });
    const client = new E2BSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'agent-logs',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountPath: 'mounted/logs',
            mountStrategy: new E2BCloudBucketMountStrategy(),
          },
        },
      }),
    );

    expect(
      runMock.mock.calls.some(([command]) =>
        String(command).includes('command -v apt-get'),
      ),
    ).toBe(true);
    expect(
      runMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
  });

  test('reads images with runAs through remote commands', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'pixel.png': {
            type: 'file',
            content: '',
          },
        },
      }),
    );
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    files.set('/workspace/pixel.png', png);
    runMock.mockClear();

    const image = await session.viewImage({
      path: 'pixel.png',
      runAs: 'sandbox-user',
    });

    expect((image.image as { data: Uint8Array }).data).toEqual(png);
    expect(runMock).toHaveBeenCalledWith("base64 -- '/workspace/pixel.png'", {
      cwd: '/',
      envs: {},
      timeoutMs: undefined,
      user: 'sandbox-user',
    });
    expect(readMock).not.toHaveBeenCalled();
  });

  test('reads images through the E2B byte file format', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    files.set('/workspace/pixel.png', pngHeader);
    readMock.mockClear();

    const image = await session.viewImage({ path: 'pixel.png' });
    const payload = image.image as { data: Uint8Array; mediaType?: string };

    expect(readMock).toHaveBeenCalledWith('/workspace/pixel.png', {
      format: 'bytes',
    });
    expect(payload.mediaType).toBe('image/png');
    expect([...payload.data]).toEqual([...pngHeader]);
  });

  test('supports filesystem editor hooks with absolute workspace paths', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello\n',
          },
        },
      }),
    );
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected E2BSandboxSession.createEditor().');
    }

    await editor.updateFile({
      type: 'update_file',
      path: '/workspace/README.md',
      diff: '@@\n-# Hello\n+# Updated\n',
    });
    const exists = await session.pathExists?.('/workspace/README.md');

    expect(readMock).toHaveBeenCalledWith('/workspace/README.md');
    expect(writeMock).toHaveBeenLastCalledWith(
      '/workspace/README.md',
      '# Updated\n',
    );
    expect(exists).toBe(true);
    await expect(
      session.pathExists('/workspace/../tmp/README.md'),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test('supports filesystem and command runAs', async () => {
    const client = new E2BSandboxClient();
    const session = await client.create(new Manifest());

    expect(() => session.createEditor?.('sandbox-user')).not.toThrow();
    await expect(
      session.pathExists?.('/workspace/README.md', 'sandbox-user'),
    ).resolves.toBe(false);
    await expect(
      session.applyManifest?.(
        new Manifest({
          entries: {
            'owned.txt': {
              type: 'file',
              content: 'owned\n',
            },
          },
        }),
        'sandbox-user',
      ),
    ).resolves.toBeUndefined();
    expect(writeMock).toHaveBeenCalledWith('/workspace/owned.txt', 'owned\n');
    expect(runMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "chown 'sandbox-user':'sandbox-user' -- '/workspace/owned.txt'",
      ),
      expect.objectContaining({
        cwd: '/',
        user: undefined,
      }),
    );

    await session.execCommand({ cmd: 'ls', runAs: 'sandbox-user' });
    expect(runMock).toHaveBeenLastCalledWith('ls', {
      cwd: '/workspace',
      envs: {},
      timeoutMs: undefined,
      user: 'sandbox-user',
    });
  });
});
