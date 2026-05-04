import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ModalSandboxClient,
  ModalCloudBucketMountStrategy,
  ModalImageSelector,
  ModalSandboxSelector,
  type ModalSandboxClientOptions,
  type ModalSandboxSessionState,
} from '../../src/sandbox/modal';
import {
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
} from '../../src/sandbox/shared';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const processMocks = vi.hoisted(() => ({
  runSandboxProcess: vi.fn(),
}));
const modalSdkMocks = vi.hoisted(() => ({
  cloudBucketMountAvailable: true,
  classSecretApi: false,
}));
const appsFromNameMock = vi.fn();
const imagesFromRegistryMock = vi.fn();
const imagesFromIdMock = vi.fn();
const imagesDeleteMock = vi.fn();
const imageCmdMock = vi.fn();
const sandboxesCreateMock = vi.fn();
const sandboxesFromIdMock = vi.fn();
const sandboxExecMock = vi.fn();
const sandboxOpenMock = vi.fn();
const sandboxTerminateMock = vi.fn();
const sandboxPollMock = vi.fn();
const sandboxTunnelsMock = vi.fn();
const sandboxSnapshotFilesystemMock = vi.fn();
const sandboxSnapshotDirectoryMock = vi.fn();
const sandboxMountImageMock = vi.fn();
const secretFromNameMock = vi.fn();
const secretFromObjectMock = vi.fn();
const imageBuilderVersionMock = vi.fn();
const modalClientParams: Record<string, unknown>[] = [];

