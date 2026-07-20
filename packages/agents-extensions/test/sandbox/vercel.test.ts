import {
  Manifest,
  SandboxArchiveError,
  SandboxLifecycleError,
  SandboxMountError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  r2Mount,
  s3Mount,
  type S3Mount,
} from '@openai/agents-core/sandbox';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
} from '../../src/sandbox/shared';
import {
  listVercelCloudBucketMountPaths,
  unmountVercelCloudBucket,
  VercelCloudBucketMountStrategy,
  VercelSandboxClient,
} from '../../src/sandbox/vercel';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const createMock = vi.fn();
const getMock = vi.fn();
const runCommandMock = vi.fn();
const rawRunCommandMock = vi.fn();
const mkDirMock = vi.fn();
const readFileToBufferMock = vi.fn();
const writeFilesMock = vi.fn();
const stopMock = vi.fn();
const snapshotMock = vi.fn();
const domainMock = vi.fn();
const remoteFilePaths = new Set<string>();

function makeSandbox(
  sandboxId: string,
  overrides: Record<string, unknown> = {},
) {
  const liveS3MountPaths = new Set<string>();
  let physicalMountStateManaged = false;
  let acceptExternalMountListing = false;
  let failedUnmountPath: string | undefined;
  const { runCommand = runCommandMock, ...remainingOverrides } =
    overrides as Record<string, unknown> & {
      runCommand?: (params: Record<string, unknown>) => unknown;
    };
  return {
    sandboxId,
    runCommand: async (params: Record<string, unknown>) => {
      rawRunCommandMock(params);
      const unwrappedParams = unwrapIsolatedMountCommand(params);
      const result = (await runCommand(unwrappedParams)) as {
        exitCode?: number | null;
        output?: (stream?: 'stdout' | 'stderr' | 'both') => Promise<string>;
      };
      const args = Array.isArray(unwrappedParams.args)
        ? unwrappedParams.args
        : [];
      if (unwrappedParams.cmd === 'findmnt' && args.includes('TARGET')) {
        if (physicalMountStateManaged && !acceptExternalMountListing) {
          return liveS3MountPaths.size === 0
            ? commandFinished(1)
            : commandFinished(0, `${[...liveS3MountPaths].join('\n')}\n`);
        }
        acceptExternalMountListing = false;
        if (result.exitCode === 0 && typeof result.output === 'function') {
          const stdout = await result.output('stdout');
          liveS3MountPaths.clear();
          for (const mountPath of stdout.split(/\r?\n/u).filter(Boolean)) {
            liveS3MountPaths.add(mountPath);
          }
        }
      }
      if (result.exitCode === 0) {
        if (unwrappedParams.cmd === 'mount-s3' && typeof args[1] === 'string') {
          physicalMountStateManaged = true;
          liveS3MountPaths.add(args[1]);
        }
        if (unwrappedParams.cmd === 'umount' && typeof args[0] === 'string') {
          physicalMountStateManaged = true;
          failedUnmountPath = undefined;
          liveS3MountPaths.delete(args[0]);
        }
      }
      if (
        result.exitCode !== 0 &&
        unwrappedParams.cmd === 'umount' &&
        typeof args[0] === 'string'
      ) {
        failedUnmountPath = args[0];
      }
      if (
        result.exitCode === 1 &&
        unwrappedParams.cmd === 'mountpoint' &&
        failedUnmountPath !== undefined &&
        typeof args.at(-1) === 'string' &&
        args.at(-1) === failedUnmountPath
      ) {
        physicalMountStateManaged = true;
        acceptExternalMountListing = true;
        liveS3MountPaths.delete(failedUnmountPath);
        failedUnmountPath = undefined;
      }
      return result;
    },
    mkDir: mkDirMock,
    readFileToBuffer: readFileToBufferMock,
    writeFiles: writeFilesMock,
    stop: stopMock,
    snapshot: snapshotMock,
    domain: domainMock,
    ...remainingOverrides,
  };
}

function unwrapIsolatedMountCommand(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const args = Array.isArray(params.args) ? params.args : [];
  if (
    params.cmd !== '/bin/sh' ||
    args[0] !== '-c' ||
    args[2] !== 'vercel-sandbox-mount-command'
  ) {
    return params;
  }
  const environment =
    params.env && typeof params.env === 'object'
      ? Object.fromEntries(
          Object.entries(params.env).filter(([, value]) => value !== ''),
        )
      : undefined;
  return {
    ...params,
    cmd: args[3],
    args: args.slice(4),
    ...(environment ? { env: environment } : {}),
  };
}

function vercelAlreadyExistsError(path: string): unknown {
  return {
    json: {
      error: {
        code: 'file_error',
        message: `error creating directory: cannot create directory '${path}': File exists`,
      },
    },
  };
}

function vercelHttpError(status: number): Error {
  return Object.assign(new Error(`Vercel request failed with ${status}.`), {
    response: {
      status,
      statusText: status === 401 ? 'Unauthorized' : 'Request failed',
    },
  });
}

function testExistsPath(command: string): string | undefined {
  return command.match(/^test -e '([^']+)'$/u)?.[1];
}

