import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DaytonaCloudBucketMountStrategy,
  DaytonaSandboxClient,
} from '../../src/sandbox/daytona';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';

const createMock = vi.fn();
const getMock = vi.fn();
const executeCommandMock = vi.fn();
const createPtyMock = vi.fn();
const createFolderMock = vi.fn();
const uploadFileMock = vi.fn();
const downloadFileMock = vi.fn();
const deleteFileMock = vi.fn();
const getSignedPreviewUrlMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const deleteMock = vi.fn();
const daytonaConstructorMock = vi.fn();

vi.mock('@daytonaio/sdk', () => ({
  Daytona: class Daytona {
    constructor(options?: Record<string, unknown>) {
      daytonaConstructorMock(options);
    }

    create = createMock;
    get = getMock;
  },
}));

describe('DaytonaSandboxClient', () => {
  beforeEach(() => {
    createMock.mockReset();
    getMock.mockReset();
    executeCommandMock.mockReset();
    createPtyMock.mockReset();
    createFolderMock.mockReset();
    uploadFileMock.mockReset();
    downloadFileMock.mockReset();
    deleteFileMock.mockReset();
    getSignedPreviewUrlMock.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
    deleteMock.mockReset();
    daytonaConstructorMock.mockReset();

    const sandbox = {
      id: 'daytona-test',
      start: startMock,
      stop: stopMock,
      delete: deleteMock,
      fs: {
        createFolder: createFolderMock,
        uploadFile: uploadFileMock,
        downloadFile: downloadFileMock,
        deleteFile: deleteFileMock,
      },
      process: {
        executeCommand: executeCommandMock,
        createPty: createPtyMock,
      },
      getSignedPreviewUrl: getSignedPreviewUrlMock,
    };

    createMock.mockResolvedValue(sandbox);
    getMock.mockResolvedValue(sandbox);
    executeCommandMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      const stdout = resolvedPath ? `${resolvedPath}\n` : 'README.md\n';
      return {
        exitCode: 0,
        result: stdout,
        artifacts: { stdout },
      };
    });
    createPtyMock.mockImplementation(async () => {
      throw new Error('PTY not configured for this test.');
    });
    createFolderMock.mockResolvedValue(undefined);
    uploadFileMock.mockResolvedValue(undefined);
    downloadFileMock.mockResolvedValue(Buffer.from('# Hello\n', 'utf8'));
    deleteFileMock.mockResolvedValue(undefined);
    getSignedPreviewUrlMock.mockResolvedValue({
      url: 'https://3000-daytona.example.test/signed?token=abc',
    });
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);
    deleteMock.mockResolvedValue(undefined);
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new DaytonaSandboxClient();

    await expect(
      client.create({
        manifest: new Manifest(),
        snapshot: { type: 'remote' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('creates a sandbox, remaps the default root, and executes commands', async () => {
    const client = new DaytonaSandboxClient();
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
    const output = await session.execCommand({ cmd: 'ls' });

    expect(session.state.manifest.root).toBe('/home/daytona/workspace');
    expect(executeCommandMock).toHaveBeenNthCalledWith(
      1,
      "mkdir -p -- '/home/daytona/workspace'",
      '/',
      {},
    );
    expect(uploadFileMock).toHaveBeenCalledWith(
      Buffer.from('# Hello\n'),
      '/home/daytona/workspace/README.md',
    );
    expect(executeCommandMock).toHaveBeenCalledWith(
      'ls',
      '/home/daytona/workspace',
      {},
    );
    expect(output).toContain('README.md');
  });

  test('cleans up when workspace root preparation fails', async () => {
    executeCommandMock.mockResolvedValueOnce({
      exitCode: 1,
      result: 'mkdir failed',
      artifacts: { stdout: 'mkdir failed' },
    });
    const client = new DaytonaSandboxClient();

    await expect(client.create(new Manifest())).rejects.toThrow(
      /failed to prepare the workspace root/,
    );

    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('rejects unsupported manifest metadata after remapping the default root', async () => {
    const client = new DaytonaSandboxClient();

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
      ),
    ).rejects.toThrow(/does not support extra path grants yet/);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('remaps default manifest roots when applying manifests to sessions', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());
    uploadFileMock.mockClear();

    await session.applyManifest(
      new Manifest({
        entries: {
          'next.txt': {
            type: 'file',
            content: 'next\n',
          },
        },
      }),
    );

    expect(uploadFileMock).toHaveBeenCalledWith(
      Buffer.from('next\n'),
      '/home/daytona/workspace/next.txt',
    );
    expect(session.state.manifest.root).toBe('/home/daytona/workspace');
    expect(session.state.manifest.entries).toHaveProperty('next.txt');
  });

  test('rejects applyManifest roots that differ from the session root', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());
    uploadFileMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          root: '/tmp',
          entries: {
            'outside.txt': {
              type: 'file',
              content: 'outside\n',
            },
          },
        }),
      ),
    ).rejects.toThrow(/different root than the active session/);

    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(session.state.manifest.root).toBe('/home/daytona/workspace');
    expect(session.state.manifest.entries).not.toHaveProperty('outside.txt');
  });

  test('does not pass yield_time_ms as the provider command timeout', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());

    await session.execCommand({ cmd: 'sleep 30', yieldTimeMs: 10_000 });

    expect(executeCommandMock).toHaveBeenLastCalledWith(
      'sleep 30',
      '/home/daytona/workspace',
      {},
    );
  });

  test('uses remote shell file operations for editor reads and writes', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());
    executeCommandMock.mockClear();
    downloadFileMock.mockClear();
    uploadFileMock.mockClear();

    executeCommandMock.mockImplementation(async (command: string) => {
      if (command.includes('resolve-workspace-path.sh')) {
        return {
          exitCode: 0,
          result: '/home/daytona/workspace/link.txt\n',
          artifacts: { stdout: '/home/daytona/workspace/link.txt\n' },
        };
      }

      if (command.includes('base64 <&3')) {
        const stdout = Buffer.from('# Hello\n', 'utf8').toString('base64');
        return {
          exitCode: 0,
          result: stdout,
          artifacts: { stdout },
        };
      }

      return {
        exitCode: 0,
        result: '',
        artifacts: { stdout: '' },
      };
    });

    await session.createEditor().updateFile({
      type: 'update_file',
      path: 'link.txt',
      diff: '-# Hello\n+# Safe\n',
    });

    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('/proc/$$/fd/3'),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('mktemp "$resolved_parent'),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('if [ -d "$target" ]'),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('mv -f -- "$tmp" "$target"'),
      ),
    ).toBe(true);
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  test('uses remote shell directory creation for nested editor writes', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());
    executeCommandMock.mockClear();
    createFolderMock.mockClear();
    uploadFileMock.mockClear();

    executeCommandMock.mockImplementation(async (command: string) => {
      if (command.includes('test -e ')) {
        return {
          exitCode: 1,
          result: '',
          artifacts: { stdout: '' },
        };
      }
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return {
          exitCode: 0,
          result: `${resolvedPath}\n`,
          artifacts: { stdout: `${resolvedPath}\n` },
        };
      }

      return {
        exitCode: 0,
        result: '',
        artifacts: { stdout: '' },
      };
    });

    await session.createEditor().createFile({
      type: 'create_file',
      path: 'nested/new.txt',
      diff: '+hello',
    });

    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('mkdir -p -- "$resolved_path"'),
      ),
    ).toBe(true);
    expect(createFolderMock).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  test('uses remote shell file operation for image reads', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    executeCommandMock.mockClear();
    downloadFileMock.mockClear();

    executeCommandMock.mockImplementation(async (command: string) => {
      if (command.includes('base64 <&3')) {
        const stdout = pngBytes.toString('base64');
        return {
          exitCode: 0,
          result: stdout,
          artifacts: { stdout },
        };
      }

      return {
        exitCode: 0,
        result: '',
        artifacts: { stdout: '' },
      };
    });

    const image = await session.viewImage({ path: 'image.png' });

    const readCommand = executeCommandMock.mock.calls
      .map(([command]) => String(command))
      .find((command) => command.includes('base64 <&3'));
    expect(readCommand).toContain('resolved=$(readlink -f -- "$path")');
    expect(readCommand).toContain('exec 3< "$resolved"');
    expect(readCommand).toContain('[ -f "$resolved" ]');
    expect(
      readCommand?.indexOf('resolved=$(readlink -f -- "$path")'),
    ).toBeLessThan(readCommand?.indexOf('exec 3< "$resolved"') ?? -1);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('/proc/$$/fd/3'),
      ),
    ).toBe(true);
    expect(downloadFileMock).not.toHaveBeenCalled();
    if (
      !image.image ||
      typeof image.image !== 'object' ||
      !('mediaType' in image.image)
    ) {
      throw new Error('Expected viewImage to return inline image data.');
    }
    expect(image.image.mediaType).toBe('image/png');
  });

  test('reuses resolved manifest environment values during create', async () => {
    let tokenVersion = 0;
    const resolveToken = vi.fn(async () => `token-${++tokenVersion}`);
    const client = new DaytonaSandboxClient({
      env: {
        CLIENT_ENV: 'client',
      },
    });

    const session = await client.create(
      new Manifest({
        environment: {
          TOKEN: {
            value: 'placeholder',
            resolve: resolveToken,
          },
        },
      }),
    );

    expect(resolveToken).toHaveBeenCalledOnce();
    expect(createMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        envVars: {
          CLIENT_ENV: 'client',
          TOKEN: 'token-1',
        },
      }),
    );
    expect(session.state.environment).toEqual({
      CLIENT_ENV: 'client',
      TOKEN: 'token-1',
    });
  });

  test('maps sandboxSnapshotName to the Daytona snapshot create field', async () => {
    const client = new DaytonaSandboxClient({
      image: 'node:22',
      resources: { cpu: 2 },
      sandboxSnapshotName: 'snapshot-test',
    });

    await client.create(new Manifest());

    const createParams = createMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(createParams).toEqual(
      expect.objectContaining({
        snapshot: 'snapshot-test',
      }),
    );
    expect(createParams).not.toHaveProperty('sandboxSnapshotName');
    expect(createParams).not.toHaveProperty('image');
    expect(createParams).not.toHaveProperty('resources');
  });

  test('rejects PTY execution when the SDK PTY API is unavailable', async () => {
    createMock.mockResolvedValueOnce({
      id: 'daytona-test',
      start: startMock,
      stop: stopMock,
      delete: deleteMock,
      fs: {
        createFolder: createFolderMock,
        uploadFile: uploadFileMock,
        downloadFile: downloadFileMock,
        deleteFile: deleteFileMock,
      },
      process: {
        executeCommand: executeCommandMock,
      },
      getSignedPreviewUrl: getSignedPreviewUrlMock,
    });
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'sh', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('supports PTY execution and stdin through the Daytona SDK', async () => {
    let onData!: (data: Uint8Array | string) => void;
    let finishWait!: (result: { exitCode: number }) => void;
    createPtyMock.mockImplementationOnce(
      async (options: Record<string, unknown>) => {
        onData = options.onData as (data: Uint8Array | string) => void;
        return {
          sessionId: options.id,
          waitForConnection: async () => {},
          sendInput: async (data: string | Uint8Array) => {
            onData(
              typeof data === 'string' ? data : new TextDecoder().decode(data),
            );
          },
          wait: async () =>
            await new Promise<{ exitCode: number }>((resolve) => {
              finishWait = resolve;
            }),
          kill: async () => {},
          disconnect: async () => {},
        };
      },
    );
    const client = new DaytonaSandboxClient();
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
    expect(createPtyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/daytona/workspace',
        envs: {},
        cols: 80,
        rows: 24,
      }),
    );
    expect(started).toContain('Process running with session ID');
  });

  test('rejects PTY handles without wait support', async () => {
    const killMock = vi.fn();
    const disconnectMock = vi.fn();
    createPtyMock.mockResolvedValueOnce({
      sendInput: async () => {},
      kill: killMock,
      disconnect: disconnectMock,
    });
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'sh', tty: true }),
    ).rejects.toMatchObject({
      details: {
        provider: 'daytona',
        feature: 'tty.wait',
      },
    });

    expect(killMock).toHaveBeenCalledOnce();
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  test('registers PTY handles before sending the initial command', async () => {
    const killMock = vi.fn();
    const disconnectMock = vi.fn();
    createPtyMock.mockResolvedValueOnce({
      waitForConnection: async () => {},
      sendInput: async () => {
        throw new Error('stdin failed');
      },
      wait: async () => await new Promise(() => {}),
      kill: killMock,
      disconnect: disconnectMock,
    });
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());

    await expect(session.execCommand({ cmd: 'sh', tty: true })).rejects.toThrow(
      'stdin failed',
    );
    await session.close();

    expect(killMock).toHaveBeenCalledOnce();
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  test('serializes runtime env overrides for session resume', async () => {
    const client = new DaytonaSandboxClient({
      env: { API_KEY: 'client-secret' },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          SAFE: 'manifest',
        },
      }),
    );

    const serialized = await client.serializeSessionState(session.state);
    const restored = await client.deserializeSessionState(serialized);

    expect(serialized.environment).toEqual({
      API_KEY: 'client-secret',
      SAFE: 'manifest',
    });
    expect(restored.environment).toEqual({
      SAFE: 'manifest',
      API_KEY: 'client-secret',
    });
  });

  test('stops on close when pauseOnExit is enabled and resumes by id', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });

    await session.close();
    await client.resume(session.state);

    expect(stopMock).toHaveBeenCalledOnce();
    expect(getMock).toHaveBeenCalledWith('daytona-test');
    expect(startMock).toHaveBeenCalledOnce();
    expect(executeCommandMock).toHaveBeenLastCalledWith(
      "mkdir -p -- '/home/daytona/workspace'",
      '/',
      {},
    );
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('starts sandboxes during resume even when pauseOnExit is false', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      autoStopInterval: 10,
    });

    await client.resume(session.state);

    expect(getMock).toHaveBeenCalledWith('daytona-test');
    expect(startMock).toHaveBeenCalledOnce();
  });

  test('rematerializes cloud bucket mounts when resuming auto-stopped sandboxes', async () => {
    const client = new DaytonaSandboxClient();
    const manifest = new Manifest({
      entries: {
        data: {
          type: 's3_mount',
          bucket: 'agent-logs',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
          mountPath: 'mounted/logs',
          mountStrategy: new DaytonaCloudBucketMountStrategy(),
        },
      },
    });
    const session = await client.create(manifest, {
      autoStopInterval: 10,
    });
    executeCommandMock.mockClear();

    await client.resume(session.state);

    expect(startMock).toHaveBeenCalledOnce();
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('fusermount3 -u'),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('/home/daytona/workspace/mounted/logs'),
      ),
    ).toBe(true);
  });

  test('persists create-time client auth options for serialized resume', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      apiKey: 'daytona-create-key',
      apiUrl: 'https://daytona.example.test',
      target: 'us',
      pauseOnExit: true,
    });
    const serialized = await client.serializeSessionState(session.state);
    const restoredClient = new DaytonaSandboxClient();
    const restored = await restoredClient.deserializeSessionState(serialized);
    daytonaConstructorMock.mockClear();

    await restoredClient.resume(restored);

    expect(serialized).toMatchObject({
      apiKey: 'daytona-create-key',
      apiUrl: 'https://daytona.example.test',
      target: 'us',
    });
    expect(restored).toMatchObject({
      apiKey: 'daytona-create-key',
      apiUrl: 'https://daytona.example.test',
      target: 'us',
    });
    expect(daytonaConstructorMock).toHaveBeenCalledWith({
      apiKey: 'daytona-create-key',
      apiUrl: 'https://daytona.example.test',
      target: 'us',
    });
  });

  test('delete terminates even when pauseOnExit is enabled', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });

    await session.delete();

    expect(stopMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('does not delete twice across shutdown and delete lifecycle hooks', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest());

    await session.shutdown();
    await session.delete();

    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('deletes after pause shutdown when delete lifecycle hook runs', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });

    await session.shutdown();
    await session.delete();

    expect(stopMock).toHaveBeenCalledOnce();
    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('retries delete while Daytona reports a state change in progress', async () => {
    vi.useFakeTimers();
    try {
      const client = new DaytonaSandboxClient();
      const session = await client.create(new Manifest());
      const stateChangeError = Object.assign(
        new Error('Sandbox state change in progress'),
        { statusCode: 409 },
      );
      deleteMock
        .mockRejectedValueOnce(stateChangeError)
        .mockResolvedValueOnce(undefined);

      const deletePromise = session.delete();
      await vi.advanceTimersByTimeAsync(1_000);
      await deletePromise;

      expect(deleteMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('recreates paused sandboxes when resume start reports missing sandbox', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    startMock.mockRejectedValueOnce(new Error('sandbox not found'));

    const recreated = await client.resume(session.state);

    expect(getMock).toHaveBeenCalledWith('daytona-test');
    expect(startMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledOnce();
    expect(recreated.state.sandboxId).toBe('daytona-test');
  });

  test('preserves persisted environment when recreating resumed sandboxes', async () => {
    let tokenVersion = 0;
    const resolveToken = vi.fn(async () => `token-${++tokenVersion}`);
    const client = new DaytonaSandboxClient();
    const session = await client.create(
      new Manifest({
        environment: {
          TOKEN: {
            value: 'placeholder',
            resolve: resolveToken,
          },
        },
      }),
      { pauseOnExit: true },
    );
    createMock.mockClear();
    startMock.mockRejectedValueOnce(new Error('sandbox not found'));

    const recreated = await client.resume(session.state);

    expect(resolveToken).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: {
          TOKEN: 'token-1',
        },
      }),
      undefined,
    );
    expect(recreated.state.environment).toEqual({
      TOKEN: 'token-1',
    });
  });

  test('recreates sandboxes when resume lookup reports missing sandbox', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    getMock.mockRejectedValueOnce(new Error('sandbox missing'));

    const recreated = await client.resume(session.state);

    expect(getMock).toHaveBeenCalledWith('daytona-test');
    expect(startMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledOnce();
    expect(recreated.state.sandboxId).toBe('daytona-test');
  });

  test('fails fast when resume lookup fails with a provider error', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    getMock.mockRejectedValueOnce(new Error('request timeout'));

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'daytona',
      operation: 'resume',
      sandboxId: 'daytona-test',
      cause: 'request timeout',
    });
    expect(startMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('fails fast when resume start fails with a provider error', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    startMock.mockRejectedValueOnce(new Error('request timeout'));

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'daytona',
      operation: 'resume',
      sandboxId: 'daytona-test',
      cause: 'request timeout',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  test('fails fast when resume workspace root preparation fails', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    executeCommandMock.mockResolvedValueOnce({
      exitCode: 1,
      result: 'mkdir failed',
      artifacts: { stdout: 'mkdir failed' },
    });

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'daytona',
      operation: 'prepare workspace root',
      sandboxId: 'daytona-test',
      root: '/home/daytona/workspace',
      stdout: 'mkdir failed',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  test('resolves configured exposed ports through signed preview URLs', async () => {
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      exposedPorts: [3000],
      exposedPortUrlTtlS: 120,
    });

    const endpoint = await session.resolveExposedPort(3000);
    const cachedEndpoint = await session.resolveExposedPort(3000);

    expect(getSignedPreviewUrlMock).toHaveBeenCalledWith(3000, 120);
    expect(getSignedPreviewUrlMock).toHaveBeenCalledOnce();
    expect(endpoint).toMatchObject({
      host: '3000-daytona.example.test',
      port: 443,
      tls: true,
      query: 'token=abc',
    });
    expect(endpoint.daytonaExpiresAtMs).toEqual(expect.any(Number));
    expect(cachedEndpoint).toBe(endpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('refreshes expired Daytona signed preview URLs', async () => {
    getSignedPreviewUrlMock
      .mockResolvedValueOnce({
        url: 'https://3000-daytona.example.test/signed?token=first',
      })
      .mockResolvedValueOnce({
        url: 'https://3000-daytona.example.test/signed?token=second',
      });
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      exposedPorts: [3000],
      exposedPortUrlTtlS: 120,
    });

    const firstEndpoint = await session.resolveExposedPort(3000);
    session.state.exposedPorts!['3000']!.daytonaExpiresAtMs = Date.now() - 1;
    const secondEndpoint = await session.resolveExposedPort(3000);

    expect(getSignedPreviewUrlMock).toHaveBeenCalledTimes(2);
    expect(firstEndpoint.query).toBe('token=first');
    expect(secondEndpoint.query).toBe('token=second');
    expect(secondEndpoint).not.toBe(firstEndpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(secondEndpoint);
  });

  test('clears cached signed preview URLs when recreating a sandbox', async () => {
    getSignedPreviewUrlMock
      .mockResolvedValueOnce({
        url: 'https://3000-daytona.example.test/signed?token=first',
      })
      .mockResolvedValueOnce({
        url: 'https://3000-daytona.example.test/signed?token=second',
      });
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      exposedPorts: [3000],
      exposedPortUrlTtlS: 120,
      pauseOnExit: true,
    });
    const firstEndpoint = await session.resolveExposedPort(3000);
    createMock.mockClear();
    startMock.mockRejectedValueOnce(new Error('sandbox not found'));

    const recreated = await client.resume(session.state);
    const secondEndpoint = await recreated.resolveExposedPort(3000);

    expect(createMock).toHaveBeenCalledOnce();
    expect(getSignedPreviewUrlMock).toHaveBeenCalledTimes(2);
    expect(firstEndpoint.query).toBe('token=first');
    expect(secondEndpoint.query).toBe('token=second');
    expect(recreated.state.exposedPorts?.['3000']).toBe(secondEndpoint);
  });

  test('expires Daytona signed preview URL cache when TTL is implicit', async () => {
    getSignedPreviewUrlMock
      .mockResolvedValueOnce({
        url: 'https://3000-daytona.example.test/signed?token=first',
      })
      .mockResolvedValueOnce({
        url: 'https://3000-daytona.example.test/signed?token=second',
      });
    const client = new DaytonaSandboxClient();
    const session = await client.create(new Manifest(), {
      exposedPorts: [3000],
    });

    const firstEndpoint = await session.resolveExposedPort(3000);
    session.state.exposedPorts!['3000']!.daytonaExpiresAtMs = Date.now() - 1;
    const secondEndpoint = await session.resolveExposedPort(3000);

    expect(getSignedPreviewUrlMock).toHaveBeenCalledWith(3000, undefined);
    expect(getSignedPreviewUrlMock).toHaveBeenCalledTimes(2);
    expect(firstEndpoint.daytonaExpiresAtMs).toEqual(expect.any(Number));
    expect(firstEndpoint.query).toBe('token=first');
    expect(secondEndpoint.query).toBe('token=second');
    expect(secondEndpoint).not.toBe(firstEndpoint);
  });

  test('mounts cloud buckets with the Daytona rclone mount strategy', async () => {
    const client = new DaytonaSandboxClient();

    const session = await client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'agent-logs',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountPath: 'mounted/logs',
            mountStrategy: new DaytonaCloudBucketMountStrategy(),
          },
        },
      }),
    );
    await session.close();

    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('/home/daytona/workspace/mounted/logs'),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('fusermount3 -u'),
      ),
    ).toBe(true);
    const privilegedFuseCommand = executeCommandMock.mock.calls
      .map(([command]) => String(command))
      .find((command) => command.includes('chmod a+rw /dev/fuse'));
    expect(privilegedFuseCommand).toContain("target_user='root'");
    expect(privilegedFuseCommand).toContain(
      'sudo -n -u "$target_user" -- sh -lc',
    );
  });

  test('rematerializes cloud bucket mounts when resuming paused sandboxes', async () => {
    const client = new DaytonaSandboxClient();
    const manifest = new Manifest({
      entries: {
        data: {
          type: 's3_mount',
          bucket: 'agent-logs',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
          mountPath: 'mounted/logs',
          mountStrategy: new DaytonaCloudBucketMountStrategy(),
        },
      },
    });

    const session = await client.create(manifest, {
      pauseOnExit: true,
    });
    await session.close();
    executeCommandMock.mockClear();

    await client.resume(session.state);

    expect(startMock).toHaveBeenCalledOnce();
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
    expect(
      executeCommandMock.mock.calls.some(([command]) =>
        String(command).includes('/home/daytona/workspace/mounted/logs'),
      ),
    ).toBe(true);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
