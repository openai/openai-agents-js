import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserError } from '../../src/errors';
import type { SandboxProcessResult } from '../../src/sandbox/sandboxes/shared/runProcess';
import { rebindPersistedPathGrants } from '../../src/sandbox/sandboxes/shared/manifestPersistence';
import {
  deserializeSandboxSessionStateEntry,
  toSessionStateEnvelope,
} from '../../src/sandbox/runtime/sessionState';
import { cleanupSandboxSession } from '../../src/sandbox/runtime/sessionLifecycle';
import {
  bindProcessEnvironmentAccess,
  liveMountCredentialAuthorityMatches,
  markRunStateDeserializationInput,
  rebindPersistedMountCredentials,
  serializeManifestRecord,
} from '../../src/sandbox/internal';

const dockerStdinWrites: Array<string | Uint8Array> = [];
const dockerMountAuthorityFingerprintLabel =
  'openai-agents-sandbox.mount-authority-fingerprint';
const dockerSessionIdentityLabel = 'openai-agents-sandbox.session-identity';
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
  DockerSandboxSession,
  type DockerSandboxSessionState,
  cloneManifest,
  Environment,
  EnvValueReference,
  inContainerMountStrategy,
  Manifest,
  ProcessEnvValue,
  NoopSnapshotSpec,
  registerEnvValueReference,
  SandboxLifecycleError,
  SandboxMountError,
  s3Mount,
  skills,
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

const timedOut = (): SandboxProcessResult => ({
  status: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true,
});

function dockerRunLabels(args: string[]): Record<string, string> {
  return Object.fromEntries(
    args.flatMap((arg, index) => {
      if (arg !== '--label') {
        return [];
      }
      const value = args[index + 1];
      const separatorIndex = value?.indexOf('=') ?? -1;
      return separatorIndex > 0
        ? [[value!.slice(0, separatorIndex), value!.slice(separatorIndex + 1)]]
        : [];
    }),
  );
}

function dockerWorkspaceMount(source: string, target = '/workspace') {
  return [
    {
      Type: 'bind',
      Source: source,
      Destination: target,
      RW: true,
    },
  ];
}

type DockerContainerInspection = {
  labels: Record<string, string>;
  mounts: Array<{
    Type: string;
    Source?: string;
    Name?: string;
    Destination: string;
    RW: boolean;
  }>;
  networkMode: string;
  networks: unknown;
};

function dockerRunInspection(args: string[]): DockerContainerInspection {
  const workspaceMountIndex = args.indexOf('-v');
  const workspaceMount = args[workspaceMountIndex + 1] ?? '';
  const separatorIndex = workspaceMount.indexOf(':');
  const mounts: DockerContainerInspection['mounts'] = dockerWorkspaceMount(
    workspaceMount.slice(0, separatorIndex),
    workspaceMount.slice(separatorIndex + 1),
  );
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '--mount') {
      continue;
    }
    const options = Object.fromEntries(
      (args[index + 1] ?? '').split(',').map((option) => {
        const optionSeparatorIndex = option.indexOf('=');
        return optionSeparatorIndex === -1
          ? [option, true]
          : [
              option.slice(0, optionSeparatorIndex),
              option.slice(optionSeparatorIndex + 1),
            ];
      }),
    );
    if (options.type === 'bind') {
      mounts.push({
        Type: 'bind',
        Source: String(options.source),
        Destination: String(options.target),
        RW: options.readonly !== true,
      });
    } else if (options.type === 'volume') {
      mounts.push({
        Type: 'volume',
        Name: String(options.source),
        Destination: String(options.target),
        RW: options.readonly !== true,
      });
    }
  }
  const networkArgIndex = args.indexOf('--network');
  const networkMode =
    networkArgIndex === -1 ? 'bridge' : (args[networkArgIndex + 1] ?? '');
  return {
    labels: dockerRunLabels(args),
    mounts,
    networkMode,
    networks: networkMode === 'none' ? {} : { [networkMode]: {} },
  };
}

function dockerInspectionResult(
  inspections: Map<string, DockerContainerInspection>,
  args: string[],
): SandboxProcessResult | undefined {
  const inspection = inspections.get(args[5]!);
  if (args[4] === '{{json .Config.Labels}}') {
    return success(JSON.stringify(inspection?.labels ?? {}));
  }
  if (args[4] === '{{json .Mounts}}') {
    return success(JSON.stringify(inspection?.mounts ?? []));
  }
  if (
    args[4] ===
    '{{json .HostConfig.NetworkMode}}\n{{json .NetworkSettings.Networks}}'
  ) {
    return success(
      `${JSON.stringify(inspection?.networkMode ?? '')}\n${JSON.stringify(inspection?.networks ?? null)}\n`,
    );
  }
  if (args[4] === '{{.Id}}') {
    return inspection ? success(`${args[5]}\n`) : failure('No such container');
  }
  return undefined;
}

