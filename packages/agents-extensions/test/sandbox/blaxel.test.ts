import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  type Mount,
} from '@openai/agents-core/sandbox';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BlaxelCloudBucketMountStrategy,
  BlaxelDriveMount,
  BlaxelDriveMountStrategy,
  BlaxelSandboxClient,
  type BlaxelSandboxClientOptions,
} from '../../src/sandbox/blaxel';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';

const createSandboxMock = vi.fn();
const getMock = vi.fn();
const processExecMock = vi.fn();
const mkdirMock = vi.fn();
const writeMock = vi.fn();
const writeBinaryMock = vi.fn();
const readMock = vi.fn();
const readBinaryMock = vi.fn();
const rmMock = vi.fn();
const createPreviewMock = vi.fn();
const createPreviewTokenMock = vi.fn();
const driveMountMock = vi.fn();
const driveUnmountMock = vi.fn();
const deleteMock = vi.fn();
const originalWebSocket = globalThis.WebSocket;

function makeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    name: 'blaxel-test',
    metadata: {
      name: 'blaxel-test',
      createdAt: '2026-04-28T00:00:00.000Z',
      workspace: 'test-workspace',
      createdBy: 'test-user',
    },
    url: 'https://sandbox.blaxel.test',
    process: {
      exec: processExecMock,
    },
    fs: {
      mkdir: mkdirMock,
      write: writeMock,
      writeBinary: writeBinaryMock,
      read: readMock,
      readBinary: readBinaryMock,
      rm: rmMock,
    },
    previews: {
      createIfNotExists: createPreviewMock,
    },
    drives: {
      mount: driveMountMock,
      unmount: driveUnmountMock,
    },
    delete: deleteMock,
    ...overrides,
  };
}

vi.mock('@blaxel/core', () => ({
  SandboxInstance: {
    create: createSandboxMock,
    get: getMock,
  },
}));

