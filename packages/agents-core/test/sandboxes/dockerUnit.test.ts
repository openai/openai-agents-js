import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxProcessResult } from '../../src/sandbox/sandboxes/shared/runProcess';

const dockerStdinWrites: Array<string | Uint8Array> = [];
const processMocks = vi.hoisted(() => ({
  runSandboxProcess: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/sandbox/sandboxes/shared/runProcess', () => ({
  runSandboxProcess: processMocks.runSandboxProcess,
  formatSandboxProcessError: (result: SandboxProcessResult) =>
    result.stderr || result.stdout || result.error?.message || 'process failed',
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

import {
  dockerVolumeMountStrategy,
  DockerSandboxClient,
  inContainerMountStrategy,
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

function dockerSpawnResult(args: {
  stdout?: string;
  stderr?: string;
  status?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    write: vi.fn((chunk: string | Uint8Array) => {
      dockerStdinWrites.push(chunk);
    }),
    end: vi.fn(),
  };
  queueMicrotask(() => {
    if (args.stdout) {
      child.stdout.write(args.stdout);
    }
    if (args.stderr) {
      child.stderr.write(args.stderr);
    }
    child.stdout.end();
    child.stderr.end();
    child.emit('close', args.status ?? 0);
  });
  return child;
}

describe('DockerSandboxClient unit behavior', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-core-docker-unit-test-'));
    dockerStdinWrites.length = 0;
    processMocks.runSandboxProcess.mockReset();
    childProcessMocks.spawn.mockReset();
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

  it('starts Docker with fuse privileges and applies in-container command mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      expect(args).toEqual(
        expect.arrayContaining(['exec', '-i', '-w', '/', '-u', 'root']),
      );
      expect(args.join(' ')).toContain('OPENAI_AGENTS_MOUNT_PATH=');
      expect(args.join(' ')).toContain('OPENAI_AGENTS_MOUNT_SOURCE=');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          mounted: {
            type: 'mount',
            source: 'memory://fixture',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                command:
                  'printf mounted > "$OPENAI_AGENTS_MOUNT_PATH/marker.txt"',
              },
            }),
          },
        },
      }),
    );

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--device',
        '/dev/fuse',
        '--cap-add',
        'SYS_ADMIN',
        '--security-opt',
        'apparmor:unconfined',
      ]),
    );
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
  });

  it('routes filesystem reads in in-container mounts through Docker', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      if (command.includes('test -e')) {
        return dockerSpawnResult({ status: 0 });
      }
      if (command.includes('base64 --')) {
        return dockerSpawnResult({
          stdout: Buffer.from('container-data').toString('base64'),
          status: 0,
        });
      }
      if (command.includes('find ')) {
        return dockerSpawnResult({
          stdout: 'f\tfile.txt\nd\tnested\nl\tlink\n',
          status: 0,
        });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(
      new Manifest({
        entries: {
          mounted: {
            type: 'mount',
            source: 'memory://fixture',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                command: 'true',
              },
            }),
          },
        },
      }),
    );

    await expect(session.pathExists('mounted/file.txt')).resolves.toBe(true);
    await expect(
      session.readFile({ path: 'mounted/file.txt' }),
    ).resolves.toEqual(Buffer.from('container-data'));
    await expect(session.listDir({ path: 'mounted' })).resolves.toEqual([
      { name: 'file.txt', path: 'mounted/file.txt', type: 'file' },
      { name: 'nested', path: 'mounted/nested', type: 'dir' },
      { name: 'link', path: 'mounted/link', type: 'other' },
    ]);
    await expect(
      session.createEditor().createFile({
        type: 'create_file',
        path: 'mounted/host-only.txt',
        diff: '+hidden\n',
      }),
    ).rejects.toThrow(/in-container mount path/);

    const filesystemCommands = childProcessMocks.spawn.mock.calls
      .map(([, args]) => (args as string[]).join(' '))
      .filter(
        (command) =>
          command.includes('test -e') ||
          command.includes('base64 --') ||
          command.includes('find '),
      );
    expect(filesystemCommands).toHaveLength(3);
    for (const command of filesystemCommands) {
      expect(command).toContain('exec -i');
      expect(command).toContain('container-123');
    }

    await session.close();
  });

  it('removes the container and workspace when in-container mount application fails during create', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ stderr: 'mount failed', status: 1 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            mounted: {
              type: 'mount',
              source: 'memory://fixture',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  command: 'false',
                },
              }),
            },
          },
        }),
      ),
    ).rejects.toThrow(/mount failed/);

    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-123'],
      { timeoutMs: 30_000 },
    );
    expect(
      (await readdir(rootDir)).filter((name) =>
        name.startsWith('openai-agents-docker-sandbox-'),
      ),
    ).toEqual([]);
  });

  it('applies Azure Blob blobfuse options for Docker in-container mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain('blobfuse2');
      expect(command).toContain('--read-only');
      expect(command).toContain('trap');
      expect(command).toContain('rm -rf');
      expect(command).not.toContain('account-key');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          azure: {
            type: 'azure_blob_mount',
            account: 'account-name',
            container: 'container-name',
            endpointUrl: 'https://blob.example.test',
            accountKey: 'account-key',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                cacheType: 'file_cache',
                cachePath: 'cache/blobfuse',
                cacheSizeMb: 123,
                fileCacheTimeoutSec: 77,
                attrCacheTimeoutSec: 42,
                entryCacheTimeoutSec: 9,
                negativeEntryCacheTimeoutSec: 3,
                logLevel: 'log_warning',
              },
            }),
          },
        },
      }),
    );

    const configInput = dockerStdinWrites.join('\n');
    expect(configInput).toContain('allow-other: true');
    expect(configInput).toContain('- file_cache');
    expect(configInput).toContain('level: log_warning');
    expect(configInput).toContain('entry-expiration-sec: 9');
    expect(configInput).toContain('negative-entry-expiration-sec: 3');
    expect(configInput).toContain('timeout-sec: 42');
    expect(configInput).toContain('path: /workspace/cache/blobfuse');
    expect(configInput).toContain('timeout-sec: 77');
    expect(configInput).toContain('max-size-mb: 123');
    expect(configInput).toContain('account-name: account-name');
    expect(configInput).toContain('container: container-name');
    expect(configInput).toContain('endpoint: https://blob.example.test');
    expect(configInput).toContain('auth-type: key');
    expect(configInput).toContain('account-key: account-key');

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--device',
        '/dev/fuse',
        '--cap-add',
        'SYS_ADMIN',
        '--security-opt',
        'apparmor:unconfined',
      ]),
    );
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
  });

  it('rejects blobfuse cache paths inside the mount path', async () => {
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
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            azure: {
              type: 'azure_blob_mount',
              account: 'account-name',
              container: 'container-name',
              mountPath: 'azure',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  cachePath: 'azure/cache',
                },
              }),
            },
          },
        }),
      ),
    ).rejects.toThrow(/cachePath must be outside the mount path/);
    expect(
      childProcessMocks.spawn.mock.calls.every(([, args]) =>
        (args as string[]).join(' ').includes('fusermount3'),
      ),
    ).toBe(true);
  });

  it('rejects blobfuse cache paths with parent segments', async () => {
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
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            azure: {
              type: 'azure_blob_mount',
              account: 'account-name',
              container: 'container-name',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  cachePath: 'cache/..',
                },
              }),
            },
          },
        }),
      ),
    ).rejects.toThrow(/cachePath must be relative/);
    expect(
      childProcessMocks.spawn.mock.calls.every(([, args]) =>
        (args as string[]).join(' ').includes('fusermount3'),
      ),
    ).toBe(true);
  });

  it('starts Docker with sysadmin privileges and applies S3 Files mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain('mount');
      expect(command).toContain('s3files');
      expect(command).toContain('fs-123:/reports');
      expect(command).toContain('mounttargetip=10.0.0.5');
      expect(command).toContain('accesspoint=ap-123');
      expect(command).toContain('region=us-east-1');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          s3files: {
            type: 's3_files_mount',
            fileSystemId: 'fs-123',
            subpath: '/reports',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 's3files',
                options: {
                  mountTargetIp: '10.0.0.5',
                  accessPoint: 'ap-123',
                  region: 'us-east-1',
                },
              },
            }),
          },
        },
      }),
    );

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--cap-add',
        'SYS_ADMIN',
        '--security-opt',
        'apparmor:unconfined',
      ]),
    );
    expect(runCall?.[1]).not.toContain('/dev/fuse');
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
  });

  it('applies mountpoint options for Docker in-container mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain('mount-s3');
      expect(command).toContain('--prefix');
      expect(command).toContain('reports');
      expect(command).toContain('--region');
      expect(command).toContain('us-west-2');
      expect(command).toContain('--endpoint-url');
      expect(command).toContain('https://s3.example.test');
      expect(command).not.toContain('secret-key');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          s3: {
            type: 's3_mount',
            bucket: 'agent-logs',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'mountpoint',
                options: {
                  prefix: 'reports',
                  region: 'us-west-2',
                  endpointUrl: 'https://s3.example.test',
                },
              },
            }),
          },
        },
      }),
    );

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--device',
        '/dev/fuse',
        '--cap-add',
        'SYS_ADMIN',
        '--security-opt',
        'apparmor:unconfined',
      ]),
    );
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    const envInput = dockerStdinWrites.join('\n');
    expect(envInput).toContain('AWS_ACCESS_KEY_ID');
    expect(envInput).toContain('secret-key');
  });

  it('uses the GCS endpoint default for Docker mountpoint mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain('mount-s3');
      expect(command).toContain('--endpoint-url');
      expect(command).toContain('https://storage.googleapis.com');
      expect(command).toContain('--upload-checksums');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          gcs: {
            type: 'gcs_mount',
            bucket: 'gcs-logs',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'mountpoint',
              },
            }),
          },
        },
      }),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
  });

  it('reads rclone config files and applies remoteName and extraArgs for Docker mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      if (command.includes('base64')) {
        expect(command).toContain('/workspace/rclone.conf');
        return dockerSpawnResult({
          stdout: Buffer.from('[custom]\ncustom_option = true\n').toString(
            'base64',
          ),
          status: 0,
        });
      }
      expect(command).toContain('--allow-other');
      expect(command).toContain('--vfs-cache-mode');
      expect(command).toContain('writes');
      expect(command).toContain('trap');
      expect(command).toContain('rm -rf');
      expect(command).not.toContain('/tmp/openai-agents-docker-custom.conf');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          'rclone.conf': {
            type: 'file',
            content: '[custom]\ncustom_option = true\n',
          },
          s3: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'rclone',
                remoteName: 'custom',
                configFilePath: 'rclone.conf',
                extraArgs: ['--vfs-cache-mode', 'writes'],
              },
            }),
          },
        },
      }),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
    const configInput = dockerStdinWrites.join('\n');
    expect(configInput).toContain('[custom]');
    expect(configInput).toContain('custom_option = true');
    expect(configInput).toContain('provider = AWS');
  });

  it('honors R2 prefixes in Docker in-container rclone mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain('rclone');
      expect(command).toContain('r2remote:r2-logs/2026/04');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(
      new Manifest({
        entries: {
          r2logs: {
            type: 'r2_mount',
            bucket: 'r2-logs',
            prefix: '/2026/04/',
            accountId: 'account-id',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'rclone',
                remoteName: 'r2remote',
              },
            }),
          },
        },
      }),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    await session.close();
  });

  it('rejects rclone config files outside the Docker workspace policy', async () => {
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
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            s3: {
              type: 's3_mount',
              bucket: 'agent-logs',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'rclone',
                  remoteName: 'custom',
                  configFilePath: '/etc/rclone.conf',
                },
              }),
            },
          },
        }),
      ),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  it('builds syntactically valid Docker rclone NFS mount commands', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain('rclone');
      expect(command).toContain('serve');
      expect(command).toContain('nfs');
      expect(command).toContain('& printf %s "$!" >');
      expect(command).toContain('{ mounted=0; for i in 1 2 3; do if');
      expect(command).toContain('openai-agents-rclone-nfs');
      expect(command).not.toContain('pkill -f');
      expect(command).not.toContain('do; if');
      expect(command).not.toContain('& &&');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          s3: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'rclone',
                mode: 'nfs',
              },
            }),
          },
        },
      }),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
  });

  it('applies Azure Blob prefix when building Docker rclone mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain(':container-name/prefix/path');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          azure: {
            type: 'azure_blob_mount',
            accountName: 'account-name',
            container: 'container-name',
            endpoint: 'https://blob.alias.example.test',
            prefix: '/prefix/path/',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'rclone',
              },
            }),
          },
        },
      }),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    const configInput = dockerStdinWrites.join('\n');
    expect(configInput).toContain('type = azureblob');
    expect(configInput).toContain('account = account-name');
    expect(configInput).toContain('endpoint = https://blob.alias.example.test');
  });

  it('passes custom S3 providers through Docker rclone mounts', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          s3: {
            type: 's3_mount',
            bucket: 'agent-logs',
            s3Provider: 'Minio',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'rclone',
              },
            }),
          },
        },
      }),
    );

    const configInput = dockerStdinWrites.join('\n');
    expect(configInput).toContain('type = s3');
    expect(configInput).toContain('provider = Minio');
  });

  it('falls back to native Docker GCS rclone config for partial HMAC credentials', async () => {
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
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      expect(command).toContain('rclone');
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await client.create(
      new Manifest({
        entries: {
          gcs: {
            type: 'gcs_mount',
            bucket: 'gcs-logs',
            accessId: 'gcs-access-id',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'rclone',
              },
            }),
          },
        },
      }),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    const configInput = dockerStdinWrites.join('\n');
    expect(configInput).toContain('type = google cloud storage');
    expect(configInput).toContain('env_auth = true');
    expect(configInput).not.toContain('access_key_id = gcs-access-id');
  });

  it('rejects R2 Docker rclone mounts without accountId even with customDomain', async () => {
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
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            r2: {
              type: 'r2_mount',
              bucket: 'r2-logs',
              customDomain: 'https://r2.example.test',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'rclone',
                },
              }),
            } as any,
          },
        }),
      ),
    ).rejects.toThrow(/accountId/);
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

  it('uses docker exec for filesystem runAs instead of host user lookup', async () => {
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
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ stdout: '', status: 0 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const session = await client.create(new Manifest());

    await expect(session.pathExists('notes.txt', 'node')).resolves.toBe(true);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-i',
        '-w',
        '/',
        '-u',
        'node',
        'container-123',
        '/bin/sh',
        '-lc',
        "test -e '/workspace/notes.txt'",
      ]),
      { stdio: 'pipe' },
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

  it('rejects applying in-container mounts that need missing Docker privileges', async () => {
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

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            s3files: {
              type: 's3_files_mount',
              fileSystemId: 'fs-123',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 's3files',
                },
              }),
            },
          },
        }),
      ),
    ).rejects.toThrow(/requires Docker privileges/);
  });

  it('creates and chowns absolute in-container mount paths before runAs apply', async () => {
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
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          bootstrap: {
            type: 'mount',
            source: 'memory://fixture',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                command: 'true',
              },
            }),
          },
        },
      }),
    );
    childProcessMocks.spawn.mockClear();
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = (args as string[]).join(' ');
      if (command.includes("OPENAI_AGENTS_MOUNT_PATH='/workspace/failed'")) {
        return dockerSpawnResult({ stderr: 'mount failed', status: 1 });
      }
      return dockerSpawnResult({ status: 0 });
    });

    await session.applyManifest(
      new Manifest({
        entries: {
          mounted: {
            type: 'mount',
            source: 'memory://fixture',
            mountPath: '/mnt/absolute',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                command: 'true',
              },
            }),
          },
        },
      }),
      'node',
    );

    const commands = childProcessMocks.spawn.mock.calls.map(([, args]) =>
      (args as string[]).join(' '),
    );
    const mkdirIndex = commands.findIndex((command) =>
      command.includes("mkdir -p -- '/mnt/absolute'"),
    );
    const chownIndex = commands.findIndex((command) =>
      command.includes("chown -R 'node':'node' -- '/mnt/absolute'"),
    );
    const mountIndex = commands.findIndex((command) =>
      command.includes("OPENAI_AGENTS_MOUNT_PATH='/mnt/absolute'"),
    );
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(chownIndex).toBeGreaterThan(mkdirIndex);
    expect(mountIndex).toBeGreaterThan(chownIndex);
  });

  it('unmounts applied in-container mounts when applyManifest later fails', async () => {
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
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = args.join(' ');
      if (command.includes("OPENAI_AGENTS_MOUNT_PATH='/workspace/second'")) {
        return dockerSpawnResult({ stderr: 'second failed', status: 1 });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          bootstrap: {
            type: 'mount',
            source: 'memory://fixture',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                command: 'true',
              },
            }),
          },
        },
      }),
    );
    childProcessMocks.spawn.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            first: {
              type: 'mount',
              source: 'memory://fixture',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  command: 'true',
                },
              }),
            },
            second: {
              type: 'mount',
              source: 'memory://fixture',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  command: 'false',
                },
              }),
            },
          },
        }),
      ),
    ).rejects.toThrow(/second failed/);

    const commands = childProcessMocks.spawn.mock.calls.map(([, args]) =>
      (args as string[]).join(' '),
    );
    expect(
      commands.some(
        (command) =>
          command.includes("umount -l '/workspace/second'") &&
          command.includes('fusermount3'),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("umount -l '/workspace/first'") &&
          command.includes('fusermount3'),
      ),
    ).toBe(true);
  });

  it('rolls back environment state when applyManifest fails', async () => {
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
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        environment: {
          KEEP: 'old',
        },
        entries: {
          bootstrap: {
            type: 'mount',
            source: 'memory://fixture',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                command: 'true',
              },
            }),
          },
        },
      }),
    );
    childProcessMocks.spawn.mockClear();
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = (args as string[]).join(' ');
      if (command.includes("OPENAI_AGENTS_MOUNT_PATH='/workspace/failed'")) {
        return dockerSpawnResult({ stderr: 'mount failed', status: 1 });
      }
      return dockerSpawnResult({ status: 0 });
    });

    await expect(
      session.applyManifest(
        new Manifest({
          environment: {
            SECRET: {
              value: 'new-secret',
              ephemeral: true,
            },
          },
          entries: {
            failed: {
              type: 'mount',
              source: 'memory://fixture',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  command: 'false',
                },
              }),
            },
          },
        }),
      ),
    ).rejects.toThrow(/mount failed/);

    expect(session.state.environment).toEqual({
      KEEP: 'old',
    });
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

  it('excludes blobfuse cache and config directories from Docker snapshots', async () => {
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
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
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
          azure: {
            type: 'azure_blob_mount',
            account: 'account-name',
            container: 'container-name',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                cachePath: 'cache/blobfuse',
              },
            }),
          },
        },
      }),
    );
    await mkdir(
      join(session.state.workspaceRootPath, '.sandbox-blobfuse-config'),
      {
        recursive: true,
      },
    );
    await writeFile(
      join(
        session.state.workspaceRootPath,
        '.sandbox-blobfuse-config',
        'secret.yaml',
      ),
      'account-key: secret\n',
      'utf8',
    );
    await mkdir(
      join(session.state.workspaceRootPath, '.sandbox-blobfuse-cache'),
      {
        recursive: true,
      },
    );
    await writeFile(
      join(session.state.workspaceRootPath, '.sandbox-blobfuse-cache', 'data'),
      'cache\n',
      'utf8',
    );
    await mkdir(join(session.state.workspaceRootPath, 'cache', 'blobfuse'), {
      recursive: true,
    });
    await writeFile(
      join(session.state.workspaceRootPath, 'cache', 'blobfuse', 'data'),
      'custom cache\n',
      'utf8',
    );

    const serialized = await client.serializeSessionState(session.state);
    const snapshot = serialized.snapshot as {
      type: 'local';
      path: string;
    };

    await expect(
      stat(join(snapshot.path, '.sandbox-blobfuse-config')),
    ).rejects.toThrow();
    await expect(
      stat(join(snapshot.path, '.sandbox-blobfuse-cache')),
    ).rejects.toThrow();
    await expect(
      stat(join(snapshot.path, 'cache', 'blobfuse')),
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