function commandFinished(
  exitCode: number | null = 0,
  stdout: string = '',
  stderr: string = '',
) {
  return {
    exitCode,
    output: vi.fn(async (stream?: 'stdout' | 'stderr' | 'both') => {
      if (stream === 'stderr') {
        return stderr;
      }
      if (stream === 'both') {
        return `${stdout}${stderr}`;
      }
      return stdout;
    }),
  };
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

function trustPersistedS3Mounts(args: {
  persistedMounts: ReadonlyArray<{
    logicalPath: string;
    mountPath: string;
    mount: Readonly<S3Mount>;
  }>;
}) {
  return args.persistedMounts.map(({ logicalPath, mountPath, mount }) => ({
    logicalPath,
    mountPath,
    mount: structuredClone(mount),
  }));
}

async function defaultRunCommand(
  params: { cmd?: string; args?: string[] } = {},
) {
  if (params.cmd === 'id') {
    return commandFinished(0, params.args?.[0] === '-g' ? '1001\n' : '1000\n');
  }
  if (params.cmd === 'find') {
    return commandFinished(0);
  }
  if (params.cmd === 'findmnt') {
    if (params.args?.includes('TARGET')) {
      return commandFinished(1);
    }
    return commandFinished(0, 'mountpoint-s3\n');
  }
  if (params.cmd === 'rpm' && params.args?.at(-1) === 'mount-s3') {
    return commandFinished(0, '1.21.0');
  }
  const command = params.args?.[1] ?? '';
  const path = testExistsPath(command);
  if (path) {
    return commandFinished(remoteFilePaths.has(path) ? 0 : 1);
  }
  const resolvedPath = resolvedRemotePathFromValidationCommand(command);
  return commandFinished(0, resolvedPath ? `${resolvedPath}\n` : 'README.md\n');
}

vi.mock('@vercel/sandbox', () => ({
  Sandbox: {
    create: createMock,
    get: getMock,
  },
}));

describe('VercelSandboxClient', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL_PROJECT_ID', '');
    vi.stubEnv('VERCEL_TEAM_ID', '');
    vi.stubEnv('VERCEL_TOKEN', '');
    createMock.mockReset();
    getMock.mockReset();
    runCommandMock.mockReset();
    rawRunCommandMock.mockReset();
    mkDirMock.mockReset();
    readFileToBufferMock.mockReset();
    writeFilesMock.mockReset();
    stopMock.mockReset();
    snapshotMock.mockReset();
    domainMock.mockReset();
    remoteFilePaths.clear();

    createMock.mockResolvedValue(makeSandbox('vercel_test'));
    getMock.mockResolvedValue(makeSandbox('vercel_test'));
    runCommandMock.mockImplementation(defaultRunCommand);
    mkDirMock.mockResolvedValue(undefined);
    readFileToBufferMock.mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    writeFilesMock.mockImplementation(
      async (files: Array<{ path?: unknown }> = []) => {
        for (const file of files) {
          if (typeof file.path === 'string') {
            remoteFilePaths.add(file.path);
          }
        }
      },
    );
    stopMock.mockResolvedValue(undefined);
    snapshotMock.mockResolvedValue({ snapshotId: 'snap_test' });
    domainMock.mockReturnValue('https://3000-vercel.example.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create({
        manifest: new Manifest(),
        snapshot: { type: 'remote' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('creates a sandbox, remaps the default root, and executes commands', async () => {
    const client = new VercelSandboxClient();
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

    expect(session.state.manifest.root).toBe('/vercel/sandbox');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/README.md',
        content: '# Hello\n',
      },
    ]);
    expect(mkDirMock).not.toHaveBeenCalledWith('/vercel/sandbox');
    expect(runCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'ls'],
      cwd: '/vercel/sandbox',
      env: {},
    });
    expect(output).toContain('README.md');
  });

  test('rejects non-S3 mounts and incomplete S3 credentials', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: r2Mount({
              bucket: 'bucket',
              accountId: 'account',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              accessKeyId: 'access-value',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              sessionToken: 'session-value',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
    });

    expect(createMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
  });

  test('rejects explicit S3 credentials without an exposure opt-in', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              accessKeyId: 'access-value',
              secretAccessKey: 'secret-value',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      message: expect.stringContaining('allowS3CredentialExposure'),
      details: {
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects resolved S3 credentials without an exposure opt-in', async () => {
    const client = new VercelSandboxClient({
      resolveS3MountCredentials: async () => ({
        accessKeyId: 'access-value',
        secretAccessKey: 'secret-value',
      }),
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      message: expect.stringContaining('allowS3CredentialExposure'),
      details: {
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(stopMock).toHaveBeenCalledOnce();
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
  });

  test('rejects S3 mounts at the workspace root before creating a sandbox', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountPath: '/vercel/sandbox',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPath: '/vercel/sandbox',
        root: '/vercel/sandbox',
      },
    });

    expect(createMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  test('rejects S3 mounts that resolve to the workspace root', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-root')) {
          return commandFinished(0, '/vercel/sandbox\n');
        }
        return await defaultRunCommand(params);
      },
    );
    runCommandMock.mockClear();

    await expect(
      session.materializeEntry({
        path: 'data',
        entry: s3Mount({
          bucket: 'bucket',
          mountPath: '/vercel/sandbox/linked-root',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      }),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPath: '/vercel/sandbox',
        root: '/vercel/sandbox',
      },
    });

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    await session.close();
  });

  test('rejects invalid applied mounts before writing manifest entries', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    writeFilesMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            'README.md': {
              type: 'file',
              content: '# Hidden partial write\n',
            },
            data: r2Mount({
              bucket: 'bucket',
              accountId: 'account',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);

    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(session.state.manifest.entries).not.toHaveProperty('README.md');
  });

  test('rejects duplicate resolved mounts before writing manifest entries', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (
          requestedPath === '/vercel/sandbox/linked-first' ||
          requestedPath === '/vercel/sandbox/linked-second'
        ) {
          return commandFinished(0, '/vercel/sandbox/shared-target\n');
        }
        return await defaultRunCommand(params);
      },
    );
    writeFilesMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            'README.md': {
              type: 'file',
              content: '# Hidden partial write\n',
            },
            first: s3Mount({
              bucket: 'first-bucket',
              mountPath: '/vercel/sandbox/linked-first',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            second: s3Mount({
              bucket: 'second-bucket',
              mountPath: '/vercel/sandbox/linked-second',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPath: '/vercel/sandbox/shared-target',
      },
    });

    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    expect(session.state.manifest.entries).not.toHaveProperty('README.md');
  });

  test('defers nested duplicate checks until the parent mount is active', async () => {
    let parentMounted = false;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'parent-bucket') {
          parentMounted = true;
        }
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (
          !parentMounted &&
          (requestedPath === '/vercel/sandbox/parent/first' ||
            requestedPath === '/vercel/sandbox/parent/second')
        ) {
          return commandFinished(0, '/vercel/sandbox/shared-target\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockClear();

    await session.applyManifest(
      new Manifest({
        entries: {
          parent: s3Mount({
            bucket: 'parent-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          first: s3Mount({
            bucket: 'first-bucket',
            mountPath: '/vercel/sandbox/parent/first',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountPath: '/vercel/sandbox/parent/second',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'mount-s3')
        .map(({ args }) => [args?.[0], args?.[1]]),
    ).toEqual([
      ['parent-bucket', '/vercel/sandbox/parent'],
      ['first-bucket', '/vercel/sandbox/parent/first'],
      ['second-bucket', '/vercel/sandbox/parent/second'],
    ]);
  });

  test('rejects mount targets that cover incoming manifest files before writing', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            'data/file.txt': {
              type: 'file',
              content: 'must remain visible\n',
            },
            bucket: s3Mount({
              bucket: 'bucket',
              mountPath: 'data',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        path: '/vercel/sandbox/data/file.txt',
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('rejects a new mount that covers an existing manifest file', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'data/file.txt': {
            type: 'file',
            content: 'must remain visible\n',
          },
        },
      }),
    );
    runCommandMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            bucket: s3Mount({
              bucket: 'bucket',
              mountPath: 'data',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        path: '/vercel/sandbox/data/file.txt',
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    expect(session.state.manifest.entries).not.toHaveProperty('bucket');
  });

  test('rejects a non-empty resolved mount directory', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'find' &&
          params.args?.[0] === '/vercel/sandbox/data'
        ) {
          return commandFinished(0, '/vercel/sandbox/data/existing.txt\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'find',
        args: [
          '/vercel/sandbox/data',
          '-mindepth',
          '1',
          '-maxdepth',
          '1',
          '-print',
          '-quit',
        ],
      }),
    );
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('rejects a mount when directory inspection output is unavailable', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'find') {
          return {
            exitCode: 0,
            output: vi.fn(async () => {
              throw new Error('output unavailable');
            }),
          };
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_failed',
      details: {
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('orders manifest mounts by resolved topology', async () => {
    const resolvedMountPaths = new Map([
      ['/vercel/sandbox/linked-child', '/vercel/sandbox/real-parent/child'],
      ['/vercel/sandbox/linked-parent', '/vercel/sandbox/real-parent'],
    ]);
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        const resolvedPath = requestedPath
          ? resolvedMountPaths.get(requestedPath)
          : undefined;
        if (resolvedPath) {
          return commandFinished(0, `${resolvedPath}\n`);
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          child: s3Mount({
            bucket: 'child-bucket',
            mountPath: '/vercel/sandbox/linked-child',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          parent: s3Mount({
            bucket: 'parent-bucket',
            mountPath: '/vercel/sandbox/linked-parent',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'mount-s3')
        .map(({ args }) => [args?.[0], args?.[1]]),
    ).toEqual([
      ['parent-bucket', '/vercel/sandbox/real-parent'],
      ['child-bucket', '/vercel/sandbox/real-parent/child'],
    ]);
  });

  test('rejects manifest mounts that resolve to the same path', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (
          requestedPath === '/vercel/sandbox/linked-first' ||
          requestedPath === '/vercel/sandbox/linked-second'
        ) {
          return commandFinished(0, '/vercel/sandbox/shared-target\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            first: s3Mount({
              bucket: 'first-bucket',
              mountPath: '/vercel/sandbox/linked-first',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            second: s3Mount({
              bucket: 'second-bucket',
              mountPath: '/vercel/sandbox/linked-second',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPath: '/vercel/sandbox/shared-target',
        declaredMountPaths: [
          '/vercel/sandbox/linked-first',
          '/vercel/sandbox/linked-second',
        ],
      },
    });
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('installs Mountpoint and mounts S3 with structured credentials', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'sh' &&
          params.args?.[1] === 'command -v mount-s3 >/dev/null 2>&1'
        ) {
          return commandFinished(1);
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });

    await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            accessKeyId: 'access-value',
            secretAccessKey: 'secret-value',
            sessionToken: 'session-value',
            region: 'us-east-1',
            prefix: 'reports/',
            readOnly: false,
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    const mountCommands = runCommandMock.mock.calls
      .map(([params]) => params)
      .filter(({ cmd }) => cmd !== '/bin/sh');
    expect(mountCommands.map(({ cmd }) => cmd)).toEqual([
      'sh',
      'dnf',
      'rpm',
      'mkdir',
      'id',
      'id',
      'find',
      'mount-s3',
      'findmnt',
    ]);
    expect(mountCommands[1]).toMatchObject({
      cmd: 'dnf',
      args: ['install', '-y', '--setopt=gpgcheck=1', 'fuse', 'mount-s3'],
      sudo: true,
      signal: expect.any(AbortSignal),
    });
    expect(mountCommands[2]).toMatchObject({
      cmd: 'rpm',
      args: ['--query', '--queryformat', '%{VERSION}', 'mount-s3'],
      signal: expect.any(AbortSignal),
    });
    expect(mountCommands[3]).toMatchObject({
      cmd: 'mkdir',
      args: ['-p', '--', '/vercel/sandbox/data'],
      signal: expect.any(AbortSignal),
    });
    expect(mountCommands[3]).not.toHaveProperty('sudo');
    expect(mountCommands[4]).toMatchObject({
      cmd: 'id',
      args: ['-u'],
      signal: expect.any(AbortSignal),
    });
    expect(mountCommands[5]).toMatchObject({
      cmd: 'id',
      args: ['-g'],
      signal: expect.any(AbortSignal),
    });
    expect(mountCommands[6]).toMatchObject({
      cmd: 'find',
      args: [
        '/vercel/sandbox/data',
        '-mindepth',
        '1',
        '-maxdepth',
        '1',
        '-print',
        '-quit',
      ],
      signal: expect.any(AbortSignal),
    });
    expect(mountCommands[7]).toMatchObject({
      cmd: 'mount-s3',
      args: [
        'bucket',
        '/vercel/sandbox/data',
        '--allow-other',
        '--allow-overwrite',
        '--allow-delete',
        '--uid',
        '1000',
        '--gid',
        '1001',
        '--region',
        'us-east-1',
        '--prefix',
        'reports/',
      ],
      env: {
        AWS_ACCESS_KEY_ID: 'access-value',
        AWS_SECRET_ACCESS_KEY: 'secret-value',
        AWS_SESSION_TOKEN: 'session-value',
        AWS_REGION: 'us-east-1',
      },
      signal: expect.any(AbortSignal),
      sudo: true,
    });
    const commandText = JSON.stringify(
      mountCommands.map(({ cmd, args }) => ({ cmd, args })),
    );
    expect(commandText).not.toContain('access-value');
    expect(commandText).not.toContain('secret-value');
    expect(commandText).not.toContain('session-value');
  });

  test('accepts a newer compatible preinstalled Mountpoint version', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'rpm') {
          return commandFinished(0, '1.22.3');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'dnf'),
    ).toBe(false);
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(true);
  });

  test.each(['1.20.9', '2.0.0', 'invalid'])(
    'rejects unsupported preinstalled Mountpoint version %s',
    async (version) => {
      runCommandMock.mockImplementation(
        async (params: { cmd?: string; args?: string[] } = {}) => {
          if (params.cmd === 'rpm') {
            return commandFinished(0, version);
          }
          return await defaultRunCommand(params);
        },
      );
      const client = new VercelSandboxClient();

      await expect(
        client.create(
          new Manifest({
            entries: {
              data: s3Mount({
                bucket: 'bucket',
                mountStrategy: new VercelCloudBucketMountStrategy(),
              }),
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'mount_failed',
        details: {
          minimumVersion: '1.21.0',
          supportedMajorVersion: 1,
          actualVersion: version,
        },
      });
      expect(
        runCommandMock.mock.calls.some(([params]) => params.cmd === 'dnf'),
      ).toBe(false);
      expect(
        runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
      ).toBe(false);
    },
  );

  test('uses a trusted PATH for credential-bearing mount commands', async () => {
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
      env: {
        PATH: '/vercel/sandbox/untrusted-bin',
        AWS_ENDPOINT_URL: 'https://untrusted.example.test',
        LD_PRELOAD: '/vercel/sandbox/libhook.so',
      },
    });

    await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            accessKeyId: 'access-value',
            secretAccessKey: 'secret-value',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PATH: '/vercel/sandbox/untrusted-bin',
          AWS_ENDPOINT_URL: 'https://untrusted.example.test',
          LD_PRELOAD: '/vercel/sandbox/libhook.so',
        },
      }),
    );
    const mountCommands = runCommandMock.mock.calls
      .map(([params]) => params)
      .filter(({ cmd }) => cmd !== '/bin/sh');
    expect(mountCommands).not.toHaveLength(0);
    for (const command of mountCommands) {
      expect(command).toMatchObject({
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        },
      });
    }
    expect(mountCommands.find(({ cmd }) => cmd === 'mount-s3')).toMatchObject({
      env: {
        AWS_ACCESS_KEY_ID: 'access-value',
        AWS_SECRET_ACCESS_KEY: 'secret-value',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    });
    const rawMountCommand = rawRunCommandMock.mock.calls
      .map(([params]) => params)
      .find(
        ({ cmd, args }) =>
          cmd === '/bin/sh' &&
          args?.[2] === 'vercel-sandbox-mount-command' &&
          args?.[3] === 'mount-s3',
      );
    expect(rawMountCommand).toMatchObject({
      cmd: '/bin/sh',
      env: {
        AWS_ACCESS_KEY_ID: 'access-value',
        AWS_ENDPOINT_URL: '',
        AWS_SECRET_ACCESS_KEY: 'secret-value',
        LD_PRELOAD: '',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    });
    expect(rawMountCommand?.args?.slice(0, 4)).toEqual([
      '-c',
      expect.stringContaining('exec /usr/bin/env -i'),
      'vercel-sandbox-mount-command',
      'mount-s3',
    ]);
    expect(JSON.stringify(rawMountCommand?.args)).not.toContain('access-value');
    expect(JSON.stringify(rawMountCommand?.args)).not.toContain('secret-value');
  });

  test('strips credentials from S3 mounts before validating their strategy', async () => {
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            accessKeyId: 'stale-access',
            secretAccessKey: 'stale-secret',
            sessionToken: 'stale-session',
            mountStrategy: {
              type: 'unsupported',
            } as unknown as VercelCloudBucketMountStrategy,
          }),
        },
      }),
      sandboxId: 'vercel_test',
      workspacePersistence: 'tar',
      environment: {},
    });

    const serialized = JSON.stringify(
      await client.serializeSessionState(state),
    );

    expect(serialized).not.toContain('stale-access');
    expect(serialized).not.toContain('stale-secret');
    expect(serialized).not.toContain('stale-session');
  });

  test('keeps S3 credentials out of state and resolves them again after resume', async () => {
    readFileToBufferMock.mockResolvedValue(
      makeTarArchive([{ name: 'keep.txt', content: 'keep' }]),
    );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            accessKeyId: 'access-value',
            secretAccessKey: 'secret-value',
            sessionToken: 'session-value',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    const serialized = await client.serializeSessionState(session.state);
    expect(JSON.stringify(session.state.manifest)).not.toContain(
      'access-value',
    );
    expect(JSON.stringify(session.state.manifest)).not.toContain(
      'secret-value',
    );
    expect(JSON.stringify(session.state.manifest)).not.toContain(
      'session-value',
    );
    expect(JSON.stringify(serialized)).not.toContain('access-value');
    expect(JSON.stringify(serialized)).not.toContain('secret-value');
    expect(JSON.stringify(serialized)).not.toContain('session-value');

    const resolveS3MountCredentials = vi.fn(async () => ({
      accessKeyId: 'fresh-access',
      secretAccessKey: 'fresh-secret',
      sessionToken: 'fresh-session',
    }));
    const resumeClient = new VercelSandboxClient({
      allowS3CredentialExposure: true,
      resolveS3MountCredentials,
      resolveS3MountConfiguration: trustPersistedS3Mounts,
    });
    const resumedState = await resumeClient.deserializeSessionState({
      ...serialized,
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            accessKeyId: 'stale-access',
            secretAccessKey: 'stale-secret',
            sessionToken: 'stale-session',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    });
    expect(JSON.stringify(resumedState.manifest)).not.toContain('stale-secret');
    runCommandMock.mockClear();
    const resumed = await resumeClient.resume(resumedState);

    expect(resolveS3MountCredentials).toHaveBeenCalledTimes(1);
    expect(
      runCommandMock.mock.calls
        .map(([params]) => params.cmd)
        .filter((command) => command !== '/bin/sh'),
    ).toEqual([
      'findmnt',
      'findmnt',
      'findmnt',
      'umount',
      'sh',
      'rpm',
      'mkdir',
      'find',
      'mount-s3',
      'findmnt',
    ]);
    const resumeRemount = runCommandMock.mock.calls
      .map(([params]) => params)
      .find(({ cmd }) => cmd === 'mount-s3');
    expect(resumeRemount).toMatchObject({
      env: {
        AWS_ACCESS_KEY_ID: 'fresh-access',
        AWS_SECRET_ACCESS_KEY: 'fresh-secret',
        AWS_SESSION_TOKEN: 'fresh-session',
      },
    });
    expect(JSON.stringify(resumeRemount)).not.toContain('stale-secret');

    runCommandMock.mockClear();
    resolveS3MountCredentials.mockClear();

    await resumed.persistWorkspace();

    expect(resolveS3MountCredentials).toHaveBeenCalledTimes(1);
    expect(resolveS3MountCredentials).toHaveBeenCalledWith({
      mountPath: '/vercel/sandbox/data',
      mount: expect.objectContaining({
        type: 's3_mount',
        bucket: 'bucket',
      }),
    });
    const remount = runCommandMock.mock.calls
      .map(([params]) => params)
      .find(({ cmd }) => cmd === 'mount-s3');
    expect(remount).toMatchObject({
      env: {
        AWS_ACCESS_KEY_ID: 'fresh-access',
        AWS_SECRET_ACCESS_KEY: 'fresh-secret',
        AWS_SESSION_TOKEN: 'fresh-session',
      },
    });
    expect(JSON.stringify(remount)).not.toContain('stale-secret');
  });

  test('redacts S3 credentials from failed mount command details', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3') {
          return commandFinished(
            1,
            '',
            'request used secret-value and session-value',
          );
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    let error: unknown;

    try {
      await client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              accessKeyId: 'access-value',
              secretAccessKey: 'secret-value',
              sessionToken: 'session-value',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SandboxMountError);
    const serializedError = JSON.stringify({
      message: (error as Error).message,
      details: (error as SandboxMountError).details,
    });
    expect(serializedError).not.toContain('secret-value');
    expect(serializedError).not.toContain('session-value');
    expect(serializedError).toContain('REDACTED');
  });

  test('redacts S3 credentials from mount provider exceptions', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3') {
          throw new Error('provider echoed secret-value');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    let error: unknown;

    try {
      await client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              accessKeyId: 'access-value',
              secretAccessKey: 'secret-value',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SandboxMountError);
    const serializedError = JSON.stringify({
      message: (error as Error).message,
      details: (error as SandboxMountError).details,
    });
    expect(serializedError).not.toContain('secret-value');
    expect(serializedError).toContain('provider echoed REDACTED');
  });

  test('uses a successful mount exit code when output retrieval fails', async () => {
    const output = vi.fn().mockRejectedValue(new Error('logs unavailable'));
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3') {
          return {
            exitCode: 0,
            output,
          };
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await session.materializeEntry({
      path: 'data',
      entry: s3Mount({
        bucket: 'bucket',
        mountStrategy: new VercelCloudBucketMountStrategy(),
      }),
    });

    expect(session.state.mountStateUncertainCommand).toBeUndefined();
    expect(session.state.manifest.mountTargets()).toEqual([
      expect.objectContaining({
        mountPath: '/vercel/sandbox/data',
      }),
    ]);
    expect(output).toHaveBeenCalledWith('stdout', {
      signal: expect.any(AbortSignal),
    });
    expect(output).toHaveBeenCalledWith('stderr', {
      signal: expect.any(AbortSignal),
    });
    await session.close();
    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount'),
    ).toEqual([
      expect.objectContaining({
        args: ['/vercel/sandbox/data'],
        sudo: true,
      }),
    ]);
  });

  test.each(['mount-s3', 'umount'])(
    'marks the session unusable after an ambiguous %s transport failure',
    async (failedCommand) => {
      const client = new VercelSandboxClient();
      const session = await client.create(
        failedCommand === 'umount'
          ? new Manifest({
              entries: {
                data: s3Mount({
                  bucket: 'bucket',
                  mountStrategy: new VercelCloudBucketMountStrategy(),
                }),
              },
            })
          : new Manifest(),
      );
      runCommandMock.mockImplementation(
        async (params: { cmd?: string; args?: string[] } = {}) => {
          if (params.cmd === failedCommand) {
            throw new Error('transport disconnected after dispatch');
          }
          return await defaultRunCommand(params);
        },
      );

      if (failedCommand === 'mount-s3') {
        await expect(
          session.materializeEntry({
            path: 'data',
            entry: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          }),
        ).rejects.toBeInstanceOf(SandboxMountError);
        expect(
          runCommandMock.mock.calls.some(
            ([params]) =>
              params.cmd === 'umount' &&
              params.args?.[0] === '/vercel/sandbox/data',
          ),
        ).toBe(true);
      } else {
        await expect(session.persistWorkspace()).rejects.toBeInstanceOf(
          SandboxMountError,
        );
      }

      expect(session.state.mountStateUncertainCommand).toBe(failedCommand);
      await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
        details: {
          command: failedCommand,
        },
      });
    },
  );

  test('marks the session unusable after detecting an unexpected mount source', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'findmnt' &&
          params.args?.includes('SOURCE') === true
        ) {
          return commandFinished(0, 'tmpfs\n');
        }
        return await defaultRunCommand(params);
      },
    );

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      code: 'mount_failed',
      details: {
        mountPath: '/vercel/sandbox/data',
        expectedSource: 'mountpoint-s3',
        actualSource: 'tmpfs',
      },
    });
    expect(session.state.mountStateUncertainCommand).toBe('findmnt');
    const commandCountAfterFailure = runCommandMock.mock.calls.length;

    await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
      details: {
        command: 'findmnt',
      },
    });
    expect(runCommandMock).toHaveBeenCalledTimes(commandCountAfterFailure);
  });

  test('retries cleanup for a possibly late mount after stop fails', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3') {
          throw Object.assign(new Error('command timed out'), {
            name: 'TimeoutError',
          });
        }
        return await defaultRunCommand(params);
      },
    );

    await expect(
      session.materializeEntry({
        path: 'data',
        entry: s3Mount({
          bucket: 'bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      }),
    ).rejects.toBeInstanceOf(SandboxMountError);

    runCommandMock.mockImplementation(defaultRunCommand);
    stopMock
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined);
    await expect(session.close()).rejects.toThrow('stop failed');
    await session.close();

    const cleanupPaths = runCommandMock.mock.calls
      .map(([params]) => params)
      .filter(({ cmd }) => cmd === 'umount')
      .map(({ args }) => args?.[0]);
    expect(cleanupPaths).toEqual([
      '/vercel/sandbox/data',
      '/vercel/sandbox/data',
      '/vercel/sandbox/data',
    ]);
    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  test.each(['mount-s3', 'umount'])(
    'marks the session unusable after a timed-out %s command',
    async (timedOutCommand) => {
      const client = new VercelSandboxClient();
      const session = await client.create(
        timedOutCommand === 'umount'
          ? new Manifest({
              entries: {
                data: s3Mount({
                  bucket: 'bucket',
                  mountStrategy: new VercelCloudBucketMountStrategy(),
                }),
              },
            })
          : new Manifest(),
      );
      runCommandMock.mockImplementation(
        async (params: { cmd?: string; args?: string[] } = {}) => {
          if (params.cmd === timedOutCommand) {
            throw Object.assign(new Error('command timed out'), {
              name: 'TimeoutError',
            });
          }
          return await defaultRunCommand(params);
        },
      );

      if (timedOutCommand === 'mount-s3') {
        await expect(
          session.materializeEntry({
            path: 'data',
            entry: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          }),
        ).rejects.toBeInstanceOf(SandboxMountError);
      } else {
        await expect(session.persistWorkspace()).rejects.toBeInstanceOf(
          SandboxMountError,
        );
      }
      const commandCountAfterTimeout = runCommandMock.mock.calls.length;

      await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
        details: {
          command: timedOutCommand,
        },
      });
      await expect(
        session.readFile({ path: '/vercel/sandbox/data/object.txt' }),
      ).rejects.toMatchObject({
        details: {
          command: timedOutCommand,
        },
      });
      await expect(
        client.serializeSessionState(session.state),
      ).rejects.toMatchObject({
        details: {
          command: timedOutCommand,
        },
      });
      await expect(client.resume(session.state)).rejects.toMatchObject({
        details: {
          command: timedOutCommand,
        },
      });
      expect(runCommandMock).toHaveBeenCalledTimes(commandCountAfterTimeout);
      expect(getMock).not.toHaveBeenCalled();
    },
  );

  test.each(['mount-s3', 'umount'])(
    'retains uncertainty after a timed-out live-resume %s command',
    async (timedOutCommand) => {
      const client = new VercelSandboxClient({
        allowS3CredentialExposure: true,
        resolveS3MountConfiguration: trustPersistedS3Mounts,
        ...(timedOutCommand === 'umount'
          ? {
              resolveS3MountCredentials: async () => ({
                accessKeyId: 'fresh-access',
                secretAccessKey: 'fresh-secret',
              }),
            }
          : {}),
      });
      const state = await client.deserializeSessionState({
        manifest: new Manifest({
          root: '/vercel/sandbox',
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
      });
      runCommandMock.mockImplementation(
        async (params: { cmd?: string; args?: string[] } = {}) => {
          if (timedOutCommand === 'mount-s3' && params.cmd === 'findmnt') {
            return commandFinished(1);
          }
          if (params.cmd === timedOutCommand) {
            throw Object.assign(new Error('command timed out'), {
              name: 'TimeoutError',
            });
          }
          return await defaultRunCommand(params);
        },
      );

      await expect(client.resume(state)).rejects.toBeInstanceOf(
        SandboxMountError,
      );
      expect(state.mountStateUncertainCommand).toBe(timedOutCommand);
      expect(stopMock).toHaveBeenCalledOnce();
      const getCallsAfterTimeout = getMock.mock.calls.length;

      runCommandMock.mockImplementation(defaultRunCommand);
      await expect(client.resume(state)).rejects.toMatchObject({
        details: {
          command: timedOutCommand,
        },
      });
      expect(getMock).toHaveBeenCalledTimes(getCallsAfterTimeout);
    },
  );

  test('preserves ambiguous live-resume and stop failures', async () => {
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration: trustPersistedS3Mounts,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'findmnt') {
          return commandFinished(1);
        }
        if (params.cmd === 'mount-s3') {
          throw Object.assign(new Error('mount timed out'), {
            name: 'TimeoutError',
          });
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'lifecycle_error',
      details: {
        sandboxId: 'vercel_test',
        resumeCause: expect.stringContaining('failed to mount the S3 bucket'),
        resumeDetails: expect.objectContaining({
          cause: 'mount timed out',
        }),
        stopCause: 'stop failed',
      },
    });
    expect(state.mountStateUncertainCommand).toBe('mount-s3');
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('accepts an already-unmounted S3 path during close', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'umount') {
          return commandFinished(32, '', 'not mounted');
        }
        if (params.cmd === 'mountpoint') {
          return commandFinished(1);
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();

    await session.close();

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params.cmd)
        .filter((cmd) => cmd !== '/bin/sh'),
    ).toEqual(['findmnt', 'umount', 'mountpoint', 'findmnt', 'findmnt']);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('treats missing command exit codes as failures', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockResolvedValueOnce({
      exitCode: null,
      output: vi.fn().mockResolvedValue('lost exit\n'),
    });

    const output = await session.execCommand({ cmd: 'lost-exit' });

    expect(output).toContain('Process exited with code 1');
    expect(output).toContain('lost exit');
  });

  test.each(['mount-s3', 'umount', 'mountpoint'])(
    'marks the session unusable when %s returns no exit status',
    async (commandWithoutStatus) => {
      const client = new VercelSandboxClient();
      const session = await client.create(
        commandWithoutStatus !== 'mount-s3'
          ? new Manifest({
              entries: {
                data: s3Mount({
                  bucket: 'bucket',
                  mountStrategy: new VercelCloudBucketMountStrategy(),
                }),
              },
            })
          : new Manifest(),
      );
      runCommandMock.mockImplementation(
        async (params: { cmd?: string; args?: string[] } = {}) => {
          if (
            commandWithoutStatus === 'mountpoint' &&
            params.cmd === 'umount'
          ) {
            return commandFinished(32, '', 'not mounted');
          }
          if (params.cmd === commandWithoutStatus) {
            return commandFinished(null);
          }
          return await defaultRunCommand(params);
        },
      );

      const operation =
        commandWithoutStatus === 'mount-s3'
          ? session.materializeEntry({
              path: 'data',
              entry: s3Mount({
                bucket: 'bucket',
                mountStrategy: new VercelCloudBucketMountStrategy(),
              }),
            })
          : session.persistWorkspace();
      await expect(operation).rejects.toMatchObject({
        code: 'mount_failed',
        details: {
          command: expect.stringContaining(commandWithoutStatus),
        },
      });
      expect(session.state.mountStateUncertainCommand).toBe(
        commandWithoutStatus,
      );
      await expect(session.execCommand({ cmd: 'pwd' })).rejects.toMatchObject({
        details: {
          command: commandWithoutStatus,
        },
      });
    },
  );

  test('marks the session unusable when a mount-state probe returns no exit status', async () => {
    const sandbox = makeSandbox('vercel_test');
    sandbox.runCommand = async (params: Record<string, unknown>) => {
      const unwrappedParams = unwrapIsolatedMountCommand(params);
      if (unwrappedParams.cmd === 'findmnt') {
        return commandFinished(null);
      }
      return await defaultRunCommand(unwrappedParams);
    };
    createMock.mockResolvedValueOnce(sandbox);
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.materializeEntry({
        path: 'data',
        entry: s3Mount({
          bucket: 'bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      }),
    ).rejects.toMatchObject({
      code: 'mount_failed',
      details: {
        rollbackFailures: expect.arrayContaining([
          expect.objectContaining({
            details: expect.objectContaining({
              command: expect.stringContaining('findmnt'),
            }),
          }),
        ]),
      },
    });
    expect(session.state.mountStateUncertainCommand).toBe('findmnt');
    await expect(session.execCommand({ cmd: 'pwd' })).rejects.toMatchObject({
      details: {
        command: 'findmnt',
      },
    });

    sandbox.runCommand = async (params: Record<string, unknown>) =>
      await defaultRunCommand(unwrapIsolatedMountCommand(params));
    await session.close();
  });

  test('unmounts a successful mount when post-mount verification fails', async () => {
    const sandbox = makeSandbox('vercel_test');
    const executedCommands: Record<string, unknown>[] = [];
    sandbox.runCommand = async (params: Record<string, unknown>) => {
      const unwrappedParams = unwrapIsolatedMountCommand(params);
      executedCommands.push(unwrappedParams);
      if (
        unwrappedParams.cmd === 'findmnt' &&
        Array.isArray(unwrappedParams.args) &&
        unwrappedParams.args.includes('TARGET')
      ) {
        return commandFinished(2, '', 'findmnt failed');
      }
      return await defaultRunCommand(unwrappedParams);
    };
    createMock.mockResolvedValueOnce(sandbox);
    stopMock.mockRejectedValueOnce(new Error('stop failed'));
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        stopCause: 'stop failed',
      },
    });

    const commands = executedCommands;
    const mountIndex = commands.findIndex(({ cmd }) => cmd === 'mount-s3');
    const unmountIndex = commands.findIndex(({ cmd }) => cmd === 'umount');
    expect(mountIndex).toBeGreaterThanOrEqual(0);
    expect(unmountIndex).toBeGreaterThan(mountIndex);
    expect(commands[unmountIndex]).toMatchObject({
      args: ['/vercel/sandbox/data'],
    });
  });

  test('forwards and stores a complete PAT environment credential triple', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    const client = new VercelSandboxClient();

    const session = await client.create(new Manifest());

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_env',
        teamId: 'team_env',
        token: 'env_token',
      }),
    );
    expect(session.state).toMatchObject({
      authenticationMode: 'explicit',
      projectId: 'prj_env',
      teamId: 'team_env',
      token: 'env_token',
    });
  });

  test('mixes create, constructor, and PAT environment credentials using field precedence', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    const client = new VercelSandboxClient({
      projectId: 'prj_constructor',
      token: 'constructor_token',
    });

    const session = await client.create(new Manifest(), {
      projectId: 'prj_create',
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_create',
        teamId: 'team_env',
        token: 'constructor_token',
      }),
    );
    expect(session.state).toMatchObject({
      projectId: 'prj_create',
      teamId: 'team_env',
      token: 'constructor_token',
    });
  });

  test.each([
    {},
    { projectId: 'prj_partial' },
    { teamId: 'team_partial' },
    { token: 'token_partial' },
    { projectId: 'prj_partial', teamId: 'team_partial' },
    { projectId: 'prj_partial', token: 'token_partial' },
    { teamId: 'team_partial', token: 'token_partial' },
  ])(
    'omits absent or partial credentials when the resolved triple remains incomplete: %j',
    async (options) => {
      vi.stubEnv('VERCEL_PROJECT_ID', '');
      vi.stubEnv('VERCEL_TEAM_ID', '');
      vi.stubEnv('VERCEL_TOKEN', '');
      const client = new VercelSandboxClient(options);

      const session = await client.create(new Manifest());

      const createParams = createMock.mock.calls[0]?.[0];
      expect(createParams).not.toHaveProperty('projectId');
      expect(createParams).not.toHaveProperty('teamId');
      expect(createParams).not.toHaveProperty('token');
      expect(session.state).not.toHaveProperty('projectId');
      expect(session.state).not.toHaveProperty('teamId');
      expect(session.state).not.toHaveProperty('token');
      expect(session.state.authenticationMode).toBe('sdk');
    },
  );

  test('explicit empty values suppress environment fallback and delegate authentication', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    const client = new VercelSandboxClient({
      token: '',
    });

    const session = await client.create(new Manifest());

    const createParams = createMock.mock.calls[0]?.[0];
    expect(createParams).not.toHaveProperty('projectId');
    expect(createParams).not.toHaveProperty('teamId');
    expect(createParams).not.toHaveProperty('token');
    expect(session.state).not.toHaveProperty('projectId');
    expect(session.state).not.toHaveProperty('teamId');
    expect(session.state).not.toHaveProperty('token');
    expect(session.state.authenticationMode).toBe('sdk');
  });

  test('serializes PAT environment credentials used during create and snapshot capture', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    const client = new VercelSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(new Manifest());
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state, {
      willCloseAfterSerialize: true,
    });

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_test',
      projectId: 'prj_env',
      teamId: 'team_env',
      token: 'env_token',
    });
    expect(serialized).toMatchObject({
      authenticationMode: 'explicit',
      projectId: 'prj_env',
      teamId: 'team_env',
      token: 'env_token',
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
      snapshotId: 'snap_test',
    });
    await expect(
      client.deserializeSessionState(serialized),
    ).resolves.toMatchObject({
      authenticationMode: 'explicit',
      projectId: 'prj_env',
      teamId: 'team_env',
      token: 'env_token',
    });
  });

  test('delegates legacy snapshot lookup authentication after a 401 response', async () => {
    getMock
      .mockRejectedValueOnce(vercelHttpError(401))
      .mockResolvedValueOnce(makeSandbox('vercel_existing'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotSupported: true,
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    const serialized = await client.serializeSessionState(state, {
      willCloseAfterSerialize: true,
    });

    expect(getMock).toHaveBeenNthCalledWith(1, {
      sandboxId: 'vercel_existing',
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });
    expect(getMock).toHaveBeenNthCalledWith(2, {
      sandboxId: 'vercel_existing',
    });
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(serialized).toMatchObject({
      authenticationMode: 'sdk',
      snapshotId: 'snap_test',
    });
    expect(serialized).not.toHaveProperty('token');
  });

  test('strips incomplete credentials before serializing session state', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    session.state.projectId = 'prj_legacy';
    session.state.token = 'legacy_token';

    const serialized = await client.serializeSessionState(session.state);

    expect(serialized).not.toHaveProperty('projectId');
    expect(serialized).not.toHaveProperty('teamId');
    expect(serialized).not.toHaveProperty('token');
    expect(session.state).not.toHaveProperty('projectId');
    expect(session.state).not.toHaveProperty('teamId');
    expect(session.state).not.toHaveProperty('token');
  });

  test('passes complete access token credentials to Vercel', async () => {
    const client = new VercelSandboxClient({
      projectId: 'prj_access_token',
      teamId: 'team_access_token',
      token: 'vercel_test_token',
    });

    await client.create(new Manifest());

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_access_token',
        teamId: 'team_access_token',
        token: 'vercel_test_token',
      }),
    );
  });

  test('preserves access token credentials when hydrating native snapshots', async () => {
    const client = new VercelSandboxClient({
      projectId: 'prj_access_token',
      teamId: 'team_access_token',
      token: 'vercel_test_token',
    });
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_restore',
      }),
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_access_token',
        teamId: 'team_access_token',
        token: 'vercel_test_token',
        source: {
          type: 'snapshot',
          snapshotId: 'snap_restore',
        },
      }),
    );
  });

  test('reuses resolved manifest environment values during create', async () => {
    let tokenVersion = 0;
    const resolveToken = vi.fn(async () => `token-${++tokenVersion}`);
    const client = new VercelSandboxClient({
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
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
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

  test('rejects unsupported manifest metadata after remapping the default root', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
      ),
    ).rejects.toThrow(/does not support extra path grants yet/);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects serialized sessions with roots outside the Vercel workspace', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.deserializeSessionState({
        manifest: new Manifest({
          root: '/tmp',
        }),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
      }),
    ).rejects.toThrow(
      'Vercel sandboxes require manifest.root to stay within "/vercel/sandbox".',
    );
  });

  test('rejects serialized sessions with unsupported manifest metadata', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.deserializeSessionState({
        manifest: new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
      }),
    ).rejects.toThrow(/does not support extra path grants yet/);
  });

  test('does not recreate an existing directory for sibling files', async () => {
    mkDirMock.mockImplementation(async (path: string) => {
      if (path === '/vercel/sandbox/project') {
        const callsForPath = mkDirMock.mock.calls.filter(
          ([calledPath]) => calledPath === path,
        ).length;
        if (callsForPath > 1) {
          throw vercelAlreadyExistsError(path);
        }
      }
    });

    const client = new VercelSandboxClient();
    await client.create(
      new Manifest({
        entries: {
          'project/status.md': {
            type: 'file',
            content: '# Status\n',
          },
          'project/tasks.md': {
            type: 'file',
            content: '# Tasks\n',
          },
        },
      }),
    );

    expect(
      mkDirMock.mock.calls.filter(
        ([path]) => path === '/vercel/sandbox/project',
      ),
    ).toHaveLength(1);
  });

  test('creates parent directories recursively before file writes', async () => {
    const createdDirs = new Set(['/vercel/sandbox']);
    mkDirMock.mockImplementation(async (path: string) => {
      const lastSlash = path.lastIndexOf('/');
      const parent = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
      if (!createdDirs.has(parent)) {
        throw new Error(`missing parent: ${parent}`);
      }
      createdDirs.add(path);
    });

    const client = new VercelSandboxClient();
    await client.create(
      new Manifest({
        entries: {
          'a/b/file.txt': {
            type: 'file',
            content: 'nested\n',
          },
        },
      }),
    );

    expect(mkDirMock.mock.calls.map(([path]) => path)).toEqual([
      '/vercel/sandbox/a',
      '/vercel/sandbox/a/b',
    ]);
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/a/b/file.txt',
        content: 'nested\n',
      },
    ]);
  });

  test('creates configured workspace roots before initial writes', async () => {
    const createdDirs = new Set(['/vercel/sandbox']);
    mkDirMock.mockImplementation(async (path: string) => {
      const lastSlash = path.lastIndexOf('/');
      const parent = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
      if (!createdDirs.has(parent)) {
        throw new Error(`missing parent: ${parent}`);
      }
      createdDirs.add(path);
    });

    const client = new VercelSandboxClient();
    await client.create(
      new Manifest({
        root: '/vercel/sandbox/app',
        entries: {
          'README.md': {
            type: 'file',
            content: '# App\n',
          },
        },
      }),
    );

    expect(mkDirMock).toHaveBeenCalledWith('/vercel/sandbox/app');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/app/README.md',
        content: '# App\n',
      },
    ]);
  });

  test('uses idempotent editor mkdir operations', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }
    mkDirMock.mockClear();
    writeFilesMock.mockClear();
    mkDirMock.mockImplementation(async (path: string) => {
      if (path === '/vercel/sandbox') {
        throw vercelAlreadyExistsError(path);
      }
    });

    await editor.createFile({
      type: 'create_file',
      path: 'notes.txt',
      diff: '+hello\n',
    });

    expect(mkDirMock).not.toHaveBeenCalledWith('/vercel/sandbox');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/notes.txt',
        content: 'hello',
      },
    ]);
  });

  test('fails editor deletes when remote rm fails', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }
    runCommandMock.mockImplementation(
      async (params: { args?: string[] } = {}) => {
        const command = params.args?.[1] ?? '';
        if (command.includes("rm -f -- '/vercel/sandbox/old.txt'")) {
          return {
            exitCode: 1,
            output: vi.fn().mockResolvedValue('delete denied'),
          };
        }
        const resolvedPath = resolvedRemotePathFromValidationCommand(command);
        return {
          exitCode: 0,
          output: vi
            .fn()
            .mockResolvedValue(
              resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
            ),
        };
      },
    );

    await expect(
      editor.deleteFile({
        type: 'delete_file',
        path: 'old.txt',
      }),
    ).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'delete path',
        sandboxId: 'vercel_test',
        path: '/vercel/sandbox/old.txt',
        exitCode: 1,
        output: 'delete denied',
      },
    });
  });

  test('stores materialized absolute workspace paths as relative manifest keys', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await session.materializeEntry({
      path: '/vercel/sandbox/extra.txt',
      entry: {
        type: 'file',
        content: 'extra\n',
      },
    });

    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/extra.txt',
        content: 'extra\n',
      },
    ]);
    expect(session.state.manifest.entries).toHaveProperty('extra.txt');
    expect(session.state.manifest.entries).not.toHaveProperty(
      '/vercel/sandbox/extra.txt',
    );
  });

  test('sanitizes and retains credentials for dynamically added S3 mounts', async () => {
    readFileToBufferMock.mockResolvedValue(
      makeTarArchive([{ name: 'keep.txt', content: 'keep' }]),
    );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    const session = await client.create(new Manifest());

    await session.materializeEntry({
      path: '/vercel/sandbox/dynamic',
      entry: s3Mount({
        bucket: 'dynamic-bucket',
        accessKeyId: 'dynamic-access',
        secretAccessKey: 'dynamic-secret',
        sessionToken: 'dynamic-session',
        mountStrategy: new VercelCloudBucketMountStrategy(),
      }),
    });
    await session.applyManifest(
      new Manifest({
        entries: {
          applied: s3Mount({
            bucket: 'applied-bucket',
            accessKeyId: 'applied-access',
            secretAccessKey: 'applied-secret',
            sessionToken: 'applied-session',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    const serializedState = JSON.stringify(session.state.manifest);
    expect(serializedState).not.toContain('dynamic-access');
    expect(serializedState).not.toContain('dynamic-secret');
    expect(serializedState).not.toContain('dynamic-session');
    expect(serializedState).not.toContain('applied-access');
    expect(serializedState).not.toContain('applied-secret');
    expect(serializedState).not.toContain('applied-session');
    expect(
      JSON.stringify(await client.serializeSessionState(session.state)),
    ).not.toContain('dynamic-secret');

    runCommandMock.mockClear();
    await session.persistWorkspace();

    const remounts = runCommandMock.mock.calls
      .map(([params]) => params)
      .filter(({ cmd }) => cmd === 'mount-s3');
    expect(remounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: expect.arrayContaining(['dynamic-bucket']),
          env: expect.objectContaining({
            AWS_ACCESS_KEY_ID: 'dynamic-access',
            AWS_SECRET_ACCESS_KEY: 'dynamic-secret',
            AWS_SESSION_TOKEN: 'dynamic-session',
          }),
        }),
        expect.objectContaining({
          args: expect.arrayContaining(['applied-bucket']),
          env: expect.objectContaining({
            AWS_ACCESS_KEY_ID: 'applied-access',
            AWS_SECRET_ACCESS_KEY: 'applied-secret',
            AWS_SESSION_TOKEN: 'applied-session',
          }),
        }),
      ]),
    );
  });

  test('caches applied mount credentials under the resolved mount path', async () => {
    readFileToBufferMock.mockResolvedValue(
      makeTarArchive([{ name: 'keep.txt', content: 'keep' }]),
    );
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-data')) {
          return commandFinished(0, '/vercel/sandbox/real-data\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    const session = await client.create(new Manifest());

    await session.applyManifest(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountPath: '/vercel/sandbox/linked-data',
            accessKeyId: 'resolved-access',
            secretAccessKey: 'resolved-secret',
            sessionToken: 'resolved-session',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    const initialMount = runCommandMock.mock.calls
      .map(([params]) => params)
      .find(({ cmd }) => cmd === 'mount-s3');
    expect(initialMount).toMatchObject({
      args: expect.arrayContaining(['bucket', '/vercel/sandbox/real-data']),
      env: {
        AWS_ACCESS_KEY_ID: 'resolved-access',
        AWS_SECRET_ACCESS_KEY: 'resolved-secret',
        AWS_SESSION_TOKEN: 'resolved-session',
      },
    });
    expect(JSON.stringify(session.state.manifest)).not.toContain(
      'resolved-secret',
    );

    runCommandMock.mockClear();
    await session.persistWorkspace();

    const tarCommand = runCommandMock.mock.calls
      .map(([params]) => params)
      .find(
        ({ cmd, args }) =>
          cmd === '/bin/sh' &&
          args?.some((arg: string) => arg.includes('tar ')),
      );
    expect(tarCommand?.args?.join(' ')).toContain("--exclude='./linked-data'");
    expect(tarCommand?.args?.join(' ')).toContain("--exclude='./real-data'");
    const restoredMount = runCommandMock.mock.calls
      .map(([params]) => params)
      .find(({ cmd }) => cmd === 'mount-s3');
    expect(restoredMount).toMatchObject({
      args: expect.arrayContaining(['bucket', '/vercel/sandbox/real-data']),
      env: {
        AWS_ACCESS_KEY_ID: 'resolved-access',
        AWS_SECRET_ACCESS_KEY: 'resolved-secret',
        AWS_SESSION_TOKEN: 'resolved-session',
      },
    });
  });

  test('resolves declared mount paths inside snapshot replacements', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    readFileToBufferMock.mockResolvedValue(archive);
    const resolveSourceMountPath = async (
      params: { cmd?: string; args?: string[] } = {},
    ) => {
      const requestedPath = resolvedRemotePathFromValidationCommand(
        params.args?.[1] ?? '',
      );
      if (requestedPath?.endsWith('/linked-data')) {
        return commandFinished(0, '/vercel/sandbox/source-real-data\n');
      }
      return await defaultRunCommand(params);
    };
    let replacementLinkExists = true;
    const replacementRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === '/bin/sh' &&
          params.args?.some((arg) => arg.includes("find '/vercel/sandbox'"))
        ) {
          replacementLinkExists = false;
        }
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-data')) {
          return commandFinished(
            0,
            replacementLinkExists
              ? '/vercel/sandbox/replacement-real-data\n'
              : '/vercel/sandbox/linked-data\n',
          );
        }
        return await defaultRunCommand(params);
      },
    );
    runCommandMock.mockImplementation(resolveSourceMountPath);
    createMock
      .mockResolvedValueOnce(makeSandbox('vercel_source'))
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountPath: '/vercel/sandbox/linked-data',
            accessKeyId: 'resolved-access',
            secretAccessKey: 'resolved-secret',
            sessionToken: 'resolved-session',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        workspacePersistence: 'snapshot',
      },
    );

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_restore',
      }),
    );
    expect(
      replacementRunCommandMock.mock.calls.find(
        ([params]) => params?.cmd === 'mount-s3',
      )?.[0],
    ).toMatchObject({
      args: expect.arrayContaining([
        'bucket',
        '/vercel/sandbox/replacement-real-data',
      ]),
      env: {
        AWS_ACCESS_KEY_ID: 'resolved-access',
        AWS_SECRET_ACCESS_KEY: 'resolved-secret',
        AWS_SESSION_TOKEN: 'resolved-session',
      },
    });
    replacementRunCommandMock.mockClear();
    await session.hydrateWorkspace(archive);

    expect(
      replacementRunCommandMock.mock.calls.find(
        ([params]) => params?.cmd === 'umount',
      )?.[0],
    ).toMatchObject({
      args: ['/vercel/sandbox/replacement-real-data'],
      sudo: true,
    });
    expect(
      replacementRunCommandMock.mock.calls.find(
        ([params]) => params?.cmd === 'mount-s3',
      )?.[0],
    ).toMatchObject({
      args: expect.arrayContaining(['bucket', '/vercel/sandbox/linked-data']),
      env: {
        AWS_ACCESS_KEY_ID: 'resolved-access',
        AWS_SECRET_ACCESS_KEY: 'resolved-secret',
        AWS_SESSION_TOKEN: 'resolved-session',
      },
    });
  });

  test('rejects snapshot mounts that resolve over manifest entries', async () => {
    const sourceStopMock = vi.fn().mockResolvedValue(undefined);
    const replacementStopMock = vi.fn().mockResolvedValue(undefined);
    const sourceRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-data')) {
          return commandFinished(0, '/vercel/sandbox/source-data\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const replacementRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-data')) {
          return commandFinished(0, '/vercel/sandbox/config\n');
        }
        return await defaultRunCommand(params);
      },
    );
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          runCommand: sourceRunCommandMock,
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
          stop: replacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'config/settings.json': {
            type: 'file',
            content: '{}',
          },
          data: s3Mount({
            bucket: 'bucket',
            mountPath: '/vercel/sandbox/linked-data',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        workspacePersistence: 'snapshot',
      },
    );

    await expect(
      session.hydrateWorkspace(
        encodeNativeSnapshotRef({
          provider: 'vercel',
          snapshotId: 'snap_restore',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        path: '/vercel/sandbox/config/settings.json',
        mountPath: '/vercel/sandbox/config',
      },
    });

    expect(
      replacementRunCommandMock.mock.calls.some(
        ([params]) => params?.cmd === 'mount-s3',
      ),
    ).toBe(false);
    expect(replacementStopMock).toHaveBeenCalledOnce();
    expect(sourceStopMock).not.toHaveBeenCalled();
  });

  test('preserves default logical mount paths inside snapshot replacements', async () => {
    const sourceRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-data')) {
          return commandFinished(0, '/vercel/sandbox/source-real-data\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const replacementRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-data')) {
          return commandFinished(0, '/vercel/sandbox/replacement-real-data\n');
        }
        return await defaultRunCommand(params);
      },
    );
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          runCommand: sourceRunCommandMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'linked-data': s3Mount({
            bucket: 'bucket',
            accessKeyId: 'resolved-access',
            secretAccessKey: 'resolved-secret',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        workspacePersistence: 'snapshot',
      },
    );

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_restore',
      }),
    );

    expect(
      replacementRunCommandMock.mock.calls.find(
        ([params]) => params?.cmd === 'mount-s3',
      )?.[0],
    ).toMatchObject({
      args: expect.arrayContaining([
        'bucket',
        '/vercel/sandbox/replacement-real-data',
      ]),
      env: {
        AWS_ACCESS_KEY_ID: 'resolved-access',
        AWS_SECRET_ACCESS_KEY: 'resolved-secret',
      },
    });
  });

  test('re-resolves nested snapshot mounts after mounting their parent', async () => {
    let replacementParentMounted = false;
    const replacementRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'parent-bucket') {
          replacementParentMounted = true;
        }
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (
          !replacementParentMounted &&
          requestedPath === '/vercel/sandbox/parent/link'
        ) {
          return commandFinished(0, '/vercel/sandbox/aaa\n');
        }
        return await defaultRunCommand(params);
      },
    );
    createMock
      .mockResolvedValueOnce(makeSandbox('vercel_source'))
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          parent: s3Mount({
            bucket: 'parent-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          child: s3Mount({
            bucket: 'child-bucket',
            mountPath: '/vercel/sandbox/parent/link',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_restore',
      }),
    );

    expect(
      replacementRunCommandMock.mock.calls
        .map(([params]) => params)
        .filter((params) => params?.cmd === 'mount-s3')
        .map((params) => [params?.args?.[0], params?.args?.[1]]),
    ).toEqual([
      ['parent-bucket', '/vercel/sandbox/parent'],
      ['child-bucket', '/vercel/sandbox/parent/link'],
    ]);
    expect(
      replacementRunCommandMock.mock.calls.some(
        ([params]) =>
          params?.cmd === 'mount-s3' &&
          params?.args?.[1] === '/vercel/sandbox/aaa',
      ),
    ).toBe(false);
  });

  test('preserves credentials when snapshot mount targets swap paths', async () => {
    const sourceRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-first')) {
          return commandFinished(0, '/vercel/sandbox/real-first\n');
        }
        if (requestedPath?.endsWith('/linked-second')) {
          return commandFinished(0, '/vercel/sandbox/real-second\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const replacementRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-first')) {
          return commandFinished(0, '/vercel/sandbox/real-second\n');
        }
        if (requestedPath?.endsWith('/linked-second')) {
          return commandFinished(0, '/vercel/sandbox/real-first\n');
        }
        return await defaultRunCommand(params);
      },
    );
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          runCommand: sourceRunCommandMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          first: s3Mount({
            bucket: 'first-bucket',
            mountPath: '/vercel/sandbox/linked-first',
            accessKeyId: 'first-access',
            secretAccessKey: 'first-secret',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountPath: '/vercel/sandbox/linked-second',
            accessKeyId: 'second-access',
            secretAccessKey: 'second-secret',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        workspacePersistence: 'snapshot',
      },
    );

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_restore',
      }),
    );

    const mounts = replacementRunCommandMock.mock.calls
      .map(([params]) => params)
      .filter((params) => params?.cmd === 'mount-s3');
    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: expect.arrayContaining([
            'first-bucket',
            '/vercel/sandbox/real-second',
          ]),
          env: expect.objectContaining({
            AWS_ACCESS_KEY_ID: 'first-access',
            AWS_SECRET_ACCESS_KEY: 'first-secret',
          }),
        }),
        expect.objectContaining({
          args: expect.arrayContaining([
            'second-bucket',
            '/vercel/sandbox/real-first',
          ]),
          env: expect.objectContaining({
            AWS_ACCESS_KEY_ID: 'second-access',
            AWS_SECRET_ACCESS_KEY: 'second-secret',
          }),
        }),
      ]),
    );
  });

  test('refreshes cached inline credentials through the resolver before remounting', async () => {
    readFileToBufferMock.mockResolvedValue(
      makeTarArchive([{ name: 'keep.txt', content: 'keep' }]),
    );
    const resolveS3MountCredentials = vi.fn(async () => ({
      accessKeyId: 'fresh-access',
      secretAccessKey: 'fresh-secret',
      sessionToken: 'fresh-session',
    }));
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
      resolveS3MountCredentials,
    });
    const session = await client.create(new Manifest());

    await session.materializeEntry({
      path: 'data',
      entry: s3Mount({
        bucket: 'bucket',
        accessKeyId: 'inline-access',
        secretAccessKey: 'inline-secret',
        sessionToken: 'inline-session',
        mountStrategy: new VercelCloudBucketMountStrategy(),
      }),
    });
    expect(resolveS3MountCredentials).not.toHaveBeenCalled();

    runCommandMock.mockClear();
    await session.persistWorkspace();

    expect(resolveS3MountCredentials).toHaveBeenCalledWith({
      mountPath: '/vercel/sandbox/data',
      mount: expect.objectContaining({
        type: 's3_mount',
        bucket: 'bucket',
      }),
    });
    const remount = runCommandMock.mock.calls
      .map(([params]) => params)
      .find(({ cmd }) => cmd === 'mount-s3');
    expect(remount).toMatchObject({
      env: {
        AWS_ACCESS_KEY_ID: 'fresh-access',
        AWS_SECRET_ACCESS_KEY: 'fresh-secret',
        AWS_SESSION_TOKEN: 'fresh-session',
      },
    });
    expect(JSON.stringify(remount)).not.toContain('inline-secret');
    expect(JSON.stringify(remount)).not.toContain('inline-session');
  });

  test('rolls back mounts after a later manifest mount fails', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'second-bucket') {
          return commandFinished(1, '', 'second mount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            first: s3Mount({
              bucket: 'first-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            second: s3Mount({
              bucket: 'second-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxMountError);

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount'),
    ).toEqual([
      expect.objectContaining({
        args: ['/vercel/sandbox/first'],
        sudo: true,
      }),
      expect.objectContaining({
        args: ['/vercel/sandbox/second'],
        sudo: true,
      }),
    ]);
    expect(session.state.manifest.mountTargets()).toEqual([]);
    expect(
      JSON.stringify(await client.serializeSessionState(session.state)),
    ).not.toContain('first-bucket');

    runCommandMock.mockClear();
    await expect(session.execCommand({ cmd: 'ls' })).resolves.toContain(
      'README.md',
    );
  });

  test('cleans up a mount that remains live after mount-s3 reports failure', async () => {
    let failedMountLive = true;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'bucket') {
          return commandFinished(1, '', 'mount failed after attaching');
        }
        if (params.cmd === 'findmnt' && params.args?.includes('SOURCE')) {
          return failedMountLive
            ? commandFinished(0, 'mountpoint-s3\n')
            : commandFinished(1);
        }
        if (params.cmd === 'findmnt' && params.args?.includes('TARGET')) {
          return failedMountLive
            ? commandFinished(0, '/vercel/sandbox/data\n')
            : commandFinished(1);
        }
        if (params.cmd === 'umount') {
          failedMountLive = false;
          return commandFinished(0);
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxMountError);

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount'),
    ).toEqual([
      expect.objectContaining({
        args: ['/vercel/sandbox/data'],
        sudo: true,
      }),
    ]);
    expect(failedMountLive).toBe(false);
    expect(session.state.manifest.mountTargets()).toEqual([]);
    await expect(session.execCommand({ cmd: 'ls' })).resolves.toContain(
      'README.md',
    );
  });

  test('resolves manifest environment before mounting applied entries', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        environment: {
          KEEP: 'previous',
        },
      }),
    );
    runCommandMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          environment: {
            FAIL: {
              value: 'placeholder',
              resolve: async () => {
                throw new Error('environment resolution failed');
              },
            },
          },
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toThrow('environment resolution failed');

    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === 'mount-s3' && params.args?.[0] === 'bucket',
      ),
    ).toBe(false);
    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === 'umount' &&
          params.args?.[0] === '/vercel/sandbox/data',
      ),
    ).toBe(false);
    expect(session.state.manifest.mountTargets()).toEqual([]);
    expect(session.state.manifest.environment).toHaveProperty('KEEP');
    expect(session.state.manifest.environment).not.toHaveProperty('FAIL');
    expect(session.state.environment).toEqual({
      KEEP: 'previous',
    });
    expect(
      JSON.stringify(await client.serializeSessionState(session.state)),
    ).not.toContain('bucket');
    await expect(session.execCommand({ cmd: 'ls' })).resolves.toContain(
      'README.md',
    );
  });

  test('does not roll back a successful overlapping mount operation', async () => {
    const firstMountStarted = deferred<void>();
    const finishFirstMount = deferred<void>();
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'mount-s3' &&
          params.args?.[0] === 'failing-bucket'
        ) {
          firstMountStarted.resolve();
          await finishFirstMount.promise;
          return commandFinished(1, '', 'mount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    const failingMaterialization = session.materializeEntry({
      path: 'failing',
      entry: s3Mount({
        bucket: 'failing-bucket',
        mountStrategy: new VercelCloudBucketMountStrategy(),
      }),
    });
    await firstMountStarted.promise;
    const successfulMaterialization = session.materializeEntry({
      path: 'survivor',
      entry: s3Mount({
        bucket: 'surviving-bucket',
        mountStrategy: new VercelCloudBucketMountStrategy(),
      }),
    });
    await Promise.resolve();
    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === 'mount-s3' && params.args?.[0] === 'surviving-bucket',
      ),
    ).toBe(false);

    finishFirstMount.resolve();
    await expect(failingMaterialization).rejects.toBeInstanceOf(
      SandboxMountError,
    );
    await expect(successfulMaterialization).resolves.toBeUndefined();

    expect(session.state.manifest.mountTargets()).toEqual([
      expect.objectContaining({
        mountPath: '/vercel/sandbox/survivor',
        entry: expect.objectContaining({
          bucket: 'surviving-bucket',
        }),
      }),
    ]);
    runCommandMock.mockClear();
    await session.close();
    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount'),
    ).toEqual([
      expect.objectContaining({
        args: ['/vercel/sandbox/survivor'],
        sudo: true,
      }),
    ]);
  });

  test('rejects manifest updates that overlap active mounts before writing', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            readOnly: false,
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          custom: s3Mount({
            bucket: 'custom-bucket',
            mountPath: 'custom-target',
            readOnly: false,
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    writeFilesMock.mockClear();
    runCommandMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            data: {
              type: 'dir',
              children: {
                'replacement.txt': {
                  type: 'file',
                  content: 'replacement\n',
                },
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        path: '/vercel/sandbox/data',
        mountPath: '/vercel/sandbox/data',
      },
    });
    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            custom: {
              type: 'dir',
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        path: '/vercel/sandbox/custom',
        mountPath: '/vercel/sandbox/custom-target',
      },
    });
    await expect(
      session.materializeEntry({
        path: 'data/dynamic.txt',
        entry: {
          type: 'file',
          content: 'dynamic\n',
        },
      }),
    ).rejects.toMatchObject({
      details: {
        path: '/vercel/sandbox/data/dynamic.txt',
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'umount'),
    ).toBe(false);
    expect(session.state.manifest.mountTargets()).toHaveLength(2);
  });

  test('rechecks resolved manifest paths immediately before writing', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            readOnly: false,
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    let candidateResolutions = 0;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath === '/vercel/sandbox/linked.txt') {
          candidateResolutions += 1;
          return commandFinished(
            0,
            candidateResolutions === 1
              ? '/vercel/sandbox/safe.txt\n'
              : '/vercel/sandbox/data/linked.txt\n',
          );
        }
        return await defaultRunCommand(params);
      },
    );
    writeFilesMock.mockClear();

    await expect(
      session.materializeEntry({
        path: 'linked.txt',
        entry: {
          type: 'file',
          content: 'unsafe\n',
        },
      }),
    ).rejects.toMatchObject({
      details: {
        path: '/vercel/sandbox/data/linked.txt',
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(candidateResolutions).toBeGreaterThanOrEqual(2);
    expect(writeFilesMock).not.toHaveBeenCalled();
  });

  test('rechecks resolved mount paths after active operations drain', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    let candidateResolutions = 0;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath === '/vercel/sandbox/linked') {
          candidateResolutions += 1;
          return commandFinished(
            0,
            candidateResolutions === 1
              ? '/vercel/sandbox/safe\n'
              : '/vercel/sandbox/data/linked\n',
          );
        }
        return await defaultRunCommand(params);
      },
    );
    runCommandMock.mockClear();

    await expect(
      session.materializeEntry({
        path: 'linked',
        entry: s3Mount({
          bucket: 'other-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      }),
    ).rejects.toMatchObject({
      details: {
        path: '/vercel/sandbox/data/linked',
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(candidateResolutions).toBeGreaterThanOrEqual(2);
    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === 'mount-s3' && params.args?.[0] === 'other-bucket',
      ),
    ).toBe(false);
  });

  test('rechecks a mount target after preparing its directory', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    let mountDirectoryInspected = false;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'find') {
          mountDirectoryInspected = true;
          return await defaultRunCommand(params);
        }
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath === '/vercel/sandbox/linked-data') {
          return commandFinished(
            0,
            mountDirectoryInspected
              ? '/outside/data\n'
              : '/vercel/sandbox/real-data\n',
          );
        }
        return await defaultRunCommand(params);
      },
    );
    runCommandMock.mockClear();

    await expect(
      session.materializeEntry({
        path: 'data',
        entry: s3Mount({
          bucket: 'bucket',
          mountPath: '/vercel/sandbox/linked-data',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      }),
    ).rejects.toMatchObject({
      code: 'invalid_manifest_path',
    });

    expect(mountDirectoryInspected).toBe(true);
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    await session.close();
  });

  test('remaps default manifest roots when applying manifests to sessions', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    writeFilesMock.mockClear();

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

    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/next.txt',
        content: 'next\n',
      },
    ]);
    expect(session.state.manifest.root).toBe('/vercel/sandbox');
    expect(session.state.manifest.entries).toHaveProperty('next.txt');
  });

  test('captures snapshot ids on close and resumes from snapshots', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await session.close();
    getMock.mockRejectedValueOnce(new Error('sandbox gone'));
    await client.resume(session.state);

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state.snapshotId).toBe('snap_test');
    expect(createMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: {
          type: 'snapshot',
          snapshotId: 'snap_test',
        },
      }),
    );
  });

  test('retains serialized access token credentials when resuming live sandboxes', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await client.resume(state);

    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: 'vercel_existing',
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'serialized_token',
      }),
    );
  });

  test('remounts missing manifest mounts before accepting a live resume', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'findmnt') {
          return commandFinished(1);
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration: trustPersistedS3Mounts,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await client.resume(state);

    const mountCommands = runCommandMock.mock.calls
      .map(([params]) => params)
      .filter(({ cmd }) => cmd !== '/bin/sh');
    expect(mountCommands.map(({ cmd }) => cmd)).toEqual([
      'findmnt',
      'findmnt',
      'sh',
      'rpm',
      'mkdir',
      'find',
      'mount-s3',
      'findmnt',
    ]);
    expect(mountCommands.find(({ cmd }) => cmd === 'mount-s3')).toMatchObject({
      args: expect.arrayContaining(['bucket', '/vercel/sandbox/data']),
    });
  });

  test('decodes raw findmnt mount paths before validating the live set', async () => {
    const runCommand = vi.fn(async () => ({
      status: 0,
      stdout:
        '/vercel/sandbox/with\\x20space\n' +
        '/vercel/sandbox/literal\\x5cx20\n' +
        '/vercel/sandbox/\\xe6\\x97\\xa5\\xe6\\x9c\\xac\\xe8\\xaa\\x9e\n',
    }));

    await expect(
      listVercelCloudBucketMountPaths({ runCommand }),
    ).resolves.toEqual([
      '/vercel/sandbox/with space',
      '/vercel/sandbox/literal\\x20',
      '/vercel/sandbox/日本語',
    ]);
  });

  test('rejects a successful S3 mount listing without target output', async () => {
    const runCommand = vi.fn(async () => ({
      status: 0,
    }));

    await expect(
      listVercelCloudBucketMountPaths({ runCommand }),
    ).rejects.toMatchObject({
      name: 'SandboxMountError',
      code: 'mount_failed',
    });
  });

  test('refuses to unmount an unexpected filesystem at a tracked path', async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === 'findmnt') {
        return {
          status: 0,
          stdout: 'tmpfs\n',
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      unmountVercelCloudBucket({
        mountPath: '/vercel/sandbox/data',
        runCommand,
      }),
    ).rejects.toMatchObject({
      code: 'mount_failed',
      details: {
        mountPath: '/vercel/sandbox/data',
        expectedSource: 'mountpoint-s3',
        actualSource: 'tmpfs',
      },
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalledWith(
      'umount',
      expect.anything(),
      expect.anything(),
    );
  });

  test('rolls back partial live-resume remounts', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'mount-s3' &&
          params.args?.includes('second-bucket')
        ) {
          return commandFinished(1, '', 'mount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration: trustPersistedS3Mounts,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          first: s3Mount({
            bucket: 'first-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toBeInstanceOf(
      SandboxMountError,
    );

    const unmountPaths = runCommandMock.mock.calls
      .map(([params]) => params)
      .filter(({ cmd }) => cmd === 'umount')
      .map(({ args }) => args?.[0]);
    expect(unmountPaths).toEqual([
      '/vercel/sandbox/first',
      '/vercel/sandbox/second',
      '/vercel/sandbox/first',
      '/vercel/sandbox/second',
    ]);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('preserves resume and stop errors after a partial live remount', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'mount-s3' &&
          params.args?.includes('second-bucket')
        ) {
          return commandFinished(1, '', 'mount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration: trustPersistedS3Mounts,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          first: s3Mount({
            bucket: 'first-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        sandboxId: 'vercel_test',
        resumeCause: expect.stringContaining('failed to mount the S3 bucket'),
        stopCause: 'stop failed',
      },
    });
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('rebuilds resumed mounts from current trusted configuration', async () => {
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'data',
        mountPath: '/vercel/sandbox/data',
        mount: s3Mount({
          bucket: 'trusted-bucket',
          endpointUrl: 'https://trusted.example.test',
          prefix: 'trusted-prefix/',
          readOnly: true,
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'tampered-bucket',
            endpointUrl: 'https://tampered.example.test',
            prefix: 'tampered-prefix/',
            readOnly: false,
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {
        AWS_ENDPOINT_URL: 'https://tampered.example.test',
        LD_PRELOAD: '/vercel/sandbox/libhook.so',
      },
    });

    const resumed = await client.resume(state);

    expect(resolveS3MountConfiguration).toHaveBeenCalledWith({
      persistedMounts: [
        {
          logicalPath: 'data',
          mountPath: '/vercel/sandbox/data',
          mount: expect.objectContaining({
            bucket: 'tampered-bucket',
          }),
        },
      ],
    });
    const mountCommands = runCommandMock.mock.calls
      .map(([params]) => params)
      .filter(({ cmd }) => cmd !== '/bin/sh');
    expect(mountCommands.map(({ cmd }) => cmd)).toEqual([
      'findmnt',
      'findmnt',
      'findmnt',
      'umount',
      'sh',
      'rpm',
      'mkdir',
      'find',
      'mount-s3',
      'findmnt',
    ]);
    expect(mountCommands.find(({ cmd }) => cmd === 'mount-s3')).toMatchObject({
      args: [
        'trusted-bucket',
        '/vercel/sandbox/data',
        '--allow-other',
        '--read-only',
        '--endpoint-url',
        'https://trusted.example.test',
        '--prefix',
        'trusted-prefix/',
      ],
    });
    expect(JSON.stringify(mountCommands)).not.toContain('tampered-bucket');
    expect(JSON.stringify(resumed.state.manifest)).not.toContain(
      'tampered-bucket',
    );
    const rawMountCommand = rawRunCommandMock.mock.calls
      .map(([params]) => params)
      .find(
        ({ cmd, args }) =>
          cmd === '/bin/sh' &&
          args?.[2] === 'vercel-sandbox-mount-command' &&
          args?.[3] === 'mount-s3',
      );
    expect(rawMountCommand).toMatchObject({
      env: {
        AWS_ENDPOINT_URL: '',
        LD_PRELOAD: '',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    });
  });

  test('remounts nested live mounts in filesystem-safe order', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'findmnt' && params.args?.includes('TARGET')) {
          return commandFinished(
            0,
            '/vercel/sandbox/parent\n/vercel/sandbox/parent/child\n',
          );
        }
        return await defaultRunCommand(params);
      },
    );
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'child',
        mountPath: '/vercel/sandbox/parent/child',
        mount: s3Mount({
          bucket: 'child-bucket',
          mountPath: '/vercel/sandbox/parent/child',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
      {
        logicalPath: 'parent',
        mountPath: '/vercel/sandbox/parent',
        mount: s3Mount({
          bucket: 'parent-bucket',
          mountPath: '/vercel/sandbox/parent',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          parent: s3Mount({
            bucket: 'persisted-parent',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          child: s3Mount({
            bucket: 'persisted-child',
            mountPath: '/vercel/sandbox/parent/child',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await client.resume(state);

    const commands = runCommandMock.mock.calls.map(([params]) => params);
    expect(
      commands
        .filter(({ cmd }) => cmd === 'umount')
        .map(({ args }) => args?.[0]),
    ).toEqual(['/vercel/sandbox/parent/child', '/vercel/sandbox/parent']);
    expect(
      commands
        .filter(({ cmd }) => cmd === 'mount-s3')
        .map(({ args }) => [args?.[0], args?.[1]]),
    ).toEqual([
      ['parent-bucket', '/vercel/sandbox/parent'],
      ['child-bucket', '/vercel/sandbox/parent/child'],
    ]);
  });

  test('rejects live-resume mount topology changes before touching mounts', async () => {
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'data',
        mountPath: '/vercel/sandbox/trusted-data',
        mount: s3Mount({
          bucket: 'trusted-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'persisted-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        persistedTopology: [
          {
            logicalPath: 'data',
            mountPath: '/vercel/sandbox/data',
          },
        ],
        trustedTopology: [
          {
            logicalPath: 'data',
            mountPath: '/vercel/sandbox/trusted-data',
          },
        ],
      },
    });
    expect(
      runCommandMock.mock.calls.some(([params]) =>
        ['findmnt', 'umount', 'mount-s3'].includes(params.cmd ?? ''),
      ),
    ).toBe(false);
  });

  test('rejects incomplete persisted mount sets during live resume', async () => {
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'data',
        mountPath: '/vercel/sandbox/data',
        mount: s3Mount({
          bucket: 'trusted-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        persistedTopology: [],
        trustedTopology: [
          {
            logicalPath: 'data',
            mountPath: '/vercel/sandbox/data',
          },
        ],
      },
    });
    expect(resolveS3MountConfiguration).toHaveBeenCalledWith({
      persistedMounts: [],
    });
    expect(
      runCommandMock.mock.calls.some(([params]) =>
        ['findmnt', 'umount', 'mount-s3'].includes(params.cmd ?? ''),
      ),
    ).toBe(false);
  });

  test('rejects workspace-root mounts from trusted snapshot configuration', async () => {
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'data',
        mountPath: '/vercel/sandbox',
        mount: s3Mount({
          bucket: 'trusted-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
      }),
      sandboxId: 'vercel_existing',
      snapshotId: 'snap_existing',
      snapshotSandboxId: 'vercel_existing',
      workspacePersistence: 'native',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPath: '/vercel/sandbox',
        root: '/vercel/sandbox',
      },
    });

    expect(resolveS3MountConfiguration).toHaveBeenCalledWith({
      persistedMounts: [],
    });
    expect(
      runCommandMock.mock.calls.some(([params]) =>
        ['findmnt', 'umount', 'mount-s3'].includes(params.cmd ?? ''),
      ),
    ).toBe(false);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('re-resolves trusted nested snapshot mounts after mounting their parent', async () => {
    let parentMounted = false;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'parent-bucket') {
          parentMounted = true;
        }
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (!parentMounted && requestedPath === '/vercel/sandbox/parent/link') {
          return commandFinished(0, '/vercel/sandbox/aaa\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'parent',
        mountPath: '/vercel/sandbox/parent',
        mount: s3Mount({
          bucket: 'parent-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
      {
        logicalPath: 'child',
        mountPath: '/vercel/sandbox/parent/link',
        mount: s3Mount({
          bucket: 'child-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
      }),
      sandboxId: 'vercel_existing',
      snapshotId: 'snap_existing',
      snapshotSandboxId: 'vercel_existing',
      workspacePersistence: 'snapshot',
      environment: {},
    });

    await client.resume(state);

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'mount-s3')
        .map(({ args }) => [args?.[0], args?.[1]]),
    ).toEqual([
      ['parent-bucket', '/vercel/sandbox/parent'],
      ['child-bucket', '/vercel/sandbox/parent/link'],
    ]);
    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === 'mount-s3' &&
          params.args?.[1] === '/vercel/sandbox/aaa',
      ),
    ).toBe(false);
  });

  test('rejects live mounts omitted from persisted state without a resolver', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'findmnt' && params.args?.includes('TARGET')) {
          return commandFinished(0, '/vercel/sandbox/data\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPaths: ['/vercel/sandbox/data'],
      },
    });
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
  });

  test('rejects physical mounts outside the complete trusted set', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'findmnt' && params.args?.includes('TARGET')) {
          return commandFinished(
            0,
            '/vercel/sandbox/data\n/vercel/sandbox/stale\n',
          );
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration: trustPersistedS3Mounts,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPaths: ['/vercel/sandbox/stale'],
        trustedMountPaths: ['/vercel/sandbox/data'],
      },
    });
    expect(
      runCommandMock.mock.calls.some(([params]) =>
        ['umount', 'mount-s3'].includes(params.cmd ?? ''),
      ),
    ).toBe(false);
  });

  test('rebuilds the complete trusted mount set when resuming a snapshot', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'data',
        mountPath: '/vercel/sandbox/data',
        mount: s3Mount({
          bucket: 'trusted-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
      }),
      sandboxId: 'vercel_preserved',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_preserved',
      snapshotSandboxId: 'vercel_preserved',
    });

    const session = await client.resume(state);

    expect(resolveS3MountConfiguration).toHaveBeenCalledWith({
      persistedMounts: [],
    });
    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .find(({ cmd }) => cmd === 'mount-s3'),
    ).toMatchObject({
      args: expect.arrayContaining(['trusted-bucket', '/vercel/sandbox/data']),
    });
    expect(session.state.manifest.mountTargets()).toEqual([
      expect.objectContaining({
        logicalPath: 'data',
        mountPath: '/vercel/sandbox/data',
      }),
    ]);
  });

  test('rejects trusted snapshot mounts that cover persisted files', async () => {
    const resolveS3MountConfiguration = vi.fn(() => [
      {
        logicalPath: 'bucket',
        mountPath: '/vercel/sandbox/data',
        mount: s3Mount({
          bucket: 'trusted-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    ]);
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          'data/file.txt': {
            type: 'file',
            content: 'must remain visible\n',
          },
        },
      }),
      sandboxId: 'vercel_preserved',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_preserved',
      snapshotSandboxId: 'vercel_preserved',
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        path: '/vercel/sandbox/data/file.txt',
        mountPath: '/vercel/sandbox/data',
      },
    });

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('requires trusted mount configuration when resuming S3 mounts', async () => {
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'persisted-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPaths: ['/vercel/sandbox/data'],
      },
    });
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'findmnt'),
    ).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects snapshot S3 resumes without trusted configuration before creating a sandbox', async () => {
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'persisted-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_existing',
      snapshotSandboxId: 'vercel_existing',
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      code: 'mount_config_invalid',
      details: {
        mountPaths: ['/vercel/sandbox/data'],
      },
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
  });

  test('rejects live-resume mount paths outside the workspace before probing them', async () => {
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountPath: '/proc',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toThrow(
      'escapes the workspace root',
    );

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'findmnt'),
    ).toBe(false);
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'umount'),
    ).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects unexpected live-resume mount sources', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'findmnt' && params.args?.includes('SOURCE')) {
          return commandFinished(0, 'proc\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      resolveS3MountConfiguration: trustPersistedS3Mounts,
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest({
        root: '/vercel/sandbox',
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        mountPath: '/vercel/sandbox/data',
        expectedSource: 'mountpoint-s3',
        actualSource: 'proc',
      },
    });

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'umount'),
    ).toBe(false);
  });

  test('rejects unsupported mounts during live resume', async () => {
    const client = new VercelSandboxClient();
    const unsupportedEntries = [
      r2Mount({
        bucket: 'bucket',
        accountId: 'account',
        mountStrategy: new VercelCloudBucketMountStrategy(),
      }),
      s3Mount({
        bucket: 'bucket',
        mountStrategy: {
          type: 'another_strategy',
        },
      }),
    ];

    for (const entry of unsupportedEntries) {
      const state = await client.deserializeSessionState({
        manifest: new Manifest({
          root: '/vercel/sandbox',
          entries: {
            first: s3Mount({
              bucket: 'first-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            second: entry,
          },
        }),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
      });

      await expect(client.resume(state)).rejects.toBeInstanceOf(
        SandboxUnsupportedFeatureError,
      );
    }

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'findmnt'),
    ).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('delegates legacy live sandbox authentication after a 401 response', async () => {
    getMock
      .mockRejectedValueOnce(vercelHttpError(401))
      .mockResolvedValueOnce(makeSandbox('vercel_existing'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await client.resume(state);

    expect(getMock).toHaveBeenNthCalledWith(1, {
      sandboxId: 'vercel_existing',
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });
    expect(getMock).toHaveBeenNthCalledWith(2, {
      sandboxId: 'vercel_existing',
    });
    expect(state.authenticationMode).toBe('sdk');
    expect(state).not.toHaveProperty('projectId');
    expect(state).not.toHaveProperty('teamId');
    expect(state).not.toHaveProperty('token');
  });

  test('preserves legacy credentials when delegated authentication also fails', async () => {
    getMock
      .mockRejectedValueOnce(vercelHttpError(401))
      .mockRejectedValueOnce(new Error('delegated authentication failed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        cause: 'delegated authentication failed',
      },
    });

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(state.authenticationMode).toBeUndefined();
    expect(state).toMatchObject({
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });
  });

  test('does not delegate current explicit authentication after a 401 response', async () => {
    getMock.mockRejectedValueOnce(vercelHttpError(401));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      authenticationMode: 'explicit',
      projectId: 'prj_explicit',
      teamId: 'team_explicit',
      token: 'explicit_token',
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        responseStatus: 401,
      },
    });

    expect(getMock).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      authenticationMode: 'explicit',
      projectId: 'prj_explicit',
      teamId: 'team_explicit',
      token: 'explicit_token',
    });
  });

  test('does not delegate legacy authentication after a non-401 response', async () => {
    getMock.mockRejectedValueOnce(vercelHttpError(403));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        responseStatus: 403,
      },
    });

    expect(getMock).toHaveBeenCalledOnce();
    expect(state.authenticationMode).toBeUndefined();
  });

  test('discards incomplete serialized credentials before resolving PAT environment fallback', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      projectId: 'prj_serialized',
      token: 'serialized_token',
    });

    expect(state).not.toHaveProperty('projectId');
    expect(state).not.toHaveProperty('teamId');
    expect(state).not.toHaveProperty('token');

    await client.resume(state);

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_existing',
      projectId: 'prj_env',
      teamId: 'team_env',
      token: 'env_token',
    });
    expect(state).toMatchObject({
      projectId: 'prj_env',
      teamId: 'team_env',
      token: 'env_token',
    });
  });

  test('uses a complete current client triple when serialized credentials are incomplete', async () => {
    const client = new VercelSandboxClient({
      projectId: 'prj_current',
      teamId: 'team_current',
      token: 'current_token',
    });
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      projectId: 'prj_legacy',
      teamId: 'team_legacy',
    });

    await client.resume(state);

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_existing',
      projectId: 'prj_current',
      teamId: 'team_current',
      token: 'current_token',
    });
    expect(state).toMatchObject({
      projectId: 'prj_current',
      teamId: 'team_current',
      token: 'current_token',
    });
  });

  test('retains serialized access token credentials when resuming snapshot sandboxes', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await client.resume(state);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'serialized_token',
        source: {
          type: 'snapshot',
          snapshotId: 'snap_original',
        },
      }),
    );
  });

  test('delegates legacy snapshot resume authentication after a 401 response', async () => {
    createMock
      .mockRejectedValueOnce(vercelHttpError(401))
      .mockResolvedValueOnce(makeSandbox('vercel_restored'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await client.resume(state);

    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'serialized_token',
      }),
    );
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({
        projectId: expect.anything(),
        teamId: expect.anything(),
        token: expect.anything(),
      }),
    );
    expect(state.authenticationMode).toBe('sdk');
    expect(state).not.toHaveProperty('token');
  });

  test('delegates legacy snapshot restore authentication after a 401 response', async () => {
    getMock.mockResolvedValueOnce(makeSandbox('vercel_live'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_live',
      workspacePersistence: 'snapshot',
      environment: {},
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });
    const session = await client.resume(state);
    createMock
      .mockRejectedValueOnce(vercelHttpError(401))
      .mockResolvedValueOnce(makeSandbox('vercel_restored'));

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_restore',
      }),
    );

    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'serialized_token',
      }),
    );
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({
        projectId: expect.anything(),
        teamId: expect.anything(),
        token: expect.anything(),
      }),
    );
    expect(session.state.authenticationMode).toBe('sdk');
    expect(session.state).not.toHaveProperty('token');
  });

  test('reattaches live sandboxes when snapshot freshness was invalidated', async () => {
    getMock.mockResolvedValueOnce(makeSandbox('vercel_live'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_live',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_stale',
    });

    const session = await client.resume(state);

    expect(createMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_live',
    });
    expect(session.state.sandboxId).toBe('vercel_live');
    expect(session.state.snapshotId).toBe('snap_stale');
    expect(session.state.snapshotSandboxId).toBeUndefined();
  });

  test('wraps resume lookup provider errors', async () => {
    getMock.mockRejectedValueOnce(new Error('auth failed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'resume sandbox',
        sandboxId: 'vercel_existing',
        cause: 'auth failed',
      },
    });
  });

  test('wraps resume snapshot provider errors', async () => {
    createMock.mockRejectedValueOnce(new Error('snapshot restore failed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'resume sandbox from snapshot',
        sandboxId: 'vercel_original',
        snapshotId: 'snap_original',
        cause: 'snapshot restore failed',
      },
    });
  });

  test('wraps snapshot capture provider errors during explicit persistence', async () => {
    snapshotMock.mockRejectedValueOnce(new Error('snapshot failed'));
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'capture snapshot',
        sandboxId: 'vercel_test',
        cause: 'snapshot failed',
      },
    });
  });

  test('stores the live sandbox id after resuming from a snapshot', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });

    const session = await client.resume(state);

    expect(getMock).not.toHaveBeenCalled();
    expect(session.state.sandboxId).toBe('vercel_resumed');
    expect(session.state.snapshotId).toBe('snap_original');
    expect(session.state.snapshotSandboxId).toBeUndefined();
  });

  test('clears exposed port caches after resuming from a snapshot', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      configuredExposedPorts: [3000],
      environment: {},
      exposedPorts: {
        '3000': {
          host: 'old-vercel.example.test',
          port: 443,
          tls: true,
          query: '',
        },
      },
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });

    const session = await client.resume(state);
    const endpoint = await session.resolveExposedPort(3000);

    expect(domainMock).toHaveBeenCalledOnce();
    expect(endpoint.host).toBe('3000-vercel.example.test');
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('stops snapshot replacements when resume readiness times out', async () => {
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(31_000);
    try {
      createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
      const client = new VercelSandboxClient();
      const state = await client.deserializeSessionState({
        manifest: new Manifest(),
        sandboxId: 'vercel_original',
        workspacePersistence: 'snapshot',
        environment: {},
        snapshotId: 'snap_original',
        snapshotSandboxId: 'vercel_original',
      });

      await expect(client.resume(state)).rejects.toBeInstanceOf(
        SandboxLifecycleError,
      );

      expect(stopMock).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('captures and stops a live sandbox resumed from a snapshot', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
    snapshotMock.mockResolvedValueOnce({ snapshotId: 'snap_resumed' });
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });
    const session = await client.resume(state);

    await session.close();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state.snapshotId).toBe('snap_resumed');
    expect(session.state.snapshotSandboxId).toBe('vercel_resumed');
  });

  test('restores snapshot sessions instead of reattaching to the source sandbox', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_preserved',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_preserved',
      snapshotSandboxId: 'vercel_preserved',
    });

    const session = await client.resume(state);

    expect(getMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          type: 'snapshot',
          snapshotId: 'snap_preserved',
        },
      }),
    );
    expect(session.state.sandboxId).toBe('vercel_restored');
    expect(session.state.snapshotId).toBe('snap_preserved');
    expect(session.state.snapshotSandboxId).toBeUndefined();
  });

  test('surfaces stop failures when replacing snapshot sandboxes', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));
    stopMock
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined);

    let thrown: unknown;
    try {
      await session.hydrateWorkspace(
        encodeNativeSnapshotRef({
          provider: 'vercel',
          snapshotId: 'snap_restore',
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'vercel',
      sandboxId: 'vercel_test',
      replacementSandboxId: 'vercel_restored',
      cause: 'stop failed',
    });
    expect(stopMock).toHaveBeenCalledTimes(2);
    expect(session.state.sandboxId).toBe('vercel_test');
    expect(session.state.snapshotId).toBeUndefined();
  });

  test('unmounts a prepared replacement when the previous sandbox cannot stop', async () => {
    const sourceStopMock = vi
      .fn()
      .mockRejectedValue(new Error('source stop failed'));
    const replacementStopMock = vi
      .fn()
      .mockRejectedValue(new Error('replacement stop failed'));
    const replacementRunCommandMock = vi.fn(defaultRunCommand);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
          stop: replacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        workspacePersistence: 'snapshot',
      },
    );

    await expect(
      session.hydrateWorkspace(
        encodeNativeSnapshotRef({
          provider: 'vercel',
          snapshotId: 'snap_restore',
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        sandboxId: 'vercel_source',
        replacementSandboxId: 'vercel_replacement',
        cause: 'source stop failed',
        replacementStopCause: 'replacement stop failed',
      },
    });

    expect(
      replacementRunCommandMock.mock.calls
        .map(([params]) => params)
        .filter((params) => params?.cmd === 'umount')
        .map((params) => params?.args?.[0]),
    ).toEqual(['/vercel/sandbox/data']);
    expect(replacementStopMock).toHaveBeenCalledOnce();
    expect(session.state.sandboxId).toBe('vercel_source');
  });

  test('cancels credential refresh for a discarded snapshot replacement', async () => {
    const sourceStopMock = vi
      .fn()
      .mockRejectedValue(new Error('source stop failed'));
    const replacementStopMock = vi.fn().mockResolvedValue(undefined);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          stop: replacementStopMock,
        }),
      );
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
      resolveS3MountCredentials: async () => ({
        accessKeyId: 'temporary-access',
        secretAccessKey: 'temporary-secret',
        expiration: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      }),
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        workspacePersistence: 'snapshot',
      },
    );
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await expect(
        session.hydrateWorkspace(
          encodeNativeSnapshotRef({
            provider: 'vercel',
            snapshotId: 'snap_restore',
          }),
        ),
      ).rejects.toMatchObject({
        details: {
          cause: 'source stop failed',
        },
      });

      const replacementTimerIndex = setTimeoutSpy.mock.calls
        .map(([, delay]) => delay)
        .lastIndexOf(2_147_483_647);
      expect(replacementTimerIndex).toBeGreaterThanOrEqual(0);
      const replacementTimer =
        setTimeoutSpy.mock.results[replacementTimerIndex]?.value;
      expect(clearTimeoutSpy).toHaveBeenCalledWith(replacementTimer);
      expect(replacementStopMock).toHaveBeenCalledOnce();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      sourceStopMock.mockResolvedValue(undefined);
      await session.close();
    }
  });

  test('stops snapshot replacements when hydrate readiness times out', async () => {
    const replacementStopMock = vi.fn().mockResolvedValue(undefined);
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockResolvedValueOnce(
      makeSandbox('vercel_restored', {
        stop: replacementStopMock,
      }),
    );
    stopMock.mockClear();

    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(31_000);
    try {
      await expect(
        session.hydrateWorkspace(
          encodeNativeSnapshotRef({
            provider: 'vercel',
            snapshotId: 'snap_restore',
          }),
        ),
      ).rejects.toBeInstanceOf(SandboxLifecycleError);

      expect(replacementStopMock).toHaveBeenCalledOnce();
      expect(stopMock).not.toHaveBeenCalled();
      expect(session.state.sandboxId).toBe('vercel_test');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('stops snapshot replacements when mount rematerialization fails', async () => {
    const sourceStopMock = vi.fn().mockResolvedValue(undefined);
    const replacementStopMock = vi
      .fn()
      .mockRejectedValue(new Error('replacement stop failed'));
    const replacementRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'second-bucket') {
          return commandFinished(1, '', 'remount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
          stop: replacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          first: s3Mount({
            bucket: 'first-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        workspacePersistence: 'snapshot',
      },
    );

    await expect(
      session.hydrateWorkspace(
        encodeNativeSnapshotRef({
          provider: 'vercel',
          snapshotId: 'snap_restore',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'lifecycle_error',
      details: {
        restoreDetails: {
          stderr: 'remount failed',
        },
        stopCause: 'replacement stop failed',
      },
    });

    expect(replacementStopMock).toHaveBeenCalledOnce();
    expect(sourceStopMock).not.toHaveBeenCalled();
    expect(
      replacementRunCommandMock.mock.calls.some(
        ([params]) =>
          params?.cmd === 'umount' &&
          params?.args?.[0] === '/vercel/sandbox/first',
      ),
    ).toBe(true);
    expect(session.state.sandboxId).toBe('vercel_source');
  });

  test('serializes snapshot sessions without capturing new snapshots', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    const serialized = await client.serializeSessionState(session.state);

    expect(snapshotMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
    expect(serialized).toMatchObject({
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
    });
  });

  test('serializes snapshot state with create-time access token credentials', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state);

    expect(getMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(serialized).toMatchObject({
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
    });
  });

  test('captures snapshots before serializing preserved snapshot sessions', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state, {
      preserveOwnedSession: true,
      reuseLiveSession: false,
    });

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_test',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).not.toHaveBeenCalled();
    expect(serialized).toMatchObject({
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_test',
    });
  });

  test('captures snapshots before serializing snapshot sessions marked for close', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state, {
      willCloseAfterSerialize: true,
    });

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_test',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(serialized).toMatchObject({
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_test',
    });
  });

  test('captures snapshots during close after non-destructive serialization', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await client.serializeSessionState(session.state);
    await session.close();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('captures live sandbox snapshots without looking up credentials', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await session.close();

    expect(getMock).not.toHaveBeenCalled();
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('ignores stop failures after a close snapshot already shut down the sandbox', async () => {
    stopMock.mockRejectedValueOnce(new Error('sandbox already stopped'));
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.close()).resolves.toBeUndefined();
    await session.delete();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state.snapshotId).toBe('snap_test');
    expect(session.state.snapshotSandboxId).toBe('vercel_test');
  });

  test('does not probe mounts after a close snapshot stops the sandbox', async () => {
    let snapshotCompleted = false;
    snapshotMock.mockImplementationOnce(async () => {
      snapshotCompleted = true;
      return { snapshotId: 'snap_test' };
    });
    stopMock.mockRejectedValueOnce(new Error('sandbox already stopped'));
    runCommandMock.mockImplementation(async (params) => {
      if (snapshotCompleted) {
        throw new Error('sandbox stopped');
      }
      return await defaultRunCommand(params);
    });
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    runCommandMock.mockClear();

    await expect(session.close()).resolves.toBeUndefined();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  test('invalidates snapshot freshness after workspace writes', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }

    await session.persistWorkspace();
    expect(session.state.snapshotSandboxId).toBe('vercel_test');
    snapshotMock.mockClear();

    await editor.createFile({
      type: 'create_file',
      path: 'notes.txt',
      diff: '+fresh\n',
    });
    expect(session.state.snapshotSandboxId).toBeUndefined();

    await session.close();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  test('persists and hydrates tar workspaces through safe archive helpers', async () => {
    const archive = makeTarArchive([
      { name: 'keep.txt', content: 'keep' },
      { name: 'nested/file.txt', content: 'nested' },
    ]);
    readFileToBufferMock.mockResolvedValue(archive);
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(new Manifest());

    await expect(session.persistWorkspace()).resolves.toEqual(archive);
    await session.hydrateWorkspace(archive);

    expect(
      runCommandMock.mock.calls.some(([params]) =>
        String(params.args?.[1]).includes('tar -C'),
      ),
    ).toBe(true);
    expect(writeFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        content: archive,
      }),
    ]);
  });

  test('waits for active workspace operations before detaching mounts', async () => {
    const commandStarted = deferred<void>();
    const finishCommand = deferred<void>();
    readFileToBufferMock.mockResolvedValue(
      makeTarArchive([{ name: 'keep.txt', content: 'keep' }]),
    );
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === '/bin/sh' &&
          params.args?.[1]?.includes('long-running')
        ) {
          commandStarted.resolve(undefined);
          await finishCommand.promise;
          return commandFinished(0, 'done\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();

    const commandPromise = session.execCommand({ cmd: 'long-running' });
    await commandStarted.promise;
    const persistencePromise = session.persistWorkspace();
    await Promise.resolve();
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'umount'),
    ).toBe(false);
    await expect(
      session.execCommand({ cmd: 'should-not-run' }),
    ).rejects.toThrow('while S3 mounts are transitioning');

    finishCommand.resolve(undefined);
    await expect(commandPromise).resolves.toContain('done');
    await expect(persistencePromise).resolves.toBeInstanceOf(Uint8Array);
    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'umount'),
    ).toBe(true);
  });

  test('excludes workspace operations during dynamic mount transitions', async () => {
    const commandStarted = deferred<void>();
    const finishCommand = deferred<void>();
    const mountStarted = deferred<void>();
    const finishMount = deferred<void>();
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === '/bin/sh' &&
          params.args?.[1]?.includes('long-running')
        ) {
          commandStarted.resolve(undefined);
          await finishCommand.promise;
          return commandFinished(0, 'done\n');
        }
        if (params.cmd === 'mount-s3') {
          mountStarted.resolve(undefined);
          await finishMount.promise;
          return commandFinished();
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockClear();

    const commandPromise = session.execCommand({ cmd: 'long-running' });
    await commandStarted.promise;
    const materializationPromise = session.materializeEntry({
      path: 'data',
      entry: s3Mount({
        bucket: 'bucket',
        mountStrategy: new VercelCloudBucketMountStrategy(),
      }),
    });
    await Promise.resolve();

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'mount-s3'),
    ).toBe(false);

    finishCommand.resolve(undefined);
    await expect(commandPromise).resolves.toContain('done');
    await mountStarted.promise;
    await expect(
      session.execCommand({ cmd: 'should-not-run-during-mount' }),
    ).rejects.toThrow('while S3 mounts are transitioning');

    finishMount.resolve(undefined);
    await expect(materializationPromise).resolves.toBeUndefined();
    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === '/bin/sh' &&
          params.args?.[1]?.includes('should-not-run'),
      ),
    ).toBe(false);
  });

  test('clears cached directories after hydrating tar workspaces', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'cache/old.txt': {
            type: 'file',
            content: 'old\n',
          },
        },
      }),
    );
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }

    await session.hydrateWorkspace(archive);
    mkDirMock.mockClear();
    writeFilesMock.mockClear();

    await editor.createFile({
      type: 'create_file',
      path: 'cache/new.txt',
      diff: '+new\n',
    });

    expect(mkDirMock).toHaveBeenCalledWith('/vercel/sandbox/cache');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/cache/new.txt',
        content: 'new',
      },
    ]);
  });

  test('clears cached directories after shell commands', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'cache/old.txt': {
            type: 'file',
            content: 'old\n',
          },
        },
      }),
    );
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }
    mkDirMock.mockClear();
    writeFilesMock.mockClear();

    await session.execCommand({ cmd: 'rm -rf /vercel/sandbox/cache' });
    await editor.createFile({
      type: 'create_file',
      path: 'cache/new.txt',
      diff: '+new\n',
    });

    expect(mkDirMock).toHaveBeenCalledWith('/vercel/sandbox/cache');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/cache/new.txt',
        content: 'new',
      },
    ]);
  });

  test('rejects unsafe tar payloads before hydrate writes them', async () => {
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(new Manifest());
    writeFilesMock.mockClear();

    await expect(
      session.hydrateWorkspace(
        makeTarArchive([{ name: '../escape.txt', content: 'bad' }]),
      ),
    ).rejects.toBeInstanceOf(SandboxArchiveError);
    expect(writeFilesMock).not.toHaveBeenCalled();
  });

  test('uses tar fallback for snapshot persistence with an S3 mount', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    readFileToBufferMock.mockResolvedValue(archive);
    const client = new VercelSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();

    const persisted = await session.persistWorkspace();

    expect(persisted).toEqual(archive);
    expect(decodeNativeSnapshotRef(persisted)).toBeUndefined();
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(client.canPersistOwnedSessionState(session.state)).toBe(false);
    expect(client.canReusePreservedOwnedSession(session.state)).toBe(true);

    const calls = runCommandMock.mock.calls.map(([params]) => params);
    const unmountIndex = calls.findIndex(({ cmd }) => cmd === 'umount');
    const tarIndex = calls.findIndex(({ args }) =>
      String(args?.[1]).includes(
        "tar --one-file-system --anchored --no-wildcards --exclude='./data'",
      ),
    );
    const remountIndex = calls.map(({ cmd }) => cmd).lastIndexOf('mount-s3');
    const remountVerificationIndex = calls.findIndex(
      ({ cmd, args }, index) =>
        index > remountIndex &&
        cmd === 'findmnt' &&
        args?.includes('TARGET') === true,
    );
    expect(unmountIndex).toBeGreaterThanOrEqual(0);
    expect(tarIndex).toBeGreaterThan(unmountIndex);
    expect(remountIndex).toBeGreaterThan(tarIndex);
    expect(remountVerificationIndex).toBeGreaterThan(remountIndex);

    await session.close();
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  test('detaches and restores S3 mounts around tar hydration', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();

    await session.hydrateWorkspace(archive);

    const calls = runCommandMock.mock.calls.map(([params]) => params);
    const unmountIndex = calls.findIndex(({ cmd }) => cmd === 'umount');
    const hydrateIndex = calls.findIndex(({ args }) =>
      String(args?.[1]).includes("find '/vercel/sandbox'"),
    );
    const remountIndex = calls.map(({ cmd }) => cmd).lastIndexOf('mount-s3');
    expect(unmountIndex).toBeGreaterThanOrEqual(0);
    expect(hydrateIndex).toBeGreaterThan(unmountIndex);
    expect(remountIndex).toBeGreaterThan(hydrateIndex);
    expect(writeFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        content: archive,
      }),
    ]);
  });

  test('does not remount nested children after an ambiguous parent unmount', async () => {
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          parent: s3Mount({
            bucket: 'parent-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          child: s3Mount({
            bucket: 'child-bucket',
            mountPath: '/vercel/sandbox/parent/child',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'umount' &&
          params.args?.[0] === '/vercel/sandbox/parent'
        ) {
          throw Object.assign(new Error('parent unmount timed out'), {
            name: 'TimeoutError',
          });
        }
        return await defaultRunCommand(params);
      },
    );
    runCommandMock.mockClear();

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      code: 'mount_failed',
      details: {
        cause: 'parent unmount timed out',
        command: "'umount' '/vercel/sandbox/parent'",
      },
    });

    const calls = runCommandMock.mock.calls.map(([params]) => params);
    expect(
      calls.filter(({ cmd }) => cmd === 'umount').map(({ args }) => args?.[0]),
    ).toEqual(['/vercel/sandbox/parent/child', '/vercel/sandbox/parent']);
    expect(calls.some(({ cmd }) => cmd === 'mount-s3')).toBe(false);
    await expect(session.execCommand({ cmd: 'pwd' })).rejects.toMatchObject({
      details: {
        command: 'umount',
      },
    });

    runCommandMock.mockImplementation(defaultRunCommand);
    await session.close();
  });

  test('does not unmount an untracked S3 mount during close', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'findmnt' && params.args?.includes('TARGET')) {
          return commandFinished(0, '/tmp/moved/data\n');
        }
        return await defaultRunCommand(params);
      },
    );
    runCommandMock.mockClear();

    await session.close();

    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === 'umount' && params.args?.[0] === '/tmp/moved/data',
      ),
    ).toBe(false);
    expect(
      runCommandMock.mock.calls.some(
        ([params]) =>
          params.cmd === 'umount' &&
          params.args?.[0] === '/vercel/sandbox/data',
      ),
    ).toBe(true);
  });

  test('rejects tar members beneath S3 mounts before detaching them', async () => {
    const archive = makeTarArchive([
      { name: 'data/object.txt', content: 'unexpected' },
    ]);
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();
    writeFilesMock.mockClear();

    await expect(session.hydrateWorkspace(archive)).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );

    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(
      runCommandMock.mock.calls.some(
        ([params]) => params.cmd === 'umount' || params.cmd === 'mount-s3',
      ),
    ).toBe(false);
    await expect(session.execCommand({ cmd: 'pwd' })).resolves.toBeDefined();
  });

  test('rejects tar members beneath declared symlink mount paths before detaching them', async () => {
    const archive = makeTarArchive([
      { name: 'linked-data/object.txt', content: 'unexpected' },
    ]);
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-data')) {
          return commandFinished(0, '/vercel/sandbox/real-data\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountPath: '/vercel/sandbox/linked-data',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();
    writeFilesMock.mockClear();

    await expect(session.hydrateWorkspace(archive)).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );

    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(
      runCommandMock.mock.calls.some(
        ([params]) => params.cmd === 'umount' || params.cmd === 'mount-s3',
      ),
    ).toBe(false);
    await expect(session.execCommand({ cmd: 'pwd' })).resolves.toBeDefined();
  });

  test('enforces session archive limits before detaching S3 mounts', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
      {
        archiveLimits: {
          maxInputBytes: 1,
          maxExtractedBytes: null,
          maxMembers: null,
        },
      },
    );
    runCommandMock.mockClear();
    writeFilesMock.mockClear();

    await expect(session.hydrateWorkspace(archive)).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );

    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(
      runCommandMock.mock.calls.some(
        ([params]) => params.cmd === 'umount' || params.cmd === 'mount-s3',
      ),
    ).toBe(false);
    await expect(session.execCommand({ cmd: 'pwd' })).resolves.toBeDefined();
  });

  test('refreshes temporary S3 credentials before expiration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const resolveS3MountCredentials = vi
        .fn()
        .mockResolvedValueOnce({
          accessKeyId: 'initial-access',
          secretAccessKey: 'initial-secret',
          sessionToken: 'initial-session',
          expiration: new Date('2026-01-01T00:00:10.000Z'),
        })
        .mockResolvedValue({
          accessKeyId: 'refreshed-access',
          secretAccessKey: 'refreshed-secret',
          sessionToken: 'refreshed-session',
          expiration: new Date('2026-01-01T00:00:30.000Z'),
        });
      const client = new VercelSandboxClient({
        allowS3CredentialExposure: true,
        resolveS3MountCredentials,
      });
      const session = await client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      );
      runCommandMock.mockClear();

      await vi.advanceTimersByTimeAsync(8_000);

      expect(resolveS3MountCredentials).toHaveBeenCalledTimes(2);
      const calls = runCommandMock.mock.calls.map(([params]) => params);
      expect(calls.some(({ cmd }) => cmd === 'umount')).toBe(true);
      expect(calls).toContainEqual(
        expect.objectContaining({
          cmd: 'mount-s3',
          env: expect.objectContaining({
            AWS_ACCESS_KEY_ID: 'refreshed-access',
            AWS_SECRET_ACCESS_KEY: 'refreshed-secret',
            AWS_SESSION_TOKEN: 'refreshed-session',
          }),
        }),
      );
      const remountIndex = calls.map(({ cmd }) => cmd).lastIndexOf('mount-s3');
      expect(
        calls.findIndex(
          ({ cmd, args }, index) =>
            index > remountIndex &&
            cmd === 'findmnt' &&
            args?.includes('TARGET') === true,
        ),
      ).toBeGreaterThan(remountIndex);

      await session.close();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(resolveS3MountCredentials).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('caps long credential refresh timers at the supported delay', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    let session: Awaited<ReturnType<VercelSandboxClient['create']>> | undefined;
    try {
      const client = new VercelSandboxClient({
        allowS3CredentialExposure: true,
        resolveS3MountCredentials: async () => ({
          accessKeyId: 'long-lived-access',
          secretAccessKey: 'long-lived-secret',
          expiration: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        }),
      });
      session = await client.create(
        new Manifest({
          entries: {
            data: s3Mount({
              bucket: 'bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      );

      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        2_147_483_647,
      );
    } finally {
      setTimeoutSpy.mockRestore();
      await session?.close();
    }
  });

  test('retains detached mounts after a partial remount failure', async () => {
    let workspaceOperationStarted = false;
    let restoreMountCalls = 0;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === '/bin/sh' &&
          String(params.args?.[1]).includes('tar ')
        ) {
          workspaceOperationStarted = true;
        }
        if (params.cmd === 'mount-s3' && workspaceOperationStarted) {
          restoreMountCalls += 1;
          if (restoreMountCalls === 2) {
            return commandFinished(1, '', 'transient remount failure');
          }
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          first: s3Mount({
            bucket: 'first-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    await expect(session.persistWorkspace()).rejects.toBeInstanceOf(
      SandboxMountError,
    );
    const commandCountAfterFailure = runCommandMock.mock.calls.length;

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/second'],
      },
    });
    await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/second'],
      },
    });
    await expect(
      session.readFile({ path: '/vercel/sandbox/second/object.txt' }),
    ).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/second'],
      },
    });
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }
    await expect(
      editor.createFile({
        type: 'create_file',
        path: 'local-after-failure.txt',
        diff: '+unsafe\n',
      }),
    ).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/second'],
      },
    });
    await expect(
      session.materializeEntry({
        path: 'dynamic-after-failure',
        entry: {
          type: 'file',
          content: 'unsafe\n',
        },
      }),
    ).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/second'],
      },
    });
    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            'applied-after-failure.txt': {
              type: 'file',
              content: 'unsafe\n',
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/second'],
      },
    });
    expect(runCommandMock).toHaveBeenCalledTimes(commandCountAfterFailure);
  });

  test('retains the pending detached mount when symlink targets swap', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    let hydrating = false;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === '/bin/sh' &&
          String(params.args?.[1]).includes("find '/vercel/sandbox'")
        ) {
          hydrating = true;
        }
        const requestedPath = resolvedRemotePathFromValidationCommand(
          params.args?.[1] ?? '',
        );
        if (requestedPath?.endsWith('/linked-first')) {
          return commandFinished(
            0,
            hydrating
              ? '/vercel/sandbox/real-second\n'
              : '/vercel/sandbox/real-first\n',
          );
        }
        if (requestedPath?.endsWith('/linked-second')) {
          return commandFinished(
            0,
            hydrating
              ? '/vercel/sandbox/real-first\n'
              : '/vercel/sandbox/real-second\n',
          );
        }
        if (
          params.cmd === 'mount-s3' &&
          hydrating &&
          params.args?.[0] === 'first-bucket'
        ) {
          return commandFinished(1, '', 'remount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          first: s3Mount({
            bucket: 'first-bucket',
            mountPath: '/vercel/sandbox/linked-first',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountPath: '/vercel/sandbox/linked-second',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );

    await expect(session.hydrateWorkspace(archive)).rejects.toBeInstanceOf(
      SandboxMountError,
    );
    await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/real-first'],
      },
    });
  });

  test('persists Vercel snapshots as Python-compatible native refs', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    const ref = decodeNativeSnapshotRef(await session.persistWorkspace());

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(ref).toEqual({
      provider: 'vercel',
      snapshotId: 'snap_test',
      workspacePersistence: undefined,
    });
  });

  test('rebinds live snapshot persistence to a replacement sandbox', async () => {
    const sourceStopMock = vi.fn().mockResolvedValue(undefined);
    const replacementRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) =>
        params.cmd === 'findmnt'
          ? await defaultRunCommand(params)
          : commandFinished(0, 'replacement\n'),
    );
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockClear();
    stopMock.mockClear();

    const ref = decodeNativeSnapshotRef(await session.persistWorkspace());

    expect(ref).toMatchObject({
      provider: 'vercel',
      snapshotId: 'snap_test',
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          type: 'snapshot',
          snapshotId: 'snap_test',
        },
      }),
    );
    expect(sourceStopMock).toHaveBeenCalledOnce();
    expect(stopMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_replacement',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_replacement',
    });
    expect(replacementRunCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'true'],
      cwd: '/',
      env: {},
    });

    replacementRunCommandMock.mockClear();
    await session.execCommand({ cmd: 'echo after-persist' });

    expect(replacementRunCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'echo after-persist'],
      cwd: '/vercel/sandbox',
      env: {},
    });
  });

  test('keeps restored snapshot persistence when the snapshotted source is already stopped', async () => {
    const sourceStopMock = vi
      .fn()
      .mockRejectedValue(new Error('sandbox already stopped'));
    const replacementStopMock = vi.fn().mockResolvedValue(undefined);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          stop: replacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.persistWorkspace()).resolves.toEqual(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_test',
      }),
    );

    expect(sourceStopMock).toHaveBeenCalledOnce();
    expect(replacementStopMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_replacement',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_replacement',
    });
  });

  test('does not rebind snapshot persistence when the previous sandbox stop fails', async () => {
    const sourceStopMock = vi
      .fn()
      .mockRejectedValue(new Error('network timeout'));
    const firstReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    const secondReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_1', {
          stop: firstReplacementStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_2', {
          stop: secondReplacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        sandboxId: 'vercel_source',
        snapshotId: 'snap_test',
      },
    });

    expect(sourceStopMock).toHaveBeenCalledTimes(2);
    expect(firstReplacementStopMock).toHaveBeenCalledOnce();
    expect(secondReplacementStopMock).toHaveBeenCalledOnce();
    expect(session.state.sandboxId).toBe('vercel_source');
    expect(session.state.snapshotSandboxId).toBe('vercel_source');
  });

  test('uses an updated complete state triple when restoring persisted snapshots', async () => {
    createMock
      .mockResolvedValueOnce(makeSandbox('vercel_source'))
      .mockResolvedValueOnce(makeSandbox('vercel_replacement'));
    const client = new VercelSandboxClient({
      projectId: 'prj_cli',
      teamId: 'team_cli',
      token: 'cli_access_token',
    });
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    session.state.token = 'updated_token';
    createMock.mockClear();

    await session.persistWorkspace();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_cli',
        teamId: 'team_cli',
        token: 'updated_token',
        source: {
          type: 'snapshot',
          snapshotId: 'snap_test',
        },
      }),
    );
    expect(session.state.token).toBe('updated_token');
  });

  test('stops each previous sandbox during repeated snapshot persistence', async () => {
    const sourceStopMock = vi.fn().mockResolvedValue(undefined);
    const firstReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    const secondReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_1', {
          stop: firstReplacementStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_2', {
          stop: secondReplacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await session.persistWorkspace();
    await session.persistWorkspace();

    expect(sourceStopMock).toHaveBeenCalledOnce();
    expect(firstReplacementStopMock).toHaveBeenCalledOnce();
    expect(secondReplacementStopMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_replacement_2',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_replacement_2',
    });
  });

  test('recovers live snapshot persistence when replacement restore fails', async () => {
    const recoveredRunCommandMock = vi.fn(
      async (params: { cmd?: string; args?: string[] } = {}) =>
        params.cmd === 'findmnt'
          ? await defaultRunCommand(params)
          : commandFinished(0, 'recovered\n'),
    );
    createMock
      .mockResolvedValueOnce(makeSandbox('vercel_source'))
      .mockRejectedValueOnce(new Error('restore failed'))
      .mockResolvedValueOnce(
        makeSandbox('vercel_recovered', {
          runCommand: recoveredRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockClear();

    const ref = decodeNativeSnapshotRef(await session.persistWorkspace());

    expect(ref).toMatchObject({
      provider: 'vercel',
      snapshotId: 'snap_test',
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_recovered',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_recovered',
    });

    recoveredRunCommandMock.mockClear();
    await session.execCommand({ cmd: 'echo after-recovery' });

    expect(recoveredRunCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'echo after-recovery'],
      cwd: '/vercel/sandbox',
      env: {},
    });
  });

  test('stops the sandbox when snapshot capture fails during close', async () => {
    snapshotMock.mockRejectedValueOnce(new Error('snapshot failed'));
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.close()).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'capture snapshot',
        sandboxId: 'vercel_test',
        cause: 'snapshot failed',
      },
    });

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('stops the sandbox when manifest application fails during create', async () => {
    writeFilesMock.mockRejectedValueOnce(new Error('write failed'));
    const client = new VercelSandboxClient();

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

    expect(createMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('rolls back partial initial mounts before stopping a failed create', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'second-bucket') {
          return commandFinished(1, '', 'second mount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            first: s3Mount({
              bucket: 'first-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            second: s3Mount({
              bucket: 'second-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxMountError);

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount'),
    ).toEqual([
      expect.objectContaining({
        args: ['/vercel/sandbox/first'],
        sudo: true,
      }),
      expect.objectContaining({
        args: ['/vercel/sandbox/second'],
        sudo: true,
      }),
    ]);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('rolls back uncertain nested mounts from child to parent', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'child-bucket') {
          throw Object.assign(new Error('child mount timed out'), {
            name: 'TimeoutError',
          });
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            parent: s3Mount({
              bucket: 'parent-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            child: s3Mount({
              bucket: 'child-bucket',
              mountPath: '/vercel/sandbox/parent/child',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxMountError);

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount')
        .map(({ args }) => args?.[0]),
    ).toEqual(['/vercel/sandbox/parent/child', '/vercel/sandbox/parent']);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('continues initial mount rollback after an unmount failure', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'third-bucket') {
          throw Object.assign(new Error('third mount timed out'), {
            name: 'TimeoutError',
          });
        }
        if (
          params.cmd === 'umount' &&
          params.args?.[0] === '/vercel/sandbox/second'
        ) {
          return commandFinished(1, '', 'second unmount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            first: s3Mount({
              bucket: 'first-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            second: s3Mount({
              bucket: 'second-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            third: s3Mount({
              bucket: 'third-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'mount_failed',
      details: {
        rollbackFailures: [
          expect.objectContaining({
            mountPath: '/vercel/sandbox/second',
            cause: expect.stringContaining('unmount'),
          }),
        ],
      },
    });

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount')
        .map(({ args }) => args?.[0]),
    ).toEqual([
      '/vercel/sandbox/first',
      '/vercel/sandbox/second',
      '/vercel/sandbox/third',
      '/vercel/sandbox/second',
    ]);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('preserves initial mount rollback and stop failures', async () => {
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (params.cmd === 'mount-s3' && params.args?.[0] === 'second-bucket') {
          return commandFinished(1, '', 'second mount failed');
        }
        if (params.cmd === 'umount') {
          return commandFinished(1, '', 'unmount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            first: s3Mount({
              bucket: 'first-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
            second: s3Mount({
              bucket: 'second-bucket',
              mountStrategy: new VercelCloudBucketMountStrategy(),
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'lifecycle_error',
      details: {
        manifestDetails: {
          materializationDetails: {
            stderr: 'second mount failed',
          },
          rollbackDetails: {
            stderr: 'unmount failed',
          },
        },
        stopCause: 'stop failed',
      },
    });

    expect(
      runCommandMock.mock.calls.some(([params]) => params.cmd === 'umount'),
    ).toBe(true);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('cancels credential refresh after a failed initial mount cleanup', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      runCommandMock.mockImplementation(
        async (params: { cmd?: string; args?: string[] } = {}) => {
          if (
            params.cmd === 'mount-s3' &&
            params.args?.[0] === 'second-bucket'
          ) {
            return commandFinished(1, '', 'second mount failed');
          }
          if (params.cmd === 'umount') {
            return commandFinished(1, '', 'unmount failed');
          }
          return await defaultRunCommand(params);
        },
      );
      stopMock.mockRejectedValueOnce(new Error('stop failed'));
      const client = new VercelSandboxClient({
        allowS3CredentialExposure: true,
        resolveS3MountCredentials: async () => ({
          accessKeyId: 'temporary-access',
          secretAccessKey: 'temporary-secret',
          expiration: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        }),
      });

      await expect(
        client.create(
          new Manifest({
            entries: {
              first: s3Mount({
                bucket: 'first-bucket',
                mountStrategy: new VercelCloudBucketMountStrategy(),
              }),
              second: s3Mount({
                bucket: 'second-bucket',
                mountStrategy: new VercelCloudBucketMountStrategy(),
              }),
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'lifecycle_error',
      });

      const refreshTimerIndex = setTimeoutSpy.mock.calls.findIndex(
        ([, delay]) => delay === 2_147_483_647,
      );
      expect(refreshTimerIndex).toBeGreaterThanOrEqual(0);
      const refreshTimer = setTimeoutSpy.mock.results[refreshTimerIndex]?.value;
      expect(clearTimeoutSpy).toHaveBeenCalledWith(refreshTimer);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test('does not reuse preserved snapshot sessions as live handles', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await client.serializeSessionState(session.state);

    expect(client.canReusePreservedOwnedSession(session.state)).toBe(false);
  });

  test('does not stop a sandbox twice across shutdown and delete lifecycle hooks', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await session.shutdown();
    await session.delete();

    expect(stopMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledWith();
  });

  test('retries close after a stop failure', async () => {
    stopMock
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined);
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await expect(session.close()).rejects.toThrow('stop failed');
    await session.delete();

    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  test('stops mount-free sandboxes without waiting for active commands', async () => {
    const commandStarted = deferred<void>();
    const finishCommand = deferred<void>();
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === '/bin/sh' &&
          params.args?.[1]?.includes('long-running')
        ) {
          commandStarted.resolve(undefined);
          await finishCommand.promise;
          return commandFinished(0, 'done\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    const commandPromise = session.execCommand({ cmd: 'long-running' });
    await commandStarted.promise;
    const closePromise = session.close();

    await vi.waitFor(() => expect(stopMock).toHaveBeenCalledOnce());
    await expect(closePromise).resolves.toBeUndefined();

    finishCommand.resolve(undefined);
    await expect(commandPromise).resolves.toContain('done');
  });

  test('keeps successfully unmounted paths unusable after a stop failure', async () => {
    stopMock
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined);
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();

    await expect(session.close()).rejects.toThrow('stop failed');
    const commandCountAfterClose = runCommandMock.mock.calls.length;
    await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
      details: {
        detachedMountPaths: ['/vercel/sandbox/data'],
      },
    });
    expect(runCommandMock).toHaveBeenCalledTimes(commandCountAfterClose);

    await session.delete();
    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  test('keeps retry-cleaned mounts unusable after a stop failure', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          data: s3Mount({
            bucket: 'bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    let unmountAttempts = 0;
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'umount' &&
          params.args?.[0] === '/vercel/sandbox/data' &&
          ++unmountAttempts === 1
        ) {
          return commandFinished(1, '', 'initial unmount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(session.close()).rejects.toThrow(
      'Failed to prepare and stop a Vercel sandbox.',
    );
    expect(unmountAttempts).toBe(2);
    expect(session.state.mountStateUncertainCommand).toBe('umount');
    const commandCountAfterClose = runCommandMock.mock.calls.length;

    await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
      details: {
        command: 'umount',
      },
    });
    expect(runCommandMock).toHaveBeenCalledTimes(commandCountAfterClose);
  });

  test('continues close cleanup after an unmount failure', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          first: s3Mount({
            bucket: 'first-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
          second: s3Mount({
            bucket: 'second-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
      }),
    );
    runCommandMock.mockClear();
    runCommandMock.mockImplementation(
      async (params: { cmd?: string; args?: string[] } = {}) => {
        if (
          params.cmd === 'umount' &&
          params.args?.[0] === '/vercel/sandbox/second'
        ) {
          return commandFinished(1, '', 'second unmount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(session.close()).rejects.toThrow(
      'Failed to prepare and stop a Vercel sandbox.',
    );

    expect(
      runCommandMock.mock.calls
        .map(([params]) => params)
        .filter(({ cmd }) => cmd === 'umount')
        .map(({ args }) => args?.[0]),
    ).toEqual([
      '/vercel/sandbox/second',
      '/vercel/sandbox/first',
      '/vercel/sandbox/second',
    ]);
    await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
      details: {
        command: 'umount',
      },
    });
  });

  test('preserves missing optional Vercel sandbox methods', async () => {
    createMock.mockResolvedValueOnce(
      makeSandbox('vercel_test', {
        domain: undefined,
        stop: undefined,
        snapshot: undefined,
      }),
    );
    const client = new VercelSandboxClient({
      exposedPorts: [3000],
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(new Manifest());
    getMock.mockClear();

    await expect(session.resolveExposedPort(3000)).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
    expect(session.state.snapshotSupported).toBe(false);
    expect(client.canPersistOwnedSessionState(session.state)).toBe(false);
    expect(client.canReusePreservedOwnedSession(session.state)).toBe(true);
    await expect(
      client.serializeSessionState(session.state, {
        willCloseAfterSerialize: true,
      }),
    ).resolves.toMatchObject({
      workspacePersistence: 'snapshot',
      snapshotSupported: false,
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
    await expect(session.persistWorkspace()).rejects.toThrow(
      'Vercel snapshot persistence requires @vercel/sandbox snapshot support.',
    );
    await expect(session.close()).resolves.toBeUndefined();
    expect(stopMock).not.toHaveBeenCalled();
  });

  test('accepts absolute workspace paths for remote file checks', async () => {
    const client = new VercelSandboxClient();
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

    const exists = await session.pathExists('/vercel/sandbox/README.md');

    expect(exists).toBe(true);
    expect(runCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', "test -e '/vercel/sandbox/README.md'"],
      cwd: '/vercel/sandbox',
      env: {},
    });
    await expect(
      session.pathExists('/vercel/sandbox/../tmp/README.md'),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test('resolves configured exposed ports through Vercel domains', async () => {
    const client = new VercelSandboxClient({
      exposedPorts: [3000],
    });
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(3000);
    const cachedEndpoint = await session.resolveExposedPort(3000);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ports: [3000],
      }),
    );
    expect(domainMock).toHaveBeenCalledWith(3000);
    expect(domainMock).toHaveBeenCalledOnce();
    expect(endpoint).toMatchObject({
      host: '3000-vercel.example.test',
      port: 443,
      tls: true,
    });
    expect(cachedEndpoint).toBe(endpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('rejects unsupported PTY execution with a typed error', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'sh', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('rejects command runAs instead of sudoing as root', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockClear();

    await expect(
      session.execCommand({ cmd: 'id', runAs: 'root' }),
    ).rejects.toThrow(/does not support runAs yet/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });
});