function dockerSpawnResult(args: {
  stdout?: string;
  stderr?: string;
  status?: number;
  remainActive?: boolean;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    write: vi.fn((chunk: string | Uint8Array) => {
      dockerStdinWrites.push(chunk);
    }),
    end: vi.fn(),
  };
  const close = (status: number | null, signal: NodeJS.Signals | null) => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', status, signal);
  };
  child.kill = vi.fn(() => {
    queueMicrotask(() => {
      close(null, 'SIGTERM');
    });
    return true;
  });
  if (!args.remainActive) {
    queueMicrotask(() => {
      if (args.stdout) {
        child.stdout.write(args.stdout);
      }
      if (args.stderr) {
        child.stderr.write(args.stderr);
      }
      close(args.status ?? 0, null);
    });
  }
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
    delete process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE;
    delete process.env.AGENTS_TEST_DOCKER_ACCESS_SOURCE;
    delete process.env.AGENTS_TEST_DOCKER_SECRET_SOURCE;
    delete process.env.AGENTS_TEST_DOCKER_UNRELATED_SOURCE;
    delete process.env['AGENTS-TEST-DOCKER-SOURCE'];
    await rm(rootDir, { recursive: true, force: true });
  });

  it('rejects replacing active mounts before Docker or filesystem effects', async () => {
    const manifest = new Manifest({
      entries: {
        remote: {
          type: 's3_mount',
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        },
      },
    });
    const session = new DockerSandboxSession({
      state: {
        manifest,
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {},
        containerId: 'container-existing-mount',
        image: 'test:image',
      },
    });

    await expect(
      session.materializeEntry({ path: 'remote', entry: { type: 'dir' } }),
    ).rejects.toThrow(/cannot be removed or replaced.*remote/u);
    await expect(
      session.applyManifest(
        new Manifest({ entries: { remote: { type: 'dir' } } }),
      ),
    ).rejects.toThrow(/cannot be removed or replaced.*remote/u);

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    expect(session.state.manifest.entries.remote?.type).toBe('s3_mount');
    await expect(stat(join(rootDir, 'remote'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
    expect(runCall?.[1]).not.toContain('--network');
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

  it.each(['bridge', 'host', null, 42])(
    'rejects unsupported network mode %j before Docker or filesystem effects',
    async (networkMode) => {
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        networkMode: networkMode as never,
      });

      await expect(client.create(new Manifest())).rejects.toThrow(
        'networkMode must be "none"',
      );

      expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
      await expect(readdir(rootDir)).resolves.toEqual([]);
    },
  );

  it('rejects exposed ports with network isolation before Docker or filesystem effects', async () => {
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      networkMode: 'none',
      exposedPorts: [3000],
    });

    await expect(client.create(new Manifest())).rejects.toThrow(
      'exposedPorts cannot be used when networkMode is "none"',
    );

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    await expect(readdir(rootDir)).resolves.toEqual([]);
  });

  it('creates and persists a network-isolated container', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-isolated\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      networkMode: 'none',
      snapshot: new NoopSnapshotSpec(),
    });

    const session = await client.create(new Manifest(), {
      networkMode: undefined,
    });
    const runArgs = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    )?.[1];

    expect(session.state.networkMode).toBe('none');
    expect(runArgs).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(runArgs?.indexOf('--network')).toBe(
      (runArgs?.indexOf('none') ?? 0) - 1,
    );
    expect(runArgs).not.toContain('-p');

    const serialized = await client.serializeSessionState(session.state);
    expect(serialized.networkMode).toBe('none');
    await expect(
      client.deserializeSessionState(serialized),
    ).resolves.toMatchObject({ networkMode: 'none' });

    const legacy = { ...serialized };
    delete legacy.networkMode;
    await expect(client.deserializeSessionState(legacy)).resolves.toMatchObject(
      { networkMode: undefined },
    );

    const providerCallCount = processMocks.runSandboxProcess.mock.calls.length;
    await expect(
      client.deserializeSessionState({
        ...serialized,
        networkMode: 'bridge',
      }),
    ).rejects.toThrow('networkMode must be "none"');
    await expect(
      client.deserializeSessionState({
        ...serialized,
        configuredExposedPorts: [3000],
      }),
    ).rejects.toThrow('exposedPorts cannot be used when networkMode is "none"');
    expect(processMocks.runSandboxProcess).toHaveBeenCalledTimes(
      providerCallCount,
    );

    await session.close();
  });

  it('passes granted process environment values to Docker without persisting them', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-process-secret';
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-process-env-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
    });
    const clientOptions = {
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    };

    const session = await client.create({
      manifest: new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
      options: clientOptions,
    });
    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    expect(runCall?.[1]).not.toContain('SANDBOX_TOKEN=docker-process-secret');
    session.state.environment.RUNTIME_ENV = 'runtime-only';

    const serialized = await client.serializeSessionState(session.state);
    expect(JSON.stringify(serialized)).not.toContain('docker-process-secret');
    expect(serialized.environment).toEqual({ RUNTIME_ENV: 'runtime-only' });

    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';
    const restored = await client.deserializeSessionState(
      markRunStateDeserializationInput(serialized, { clientOptions }),
    );
    const authenticatedPreviousVolumeName =
      session.state.dockerVolumeNames?.[0];
    expect(authenticatedPreviousVolumeName).toBeDefined();
    restored.dockerVolumeNames = ['forged-unrelated-volume'];
    expect(restored.environment).toEqual({
      RUNTIME_ENV: 'runtime-only',
      SANDBOX_TOKEN: 'rotated-process-secret',
    });
    restored.manifest = new Manifest({
      ...restored.manifest,
      environment: {
        ...restored.manifest.environment,
        MUTATE_RESUME_STATE: async () => {
          restored.manifest = new Manifest();
          return 'mutated';
        },
      },
    });
    const resumed = await client.resume(restored, { clientOptions });
    expect(resumed.state.containerId).toBe('container-process-env-2');
    expect(resumed.state.manifest.environment.SANDBOX_TOKEN).toBeInstanceOf(
      ProcessEnvValue,
    );
    const runCalls = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    );
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]?.[1]).toEqual(
      expect.arrayContaining(['-e', 'RUNTIME_ENV=runtime-only']),
    );
    expect(runCalls[1]?.[1]).not.toContain(
      'SANDBOX_TOKEN=rotated-process-secret',
    );
    expect(resumed.state.environment.RUNTIME_ENV).toBe('runtime-only');
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-process-env-1'],
      { timeoutMs: 30_000 },
    );
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['volume', 'rm', '-f', authenticatedPreviousVolumeName],
      { timeoutMs: 10_000 },
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['volume', 'rm', '-f', 'forged-unrelated-volume'],
      { timeoutMs: 10_000 },
    );
    const replacementStartIndex =
      processMocks.runSandboxProcess.mock.calls.indexOf(runCalls[1]!);
    const previousRemovalIndex =
      processMocks.runSandboxProcess.mock.calls.findIndex(
        ([, args]) =>
          args[0] === 'rm' && args.includes('container-process-env-1'),
      );
    expect(replacementStartIndex).toBeLessThan(previousRemovalIndex);
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
    );
    childProcessMocks.spawn.mockClear();
    dockerStdinWrites.length = 0;
    expect(() => {
      resumed.state.manifest = new Manifest();
    }).toThrow(/cannot remove or replace protected ProcessEnvValue bindings/u);
    const unboundReplacement = cloneManifest(resumed.state.manifest);
    unboundReplacement.environment.EXTRA_TOKEN = new ProcessEnvValue({
      name: 'AGENTS_TEST_EXTRA_PROCESS_SOURCE',
    });
    expect(() => {
      resumed.state.manifest = unboundReplacement;
    }).toThrow(/cannot remove or replace protected ProcessEnvValue bindings/u);
    await resumed.execCommand({ cmd: 'env', yieldTimeMs: 0 });
    expect(JSON.stringify(childProcessMocks.spawn.mock.calls)).not.toContain(
      'rotated-process-secret',
    );
    expect(dockerStdinWrites).toHaveLength(1);
    expect(
      Buffer.from(String(dockerStdinWrites[0]).trim(), 'base64').toString(
        'utf8',
      ),
    ).toContain("export 'SANDBOX_TOKEN=rotated-process-secret'");
    const resumedSerialized = await client.serializeSessionState(resumed.state);
    expect(JSON.stringify(resumedSerialized)).not.toContain(
      'rotated-process-secret',
    );
    expect(resumedSerialized.environment).not.toHaveProperty('SANDBOX_TOKEN');

    const mutatedState = await client.deserializeSessionState(
      markRunStateDeserializationInput(serialized, { clientOptions }),
    );
    mutatedState.manifest.environment.SANDBOX_TOKEN = new Environment(
      'ordinary-value',
    );
    processMocks.runSandboxProcess.mockClear();
    await expect(
      client.resume(mutatedState, { clientOptions }),
    ).rejects.toThrow(
      /bound sandbox manifest contains changed ProcessEnvValue references/u,
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
  });

  it('transports only selected protected mount environment through stdin', async () => {
    process.env.AGENTS_TEST_DOCKER_ACCESS_SOURCE = 'protected-access-key';
    process.env.AGENTS_TEST_DOCKER_SECRET_SOURCE = 'protected-secret-key';
    process.env.AGENTS_TEST_DOCKER_UNRELATED_SOURCE =
      'unrelated-protected-secret';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-protected-mount\n');
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
      processEnvironmentBindings: {
        AWS_ACCESS_KEY_ID: 'AGENTS_TEST_DOCKER_ACCESS_SOURCE',
        AWS_SECRET_ACCESS_KEY: 'AGENTS_TEST_DOCKER_SECRET_SOURCE',
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_UNRELATED_SOURCE',
      },
    });
    await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountStrategy: inContainerMountStrategy({
              pattern: { type: 'rclone' },
            }),
          },
        },
        environment: {
          AWS_ACCESS_KEY_ID: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_ACCESS_SOURCE',
          }),
          AWS_SECRET_ACCESS_KEY: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_SECRET_SOURCE',
          }),
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_UNRELATED_SOURCE',
          }),
          HTTPS_PROXY: 'http://proxy.example.test',
        },
      }).withInContainerMountBroadCredentialExposureAcknowledged('logs'),
    );

    const spawnArgs = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toEqual(
      expect.arrayContaining([
        'exec',
        '-i',
        'container-protected-mount',
        '/bin/sh',
        '-s',
      ]),
    );
    expect(JSON.stringify(spawnArgs)).not.toContain('protected-access-key');
    expect(JSON.stringify(spawnArgs)).not.toContain('protected-secret-key');
    expect(JSON.stringify(spawnArgs)).not.toContain(
      'unrelated-protected-secret',
    );
    expect(spawnArgs).toEqual(
      expect.arrayContaining(['-e', 'HTTPS_PROXY=http://proxy.example.test']),
    );
    const stdin = dockerStdinWrites.join('');
    expect(stdin).toContain('protected-access-key');
    expect(stdin).toContain('protected-secret-key');
    expect(stdin).not.toContain('unrelated-protected-secret');
    const runArgs = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    )?.[1];
    expect(JSON.stringify(runArgs)).not.toContain('protected-access-key');
    expect(JSON.stringify(runArgs)).not.toContain('protected-secret-key');
    expect(JSON.stringify(runArgs)).not.toContain('unrelated-protected-secret');
  });

  it('rejects mutated protected bindings before Docker snapshot effects', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-process-secret';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-process-env-mutation\n');
        }
        return success();
      },
    );
    const snapshotBaseDir = join(rootDir, 'mutation-snapshots');
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: { type: 'local', baseDir: snapshotBaseDir },
    });
    const session = await client.create({
      manifest: new Manifest({
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
      options: {
        processEnvironmentBindings: {
          SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
        },
      },
    });
    delete session.state.manifest.environment.SANDBOX_TOKEN;

    await expect(client.serializeSessionState(session.state)).rejects.toThrow(
      /protected ProcessEnvValue references changed after binding/u,
    );
    await expect(readdir(snapshotBaseDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await session.close();
  });

  it('keeps the running Docker container when protected replacement startup fails', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-process-secret';
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 2) {
            return failure('replacement startup failed');
          }
          const containerId = 'container-process-env-original';
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
    });
    const clientOptions = {
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    };
    const session = await client.create({
      manifest: new Manifest({
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
      options: clientOptions,
    });
    const serialized = await client.serializeSessionState(session.state);
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';
    const restored = await client.deserializeSessionState(
      markRunStateDeserializationInput(serialized, { clientOptions }),
    );
    restored.manifest.environment.MUTATING = new Environment({
      value: 'safe',
      resolve: () => {
        delete restored.manifest.environment.SANDBOX_TOKEN;
        return 'safe';
      },
    });

    await expect(client.resume(restored, { clientOptions })).rejects.toThrow(
      /protected process environment values/u,
    );

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-process-env-original'],
      { timeoutMs: 30_000 },
    );
  });

  it('keeps an authenticated stopped container when protected replacement startup fails', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-process-secret';
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 2) {
            return failure('replacement startup failed');
          }
          const containerId = 'container-process-env-stopped';
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (
          args[0] === 'inspect' &&
          args[4] === '{{.State.Running}}' &&
          args[5] === 'container-process-env-stopped'
        ) {
          return success('false\n');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
    );
    session.state.dockerVolumeNames = ['forged-unrelated-volume'];
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';

    await expect(client.resume(session.state)).rejects.toThrow(
      /protected process environment values/u,
    );

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-process-env-stopped'],
      { timeoutMs: 30_000 },
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['volume', 'rm', '-f', 'forged-unrelated-volume'],
      { timeoutMs: 10_000 },
    );
  });

  it('preserves protected creation identifiers when Docker run and cleanup fail', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'protected-run-secret';
    let candidateName: string | undefined;
    let candidateVolumeName: string | undefined;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          candidateName = args[args.indexOf('--name') + 1];
          candidateVolumeName = dockerRunInspection(args).mounts.find(
            (mount) => mount.Type === 'volume',
          )?.Name;
          return failure('docker run echoed protected-run-secret');
        }
        if (args[0] === 'rm' && args[2] === candidateName) {
          return failure('container cleanup echoed protected-run-secret');
        }
        if (
          args[0] === 'volume' &&
          args[1] === 'rm' &&
          args[3] === candidateVolumeName
        ) {
          return failure('volume cleanup echoed protected-run-secret');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });

    const error = await client
      .create(
        new Manifest({
          entries: {
            logs: {
              type: 's3_mount',
              bucket: 'agent-logs',
              mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
            },
          },
          environment: {
            SANDBOX_TOKEN: new ProcessEnvValue({
              name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
            }),
          },
        }),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(candidateName).toBeDefined();
    expect(candidateVolumeName).toBeDefined();
    expect(error).toBeInstanceOf(SandboxLifecycleError);
    expect(String(error)).not.toContain('protected-run-secret');
    expect((error as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'sandbox creation',
      replacementContainerId: candidateName,
      replacementDockerVolumeNames: [candidateVolumeName],
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('preserves protected replacement identifiers when Docker run and cleanup fail', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-secret';
    let runCount = 0;
    let candidateName: string | undefined;
    let candidateVolumeName: string | undefined;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 1) {
            inspections.set(
              'protected-run-original',
              dockerRunInspection(args),
            );
            return success('protected-run-original\n');
          }
          candidateName = args[args.indexOf('--name') + 1];
          candidateVolumeName = dockerRunInspection(args).mounts.find(
            (mount) => mount.Type === 'volume',
          )?.Name;
          return failure('docker run echoed rotated-secret');
        }
        if (args[0] === 'rm' && args[2] === candidateName) {
          return failure('container cleanup echoed rotated-secret');
        }
        if (
          args[0] === 'volume' &&
          args[1] === 'rm' &&
          args[3] === candidateVolumeName
        ) {
          return failure('volume cleanup echoed rotated-secret');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
    );
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-secret';

    const error = await client.resume(session.state).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(candidateName).toBeDefined();
    expect(candidateVolumeName).toBeDefined();
    expect(error).toBeInstanceOf(SandboxLifecycleError);
    expect(String(error)).not.toContain('rotated-secret');
    expect((error as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'sandbox resume',
      containerId: 'protected-run-original',
      replacementContainerId: candidateName,
      replacementDockerVolumeNames: [candidateVolumeName],
    });
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'protected-run-original'],
      { timeoutMs: 30_000 },
    );
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('does not clean persisted Docker identifiers when the protected container is missing', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-process-secret';
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-process-env-missing-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (
          args[0] === 'inspect' &&
          args[4] === '{{.State.Running}}' &&
          args[5] === 'container-process-env-missing-1'
        ) {
          return failure('No such container');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
    );
    inspections.delete('container-process-env-missing-1');
    session.state.dockerVolumeNames = ['forged-unrelated-volume'];
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-process-env-missing-2');
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-process-env-missing-1'],
      { timeoutMs: 30_000 },
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['volume', 'rm', '-f', 'forged-unrelated-volume'],
      { timeoutMs: 10_000 },
    );
  });

  it('preserves the Docker replacement after ambiguous previous-container retirement', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-process-secret';
    let runCount = 0;
    let previousRemovalCompleted = false;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-process-env-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'rm' && args.includes('container-process-env-1')) {
          previousRemovalCompleted = true;
          inspections.delete('container-process-env-1');
          return failure('container removal response was lost');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
    });
    const clientOptions = {
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    };
    const session = await client.create({
      manifest: new Manifest({
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
      options: clientOptions,
    });
    const serialized = await client.serializeSessionState(session.state);
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';
    const restored = await client.deserializeSessionState(
      markRunStateDeserializationInput(serialized, { clientOptions }),
    );

    let thrown: unknown;
    try {
      await client.resume(restored, { clientOptions });
    } catch (error) {
      thrown = error;
    }

    expect(previousRemovalCompleted).toBe(true);
    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect((thrown as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'sandbox resume',
      containerId: 'container-process-env-1',
      previousContainerId: 'container-process-env-1',
      previousDockerVolumeNames: [],
      replacementContainerId: 'container-process-env-2',
      replacementDockerVolumeNames: [],
    });
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-process-env-2'],
      { timeoutMs: 30_000 },
    );
  });

  it('preserves the Docker replacement when previous volume retirement fails', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-process-secret';
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-process-env-volume-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (
          args[0] === 'volume' &&
          args[1] === 'rm' &&
          args[3] === previousVolumeName
        ) {
          return failure('volume cleanup echoed initial-process-secret');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
    );
    const previousVolumeName = session.state.dockerVolumeNames?.[0];
    expect(previousVolumeName).toBeDefined();
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    const replacementVolumeName = inspections
      .get('container-process-env-volume-2')
      ?.mounts.find((mount) => mount.Type === 'volume')?.Name;
    expect(replacementVolumeName).toBeDefined();
    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect(String(thrown)).not.toContain('initial-process-secret');
    expect((thrown as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'sandbox resume',
      containerId: 'container-process-env-volume-1',
      previousContainerId: 'container-process-env-volume-1',
      previousDockerVolumeNames: [previousVolumeName],
      replacementContainerId: 'container-process-env-volume-2',
      replacementDockerVolumeNames: [replacementVolumeName],
    });
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-process-env-volume-2'],
      { timeoutMs: 30_000 },
    );
  });

  it('removes a distinct previous owned workspace after protected replacement', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-process-secret';
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-process-env-workspace-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: { type: 'local', baseDir: join(rootDir, 'snapshots') },
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'snapshot.txt': { type: 'file', content: 'snapshot\n' },
        },
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );
    await client.serializeSessionState(session.state);
    const previousWorkspaceRootPath = session.state.workspaceRootPath;
    await writeFile(join(previousWorkspaceRootPath, 'changed.txt'), 'changed');
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';

    const resumed = await client.resume(session.state);

    expect(resumed.state.workspaceRootPath).not.toBe(previousWorkspaceRootPath);
    await expect(stat(previousWorkspaceRootPath)).rejects.toThrow();
    await expect(
      readFile(join(resumed.state.workspaceRootPath, 'snapshot.txt'), 'utf8'),
    ).resolves.toBe('snapshot\n');
  });

  it('preserves a previous owned workspace when protected retirement fails', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-process-secret';
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-process-env-workspace-failure-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (
          args[0] === 'rm' &&
          args.includes('container-process-env-workspace-failure-1')
        ) {
          return failure('retirement failed');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: { type: 'local', baseDir: join(rootDir, 'snapshots') },
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'snapshot.txt': { type: 'file', content: 'snapshot\n' },
        },
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );
    await client.serializeSessionState(session.state);
    const previousWorkspaceRootPath = session.state.workspaceRootPath;
    await writeFile(join(previousWorkspaceRootPath, 'changed.txt'), 'changed');
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-process-secret';

    await expect(client.resume(session.state)).rejects.toThrow(
      /protected process environment values/u,
    );

    await expect(stat(previousWorkspaceRootPath)).resolves.toBeTruthy();
  });

  it('rejects ungranted process environment values before Docker effects', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'unused-secret';
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });

    await expect(
      client.create(
        new Manifest({
          environment: {
            SANDBOX_TOKEN: new ProcessEnvValue({
              name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
            }),
          },
        }),
      ),
    ).rejects.toThrow(/is not granted/u);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
  });

  it.each(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT'])(
    'rejects protected %s before Docker effects',
    async (destination) => {
      process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'unused-secret';
      const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });

      await expect(
        client.create({
          manifest: new Manifest({
            environment: {
              [destination]: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
              }),
            },
          }),
          options: {
            processEnvironmentBindings: {
              [destination]: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
            },
          },
        }),
      ).rejects.toThrow(
        new RegExp(
          `does not support ProcessEnvValue for "${destination}"`,
          'u',
        ),
      );
      expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    },
  );

  it.each([
    'API-TOKEN',
    'A B',
    '9TOKEN',
    'PPID',
    'UID',
    'EUID',
    'SHELLOPTS',
    'IFS',
    'BASH',
    'BASH_EXECUTION_STRING',
    'BASH_VERSION',
    'ZSH_VERSION',
    'KSH_VERSION',
  ])(
    'rejects unsupported protected destination %s before Docker effects',
    async (destination) => {
      process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'unused-secret';
      const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });

      await expect(
        client.create({
          manifest: new Manifest({
            environment: {
              [destination]: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
              }),
            },
          }),
          options: {
            processEnvironmentBindings: {
              [destination]: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
            },
          },
        }),
      ).rejects.toThrow(/assignable POSIX shell identifiers/u);
      expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-POSIX protected destination during trusted resume preparation', () => {
    process.env['AGENTS-TEST-DOCKER-SOURCE'] = 'unused-secret';
    const resolver = vi.fn(async () => 'unresolved');
    const client = new DockerSandboxClient({
      processEnvironmentBindings: {
        API_TOKEN: 'AGENTS-TEST-DOCKER-SOURCE',
      },
    });

    expect(() =>
      client.resolveTrustedManifestForResume(
        new Manifest({
          environment: {
            'API-TOKEN': new ProcessEnvValue({
              name: 'AGENTS-TEST-DOCKER-SOURCE',
            }),
            PROBE: resolver,
          },
        }),
        {
          processEnvironmentBindings: {
            'API-TOKEN': 'AGENTS-TEST-DOCKER-SOURCE',
          },
        },
      ),
    ).toThrow(/assignable POSIX shell identifiers/u);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a serialized non-POSIX protected destination before rehydration', async () => {
    const resolver = vi.fn(async () => 'unresolved');
    class ProbeReference extends EnvValueReference {
      static readonly type = 'test.docker_destination_probe';

      constructor() {
        super();
      }

      override serialize(): Record<string, unknown> {
        return {};
      }

      override async resolve(): Promise<string> {
        return await resolver();
      }
    }

    process.env['AGENTS-TEST-DOCKER-SOURCE'] = 'unused-secret';
    const unregister = registerEnvValueReference(
      ProbeReference,
      () => new ProbeReference(),
    );
    try {
      const client = new DockerSandboxClient({
        processEnvironmentBindings: {
          'API-TOKEN': 'AGENTS-TEST-DOCKER-SOURCE',
        },
      });
      const serialized = {
        manifest: serializeManifestRecord(
          new Manifest({
            environment: {
              'API-TOKEN': new ProcessEnvValue({
                name: 'AGENTS-TEST-DOCKER-SOURCE',
              }),
              PROBE: new ProbeReference(),
            },
          }),
        ),
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {},
        containerId: 'container-invalid-destination-state',
        image: 'test:image',
      };

      await expect(client.deserializeSessionState(serialized)).rejects.toThrow(
        /assignable POSIX shell identifiers/u,
      );
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('rejects a mutated non-POSIX protected destination before live effects', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'unused-secret';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-invalid-destination-mutation\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      processEnvironmentBindings: {
        API_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          API_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
    );
    session.state.manifest.environment['API-TOKEN'] = new ProcessEnvValue({
      name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
    });
    const resolver = vi.fn(async () => 'unresolved');
    processMocks.runSandboxProcess.mockClear();

    await expect(
      session.materializeEntry({
        path: 'materialized.txt',
        entry: { type: 'file', content: 'not written' },
      }),
    ).rejects.toThrow(/assignable POSIX shell identifiers/u);
    await expect(stat(join(rootDir, 'materialized.txt'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            'marker.txt': { type: 'file', content: 'not written' },
          },
          environment: { PROBE: resolver },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxLifecycleError);

    expect(resolver).not.toHaveBeenCalled();
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    await expect(stat(join(rootDir, 'marker.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('redacts Docker startup errors when process environment values are present', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-secret-in-error';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return failure('provider echoed docker-secret-in-error');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });

    let thrown: unknown;
    try {
      await client.create(
        new Manifest({
          environment: {
            AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UserError);
    expect(String(thrown)).not.toContain('docker-secret-in-error');
    expect(String(thrown)).toContain('protected process environment values');
  });

  it('redacts mixed environment resolver errors before Docker effects', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-resolver-secret';
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });

    let thrown: unknown;
    try {
      await client.create(
        new Manifest({
          environment: {
            AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
            FAILING: async () => {
              throw Object.assign(
                new Error('resolver echoed docker-resolver-secret'),
                { cause: new Error('nested docker-resolver-secret') },
              );
            },
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect(String(thrown)).not.toContain('docker-resolver-secret');
    expect(JSON.stringify(thrown)).not.toContain('docker-resolver-secret');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
  });

  it('redacts resolver errors while applying a manifest to a protected Docker session', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-apply-secret';
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          const containerId = 'container-apply-secret';
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );
    processMocks.runSandboxProcess.mockClear();

    let thrown: unknown;
    try {
      await session.applyManifest(
        new Manifest({
          environment: {
            FAILING: async () => {
              throw Object.assign(
                new Error('resolver echoed docker-apply-secret'),
                { cause: new Error('nested docker-apply-secret') },
              );
            },
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect(String(thrown)).not.toContain('docker-apply-secret');
    expect(JSON.stringify(thrown)).not.toContain('docker-apply-secret');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
  });

  it('retains protected destination authority after a successful manifest mutation', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-mutation-secret';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-mutation-authority\n');
        }
        return success();
      },
    );
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );

    await session.applyManifest(
      new Manifest({
        environment: {
          SAFE: async () => {
            delete session.state.manifest.environment
              .AGENTS_TEST_DOCKER_PROCESS_SOURCE;
            return 'safe';
          },
        },
      }),
    );
    await session.pathExists('marker', 'root');
    const serialized = await client.serializeSessionState(session.state);

    expect(
      session.state.manifest.environment.AGENTS_TEST_DOCKER_PROCESS_SOURCE,
    ).toBeInstanceOf(ProcessEnvValue);
    expect(childProcessMocks.spawn).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        '-e',
        'AGENTS_TEST_DOCKER_PROCESS_SOURCE=docker-mutation-secret',
      ]),
      expect.anything(),
    );
    expect(JSON.stringify(serialized)).not.toContain('docker-mutation-secret');
    expect(serialized.environment).not.toHaveProperty(
      'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
    );
  });

  it('rejects replacing a protected Docker environment destination', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-protected-secret';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-protected-delta\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );
    processMocks.runSandboxProcess.mockClear();
    const replacementResolver = vi.fn(async () => 'ordinary');

    await expect(
      session.applyManifest(
        new Manifest({
          environment: {
            AGENTS_TEST_DOCKER_PROCESS_SOURCE: replacementResolver,
          },
        }),
      ),
    ).rejects.toThrow(/protected process environment values/u);

    expect(replacementResolver).not.toHaveBeenCalled();
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    expect(
      session.state.manifest.environment.AGENTS_TEST_DOCKER_PROCESS_SOURCE,
    ).toBeInstanceOf(ProcessEnvValue);
    const serialized = await client.serializeSessionState(session.state);
    const restored = await client.deserializeSessionState(
      markRunStateDeserializationInput(serialized, {
        clientOptions: {
          allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
        },
      }),
    );
    expect(
      restored.manifest.environment.AGENTS_TEST_DOCKER_PROCESS_SOURCE,
    ).toBeInstanceOf(ProcessEnvValue);
  });

  it('rejects importing bound process environment authority into a live Docker session', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-import-secret';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-ordinary-delta\n');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
    });
    const session = await client.create(new Manifest());
    const boundDelta = cloneManifest(
      bindProcessEnvironmentAccess(
        new Manifest({
          environment: {
            IMPORTED_TOKEN: new ProcessEnvValue({
              name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
            }),
          },
        }),
        {
          processEnvironmentBindings: {
            IMPORTED_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          },
        },
      ),
    );
    processMocks.runSandboxProcess.mockClear();

    await expect(session.applyManifest(boundDelta)).rejects.toThrow(
      /protected process environment destinations/u,
    );

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    expect(session.state.manifest.environment).not.toHaveProperty(
      'IMPORTED_TOKEN',
    );
  });

  it('redacts mixed environment resolver errors during Docker resume', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-resume-secret';
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const state: DockerSandboxSessionState = {
      manifest: new Manifest({
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
          FAILING: async () => {
            throw Object.assign(
              new Error('resolver echoed docker-resume-secret'),
              { cause: new Error('nested docker-resume-secret') },
            );
          },
        },
      }),
      workspaceRootPath: rootDir,
      workspaceRootOwned: false,
      environment: {},
      containerId: 'container-resolver-error',
      image: 'test:image',
    };

    let thrown: unknown;
    try {
      await client.resume(state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect(String(thrown)).not.toContain('docker-resume-secret');
    expect(JSON.stringify(thrown)).not.toContain('docker-resume-secret');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
  });

  it('redacts serializable environment reference errors during Docker deserialization', async () => {
    class ThrowingDockerReference extends EnvValueReference {
      static readonly type = 'test.throwing_docker_reference';

      constructor() {
        super();
      }

      override serialize(): Record<string, unknown> {
        return {};
      }

      override async resolve(): Promise<string> {
        throw Object.assign(
          new Error('reference echoed docker-deserialize-secret'),
          { cause: new Error('nested docker-deserialize-secret') },
        );
      }
    }

    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-deserialize-secret';
    const unregister = registerEnvValueReference(
      ThrowingDockerReference,
      () => new ThrowingDockerReference(),
    );
    try {
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
      });
      const serialized = {
        manifest: serializeManifestRecord(
          new Manifest({
            environment: {
              AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
              FAILING: new ThrowingDockerReference(),
            },
          }),
        ),
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {},
        containerId: 'container-deserialize-error',
        image: 'test:image',
      };

      let thrown: unknown;
      try {
        await client.deserializeSessionState(serialized);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SandboxLifecycleError);
      expect(String(thrown)).not.toContain('docker-deserialize-secret');
      expect(JSON.stringify(thrown)).not.toContain('docker-deserialize-secret');
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it('redacts Docker post-start and cleanup errors for process environment values', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-secret-in-error';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-process-env\n');
        }
        if (args[0] === 'exec') {
          return failure('provisioning echoed docker-secret-in-error');
        }
        if (args[0] === 'rm') {
          return failure('cleanup echoed docker-secret-in-error');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });

    let thrown: unknown;
    try {
      await client.create(
        new Manifest({
          environment: {
            AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
          },
          users: [{ name: 'sandbox-user' }],
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect(String(thrown)).not.toContain('docker-secret-in-error');
    expect(JSON.stringify(thrown)).not.toContain('docker-secret-in-error');
    expect((thrown as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'sandbox creation',
      replacementContainerId: 'container-process-env',
      replacementDockerVolumeNames: [],
    });

    let deferredCleanupError: unknown;
    try {
      await client.create(new Manifest());
    } catch (error) {
      deferredCleanupError = error;
    }
    expect(deferredCleanupError).toBeInstanceOf(SandboxLifecycleError);
    expect(String(deferredCleanupError)).not.toContain(
      'docker-secret-in-error',
    );
    expect(JSON.stringify(deferredCleanupError)).not.toContain(
      'docker-secret-in-error',
    );
    expect((deferredCleanupError as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'deferred cleanup',
      containerId: 'container-process-env',
      replacementContainerId: 'container-process-env',
      replacementDockerVolumeNames: [],
    });
  });

  it('retries protected candidate volume cleanup after setup failure', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-cleanup-secret';
    let runCount = 0;
    let volumeRemovalAttempts = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          return success(`container-protected-cleanup-${runCount}\n`);
        }
        if (
          args[0] === 'exec' &&
          args.includes('container-protected-cleanup-1')
        ) {
          return failure('account provisioning failed');
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          volumeRemovalAttempts += 1;
          return volumeRemovalAttempts === 1
            ? failure('volume cleanup echoed docker-cleanup-secret')
            : success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });

    let thrown: unknown;
    try {
      await client.create(
        new Manifest({
          entries: {
            logs: {
              type: 's3_mount',
              bucket: 'agent-logs',
              mountPath: '/mnt/logs',
              mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
            },
          },
          environment: {
            AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
          },
          users: [{ name: 'sandbox-user' }],
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect(String(thrown)).not.toContain('docker-cleanup-secret');
    expect(volumeRemovalAttempts).toBe(1);

    const later = await client.create(new Manifest());
    expect(volumeRemovalAttempts).toBe(2);
    await later.close();
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
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
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

    await expect(session.directoryExists('r2logs')).resolves.toBe(true);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-i',
        '-w',
        '/',
        'container-123',
        '/bin/sh',
        '-lc',
        "test -d '/workspace/r2logs' && test -x '/workspace/r2logs'",
      ]),
      expect.any(Object),
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
    const resolvedHostDataDir = await realpath(hostDataDir);
    expect(runArgs).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${resolvedHostDataDir},target=/workspace/mounted/host,readonly`,
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

  it('rejects custom in-container command mounts before Docker effects', async () => {
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

    await expect(
      client.create(
        new Manifest({
          entries: {
            mounted: {
              type: 'mount',
              source: 'memory://fixture',
              mountStrategy: inContainerMountStrategy({
                pattern: { type: 'fuse', command: 'custom-mount' },
              }),
            },
          },
        }).withInContainerMountCredentialExposureAcknowledged('mounted'),
      ),
    ).rejects.toThrow(/SDK-supported strategy/u);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('validates credential opt-ins against symlink-resolved mount paths', async () => {
    await mkdir(join(rootDir, 'redirected'));
    await symlink('redirected', join(rootDir, 'remote'));
    const session = new DockerSandboxSession({
      state: {
        manifest: new Manifest({
          entries: {
            seed: {
              type: 's3_mount',
              bucket: 'seed',
              mountStrategy: inContainerMountStrategy(),
            },
          },
        }),
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {},
        containerId: 'container-effective-path',
        image: 'test:image',
      },
    });
    const update = new Manifest({
      entries: {
        remote: {
          type: 's3_mount',
          bucket: 'private',
          accessKeyId: 'trusted-key',
          secretAccessKey: 'trusted-secret',
          mountStrategy: inContainerMountStrategy(),
        },
      },
    }).withInContainerMountCredentialExposureAcknowledged('remote');

    await expect(session.applyManifest(update)).rejects.toThrow(
      /model-controlled sandbox/u,
    );
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('revalidates effective mount paths before Docker credential effects', async () => {
    const session = new DockerSandboxSession({
      state: {
        manifest: new Manifest({
          entries: {
            seed: {
              type: 's3_mount',
              bucket: 'seed',
              mountStrategy: inContainerMountStrategy(),
            },
          },
        }),
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {},
        containerId: 'container-retargeted-mount',
        image: 'test:image',
      },
    });
    let mountPathResolutions = 0;
    childProcessMocks.spawn.mockImplementation((_command, args) => {
      const command = (args as string[]).join(' ');
      if (command.includes('realpath -m -- /mnt/data')) {
        return dockerSpawnResult({
          stdout:
            mountPathResolutions++ === 0 ? '/mnt/data\n' : '/mnt/redirected\n',
        });
      }
      return dockerSpawnResult({ status: 0 });
    });

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'private',
              accessKeyId: 'trusted-key',
              secretAccessKey: 'trusted-secret',
              mountPath: '/mnt/data',
              mountStrategy: inContainerMountStrategy(),
            },
          },
        }).withInContainerMountCredentialExposureAcknowledged('/mnt/data'),
      ),
    ).rejects.toThrow(/model-controlled sandbox/u);

    const commands = childProcessMocks.spawn.mock.calls.map(([, args]) =>
      (args as string[]).join(' '),
    );
    expect(mountPathResolutions).toBe(2);
    expect(commands.some((command) => command.includes('rclone mount'))).toBe(
      false,
    );
    expect(dockerStdinWrites).toEqual([]);
  });

  it('mounts and retains authority for the trusted symlink-resolved path', async () => {
    await mkdir(join(rootDir, 'redirected'));
    await symlink('redirected', join(rootDir, 'remote'));
    const session = new DockerSandboxSession({
      state: {
        manifest: new Manifest({
          entries: {
            seed: {
              type: 's3_mount',
              bucket: 'seed',
              mountStrategy: inContainerMountStrategy(),
            },
          },
        }),
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {},
        containerId: 'container-effective-path',
        image: 'test:image',
      },
    });
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
    );
    const update = new Manifest({
      entries: {
        remote: {
          type: 's3_mount',
          bucket: 'private',
          accessKeyId: 'trusted-key',
          secretAccessKey: 'trusted-secret',
          mountStrategy: inContainerMountStrategy(),
        },
      },
    }).withInContainerMountCredentialExposureAcknowledged(
      'remote',
      'redirected',
    );

    await session.applyManifest(update);

    const commands = childProcessMocks.spawn.mock.calls.map(([, args]) =>
      (args as string[]).join(' '),
    );
    expect(
      commands.some((command) => command.includes("'/workspace/redirected'")),
    ).toBe(true);
    expect(
      commands.some((command) => command.includes("'/workspace/remote'")),
    ).toBe(false);
    expect(
      liveMountCredentialAuthorityMatches(
        session.state.manifest,
        session.state.manifest,
      ),
    ).toBe(true);

    const currentWithoutEffectivePathTrust = new Manifest({
      entries: structuredClone(session.state.manifest.entries),
    }).withInContainerMountCredentialExposureAcknowledged('remote');
    expect(
      liveMountCredentialAuthorityMatches(
        session.state.manifest,
        currentWithoutEffectivePathTrust,
      ),
    ).toBe(false);
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
          mounted: s3Mount({
            bucket: 'fixture',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountStrategy: inContainerMountStrategy(),
          }),
        },
      }).withInContainerMountCredentialExposureAcknowledged('mounted'),
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

  it('uses a safe environment when the Docker filesystem user may be root', async () => {
    childProcessMocks.spawn.mockImplementation(() =>
      dockerSpawnResult({ status: 0 }),
    );
    const manifest = new Manifest({
      entries: {
        mounted: s3Mount({
          bucket: 'fixture',
          mountStrategy: inContainerMountStrategy(),
        }),
      },
      environment: {
        PATH: '/workspace/bin:/usr/bin:/bin',
      },
    });
    const session = new DockerSandboxSession({
      state: {
        manifest,
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {
          PATH: '/workspace/bin:/usr/bin:/bin',
          HOME: '/workspace/home',
          LD_PRELOAD: '/workspace/loader.so',
          LD_LIBRARY_PATH: '/workspace/lib',
          LD_AUDIT: '/workspace/audit.so',
        },
        containerId: 'container-implicit-root',
        image: 'test:image',
      },
    });

    for (const { runAs, defaultUser } of [
      { runAs: undefined, defaultUser: undefined },
      { runAs: '0', defaultUser: undefined },
      { runAs: '0:0', defaultUser: undefined },
      { runAs: 'root:root', defaultUser: undefined },
      { runAs: undefined, defaultUser: '0:0' },
      { runAs: '', defaultUser: undefined },
      { runAs: undefined, defaultUser: '' },
    ]) {
      childProcessMocks.spawn.mockClear();
      session.state.defaultUser = defaultUser;

      await expect(session.pathExists('mounted/file.txt', runAs)).resolves.toBe(
        true,
      );

      const command = (
        childProcessMocks.spawn.mock.calls[0]?.[1] as string[]
      ).join(' ');
      expect(command).toContain('-e PATH=/usr/sbin:/usr/bin:/sbin:/bin');
      expect(command).toContain('-e HOME=/root');
      expect(command).toContain('-e LD_PRELOAD=');
      expect(command).toContain('-e LD_LIBRARY_PATH=');
      expect(command).toContain('-e LD_AUDIT=');
      expect(command).not.toContain('/workspace/bin:/usr/bin:/bin');
    }

    for (const { runAs, defaultUser } of [
      { runAs: 'node', defaultUser: undefined },
      { runAs: '', defaultUser: 'node' },
    ]) {
      childProcessMocks.spawn.mockClear();
      session.state.defaultUser = defaultUser;
      await expect(session.pathExists('mounted/file.txt', runAs)).resolves.toBe(
        true,
      );
      const nonRootCommand = (
        childProcessMocks.spawn.mock.calls[0]?.[1] as string[]
      ).join(' ');
      expect(nonRootCommand).toContain('-e PATH=/workspace/bin:/usr/bin:/bin');
      expect(nonRootCommand).toContain('-u node');
      expect(nonRootCommand).not.toContain(
        '-e PATH=/usr/sbin:/usr/bin:/sbin:/bin',
      );
    }
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
      dockerSpawnResult({ stderr: 'MOUNT_SECRET_SENTINEL', status: 1 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const error = await client
      .create(
        new Manifest({
          entries: {
            mounted: {
              ...s3Mount({
                bucket: 'fixture',
                accessKeyId: 'access-key',
                secretAccessKey: 'secret-key',
                mountStrategy: inContainerMountStrategy(),
              }),
            },
          },
        }).withInContainerMountCredentialExposureAcknowledged('mounted'),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/exit status 1/u);
    expect(JSON.stringify(error)).not.toContain('MOUNT_SECRET_SENTINEL');

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

  it('retries failed container cleanup before a later create', async () => {
    let containerCount = 0;
    let removeCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          containerCount += 1;
          return success(`container-${containerCount}\n`);
        }
        if (args[0] === 'rm') {
          removeCount += 1;
          return removeCount === 1
            ? failure('container removal failed')
            : success();
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
              ...s3Mount({
                bucket: 'fixture',
                accessKeyId: 'access-key',
                secretAccessKey: 'secret-key',
                mountStrategy: inContainerMountStrategy(),
              }),
            },
          },
        }).withInContainerMountCredentialExposureAcknowledged('mounted'),
      ),
    ).rejects.toThrow(
      'Docker sandbox creation failed and cleanup could not complete.',
    );

    const session = await client.create(new Manifest());
    await session.close();

    expect(
      processMocks.runSandboxProcess.mock.calls
        .filter(([, args]) => args[0] === 'rm')
        .map(([, args]) => args[2]),
    ).toEqual(['container-1', 'container-1', 'container-2']);
  });

  it('retains cleanup tracking when a timed-out create is not visible yet', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'protected-create-secret';
    let runCount = 0;
    let timedOutContainerName: string | undefined;
    let timedOutContainerRemovalCount = 0;
    let timedOutVolumeName: string | undefined;
    let timedOutVolumeRemovalCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 1) {
            timedOutContainerName = args[args.indexOf('--name') + 1];
            timedOutVolumeName = dockerRunInspection(args).mounts.find(
              (mount) => mount.Type === 'volume',
            )?.Name;
            return timedOut();
          }
          return success('later-container\n');
        }
        if (args[0] === 'rm') {
          if (args[2] === timedOutContainerName) {
            timedOutContainerRemovalCount += 1;
            return timedOutContainerRemovalCount === 2
              ? success()
              : failure('No such container');
          }
          return success();
        }
        if (
          args[0] === 'volume' &&
          args[1] === 'rm' &&
          args[3] === timedOutVolumeName
        ) {
          timedOutVolumeRemovalCount += 1;
          return timedOutVolumeRemovalCount === 1
            ? failure('volume cleanup failed')
            : success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const manifest = new Manifest({
      entries: {
        logs: {
          type: 's3_mount',
          bucket: 'agent-logs',
          mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
        },
      },
      environment: {
        SANDBOX_TOKEN: new ProcessEnvValue({
          name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
        }),
      },
    });

    const error = await client.create(manifest).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(timedOutContainerName).toBeDefined();
    expect(timedOutVolumeName).toBeDefined();
    expect(error).toBeInstanceOf(SandboxLifecycleError);
    expect((error as SandboxLifecycleError).details).toMatchObject({
      provider: 'docker',
      operation: 'sandbox creation',
      replacementContainerId: timedOutContainerName,
    });
    expect(timedOutContainerRemovalCount).toBe(1);

    await expect(client.create(new Manifest())).rejects.toThrow(
      'Docker sandbox cleanup failed for a resource that used protected process environment values.',
    );
    const later = await client.create(new Manifest());
    await later.close();

    expect(timedOutContainerRemovalCount).toBe(3);
    expect(timedOutVolumeRemovalCount).toBe(2);
    expect(
      processMocks.runSandboxProcess.mock.calls
        .filter(([, args]) => args[0] === 'rm')
        .map(([, args]) => args[2]),
    ).toEqual([
      timedOutContainerName,
      timedOutContainerName,
      timedOutContainerName,
      'later-container',
    ]);
  });

  it('retries owned workspace cleanup after a timed-out create', async () => {
    let runCount = 0;
    let timedOutContainerName: string | undefined;
    let timedOutWorkspaceRoot: string | undefined;
    let timedOutContainerRemovalCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 1) {
            timedOutContainerName = args[args.indexOf('--name') + 1];
            timedOutWorkspaceRoot = dockerRunInspection(args).mounts.find(
              (mount) => mount.Type === 'bind',
            )?.Source;
            return timedOut();
          }
          return success(`container-${runCount}\n`);
        }
        if (args[0] === 'rm') {
          if (args[2] === timedOutContainerName) {
            timedOutContainerRemovalCount += 1;
            return timedOutContainerRemovalCount === 2
              ? success()
              : failure('No such container');
          }
          return success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });

    await expect(client.create(new Manifest())).rejects.toThrow(
      'Failed to start Docker sandbox container',
    );

    expect(timedOutContainerName).toBeDefined();
    expect(timedOutWorkspaceRoot).toBeDefined();
    await chmod(rootDir, 0o500);
    try {
      await expect(client.create(new Manifest())).rejects.toThrow();
      await expect(stat(timedOutWorkspaceRoot!)).resolves.toBeDefined();
    } finally {
      await chmod(rootDir, 0o700);
    }

    const later = await client.create(new Manifest());
    await expect(stat(timedOutWorkspaceRoot!)).rejects.toThrow();
    await later.close();

    expect(timedOutContainerRemovalCount).toBe(3);
  });

  it('preserves protected creation identifiers when setup cleanup fails', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'protected-create-secret';
    let replacementVolumeName: string | undefined;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          const inspection = dockerRunInspection(args);
          replacementVolumeName = inspection.mounts.find(
            (mount) => mount.Type === 'volume',
          )?.Name;
          return success('protected-create-replacement\n');
        }
        if (args[0] === 'exec') {
          return failure('account provisioning echoed protected-create-secret');
        }
        if (args[0] === 'rm') {
          return failure('container cleanup echoed protected-create-secret');
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          return failure('volume cleanup echoed protected-create-secret');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });

    const error = await client
      .create(
        new Manifest({
          entries: {
            logs: {
              type: 's3_mount',
              bucket: 'agent-logs',
              mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
            },
          },
          environment: {
            SANDBOX_TOKEN: new ProcessEnvValue({
              name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
            }),
          },
          users: [{ name: 'sandbox-user' }],
        }),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(replacementVolumeName).toBeDefined();
    expect(error).toBeInstanceOf(SandboxLifecycleError);
    expect(String(error)).not.toContain('protected-create-secret');
    expect((error as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'sandbox creation',
      replacementContainerId: 'protected-create-replacement',
      replacementDockerVolumeNames: [replacementVolumeName],
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('preserves protected replacement identifiers when setup cleanup fails', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-secret';
    let runCount = 0;
    let replacementVolumeName: string | undefined;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `protected-replacement-${runCount}`;
          const inspection = dockerRunInspection(args);
          inspections.set(containerId, inspection);
          if (runCount === 2) {
            replacementVolumeName = inspection.mounts.find(
              (mount) => mount.Type === 'volume',
            )?.Name;
          }
          return success(`${containerId}\n`);
        }
        if (args[0] === 'exec') {
          return args.includes('protected-replacement-2')
            ? failure('account provisioning echoed rotated-secret')
            : success();
        }
        if (args[0] === 'rm' && args[2] === 'protected-replacement-2') {
          return failure('container cleanup echoed rotated-secret');
        }
        if (
          args[0] === 'volume' &&
          args[1] === 'rm' &&
          args[3] === replacementVolumeName
        ) {
          return failure('volume cleanup echoed rotated-secret');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
        users: [{ name: 'sandbox-user' }],
      }),
    );
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-secret';

    const error = await client.resume(session.state).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(replacementVolumeName).toBeDefined();
    expect(error).toBeInstanceOf(SandboxLifecycleError);
    expect(String(error)).not.toContain('rotated-secret');
    expect((error as SandboxLifecycleError).details).toEqual({
      provider: 'docker',
      operation: 'sandbox resume',
      containerId: 'protected-replacement-1',
      replacementContainerId: 'protected-replacement-2',
      replacementDockerVolumeNames: [replacementVolumeName],
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('retries failed restart cleanup before a later create', async () => {
    let containerCount = 0;
    let replacementRemoveAttempts = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'run') {
          containerCount += 1;
          const containerId = `container-${containerCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'exec') {
          return args.includes('container-2')
            ? failure('account provisioning failed')
            : success();
        }
        if (args[0] === 'rm') {
          if (args[2] === 'container-2') {
            replacementRemoveAttempts += 1;
            return replacementRemoveAttempts === 1
              ? failure('replacement removal failed')
              : success();
          }
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const original = await client.create(new Manifest());

    await expect(
      client.resume({
        ...original.state,
        manifest: new Manifest({
          users: [{ name: 'sandbox-user' }],
        }),
      }),
    ).rejects.toThrow(
      'Docker sandbox restart failed and cleanup could not complete.',
    );

    const later = await client.create(new Manifest());
    await later.close();

    expect(replacementRemoveAttempts).toBe(2);
    expect(
      processMocks.runSandboxProcess.mock.calls
        .filter(([, args]) => args[0] === 'rm')
        .map(([, args]) => args[2]),
    ).toEqual(['container-1', 'container-2', 'container-2', 'container-3']);
  });

  it('continues timed-out restart cleanup after container removal', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'initial-secret';
    let runCount = 0;
    let timedOutContainerName: string | undefined;
    let timedOutContainerRemovalCount = 0;
    let timedOutVolumeName: string | undefined;
    let timedOutVolumeRemovalCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 2) {
            timedOutContainerName = args[args.indexOf('--name') + 1];
            timedOutVolumeName = dockerRunInspection(args).mounts.find(
              (mount) => mount.Type === 'volume',
            )?.Name;
            return timedOut();
          }
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'rm') {
          if (args[2] === timedOutContainerName) {
            timedOutContainerRemovalCount += 1;
            return timedOutContainerRemovalCount === 2
              ? success()
              : failure('No such object');
          }
          return success();
        }
        if (
          args[0] === 'volume' &&
          args[1] === 'rm' &&
          args[3] === timedOutVolumeName
        ) {
          timedOutVolumeRemovalCount += 1;
          return timedOutVolumeRemovalCount === 1
            ? failure('volume cleanup failed')
            : success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });
    const original = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          SANDBOX_TOKEN: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
      }),
    );
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'rotated-secret';

    await expect(client.resume(original.state)).rejects.toBeInstanceOf(
      SandboxLifecycleError,
    );

    expect(timedOutContainerName).toBeDefined();
    expect(timedOutVolumeName).toBeDefined();
    expect(timedOutContainerRemovalCount).toBe(1);

    await expect(client.create(new Manifest())).rejects.toThrow(
      'Docker sandbox cleanup failed for a resource that used protected process environment values.',
    );
    const later = await client.create(new Manifest());
    await later.close();
    await original.close();

    expect(timedOutContainerRemovalCount).toBe(3);
    expect(timedOutVolumeRemovalCount).toBe(2);
  });

  it('retains a restored workspace while a timed-out restart is not visible', async () => {
    let runCount = 0;
    let timedOutContainerName: string | undefined;
    let timedOutContainerRemovalCount = 0;
    let timedOutWorkspaceRoot: string | undefined;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 2) {
            timedOutContainerName = args[args.indexOf('--name') + 1];
            const inspection = dockerRunInspection(args);
            timedOutWorkspaceRoot = inspection.mounts.find(
              (mount) => mount.Type === 'bind',
            )?.Source;
            return timedOut();
          }
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'rm') {
          if (args[2] === timedOutContainerName) {
            timedOutContainerRemovalCount += 1;
            return timedOutContainerRemovalCount === 1
              ? failure('No such object')
              : success();
          }
          return success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: join(rootDir, 'snapshots'),
      },
    });
    const original = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
      }),
    );
    const serializedState = await client.serializeSessionState(original.state);
    original.state.snapshot =
      serializedState.snapshot as DockerSandboxSessionState['snapshot'];
    original.state.snapshotExcludedPaths =
      serializedState.snapshotExcludedPaths as string[] | undefined;
    await rm(original.state.workspaceRootPath, {
      recursive: true,
      force: true,
    });
    const error = await client.resume(original.state).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(timedOutContainerName).toBeDefined();
    expect(timedOutWorkspaceRoot).toBeDefined();
    await expect(stat(timedOutWorkspaceRoot!)).resolves.toBeDefined();
    expect(error).toBeInstanceOf(UserError);
    expect(String(error)).toContain('Failed to start Docker sandbox container');
    expect(timedOutContainerRemovalCount).toBe(1);

    const later = await client.create(new Manifest());
    await expect(stat(timedOutWorkspaceRoot!)).rejects.toThrow();
    await later.close();
    await original.close();

    expect(timedOutContainerRemovalCount).toBe(2);
    expect(
      processMocks.runSandboxProcess.mock.calls
        .filter(([, args]) => args[0] === 'rm')
        .map(([, args]) => args[2]),
    ).toEqual([
      'container-1',
      timedOutContainerName,
      timedOutContainerName,
      'container-3',
      'container-1',
    ]);
  });

  it('retries restored workspace cleanup after a timed-out restart', async () => {
    let runCount = 0;
    let timedOutContainerName: string | undefined;
    let timedOutContainerRemovalCount = 0;
    let timedOutWorkspaceRoot: string | undefined;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'run') {
          runCount += 1;
          if (runCount === 2) {
            timedOutContainerName = args[args.indexOf('--name') + 1];
            timedOutWorkspaceRoot = dockerRunInspection(args).mounts.find(
              (mount) => mount.Type === 'bind',
            )?.Source;
            return timedOut();
          }
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'rm') {
          if (args[2] === timedOutContainerName) {
            timedOutContainerRemovalCount += 1;
            return timedOutContainerRemovalCount === 2
              ? success()
              : failure('No such object');
          }
          return success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: join(rootDir, 'snapshots'),
      },
    });
    const original = await client.create(new Manifest());
    const serializedState = await client.serializeSessionState(original.state);
    original.state.snapshot =
      serializedState.snapshot as DockerSandboxSessionState['snapshot'];
    original.state.snapshotExcludedPaths =
      serializedState.snapshotExcludedPaths as string[] | undefined;
    await rm(original.state.workspaceRootPath, {
      recursive: true,
      force: true,
    });

    await expect(client.resume(original.state)).rejects.toThrow(
      'Failed to start Docker sandbox container',
    );

    expect(timedOutContainerName).toBeDefined();
    expect(timedOutWorkspaceRoot).toBeDefined();
    await chmod(rootDir, 0o500);
    try {
      await expect(client.create(new Manifest())).rejects.toThrow();
      await expect(stat(timedOutWorkspaceRoot!)).resolves.toBeDefined();
    } finally {
      await chmod(rootDir, 0o700);
    }

    const later = await client.create(new Manifest());
    await expect(stat(timedOutWorkspaceRoot!)).rejects.toThrow();
    await later.close();
    await original.close();

    expect(timedOutContainerRemovalCount).toBe(3);
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
      }).withInContainerMountCredentialExposureAcknowledged('azure'),
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
              accountKey: 'account-key',
              mountPath: 'azure',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  cachePath: 'azure/cache',
                },
              }),
            },
          },
        }).withInContainerMountCredentialExposureAcknowledged('azure'),
      ),
    ).rejects.toThrow(/cachePath must be outside the mount path/);
    expect(
      childProcessMocks.spawn.mock.calls.every(([, args]) =>
        (args as string[]).join(' ').includes('fusermount3'),
      ),
    ).toBe(true);
  });

  it('redacts thrown Docker mount command errors', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-123\n');
        }
        if (args[0] === 'exec') {
          throw new Error('MOUNT_SECRET_SENTINEL');
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

    const error = await client
      .create(
        new Manifest({
          entries: {
            s3: {
              type: 's3_mount',
              bucket: 'agent-logs',
              mountStrategy: inContainerMountStrategy(),
            },
          },
        }),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(UserError);
    expect(JSON.stringify(error)).not.toContain('MOUNT_SECRET_SENTINEL');
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
              accountKey: 'account-key',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'fuse',
                  cachePath: 'cache/..',
                },
              }),
            },
          },
        }).withInContainerMountCredentialExposureAcknowledged('azure'),
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
      }).withInContainerMountBroadCredentialExposureAcknowledged('s3files'),
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
      expect(command).toContain('trap');
      expect(command).toContain('EXIT HUP INT TERM');
      expect(command).toContain('rm -rf');
      expect(command).toContain('unset AWS_ACCESS_KEY_ID');
      expect(command).toContain('AWS_SESSION_TOKEN');
      expect(command).toContain('AWS_SECURITY_TOKEN');
      expect(command).toContain('-e AWS_SESSION_TOKEN=');
      expect(command).toContain('-e AWS_SECURITY_TOKEN=');
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
        environment: {
          AWS_SESSION_TOKEN: 'inherited-session-token',
          AWS_SECURITY_TOKEN: 'inherited-security-token',
        },
      }).withInContainerMountCredentialExposureAcknowledged('s3'),
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

  it.each(['rclone', 'mountpoint'] as const)(
    'rejects partial S3 credentials before Docker %s effects',
    async (patternType) => {
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
      });
      const pattern =
        patternType === 'rclone'
          ? ({ type: 'rclone' } as const)
          : ({ type: 'mountpoint' } as const);

      await expect(
        client.create(
          new Manifest({
            entries: {
              s3: {
                type: 's3_mount',
                bucket: 'agent-logs',
                accessKeyId: 'access-key',
                mountStrategy: inContainerMountStrategy({ pattern }),
              },
            },
          }).withInContainerMountCredentialExposureAcknowledged('s3'),
        ),
      ).rejects.toThrow(/both accessKeyId and secretAccessKey/u);

      expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    },
  );

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
      expect(command).toContain('--no-sign-request');
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

  it('removes shadowed GCS credential files from Docker mountpoint helpers', async () => {
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
      expect(command).toContain('unset AWS_ACCESS_KEY_ID');
      expect(command).toContain('GOOGLE_APPLICATION_CREDENTIALS');
      expect(command).toContain('-e GOOGLE_APPLICATION_CREDENTIALS=');
      expect(command).not.toContain('/run/secrets/gcp.json');
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
            accessId: 'inline-access-id',
            secretAccessKey: 'inline-secret-key',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'mountpoint',
              },
            }),
          },
        },
        environment: {
          GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/gcp.json',
        },
      }).withInContainerMountCredentialExposureAcknowledged('gcs'),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
  });

  it('rejects rclone credential config stored in manifest entries', async () => {
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
        }).withInContainerMountCredentialExposureAcknowledged('s3'),
      ),
    ).rejects.toThrow(/serialized manifest entry/u);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('redacts symlink-aliased rclone config failures for protected Docker sessions', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'protected-secret';
    const session = new DockerSandboxSession({
      state: {
        manifest: bindProcessEnvironmentAccess(
          new Manifest({
            entries: {
              'secret.conf': {
                type: 'file',
                content: '[custom]\npassword = serialized\n',
              },
              seed: {
                type: 's3_mount',
                bucket: 'seed',
                mountStrategy: inContainerMountStrategy(),
              },
            },
            environment: {
              PATH: new ProcessEnvValue(),
              HOME: new ProcessEnvValue(),
              SANDBOX_TOKEN: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
              }),
            },
          }),
          {
            processEnvironmentBindings: {
              PATH: 'PATH',
              HOME: 'HOME',
              SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
            },
          },
        ),
        workspaceRootPath: rootDir,
        workspaceRootOwned: false,
        environment: {
          PATH: '/workspace/model-bin',
          HOME: '/workspace/model-home',
          LD_PRELOAD: '/workspace/model-loader.so',
          SANDBOX_TOKEN: 'protected-secret',
        },
        containerId: 'container-credential-alias',
        image: 'test:image',
      },
    });
    childProcessMocks.spawn.mockImplementation((_command, args) => {
      const command = (args as string[]).join(' ');
      if (command.includes('realpath -m -- /workspace/secret.conf')) {
        return dockerSpawnResult({ stdout: '/workspace/secret.conf\n' });
      }
      if (command.includes('realpath -m -- /workspace/config-link')) {
        return dockerSpawnResult({ stdout: '/workspace/secret.conf\n' });
      }
      return dockerSpawnResult({ status: 1, stderr: 'unexpected command' });
    });

    await expect(
      session.applyManifest(
        new Manifest({
          environment: {
            SAFE: async () => {
              delete session.state.manifest.environment.PATH;
              delete session.state.manifest.environment.HOME;
              return 'safe';
            },
          },
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'agent-logs',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'rclone',
                  remoteName: 'custom',
                  configFilePath: '/workspace/config-link',
                },
              }),
            },
          },
        }).withInContainerMountBroadCredentialExposureAcknowledged('data'),
      ),
    ).rejects.toThrow(/protected process environment values/u);

    const commands = childProcessMocks.spawn.mock.calls.map(([, args]) =>
      (args as string[]).join(' '),
    );
    const resolverArgs = childProcessMocks.spawn.mock.calls
      .map(([, args]) => args as string[])
      .filter((args) => args.includes('/usr/bin/realpath'));
    expect(resolverArgs).not.toHaveLength(0);
    for (const args of resolverArgs) {
      expect(args).not.toContain('/bin/sh');
      expect(args).not.toContain('-lc');
      expect(args).not.toContain('SANDBOX_TOKEN=');
      expect(args).not.toContain('PATH=');
      expect(args).not.toContain('HOME=');
      expect(args.join(' ')).not.toContain('protected-secret');
      expect(args).toEqual(
        expect.arrayContaining([
          'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
          'HOME=/root',
          'LD_PRELOAD=',
          'LD_LIBRARY_PATH=',
          'LD_AUDIT=',
        ]),
      );
    }
    expect(commands.some((command) => command.includes('base64 --'))).toBe(
      false,
    );
    expect(commands.some((command) => command.includes('rclone mount'))).toBe(
      false,
    );
    expect(session.state.manifest.entries.data).toBeUndefined();
  });

  it('rejects ambient mount credentials before Docker side effects', async () => {
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
              mountStrategy: inContainerMountStrategy(),
            },
          },
          environment: {
            AWS_ACCESS_KEY_ID: 'AMBIENT_ACCESS_SENTINEL',
            AWS_SECRET_ACCESS_KEY: 'AMBIENT_SECRET_SENTINEL',
          },
        }),
      ),
    ).rejects.toThrow(/model-controlled sandbox/u);

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('requires broad acknowledgement for ambient credentials exposed beside inline rclone credentials', async () => {
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
              accessKeyId: 'inline-access-key',
              secretAccessKey: 'inline-secret-key',
              mountStrategy: inContainerMountStrategy({
                pattern: { type: 'rclone' },
              }),
            },
          },
          environment: {
            AWS_ACCESS_KEY_ID: 'ambient-access-key',
            AWS_SECRET_ACCESS_KEY: 'ambient-secret-key',
            AWS_SESSION_TOKEN: 'ambient-session-token',
          },
        }).withInContainerMountCredentialExposureAcknowledged('s3'),
      ),
    ).rejects.toThrow(/broad credential authority/iu);

    await expect(
      client.create(
        new Manifest({
          entries: {
            gcs: {
              type: 'gcs_mount',
              bucket: 'agent-logs',
              accessToken: 'inline-access-token',
              mountStrategy: inContainerMountStrategy({
                pattern: { type: 'rclone' },
              }),
            },
          },
          environment: {
            GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/gcp.json',
          },
        }).withInContainerMountCredentialExposureAcknowledged('gcs'),
      ),
    ).rejects.toThrow(/broad credential authority/iu);

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
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
      }).withInContainerMountCredentialExposureAcknowledged('r2logs'),
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

    const error = await client
      .create(
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
        }).withInContainerMountBroadCredentialExposureAcknowledged('s3'),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(SandboxMountError);
    expect(String(error)).toMatch(/failed to resolve the rclone config file/u);
    expect(JSON.stringify(error)).not.toContain('/etc/rclone.conf');
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

  it('surfaces failed Docker rclone NFS helper termination', async () => {
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
      if (command.includes('openai_agents_kill_rclone_nfs')) {
        return dockerSpawnResult({
          stderr: 'CLEANUP_SECRET_SENTINEL',
          status: 1,
        });
      }
      if (command.includes('rclone') && command.includes('serve')) {
        return dockerSpawnResult({
          stderr: 'MOUNT_SECRET_SENTINEL',
          status: 1,
        });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    const error = await client
      .create(
        new Manifest({
          entries: {
            s3: {
              type: 's3_mount',
              bucket: 'agent-logs',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
              mountStrategy: inContainerMountStrategy({
                pattern: {
                  type: 'rclone',
                  mode: 'nfs',
                },
              }),
            },
          },
        }).withInContainerMountCredentialExposureAcknowledged('s3'),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(SandboxMountError);
    expect(String(error)).toContain(
      'mount failed and credential cleanup could not complete',
    );
    expect((error as SandboxMountError).details).toMatchObject({
      provider: 'docker',
      cleanupFailed: true,
    });
    expect(JSON.stringify(error)).not.toContain('MOUNT_SECRET_SENTINEL');
    expect(JSON.stringify(error)).not.toContain('CLEANUP_SECRET_SENTINEL');
    const cleanupCommand = childProcessMocks.spawn.mock.calls
      .map(([, args]) => (args as string[]).join(' '))
      .find((command) => command.includes('openai_agents_kill_rclone_nfs'));
    expect(cleanupCommand).toContain('[ "$helper_status" -eq 0 ] && rm -f --');
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
    expect(configInput).toContain('use_msi = false');
    expect(configInput).toContain('env_auth = false');
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

  it('enables ambient Docker GCS auth after exact-path opt-in', async () => {
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
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'rclone',
              },
            }),
          },
        },
      }).withInContainerMountBroadCredentialExposureAcknowledged('gcs'),
    );

    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    const configInput = dockerStdinWrites.join('\n');
    expect(configInput).toContain('type = google cloud storage');
    expect(configInput).toContain('env_auth = true');
    expect(configInput).not.toContain('anonymous = true');
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

  it('redacts protected Docker close errors for direct and managed cleanup', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-close-secret';
    let removeCalls = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-process-env\n');
        }
        if (args[0] === 'rm') {
          removeCalls += 1;
          return removeCalls <= 2
            ? failure('cleanup echoed docker-close-secret')
            : success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );

    for (const cleanup of [
      () => session.close(),
      () => cleanupSandboxSession(session),
    ]) {
      let thrown: unknown;
      try {
        await cleanup();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SandboxLifecycleError);
      expect(String(thrown)).not.toContain('docker-close-secret');
      expect(JSON.stringify(thrown)).not.toContain('docker-close-secret');
      expect((thrown as SandboxLifecycleError).details).toEqual({
        provider: 'docker',
        operation: 'sandbox shutdown',
        containerId: 'container-process-env',
      });
    }

    await session.close();
    expect(removeCalls).toBe(3);
  });

  it('reports protected Docker volume cleanup failures after closing the workspace', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-close-secret';
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-process-env-volume-close\n');
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          return failure('cleanup echoed docker-close-secret');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );
    const workspaceRootPath = session.state.workspaceRootPath;
    const volumeName = session.state.dockerVolumeNames?.[0];

    let thrown: unknown;
    try {
      await session.close();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxLifecycleError);
    expect(String(thrown)).not.toContain('docker-close-secret');
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['volume', 'rm', '-f', volumeName],
      { timeoutMs: 10_000 },
    );
    await expect(stat(workspaceRootPath)).rejects.toThrow();
  });

  it('treats an already absent protected Docker volume as closed', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-close-secret';
    let volumeRemovalCalls = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-process-env-volume-repeat\n');
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          volumeRemovalCalls += 1;
          return volumeRemovalCalls === 1
            ? success()
            : failure('Error response from daemon: no such volume');
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );

    await session.close();
    await session.close();

    expect(volumeRemovalCalls).toBe(2);
  });

  it('converges when retrying partially removed protected Docker volumes', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'docker-close-secret';
    const volumeRemovalCalls = new Map<string, number>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-process-env-volume-partial\n');
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          const volumeName = args[3]!;
          const attempt = (volumeRemovalCalls.get(volumeName) ?? 0) + 1;
          volumeRemovalCalls.set(volumeName, attempt);
          if (volumeName === session.state.dockerVolumeNames?.[0]) {
            return attempt === 1
              ? success()
              : failure('Error response from daemon: no such object');
          }
          return attempt === 1 ? failure('volume is busy') : success();
        }
        return success();
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      allowedProcessEnvironmentKeys: ['AGENTS_TEST_DOCKER_PROCESS_SOURCE'],
    });
    const session = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
          cache: {
            type: 's3_mount',
            bucket: 'agent-cache',
            mountPath: '/mnt/cache',
            mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
          },
        },
        environment: {
          AGENTS_TEST_DOCKER_PROCESS_SOURCE: new ProcessEnvValue(),
        },
      }),
    );

    await expect(session.close()).rejects.toThrow(
      /protected process environment values/u,
    );
    await session.close();

    expect([...volumeRemovalCalls.values()]).toEqual([2, 2]);
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

  it.each([
    { status: 1, stderr: 'Permission denied' },
    { status: 2, stderr: 'Input/output error' },
  ])('preserves failed Docker filesystem probes: %j', async (result) => {
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
    childProcessMocks.spawn.mockImplementation(() => dockerSpawnResult(result));
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest());

    await expect(
      session.pathExists('blocked.txt', 'node'),
    ).rejects.toMatchObject({
      code: 'workspace_archive_read_error',
      details: {
        path: '/workspace/blocked.txt',
        status: result.status,
      },
    });
  });

  it('normalizes missing Docker filesystem reads to typed not-found errors', async () => {
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
      const command = args.at(-1) ?? '';
      const path = '/workspace/.agents/.git/SKILL.md';
      if (command.startsWith('base64 --')) {
        return dockerSpawnResult({
          status: 1,
          stderr: `base64: ${path}: No such file or directory`,
        });
      }
      if (command.startsWith('test -e')) {
        return dockerSpawnResult({
          status: 1,
          stderr: `test: ${path}: No such file or directory`,
        });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest());

    await expect(
      session.readFile({ path: '.agents/.git/SKILL.md', runAs: 'node' }),
    ).rejects.toMatchObject({
      code: 'workspace_read_not_found',
      details: { path: '/workspace/.agents/.git/SKILL.md' },
    });
  });

  it('normalizes missing Docker directory listings to typed not-found errors', async () => {
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
      const command = args.at(-1) ?? '';
      const path = '/workspace/.agents';
      if (command.startsWith('find ')) {
        return dockerSpawnResult({
          status: 1,
          stderr: `find: ${path}: No such file or directory`,
        });
      }
      if (command.startsWith('test -e')) {
        return dockerSpawnResult({
          status: 1,
          stderr: `test: ${path}: No such file or directory`,
        });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest());

    await expect(
      session.listDir({ path: '.agents', runAs: 'node' }),
    ).rejects.toMatchObject({
      code: 'workspace_read_not_found',
      details: { path: '/workspace/.agents' },
    });
  });

  it('uses the discovery fallback when Docker skill directories are missing', async () => {
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
      const command = args.at(-1) ?? '';
      const path = '/workspace/.agents';
      if (command.startsWith('find ') || command.startsWith('test -e')) {
        return dockerSpawnResult({
          status: 1,
          stderr: `find: ${path}: No such file or directory`,
        });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest());
    const capability = skills({ from: { type: 'dir', children: {} } });
    capability.bind(session).bindRunAs('node');

    await expect(
      capability.instructions(session.state.manifest),
    ).resolves.toContain('.agents');
  });

  it('does not treat inaccessible Docker skill directories as missing', async () => {
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
      const command = args.at(-1) ?? '';
      if (command.startsWith('find ')) {
        return dockerSpawnResult({
          status: 1,
          stderr: 'find: /workspace/.agents: Permission denied',
        });
      }
      if (command.startsWith('test -e')) {
        return dockerSpawnResult({ status: 0 });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest());
    const capability = skills({ from: { type: 'dir', children: {} } });
    capability.bind(session).bindRunAs('node');

    await expect(
      capability.instructions(session.state.manifest),
    ).rejects.toThrow('Permission denied');
  });

  it('skips Docker Git metadata when discovering materialized skills', async () => {
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
      const command = args.at(-1) ?? '';
      const missingPath = '/workspace/.agents/.git/SKILL.md';
      if (command.startsWith('find ')) {
        return dockerSpawnResult({ stdout: 'd\t.git\nd\tdynamic-skill\n' });
      }
      if (command.includes(missingPath)) {
        return dockerSpawnResult({
          status: 1,
          stderr: `base64: ${missingPath}: No such file or directory`,
        });
      }
      if (command.startsWith('base64 --')) {
        return dockerSpawnResult({
          stdout: Buffer.from(
            '---\nname: dynamic-skill\ndescription: Dynamic skill\n---\n',
          ).toString('base64'),
        });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest());
    const capability = skills({ from: { type: 'dir', children: {} } });
    capability.bind(session).bindRunAs('node');

    await expect(
      capability.instructions(session.state.manifest),
    ).resolves.toContain('- dynamic-skill: Dynamic skill');
  });

  it('provisions manifest identity metadata inside the container', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE =
      '/workspace/bin:/usr/bin:/bin';
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
      processEnvironmentBindings: {
        PATH: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    });

    await client.create(
      new Manifest({
        environment: {
          PATH: new ProcessEnvValue({
            name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          }),
        },
        users: [{ name: 'sandbox-user' }],
        groups: [
          {
            name: 'sandbox-group',
            users: [{ name: 'sandbox-user' }],
          },
        ],
      }),
    );

    const execCalls = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'exec',
    );
    const execCommands = execCalls.map(([, args]) => args.at(-1));
    expect(
      execCommands.some((command) => String(command).includes('groupadd')),
    ).toBe(true);
    expect(
      execCommands.some((command) => String(command).includes('useradd')),
    ).toBe(true);
    expect(
      execCommands.some((command) => String(command).includes('usermod')),
    ).toBe(true);
    for (const [, args] of execCalls) {
      expect(args).toEqual(
        expect.arrayContaining([
          '-e',
          'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
          '-e',
          'HOME=/root',
          '-e',
          'LD_PRELOAD=',
          '-e',
          'LD_LIBRARY_PATH=',
          '-e',
          'LD_AUDIT=',
          '-u',
          'root',
        ]),
      );
      expect(args).not.toContain('PATH=/workspace/bin:/usr/bin:/bin');
    }
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
    const resolvedRootDir = await realpath(rootDir);
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${resolvedRootDir},target=${rootDir},readonly`,
      ]),
    );
  });

  it('uses hostPath as the Docker bind source and path as the target', async () => {
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
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: rootDir,
            readOnly: true,
          },
        ],
      }),
    );

    const runCall = processMocks.runSandboxProcess.mock.calls.find(
      ([, args]) => args[0] === 'run',
    );
    const resolvedRootDir = await realpath(rootDir);
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${resolvedRootDir},target=/mnt/shared-data,readonly`,
      ]),
    );
  });

  it('uses create-time path grants as command workdirs', async () => {
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
      dockerSpawnResult({ stdout: '/mnt/shared-data\n', status: 0 }),
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: rootDir,
            readOnly: true,
          },
          {
            path: '/mnt/shared-data',
            hostPath: rootDir,
            readOnly: true,
          },
        ],
      }),
    );

    await session.execCommand({
      cmd: 'pwd',
      workdir: rootDir,
      yieldTimeMs: 0,
    });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-i',
        '-w',
        rootDir,
        'container-123',
        'pwd',
      ]),
      { stdio: 'pipe' },
    );

    childProcessMocks.spawn.mockClear();
    await session.execCommand({
      cmd: 'pwd',
      workdir: '/mnt/shared-data',
      yieldTimeMs: 0,
    });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-i',
        '-w',
        '/mnt/shared-data',
        'container-123',
        'pwd',
      ]),
      { stdio: 'pipe' },
    );

    childProcessMocks.spawn.mockClear();
    await expect(
      session.execCommand({
        cmd: 'pwd',
        workdir: '/mnt/not-granted',
      }),
    ).rejects.toThrow(/escapes the workspace root/);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('uses the container filesystem for split path grants', async () => {
    const pngBytes = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
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
      const command = args.at(-1) ?? '';
      if (command.startsWith('base64 --')) {
        const bytes =
          command.includes('picture.png') || command.includes('payload.bin')
            ? pngBytes
            : new TextEncoder().encode('hello');
        return dockerSpawnResult({
          stdout: Buffer.from(bytes).toString('base64'),
          status: 0,
        });
      }
      if (command.startsWith('find ')) {
        return dockerSpawnResult({ stdout: 'f\tdata.txt\n', status: 0 });
      }
      return dockerSpawnResult({ status: 0 });
    });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'workspace.txt': {
            type: 'file',
            content: 'workspace',
          },
        },
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: rootDir,
          },
        ],
      }),
    );
    const editor = session.createEditor();

    await editor.deleteFile({
      type: 'delete_file',
      path: 'workspace.txt',
    });
    await expect(
      stat(join(session.state.workspaceRootPath, 'workspace.txt')),
    ).rejects.toThrow();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();

    await expect(session.pathExists('/mnt/shared-data/data.txt')).resolves.toBe(
      true,
    );
    await expect(
      session
        .readFile({ path: '/mnt/shared-data/data.txt' })
        .then((bytes) => new TextDecoder().decode(bytes)),
    ).resolves.toBe('hello');
    await expect(
      session.listDir({ path: '/mnt/shared-data' }),
    ).resolves.toEqual([
      {
        name: 'data.txt',
        path: '/mnt/shared-data/data.txt',
        type: 'file',
      },
    ]);
    await expect(
      session.viewImage({ path: '/mnt/shared-data/picture.png' }),
    ).resolves.toMatchObject({
      type: 'image',
      image: {
        data: pngBytes,
        mediaType: 'image/png',
      },
    });
    await expect(
      session.viewImage({ path: '/mnt/shared-data/fake.png' }),
    ).rejects.toThrow(
      'Unsupported image format for view_image: /mnt/shared-data/fake.png',
    );
    await expect(
      session.viewImage({ path: '/mnt/shared-data/payload.bin' }),
    ).resolves.toMatchObject({
      type: 'image',
      image: {
        data: pngBytes,
        mediaType: 'image/png',
      },
    });
    await editor.deleteFile({
      type: 'delete_file',
      path: '/mnt/shared-data/data.txt',
    });

    const dockerCommands = childProcessMocks.spawn.mock.calls.map(([, args]) =>
      (args as string[]).at(-1),
    );
    expect(dockerCommands).toEqual(
      expect.arrayContaining([
        "test -e '/mnt/shared-data/data.txt'",
        "base64 -- '/mnt/shared-data/data.txt'",
        "find '/mnt/shared-data' -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n'",
        "base64 -- '/mnt/shared-data/picture.png'",
        "base64 -- '/mnt/shared-data/fake.png'",
        "base64 -- '/mnt/shared-data/payload.bin'",
        "rm -f -- '/mnt/shared-data/data.txt'",
      ]),
    );
  });

  it('rejects split path grants when applying a manifest delta', async () => {
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
          extraPathGrants: [
            {
              path: '/mnt/shared-data',
              hostPath: rootDir,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'unsupported_feature',
      details: {
        provider: 'DockerSandboxClient',
        feature: 'manifest.extraPathGrants.hostPath',
        path: '/mnt/shared-data',
      },
    });
    expect(session.state.manifest.extraPathGrants).toEqual([]);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();

    const splitSession = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: rootDir,
          },
        ],
      }),
    );
    await expect(
      splitSession.applyManifest(
        new Manifest({
          extraPathGrants: [
            {
              path: '/mnt/shared-data',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'unsupported_feature',
      details: {
        feature: 'manifest.extraPathGrants.hostPath',
        path: '/mnt/shared-data',
      },
    });
    expect(splitSession.state.manifest.extraPathGrants).toEqual([
      {
        path: '/mnt/shared-data',
        hostPath: rootDir,
        readOnly: false,
      },
    ]);
  });

  it('allows live-session reuse with unchanged ordinary path grants', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    const activeChild = dockerSpawnResult({ remainActive: true });
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    childProcessMocks.spawn.mockReturnValue(activeChild);
    const sharedPath = join(rootDir, 'shared-data');
    await mkdir(sharedPath, { recursive: true });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: sharedPath,
            readOnly: true,
          },
        ],
      }),
    );
    const activeProcess = await session.exec({
      cmd: 'sleep 60',
      yieldTimeMs: 0,
    });

    expect(activeProcess.sessionId).toBe(1);
    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(true);
    await expect(
      client.canReusePreservedOwnedSession(session.state, {
        clientOptions: { image: 'different-image' },
      }),
    ).resolves.toBe(false);
    await expect(
      client.canReusePreservedOwnedSession(session.state, {
        clientOptions: { exposedPorts: [8080] },
      }),
    ).resolves.toBe(false);
    await expect(
      client.canReusePreservedOwnedSession(session.state, {
        clientOptions: { networkMode: 'none' },
      }),
    ).resolves.toBe(false);
    expect(activeChild.kill).not.toHaveBeenCalled();
    expect(runCount).toBe(1);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );

    await session.close();
  });

  it('verifies actual Docker network isolation before live reuse', async () => {
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          inspections.set('container-isolated', dockerRunInspection(args));
          return success('container-isolated\n');
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      networkMode: 'none',
    });
    const session = await client.create(new Manifest());
    const inspection = inspections.get('container-isolated')!;

    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(true);
    await expect(
      client.canReusePreservedOwnedSession(session.state, {
        clientOptions: { networkMode: undefined },
      }),
    ).resolves.toBe(true);

    inspection.networks = { bridge: {} };
    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(false);

    inspection.networks = { none: {} };
    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(true);

    inspection.networkMode = 'bridge';
    inspection.networks = {};
    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(false);

    inspection.networkMode = 'none';
    inspection.networks = null;
    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(false);

    await session.close();
  });

  it('replaces an owned container whose network isolation no longer matches', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      networkMode: 'none',
    });
    const session = await client.create(new Manifest());
    const firstInspection = inspections.get('container-1')!;
    firstInspection.networkMode = 'bridge';
    firstInspection.networks = { bridge: {} };

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-2');
    expect(resumed.state.networkMode).toBe('none');
    expect(inspections.get('container-2')).toMatchObject({
      networkMode: 'none',
      networks: {},
    });
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-1'],
      { timeoutMs: 30_000 },
    );

    await resumed.close();
  });

  it('applies trusted network isolation when resuming explicit session state', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest());

    const resumed = await client.resume(session.state, {
      clientOptions: { networkMode: 'none' },
    });

    expect(resumed.state.containerId).toBe('container-2');
    expect(resumed.state.networkMode).toBe('none');
    expect(inspections.get('container-1')).toMatchObject({
      networkMode: 'bridge',
    });
    expect(inspections.get('container-2')).toMatchObject({
      networkMode: 'none',
      networks: {},
    });
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'container-1'],
      { timeoutMs: 30_000 },
    );

    await resumed.close();
  });

  it('keeps constructor network isolation when per-run resume mode is undefined', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          return dockerInspectionResult(inspections, args) ?? success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const sourceClient = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const sourceSession = await sourceClient.create(new Manifest());
    const isolatedClient = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      networkMode: 'none',
    });

    const resumed = await isolatedClient.resume(sourceSession.state, {
      clientOptions: { networkMode: undefined },
    });

    expect(resumed.state.containerId).toBe('container-2');
    expect(resumed.state.networkMode).toBe('none');
    expect(inspections.get('container-2')).toMatchObject({
      networkMode: 'none',
      networks: {},
    });

    await resumed.close();
  });

  it('rejects trusted network isolation conflicts before explicit resume side effects', async () => {
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return success('container-1\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({ workspaceBaseDir: rootDir });
    const session = await client.create(new Manifest(), {
      exposedPorts: [8080],
    });
    processMocks.runSandboxProcess.mockClear();

    await expect(
      client.resume(session.state, {
        clientOptions: { networkMode: 'none' },
      }),
    ).rejects.toThrow('exposedPorts cannot be used when networkMode is "none"');
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();

    await session.close();
  });

  it.each([{ exposedPorts: [] }, { exposedPorts: [9090] }])(
    'rejects explicit resume port changes before side effects: $exposedPorts',
    async ({ exposedPorts }) => {
      processMocks.runSandboxProcess.mockImplementation(
        async (_command: string, args: string[]) => {
          if (args[0] === 'version') {
            return success('Docker version test');
          }
          if (args[0] === 'run') {
            return success('container-1\n');
          }
          if (args[0] === 'rm') {
            return success();
          }
          return failure('unexpected docker command');
        },
      );
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        snapshot: new NoopSnapshotSpec(),
      });
      const session = await client.create(new Manifest(), {
        exposedPorts: [8080],
      });
      const deserialized = await client.deserializeSessionState(
        await client.serializeSessionState(session.state),
      );
      expect(deserialized.configuredExposedPorts).toEqual([8080]);
      processMocks.runSandboxProcess.mockClear();

      await expect(
        client.resume(deserialized, {
          clientOptions: { exposedPorts },
        }),
      ).rejects.toThrow(
        'exposedPorts cannot be changed when resuming explicit session state',
      );
      expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();

      await session.close();
    },
  );

  it('preserves live reuse after runtime files are materialized', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
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
    });
    const session = await client.create(new Manifest());
    await session.applyManifest(
      new Manifest({
        entries: {
          'runtime.txt': {
            type: 'file',
            content: 'runtime',
          },
        },
      }),
    );

    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(true);
    expect(runCount).toBe(1);

    await session.close();
  });

  it('restarts when container account provisioning changes', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm' || args[0] === 'exec') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());

    const resumed = await client.resume({
      ...session.state,
      manifest: new Manifest({
        users: [{ name: 'sandbox-user' }],
      }),
    });

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['exec', '-u', 'root', 'container-2']),
      expect.anything(),
    );
  });

  it.each([
    ['replaced persistent', 'old', 'new', false],
    ['replaced ephemeral', 'old', 'new', true],
    ['added', undefined, 'new', false],
    ['removed', 'old', undefined, false],
  ])(
    'rejects changed %s non-mount entries without removing the container',
    async (_kind, initialContent, currentContent, ephemeral) => {
      let runCount = 0;
      const inspections = new Map<string, DockerContainerInspection>();
      processMocks.runSandboxProcess.mockImplementation(
        async (_command: string, args: string[]) => {
          if (args[0] === 'version') {
            return success('Docker version test');
          }
          if (args[0] === 'run') {
            runCount += 1;
            const containerId = `container-${runCount}`;
            inspections.set(containerId, dockerRunInspection(args));
            return success(`${containerId}\n`);
          }
          if (args[0] === 'inspect') {
            const inspection = dockerInspectionResult(inspections, args);
            if (inspection) {
              return inspection;
            }
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
      });
      const session = await client.create(
        new Manifest({
          entries:
            initialContent === undefined
              ? {}
              : {
                  'config.txt': {
                    type: 'file',
                    content: initialContent,
                    ephemeral,
                  },
                },
        }),
      );

      const changedState = {
        ...session.state,
        manifest: new Manifest({
          entries:
            currentContent === undefined
              ? {}
              : {
                  'config.txt': {
                    type: 'file' as const,
                    content: currentContent,
                    ephemeral,
                  },
                },
        }),
      };

      await expect(
        client.canReusePreservedOwnedSession(changedState, {
          revalidateManifestEntries: true,
        }),
      ).rejects.toThrow(
        'Docker sandbox resume cannot apply changes to non-mount manifest entries',
      );
      expect(runCount).toBe(1);
      expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['rm', '-f', 'container-1']),
        expect.anything(),
      );

      await session.close();
    },
  );

  it('rejects a fully swapped running Docker session without deleting it', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const sharedPath = join(rootDir, 'shared-data');
    await mkdir(sharedPath);
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: new NoopSnapshotSpec(),
    });
    const manifest = new Manifest({
      extraPathGrants: [{ path: sharedPath, readOnly: true }],
    });
    const firstSession = await client.create(manifest);
    const secondSession = await client.create(manifest);
    const firstProviderState = await client.serializeSessionState(
      firstSession.state,
    );
    const secondProviderState = await client.serializeSessionState(
      secondSession.state,
    );
    const swappedEnvelope = toSessionStateEnvelope(
      client.backendId,
      firstSession.state,
      firstProviderState,
    );
    swappedEnvelope.providerState = {
      ...secondProviderState,
    };
    (swappedEnvelope as unknown as Record<string, unknown>).sessionIdentity =
      secondSession.state.sessionIdentity;
    const swappedState = (await deserializeSandboxSessionStateEntry(
      client,
      {
        backendId: client.backendId,
        currentAgentKey: 'SandboxWorker',
        currentAgentName: 'SandboxWorker',
        sessionState: swappedEnvelope,
      },
      manifest,
    )) as DockerSandboxSessionState;

    await expect(
      client.canReusePreservedOwnedSession(swappedState),
    ).resolves.toBe(false);
    expect(swappedState).not.toHaveProperty('sessionIdentity');

    await expect(client.resume(swappedState)).rejects.toThrow(
      'Docker sandbox resources are unavailable and no local snapshot could be restored.',
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-2']),
      expect.anything(),
    );
    expect(runCount).toBe(2);

    await firstSession.close();
    await secondSession.close();
  });

  it('reuses a legacy zero-grant container with exact declared bind mounts', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
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
    });
    const declaredSource = join(rootDir, 'declared');
    await mkdir(declaredSource);
    const session = await client.create(
      new Manifest({
        entries: {
          declared: {
            type: 'mount',
            source: declaredSource,
            mountPath: 'mounted/declared',
            mountStrategy: { type: 'local_bind' },
          },
        },
      }),
    );
    const inspection = inspections.get(session.state.containerId)!;
    delete inspection.labels[dockerSessionIdentityLabel];
    delete inspection.labels[dockerMountAuthorityFingerprintLabel];
    delete session.state.sessionIdentity;

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-1');
    expect(runCount).toBe(1);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );

    await resumed.close();
  });

  it('rejects a container that lost its current session identity label', async () => {
    let runCount = 0;
    let workspaceSource = '';
    const declaredSource = join(rootDir, 'declared');
    await mkdir(declaredSource);
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
          if (args[4] === '{{json .Config.Labels}}') {
            return success(JSON.stringify({ 'openai-agents-sandbox': 'true' }));
          }
          if (args[4] === '{{json .Mounts}}') {
            return success(
              JSON.stringify([
                {
                  Type: 'bind',
                  Source: workspaceSource,
                  Destination: '/workspace',
                  RW: true,
                },
                {
                  Type: 'bind',
                  Source: declaredSource,
                  Destination: '/workspace/mounted/declared',
                  RW: false,
                },
              ]),
            );
          }
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
    });
    const session = await client.create(
      new Manifest({
        entries: {
          declared: {
            type: 'mount',
            source: declaredSource,
            mountPath: 'mounted/declared',
            mountStrategy: { type: 'local_bind' },
          },
        },
      }),
    );
    workspaceSource = session.state.workspaceRootPath;

    await expect(client.resume(session.state)).rejects.toThrow(
      'Docker sandbox container identity could not be verified',
    );
    expect(runCount).toBe(1);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );

    await session.close();
  });

  it('restarts an identity-verified container without a mount fingerprint', async () => {
    let runCount = 0;
    let workspaceSource = '';
    const undeclaredSource = join(rootDir, 'undeclared');
    await mkdir(undeclaredSource);
    const labelsByContainer = new Map<string, Record<string, string>>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          labelsByContainer.set(containerId, dockerRunLabels(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          if (args[4] === '{{json .Config.Labels}}') {
            return success(
              JSON.stringify(labelsByContainer.get(args[5]!) ?? {}),
            );
          }
          if (args[4] === '{{json .Mounts}}') {
            return success(
              JSON.stringify([
                {
                  Type: 'bind',
                  Source: workspaceSource,
                  Destination: '/workspace',
                  RW: true,
                },
                {
                  Type: 'bind',
                  Source: undeclaredSource,
                  Destination: '/mnt/undeclared',
                  RW: true,
                },
              ]),
            );
          }
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
    });
    const session = await client.create(new Manifest());
    workspaceSource = session.state.workspaceRootPath;
    delete labelsByContainer.get(session.state.containerId)?.[
      dockerMountAuthorityFingerprintLabel
    ];
    expect(
      labelsByContainer.get(session.state.containerId)?.[
        dockerSessionIdentityLabel
      ],
    ).toBe(session.state.sessionIdentity);

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
  });

  it('restarts when persisted state omits a manifest bind mount', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const declaredSource = join(rootDir, 'declared');
    await mkdir(declaredSource);
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          declared: {
            type: 'mount',
            source: declaredSource,
            mountPath: 'mounted/declared',
            mountStrategy: { type: 'local_bind' },
          },
        },
      }),
    );

    const unchanged = await client.resume(session.state);
    const resumed = await client.resume({
      ...unchanged.state,
      manifest: new Manifest(),
    });

    expect(unchanged.state.containerId).toBe('container-1');
    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
    const secondRunArgs = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    )[1]?.[1];
    expect(secondRunArgs).not.toContain(
      `type=bind,source=${await realpath(declaredSource)},target=/workspace/mounted/declared,readonly`,
    );
  });

  it('restarts when a path-granted session changes a non-bind mount', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm' || args[0] === 'volume') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const sharedPath = join(rootDir, 'shared-data');
    await mkdir(sharedPath);
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          logs: {
            type: 's3_mount',
            bucket: 'agent-logs',
            mountPath: '/mnt/logs',
            mountStrategy: dockerVolumeMountStrategy({
              driver: 'rclone',
            }),
          },
        },
        extraPathGrants: [{ path: sharedPath, readOnly: true }],
      }),
    );

    const resumed = await client.resume({
      ...session.state,
      manifest: new Manifest({
        extraPathGrants: [{ path: sharedPath, readOnly: true }],
      }),
    });

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
  });

  it('restarts a running container when path grant mount policy changes', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const sharedPath = join(rootDir, 'shared-data');
    await mkdir(sharedPath, { recursive: true });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: sharedPath,
            readOnly: false,
          },
        ],
      }),
    );
    const reboundState = rebindPersistedPathGrants(
      session.state,
      new Manifest({
        extraPathGrants: [
          {
            path: sharedPath,
            readOnly: true,
          },
        ],
      }),
    );

    const resumed = await client.resume(reboundState);
    const resumedAgain = await client.resume(resumed.state);

    expect(resumed.state.containerId).toBe('container-2');
    expect(resumedAgain.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
  });

  it('restarts when persisted state omits a container-mounted path grant', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const retainedPath = join(rootDir, 'retained-data');
    const omittedPath = join(rootDir, 'omitted-data');
    await mkdir(retainedPath, { recursive: true });
    await mkdir(omittedPath, { recursive: true });
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          { path: retainedPath, readOnly: true },
          { path: omittedPath, readOnly: true },
        ],
      }),
    );

    const resumed = await client.resume({
      ...session.state,
      manifest: new Manifest({
        extraPathGrants: [{ path: retainedPath, readOnly: true }],
      }),
    });

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    const secondRunArgs = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    )[1]?.[1];
    const resolvedRetainedPath = await realpath(retainedPath);
    const resolvedOmittedPath = await realpath(omittedPath);
    expect(secondRunArgs).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${resolvedRetainedPath},target=${retainedPath},readonly`,
      ]),
    );
    expect(secondRunArgs).not.toContain(
      `type=bind,source=${resolvedOmittedPath},target=${omittedPath},readonly`,
    );
  });

  it('restarts a running container before using rebound path grants', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
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
    });
    const originalHostPath = join(rootDir, 'original-source');
    const reboundHostPath = join(rootDir, 'rebound-source');
    await mkdir(originalHostPath);
    await mkdir(reboundHostPath);
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: originalHostPath,
            readOnly: false,
          },
        ],
      }),
    );

    const resumed = await client.resume({
      ...session.state,
      manifest: new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: reboundHostPath,
            readOnly: true,
          },
        ],
      }),
    });

    expect(resumed.state.containerId).toBe('container-2');
    await expect(
      client.canReusePreservedOwnedSession({
        ...session.state,
        manifest: new Manifest({
          extraPathGrants: [
            {
              path: '/mnt/shared-data',
              hostPath: reboundHostPath,
              readOnly: true,
            },
          ],
        }),
      }),
    ).resolves.toBe(false);
    const calls = processMocks.runSandboxProcess.mock.calls;
    const removeIndex = calls.findIndex(
      ([, args]) => args[0] === 'rm' && args[2] === 'container-1',
    );
    const secondRunIndex = calls.findIndex(
      ([, args], index) => index > removeIndex && args[0] === 'run',
    );
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(secondRunIndex).toBeGreaterThan(removeIndex);
    const resolvedReboundHostPath = await realpath(reboundHostPath);
    expect(calls[secondRunIndex]?.[1]).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${resolvedReboundHostPath},target=/mnt/shared-data,readonly`,
      ]),
    );
  });

  it('restarts when a path grant host symlink is retargeted', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const firstSource = join(rootDir, 'first-source');
    const secondSource = join(rootDir, 'second-source');
    const hostPath = join(rootDir, 'current-source');
    await mkdir(firstSource);
    await mkdir(secondSource);
    await symlink(firstSource, hostPath);
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath,
            readOnly: true,
          },
        ],
      }),
    );
    await unlink(hostPath);
    await symlink(secondSource, hostPath);

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    const secondRunArgs = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    )[1]?.[1];
    expect(secondRunArgs).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${await realpath(secondSource)},target=/mnt/shared-data,readonly`,
      ]),
    );
    expect(secondRunArgs).not.toContain(
      `type=bind,source=${await realpath(firstSource)},target=/mnt/shared-data,readonly`,
    );
  });

  it('restarts when a path grant source is replaced at the same real path', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const sharedPath = join(rootDir, 'shared-data');
    const previousSharedPath = join(rootDir, 'previous-shared-data');
    await mkdir(sharedPath);
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: sharedPath,
            readOnly: true,
          },
        ],
      }),
    );
    await rename(sharedPath, previousSharedPath);
    await mkdir(sharedPath);

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
  });

  it('declines live reuse when a path grant source disappears', async () => {
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          inspections.set('container-1', dockerRunInspection(args));
          return success('container-1\n');
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
          return success('true\n');
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const sharedPath = join(rootDir, 'shared-data');
    await mkdir(sharedPath);
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: sharedPath,
            readOnly: true,
          },
        ],
      }),
    );
    await rm(sharedPath, { recursive: true });

    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(false);

    await session.close();
  });

  it('restarts when a path grant source changes during container inspection', async () => {
    let runCount = 0;
    let sourceReplaced = false;
    const inspections = new Map<string, DockerContainerInspection>();
    const sharedPath = join(rootDir, 'shared-data');
    const previousSharedPath = join(rootDir, 'previous-shared-data');
    await mkdir(sharedPath);
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          if (args[4] === '{{json .Config.Labels}}') {
            if (!sourceReplaced) {
              sourceReplaced = true;
              await rename(sharedPath, previousSharedPath);
              await mkdir(sharedPath);
            }
          }
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
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
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: sharedPath,
            readOnly: true,
          },
        ],
      }),
    );

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    expect(processMocks.runSandboxProcess).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
  });

  it('rejects foreign host paths before checking Docker or creating a workspace', async () => {
    const foreignHostPath = process.platform === 'win32' ? '/data' : 'C:\\data';
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [
            {
              path: '/mnt/shared-data',
              hostPath: foreignHostPath,
              readOnly: true,
            },
          ],
        }),
      ),
    ).rejects.toThrow(/hostPath must (?:be absolute|be drive-qualified)/i);

    expect(processMocks.runSandboxProcess).not.toHaveBeenCalled();
    await expect(readdir(rootDir)).resolves.toEqual([]);
  });

  it('rejects direct resume when native host paths need trusted rebinding', async () => {
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
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: rootDir,
            readOnly: true,
          },
        ],
      }),
    );

    const serialized = JSON.parse(
      JSON.stringify(await client.serializeSessionState(session.state)),
    ) as Record<string, unknown>;
    const deserialized = await client.deserializeSessionState(serialized);

    expect(serialized.__openaiAgentsRedactedHostPathGrantPaths).toEqual([
      '/mnt/shared-data',
    ]);
    expect(serialized.sessionIdentity).toBe(session.state.sessionIdentity);
    expect(session.state.materializedEntriesFingerprint).toBeDefined();
    expect(serialized).not.toHaveProperty('materializedEntriesFingerprint');
    expect(deserialized.sessionIdentity).toBe(session.state.sessionIdentity);
    expect(deserialized.materializedEntriesFingerprint).toBeUndefined();
    expect(deserialized.manifest.extraPathGrants).toEqual([
      {
        path: '/mnt/shared-data',
        readOnly: true,
      },
    ]);
    await expect(client.resume(deserialized)).rejects.toThrow(
      'Sandbox session state requires trusted hostPath values for these path grants: /mnt/shared-data.',
    );
  });

  it('limits dynamically applied path grants to host filesystem helpers', async () => {
    let runCount = 0;
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
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
    });
    const session = await client.create(new Manifest());

    await session.applyManifest(
      new Manifest({
        extraPathGrants: [{ path: rootDir }],
      }),
    );

    await expect(session.pathExists(rootDir)).resolves.toBe(true);
    await expect(
      session.execCommand({
        cmd: 'pwd',
        workdir: rootDir,
      }),
    ).rejects.toThrow();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();

    const resumed = await client.resume(session.state);

    expect(resumed.state.containerId).toBe('container-2');
    expect(runCount).toBe(2);
    const secondRunCall = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    )[1];
    const resolvedRootDir = await realpath(rootDir);
    expect(secondRunCall?.[1]).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,source=${resolvedRootDir},target=${rootDir}`,
      ]),
    );
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
        }).withInContainerMountBroadCredentialExposureAcknowledged('s3files'),
      ),
    ).rejects.toThrow(/requires Docker privileges/);
  });

  it('uses the resolved absolute mount path for runAs and mount apply', async () => {
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
          bootstrap: s3Mount({
            bucket: 'bootstrap',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountStrategy: inContainerMountStrategy(),
          }),
        },
      }).withInContainerMountCredentialExposureAcknowledged('bootstrap'),
    );
    childProcessMocks.spawn.mockClear();
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = (args as string[]).join(' ');
      if (command.includes('realpath -m -- /mnt/absolute')) {
        return dockerSpawnResult({ stdout: '/mnt/resolved\n', status: 0 });
      }
      if (command.includes("OPENAI_AGENTS_MOUNT_PATH='/workspace/failed'")) {
        return dockerSpawnResult({ stderr: 'mount failed', status: 1 });
      }
      return dockerSpawnResult({ status: 0 });
    });

    await session.applyManifest(
      new Manifest({
        entries: {
          mounted: s3Mount({
            bucket: 'mounted',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountPath: '/mnt/absolute',
            mountStrategy: inContainerMountStrategy(),
          }),
        },
      }).withInContainerMountCredentialExposureAcknowledged(
        'bootstrap',
        '/mnt/absolute',
        '/mnt/resolved',
      ),
      'node',
    );

    const commands = childProcessMocks.spawn.mock.calls.map(([, args]) =>
      (args as string[]).join(' '),
    );
    const mkdirIndex = commands.findIndex((command) =>
      command.includes("mkdir -p -- '/mnt/resolved'"),
    );
    const chownIndex = commands.findIndex((command) =>
      command.includes("chown -R 'node':'node' -- '/mnt/resolved'"),
    );
    const mountIndex = commands.findIndex(
      (command) =>
        command.includes('/mnt/resolved') && command.includes('rclone'),
    );
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(chownIndex).toBeGreaterThan(mkdirIndex);
    expect(mountIndex).toBeGreaterThan(chownIndex);

    const mounted = session.state.manifest.entries.mounted as unknown as {
      accessKeyId: string;
    };
    mounted.accessKeyId = 'rotated-access-key';
    expect(
      liveMountCredentialAuthorityMatches(
        session.state.manifest,
        session.state.manifest,
      ),
    ).toBe(false);
  });

  it('force-removes and poisons Docker after a partial mount failure', async () => {
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
      if (command.includes('/workspace/second') && command.includes('rclone')) {
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
          bootstrap: s3Mount({
            bucket: 'bootstrap',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountStrategy: inContainerMountStrategy(),
          }),
        },
      }).withInContainerMountCredentialExposureAcknowledged('bootstrap'),
    );
    childProcessMocks.spawn.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            first: s3Mount({
              bucket: 'first',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
              mountStrategy: inContainerMountStrategy(),
            }),
            second: s3Mount({
              bucket: 'second',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
              mountStrategy: inContainerMountStrategy(),
            }),
          },
        }).withInContainerMountCredentialExposureAcknowledged(
          'bootstrap',
          'first',
          'second',
        ),
      ),
    ).rejects.toThrow(/exit status 1/u);

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
    expect(
      processMocks.runSandboxProcess.mock.calls.some(
        ([, args]) => (args as string[])[0] === 'rm',
      ),
    ).toBe(true);
    await expect(session.execCommand({ cmd: 'true' })).rejects.toThrow(
      /privileged manifest transition failed/u,
    );
    await expect(client.serializeSessionState(session.state)).rejects.toThrow(
      /privileged manifest transition failed/u,
    );
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
          bootstrap: s3Mount({
            bucket: 'bootstrap',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountStrategy: inContainerMountStrategy(),
          }),
        },
      }).withInContainerMountCredentialExposureAcknowledged('bootstrap'),
    );
    childProcessMocks.spawn.mockClear();
    childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
      const command = (args as string[]).join(' ');
      if (command.includes('/workspace/failed') && command.includes('rclone')) {
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
            failed: s3Mount({
              bucket: 'failed',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
              mountStrategy: inContainerMountStrategy(),
            }),
          },
        }).withInContainerMountCredentialExposureAcknowledged(
          'bootstrap',
          'failed',
        ),
      ),
    ).rejects.toThrow(/exit status 1/u);

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
            accountKey: 'account-key',
            mountStrategy: inContainerMountStrategy({
              pattern: {
                type: 'fuse',
                cachePath: 'cache/blobfuse',
              },
            }),
          },
        },
      }).withInContainerMountCredentialExposureAcknowledged('azure'),
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

  it('restores untrusted running RunState without touching its live resources', async () => {
    let runCount = 0;
    let resolvedSecret = 'initial-secret';
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
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
      image: 'client:image',
      exposedPorts: [3000],
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          SECRET_ENV: {
            value: '',
            resolve: () => resolvedSecret,
            ephemeral: true,
          },
        },
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'snapshot\n',
          },
        },
      }),
    );

    const serialized = await client.serializeSessionState(session.state);
    serialized.image = 'untrusted:image';
    serialized.environment = {
      SECRET_ENV: 'stale-secret',
      UNTRUSTED_ENV: 'untrusted-value',
    };
    serialized.defaultUser = 'root';
    serialized.configuredExposedPorts = [9999];
    expect(serialized.snapshotFingerprint).toEqual(expect.any(String));
    expect(serialized.snapshotFingerprintVersion).toBe(
      'workspace_tree_sha256_v1',
    );

    await writeFile(
      join(session.state.workspaceRootPath, 'notes.txt'),
      'drifted\n',
      'utf8',
    );
    resolvedSecret = 'refreshed-secret';

    const persistedState = (await deserializeSandboxSessionStateEntry(
      client,
      {
        backendId: client.backendId,
        currentAgentKey: 'SandboxWorker',
        currentAgentName: 'SandboxWorker',
        sessionState: toSessionStateEnvelope(
          client.backendId,
          session.state,
          serialized,
        ),
      },
      session.state.manifest,
      {
        clientOptions: {
          image: 'run:image',
          exposedPorts: [4000],
          workspaceBaseDir: rootDir,
        },
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    )) as DockerSandboxSessionState;

    const restored = await client.resume(persistedState);

    expect(restored.state.containerId).toBe('container-2');
    expect(restored.state.workspaceRootPath).not.toBe(
      session.state.workspaceRootPath,
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
    expect(
      processMocks.runSandboxProcess.mock.calls.some(
        ([, args]) => args[0] === 'inspect',
      ),
    ).toBe(false);
    expect(restored.state.image).toBe('run:image');
    expect(restored.state.environment).toEqual({
      SECRET_ENV: 'refreshed-secret',
      UNTRUSTED_ENV: 'untrusted-value',
    });
    expect(restored.state.defaultUser).not.toBe('root');
    expect(restored.state.configuredExposedPorts).toEqual([4000]);
    const restoredRunArgs = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    )[1]?.[1];
    expect(restoredRunArgs).toEqual(
      expect.arrayContaining([
        '-e',
        'SECRET_ENV=refreshed-secret',
        '-p',
        '127.0.0.1::4000',
        'run:image',
      ]),
    );
    expect(restoredRunArgs).not.toContain('stale-secret');
    expect(restoredRunArgs).toEqual(
      expect.arrayContaining(['-e', 'UNTRUSTED_ENV=untrusted-value']),
    );
    expect(restoredRunArgs).not.toContain('127.0.0.1::9999');
    expect(restoredRunArgs).not.toContain('untrusted:image');
    await expect(
      readFile(join(session.state.workspaceRootPath, 'notes.txt'), 'utf8'),
    ).resolves.toBe('drifted\n');
    await expect(
      readFile(join(restored.state.workspaceRootPath, 'notes.txt'), 'utf8'),
    ).resolves.toBe('snapshot\n');

    await restored.close();
    await session.close();
  });

  it('recreates Docker RunState with trusted network isolation', async () => {
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
    const manifest = new Manifest({
      entries: {
        'notes.txt': {
          type: 'file',
          content: 'snapshot\n',
        },
      },
    });
    const session = await client.create(manifest);
    const serialized = await client.serializeSessionState(session.state);
    delete serialized.networkMode;

    const persistedState = (await deserializeSandboxSessionStateEntry(
      client,
      {
        backendId: client.backendId,
        currentAgentKey: 'SandboxWorker',
        currentAgentName: 'SandboxWorker',
        sessionState: toSessionStateEnvelope(
          client.backendId,
          session.state,
          serialized,
        ),
      },
      manifest,
      {
        clientOptions: {
          networkMode: 'none',
          workspaceBaseDir: rootDir,
        },
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    )) as DockerSandboxSessionState;

    expect(persistedState.networkMode).toBeUndefined();
    const restored = await client.resume(persistedState);
    const runCalls = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    );

    expect(restored.state.networkMode).toBe('none');
    expect(runCalls[0]?.[1]).not.toContain('--network');
    expect(runCalls[1]?.[1]).toEqual(
      expect.arrayContaining(['--network', 'none']),
    );
    expect(
      processMocks.runSandboxProcess.mock.calls.some(
        ([, args]) => args[0] === 'inspect',
      ),
    ).toBe(false);

    await restored.close();
    await session.close();
  });

  it('resolves environment values once while restoring Docker RunState', async () => {
    class DockerSecretReference extends EnvValueReference {
      static readonly type = 'test.docker_run_state_secret_reference';

      constructor(readonly key: string) {
        super({ ephemeral: true });
      }

      override serialize(): Record<string, unknown> {
        return { key: this.key };
      }

      override async resolve(): Promise<string> {
        resolveCount += 1;
        return `credential-${resolveCount}:${this.key}`;
      }
    }

    let runCount = 0;
    let resolveCount = 0;
    let ordinaryResolveCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          return success(`container-${runCount}\n`);
        }
        if (args[0] === 'rm') {
          return success();
        }
        return failure('unexpected docker command');
      },
    );
    const unregister = registerEnvValueReference(
      DockerSecretReference,
      (payload) => {
        if (typeof payload.key !== 'string') {
          throw new TypeError('Docker secret reference key must be a string.');
        }
        return new DockerSecretReference(payload.key);
      },
    );
    try {
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      });
      const session = await client.create(
        new Manifest({
          environment: {
            TOKEN: new DockerSecretReference('openai-key'),
            ROTATING_TOKEN: async () => {
              ordinaryResolveCount += 1;
              return `rotating-credential-${ordinaryResolveCount}`;
            },
          },
        }),
      );
      const serialized = await client.serializeSessionState(session.state);
      resolveCount = 0;
      ordinaryResolveCount = 0;

      const persistedState = (await deserializeSandboxSessionStateEntry(
        client,
        {
          backendId: client.backendId,
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          sessionState: toSessionStateEnvelope(
            client.backendId,
            session.state,
            serialized,
          ),
        },
        session.state.manifest,
      )) as DockerSandboxSessionState;
      expect(resolveCount).toBe(1);
      expect(ordinaryResolveCount).toBe(0);

      const restored = await client.resume(persistedState);

      expect(resolveCount).toBe(1);
      expect(ordinaryResolveCount).toBe(1);
      expect(restored.state.environment).toEqual({
        TOKEN: 'credential-1:openai-key',
        ROTATING_TOKEN: 'rotating-credential-1',
      });
      await restored.close();
      await session.close();
    } finally {
      unregister();
    }
  });

  it('preserves runtime-only environment while restoring protected Docker RunState', async () => {
    process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE = 'run-state-secret';
    let runCount = 0;
    let ordinaryResolveCount = 0;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          return success(`container-protected-run-state-${runCount}\n`);
        }
        if (args[0] === 'rm') {
          return success();
        }
        return success();
      },
    );
    const clientOptions = {
      processEnvironmentBindings: {
        SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
      },
    };
    const client = new DockerSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: { type: 'local', baseDir: rootDir },
    });
    const manifest = new Manifest({
      environment: {
        SANDBOX_TOKEN: new ProcessEnvValue({
          name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
        }),
        ROTATING_VALUE: async () => {
          ordinaryResolveCount += 1;
          return `ordinary-${ordinaryResolveCount}`;
        },
      },
    });
    const session = await client.create({ manifest, options: clientOptions });
    session.state.environment.RUNTIME_ENV = 'runtime-only';
    const serialized = await client.serializeSessionState(session.state);
    ordinaryResolveCount = 0;

    const persistedState = (await deserializeSandboxSessionStateEntry(
      client,
      {
        backendId: client.backendId,
        currentAgentKey: 'SandboxWorker',
        currentAgentName: 'SandboxWorker',
        sessionState: toSessionStateEnvelope(
          client.backendId,
          session.state,
          serialized,
        ),
      },
      manifest,
      { clientOptions },
    )) as DockerSandboxSessionState;
    const restored = await client.resume(persistedState, { clientOptions });

    expect(ordinaryResolveCount).toBe(1);
    expect(restored.state.environment).toEqual({
      RUNTIME_ENV: 'runtime-only',
      SANDBOX_TOKEN: 'run-state-secret',
      ROTATING_VALUE: 'ordinary-1',
    });
    const runCalls = processMocks.runSandboxProcess.mock.calls.filter(
      ([, args]) => args[0] === 'run',
    );
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]?.[1]).toEqual(
      expect.arrayContaining([
        '-e',
        'RUNTIME_ENV=runtime-only',
        '-e',
        'ROTATING_VALUE=ordinary-1',
      ]),
    );
    expect(runCalls[1]?.[1]).not.toContain('SANDBOX_TOKEN=run-state-secret');
    await restored.close();
    await session.close();
  });

  it('restores untrusted stopped RunState into new Docker resources', async () => {
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
    const originalWorkspaceRootPath = session.state.workspaceRootPath;
    const serialized = await client.serializeSessionState(session.state);
    const persistedState = (await deserializeSandboxSessionStateEntry(
      client,
      {
        backendId: client.backendId,
        currentAgentKey: 'SandboxWorker',
        currentAgentName: 'SandboxWorker',
        sessionState: toSessionStateEnvelope(
          client.backendId,
          session.state,
          serialized,
        ),
      },
      session.state.manifest,
    )) as DockerSandboxSessionState;

    const restored = await client.resume(persistedState);

    expect(restored.state.containerId).toBe('container-2');
    expect(restored.state.workspaceRootPath).not.toBe(
      originalWorkspaceRootPath,
    );
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );
    expect(
      processMocks.runSandboxProcess.mock.calls.some(
        ([, args]) => args[0] === 'inspect',
      ),
    ).toBe(false);
    await expect(
      readFile(join(restored.state.workspaceRootPath, 'notes.txt'), 'utf8'),
    ).resolves.toBe('snapshot\n');
  });

  it('removes a fresh RunState workspace when container restore fails', async () => {
    let failRun = false;
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          return failRun
            ? failure('container restore failed')
            : success('container-1\n');
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
    const session = await client.create(new Manifest());
    const serialized = await client.serializeSessionState(session.state);
    const persistedState = (await deserializeSandboxSessionStateEntry(
      client,
      {
        backendId: client.backendId,
        currentAgentKey: 'SandboxWorker',
        currentAgentName: 'SandboxWorker',
        sessionState: toSessionStateEnvelope(
          client.backendId,
          session.state,
          serialized,
        ),
      },
      session.state.manifest,
    )) as DockerSandboxSessionState;
    const entriesBeforeRestore = (await readdir(rootDir)).sort();
    failRun = true;

    await expect(client.resume(persistedState)).rejects.toThrow(
      'container restore failed',
    );

    expect((await readdir(rootDir)).sort()).toEqual(entriesBeforeRestore);
    failRun = false;
    await session.close();
  });

  it('does not restore explicit state when container status cannot be inspected', async () => {
    let runCount = 0;
    let failInspection = false;
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
          return failInspection
            ? failure('permission denied')
            : success('true\n');
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
    const session = await client.create(new Manifest());
    const serialized = await client.serializeSessionState(session.state);
    const persistedState = await client.deserializeSessionState(serialized);
    failInspection = true;

    await expect(client.resume(persistedState)).rejects.toThrow(
      'Failed to inspect Docker sandbox container: permission denied',
    );
    expect(runCount).toBe(1);
    expect(processMocks.runSandboxProcess).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'container-1']),
      expect.anything(),
    );

    failInspection = false;
    await session.close();
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
      rebindPersistedMountCredentials(
        await client.deserializeSessionState(serialized),
        session.state.manifest,
      ),
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
    const inspections = new Map<string, DockerContainerInspection>();
    processMocks.runSandboxProcess.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === 'version') {
          return success('Docker version test');
        }
        if (args[0] === 'run') {
          runCount += 1;
          const containerId = `container-${runCount}`;
          inspections.set(containerId, dockerRunInspection(args));
          return success(`${containerId}\n`);
        }
        if (args[0] === 'inspect') {
          const inspection = dockerInspectionResult(inspections, args);
          if (inspection) {
            return inspection;
          }
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
    await expect(
      client.serializeSessionState(session.state, {
        preserveOwnedSession: true,
        reuseLiveSession: false,
        willCloseAfterSerialize: true,
      }),
    ).rejects.toThrow(
      'Docker sandbox session cannot be preserved after live reuse was rejected because no restorable snapshot is configured.',
    );
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

  it('redacts trusted ambient mount credentials from Docker state', async () => {
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
      snapshot: new NoopSnapshotSpec(),
    });
    const manifest = new Manifest({
      entries: {
        remote: {
          type: 's3_mount',
          bucket: 'private',
          mountStrategy: inContainerMountStrategy(),
        },
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'AMBIENT_ACCESS_SENTINEL',
        AWS_SECRET_ACCESS_KEY: 'AMBIENT_SECRET_SENTINEL',
        SAFE_ENV: 'visible',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

    const session = await client.create(manifest);
    const serialized = await client.serializeSessionState(session.state);
    const serializedText = JSON.stringify(serialized);

    expect(serializedText).not.toContain('AMBIENT_ACCESS_SENTINEL');
    expect(serializedText).not.toContain('AMBIENT_SECRET_SENTINEL');
    expect(serialized.environment).toEqual({ SAFE_ENV: 'visible' });

    await session.applyManifest(
      new Manifest({
        environment: {
          AWS_ACCESS_KEY_ID: 'ROTATED_ACCESS_SENTINEL',
        },
      }),
    );
    await expect(
      client.canReusePreservedOwnedSession(session.state),
    ).resolves.toBe(false);
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
      .mockResolvedValueOnce(failure('pull failed'))
      .mockResolvedValueOnce(failure('no such container'));

    await expect(client.create(new Manifest())).rejects.toThrow(
      /Failed to start Docker sandbox container: pull failed/,
    );
  });
});