describe('BlaxelSandboxClient', () => {
  beforeEach(() => {
    createSandboxMock.mockReset();
    getMock.mockReset();
    processExecMock.mockReset();
    mkdirMock.mockReset();
    writeMock.mockReset();
    writeBinaryMock.mockReset();
    readMock.mockReset();
    readBinaryMock.mockReset();
    rmMock.mockReset();
    createPreviewMock.mockReset();
    createPreviewTokenMock.mockReset();
    driveMountMock.mockReset();
    driveUnmountMock.mockReset();
    deleteMock.mockReset();

    createSandboxMock.mockResolvedValue(makeSandbox());
    getMock.mockResolvedValue(makeSandbox());
    processExecMock.mockImplementation(
      async (params: { command?: string } = {}) => {
        const resolvedPath = resolvedRemotePathFromValidationCommand(
          params.command ?? '',
        );
        return {
          stdout: resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
          stderr: '',
          exitCode: 0,
        };
      },
    );
    readMock.mockResolvedValue('# Hello\n');
    readBinaryMock.mockResolvedValue(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    mkdirMock.mockResolvedValue(undefined);
    writeMock.mockResolvedValue(undefined);
    writeBinaryMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
    createPreviewTokenMock.mockResolvedValue({ value: 'private-token' });
    driveMountMock.mockResolvedValue(undefined);
    driveUnmountMock.mockResolvedValue(undefined);
    createPreviewMock.mockResolvedValue({
      spec: { url: 'https://3000-preview.bl.run' },
      tokens: { create: createPreviewTokenMock },
    });
    deleteMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    TestWebSocket.instances = [];
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new BlaxelSandboxClient();

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
    expect(createSandboxMock).not.toHaveBeenCalled();
  });

  test('creates a sandbox, materializes the manifest, and executes commands', async () => {
    const client = new BlaxelSandboxClient();
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

    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(processExecMock.mock.calls[0]?.[0]).toMatchObject({
      command: "mkdir -p -- '/workspace'",
      workingDir: '/',
      waitForCompletion: true,
    });
    expect(writeMock).toHaveBeenCalledWith('/workspace/README.md', '# Hello\n');
    expect(processExecMock).toHaveBeenLastCalledWith({
      command: 'ls',
      workingDir: '/workspace',
      waitForCompletion: true,
    });
    expect(output).toContain('Process exited with code 0');
    expect(output).toContain('README.md');
  });

  test('deletes created sandboxes when environment materialization fails', async () => {
    const client = new BlaxelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          environment: {
            SECRET: {
              value: 'placeholder',
              resolve: async () => {
                throw new Error('env failed');
              },
            },
          },
        }),
      ),
    ).rejects.toThrow('env failed');

    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(deleteMock).toHaveBeenCalledOnce();
    expect(processExecMock).not.toHaveBeenCalled();
  });

  test('does not delete reused named sandboxes when environment materialization fails', async () => {
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    const client = new BlaxelSandboxClient({
      name: 'shared-sandbox',
    } satisfies BlaxelSandboxClientOptions);

    await expect(
      client.create(
        new Manifest({
          environment: {
            SECRET: {
              value: 'placeholder',
              resolve: async () => {
                throw new Error('env failed');
              },
            },
          },
        }),
      ),
    ).rejects.toThrow('env failed');

    expect(getMock).toHaveBeenCalledWith('shared-sandbox');
    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(processExecMock).not.toHaveBeenCalled();
  });

  test('checks named sandbox ownership after create conflicts', async () => {
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    const client = new BlaxelSandboxClient({
      name: 'shared-sandbox',
    } satisfies BlaxelSandboxClientOptions);

    await expect(
      client.create(
        new Manifest({
          environment: {
            SECRET: {
              value: 'placeholder',
              resolve: async () => {
                throw new Error('env failed');
              },
            },
          },
        }),
      ),
    ).rejects.toThrow('env failed');

    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(getMock).toHaveBeenCalledWith('shared-sandbox');
    const createOrder = createSandboxMock.mock.invocationCallOrder[0];
    const getOrder = getMock.mock.invocationCallOrder[0];
    expect(createOrder).toBeDefined();
    expect(getOrder).toBeDefined();
    expect(createOrder as number).toBeLessThan(getOrder as number);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test.each(['DEACTIVATING', 'DEACTIVATED', 'TERMINATING'] as const)(
    'creates a named sandbox when conflict lookup finds a %s sandbox',
    async (status) => {
      createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
      getMock.mockResolvedValueOnce(
        makeSandbox({
          name: 'shared-sandbox',
          status,
        }),
      );
      const client = new BlaxelSandboxClient({
        name: 'shared-sandbox',
      } satisfies BlaxelSandboxClientOptions);

      const session = await client.create(new Manifest());

      expect(getMock).toHaveBeenCalledWith('shared-sandbox');
      expect(createSandboxMock).toHaveBeenCalledTimes(2);
      expect(session.state.ownsSandbox).toBe(true);
      expect(session.state.sandboxName).toBe('shared-sandbox');
    },
  );

  test('retries autogenerated sandbox name conflicts instead of reusing a live sandbox', async () => {
    const randomSpy = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2);
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    const client = new BlaxelSandboxClient();

    try {
      const session = await client.create(new Manifest());

      expect(createSandboxMock).toHaveBeenCalledTimes(2);
      expect(createSandboxMock.mock.calls[0]?.[0]).toMatchObject({
        name: 'openai-agents-19999999',
      });
      expect(createSandboxMock.mock.calls[1]?.[0]).toMatchObject({
        name: 'openai-agents-33333333',
      });
      expect(getMock).not.toHaveBeenCalled();
      expect(session.state.sandboxName).toBe('openai-agents-33333333');
      expect(session.state.ownsSandbox).toBe(true);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('treats missing command exit codes as failures', async () => {
    const client = new BlaxelSandboxClient();
    const session = await client.create(new Manifest());
    processExecMock.mockResolvedValueOnce({
      stdout: 'lost exit\n',
      stderr: '',
      exitCode: null,
    });

    const output = await session.execCommand({ cmd: 'lost-exit' });

    expect(output).toContain('Process exited with code 1');
    expect(output).toContain('lost exit');
  });

  test('does not pass yield_time_ms as the provider command timeout', async () => {
    const client = new BlaxelSandboxClient();
    const session = await client.create(new Manifest());

    await session.execCommand({ cmd: 'sleep 30', yieldTimeMs: 10_000 });

    expect(processExecMock).toHaveBeenLastCalledWith({
      command: 'sleep 30',
      workingDir: '/workspace',
      waitForCompletion: true,
    });
  });

  test('applies provider timeout bundles to Blaxel operations', async () => {
    const client = new BlaxelSandboxClient({
      timeouts: {
        createTimeoutMs: 101,
        execTimeoutMs: 202,
        fileUploadTimeoutMs: 505,
        fileDownloadTimeoutMs: 606,
        workspaceTarTimeoutMs: 303,
        fastOperationTimeoutMs: 404,
      },
    });
    const session = await client.create(new Manifest());

    expect(createSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        createTimeoutMs: 101,
      }),
    );
    expect(processExecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "mkdir -p -- '/workspace'",
        timeout: 404,
      }),
    );

    await session.execCommand({ cmd: 'ls' });
    expect(processExecMock).toHaveBeenLastCalledWith({
      command: 'ls',
      workingDir: '/workspace',
      waitForCompletion: true,
      timeout: 202,
    });

    await expect(session.persistWorkspace()).rejects.toThrow();
    expect(
      processExecMock.mock.calls.some((call) => {
        const params = call[0] as { command?: string; timeout?: number };
        return params.command?.includes('tar') && params.timeout === 303;
      }),
    ).toBe(true);
  });

  test('enforces Blaxel file operation timeouts locally', async () => {
    const client = new BlaxelSandboxClient({
      timeouts: {
        fileDownloadTimeoutMs: 1,
      },
    });
    const session = await client.create(new Manifest());
    readBinaryMock.mockImplementationOnce(
      async () => await new Promise(() => {}),
    );

    await expect(
      session.viewImage({ path: 'pixel.png' }),
    ).rejects.toBeInstanceOf(SandboxProviderError);
  });

  test('rejects unsupported PTY execution with a typed error', async () => {
    const client = new BlaxelSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'sh', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('supports PTY execution and stdin through the Blaxel terminal websocket', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new BlaxelSandboxClient({
      apiKey: 'blaxel-token',
    });
    const session = await client.create(new Manifest());

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    await firstSend;
    socket.message(
      JSON.stringify({
        type: 'output',
        data: 'ready\n',
      }),
    );
    const started = await startedPromise;
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );

    const secondSend = socket.nextSend();
    const writePromise = session.writeStdin({
      sessionId,
      chars: 'echo next\n',
      yieldTimeMs: 250,
    });
    await secondSend;
    socket.message(
      JSON.stringify({
        type: 'output',
        data: 'next\n',
      }),
    );
    socket.close();
    const next = await writePromise;

    expect(socket.url).toContain('wss://sandbox.blaxel.test/terminal/ws?');
    expect(socket.url).toContain('token=blaxel-token');
    expect(socket.url).toContain('workingDir=%2Fworkspace');
    expect(JSON.parse(String(socket.sent[0]))).toEqual({
      type: 'input',
      data: "/bin/sh -c 'echo ready'\n",
    });
    expect(JSON.parse(String(socket.sent[1]))).toEqual({
      type: 'input',
      data: 'echo next\n',
    });
    expect(started).toContain('ready');
    expect(next).toContain('next');
    expect(next).toContain('Process exited with code 0');
  });

  test('exports session environment before launching PTY commands', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new BlaxelSandboxClient({
      apiKey: 'blaxel-token',
      env: { CLIENT_SECRET: 'client' },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          MANIFEST_VALUE: 'manifest',
        },
      }),
    );

    const startedPromise = session.execCommand({
      cmd: 'printf "$CLIENT_SECRET:$MANIFEST_VALUE"',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    await firstSend;
    socket.close();
    await startedPromise;

    const command = JSON.parse(String(socket.sent[0])).data;
    expect(command).toContain('export CLIENT_SECRET=');
    expect(command).toContain('client');
    expect(command).toContain('export MANIFEST_VALUE=');
    expect(command).toContain('manifest');
    expect(command).toContain('printf "$CLIENT_SECRET:$MANIFEST_VALUE"');
  });

  test('preserves PTY error exit codes after websocket close', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new BlaxelSandboxClient({
      apiKey: 'blaxel-token',
    });
    const session = await client.create(new Manifest());

    const startedPromise = session.execCommand({
      cmd: 'exit 1',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    await firstSend;
    socket.message(
      JSON.stringify({
        type: 'error',
        data: 'failed\n',
      }),
    );
    socket.close();
    const started = await startedPromise;

    expect(started).toContain('failed');
    expect(started).toContain('Process exited with code 1');
  });

  test('treats unexpected PTY websocket closes as failures', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new BlaxelSandboxClient({
      apiKey: 'blaxel-token',
    });
    const session = await client.create(new Manifest());

    const startedPromise = session.execCommand({
      cmd: 'echo interrupted',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    await firstSend;
    socket.close(1006);
    const started = await startedPromise;

    expect(started).toContain('Process exited with code 1');
  });

  test('serializes runtime env overrides for session resume', async () => {
    const client = new BlaxelSandboxClient({
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

  test('rejects unsafe environment names before building shell commands', async () => {
    const client = new BlaxelSandboxClient();
    const session = await client.create(
      new Manifest({
        environment: {
          'X; touch /tmp/pwned; #': 'bad',
        },
      }),
    );

    await expect(session.execCommand({ cmd: 'ls' })).rejects.toThrow(
      'Invalid environment variable name',
    );
  });

  test('resumes by sandbox name and respects pauseOnExit', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());

    await session.close();
    await client.resume(session.state);

    expect(deleteMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalledWith(session.state.sandboxName);
  });

  test('rejects owned resume when sandbox identity cannot be verified', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    getMock.mockResolvedValueOnce(
      makeSandbox({
        metadata: {
          name: 'blaxel-test',
          createdAt: '2026-04-28T00:01:00.000Z',
          workspace: 'test-workspace',
          createdBy: 'test-user',
        },
      }),
    );

    await expect(client.resume(session.state)).rejects.toThrow(
      `Blaxel sandbox ${session.state.sandboxName} cannot be safely resumed with ownership because its identity could not be verified.`,
    );
  });

  test('serializes ownership so resumed shared sandboxes are not deleted', async () => {
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    const client = new BlaxelSandboxClient({
      name: 'shared-sandbox',
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());

    const serialized = await client.serializeSessionState(session.state);
    const restored = await client.resume(
      await client.deserializeSessionState(serialized),
    );
    await restored.close();
    await restored.delete();

    expect(session.state.ownsSandbox).toBe(false);
    expect(serialized.ownsSandbox).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('unmounts manifest mounts after resuming shared sandboxes', async () => {
    const client = new BlaxelSandboxClient();
    const manifest = new Manifest({
      entries: {
        logs: {
          type: 's3_mount',
          bucket: 'agent-logs',
          mountPath: 'mounted/logs',
          mountStrategy: new BlaxelCloudBucketMountStrategy(),
        },
        drive: new BlaxelDriveMount({
          driveName: 'agent-drive',
          mountPath: 'mounted/drive',
          mountStrategy: new BlaxelDriveMountStrategy(),
        }),
      },
    });

    const session = await client.resume({
      manifest,
      sandboxName: 'shared-sandbox',
      sandboxIdentity: 'shared-identity',
      pauseOnExit: false,
      ownsSandbox: false,
      environment: {},
    });
    processExecMock.mockClear();

    await session.close();

    const unmountCommands = processExecMock.mock.calls
      .map(([params]) => String(params.command))
      .filter((command) => command.includes('fusermount -u'));
    expect(unmountCommands.join('\n')).toContain('/workspace/mounted/logs');
    expect(driveUnmountMock).toHaveBeenCalledWith('/workspace/mounted/drive');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('delete terminates even when pauseOnExit is enabled', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());

    await session.delete();

    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('recreates by sandbox name when resume lookup reports missing sandbox', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    createSandboxMock.mockClear();
    getMock.mockRejectedValueOnce(new Error('sandbox missing'));

    const recreated = await client.resume(session.state);

    expect(getMock).toHaveBeenCalledWith(session.state.sandboxName);
    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(recreated.state.sandboxName).toBe(session.state.sandboxName);
  });

  test('rejects owned resume recreation when the sandbox name is claimed', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    createSandboxMock.mockClear();
    getMock.mockRejectedValueOnce(new Error('sandbox missing'));
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());

    await expect(client.resume(session.state)).rejects.toThrow(
      `Blaxel sandbox ${session.state.sandboxName} cannot be safely recreated because another sandbox already uses that name.`,
    );

    expect(getMock).toHaveBeenCalledOnce();
    expect(createSandboxMock).toHaveBeenCalledOnce();
  });

  test('recreates by sandbox name when resume lookup returns a terminated sandbox', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    createSandboxMock.mockClear();
    getMock.mockResolvedValueOnce(
      makeSandbox({
        name: session.state.sandboxName,
        status: 'TERMINATED',
        url: 'https://terminated.blaxel.test',
      }),
    );

    const recreated = await client.resume(session.state);

    expect(getMock).toHaveBeenCalledWith(session.state.sandboxName);
    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(createSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: session.state.sandboxName,
      }),
    );
    expect(recreated.state.sandboxName).toBe(session.state.sandboxName);
  });

  test('recreates by sandbox name when resume lookup returns a failed sandbox', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    createSandboxMock.mockClear();
    getMock.mockResolvedValueOnce(
      makeSandbox({
        name: session.state.sandboxName,
        status: 'FAILED',
        url: 'https://failed.blaxel.test',
      }),
    );

    const recreated = await client.resume(session.state);

    expect(getMock).toHaveBeenCalledWith(session.state.sandboxName);
    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(recreated.state.sandboxName).toBe(session.state.sandboxName);
  });

  test.each(['DEACTIVATING', 'TERMINATING'] as const)(
    'recreates by sandbox name when resume lookup returns a %s sandbox',
    async (status) => {
      const client = new BlaxelSandboxClient({
        pauseOnExit: true,
      } satisfies BlaxelSandboxClientOptions);
      const session = await client.create(new Manifest());
      createSandboxMock.mockClear();
      getMock.mockResolvedValueOnce(
        makeSandbox({
          name: session.state.sandboxName,
          status,
          url: `https://${status.toLowerCase()}.blaxel.test`,
        }),
      );

      const recreated = await client.resume(session.state);

      expect(getMock).toHaveBeenCalledWith(session.state.sandboxName);
      expect(createSandboxMock).toHaveBeenCalledOnce();
      expect(recreated.state.sandboxName).toBe(session.state.sandboxName);
    },
  );

  test('takes ownership when resume recreates a missing shared sandbox', async () => {
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    const client = new BlaxelSandboxClient({
      name: 'shared-sandbox',
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    createSandboxMock.mockClear();
    getMock.mockResolvedValueOnce(
      makeSandbox({
        name: session.state.sandboxName,
        status: 'TERMINATED',
        url: 'https://terminated.blaxel.test',
      }),
    );

    const recreated = await client.resume(
      await client.deserializeSessionState(
        await client.serializeSessionState(session.state),
      ),
    );
    await recreated.delete();

    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(recreated.state.ownsSandbox).toBe(true);
    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('keeps shared ownership when resume recreation reuses an existing sandbox', async () => {
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    const client = new BlaxelSandboxClient({
      name: 'shared-sandbox',
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    createSandboxMock.mockClear();
    getMock.mockClear();
    getMock.mockResolvedValueOnce(
      makeSandbox({
        name: session.state.sandboxName,
        status: 'TERMINATED',
        url: 'https://terminated.blaxel.test',
      }),
    );
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    getMock.mockResolvedValueOnce(
      makeSandbox({
        name: session.state.sandboxName,
        status: 'RUNNING',
        url: 'https://reused.blaxel.test',
      }),
    );

    const recreated = await client.resume(
      await client.deserializeSessionState(
        await client.serializeSessionState(session.state),
      ),
    );
    await recreated.delete();

    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(recreated.state.ownsSandbox).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('fails fast when resume lookup fails with a provider error', async () => {
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());
    createSandboxMock.mockClear();
    getMock.mockRejectedValueOnce(new Error('request timeout'));

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'blaxel',
      operation: 'resume',
      sandboxName: session.state.sandboxName,
      cause: 'request timeout',
    });
    expect(createSandboxMock).not.toHaveBeenCalled();
  });

  test('deletes paused sandboxes when manifest application fails during create', async () => {
    writeMock.mockRejectedValueOnce(new Error('write failed'));
    const client = new BlaxelSandboxClient({
      pauseOnExit: true,
    } satisfies BlaxelSandboxClientOptions);

    await expect(
      client.create(
        new Manifest({
          entries: {
            'README.md': {
              type: 'file',
              content: '# Hello\n',
            },
          },
        }),
      ),
    ).rejects.toThrow('write failed');

    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('does not delete reused named sandboxes when manifest application fails during create', async () => {
    createSandboxMock.mockRejectedValueOnce(sandboxAlreadyExistsError());
    writeMock.mockRejectedValueOnce(new Error('write failed'));
    const client = new BlaxelSandboxClient({
      name: 'shared-sandbox',
    } satisfies BlaxelSandboxClientOptions);

    await expect(
      client.create(
        new Manifest({
          entries: {
            'README.md': {
              type: 'file',
              content: '# Hello\n',
            },
          },
        }),
      ),
    ).rejects.toThrow('write failed');

    expect(getMock).toHaveBeenCalledWith('shared-sandbox');
    expect(createSandboxMock).toHaveBeenCalledOnce();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('resolves public exposed ports through Blaxel previews', async () => {
    const client = new BlaxelSandboxClient();
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(3000);
    const cachedEndpoint = await session.resolveExposedPort(3000);

    expect(createPreviewMock).toHaveBeenCalledWith({
      metadata: { name: 'port-3000' },
      spec: {
        port: 3000,
        public: true,
      },
    });
    expect(createPreviewMock).toHaveBeenCalledOnce();
    expect(createPreviewTokenMock).not.toHaveBeenCalled();
    expect(endpoint).toMatchObject({
      host: '3000-preview.bl.run',
      port: 443,
      tls: true,
    });
    expect(cachedEndpoint).toBe(endpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('adds private Blaxel preview tokens to resolved endpoints', async () => {
    const client = new BlaxelSandboxClient({
      exposedPortPublic: false,
      exposedPortUrlTtlS: 60,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(3000);

    expect(createPreviewMock).toHaveBeenCalledWith({
      metadata: { name: 'port-3000' },
      spec: {
        port: 3000,
        public: false,
      },
    });
    expect(createPreviewTokenMock).toHaveBeenCalledOnce();
    expect(createPreviewTokenMock.mock.calls[0]?.[0]).toBeInstanceOf(Date);
    expect(endpoint.query).toBe('bl_preview_token=private-token');
  });

  test('adds private Blaxel preview tokens from nested preview responses', async () => {
    createPreviewMock.mockResolvedValueOnce({
      preview: {
        spec: { url: 'https://3000-preview.bl.run' },
        tokens: { create: createPreviewTokenMock },
      },
    });
    const client = new BlaxelSandboxClient({
      exposedPortPublic: false,
      exposedPortUrlTtlS: 60,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(3000);

    expect(createPreviewTokenMock).toHaveBeenCalledOnce();
    expect(endpoint.query).toBe('bl_preview_token=private-token');
  });

  test('refreshes private Blaxel preview tokens instead of returning stale cached URLs', async () => {
    createPreviewTokenMock
      .mockResolvedValueOnce({ value: 'first-token' })
      .mockResolvedValueOnce({ value: 'second-token' });
    const client = new BlaxelSandboxClient({
      exposedPortPublic: false,
      exposedPortUrlTtlS: 60,
    } satisfies BlaxelSandboxClientOptions);
    const session = await client.create(new Manifest());

    const firstEndpoint = await session.resolveExposedPort(3000);
    const secondEndpoint = await session.resolveExposedPort(3000);

    expect(createPreviewMock).toHaveBeenCalledTimes(2);
    expect(createPreviewTokenMock).toHaveBeenCalledTimes(2);
    expect(firstEndpoint.query).toBe('bl_preview_token=first-token');
    expect(secondEndpoint.query).toBe('bl_preview_token=second-token');
    expect(session.state.exposedPorts?.['3000']).toBe(secondEndpoint);
  });

  test('creates sessions when the Blaxel previews API is unavailable', async () => {
    createSandboxMock.mockResolvedValueOnce({
      name: 'blaxel-test',
      url: 'https://sandbox.blaxel.test',
      process: {
        exec: processExecMock,
      },
      fs: {
        mkdir: mkdirMock,
        write: writeMock,
        writeBinary: writeBinaryMock,
        read: readMock,
        readBinary: readBinaryMock,
        rm: rmMock,
      },
      drives: {
        mount: driveMountMock,
        unmount: driveUnmountMock,
      },
      delete: deleteMock,
    });
    const client = new BlaxelSandboxClient();

    const session = await client.create(new Manifest());

    await expect(session.resolveExposedPort(3000)).rejects.toThrow(
      'BlaxelSandboxClient exposed port resolution requires the Blaxel previews API.',
    );
  });

  test('mounts cloud buckets with the Blaxel cloud bucket strategy', async () => {
    const client = new BlaxelSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'agent-logs',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountPath: 'mounted/logs',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
        },
      }),
    );

    expect(
      processExecMock.mock.calls.some(([params]) =>
        String(params.command).includes('s3fs'),
      ),
    ).toBe(true);
    expect(
      processExecMock.mock.calls.some(([params]) =>
        String(params.command).includes('/workspace/mounted/logs'),
      ),
    ).toBe(true);
    const commands = processExecMock.mock.calls
      .map(([params]) => String(params.command))
      .join('\n');
    expect(commands).not.toContain('access-key');
    expect(commands).not.toContain('secret-key');
    expect(writeMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/s3fs-passwd-/u),
      'access-key:secret-key',
    );
  });

  test('cleans S3 credential files when cloud bucket mount commands reject', async () => {
    processExecMock.mockImplementation(
      async (params: { command?: string } = {}) => {
        const command = String(params.command ?? '');
        if (command.includes('command -v s3fs') || command.includes(' s3fs ')) {
          throw new Error('transport lost');
        }
        const resolvedPath = resolvedRemotePathFromValidationCommand(command);
        return {
          stdout: resolvedPath ? `${resolvedPath}\n` : '',
          stderr: '',
          exitCode: 0,
        };
      },
    );
    const client = new BlaxelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'agent-logs',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
              mountPath: 'mounted/logs',
              mountStrategy: new BlaxelCloudBucketMountStrategy(),
            },
          },
        }),
      ),
    ).rejects.toThrow('transport lost');

    const commands = processExecMock.mock.calls.map(([params]) =>
      String(params.command),
    );
    const mountCommandIndex = commands.findIndex((command) =>
      command.includes('s3fs'),
    );
    const cleanupCommandIndex = commands.findIndex(
      (command) =>
        command.includes('rm -f --') &&
        command.includes('/tmp/s3fs-passwd-') &&
        !command.includes('command -v s3fs') &&
        !command.includes(' s3fs '),
    );

    expect(mountCommandIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupCommandIndex).toBeGreaterThan(mountCommandIndex);
    expect(commands[cleanupCommandIndex]).not.toContain('access-key');
    expect(commands[cleanupCommandIndex]).not.toContain('secret-key');
  });

  test('cleans S3 credential files when secret file writes reject', async () => {
    writeMock.mockImplementation(
      async (path: string, content: string): Promise<void> => {
        if (path.startsWith('/tmp/s3fs-passwd-')) {
          void content;
          throw new Error('secret write lost');
        }
      },
    );
    const client = new BlaxelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'agent-logs',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
              mountPath: 'mounted/logs',
              mountStrategy: new BlaxelCloudBucketMountStrategy(),
            },
          },
        }),
      ),
    ).rejects.toThrow('secret write lost');

    const commands = processExecMock.mock.calls.map(([params]) =>
      String(params.command),
    );
    const cleanupCommand = commands.find(
      (command) =>
        command.includes('rm -f --') &&
        command.includes('/tmp/s3fs-passwd-') &&
        !command.includes('command -v s3fs') &&
        !command.includes(' s3fs '),
    );

    expect(cleanupCommand).toBeDefined();
    expect(cleanupCommand).not.toContain('access-key');
    expect(cleanupCommand).not.toContain('secret-key');
    expect(
      commands.some(
        (command) =>
          command.includes('command -v s3fs') || command.includes(' s3fs '),
      ),
    ).toBe(false);
  });

  test('rejects S3 cloud bucket mounts with partial credentials', async () => {
    const client = new BlaxelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'agent-logs',
              accessKeyId: 'access-key',
              mountPath: 'mounted/logs',
              mountStrategy: new BlaxelCloudBucketMountStrategy(),
            },
          },
        }),
      ),
    ).rejects.toThrow(
      'Blaxel cloud bucket mounts require both accessKeyId and secretAccessKey when either is provided.',
    );

    expect(
      processExecMock.mock.calls.some(([params]) =>
        String(params.command).includes('s3fs'),
      ),
    ).toBe(false);
  });

  test('mounts GCS buckets with service account files through gcsfuse auth', async () => {
    const client = new BlaxelSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 'gcs_mount',
            bucket: 'private-gcs',
            serviceAccountFile: '/var/secrets/gcs.json',
            mountPath: 'mounted/gcs',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
        },
      }),
    );

    const mountCommand = processExecMock.mock.calls
      .map(([params]) => String(params.command))
      .find((command) => command.includes('gcsfuse'));
    expect(mountCommand).toContain('--key-file=/var/secrets/gcs.json');
    expect(mountCommand).not.toContain('--anonymous-access');
  });

  test('mounts GCS buckets with service account credentials through secret files', async () => {
    const client = new BlaxelSandboxClient();
    const credentials = '{"type":"service_account","private_key":"secret"}';

    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 'gcs_mount',
            bucket: 'private-gcs',
            serviceAccountCredentials: credentials,
            mountPath: 'mounted/gcs',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
        },
      }),
    );

    const mountCommand = processExecMock.mock.calls
      .map(([params]) => String(params.command))
      .find((command) => command.includes('gcsfuse'));
    expect(mountCommand).toContain('--key-file=/tmp/gcs-creds-');
    expect(mountCommand).not.toContain(credentials);
    expect(mountCommand).not.toContain('private_key');
    expect(writeMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/gcs-creds-.*\.json$/u),
      credentials,
    );
  });

  test('mounts GCS buckets with access tokens through gcsfuse token URLs', async () => {
    const client = new BlaxelSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 'gcs_mount',
            bucket: 'private-gcs',
            accessToken: 'ya29.token',
            mountPath: 'mounted/gcs',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
        },
      }),
    );

    const mountCommand = processExecMock.mock.calls
      .map(([params]) => String(params.command))
      .find((command) => command.includes('gcsfuse'));
    const tokenServerStart = mountCommand?.match(
      /python3\s+'?\/tmp\/gcs-access-token-[^'"\s;]+\.py'?[^\n;]*/u,
    )?.[0];
    expect(mountCommand).toContain('--token-url=unix:///tmp/gcs-access-token');
    expect(mountCommand).toContain('openai_agents_kill_pidfile()');
    expect(mountCommand).toContain(
      "openai_agents_kill_pidfile '/tmp/gcs-access-token-",
    );
    expect(mountCommand).not.toContain('kill "$(cat');
    expect(mountCommand).not.toContain('"access_token":"ya29.token"');
    expect(mountCommand).not.toContain('ya29.token');
    expect(tokenServerStart).toContain('.json');
    expect(tokenServerStart).not.toContain('ya29.token');
    expect(tokenServerStart).not.toContain('access_token');
    expect(writeMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/gcs-access-token-.*\.json$/u),
      '{"access_token":"ya29.token","token_type":"Bearer"}',
    );
    expect(mountCommand).toContain('/releases/download/v3.4.4/gcsfuse_3.4.4_');
    expect(mountCommand).toContain('$GCSFUSE_DEB_ARCH.deb');
    expect(mountCommand).toContain('x86_64|amd64) GCSFUSE_DEB_ARCH=amd64');
    expect(mountCommand).toContain('aarch64|arm64) GCSFUSE_DEB_ARCH=arm64');
    expect(mountCommand).toContain(
      '406945ecc736e8cf0eee92a617fd4a038d138c9c31e48980b99862a5f1f55bb5',
    );
    expect(mountCommand).toContain(
      '8587fe2ee274075d8ec5a363e32761bc523a72c531922a69dd35035a371fdf3a',
    );
    expect(mountCommand).toContain('sha256sum -c -');
    expect(mountCommand).not.toContain('releases/latest');
    expect(mountCommand).not.toContain('--anonymous-access');
  });

  test('cleans GCS token artifacts when cloud bucket mount commands reject', async () => {
    processExecMock.mockImplementation(
      async (params: { command?: string } = {}) => {
        const command = String(params.command ?? '');
        if (command.includes('gcsfuse')) {
          throw new Error('transport lost');
        }
        const resolvedPath = resolvedRemotePathFromValidationCommand(command);
        return {
          stdout: resolvedPath ? `${resolvedPath}\n` : '',
          stderr: '',
          exitCode: 0,
        };
      },
    );
    const client = new BlaxelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 'gcs_mount',
              bucket: 'private-gcs',
              accessToken: 'ya29.token',
              mountPath: 'mounted/gcs',
              mountStrategy: new BlaxelCloudBucketMountStrategy(),
            },
          },
        }),
      ),
    ).rejects.toThrow('transport lost');

    const commands = processExecMock.mock.calls.map(([params]) =>
      String(params.command),
    );
    const mountCommandIndex = commands.findIndex((command) =>
      command.includes('gcsfuse'),
    );
    const cleanupCommandIndex = commands.findIndex(
      (command) =>
        command.includes('rm -f --') &&
        command.includes('/tmp/gcs-access-token-') &&
        !command.includes('gcsfuse'),
    );
    const cleanupCommand = commands[cleanupCommandIndex];

    expect(mountCommandIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupCommandIndex).toBeGreaterThan(mountCommandIndex);
    expect(cleanupCommand).toContain('openai_agents_kill_pidfile()');
    expect(cleanupCommand).toContain('.json');
    expect(cleanupCommand).toContain('.py');
    expect(cleanupCommand).toContain('.sock');
    expect(cleanupCommand).toContain('.pid');
    expect(cleanupCommand).not.toContain('ya29.token');
  });

  test('cleans GCS token artifacts when secret file writes reject', async () => {
    writeMock.mockImplementation(
      async (path: string, content: string): Promise<void> => {
        if (
          path.startsWith('/tmp/gcs-access-token-') &&
          path.endsWith('.json')
        ) {
          void content;
          throw new Error('token write lost');
        }
      },
    );
    const client = new BlaxelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 'gcs_mount',
              bucket: 'private-gcs',
              accessToken: 'ya29.token',
              mountPath: 'mounted/gcs',
              mountStrategy: new BlaxelCloudBucketMountStrategy(),
            },
          },
        }),
      ),
    ).rejects.toThrow('token write lost');

    const commands = processExecMock.mock.calls.map(([params]) =>
      String(params.command),
    );
    const cleanupCommand = commands.find(
      (command) =>
        command.includes('rm -f --') &&
        command.includes('/tmp/gcs-access-token-') &&
        !command.includes('gcsfuse'),
    );

    expect(cleanupCommand).toBeDefined();
    expect(cleanupCommand).toContain('openai_agents_kill_pidfile()');
    expect(cleanupCommand).toContain('.json');
    expect(cleanupCommand).toContain('.py');
    expect(cleanupCommand).toContain('.sock');
    expect(cleanupCommand).toContain('.pid');
    expect(cleanupCommand).not.toContain('ya29.token');
    expect(commands.some((command) => command.includes('gcsfuse'))).toBe(false);
  });

  test('scopes GCS access token cleanup to each unmounted path', async () => {
    const client = new BlaxelSandboxClient();

    const session = await client.create(
      new Manifest({
        entries: {
          first: {
            type: 'gcs_mount',
            bucket: 'private-gcs-a',
            accessToken: 'token-a',
            mountPath: 'mounted/gcs-a',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
          second: {
            type: 'gcs_mount',
            bucket: 'private-gcs-b',
            accessToken: 'token-b',
            mountPath: 'mounted/gcs-b',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
        },
      }),
    );
    await session.close();

    const unmountCommands = processExecMock.mock.calls
      .map(([params]) => String(params.command))
      .filter((command) => command.includes('fusermount -u'));
    const combinedUnmounts = unmountCommands.join('\n');

    expect(unmountCommands).toHaveLength(2);
    expect(combinedUnmounts).not.toContain('/tmp/gcs-access-token-*.pid');
    expect(combinedUnmounts).not.toContain('for pidfile');
    expect(combinedUnmounts).toContain('openai_agents_kill_pidfile()');
    expect(combinedUnmounts).not.toContain('kill "$(cat');
    const pidPaths = [
      ...combinedUnmounts.matchAll(/\/tmp\/gcs-access-token-[^'"\s;]+\.pid/gu),
    ].map(([path]) => path);
    const payloadPaths = [
      ...combinedUnmounts.matchAll(/\/tmp\/gcs-access-token-[^'"\s;]+\.json/gu),
    ].map(([path]) => path);
    expect(new Set(pidPaths).size).toBe(2);
    expect(new Set(payloadPaths).size).toBe(2);
  });

  test('uses collision-proof temp artifact ids for cloud bucket mounts', async () => {
    const client = new BlaxelSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          plus: {
            type: 'gcs_mount',
            bucket: 'private-gcs-plus',
            accessToken: 'token-plus',
            mountPath: 'a+b',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
          slash: {
            type: 'gcs_mount',
            bucket: 'private-gcs-slash',
            accessToken: 'token-slash',
            mountPath: 'a/b',
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
        },
      }),
    );

    const mountCommands = processExecMock.mock.calls
      .map(([params]) => String(params.command))
      .filter((command) => command.includes('gcsfuse'));
    const socketPaths = mountCommands.flatMap((command) =>
      [...command.matchAll(/\/tmp\/gcs-access-token-[^'"\s;]+\.sock/gu)].map(
        ([path]) => path,
      ),
    );

    expect(mountCommands).toHaveLength(2);
    expect(new Set(socketPaths).size).toBe(2);
    expect(socketPaths.join('\n')).not.toContain(
      '/tmp/gcs-access-token-workspace_a_b.sock',
    );
  });

  test('keeps GCS access token socket paths under Unix socket limits', async () => {
    const client = new BlaxelSandboxClient();
    const longMountPath = Array.from(
      { length: 16 },
      (_, index) => `segment-${index}`,
    ).join('/');

    await client.create(
      new Manifest({
        entries: {
          long: {
            type: 'gcs_mount',
            bucket: 'private-gcs-long',
            accessToken: 'token-long',
            mountPath: longMountPath,
            mountStrategy: new BlaxelCloudBucketMountStrategy(),
          },
        },
      }),
    );

    const socketPaths = processExecMock.mock.calls.flatMap(([params]) =>
      [
        ...String(params.command).matchAll(
          /\/tmp\/gcs-access-token-[^'"\s;]+\.sock/gu,
        ),
      ].map(([path]) => path),
    );

    expect(socketPaths.length).toBeGreaterThan(0);
    for (const socketPath of socketPaths) {
      expect(socketPath.length).toBeLessThanOrEqual(107);
    }
  });

  test('reports unsupported Blaxel drive mounts when the drives API is missing', async () => {
    createSandboxMock.mockResolvedValueOnce({
      name: 'blaxel-test',
      url: 'https://sandbox.blaxel.test',
      process: {
        exec: processExecMock,
      },
      fs: {
        mkdir: mkdirMock,
        write: writeMock,
        writeBinary: writeBinaryMock,
        read: readMock,
        readBinary: readBinaryMock,
        rm: rmMock,
      },
      previews: {
        createIfNotExists: createPreviewMock,
      },
      delete: deleteMock,
    });
    const client = new BlaxelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            drive: new BlaxelDriveMount({
              driveName: 'agent-drive',
              mountPath: 'mounted/drive',
              mountStrategy: new BlaxelDriveMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toThrow('Blaxel drive mounts require the sandbox drives API.');
    expect(driveMountMock).not.toHaveBeenCalled();
  });

  test('mounts and unmounts Blaxel drives through the drives API', async () => {
    const client = new BlaxelSandboxClient();

    const session = await client.create(
      new Manifest({
        entries: {
          drive: new BlaxelDriveMount({
            driveName: 'agent-drive',
            drivePath: '/projects',
            driveReadOnly: true,
            mountPath: 'mounted/drive',
            mountStrategy: new BlaxelDriveMountStrategy(),
          }),
        },
      }),
    );
    await session.close();

    expect(driveMountMock).toHaveBeenCalledWith(
      'agent-drive',
      '/workspace/mounted/drive',
      '/projects',
      true,
    );
    expect(driveUnmountMock).toHaveBeenCalledWith('/workspace/mounted/drive');
  });

  test('respects readOnly on plain Blaxel drive mount entries', async () => {
    const client = new BlaxelSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          drive: {
            type: 'mount',
            driveName: 'agent-drive',
            drivePath: '/projects',
            readOnly: true,
            mountPath: 'mounted/drive',
            mountStrategy: new BlaxelDriveMountStrategy(),
          } as Mount,
        },
      }),
    );

    expect(driveMountMock).toHaveBeenCalledWith(
      'agent-drive',
      '/workspace/mounted/drive',
      '/projects',
      true,
    );
  });

  test('uses the validated mount path for Blaxel drive mounts', async () => {
    const client = new BlaxelSandboxClient();

    const session = await client.create(
      new Manifest({
        entries: {
          drive: new BlaxelDriveMount({
            driveName: 'agent-drive',
            driveMountPath: '../outside',
            drivePath: '/projects',
            mountPath: 'mounted/drive',
            mountStrategy: new BlaxelDriveMountStrategy(),
          }),
        },
      }),
    );
    await session.close();

    expect(driveMountMock).toHaveBeenCalledWith(
      'agent-drive',
      '/workspace/mounted/drive',
      '/projects',
      false,
    );
    expect(driveUnmountMock).toHaveBeenCalledWith('/workspace/mounted/drive');
  });
});

function sandboxAlreadyExistsError(): Error & { code: number } {
  return Object.assign(new Error('sandbox already exists'), { code: 409 });
}

class TestWebSocket {
  static instances: TestWebSocket[] = [];
  private static instanceWaiters: Array<(socket: TestWebSocket) => void> = [];
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
  readyState = 0;
  binaryType = '';
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private sendWaiters: Array<
    (data: string | Uint8Array | ArrayBuffer) => void
  > = [];

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
    const waiter = TestWebSocket.instanceWaiters.shift();
    waiter?.(this);
  }

  static async nextInstance(): Promise<TestWebSocket> {
    const existing = TestWebSocket.instances.at(-1);
    if (existing) {
      return existing;
    }
    return await new Promise((resolve) => {
      TestWebSocket.instanceWaiters.push(resolve);
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
    const waiter = this.sendWaiters.shift();
    waiter?.(data);
  }

  close(code = 1000): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.dispatch('close', { code });
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  message(data: unknown): void {
    this.dispatch('message', { data });
  }

  async nextSend(): Promise<string | Uint8Array | ArrayBuffer> {
    return await new Promise((resolve) => {
      this.sendWaiters.push(resolve);
    });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
