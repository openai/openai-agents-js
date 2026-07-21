import {
  Manifest,
  SandboxArchiveError,
  SandboxLifecycleError,
  SandboxMountError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  s3Mount,
} from '@openai/agents-core/sandbox';
import { serializeManifestRecord } from '@openai/agents-core/sandbox/internal';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
} from '../../src/sandbox/shared';
import {
  VercelCloudBucketMountStrategy,
  VercelSandboxClient,
} from '../../src/sandbox/vercel';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const createMock = vi.fn();
const getMock = vi.fn();
const runCommandMock = vi.fn();
const mkDirMock = vi.fn();
const readFileToBufferMock = vi.fn();
const writeFilesMock = vi.fn();
const stopMock = vi.fn();
const snapshotMock = vi.fn();
const domainMock = vi.fn();
const remoteFilePaths = new Set<string>();
const mountedPaths = new Set<string>();

type MockRunCommandParams = {
  cmd?: string;
  args?: string[];
};

function commandResult(
  exitCode: number,
  stdout: string = '',
  stderr: string = '',
) {
  const result = {
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
    wait: vi.fn(),
    kill: vi.fn(async () => {}),
  };
  result.wait.mockResolvedValue(result);
  return result;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function isolatedMountCommand(
  params: MockRunCommandParams,
): { command: string; args: string[] } | undefined {
  if (params.cmd !== '/usr/bin/env') {
    return undefined;
  }
  const args = params.args ?? [];
  let commandIndex = 1;
  while (args[commandIndex]?.includes('=')) {
    commandIndex += 1;
  }
  const command = args[commandIndex];
  return command ? { command, args: args.slice(commandIndex + 1) } : undefined;
}

async function defaultRunCommand(params: MockRunCommandParams = {}) {
  const isolated = isolatedMountCommand(params);
  if (isolated) {
    switch (isolated.command) {
      case 'sh':
      case 'dnf':
      case 'mkdir':
        return commandResult(0);
      case 'rpm':
        return commandResult(0, '1.21.0\n');
      case 'find':
        return commandResult(0, '');
      case 'id':
        return commandResult(0, isolated.args[0] === '-u' ? '1000\n' : '100\n');
      case 'mount-s3':
        mountedPaths.add(isolated.args[1]!);
        return commandResult(0);
      case 'findmnt': {
        const mountPath = isolated.args.at(-1)!;
        return mountedPaths.has(mountPath)
          ? commandResult(0, 'mountpoint-s3\n')
          : commandResult(1);
      }
      case 'umount':
        mountedPaths.delete(isolated.args[0]!);
        return commandResult(0);
      case 'mountpoint':
        return commandResult(mountedPaths.has(isolated.args.at(-1)!) ? 0 : 1);
      default:
        return commandResult(1, '', `unexpected command: ${isolated.command}`);
    }
  }

  const command = params.args?.[1] ?? '';
  const path = testExistsPath(command);
  if (path) {
    return commandResult(remoteFilePaths.has(path) ? 0 : 1);
  }
  const resolvedPath = resolvedRemotePathFromValidationCommand(command);
  return commandResult(0, resolvedPath ? `${resolvedPath}\n` : 'README.md\n');
}

function makeSandbox(
  sandboxId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sandboxId,
    runCommand: runCommandMock,
    mkDir: mkDirMock,
    readFileToBuffer: readFileToBufferMock,
    writeFiles: writeFilesMock,
    stop: stopMock,
    snapshot: snapshotMock,
    domain: domainMock,
    ...overrides,
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

function vercelS3Manifest(
  path: string = 'bucket',
  overrides: Partial<Parameters<typeof s3Mount>[0]> = {},
): Manifest {
  return new Manifest({
    entries: {
      [path]: s3Mount({
        bucket: 'example-bucket',
        mountStrategy: new VercelCloudBucketMountStrategy(),
        ...overrides,
      }),
    },
  });
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
    mkDirMock.mockReset();
    readFileToBufferMock.mockReset();
    writeFilesMock.mockReset();
    stopMock.mockReset();
    snapshotMock.mockReset();
    domainMock.mockReset();
    remoteFilePaths.clear();
    mountedPaths.clear();

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

  test('requires explicit acknowledgement before exposing S3 credentials', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        vercelS3Manifest('bucket', {
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxMountError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('mounts a fixed S3 manifest without persisting its credentials', async () => {
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
    });
    const session = await client.create(
      vercelS3Manifest('bucket', {
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
        sessionToken: 'session-token',
        region: 'us-east-1',
      }),
    );

    const mountCall = runCommandMock.mock.calls.find(([params]) => {
      return isolatedMountCommand(params)?.command === 'mount-s3';
    });
    expect(mountCall?.[0]).toEqual(
      expect.objectContaining({
        cmd: '/usr/bin/env',
        args: expect.arrayContaining([
          '-i',
          'AWS_ACCESS_KEY_ID=access-key',
          'AWS_SECRET_ACCESS_KEY=secret-key',
          'AWS_SESSION_TOKEN=session-token',
          'AWS_REGION=us-east-1',
          'mount-s3',
          'example-bucket',
          '/vercel/sandbox/bucket',
        ]),
        env: {},
        sudo: true,
      }),
    );

    const [storedMount] =
      session.state.manifest.mountTargetsForMaterialization();
    expect(storedMount?.entry).toMatchObject({
      type: 's3_mount',
      bucket: 'example-bucket',
      ephemeral: true,
    });
    expect(storedMount?.entry).not.toHaveProperty('accessKeyId');
    expect(storedMount?.entry).not.toHaveProperty('secretAccessKey');
    expect(storedMount?.entry).not.toHaveProperty('sessionToken');

    const serialized = await client.serializeSessionState(session.state);
    expect(JSON.stringify(serialized)).not.toContain('access-key');
    expect(JSON.stringify(serialized)).not.toContain('secret-key');
    expect(JSON.stringify(serialized)).not.toContain('session-token');
  });

  test('retains an owned mount entry when the caller mutates its manifest', async () => {
    const manifest = new Manifest({
      root: '/vercel/sandbox',
      entries: {
        bucket: s3Mount({
          bucket: 'example-bucket',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    });
    const client = new VercelSandboxClient();
    const session = await client.create(manifest);

    Object.assign(manifest.entries.bucket!, {
      bucket: 'mutated-bucket',
      endpointUrl: 'https://mutated.example.test',
      readOnly: false,
    });
    readFileToBufferMock.mockResolvedValue(
      makeTarArchive([{ name: 'README.md', content: 'persisted' }]),
    );
    runCommandMock.mockClear();

    await session.persistWorkspace();

    const remountCall = runCommandMock.mock.calls.find(([params]) => {
      return isolatedMountCommand(params)?.command === 'mount-s3';
    });
    const remountArgs = isolatedMountCommand(remountCall?.[0] ?? {})?.args;
    expect(remountArgs).toEqual(
      expect.arrayContaining([
        'example-bucket',
        '/vercel/sandbox/bucket',
        '--read-only',
      ]),
    );
    expect(remountArgs).not.toContain('mutated-bucket');
    expect(remountArgs).not.toContain('https://mutated.example.test');
  });

  test('forwards allowlisted configured AWS authentication to mount-s3', async () => {
    const client = new VercelSandboxClient({
      env: {
        AWS_ACCESS_KEY_ID: 'environment-access-key',
        AWS_SECRET_ACCESS_KEY: 'environment-secret-key',
        AWS_SESSION_TOKEN: 'environment-session-token',
        AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/sandbox',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/aws/token',
        UNRELATED_SECRET: 'do-not-forward',
      },
    });

    const session = await client.create(vercelS3Manifest());

    const mountCall = runCommandMock.mock.calls.find(([params]) => {
      return isolatedMountCommand(params)?.command === 'mount-s3';
    });
    expect(mountCall?.[0].args).toEqual(
      expect.arrayContaining([
        'AWS_ACCESS_KEY_ID=environment-access-key',
        'AWS_SECRET_ACCESS_KEY=environment-secret-key',
        'AWS_SESSION_TOKEN=environment-session-token',
        'AWS_ROLE_ARN=arn:aws:iam::123456789012:role/sandbox',
        'AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/aws/token',
      ]),
    );
    expect(mountCall?.[0].args).not.toContain(
      'UNRELATED_SECRET=do-not-forward',
    );

    const serialized = await client.serializeSessionState(session.state);
    expect(serialized.environment).toMatchObject({
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/sandbox',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/aws/token',
      UNRELATED_SECRET: 'do-not-forward',
    });
    expect(JSON.stringify(serialized)).not.toContain('environment-access-key');
    expect(JSON.stringify(serialized)).not.toContain('environment-secret-key');
    expect(JSON.stringify(serialized)).not.toContain(
      'environment-session-token',
    );
    expect(session.state.environment).toMatchObject({
      AWS_ACCESS_KEY_ID: 'environment-access-key',
      AWS_SECRET_ACCESS_KEY: 'environment-secret-key',
      AWS_SESSION_TOKEN: 'environment-session-token',
    });
  });

  test('does not persist manifest-sourced AWS credentials for mounted sessions', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          bucket: s3Mount({
            bucket: 'example-bucket',
            mountStrategy: new VercelCloudBucketMountStrategy(),
          }),
        },
        environment: {
          AWS_ACCESS_KEY_ID: 'manifest-access-key',
          AWS_SECRET_ACCESS_KEY: 'manifest-secret-key',
          AWS_SESSION_TOKEN: 'manifest-session-token',
          AWS_REGION: 'us-east-1',
          UNRELATED_ENV: 'keep-me',
        },
      }),
    );

    const providerState = await client.serializeSessionState(session.state);
    const envelopeManifest = serializeManifestRecord(session.state.manifest);
    const serialized = JSON.stringify({
      manifest: envelopeManifest,
      providerState,
    });

    expect(serialized).not.toContain('manifest-access-key');
    expect(serialized).not.toContain('manifest-secret-key');
    expect(serialized).not.toContain('manifest-session-token');
    expect(envelopeManifest.environment).toMatchObject({
      AWS_REGION: { value: 'us-east-1' },
      UNRELATED_ENV: { value: 'keep-me' },
    });
    expect(session.state.environment).toMatchObject({
      AWS_ACCESS_KEY_ID: 'manifest-access-key',
      AWS_SECRET_ACCESS_KEY: 'manifest-secret-key',
      AWS_SESSION_TOKEN: 'manifest-session-token',
    });
  });

  test('does not combine inline static keys with an inherited session token', async () => {
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
      env: {
        AWS_ACCESS_KEY_ID: 'environment-access-key',
        AWS_SECRET_ACCESS_KEY: 'environment-secret-key',
        AWS_SESSION_TOKEN: 'environment-session-token',
      },
    });

    await client.create(
      vercelS3Manifest('bucket', {
        accessKeyId: 'inline-access-key',
        secretAccessKey: 'inline-secret-key',
      }),
    );

    const mountCall = runCommandMock.mock.calls.find(([params]) => {
      return isolatedMountCommand(params)?.command === 'mount-s3';
    });
    expect(mountCall?.[0].args).toEqual(
      expect.arrayContaining([
        'AWS_ACCESS_KEY_ID=inline-access-key',
        'AWS_SECRET_ACCESS_KEY=inline-secret-key',
      ]),
    );
    expect(mountCall?.[0].args).not.toContain(
      'AWS_SESSION_TOKEN=environment-session-token',
    );
  });

  test('uses an inline session token with inline temporary keys', async () => {
    const client = new VercelSandboxClient({
      allowS3CredentialExposure: true,
      env: {
        AWS_ACCESS_KEY_ID: 'environment-access-key',
        AWS_SECRET_ACCESS_KEY: 'environment-secret-key',
        AWS_SESSION_TOKEN: 'environment-session-token',
      },
    });

    await client.create(
      vercelS3Manifest('bucket', {
        accessKeyId: 'inline-access-key',
        secretAccessKey: 'inline-secret-key',
        sessionToken: 'inline-session-token',
      }),
    );

    const mountCall = runCommandMock.mock.calls.find(([params]) => {
      return isolatedMountCommand(params)?.command === 'mount-s3';
    });
    expect(mountCall?.[0].args).toEqual(
      expect.arrayContaining([
        'AWS_ACCESS_KEY_ID=inline-access-key',
        'AWS_SECRET_ACCESS_KEY=inline-secret-key',
        'AWS_SESSION_TOKEN=inline-session-token',
      ]),
    );
    expect(mountCall?.[0].args).not.toContain(
      'AWS_SESSION_TOKEN=environment-session-token',
    );
  });

  test('rejects unsupported and overlapping mount topology before provisioning', async () => {
    const unsupported = vercelS3Manifest('bucket', {
      mountStrategy: { type: 'other' },
    });
    const overlapping = new Manifest({
      entries: {
        parent: s3Mount({
          bucket: 'parent',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
        child: s3Mount({
          bucket: 'child',
          mountPath: 'parent/child',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    });
    const client = new VercelSandboxClient();

    await expect(client.create(unsupported)).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
    await expect(client.create(overlapping)).rejects.toBeInstanceOf(
      SandboxMountError,
    );
    await expect(
      client.create(vercelS3Manifest('bucket', { mountPath: '/workspace' })),
    ).rejects.toBeInstanceOf(SandboxMountError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects mount paths that resolve through symlinks', async () => {
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        const command = params.args?.[1] ?? '';
        if (
          resolvedRemotePathFromValidationCommand(command) ===
          '/vercel/sandbox/bucket'
        ) {
          return commandResult(0, '/tmp/redirected-bucket\n');
        }
        return await defaultRunCommand(params);
      },
    );
    const client = new VercelSandboxClient();

    await expect(client.create(vercelS3Manifest())).rejects.toBeInstanceOf(
      SandboxMountError,
    );
    expect(stopMock).toHaveBeenCalledOnce();
    expect(
      runCommandMock.mock.calls.some(
        ([params]) => isolatedMountCommand(params)?.command === 'mount-s3',
      ),
    ).toBe(false);
  });

  test('rolls back partial initial mounts before stopping the sandbox', async () => {
    const events: string[] = [];
    let mountCount = 0;
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        const isolated = isolatedMountCommand(params);
        if (isolated?.command === 'mount-s3') {
          mountCount += 1;
          events.push(`mount-${mountCount}`);
          if (mountCount === 2) {
            return commandResult(1, '', 'second mount failed');
          }
        } else if (isolated?.command === 'umount') {
          events.push('umount');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockImplementation(async () => {
      events.push('stop');
    });
    const manifest = new Manifest({
      entries: {
        first: s3Mount({
          bucket: 'first',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
        second: s3Mount({
          bucket: 'second',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    });

    await expect(
      new VercelSandboxClient().create(manifest),
    ).rejects.toBeInstanceOf(SandboxMountError);

    expect(events).toEqual(['mount-1', 'mount-2', 'umount', 'stop']);
    expect(mountedPaths.size).toBe(0);
  });

  test('rolls back an initial mount when output collection fails', async () => {
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        const isolated = isolatedMountCommand(params);
        if (isolated?.command !== 'mount-s3') {
          return await defaultRunCommand(params);
        }
        mountedPaths.add(isolated.args[1]!);
        const result = commandResult(0);
        result.output.mockImplementation(
          async (stream?: 'stdout' | 'stderr' | 'both') => {
            if (stream === 'stdout') {
              throw new Error('output timed out');
            }
            return '';
          },
        );
        return result;
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(
      new VercelSandboxClient().create(vercelS3Manifest()),
    ).rejects.toThrow(/failed to mount the S3 bucket.*Stop error: stop failed/);

    expect(mountedPaths.size).toBe(0);
    expect(
      runCommandMock.mock.calls.some(
        ([params]) => isolatedMountCommand(params)?.command === 'umount',
      ),
    ).toBe(true);
  });

  test('reconciles a timed-out mount command before rolling it back', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
    );
    let mountCommand: ReturnType<typeof commandResult> | undefined;
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        const isolated = isolatedMountCommand(params);
        if (isolated?.command !== 'mount-s3') {
          return await defaultRunCommand(params);
        }
        const result = commandResult(137);
        result.wait.mockImplementation(
          async (options?: { signal?: AbortSignal }) => {
            options?.signal?.throwIfAborted();
            mountedPaths.add(isolated.args[1]!);
            return result;
          },
        );
        mountCommand = result;
        return result;
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(
      new VercelSandboxClient().create(vercelS3Manifest()),
    ).rejects.toThrow(/failed to mount the S3 bucket.*Stop error: stop failed/);

    expect(mountCommand?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mountCommand?.wait).toHaveBeenCalledTimes(2);
    expect(mountedPaths.size).toBe(0);
    expect(
      runCommandMock.mock.calls.some(
        ([params]) => isolatedMountCommand(params)?.command === 'umount',
      ),
    ).toBe(true);
  });

  test('rejects dynamic manifest mutation after mounting', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(vercelS3Manifest());

    await expect(
      session.materializeEntry({
        path: 'new.txt',
        entry: { type: 'file', content: 'new' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    await expect(session.applyManifest(new Manifest())).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
  });

  test('rejects resume for serialized state that contains mounts', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(vercelS3Manifest());

    await expect(client.resume(session.state)).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  test('uses tar persistence and restores mounts around the archive operation', async () => {
    const archive = makeTarArchive([
      { name: 'README.md', content: 'persisted' },
    ]);
    readFileToBufferMock.mockResolvedValue(archive);
    const client = new VercelSandboxClient({
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(vercelS3Manifest());
    const callOffset = runCommandMock.mock.calls.length;

    await expect(session.persistWorkspace()).resolves.toEqual(archive);

    const calls = runCommandMock.mock.calls.slice(callOffset);
    const commandNames = calls.map(([params]) => {
      const isolated = isolatedMountCommand(params);
      if (isolated) {
        return isolated.command;
      }
      return params.args?.[1]?.includes('tar ') ? 'tar' : 'other';
    });
    expect(commandNames.indexOf('umount')).toBeGreaterThan(
      commandNames.indexOf('findmnt'),
    );
    expect(commandNames.indexOf('tar')).toBeGreaterThan(
      commandNames.indexOf('umount'),
    );
    expect(commandNames.lastIndexOf('mount-s3')).toBeGreaterThan(
      commandNames.indexOf('tar'),
    );
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  test('serializes mount-detaching persistence and session I/O', async () => {
    const archive = makeTarArchive([
      { name: 'README.md', content: 'persisted' },
    ]);
    readFileToBufferMock.mockResolvedValue(archive);
    const firstTarStarted = deferred();
    const releaseFirstTar = deferred();
    let blockedFirstTar = false;
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        const command = params.args?.[1] ?? '';
        if (
          !blockedFirstTar &&
          command.includes('tar ') &&
          command.includes(' -cf ')
        ) {
          blockedFirstTar = true;
          firstTarStarted.resolve();
          await releaseFirstTar.promise;
        }
        return await defaultRunCommand(params);
      },
    );
    const session = await new VercelSandboxClient().create(vercelS3Manifest());
    const callOffset = runCommandMock.mock.calls.length;

    const firstPersist = session.persistWorkspace();
    await firstTarStarted.promise;
    const secondPersist = session.persistWorkspace();
    const exec = session.execCommand({ cmd: 'printf ready' });
    await Promise.resolve();

    expect(
      runCommandMock.mock.calls
        .slice(callOffset)
        .some(([params]) => params.args?.[1] === 'printf ready'),
    ).toBe(false);

    releaseFirstTar.resolve();
    await expect(
      Promise.all([firstPersist, secondPersist, exec]),
    ).resolves.toEqual([archive, archive, expect.any(String)]);
    expect(
      runCommandMock.mock.calls
        .slice(callOffset)
        .some(([params]) => params.args?.[1] === 'printf ready'),
    ).toBe(true);

    const transitionCommands = runCommandMock.mock.calls
      .slice(callOffset)
      .map(([params]) => isolatedMountCommand(params)?.command)
      .filter((command) => command === 'umount' || command === 'mount-s3');
    expect(transitionCommands).toEqual([
      'umount',
      'mount-s3',
      'umount',
      'mount-s3',
    ]);
  });

  test('rejects hydrate archives that overlap mounts before detaching them', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(vercelS3Manifest());
    const callOffset = runCommandMock.mock.calls.length;

    await expect(
      session.hydrateWorkspace(
        makeTarArchive([{ name: 'bucket/file.txt', content: 'overwrite' }]),
      ),
    ).rejects.toBeInstanceOf(SandboxArchiveError);

    expect(
      runCommandMock.mock.calls
        .slice(callOffset)
        .some(([params]) => isolatedMountCommand(params)?.command === 'umount'),
    ).toBe(false);
  });

  test('rejects non-writable mount ancestors before detaching them', async () => {
    const session = await new VercelSandboxClient().create(
      vercelS3Manifest('cache/bucket'),
    );
    const callOffset = runCommandMock.mock.calls.length;

    await expect(
      session.hydrateWorkspace(
        makeTarArchive([{ name: 'cache', type: '5', mode: 0o555 }]),
      ),
    ).rejects.toThrow(/archive directory blocks protected path/);

    expect(
      runCommandMock.mock.calls
        .slice(callOffset)
        .some(([params]) => isolatedMountCommand(params)?.command === 'umount'),
    ).toBe(false);
  });

  test('honors null archive limit overrides while mounts are active', async () => {
    const archive = makeTarArchive([
      { name: 'README.md', content: 'larger than one byte' },
    ]);
    const client = new VercelSandboxClient();
    const session = await client.create(vercelS3Manifest(), {
      archiveLimits: {
        maxInputBytes: null,
        maxExtractedBytes: 1,
        maxMembers: null,
      },
    });

    await expect(session.hydrateWorkspace(archive)).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );
    const callOffset = runCommandMock.mock.calls.length;

    await expect(
      session.hydrateWorkspace(archive, { archiveLimits: null }),
    ).resolves.toBeUndefined();

    const transitionCommands = runCommandMock.mock.calls
      .slice(callOffset)
      .map(([params]) => isolatedMountCommand(params)?.command)
      .filter((command) => command === 'umount' || command === 'mount-s3');
    expect(transitionCommands).toEqual(['umount', 'mount-s3']);
  });

  test('stops the sandbox when a detached mount cannot be restored', async () => {
    const archive = makeTarArchive([
      { name: 'README.md', content: 'persisted' },
    ]);
    readFileToBufferMock.mockResolvedValue(archive);
    const client = new VercelSandboxClient();
    const session = await client.create(vercelS3Manifest());
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        if (isolatedMountCommand(params)?.command === 'mount-s3') {
          return commandResult(1, '', 'mount failed');
        }
        return await defaultRunCommand(params);
      },
    );

    await expect(session.persistWorkspace()).rejects.toBeInstanceOf(
      SandboxLifecycleError,
    );
    expect(stopMock).toHaveBeenCalledOnce();
    await expect(session.close()).resolves.toBeUndefined();
  });

  test('unmounts active S3 buckets before stopping the sandbox', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(vercelS3Manifest());
    const callOffset = runCommandMock.mock.calls.length;

    await session.close();

    const closeCommands = runCommandMock.mock.calls
      .slice(callOffset)
      .map(([params]) => isolatedMountCommand(params)?.command);
    expect(closeCommands).toContain('findmnt');
    expect(closeCommands).toContain('umount');
    expect(mountedPaths.has('/vercel/sandbox/bucket')).toBe(false);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('continues unmounting after an individual cleanup failure', async () => {
    const manifest = new Manifest({
      entries: {
        first: s3Mount({
          bucket: 'first',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
        second: s3Mount({
          bucket: 'second',
          mountStrategy: new VercelCloudBucketMountStrategy(),
        }),
      },
    });
    const session = await new VercelSandboxClient().create(manifest);
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        const isolated = isolatedMountCommand(params);
        if (
          isolated?.command === 'umount' &&
          isolated.args[0] === '/vercel/sandbox/second'
        ) {
          return commandResult(1, '', 'unmount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(session.close()).rejects.toThrow(
      /failed to unmount one or more S3 buckets.*Stop error: stop failed/,
    );

    expect(mountedPaths.has('/vercel/sandbox/first')).toBe(false);
    expect(mountedPaths.has('/vercel/sandbox/second')).toBe(true);
  });

  test('keeps a failed mounted close retryable and blocks session I/O', async () => {
    const session = await new VercelSandboxClient().create(vercelS3Manifest());
    stopMock
      .mockRejectedValueOnce(new Error('temporary stop failure'))
      .mockResolvedValueOnce(undefined);

    await expect(session.close()).rejects.toThrow(/temporary stop failure/);
    await expect(
      session.execCommand({ cmd: 'printf unsafe' }),
    ).rejects.toBeInstanceOf(SandboxLifecycleError);

    await expect(session.close()).resolves.toBeUndefined();
    expect(stopMock).toHaveBeenCalledTimes(2);
    expect(mountedPaths.size).toBe(0);
  });

  test('keeps cleanup retryable when a failed remount cannot stop the sandbox', async () => {
    const archive = makeTarArchive([
      { name: 'README.md', content: 'persisted' },
    ]);
    readFileToBufferMock.mockResolvedValue(archive);
    const session = await new VercelSandboxClient().create(vercelS3Manifest());
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        if (isolatedMountCommand(params)?.command === 'mount-s3') {
          return commandResult(1, '', 'mount failed');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock
      .mockRejectedValueOnce(new Error('temporary stop failure'))
      .mockResolvedValueOnce(undefined);

    await expect(session.persistWorkspace()).rejects.toThrow(
      /could not stop the sandbox/,
    );
    await expect(
      session.execCommand({ cmd: 'printf unsafe' }),
    ).rejects.toBeInstanceOf(SandboxLifecycleError);

    await expect(session.close()).resolves.toBeUndefined();
    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  test('reports operation, remount, and stop errors together', async () => {
    const session = await new VercelSandboxClient().create(vercelS3Manifest());
    runCommandMock.mockImplementation(
      async (params: MockRunCommandParams = {}) => {
        if (isolatedMountCommand(params)?.command === 'mount-s3') {
          return commandResult(1, '', 'mount failed');
        }
        if (params.args?.[1]?.includes(' -cf ')) {
          return commandResult(1, '', 'archive failed');
        }
        return await defaultRunCommand(params);
      },
    );
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(session.persistWorkspace()).rejects.toThrow(
      /Preceding error: VercelSandboxClient failed to create a workspace tar archive.*Transition error: VercelSandboxClient failed to mount the S3 bucket.*Stop error: stop failed/,
    );
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
    const replacementRunCommandMock = vi.fn(async () => ({
      exitCode: 0,
      output: vi.fn().mockResolvedValue('replacement\n'),
    }));
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
    const recoveredRunCommandMock = vi.fn(async () => ({
      exitCode: 0,
      output: vi.fn().mockResolvedValue('recovered\n'),
    }));
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

  test('does not reuse preserved snapshot sessions as live handles', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await client.serializeSessionState(session.state);

    expect(client.canReusePreservedOwnedSession(session.state)).toBe(false);
  });

  test('reuses mounted sessions as live handles for in-process preservation', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(vercelS3Manifest(), {
      workspacePersistence: 'snapshot',
    });

    expect(client.canReusePreservedOwnedSession(session.state)).toBe(true);
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
