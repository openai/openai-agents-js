import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxProcessResult } from '../../src/sandbox/sandboxes/shared/runProcess';

const processMocks = vi.hoisted(() => ({
  runSandboxProcess: vi.fn(),
}));

vi.mock('../../src/sandbox/sandboxes/shared/runProcess', () => ({
  runSandboxProcess: processMocks.runSandboxProcess,
  formatSandboxProcessError: (result: SandboxProcessResult) =>
    result.stderr || result.stdout || result.error?.message || 'process failed',
}));

import {
  dockerVolumeMountStrategy,
  DockerSandboxClient,
  Manifest,
  NoopSnapshotSpec,
} from '../../src/sandbox/local';

const success = (stdout = ''): SandboxProcessResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
});

const failure = (stderr: string): SandboxProcessResult => ({
  status: 1,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false,
});

describe('DockerSandboxClient unit behavior', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-core-docker-unit-test-'));
    processMocks.runSandboxProcess.mockReset();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('creates container state from materialized manifest data', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'port') {
          return success('127.0.0.1:49153\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      image: 'custom:image',
      exposedPorts: [3000],
    });
    const expectedDefaultUser =
      typeof process.getuid === 'function' &&
      typeof process.getgid === 'function'
        ? `${process.getuid()}:${process.getgid()}`
        : undefined;

    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'hello docker\n',
          },
        },
        environment: {
          TOKEN: 'value',
        },
      }),
    );

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    expect(session.state).toMatchObject({
      containerId: 'container-123',
      image: 'custom:image',
      workspaceRootOwned: true,
      environment: {
        TOKEN: 'value',
      },
    });
    if (expectedDefaultUser) {
      expect(session.state.defaultUser).toBe(expectedDefaultUser);
    }
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        'run',
        '-d',
        '-e',
        'TOKEN=value',
        '-p',
        '127.0.0.1::3000',
        'custom:image',
      ]),
    );
    const imageArgIndex = runCall?.[1].indexOf('custom:image') ?? -1;
    expect(runCall?.[1].slice(imageArgIndex + 1, imageArgIndex + 3)).toEqual([
      '/bin/sh',
      '-c',
    ]);
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `${session.state.workspaceRootPath}:/workspace`,
        ),
      ]),
    );
    if (expectedDefaultUser) {
      expect(runCall?.[1]).toEqual(
        expect.arrayContaining(['--user', expectedDefaultUser]),
      );
    }
    await expect(
      stat(join(session.state.workspaceRootPath, 'notes.txt')),
    ).resolves.toBeTruthy();
    await expect(session.resolveExposedPort(3000)).resolves.toMatchObject({
      host: '127.0.0.1',
      port: 49153,
      tls: false,
    });
    await expect(session.resolveExposedPort(3001)).rejects.toThrow(
      /was not configured to expose port 3001/,
    );

    await session.close();

    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-123'],
      { timeoutMs: 30_000 },
    );
    await expect(stat(session.state.workspaceRootPath)).rejects.toThrow();
  });

  it('passes bind and Docker volume mounts to container creation', async () => {
    const hostDataDir = await mkdtemp(join(rootDir, 'host-data-'));
    const gcsCredentials =
      '{"client_email":"svc@example.com","private_key":"line=one,two"}';
    const boxConfigCredentials =
      '{"boxAppSettings":{"clientID":"id,with,comma","clientSecret":"secret=value"}}';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        if (args[0] === 'volume') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(
      new Manifest({
        entries: {
          host: {
            type: 'mount',
            source: hostDataDir,
            mountPath: 'mounted/host',
            mountStrategy: { type: 'local_bind' },
          },
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            prefix: 'runs',
            region: 'us-east-1',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({
              driver: 'rclone',
              driverOptions: {
                poll_interval: '0',
              },
            }),
          },
          r2logs: {
            type: 'r2_mount',
            bucket: 'r2-logs',
            prefix: '/2026/04/',
            accountId: 'account-id',
            mountStrategy: dockerVolumeMountStrategy({
              driver: 'rclone',
            }),
          },
          boxdocs: {
            type: 'box_mount',
            path: '/Shared/Docs',
            boxSubType: 'enterprise',
            rootFolderId: 'root-id',
            accessToken: 'box-access-token',
            token: 'box-token',
            configCredentials: boxConfigCredentials,
            mountPath: '/mnt/box',
            mountStrategy: dockerVolumeMountStrategy({
              driver: 'rclone',
              driverOptions: {
                vfs_cache_mode: 'writes',
              },
            }),
          },
          gcsdocs: {
            type: 'gcs_mount',
            bucket: 'gcs-logs',
            serviceAccountCredentials: gcsCredentials,
            mountPath: '/mnt/gcs',
            mountStrategy: dockerVolumeMountStrategy({
              driver: 'rclone',
            }),
          },
        },
      }),
    );

    await expect(session.pathExists('r2logs/app.log')).rejects.toThrow(
      /Docker volume mount path/,
    );
    await expect(session.readFile({ path: 'r2logs/app.log' })).rejects.toThrow(
      /Docker volume mount path/,
    );
    await expect(
      session.createEditor().createFile({
        type: 'create_file',
        path: 'r2logs/app.log',
        diff: '+hidden\n',
      }),
    ).rejects.toThrow(/Docker volume mount path/);

    await session.close();

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    const runArgs: string[] = runCall?.[1] ?? [];
    expect(runArgs).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${hostDataDir},target=/workspace/mounted/host,readonly`,
      ]),
    );
    expect(
      runArgs.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('type=volume') &&
          arg.includes('target=/mnt/logs') &&
          arg.includes('volume-driver=rclone') &&
          arg.includes('volume-opt=type=s3') &&
          arg.includes('volume-opt=path=agent-logs/runs') &&
          arg.includes('volume-opt=s3-region=us-east-1') &&
          arg.includes('volume-opt=poll_interval=0') &&
          arg.includes('readonly'),
      ),
    ).toBe(true);
    expect(
      runArgs.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('type=volume') &&
          arg.includes('target=/workspace/r2logs') &&
          arg.includes('volume-driver=rclone') &&
          arg.includes('volume-opt=type=s3') &&
          arg.includes('volume-opt=path=r2-logs/2026/04') &&
          arg.includes('volume-opt=s3-provider=Cloudflare') &&
          arg.includes(
            'volume-opt=s3-endpoint=https://account-id.r2.cloudflarestorage.com',
          ) &&
          arg.includes('readonly'),
      ),
    ).toBe(true);
    expect(
      runArgs.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('type=volume') &&
          arg.includes('target=/mnt/box') &&
          arg.includes('volume-driver=rclone') &&
          arg.includes('volume-opt=type=box') &&
          arg.includes('volume-opt=path=Shared/Docs') &&
          arg.includes('volume-opt=box-access-token=box-access-token') &&
          arg.includes('volume-opt=box-token=box-token') &&
          arg.includes(
            '"volume-opt=box-config-credentials={""boxAppSettings"":{""clientID"":""id,with,comma"",""clientSecret"":""secret=value""}}"',
          ) &&
          arg.includes('volume-opt=box-box-sub-type=enterprise') &&
          arg.includes('volume-opt=box-root-folder-id=root-id') &&
          arg.includes('volume-opt=vfs_cache_mode=writes') &&
          arg.includes('readonly'),
      ),
    ).toBe(true);
    expect(
      runArgs.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('type=volume') &&
          arg.includes('target=/mnt/gcs') &&
          arg.includes('volume-driver=rclone') &&
          arg.includes('volume-opt=type=google cloud storage') &&
          arg.includes('volume-opt=path=gcs-logs') &&
          arg.includes(
            '"volume-opt=gcs-service-account-credentials={""client_email"":""svc@example.com"",""private_key"":""line=one,two""}"',
          ) &&
          arg.includes('readonly'),
      ),
    ).toBe(true);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['volume', 'rm', '-f', expect.stringContaining('logs')],
      { timeoutMs: 10_000 },
    );
  });

  it('hydrates workspace archives with Docker volume mount entries', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        if (args[0] === 'volume') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(
      new Manifest({
        entries: {
          'keep.txt': {
            type: 'file',
            content: 'keep\n',
          },
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            prefix: 'runs',
            mountStrategy: dockerVolumeMountStrategy({
              driver: 'rclone',
            }),
          },
        },
      }),
    );
    const archive = await session.persistWorkspace();
    await writeFile(
      join(session.state.workspaceRootPath, 'keep.txt'),
      'mutated\n',
    );
    await writeFile(
      join(session.state.workspaceRootPath, 'stale.txt'),
      'stale\n',
    );

    await session.hydrateWorkspace(archive);

    await expect(
      readFile(join(session.state.workspaceRootPath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep\n');
    await expect(
      stat(join(session.state.workspaceRootPath, 'stale.txt')),
    ).rejects.toThrow();

    await session.close();
  });

  it('cleans the workspace when Docker container removal fails and retries later', async () => {
    let removeCalls = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'rm') {
          removeCalls += 1;
          return removeCalls === 1 ? failure('rm failed') : success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(new Manifest());
    const workspaceRootPath = session.state.workspaceRootPath;

    await expect(session.close()).rejects.toThrow(
      'Failed to remove Docker sandbox container: rm failed',
    );
    await expect(lstat(workspaceRootPath)).rejects.toThrow();

    await session.close();

    expect(removeCalls).toBe(2);
    await expect(stat(workspaceRootPath)).rejects.toThrow();
  });

  it('treats missing Docker containers as already removed on close', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'rm') {
          return failure('Error: No such container: container-123');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(new Manifest());
    const workspaceRootPath = session.state.workspaceRootPath;

    await session.close();

    await expect(stat(workspaceRootPath)).rejects.toThrow();
  });

  it('rejects filesystem runAs instead of resolving container users on the host', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(new Manifest());

    await expect(session.pathExists('notes.txt', 'node')).rejects.toThrow(
      /does not support runAs for filesystem operations/,
    );
  });

  it('provisions manifest identity metadata inside the container', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'exec') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        users: [{ name: 'sandbox-user' }],
        groups: [
          {
            name: 'sandbox-group',
            users: [{ name: 'sandbox-user' }],
          },
        ],
      }),
    );

    const execCommands = processMocks.runSandboxProcess.mock.calls
      .filter(([, args]) => args[0] === 'exec')
      .map(([, args]) => args.at(-1));
    expect(
      execCommands.some((command) => String(command).includes('groupadd')),
    ).toBe(true);
    expect(
      execCommands.some((command) => String(command).includes('useradd')),
    ).toBe(true);
    expect(
      execCommands.some((command) => String(command).includes('usermod')),
    ).toBe(true);
  });

  it('rejects unsupported manifest entry group metadata before starting docker', async () => {
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            'notes.txt': {
              type: 'file',
              content: 'hello\n',
              group: { name: 'sandbox-group' },
            },
          },
        }),
      ),
    ).rejects.toThrow(/does not support sandbox entry group ownership yet/);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
  });

  it('rejects root manifests before starting docker', async () => {
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          root: '/',
        }),
      ),
    ).rejects.toThrow(/does not support manifest root "\/"/);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
  });

  it('passes extra path grants as Docker bind mounts', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        extraPathGrants: [{ path: rootDir, readOnly: true }],
      }),
    );

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${rootDir},target=${rootDir},readonly`,
      ]),
    );
  });

  it('allows extra path grants during docker manifest application for host filesystem helpers', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    await session.applyManifest(
      new Manifest({
        extraPathGrants: [{ path: rootDir }],
      }),
    );

    await expect(session.pathExists(rootDir)).resolves.toBe(true);
  });

  it('starts a new container when resumed container state is stopped', async () => {
    const workspaceRootPath = await mkdtemp(join(rootDir, 'workspace-'));
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'inspect') {
          return success('false\n');
        }
        if (args[0] === 'run') {
          return success('container-restarted\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      image: 'custom:image',
    });

    const session = await client.resume({
      manifest: new Manifest(),
      workspaceRootPath,
      workspaceRootOwned: false,
      environment: {},
      snapshotSpec: null,
      snapshot: null,
      image: 'custom:image',
      containerId: 'container-stopped',
    });

    expect(session.state.containerId).toBe('container-restarted');
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      [
        'inspect',
        '--type',
        'container',
        '--format',
        '{{.State.Running}}',
        'container-stopped',
      ],
      { timeoutMs: 10_000 },
    );
  });

  it('cleans up superseded local snapshots during serialization', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'hello docker\n',
          },
        },
      }),
    );
    const hostSecretPath = join(rootDir, 'host-secret.txt');
    await writeFile(hostSecretPath, 'host secret\n', 'utf8');
    await symlink(
      hostSecretPath,
      join(session.state.workspaceRootPath, 'link'),
    );

    const firstSerialized = await client.serializeSessionState(session.state);
    const firstSnapshot = firstSerialized.snapshot as {
      type: 'local';
      path: string;
    };
    const secondSerialized = await client.serializeSessionState(session.state);
    const secondSnapshot = secondSerialized.snapshot as {
      type: 'local';
      path: string;
    };

    expect(secondSnapshot.path).not.toBe(firstSnapshot.path);
    await expect(stat(firstSnapshot.path)).rejects.toThrow();
    await expect(
      stat(join(secondSnapshot.path, 'notes.txt')),
    ).resolves.toBeTruthy();
    await expect(lstat(join(secondSnapshot.path, 'link'))).rejects.toThrow();
    await expect(
      readFile(join(secondSnapshot.path, 'link'), 'utf8'),
    ).rejects.toThrow();
  });

  it('does not restore a local snapshot over a drifted live workspace', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'inspect') {
          return success('true\n');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'snapshot\n',
          },
        },
      }),
    );

    const serialized = await client.serializeSessionState(session.state);
    expect(serialized.snapshotFingerprint).toEqual(expect.any(String));
    expect(serialized.snapshotFingerprintVersion).toBe(
      'workspace_tree_sha256_v1',
    );

    await writeFile(
      join(session.state.workspaceRootPath, 'notes.txt'),
      'drifted\n',
      'utf8',
    );

    const restored = await client.resume(
      await client.deserializeSessionState(serialized),
    );

    expect(restored.state.workspaceRootPath).toBe(
      session.state.workspaceRootPath,
    );
    await expect(
      readFile(join(restored.state.workspaceRootPath, 'notes.txt'), 'utf8'),
    ).resolves.toBe('drifted\n');
  });

  it('removes stopped containers and volumes before restarting from an existing workspace', async () => {
    let runCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          return success(`container-${runCount}\n`);
        }
        if (args[0] === 'inspect') {
          return success('false\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        if (args[0] === 'volume') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'snapshot\n',
          },
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({
              driver: 'rclone',
            }),
          },
        },
      }),
    );
    const serialized = await client.serializeSessionState(session.state);
    await writeFile(
      join(session.state.workspaceRootPath, 'notes.txt'),
      'drifted\n',
      'utf8',
    );

    const restored = await client.resume(
      await client.deserializeSessionState(serialized),
    );

    await expect(
      readFile(join(restored.state.workspaceRootPath, 'notes.txt'), 'utf8'),
    ).resolves.toBe('snapshot\n');

    const calls = processMocks.runSandboxProcess.mock.calls;
    const firstRunIndex = calls.findIndex(([, args]) => args[0] === 'run');
    const removeIndex = calls.findIndex(
      ([, args]) => args[0] === 'rm' && args[2] === 'container-1',
    );
    const volumeRemoveIndex = calls.findIndex(
      ([, args]) =>
        args[0] === 'volume' &&
        args[1] === 'rm' &&
        args[2] === '-f' &&
        args[3] === session.state.dockerVolumeNames?.[0],
    );
    const secondRunIndex = calls.findIndex(
      ([, args], index) => index > firstRunIndex && args[0] === 'run',
    );
    expect(removeIndex).toBeGreaterThan(firstRunIndex);
    expect(volumeRemoveIndex).toBeGreaterThan(removeIndex);
    expect(secondRunIndex).toBeGreaterThan(volumeRemoveIndex);
  });

  it('removes a running container before restoring a missing workspace', async () => {
    let runCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          return success(`container-${runCount}\n`);
        }
        if (args[0] === 'inspect') {
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'snapshot\n',
          },
        },
      }),
    );
    const serialized = await client.serializeSessionState(session.state);
    const previousWorkspaceRootPath = session.state.workspaceRootPath;

    await rm(previousWorkspaceRootPath, { recursive: true, force: true });

    const restored = await client.resume(
      await client.deserializeSessionState(serialized),
    );

    expect(restored.state.containerId).toBe('container-2');
    expect(restored.state.workspaceRootPath).not.toBe(
      previousWorkspaceRootPath,
    );
    await expect(
      readFile(join(restored.state.workspaceRootPath, 'notes.txt'), 'utf8'),
    ).resolves.toBe('snapshot\n');

    const calls = processMocks.runSandboxProcess.mock.calls;
    const runIndexes = calls.flatMap(([, args], index) =>
      args[0] === 'run' ? [index] : [],
    );
    const removeIndex = calls.findIndex(
      ([, args]) => args[0] === 'rm' && args[2] === 'container-1',
    );
    expect(runIndexes).toHaveLength(2);
    expect(removeIndex).toBeGreaterThan(runIndexes[0]!);
    expect(removeIndex).toBeLessThan(runIndexes[1]!);
  });

  it('clears cached exposed ports when restarting a container on resume', async () => {
    let runCount = 0;
    let portCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          return success(`container-${runCount}\n`);
        }
        if (args[0] === 'port') {
          portCount += 1;
          return success(`127.0.0.1:${49152 + portCount}\n`);
        }
        if (args[0] === 'inspect') {
          return success('false\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      exposedPorts: [3000],
      snapshot: new NoopSnapshotSpec(),
    });
    const session = await client.create(new Manifest());

    const initialEndpoint = await session.resolveExposedPort(3000);
    const serialized = await client.serializeSessionState(session.state);
    const resumed = await client.resume(
      await client.deserializeSessionState(serialized),
    );
    const restartedEndpoint = await resumed.resolveExposedPort(3000);

    expect(initialEndpoint.port).toBe(49153);
    expect(resumed.state.containerId).toBe('container-2');
    expect(restartedEndpoint.port).toBe(49154);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['port', 'container-2', '3000/tcp'],
      { timeoutMs: 10_000 },
    );
  });

  it('uses the stable default local snapshot directory when baseDir is omitted', async () => {
    const originalSnapshotDir = process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR;
    const snapshotBaseDir = join(rootDir, 'stable-snapshots');
    process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR = snapshotBaseDir;

    try {
      processMocks.runSandboxProcess.mockImplementation(
        async (_command: string, args: string[]) => {
          if (args[0] === 'version') {
            return success('Docker version test');
          }
          if (args[0] === 'run') {
            return success('container-123\n');
          }
          return failure('unexpected docker command');
        },
      );
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        snapshot: {
          type: 'local',
        },
      });
      const session = await client.create(
        new Manifest({
          entries: {
            'notes.txt': {
              type: 'file',
              content: 'stable\n',
            },
          },
        }),
      );

      const serialized = await client.serializeSessionState(session.state);
      const snapshot = serialized.snapshot as { type: 'local'; path: string };

      expect(snapshot.path.startsWith(`${snapshotBaseDir}/`)).toBe(true);
      await expect(
        readFile(join(snapshot.path, 'notes.txt'), 'utf8'),
      ).resolves.toBe('stable\n');
    } finally {
      if (originalSnapshotDir === undefined) {
        delete process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR;
      } else {
        process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR = originalSnapshotDir;
      }
    }
  });

  it('skips snapshots for noop snapshot specs', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
    });
    const session = await client.create(new Manifest());

    const serialized = await client.serializeSessionState(session.state);

    expect(serialized.snapshotSpec).toEqual({ type: 'noop' });
    expect(serialized.snapshot).toBeNull();
  });

  it('persists live environment values when serializing state', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
    });
    const session = await client.create(
      new Manifest({
        environment: {
          KEEP_ENV: 'manifest-default',
          SECRET_ENV: {
            value: 'secret-default',
            ephemeral: true,
          },
        },
      }),
    );
    session.state.environment.KEEP_ENV = 'runtime-keep';
    session.state.environment.RUNTIME_ENV = 'runtime-only';
    session.state.environment.SECRET_ENV = 'runtime-secret';

    const serialized = await client.serializeSessionState(session.state);
    const deserialized = await client.deserializeSessionState(serialized);

    expect(serialized.environment).toEqual({
      KEEP_ENV: 'runtime-keep',
      RUNTIME_ENV: 'runtime-only',
    });
    expect(deserialized.environment).toEqual({
      KEEP_ENV: 'runtime-keep',
      RUNTIME_ENV: 'runtime-only',
    });
  });

  it('reports Docker availability and container startup failures', async () => {
    processMocks.runSandboxProcess.mockResolvedValueOnce(failure('no docker'));
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(client.create(new Manifest())).rejects.toThrow(
      /requires a working Docker CLI and daemon/,
    );

    processMocks.runSandboxProcess
      .mockResolvedValueOnce(success('Docker version test'))
      .mockResolvedValueOnce(failure('pull failed'));

    await expect(client.create(new Manifest())).rejects.toThrow(
      /Failed to start Docker sandbox container: pull failed/,
    );
  });
});