vi.mock('modal', () => {
  class CloudBucketMount {
    constructor(
      readonly bucketName: string,
      readonly params: Record<string, unknown> = {},
    ) {}

    toProto(mountPath: string): Record<string, unknown> {
      return {
        mountPath,
        bucketName: this.bucketName,
        params: this.params,
      };
    }
  }

  class Secret {
    static async fromName(
      name: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> {
      return await secretFromNameMock(name, params);
    }

    static async fromObject(
      entries: Record<string, string>,
      params?: Record<string, unknown>,
    ): Promise<unknown> {
      return await secretFromObjectMock(entries, params);
    }
  }

  return {
    get CloudBucketMount() {
      return modalSdkMocks.cloudBucketMountAvailable
        ? CloudBucketMount
        : undefined;
    },
    ModalClient: class ModalClient {
      readonly apps = {
        fromName: appsFromNameMock,
      };

      readonly images = {
        fromRegistry: imagesFromRegistryMock,
        fromId: imagesFromIdMock,
        delete: imagesDeleteMock,
      };

      readonly sandboxes = {
        create: sandboxesCreateMock,
        fromId: sandboxesFromIdMock,
      };

      imageBuilderVersion = imageBuilderVersionMock;

      constructor(params?: Record<string, unknown>) {
        modalClientParams.push(params ?? {});
      }
    },
    get Secret() {
      return modalSdkMocks.classSecretApi
        ? Secret
        : {
            fromName: secretFromNameMock,
            fromObject: secretFromObjectMock,
          };
    },
  };
});

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

function textStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('ModalSandboxClient', () => {
  const files = new Map<string, Uint8Array>();

  beforeEach(() => {
    files.clear();
    appsFromNameMock.mockReset();
    imagesFromRegistryMock.mockReset();
    imagesFromIdMock.mockReset();
    imagesDeleteMock.mockReset();
    imageCmdMock.mockReset();
    sandboxesCreateMock.mockReset();
    sandboxesFromIdMock.mockReset();
    sandboxExecMock.mockReset();
    sandboxOpenMock.mockReset();
    sandboxTerminateMock.mockReset();
    sandboxPollMock.mockReset();
    sandboxTunnelsMock.mockReset();
    sandboxSnapshotFilesystemMock.mockReset();
    sandboxSnapshotDirectoryMock.mockReset();
    sandboxMountImageMock.mockReset();
    secretFromNameMock.mockReset();
    secretFromObjectMock.mockReset();
    imageBuilderVersionMock.mockReset();
    processMocks.runSandboxProcess.mockReset();
    modalSdkMocks.cloudBucketMountAvailable = true;
    modalSdkMocks.classSecretApi = false;
    modalClientParams.splice(0);

    appsFromNameMock.mockResolvedValue({ appId: 'ap_test' });
    imageCmdMock.mockImplementation((command: string[]) => ({
      imageId: 'im_test_cmd',
      command,
    }));
    imagesFromRegistryMock.mockReturnValue({
      imageId: 'im_test',
      cmd: imageCmdMock,
    });
    imagesFromIdMock.mockImplementation((id: string) => ({ imageId: id }));
    imagesDeleteMock.mockResolvedValue(undefined);
    sandboxPollMock.mockResolvedValue(null);
    sandboxTerminateMock.mockResolvedValue(undefined);
    sandboxSnapshotFilesystemMock.mockResolvedValue({
      objectId: 'im_snapshot_fs',
    });
    sandboxSnapshotDirectoryMock.mockResolvedValue({
      objectId: 'im_snapshot_dir',
    });
    sandboxMountImageMock.mockResolvedValue(undefined);
    secretFromNameMock.mockResolvedValue({ secretId: 'secret-from-name' });
    secretFromObjectMock.mockResolvedValue({ secretId: 'secret-from-object' });
    imageBuilderVersionMock.mockImplementation(
      (version?: string) => version ?? '2024.10',
    );
    sandboxTunnelsMock.mockResolvedValue({
      3000: {
        host: '3000-modal.example.test',
        port: 443,
      },
    });

    sandboxOpenMock.mockImplementation(
      async (path: string, mode: string = 'r') => ({
        read: async () => files.get(path) ?? new Uint8Array(),
        write: async (data: Uint8Array) => {
          if (mode.startsWith('w') || mode.startsWith('a')) {
            files.set(path, data);
          }
        },
        flush: async () => {},
        close: async () => {},
      }),
    );

    sandboxExecMock.mockImplementation(
      async (command: string[], _params?: Record<string, unknown>) => {
        if (command[0] === '/bin/sh') {
          const resolvedPath = resolvedRemotePathFromValidationCommand(
            command[2] ?? '',
          );
          if (resolvedPath) {
            return {
              stdin: {
                writeText: async (_text: string) => {},
                close: async () => {},
              },
              stdout: textStream(`${resolvedPath}\n`),
              stderr: textStream(''),
              wait: async () => 0,
            };
          }
        }

        if (command[0] === '/bin/sh' && command[2] === 'ls') {
          return {
            stdin: {
              writeText: async (_text: string) => {},
              close: async () => {},
            },
            stdout: textStream('README.md\n'),
            stderr: textStream(''),
            wait: async () => 0,
          };
        }

        if (command[0] === 'test' && command[1] === '-e') {
          const exists = files.has(command[2] ?? '');
          return {
            stdin: {
              writeText: async (_text: string) => {},
              close: async () => {},
            },
            stdout: textStream(''),
            stderr: textStream(''),
            wait: async () => (exists ? 0 : 1),
          };
        }

        if (command[0] === 'rm' && command[1] === '-f') {
          files.delete(command[3] ?? '');
        }

        return {
          stdin: {
            writeText: async (_text: string) => {},
            close: async () => {},
          },
          stdout: textStream(''),
          stderr: textStream(''),
          wait: async () => 0,
        };
      },
    );

    const sandbox = {
      sandboxId: 'sbx_test',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: sandboxTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    sandboxesCreateMock.mockResolvedValue(sandbox);
    sandboxesFromIdMock.mockResolvedValue(sandbox);
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new ModalSandboxClient();

    await expect(
      client.create({
        manifest: new Manifest(),
        snapshot: { type: 'remote' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
  });

  test('creates a sandbox, materializes the manifest, and executes commands', async () => {
    const client = new ModalSandboxClient();
    const manifest = new Manifest({
      entries: {
        'README.md': {
          type: 'file',
          content: '# Hello from Modal\n',
        },
      },
      environment: {
        SANDBOX_FLAG: 'enabled',
      },
    });

    const session = await client.create(manifest, {
      appName: 'sandbox-tests',
    } satisfies ModalSandboxClientOptions);
    const output = await session.execCommand({ cmd: 'ls' });

    expect(appsFromNameMock).toHaveBeenCalledWith('sandbox-tests', {
      createIfMissing: true,
    });
    expect(imagesFromRegistryMock).toHaveBeenCalledWith('debian:bookworm-slim');
    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_test_cmd', command: ['sleep', 'infinity'] },
      expect.objectContaining({
        workdir: '/workspace',
        env: { SANDBOX_FLAG: 'enabled' },
      }),
    );
    expect(files.get('/workspace/README.md')).toEqual(
      new TextEncoder().encode('# Hello from Modal\n'),
    );
    expect(output).toContain('Process exited with code 0');
    expect(output).toContain('README.md');
  });

  test('clears exec yield timers when commands finish before timeout', async () => {
    vi.useFakeTimers();
    try {
      const client = new ModalSandboxClient();
      const session = await client.create(new Manifest(), {
        appName: 'sandbox-tests',
      } satisfies ModalSandboxClientOptions);

      const output = await session.execCommand({
        cmd: 'true',
        yieldTimeMs: 10_000,
      });

      expect(output).toContain('Process exited with code 0');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('wraps rejected process waits as provider errors', async () => {
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (_text: string) => {},
        close: async () => {},
      },
      stdout: textStream('partial stdout\n'),
      stderr: textStream('partial stderr\n'),
      wait: async () => {
        throw new Error('wait failed');
      },
    });
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    } satisfies ModalSandboxClientOptions);

    await expect(session.execCommand({ cmd: 'false' })).rejects.toMatchObject({
      details: {
        provider: 'modal',
        operation: 'wait process',
        cause: 'wait failed',
      },
    });
  });

  test('allows disabling the Modal sleep command image override', async () => {
    const client = new ModalSandboxClient();

    await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      useSleepCmd: false,
    } satisfies ModalSandboxClientOptions);

    expect(imageCmdMock).not.toHaveBeenCalled();
    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_test', cmd: imageCmdMock },
      expect.objectContaining({
        workdir: '/workspace',
      }),
    );
  });

  test('passes Modal idleTimeoutMs through sandbox creation', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      idleTimeoutMs: 60_000,
    } satisfies ModalSandboxClientOptions);

    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_test_cmd', command: ['sleep', 'infinity'] },
      expect.objectContaining({
        idleTimeoutMs: 60_000,
      }),
    );
    expect(session.state.idleTimeoutMs).toBe(60_000);
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
    const client = new ModalSandboxClient();

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
      {
        appName: 'sandbox-tests',
      },
    );

    expect(Buffer.from(files.get('/workspace/selected.txt')!)).toEqual(
      Buffer.from('selected'),
    );
  });

  test('passes Modal cloud bucket mounts to sandbox creation', async () => {
    const client = new ModalSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'logs',
            prefix: '2026/',
            endpointUrl: 'https://s3.us-east-1.amazonaws.com',
            mountPath: 'mounted/logs',
            mountStrategy: new ModalCloudBucketMountStrategy({
              secretName: 'modal-bucket-secret',
              secretEnvironmentName: 'prod',
            }),
          },
        },
      }),
      {
        appName: 'sandbox-tests',
      },
    );

    expect(secretFromNameMock).toHaveBeenCalledWith('modal-bucket-secret', {
      environment: 'prod',
    });
    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_test_cmd', command: ['sleep', 'infinity'] },
      expect.objectContaining({
        cloudBucketMounts: {
          '/workspace/mounted/logs': expect.objectContaining({
            bucketName: 'logs',
            params: {
              bucketEndpointUrl: 'https://s3.us-east-1.amazonaws.com',
              keyPrefix: '2026/',
              readOnly: true,
              secret: { secretId: 'secret-from-name' },
            },
          }),
        },
      }),
    );
  });

  test('rejects Modal cloud bucket mounts when the SDK export is unavailable', async () => {
    modalSdkMocks.classSecretApi = true;
    modalSdkMocks.cloudBucketMountAvailable = false;
    const client = new ModalSandboxClient();

    const createPromise = client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'logs',
            mountStrategy: new ModalCloudBucketMountStrategy({
              secretName: 'modal-bucket-secret',
            }),
          },
        },
      }),
      {
        appName: 'sandbox-tests',
      },
    );

    await expect(createPromise).rejects.toBeInstanceOf(SandboxProviderError);
    await expect(createPromise).rejects.toThrow(
      'Modal cloud bucket mounts require modal.CloudBucketMount support.',
    );
    await expect(createPromise).rejects.toMatchObject({
      details: {
        provider: 'modal',
      },
    });
    expect(secretFromNameMock).not.toHaveBeenCalled();
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
  });

  test('rejects partial S3 cloud bucket credentials', async () => {
    const client = new ModalSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'logs',
              accessKeyId: 'access-key',
              mountStrategy: new ModalCloudBucketMountStrategy(),
            },
          },
        }),
        {
          appName: 'sandbox-tests',
        },
      ),
    ).rejects.toMatchObject({
      details: {
        provider: 'modal',
        mountType: 's3_mount',
      },
    });
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
  });

  test('rejects partial GCS cloud bucket credentials even with a secret name', async () => {
    const client = new ModalSandboxClient();

    const createPromise = client.create(
      new Manifest({
        entries: {
          data: {
            type: 'gcs_mount',
            bucket: 'logs',
            accessId: 'access-id',
            mountStrategy: new ModalCloudBucketMountStrategy({
              secretName: 'modal-bucket-secret',
            }),
          },
        },
      }),
      {
        appName: 'sandbox-tests',
      },
    );

    await expect(createPromise).rejects.toThrow(
      'Modal GCS bucket mounts require both accessId and secretAccessKey when either is provided.',
    );
    await expect(createPromise).rejects.toMatchObject({
      details: {
        provider: 'modal',
        mountType: 'gcs_mount',
      },
    });
    expect(secretFromNameMock).not.toHaveBeenCalled();
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
  });

  test('rejects mount manifests when reusing an existing sandbox', async () => {
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'logs',
              mountStrategy: new ModalCloudBucketMountStrategy({
                secretName: 'modal-bucket-secret',
              }),
            },
          },
        }),
        {
          appName: 'sandbox-tests',
        },
      ),
    ).rejects.toMatchObject({
      details: {
        provider: 'modal',
        feature: 'manifest.mounts',
        mountPaths: ['/workspace/data'],
      },
    });
    expect(appsFromNameMock).not.toHaveBeenCalled();
    expect(secretFromNameMock).not.toHaveBeenCalled();
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
    expect(sandboxesFromIdMock).not.toHaveBeenCalled();
  });

  test('wraps Modal cloud bucket secret failures as provider errors', async () => {
    const client = new ModalSandboxClient();
    secretFromNameMock.mockRejectedValueOnce(new Error('secret failed'));

    const createPromise = client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'logs',
            mountStrategy: new ModalCloudBucketMountStrategy({
              secretName: 'modal-bucket-secret',
            }),
          },
        },
      }),
      {
        appName: 'sandbox-tests',
      },
    );

    await expect(createPromise).rejects.toBeInstanceOf(SandboxProviderError);
    await expect(createPromise).rejects.toMatchObject({
      details: {
        provider: 'modal',
        operation: 'resolve cloud bucket secret',
        bucketName: 'logs',
        secretName: 'modal-bucket-secret',
        cause: 'secret failed',
      },
    });
  });

  test('supports image and sandbox selectors without snake_case aliases', async () => {
    const existingSandbox = {
      sandboxId: 'sbx_existing',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: sandboxTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    sandboxesFromIdMock.mockResolvedValueOnce(existingSandbox);
    imagesFromIdMock.mockRejectedValueOnce(new Error('image unavailable'));
    const client = new ModalSandboxClient({
      image: ModalImageSelector.fromId('im_existing'),
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });

    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });

    expect(imagesFromIdMock).not.toHaveBeenCalled();
    expect(imagesFromRegistryMock).not.toHaveBeenCalled();
    expect(appsFromNameMock).not.toHaveBeenCalled();
    expect(sandboxesFromIdMock).toHaveBeenCalledWith('sbx_existing');
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'sbx_existing',
      ownsSandbox: false,
      imageId: 'im_existing',
      imageTag: 'debian:bookworm-slim',
    });
  });

  test('looks up reused sandbox apps without creating them for snapshot filesystem restore', async () => {
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
      workspacePersistence: 'snapshot_filesystem',
    });

    await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    } satisfies ModalSandboxClientOptions);

    expect(appsFromNameMock).toHaveBeenCalledWith('sandbox-tests', {
      createIfMissing: false,
    });
    expect(sandboxesFromIdMock).toHaveBeenCalledWith('sbx_existing');
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
  });

  test('does not terminate reused sandboxes on close', async () => {
    const existingSandbox = {
      sandboxId: 'sbx_existing',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: sandboxTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    sandboxesFromIdMock.mockResolvedValueOnce(existingSandbox);
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });

    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    await session.close();

    expect(sandboxesFromIdMock).toHaveBeenCalledWith('sbx_existing');
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
    expect(sandboxTerminateMock).not.toHaveBeenCalled();
  });

  test('preserves reused sandbox ownership when resuming', async () => {
    const existingSandbox = {
      sandboxId: 'sbx_existing',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: sandboxTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    sandboxesFromIdMock.mockResolvedValueOnce(existingSandbox);
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });

    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    sandboxesFromIdMock.mockResolvedValueOnce(existingSandbox);
    const resumed = await client.resume(
      session.state as ModalSandboxSessionState,
    );
    await resumed.close();

    expect(session.state.ownsSandbox).toBe(false);
    expect(resumed.state.ownsSandbox).toBe(false);
    expect(appsFromNameMock).not.toHaveBeenCalled();
    expect(sandboxTerminateMock).not.toHaveBeenCalled();
  });

  test('does not terminate reused sandboxes when manifest setup fails', async () => {
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });
    sandboxOpenMock.mockRejectedValueOnce(new Error('write failed'));

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
        {
          appName: 'sandbox-tests',
        },
      ),
    ).rejects.toThrow('write failed');

    expect(sandboxesFromIdMock).toHaveBeenCalledWith('sbx_existing');
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
    expect(sandboxTerminateMock).not.toHaveBeenCalled();
  });

  test('supports editor operations and live resume', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(
      new Manifest({
        remoteMountCommandAllowlist: ['cat'],
      }),
      {
        appName: 'sandbox-tests',
      },
    );

    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected ModalSandboxSession.createEditor().');
    }

    await editor.createFile({
      type: 'create_file',
      path: 'notes.txt',
      diff: '+hello\n',
    });
    await editor.updateFile({
      type: 'update_file',
      path: 'notes.txt',
      diff: ' hello\n+world\n',
    });
    await session.materializeEntry?.({
      path: '.agents/lazy/SKILL.md',
      entry: {
        type: 'file',
        content: '# Lazy\n',
      },
    });

    const resumed = await client.resume?.(
      session.state as ModalSandboxSessionState,
    );
    await editor.deleteFile({
      type: 'delete_file',
      path: 'notes.txt',
    });

    expect(files.get('/workspace/notes.txt')).toBeUndefined();
    expect(session.state.manifest.remoteMountCommandAllowlist).toEqual(['cat']);
    expect(sandboxesFromIdMock).toHaveBeenCalledWith('sbx_test');
    expect(resumed?.state.sandboxId).toBe('sbx_test');
  });

  test('wraps Modal resume SDK failures as provider errors', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    sandboxesFromIdMock.mockRejectedValueOnce(new Error('resume failed'));

    await expect(
      client.resume(session.state as ModalSandboxSessionState),
    ).rejects.toMatchObject({
      details: {
        provider: 'modal',
        operation: 'resume sandbox',
        sandboxId: 'sbx_test',
        cause: 'resume failed',
      },
    });
  });

  test('accepts absolute workspace paths for filesystem helpers', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello from Modal\n',
          },
        },
      }),
      {
        appName: 'sandbox-tests',
      },
    );
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected ModalSandboxSession.createEditor().');
    }

    await editor.updateFile({
      type: 'update_file',
      path: '/workspace/README.md',
      diff: '@@\n-# Hello from Modal\n+# Updated from Modal\n',
    });
    const exists = await session.pathExists('/workspace/README.md');

    expect(files.get('/workspace/README.md')).toEqual(
      new TextEncoder().encode('# Updated from Modal\n'),
    );
    expect(exists).toBe(true);
    await expect(
      session.pathExists('/workspace/../tmp/README.md'),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test('preserves configured credentials when resuming', async () => {
    const client = new ModalSandboxClient({
      appName: 'sandbox-tests',
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
    });
    const session = await client.create(new Manifest());

    await client.resume(session.state as ModalSandboxSessionState);

    expect(modalClientParams.at(-1)).toMatchObject({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
    });
  });

  test('defers cloud bucket mount secret resolution during plain resume', async () => {
    const client = new ModalSandboxClient();
    const state: ModalSandboxSessionState = {
      sandboxId: 'sbx_test',
      appName: 'sandbox-tests',
      imageTag: 'debian:bookworm-slim',
      manifest: new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'logs',
            mountStrategy: new ModalCloudBucketMountStrategy({
              secretName: 'modal-bucket-secret',
            }),
          },
        },
      }),
      workspacePersistence: 'snapshot_filesystem',
      environment: {},
      useSleepCmd: true,
    };

    const session = await client.resume(state);

    expect(sandboxesFromIdMock).toHaveBeenCalledWith('sbx_test');
    expect(secretFromNameMock).not.toHaveBeenCalled();
    expect(secretFromObjectMock).not.toHaveBeenCalled();

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'modal_snapshot_filesystem',
        snapshotId: 'im_snapshot_fs',
        workspacePersistence: 'snapshot_filesystem',
      }),
    );

    expect(secretFromNameMock).toHaveBeenCalledWith('modal-bucket-secret', {});
    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_snapshot_fs' },
      expect.objectContaining({
        cloudBucketMounts: {
          '/workspace/data': expect.objectContaining({
            bucketName: 'logs',
            params: expect.objectContaining({
              secret: { secretId: 'secret-from-name' },
            }),
          }),
        },
      }),
    );
  });

  test('preserves client env while manifest values take precedence', async () => {
    const client = new ModalSandboxClient({
      env: {
        CLIENT_ONLY: 'override',
        TOKEN: 'client',
      },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          MANIFEST_FLAG: 'enabled',
          TOKEN: 'manifest',
        },
      }),
      {
        appName: 'sandbox-tests',
      },
    );
    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_test_cmd', command: ['sleep', 'infinity'] },
      expect.objectContaining({
        env: {
          CLIENT_ONLY: 'override',
          MANIFEST_FLAG: 'enabled',
          TOKEN: 'manifest',
        },
      }),
    );

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

    expect(session.state.environment).toEqual({
      CLIENT_ONLY: 'override',
      MANIFEST_FLAG: 'updated',
      EXTRA_FLAG: 'present',
      TOKEN: 'manifest-updated',
    });
    expect(sandboxExecMock).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({
        env: {
          CLIENT_ONLY: 'override',
          MANIFEST_FLAG: 'updated',
          EXTRA_FLAG: 'present',
          TOKEN: 'manifest-updated',
        },
      }),
    );
  });

  test('rejects live Modal cloud bucket mount updates', async () => {
    const client = new ModalSandboxClient({
      workspacePersistence: 'snapshot_filesystem',
    });
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    sandboxesCreateMock.mockClear();
    secretFromNameMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'updated-logs',
              mountPath: 'data',
              mountStrategy: new ModalCloudBucketMountStrategy({
                secretName: 'modal-bucket-secret',
              }),
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        provider: 'modal',
        feature: 'manifest.mounts',
        mountPaths: ['/workspace/data'],
      },
    });

    expect(secretFromNameMock).not.toHaveBeenCalled();
    expect(sandboxesCreateMock).not.toHaveBeenCalled();
  });

  test('rejects live Modal updates that replace existing cloud bucket mounts', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'logs',
            mountStrategy: new ModalCloudBucketMountStrategy({
              secretName: 'modal-bucket-secret',
            }),
          },
        },
      }),
      {
        appName: 'sandbox-tests',
      },
    );
    sandboxExecMock.mockClear();
    sandboxOpenMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            data: {
              type: 'file',
              content: 'replacement',
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        provider: 'modal',
        feature: 'manifest.mounts',
        mountPaths: ['/workspace/data'],
      },
    });

    await expect(
      session.materializeEntry!({
        path: 'data/notes.txt',
        entry: {
          type: 'file',
          content: 'notes',
        },
      }),
    ).rejects.toMatchObject({
      details: {
        provider: 'modal',
        feature: 'manifest.mounts',
        mountPaths: ['/workspace/data'],
      },
    });

    expect(sandboxExecMock).not.toHaveBeenCalled();
    expect(sandboxOpenMock).not.toHaveBeenCalled();
    expect(session.state.manifest.mountTargets()).toHaveLength(1);
  });

  test('persists and hydrates snapshot_filesystem references', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
      snapshotFilesystemTimeoutMs: 12_345,
      snapshotFilesystemRestoreTimeoutMs: 23_456,
      idleTimeoutMs: 60_000,
      exposedPorts: [3000],
    } satisfies ModalSandboxClientOptions);

    const snapshotBytes = await session.persistWorkspace();
    const ref = decodeNativeSnapshotRef(snapshotBytes);

    expect(sandboxSnapshotFilesystemMock).toHaveBeenCalledWith(12_345);
    expect(ref).toEqual({
      provider: 'modal_snapshot_filesystem',
      snapshotId: 'im_snapshot_fs',
      workspacePersistence: 'snapshot_filesystem',
    });

    sandboxesCreateMock.mockClear();
    await session.hydrateWorkspace(snapshotBytes);

    expect(imagesFromIdMock).toHaveBeenCalledWith('im_snapshot_fs');
    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_snapshot_fs' },
      expect.objectContaining({
        workdir: '/workspace',
        env: {},
        idleTimeoutMs: 60_000,
        encryptedPorts: [3000],
      }),
    );
    expect(sandboxTerminateMock).toHaveBeenCalledOnce();
    expect(session.state.snapshotFilesystemRestoreTimeoutMs).toBe(23_456);
    expect(session.state.idleTimeoutMs).toBe(60_000);
  });

  test('falls back to tar persistence when the workspace root is ephemeral', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    sandboxExecMock.mockImplementation(
      async (command: string[], _params?: Record<string, unknown>) => {
        if (command[0] === '/bin/sh') {
          const resolvedPath = resolvedRemotePathFromValidationCommand(
            command[2] ?? '',
          );
          if (resolvedPath) {
            return {
              stdin: { writeText: async () => {}, close: async () => {} },
              stdout: textStream(`${resolvedPath}\n`),
              stderr: textStream(''),
              wait: async () => 0,
            };
          }
          const archivePath = command[2]?.match(/-cf '([^']+)'/)?.[1];
          if (archivePath) {
            files.set(archivePath, archive);
          }
        }
        return {
          stdin: { writeText: async () => {}, close: async () => {} },
          stdout: textStream(''),
          stderr: textStream(''),
          wait: async () => 0,
        };
      },
    );
    const client = new ModalSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          '': {
            type: 'dir',
            ephemeral: true,
          },
        },
      }),
      {
        appName: 'sandbox-tests',
        workspacePersistence: 'snapshot_filesystem',
      } satisfies ModalSandboxClientOptions,
    );

    const snapshotBytes = await session.persistWorkspace();

    expect(sandboxSnapshotFilesystemMock).not.toHaveBeenCalled();
    expect(decodeNativeSnapshotRef(snapshotBytes)).toBeUndefined();
    expect(snapshotBytes).toEqual(archive);
  });

  test('clears cached exposed ports after snapshot filesystem restore', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
      exposedPorts: [3000],
    } satisfies ModalSandboxClientOptions);
    const originalEndpoint = await session.resolveExposedPort(3000);
    const snapshotBytes = await session.persistWorkspace();
    const replacementTunnelsMock = vi.fn().mockResolvedValue({
      3000: {
        host: '3000-restored-modal.example.test',
        port: 443,
      },
    });
    const replacementSandbox = {
      sandboxId: 'sbx_restored',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: vi.fn().mockResolvedValue(undefined),
      poll: sandboxPollMock,
      tunnels: replacementTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    sandboxesCreateMock.mockResolvedValueOnce(replacementSandbox);

    await session.hydrateWorkspace(snapshotBytes);
    const restoredEndpoint = await session.resolveExposedPort(3000);

    expect(originalEndpoint.host).toBe('3000-modal.example.test');
    expect(restoredEndpoint).toMatchObject({
      host: '3000-restored-modal.example.test',
      port: 443,
      tls: true,
    });
    expect(sandboxTunnelsMock).toHaveBeenCalledOnce();
    expect(replacementTunnelsMock).toHaveBeenCalledWith(10_000);
    expect(session.state.exposedPorts?.['3000']).toBe(restoredEndpoint);
  });

  test('keeps caller-owned sandboxes alive when restoring snapshot filesystems', async () => {
    const previousTerminateMock = vi.fn().mockResolvedValue(undefined);
    const previousSandbox = {
      sandboxId: 'sbx_existing',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: previousTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    const replacementTerminateMock = vi.fn().mockResolvedValue(undefined);
    const replacementSandbox = {
      ...previousSandbox,
      sandboxId: 'sbx_restored',
      terminate: replacementTerminateMock,
    };
    sandboxesFromIdMock.mockResolvedValueOnce(previousSandbox);
    sandboxesCreateMock.mockResolvedValueOnce(replacementSandbox);
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
    } satisfies ModalSandboxClientOptions);

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'modal_snapshot_filesystem',
        snapshotId: 'im_snapshot_fs',
        workspacePersistence: 'snapshot_filesystem',
      }),
    );
    await session.close();

    expect(previousTerminateMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'sbx_restored',
      ownsSandbox: true,
    });
    expect(replacementTerminateMock).toHaveBeenCalledOnce();
  });

  test('drops caller-owned active processes when restoring snapshot filesystems', async () => {
    const closeStdinMock = vi.fn().mockResolvedValue(undefined);
    const cancelStdoutMock = vi.fn();
    const cancelStderrMock = vi.fn();
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (_text: string) => {},
        close: closeStdinMock,
      },
      stdout: new ReadableStream<string>({
        cancel: cancelStdoutMock,
      }),
      stderr: new ReadableStream<string>({
        cancel: cancelStderrMock,
      }),
      wait: async () => await new Promise<number>(() => {}),
    });
    const previousTerminateMock = vi.fn().mockResolvedValue(undefined);
    const previousSandbox = {
      sandboxId: 'sbx_existing',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: previousTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    const replacementTerminateMock = vi.fn().mockResolvedValue(undefined);
    const replacementSandbox = {
      ...previousSandbox,
      sandboxId: 'sbx_restored',
      terminate: replacementTerminateMock,
    };
    sandboxesFromIdMock.mockResolvedValueOnce(previousSandbox);
    sandboxesCreateMock.mockResolvedValueOnce(replacementSandbox);
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
    } satisfies ModalSandboxClientOptions);
    const started = await session.execCommand({
      cmd: 'long-running',
      yieldTimeMs: 0,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const activeProcesses = (
      session as unknown as {
        activeProcesses: Map<number, unknown>;
      }
    ).activeProcesses;

    expect(activeProcesses.has(sessionId)).toBe(true);

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'modal_snapshot_filesystem',
        snapshotId: 'im_snapshot_fs',
        workspacePersistence: 'snapshot_filesystem',
      }),
    );

    expect(previousTerminateMock).not.toHaveBeenCalled();
    expect(closeStdinMock).toHaveBeenCalledOnce();
    expect(cancelStdoutMock).toHaveBeenCalledOnce();
    expect(cancelStderrMock).toHaveBeenCalledOnce();
    expect(activeProcesses.size).toBe(0);

    await session.close();
    expect(replacementTerminateMock).toHaveBeenCalledOnce();
  });

  test('stops active output pumps when closing external sandboxes', async () => {
    const closeStdinMock = vi.fn().mockResolvedValue(undefined);
    const cancelStdoutMock = vi.fn();
    const cancelStderrMock = vi.fn();
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (_text: string) => {},
        close: closeStdinMock,
      },
      stdout: new ReadableStream<string>({
        cancel: cancelStdoutMock,
      }),
      stderr: new ReadableStream<string>({
        cancel: cancelStderrMock,
      }),
      wait: async () => await new Promise<number>(() => {}),
    });
    const terminateMock = vi.fn().mockResolvedValue(undefined);
    sandboxesFromIdMock.mockResolvedValueOnce({
      sandboxId: 'sbx_existing',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: terminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    });
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });

    await session.execCommand({
      cmd: 'long-running',
      yieldTimeMs: 0,
    });
    await session.close();

    expect(closeStdinMock).toHaveBeenCalledOnce();
    expect(cancelStdoutMock).toHaveBeenCalledOnce();
    expect(cancelStderrMock).toHaveBeenCalledOnce();
    expect(terminateMock).not.toHaveBeenCalled();
  });

  test('wraps snapshot_filesystem capture failures as provider errors', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
    } satisfies ModalSandboxClientOptions);
    sandboxSnapshotFilesystemMock.mockRejectedValueOnce(
      new Error('capture failed'),
    );

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      details: {
        provider: 'modal',
        operation: 'capture snapshot_filesystem',
        sandboxId: 'sbx_test',
        cause: 'capture failed',
      },
    });
  });

  test('terminates replacement sandboxes that resolve after restore timeouts', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
      snapshotFilesystemRestoreTimeoutMs: 1,
    } satisfies ModalSandboxClientOptions);
    const snapshotBytes = await session.persistWorkspace();
    const lateTerminateMock = vi.fn().mockResolvedValue(undefined);
    const lateSandbox = {
      sandboxId: 'sbx_late_restore',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: lateTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    const pendingRestore = deferred<typeof lateSandbox>();
    sandboxesCreateMock.mockReturnValueOnce(pendingRestore.promise);

    await expect(session.hydrateWorkspace(snapshotBytes)).rejects.toThrow(
      'Modal snapshot_filesystem restore timed out.',
    );

    pendingRestore.resolve(lateSandbox);
    await vi.waitFor(() => {
      expect(lateTerminateMock).toHaveBeenCalledOnce();
    });
    expect(session.state.sandboxId).toBe('sbx_test');
    expect(sandboxTerminateMock).not.toHaveBeenCalled();
  });

  test('applies snapshot_filesystem restore timeout to image lookup', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
      snapshotFilesystemRestoreTimeoutMs: 1,
    } satisfies ModalSandboxClientOptions);
    const snapshotBytes = await session.persistWorkspace();
    const pendingImage = deferred<unknown>();
    sandboxesCreateMock.mockClear();
    imagesFromIdMock.mockReturnValueOnce(pendingImage.promise);

    await expect(session.hydrateWorkspace(snapshotBytes)).rejects.toThrow(
      'Modal snapshot_filesystem restore timed out.',
    );

    expect(sandboxesCreateMock).not.toHaveBeenCalled();
  });

  test('surfaces snapshot_filesystem restore failures when previous sandbox termination fails', async () => {
    const previousTerminateMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('previous terminate failed'))
      .mockResolvedValue(undefined);
    const replacementTerminateMock = vi.fn().mockResolvedValue(undefined);
    const previousSandbox = {
      sandboxId: 'sbx_previous',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: previousTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    const replacementSandbox = {
      ...previousSandbox,
      sandboxId: 'sbx_replacement',
      terminate: replacementTerminateMock,
    };
    sandboxesCreateMock
      .mockResolvedValueOnce(previousSandbox)
      .mockResolvedValueOnce(replacementSandbox);

    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_filesystem',
    } satisfies ModalSandboxClientOptions);

    const snapshotBytes = await session.persistWorkspace();
    let restoreError: unknown;
    try {
      await session.hydrateWorkspace(snapshotBytes);
    } catch (error) {
      restoreError = error;
    }

    expect(restoreError).toBeInstanceOf(SandboxProviderError);
    expect(restoreError).toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'modal',
        sandboxId: 'sbx_previous',
        replacementSandboxId: 'sbx_replacement',
        cause: 'previous terminate failed',
      },
    });
    expect(session.state.sandboxId).toBe('sbx_previous');
    expect(previousTerminateMock).toHaveBeenCalledOnce();
    expect(replacementTerminateMock).toHaveBeenCalledOnce();

    await session.close();
    expect(previousTerminateMock).toHaveBeenCalledTimes(2);
  });

  test('persists and hydrates snapshot_directory references', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_directory',
    } satisfies ModalSandboxClientOptions);

    const snapshotBytes = await session.persistWorkspace();
    const ref = decodeNativeSnapshotRef(snapshotBytes);

    expect(sandboxSnapshotDirectoryMock).toHaveBeenCalledWith('/workspace');
    expect(ref).toEqual({
      provider: 'modal_snapshot_directory',
      snapshotId: 'im_snapshot_dir',
      workspacePersistence: 'snapshot_directory',
    });

    await session.hydrateWorkspace(snapshotBytes);

    expect(imagesFromIdMock).toHaveBeenCalledWith('im_snapshot_dir');
    expect(sandboxMountImageMock).toHaveBeenCalledWith('/workspace', {
      imageId: 'im_snapshot_dir',
    });
  });

  test('deletes snapshot_directory images that resolve after persistence timeouts', async () => {
    const pendingSnapshot = deferred<{ objectId: string }>();
    sandboxSnapshotDirectoryMock.mockReturnValueOnce(pendingSnapshot.promise);
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_directory',
      snapshotFilesystemTimeoutMs: 1,
    } satisfies ModalSandboxClientOptions);

    await expect(session.persistWorkspace()).rejects.toThrow(
      'Modal snapshot_directory persistence timed out.',
    );

    pendingSnapshot.resolve({ objectId: 'im_late_snapshot_dir' });
    await vi.waitFor(() => {
      expect(imagesDeleteMock).toHaveBeenCalledWith('im_late_snapshot_dir');
    });
  });

  test('terminates sandboxes when snapshot_directory restores resolve after timeout', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_directory',
      snapshotFilesystemRestoreTimeoutMs: 1,
    } satisfies ModalSandboxClientOptions);
    const snapshotBytes = encodeNativeSnapshotRef({
      provider: 'modal_snapshot_directory',
      snapshotId: 'im_snapshot_dir',
      workspacePersistence: 'snapshot_directory',
    });
    const pendingMount = deferred<void>();
    sandboxMountImageMock.mockReturnValueOnce(pendingMount.promise);

    await expect(session.hydrateWorkspace(snapshotBytes)).rejects.toThrow(
      'Modal snapshot_directory restore timed out.',
    );

    pendingMount.resolve();
    await vi.waitFor(() => {
      expect(sandboxTerminateMock).toHaveBeenCalledOnce();
    });
  });

  test('applies snapshot_directory restore timeout to image lookup', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_directory',
      snapshotFilesystemRestoreTimeoutMs: 1,
    } satisfies ModalSandboxClientOptions);
    const snapshotBytes = encodeNativeSnapshotRef({
      provider: 'modal_snapshot_directory',
      snapshotId: 'im_snapshot_dir',
      workspacePersistence: 'snapshot_directory',
    });
    const pendingImage = deferred<unknown>();
    imagesFromIdMock.mockReturnValueOnce(pendingImage.promise);

    await expect(session.hydrateWorkspace(snapshotBytes)).rejects.toThrow(
      'Modal snapshot_directory restore timed out.',
    );

    expect(sandboxMountImageMock).not.toHaveBeenCalled();
  });

  test('waits for reused sandbox snapshot_directory mounts instead of timing out late mutations', async () => {
    const previousTerminateMock = vi.fn().mockResolvedValue(undefined);
    const previousSandbox = {
      sandboxId: 'sbx_existing',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: previousTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    sandboxesFromIdMock.mockResolvedValueOnce(previousSandbox);
    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_directory',
      snapshotFilesystemRestoreTimeoutMs: 1,
    } satisfies ModalSandboxClientOptions);
    const snapshotBytes = encodeNativeSnapshotRef({
      provider: 'modal_snapshot_directory',
      snapshotId: 'im_snapshot_dir',
      workspacePersistence: 'snapshot_directory',
    });
    const pendingMount = deferred<void>();
    sandboxMountImageMock.mockReturnValueOnce(pendingMount.promise);

    let restoreCompleted = false;
    const restorePromise = session.hydrateWorkspace(snapshotBytes).then(() => {
      restoreCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(restoreCompleted).toBe(false);
    expect(sandboxMountImageMock).toHaveBeenCalledOnce();
    pendingMount.resolve();
    await restorePromise;

    expect(previousTerminateMock).not.toHaveBeenCalled();
  });

  test('wraps snapshot_directory restore failures as provider errors', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      workspacePersistence: 'snapshot_directory',
    } satisfies ModalSandboxClientOptions);
    const snapshotBytes = await session.persistWorkspace();
    sandboxMountImageMock.mockRejectedValueOnce(new Error('mount failed'));

    await expect(session.hydrateWorkspace(snapshotBytes)).rejects.toMatchObject(
      {
        details: {
          provider: 'modal',
          operation: 'restore snapshot_directory',
          sandboxId: 'sbx_test',
          snapshotId: 'im_snapshot_dir',
          cause: 'mount failed',
        },
      },
    );
  });

  test('rejects invalid persistence modes clearly', async () => {
    const client = new ModalSandboxClient();

    await expect(
      client.create(new Manifest(), {
        appName: 'sandbox-tests',
        workspacePersistence: 'native',
      } as unknown as ModalSandboxClientOptions),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('wraps Modal sandbox create SDK failures as provider errors', async () => {
    const client = new ModalSandboxClient();
    sandboxesCreateMock.mockRejectedValueOnce(new Error('modal unavailable'));

    await expect(
      client.create(new Manifest(), {
        appName: 'sandbox-tests',
      }),
    ).rejects.toBeInstanceOf(SandboxProviderError);
  });

  test('terminates sandboxes that resolve after create timeouts', async () => {
    const lateTerminateMock = vi.fn().mockResolvedValue(undefined);
    const lateSandbox = {
      sandboxId: 'sbx_late',
      exec: sandboxExecMock,
      open: sandboxOpenMock,
      terminate: lateTerminateMock,
      poll: sandboxPollMock,
      tunnels: sandboxTunnelsMock,
      snapshotFilesystem: sandboxSnapshotFilesystemMock,
      snapshotDirectory: sandboxSnapshotDirectoryMock,
      mountImage: sandboxMountImageMock,
    };
    const pendingCreate = deferred<typeof lateSandbox>();
    sandboxesCreateMock.mockReturnValueOnce(pendingCreate.promise);

    const client = new ModalSandboxClient();
    await expect(
      client.create(new Manifest(), {
        appName: 'sandbox-tests',
        sandboxCreateTimeoutS: 0.001,
      }),
    ).rejects.toThrow('Modal sandbox creation timed out.');

    pendingCreate.resolve(lateSandbox);
    await vi.waitFor(() => {
      expect(lateTerminateMock).toHaveBeenCalledOnce();
    });
  });

  test('resolves configured exposed ports through Modal tunnels', async () => {
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
      exposedPorts: [3000],
    } satisfies ModalSandboxClientOptions);

    const endpoint = await session.resolveExposedPort(3000);
    const cachedEndpoint = await session.resolveExposedPort(3000);

    expect(sandboxesCreateMock).toHaveBeenCalledWith(
      { appId: 'ap_test' },
      { imageId: 'im_test_cmd', command: ['sleep', 'infinity'] },
      expect.objectContaining({
        encryptedPorts: [3000],
      }),
    );
    expect(sandboxTunnelsMock).toHaveBeenCalledWith(10_000);
    expect(sandboxTunnelsMock).toHaveBeenCalledOnce();
    expect(endpoint).toMatchObject({
      host: '3000-modal.example.test',
      port: 443,
      tls: true,
    });
    expect(cachedEndpoint).toBe(endpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('terminates active commands before waiting during close', async () => {
    let releaseWait!: () => void;
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (_text: string) => {},
        close: async () => {},
      },
      stdout: textStream(''),
      stderr: textStream(''),
      wait: async () =>
        await new Promise<number>((resolve) => {
          releaseWait = () => resolve(137);
        }),
    });
    sandboxTerminateMock.mockImplementation(async () => {
      releaseWait();
    });

    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    const started = await session.execCommand({
      cmd: 'sleep 3600',
      yieldTimeMs: 0,
    });

    await expect(session.close()).resolves.toBeUndefined();

    expect(started).toContain('Process running with session ID');
    expect(sandboxTerminateMock).toHaveBeenCalledOnce();
  });

  test('detaches from active commands without waiting for reused sandboxes', async () => {
    const stdinCloseMock = vi.fn(async () => {});
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (_text: string) => {},
        close: stdinCloseMock,
      },
      stdout: textStream(''),
      stderr: textStream(''),
      wait: async () => await new Promise<number>(() => {}),
    });

    const client = new ModalSandboxClient({
      sandbox: ModalSandboxSelector.fromId('sbx_existing'),
    });
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    const started = await session.execCommand({
      cmd: 'sleep 3600',
      yieldTimeMs: 0,
    });

    const closeResult = await Promise.race([
      session.close().then(() => 'closed'),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('timeout'), 50);
      }),
    ]);

    expect(started).toContain('Process running with session ID');
    expect(closeResult).toBe('closed');
    expect(stdinCloseMock).toHaveBeenCalledOnce();
    expect(sandboxTerminateMock).not.toHaveBeenCalled();
  });

  test('does not terminate twice when shutdown and delete both close', async () => {
    sandboxTerminateMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second terminate'));
    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });

    await expect(session.shutdown()).resolves.toBeUndefined();
    await expect(session.delete()).resolves.toBeUndefined();

    expect(sandboxTerminateMock).toHaveBeenCalledOnce();
  });

  test('returns only unread output from active process polls', async () => {
    let stdoutController!: ReadableStreamDefaultController<string>;
    let resolveWait!: (code: number) => void;
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (text: string) => {
          stdoutController.enqueue(`input:${text}`);
        },
        close: async () => {},
      },
      stdout: new ReadableStream<string>({
        start(controller) {
          stdoutController = controller;
          controller.enqueue('ready\n');
        },
      }),
      stderr: textStream(''),
      wait: async () =>
        await new Promise<number>((resolve) => {
          resolveWait = resolve;
        }),
    });

    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    const started = await session.execCommand({
      cmd: 'long-running',
      yieldTimeMs: 50,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const firstPoll = await session.writeStdin({
      sessionId,
      yieldTimeMs: 0,
    });
    const secondPoll = await session.writeStdin({
      sessionId,
      chars: 'hello\n',
      yieldTimeMs: 50,
    });

    stdoutController.close();
    resolveWait(0);
    await session.writeStdin({
      sessionId,
      yieldTimeMs: 50,
    });

    expect(started).toContain('ready');
    expect(firstPoll).not.toContain('ready');
    expect(secondPoll).toContain('input:hello');
    expect(secondPoll).not.toContain('ready');
  });

  test('prunes completed active processes when clients stop polling', async () => {
    let stdoutController!: ReadableStreamDefaultController<string>;
    let resolveWait!: (code: number) => void;
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (_text: string) => {},
        close: async () => {},
      },
      stdout: new ReadableStream<string>({
        start(controller) {
          stdoutController = controller;
        },
      }),
      stderr: textStream(''),
      wait: async () =>
        await new Promise<number>((resolve) => {
          resolveWait = resolve;
        }),
    });

    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    const started = await session.execCommand({
      cmd: 'long-running',
      yieldTimeMs: 0,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );
    const activeProcesses = (
      session as unknown as {
        activeProcesses: Map<number, unknown>;
      }
    ).activeProcesses;

    expect(activeProcesses.has(sessionId)).toBe(true);

    vi.useFakeTimers();
    try {
      stdoutController.close();
      resolveWait(0);
      await vi.runAllTimersAsync();

      expect(activeProcesses.has(sessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('bounds unread active process output', async () => {
    let stdoutController!: ReadableStreamDefaultController<string>;
    let resolveWait!: (code: number) => void;
    sandboxExecMock.mockResolvedValueOnce({
      stdin: {
        writeText: async (_text: string) => {},
        close: async () => {},
      },
      stdout: new ReadableStream<string>({
        start(controller) {
          stdoutController = controller;
          controller.enqueue('a'.repeat(1024 * 1024 + 10));
        },
      }),
      stderr: textStream(''),
      wait: async () =>
        await new Promise<number>((resolve) => {
          resolveWait = resolve;
        }),
    });

    const client = new ModalSandboxClient();
    const session = await client.create(new Manifest(), {
      appName: 'sandbox-tests',
    });
    const started = await session.execCommand({
      cmd: 'noisy',
      yieldTimeMs: 50,
      maxOutputTokens: 20,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );

    stdoutController.close();
    resolveWait(0);
    await session.writeStdin({
      sessionId,
      yieldTimeMs: 50,
    });

    expect(started).toContain('characters truncated from process output');
    expect(started).toContain('Process running with session ID');
    expect(started.length).toBeLessThan(5_000);
  });
});
