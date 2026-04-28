import {
  Manifest,
  SandboxArchiveError,
  SandboxConfigurationError,
  SandboxMountError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  RunloopCloudBucketMountStrategy,
  RunloopSandboxClient,
  type RunloopUserParameters,
} from '../../src/sandbox/runloop';
import { decodeNativeSnapshotRef } from '../../src/sandbox/shared';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const runloopSdkConstructorMock = vi.fn();
const createMock = vi.fn();
const createFromBlueprintNameMock = vi.fn();
const createFromSnapshotMock = vi.fn();
const fromIdMock = vi.fn();
const blueprintCreateMock = vi.fn();
const blueprintListMock = vi.fn();
const blueprintFromIdMock = vi.fn();
const blueprintDeleteMock = vi.fn();
const blueprintListPublicMock = vi.fn();
const blueprintLogsMock = vi.fn();
const blueprintAwaitBuildCompleteMock = vi.fn();
const benchmarkCreateMock = vi.fn();
const benchmarkListMock = vi.fn();
const benchmarkListPublicMock = vi.fn();
const benchmarkFromIdMock = vi.fn();
const benchmarkRetrieveMock = vi.fn();
const benchmarkUpdateMock = vi.fn();
const benchmarkDefinitionsMock = vi.fn();
const benchmarkStartRunMock = vi.fn();
const benchmarkUpdateScenariosMock = vi.fn();
const secretCreateMock = vi.fn();
const secretListMock = vi.fn();
const secretUpdateMock = vi.fn();
const secretDeleteMock = vi.fn();
const secretRetrieveMock = vi.fn();
const networkPolicyCreateMock = vi.fn();
const networkPolicyListMock = vi.fn();
const networkPolicyFromIdMock = vi.fn();
const networkPolicyUpdateMock = vi.fn();
const networkPolicyDeleteMock = vi.fn();
const axonCreateMock = vi.fn();
const axonListMock = vi.fn();
const axonFromIdMock = vi.fn();
const axonPublishMock = vi.fn();
const axonQueryMock = vi.fn();
const axonBatchMock = vi.fn();
const execMock = vi.fn();
const readMock = vi.fn();
const writeMock = vi.fn();
const downloadMock = vi.fn();
const uploadMock = vi.fn();
const getTunnelUrlMock = vi.fn();
const enableTunnelMock = vi.fn();
const snapshotDiskMock = vi.fn();
const resumeMock = vi.fn();
const suspendMock = vi.fn();
const shutdownMock = vi.fn();
const RUNLOOP_HOME = '/home/user';
let includeCreateFromSnapshotApi = true;
let includeApiBenchmarks = true;
let includeLegacyBenchmarkFacade = false;

function runloopManifest(config: Record<string, unknown> = {}): Manifest {
  return new Manifest({
    root: RUNLOOP_HOME,
    ...config,
  });
}

function runloopCloudBucketManifest(
  entryOverrides: Record<string, unknown> = {},
): Manifest {
  return runloopManifest({
    entries: {
      data: {
        type: 's3_mount',
        bucket: 'agent-logs',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
        mountPath: 'mounted/logs',
        mountStrategy: new RunloopCloudBucketMountStrategy(),
        ...entryOverrides,
      },
    },
  });
}

function execResult(args: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}) {
  return {
    exitCode: args.exitCode,
    stdout: vi.fn().mockResolvedValue(args.stdout ?? ''),
    stderr: vi.fn().mockResolvedValue(args.stderr ?? ''),
  };
}

function mockRunloopDevbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'devbox_test',
    cmd: {
      exec: execMock,
    },
    file: {
      read: readMock,
      write: writeMock,
      download: downloadMock,
      upload: uploadMock,
    },
    net: {
      enableTunnel: enableTunnelMock,
    },
    getTunnelUrl: getTunnelUrlMock,
    snapshotDisk: snapshotDiskMock,
    resume: resumeMock,
    suspend: suspendMock,
    shutdown: shutdownMock,
    ...overrides,
  };
}

vi.mock('@runloop/api-client', () => ({
  RunloopSDK: class RunloopSDK {
    constructor(options?: Record<string, unknown>) {
      runloopSdkConstructorMock(options);
    }

    readonly devbox = {
      create: createMock,
      createFromBlueprintName: createFromBlueprintNameMock,
      ...(includeCreateFromSnapshotApi
        ? { createFromSnapshot: createFromSnapshotMock }
        : {}),
      fromId: fromIdMock,
    };
    readonly secret = {
      create: secretCreateMock,
      list: secretListMock,
      update: secretUpdateMock,
      delete: secretDeleteMock,
    };
    readonly blueprint = {
      create: blueprintCreateMock,
      list: blueprintListMock,
      fromId: blueprintFromIdMock,
    };
    readonly benchmark = includeLegacyBenchmarkFacade
      ? {
          create: benchmarkCreateMock,
          list: benchmarkListMock,
          fromId: benchmarkFromIdMock,
        }
      : undefined;
    readonly networkPolicy = {
      create: networkPolicyCreateMock,
      list: networkPolicyListMock,
      fromId: networkPolicyFromIdMock,
    };
    readonly axon = {
      create: axonCreateMock,
      list: axonListMock,
      fromId: axonFromIdMock,
    };
    readonly api = {
      blueprints: {
        listPublic: blueprintListPublicMock,
        logs: blueprintLogsMock,
        awaitBuildComplete: blueprintAwaitBuildCompleteMock,
      },
      ...(includeApiBenchmarks
        ? {
            benchmarks: {
              create: benchmarkCreateMock,
              list: benchmarkListMock,
              retrieve: benchmarkRetrieveMock,
              update: benchmarkUpdateMock,
              listPublic: benchmarkListPublicMock,
              definitions: benchmarkDefinitionsMock,
              startRun: benchmarkStartRunMock,
              updateScenarios: benchmarkUpdateScenariosMock,
            },
          }
        : {}),
      secrets: {
        retrieve: secretRetrieveMock,
      },
    };
  },
}));

describe('RunloopSandboxClient', () => {
  beforeEach(() => {
    runloopSdkConstructorMock.mockReset();
    createMock.mockReset();
    createFromBlueprintNameMock.mockReset();
    createFromSnapshotMock.mockReset();
    includeCreateFromSnapshotApi = true;
    fromIdMock.mockReset();
    blueprintCreateMock.mockReset();
    blueprintListMock.mockReset();
    blueprintFromIdMock.mockReset();
    blueprintDeleteMock.mockReset();
    blueprintListPublicMock.mockReset();
    blueprintLogsMock.mockReset();
    blueprintAwaitBuildCompleteMock.mockReset();
    benchmarkCreateMock.mockReset();
    benchmarkListMock.mockReset();
    benchmarkListPublicMock.mockReset();
    benchmarkFromIdMock.mockReset();
    benchmarkRetrieveMock.mockReset();
    benchmarkUpdateMock.mockReset();
    benchmarkDefinitionsMock.mockReset();
    benchmarkStartRunMock.mockReset();
    benchmarkUpdateScenariosMock.mockReset();
    secretCreateMock.mockReset();
    secretListMock.mockReset();
    secretUpdateMock.mockReset();
    secretDeleteMock.mockReset();
    secretRetrieveMock.mockReset();
    networkPolicyCreateMock.mockReset();
    networkPolicyListMock.mockReset();
    networkPolicyFromIdMock.mockReset();
    networkPolicyUpdateMock.mockReset();
    networkPolicyDeleteMock.mockReset();
    axonCreateMock.mockReset();
    axonListMock.mockReset();
    axonFromIdMock.mockReset();
    axonPublishMock.mockReset();
    axonQueryMock.mockReset();
    axonBatchMock.mockReset();
    execMock.mockReset();
    readMock.mockReset();
    writeMock.mockReset();
    downloadMock.mockReset();
    uploadMock.mockReset();
    getTunnelUrlMock.mockReset();
    enableTunnelMock.mockReset();
    snapshotDiskMock.mockReset();
    resumeMock.mockReset();
    suspendMock.mockReset();
    shutdownMock.mockReset();
    includeApiBenchmarks = true;
    includeLegacyBenchmarkFacade = false;

    const devbox = mockRunloopDevbox();

    createMock.mockResolvedValue(devbox);
    createFromBlueprintNameMock.mockResolvedValue(devbox);
    createFromSnapshotMock.mockResolvedValue({
      ...devbox,
      id: 'devbox_restored',
    });
    fromIdMock.mockReturnValue(devbox);
    blueprintCreateMock.mockResolvedValue({ id: 'bp_created' });
    blueprintListMock.mockResolvedValue([{ id: 'bp_test' }]);
    blueprintListPublicMock.mockResolvedValue([{ id: 'bp_public' }]);
    blueprintLogsMock.mockResolvedValue({ logs: [] });
    blueprintAwaitBuildCompleteMock.mockResolvedValue({ status: 'ready' });
    blueprintFromIdMock.mockReturnValue({
      delete: blueprintDeleteMock,
    });
    blueprintDeleteMock.mockResolvedValue({});
    benchmarkCreateMock.mockResolvedValue({ id: 'bench_created' });
    benchmarkListMock.mockResolvedValue([{ id: 'bench_test' }]);
    benchmarkListPublicMock.mockResolvedValue([{ id: 'bench_public' }]);
    benchmarkRetrieveMock.mockResolvedValue({ id: 'bench_test' });
    benchmarkFromIdMock.mockReturnValue({
      update: benchmarkUpdateMock,
      startRun: benchmarkStartRunMock,
    });
    benchmarkUpdateMock.mockResolvedValue({ id: 'bench_test' });
    benchmarkDefinitionsMock.mockResolvedValue([{ id: 'definition' }]);
    benchmarkStartRunMock.mockResolvedValue({ id: 'run_test' });
    benchmarkUpdateScenariosMock.mockResolvedValue({ updated: true });
    secretCreateMock.mockResolvedValue({});
    secretListMock.mockResolvedValue({});
    secretUpdateMock.mockResolvedValue({});
    secretDeleteMock.mockResolvedValue({});
    secretRetrieveMock.mockResolvedValue({ name: 'API_KEY' });
    networkPolicyCreateMock.mockResolvedValue({ id: 'np_created' });
    networkPolicyListMock.mockResolvedValue([{ id: 'np_test' }]);
    networkPolicyFromIdMock.mockReturnValue({
      update: networkPolicyUpdateMock,
      delete: networkPolicyDeleteMock,
    });
    networkPolicyUpdateMock.mockResolvedValue({ id: 'np_test' });
    networkPolicyDeleteMock.mockResolvedValue({});
    axonCreateMock.mockResolvedValue({ id: 'axon_created' });
    axonListMock.mockResolvedValue([{ id: 'axon_test' }]);
    axonFromIdMock.mockReturnValue({
      publish: axonPublishMock,
      sql: {
        query: axonQueryMock,
        batch: axonBatchMock,
      },
    });
    axonPublishMock.mockResolvedValue({ published: true });
    axonQueryMock.mockResolvedValue({ rows: [] });
    axonBatchMock.mockResolvedValue({ results: [] });
    execMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      return {
        exitCode: 0,
        stdout: vi
          .fn()
          .mockResolvedValue(
            resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
          ),
        stderr: vi.fn().mockResolvedValue(''),
      };
    });
    readMock.mockResolvedValue('# Hello\n');
    writeMock.mockResolvedValue(undefined);
    downloadMock.mockResolvedValue({
      buffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    });
    uploadMock.mockResolvedValue(undefined);
    getTunnelUrlMock.mockResolvedValue('https://3000-devbox.tunnel.runloop.ai');
    enableTunnelMock.mockResolvedValue(undefined);
    snapshotDiskMock.mockResolvedValue({ id: 'snap_runloop' });
    resumeMock.mockResolvedValue(undefined);
    suspendMock.mockResolvedValue(undefined);
    shutdownMock.mockResolvedValue(undefined);
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new RunloopSandboxClient();

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

  test('creates from a blueprint, materializes files, and executes commands', async () => {
    const client = new RunloopSandboxClient();
    const userParameters: RunloopUserParameters = {
      username: 'root',
      uid: 0,
    };

    const session = await client.create(
      new Manifest({
        root: '/root',
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello\n',
          },
        },
      }),
      {
        blueprintName: 'blueprint-test',
        userParameters,
      },
    );
    const output = await session.execCommand({ cmd: 'ls' });

    expect(createFromBlueprintNameMock).toHaveBeenCalledWith(
      'blueprint-test',
      {
        environment_variables: {},
        launch_parameters: {
          user_parameters: userParameters,
        },
      },
      undefined,
    );
    expect(uploadMock).toHaveBeenCalledWith({
      path: '/root/README.md',
      file: expect.any(File),
    });
    expect(execMock).toHaveBeenCalledWith("cd '/root' && ls", {
      last_n: '2000',
    });
    expect(output).toContain('README.md');
  });

  test('omits blueprint_id when creating from a blueprint name', async () => {
    const client = new RunloopSandboxClient({
      blueprintId: 'bp-default',
    });

    await client.create(runloopManifest(), {
      blueprintName: 'blueprint-test',
    });

    expect(createFromBlueprintNameMock).toHaveBeenCalledWith(
      'blueprint-test',
      expect.not.objectContaining({
        blueprint_id: 'bp-default',
      }),
      undefined,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test('creates subdirectory manifest roots before path validation', async () => {
    let rootCreated = false;
    execMock.mockImplementation(async (command: string) => {
      if (command === "cd '/home/user' && mkdir -p -- '/home/user/project'") {
        rootCreated = true;
        return execResult({ exitCode: 0 });
      }
      if (command.startsWith("cd '/home/user/project' &&") && !rootCreated) {
        return execResult({
          exitCode: 1,
          stderr: 'cd: /home/user/project: No such file or directory',
        });
      }
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      return execResult({
        exitCode: 0,
        stdout: resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
      });
    });
    const client = new RunloopSandboxClient();

    await client.create(
      new Manifest({
        root: '/home/user/project',
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello\n',
          },
        },
      }),
    );

    expect(rootCreated).toBe(true);
    expect(uploadMock).toHaveBeenCalledWith({
      path: '/home/user/project/README.md',
      file: expect.any(File),
    });
  });

  test('reports unknown Runloop exec exit codes as failures', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest());
    execMock.mockResolvedValueOnce(
      execResult({
        exitCode: null,
        stderr: 'command interrupted',
      }),
    );

    const output = await session.execCommand({ cmd: 'ls' });

    expect(output).toContain('Process exited with code 1');
    expect(output).toContain('command interrupted');
  });

  test('treats unknown Runloop liveness exit codes as not running', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest());
    execMock.mockResolvedValueOnce(execResult({ exitCode: null }));

    await expect(session.running()).resolves.toBe(false);
  });

  test('passes createTimeoutMs to create calls', async () => {
    const client = new RunloopSandboxClient();

    await client.create(runloopManifest(), {
      createTimeoutMs: 12_345,
    });
    await client.create(runloopManifest(), {
      blueprintName: 'blueprint-test',
      createTimeoutMs: 23_456,
    });

    expect(createMock).toHaveBeenCalledWith(
      {
        environment_variables: {},
      },
      {
        timeout: 12_345,
        longPoll: { timeoutMs: 12_345 },
      },
    );
    expect(createFromBlueprintNameMock).toHaveBeenCalledWith(
      'blueprint-test',
      {
        environment_variables: {},
      },
      {
        timeout: 23_456,
        longPoll: { timeoutMs: 23_456 },
      },
    );
  });

  test('applies provider timeout bundles to Runloop operations', async () => {
    const client = new RunloopSandboxClient({
      timeouts: {
        createTimeoutMs: 101,
        execTimeoutMs: 202,
        fileUploadTimeoutMs: 303,
        fileDownloadTimeoutMs: 404,
        snapshotTimeoutMs: 505,
        cleanupTimeoutMs: 606,
        fastOperationTimeoutMs: 707,
      },
    });

    const session = await client.create(
      runloopManifest({
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello\n',
          },
        },
      }),
    );

    expect(createMock).toHaveBeenCalledWith(
      {
        environment_variables: {},
      },
      {
        timeout: 101,
        longPoll: { timeoutMs: 101 },
      },
    );
    expect(uploadMock).toHaveBeenCalledWith(
      {
        path: '/home/user/README.md',
        file: expect.any(File),
      },
      {
        timeout: 303,
      },
    );

    await session.execCommand({ cmd: 'ls' });
    expect(execMock).toHaveBeenLastCalledWith(
      "cd '/home/user' && ls",
      {
        last_n: '2000',
      },
      {
        timeout: 202,
        longPoll: { timeoutMs: 202 },
      },
    );

    await session.viewImage({ path: 'pixel.png' });
    expect(downloadMock).toHaveBeenLastCalledWith(
      {
        path: '/home/user/pixel.png',
      },
      {
        timeout: 404,
      },
    );

    await session.persistWorkspace();
    expect(snapshotDiskMock).toHaveBeenCalledWith(
      {
        name: 'sandbox-devbox_test',
        metadata: {
          openai_agents_devbox_id: 'devbox_test',
        },
      },
      {
        timeout: 505,
        longPoll: { timeoutMs: 505 },
      },
    );

    await session.close();
    expect(shutdownMock).toHaveBeenCalledWith({
      timeout: 606,
    });
  });

  test('defaults and validates manifest roots against the effective Runloop home', async () => {
    const client = new RunloopSandboxClient();

    const defaultSession = await client.create();

    expect(defaultSession.state.manifest.root).toBe(RUNLOOP_HOME);
    await expect(
      client.create(
        new Manifest({
          root: '/workspace',
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxConfigurationError);
  });

  test('rejects unsafe usernames before deriving the effective home', async () => {
    for (const username of [
      '',
      '.',
      '..',
      '../root',
      'team/user',
      'user/../root',
      'team..user',
    ]) {
      const client = new RunloopSandboxClient({
        userParameters: {
          username,
          uid: 1000,
        },
      });

      await expect(client.create()).rejects.toThrow('userParameters.username');
    }

    expect(createMock).not.toHaveBeenCalled();
  });

  test('validates manifest roots when applying manifests to sessions', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create();
    uploadMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          root: '/workspace',
          entries: {
            'next.txt': {
              type: 'file',
              content: 'next\n',
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxConfigurationError);
    expect(uploadMock).not.toHaveBeenCalled();

    await session.applyManifest(
      runloopManifest({
        entries: {
          'next.txt': {
            type: 'file',
            content: 'next\n',
          },
        },
      }),
    );

    expect(uploadMock).toHaveBeenCalledWith({
      path: '/home/user/next.txt',
      file: expect.any(File),
    });
    expect(session.state.manifest.root).toBe('/home/user');
    expect(session.state.manifest.entries).toHaveProperty('next.txt');
  });

  test('fails manifest directory materialization when remote mkdir fails', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create();
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("mkdir -p -- '/home/user/logs'")) {
        return execResult({
          exitCode: 1,
          stderr: 'mkdir denied',
        });
      }
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      return execResult({
        exitCode: 0,
        stdout: resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
      });
    });

    await expect(
      session.applyManifest(
        runloopManifest({
          entries: {
            logs: {
              type: 'dir',
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      details: {
        provider: 'runloop',
        operation: 'create directory',
        devboxId: 'devbox_test',
        path: '/home/user/logs',
        exitCode: 1,
        stderr: 'mkdir denied',
      },
    });
  });

  test('fails editor deletes when remote rm fails', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create();
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("rm -f -- '/home/user/old.txt'")) {
        return execResult({
          exitCode: 1,
          stderr: 'delete denied',
        });
      }
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      return execResult({
        exitCode: 0,
        stdout: resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
      });
    });

    await expect(
      session.createEditor().deleteFile({
        type: 'delete_file',
        path: 'old.txt',
      }),
    ).rejects.toMatchObject({
      details: {
        provider: 'runloop',
        operation: 'delete path',
        devboxId: 'devbox_test',
        path: '/home/user/old.txt',
        exitCode: 1,
        stderr: 'delete denied',
      },
    });
  });

  test('rejects filesystem runAs values', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create();

    expect(() => session.createEditor('root')).toThrow(
      'RunloopSandboxClient does not support runAs yet.',
    );
    await expect(
      session.pathExists('README.md', 'root'),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('upserts managed secrets and stores only secret references', async () => {
    const client = new RunloopSandboxClient();

    const session = await client.create(runloopManifest(), {
      managedSecrets: {
        API_KEY: 'secret-value',
      },
      createTimeoutMs: 12_345,
    });
    const serialized = await client.serializeSessionState(session.state);

    expect(secretCreateMock).toHaveBeenCalledWith(
      {
        name: 'API_KEY',
        value: 'secret-value',
      },
      {
        timeout: 12_345,
      },
    );
    expect(secretUpdateMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(
      {
        environment_variables: {},
        secrets: {
          API_KEY: 'API_KEY',
        },
      },
      {
        timeout: 12_345,
        longPoll: { timeoutMs: 12_345 },
      },
    );
    expect(session.state.secretRefs).toEqual({
      API_KEY: 'API_KEY',
    });
    expect(JSON.stringify(serialized)).not.toContain('secret-value');
    expect(serialized).toMatchObject({
      secretRefs: {
        API_KEY: 'API_KEY',
      },
    });
  });

  test('updates existing Runloop managed secrets on conflict', async () => {
    const client = new RunloopSandboxClient();
    secretCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { status: 409 }),
    );

    await client.create(runloopManifest(), {
      managedSecrets: {
        API_KEY: 'secret-value',
      },
    });

    expect(secretCreateMock).toHaveBeenCalledWith(
      {
        name: 'API_KEY',
        value: 'secret-value',
      },
      undefined,
    );
    expect(secretUpdateMock).toHaveBeenCalledWith(
      'API_KEY',
      {
        value: 'secret-value',
      },
      undefined,
    );
  });

  test('wraps Runloop managed secret failures without leaking values', async () => {
    const client = new RunloopSandboxClient();
    secretCreateMock.mockRejectedValueOnce(
      new Error('service unavailable for secret-value'),
    );

    let thrown: unknown;
    try {
      await client.create(runloopManifest(), {
        managedSecrets: {
          API_KEY: 'secret-value',
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect(String(thrown)).not.toContain('secret-value');
    expect(JSON.stringify(thrown)).not.toContain('secret-value');
  });

  test('wraps Runloop create SDK failures as provider errors', async () => {
    const client = new RunloopSandboxClient();
    createMock.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(client.create(runloopManifest())).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
  });

  test('exposes Runloop platform facade with camelCase methods', async () => {
    const client = new RunloopSandboxClient();
    const platform = await client.platform();

    await platform.blueprints.list({ limit: 1 });
    await platform.blueprints.listPublic({ limit: 2 });
    const blueprint = platform.blueprints.get('bp_test');
    await platform.blueprints.create({ name: 'agent-blueprint' });
    await platform.blueprints.logs('bp_test', { limit: 3 });
    await platform.blueprints.awaitBuildComplete('bp_test', { timeout: 4 });
    await platform.blueprints.delete('bp_test', { force: true });
    await platform.benchmarks.list({ limit: 5 });
    await platform.benchmarks.listPublic({ limit: 6 });
    const benchmark = await platform.benchmarks.get('bench_test');
    await platform.benchmarks.create({ name: 'agent-benchmark' });
    await platform.benchmarks.update('bench_test', { name: 'updated' });
    await platform.benchmarks.definitions('bench_test', { scenario: 'all' });
    await platform.benchmarks.startRun('bench_test', { input: 'run' });
    await platform.benchmarks.updateScenarios('bench_test', {
      scenarios: [],
    });
    await platform.secrets.create({
      name: 'API_KEY',
      value: 'secret-value',
    });
    await platform.secrets.list({ limit: 9 });
    await platform.secrets.get('API_KEY', { include_metadata: true });
    await platform.secrets.update({
      name: 'API_KEY',
      value: 'next-value',
    });
    await platform.secrets.delete('API_KEY', { force: true });
    await platform.networkPolicies.create({ name: 'agent-policy' });
    await platform.networkPolicies.list({ limit: 7 });
    const networkPolicy = platform.networkPolicies.get('np_test');
    await platform.networkPolicies.update('np_test', { name: 'updated' });
    await platform.networkPolicies.delete('np_test', { force: true });
    await platform.axons.create({ name: 'agent-axon' });
    await platform.axons.list({ limit: 8 });
    const axon = platform.axons.get('axon_test');
    await platform.axons.publish('axon_test', { revision: 'latest' });
    await platform.axons.querySql('axon_test', { sql: 'select 1' });
    await platform.axons.batchSql('axon_test', {
      statements: ['select 1'],
    });

    expect(blueprint).toEqual({
      delete: blueprintDeleteMock,
    });
    expect(benchmark).toEqual({ id: 'bench_test' });
    expect(networkPolicy).toEqual({
      update: networkPolicyUpdateMock,
      delete: networkPolicyDeleteMock,
    });
    expect(axon).toEqual({
      publish: axonPublishMock,
      sql: {
        query: axonQueryMock,
        batch: axonBatchMock,
      },
    });
    expect(blueprintCreateMock).toHaveBeenCalledWith({
      name: 'agent-blueprint',
    });
    expect(blueprintListMock).toHaveBeenCalledWith({ limit: 1 });
    expect(blueprintListPublicMock).toHaveBeenCalledWith({ limit: 2 });
    expect(blueprintLogsMock).toHaveBeenCalledWith('bp_test', { limit: 3 });
    expect(blueprintAwaitBuildCompleteMock).toHaveBeenCalledWith('bp_test', {
      timeout: 4,
    });
    expect(blueprintFromIdMock).toHaveBeenCalledWith('bp_test');
    expect(blueprintDeleteMock).toHaveBeenCalledWith({ force: true });
    expect(benchmarkListMock).toHaveBeenCalledWith({ limit: 5 });
    expect(benchmarkListPublicMock).toHaveBeenCalledWith({ limit: 6 });
    expect(benchmarkRetrieveMock).toHaveBeenCalledWith('bench_test');
    expect(benchmarkCreateMock).toHaveBeenCalledWith({
      name: 'agent-benchmark',
    });
    expect(benchmarkUpdateMock).toHaveBeenCalledWith('bench_test', {
      name: 'updated',
    });
    expect(benchmarkDefinitionsMock).toHaveBeenCalledWith('bench_test', {
      scenario: 'all',
    });
    expect(benchmarkStartRunMock).toHaveBeenCalledWith({
      benchmark_id: 'bench_test',
      input: 'run',
    });
    expect(benchmarkUpdateScenariosMock).toHaveBeenCalledWith('bench_test', {
      scenarios: [],
    });
    expect(secretCreateMock).toHaveBeenCalledWith({
      name: 'API_KEY',
      value: 'secret-value',
    });
    expect(secretListMock).toHaveBeenCalledWith({ limit: 9 });
    expect(secretRetrieveMock).toHaveBeenCalledWith('API_KEY', {
      include_metadata: true,
    });
    expect(secretUpdateMock).toHaveBeenCalledWith('API_KEY', {
      value: 'next-value',
    });
    expect(secretDeleteMock).toHaveBeenCalledWith('API_KEY', { force: true });
    expect(networkPolicyCreateMock).toHaveBeenCalledWith({
      name: 'agent-policy',
    });
    expect(networkPolicyListMock).toHaveBeenCalledWith({ limit: 7 });
    expect(networkPolicyFromIdMock).toHaveBeenCalledWith('np_test');
    expect(networkPolicyUpdateMock).toHaveBeenCalledWith({ name: 'updated' });
    expect(networkPolicyDeleteMock).toHaveBeenCalledWith({ force: true });
    expect(axonCreateMock).toHaveBeenCalledWith({ name: 'agent-axon' });
    expect(axonListMock).toHaveBeenCalledWith({ limit: 8 });
    expect(axonFromIdMock).toHaveBeenCalledWith('axon_test');
    expect(axonPublishMock).toHaveBeenCalledWith({ revision: 'latest' });
    expect(axonQueryMock).toHaveBeenCalledWith({ sql: 'select 1' });
    expect(axonBatchMock).toHaveBeenCalledWith({
      statements: ['select 1'],
    });
  });

  test('binds fromId platform instance methods before invoking them', async () => {
    const client = new RunloopSandboxClient();
    const platform = await client.platform();

    blueprintFromIdMock.mockReturnValue({
      client: 'blueprint-client',
      delete: function (this: { client: string }, params: unknown) {
        if (this.client !== 'blueprint-client') {
          throw new Error('unbound blueprint method');
        }
        return blueprintDeleteMock(params);
      },
    });
    networkPolicyFromIdMock.mockReturnValue({
      client: 'network-policy-client',
      update: function (this: { client: string }, params: unknown) {
        if (this.client !== 'network-policy-client') {
          throw new Error('unbound network policy update method');
        }
        return networkPolicyUpdateMock(params);
      },
      delete: function (this: { client: string }, params: unknown) {
        if (this.client !== 'network-policy-client') {
          throw new Error('unbound network policy delete method');
        }
        return networkPolicyDeleteMock(params);
      },
    });
    axonFromIdMock.mockReturnValue({
      client: 'axon-client',
      publish: function (this: { client: string }, params: unknown) {
        if (this.client !== 'axon-client') {
          throw new Error('unbound axon publish method');
        }
        return axonPublishMock(params);
      },
      sql: {
        client: 'axon-sql-client',
        query: function (this: { client: string }, params: unknown) {
          if (this.client !== 'axon-sql-client') {
            throw new Error('unbound axon sql query method');
          }
          return axonQueryMock(params);
        },
        batch: function (this: { client: string }, params: unknown) {
          if (this.client !== 'axon-sql-client') {
            throw new Error('unbound axon sql batch method');
          }
          return axonBatchMock(params);
        },
      },
    });

    await platform.blueprints.delete('bp_test', { force: true });
    await platform.networkPolicies.update('np_test', { name: 'updated' });
    await platform.networkPolicies.delete('np_test', { force: true });
    await platform.axons.publish('axon_test', { revision: 'latest' });
    await platform.axons.querySql('axon_test', { sql: 'select 1' });
    await platform.axons.batchSql('axon_test', {
      statements: ['select 1'],
    });

    expect(blueprintDeleteMock).toHaveBeenCalledWith({ force: true });
    expect(networkPolicyUpdateMock).toHaveBeenCalledWith({ name: 'updated' });
    expect(networkPolicyDeleteMock).toHaveBeenCalledWith({ force: true });
    expect(axonPublishMock).toHaveBeenCalledWith({ revision: 'latest' });
    expect(axonQueryMock).toHaveBeenCalledWith({ sql: 'select 1' });
    expect(axonBatchMock).toHaveBeenCalledWith({
      statements: ['select 1'],
    });
  });

  test('falls back to legacy Runloop benchmark facade methods', async () => {
    includeApiBenchmarks = false;
    includeLegacyBenchmarkFacade = true;
    const client = new RunloopSandboxClient();
    const platform = await client.platform();
    benchmarkFromIdMock.mockReturnValue({
      client: 'benchmark-client',
      update: function (this: { client: string }, params: unknown) {
        if (this.client !== 'benchmark-client') {
          throw new Error('unbound benchmark update method');
        }
        return benchmarkUpdateMock(params);
      },
      startRun: function (this: { client: string }, params: unknown) {
        if (this.client !== 'benchmark-client') {
          throw new Error('unbound benchmark startRun method');
        }
        return benchmarkStartRunMock(params);
      },
    });

    await platform.benchmarks.list({ limit: 5 });
    const benchmark = platform.benchmarks.get('bench_test');
    await platform.benchmarks.create({ name: 'agent-benchmark' });
    await platform.benchmarks.update('bench_test', { name: 'updated' });
    await platform.benchmarks.startRun('bench_test', { input: 'run' });

    expect(benchmark).toMatchObject({ client: 'benchmark-client' });
    expect(benchmarkListMock).toHaveBeenCalledWith({ limit: 5 });
    expect(benchmarkCreateMock).toHaveBeenCalledWith({
      name: 'agent-benchmark',
    });
    expect(benchmarkFromIdMock).toHaveBeenCalledWith('bench_test');
    expect(benchmarkUpdateMock).toHaveBeenCalledWith({ name: 'updated' });
    expect(benchmarkStartRunMock).toHaveBeenCalledWith({ input: 'run' });
  });

  test('rejects unsafe environment names before building shell commands', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(
      runloopManifest({
        environment: {
          'X; touch /tmp/pwned; #': 'bad',
        },
      }),
    );

    await expect(session.execCommand({ cmd: 'ls' })).rejects.toThrow(
      'Invalid environment variable name',
    );
  });

  test('does not export manifest environment into internal path and manifest commands', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(
      runloopManifest({
        environment: {
          PATH: '/tmp/attacker-bin',
        },
      }),
    );
    execMock.mockClear();

    await session.pathExists('README.md');
    await session.applyManifest(
      runloopManifest({
        entries: {
          logs: {
            type: 'dir',
          },
        },
      }),
    );

    const commands = execMock.mock.calls.map(([command]) => String(command));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toContain('export PATH=');
      expect(command).not.toContain('/tmp/attacker-bin');
    }
  });

  test('rejects unsupported PTY execution with a typed error', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest());

    await expect(
      session.execCommand({ cmd: 'sh', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('suspends on close when pauseOnExit is enabled and resumes by id', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      pauseOnExit: true,
    });

    await session.close();
    await client.resume(session.state);

    expect(suspendMock).toHaveBeenCalledOnce();
    expect(fromIdMock).toHaveBeenCalledWith('devbox_test');
    expect(resumeMock).toHaveBeenCalledOnce();
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  test('ignores persisted baseUrl when resuming sessions', async () => {
    const client = new RunloopSandboxClient({
      apiKey: 'trusted-key',
    });
    const state = await client.deserializeSessionState({
      manifest: runloopManifest(),
      devboxId: 'devbox_test',
      pauseOnExit: true,
      environment: {},
      baseUrl: 'https://attacker.example',
    });
    runloopSdkConstructorMock.mockClear();

    const resumed = await client.resume(state);

    expect(runloopSdkConstructorMock).toHaveBeenCalledWith({
      bearerToken: 'trusted-key',
    });
    expect(runloopSdkConstructorMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'baseURL',
    );
    expect(resumed.state.baseUrl).toBeUndefined();
  });

  test('rejects persisted resume manifests outside the effective Runloop home', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      pauseOnExit: true,
    });
    session.state.manifest = new Manifest({ root: '/tmp' });
    fromIdMock.mockClear();
    resumeMock.mockClear();

    await expect(client.resume(session.state)).rejects.toBeInstanceOf(
      SandboxConfigurationError,
    );

    expect(fromIdMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  test('refreshes ports and rematerializes cloud mounts when resuming', async () => {
    getTunnelUrlMock.mockResolvedValueOnce(
      'https://3000-devbox.tunnel.runloop.ai',
    );
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopCloudBucketManifest(), {
      pauseOnExit: true,
      exposedPorts: [3000],
    });
    await session.resolveExposedPort(3000);
    await session.close();
    execMock.mockClear();
    enableTunnelMock.mockClear();
    getTunnelUrlMock.mockReset();
    getTunnelUrlMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://3000-resumed.tunnel.runloop.ai');

    const resumed = await client.resume(session.state);
    const endpoint = await resumed.resolveExposedPort(3000);

    expect(resumeMock).toHaveBeenCalledOnce();
    expect(
      execMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
    expect(enableTunnelMock).toHaveBeenCalledWith({
      auth_mode: 'open',
      http_keep_alive: true,
      wake_on_http: false,
    });
    expect(getTunnelUrlMock).toHaveBeenCalledTimes(2);
    expect(endpoint.host).toBe('3000-resumed.tunnel.runloop.ai');
    expect(resumed.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('suspends a resumed devbox when mount rematerialization fails', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopCloudBucketManifest(), {
      pauseOnExit: true,
    });
    await session.close();
    createMock.mockClear();
    suspendMock.mockClear();
    execMock.mockRejectedValueOnce(new Error('mount failed'));

    await expect(client.resume(session.state)).rejects.toBeInstanceOf(
      SandboxProviderError,
    );

    expect(resumeMock).toHaveBeenCalledOnce();
    expect(suspendMock).toHaveBeenCalledOnce();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('keeps nested mount entries nested when rematerializing on resume', async () => {
    const client = new RunloopSandboxClient();
    const manifest = runloopManifest({
      entries: {
        dir: {
          type: 'dir',
          children: {
            data: {
              type: 's3_mount',
              bucket: 'agent-logs',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
              mountStrategy: new RunloopCloudBucketMountStrategy(),
            },
          },
        },
      },
    });
    const session = await client.create(manifest, { pauseOnExit: true });
    await session.close();
    execMock.mockClear();

    const resumed = await client.resume(session.state);
    const dirEntry = resumed.state.manifest.entries.dir;

    expect(resumed.state.manifest.entries).not.toHaveProperty('dir/data');
    expect(dirEntry).toMatchObject({ type: 'dir' });
    expect(
      (dirEntry as { children?: Record<string, unknown> }).children,
    ).toHaveProperty('data');
  });

  test('delete terminates even when pauseOnExit is enabled', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      pauseOnExit: true,
    });

    await session.delete();

    expect(suspendMock).not.toHaveBeenCalled();
    expect(shutdownMock).toHaveBeenCalledOnce();
  });

  test('recreates paused devboxes when resume reports missing devbox', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    resumeMock.mockRejectedValueOnce(new Error('devbox not found'));

    const recreated = await client.resume(session.state);

    expect(fromIdMock).toHaveBeenCalledWith('devbox_test');
    expect(resumeMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledOnce();
    expect(recreated.state.devboxId).toBe('devbox_test');
  });

  test('rejects persisted secret refs when recreating missing devboxes', async () => {
    const client = new RunloopSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: runloopManifest(),
      devboxId: 'devbox_test',
      pauseOnExit: true,
      environment: {},
      secretRefs: {
        API_KEY: 'attacker-secret',
      },
    });
    resumeMock.mockRejectedValueOnce(new Error('devbox not found'));

    await expect(client.resume(state)).rejects.toThrow(
      'RunloopSandboxClient cannot recreate a missing devbox with persisted secretRefs.',
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  test('fails fast when resume lookup fails with a provider error', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    fromIdMock.mockImplementationOnce(() => {
      throw new Error('request timeout');
    });

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'runloop',
      operation: 'resume',
      devboxId: 'devbox_test',
      cause: 'request timeout',
    });
    expect(resumeMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('fails fast when resume fails with a provider error', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      pauseOnExit: true,
    });
    createMock.mockClear();
    resumeMock.mockRejectedValueOnce(new Error('request timeout'));

    let thrown: unknown;
    try {
      await client.resume(session.state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'runloop',
      operation: 'resume',
      devboxId: 'devbox_test',
      cause: 'request timeout',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  test('persists native disk snapshots and restores from snapshot refs', async () => {
    getTunnelUrlMock
      .mockResolvedValueOnce('https://3000-devbox.tunnel.runloop.ai')
      .mockResolvedValueOnce('https://3000-restored.tunnel.runloop.ai');
    const client = new RunloopSandboxClient();
    const session = await client.create(
      runloopCloudBucketManifest({ ephemeral: false }),
      {
        name: 'agent-devbox',
        exposedPorts: [3000],
      },
    );

    const originalEndpoint = await session.resolveExposedPort(3000);
    const snapshotBytes = await session.persistWorkspace();
    const ref = decodeNativeSnapshotRef(snapshotBytes);

    expect(snapshotDiskMock).toHaveBeenCalledWith({
      name: 'sandbox-devbox_test',
      metadata: {
        openai_agents_devbox_id: 'devbox_test',
      },
    });
    expect(ref).toEqual({
      provider: 'runloop',
      snapshotId: 'snap_runloop',
      workspacePersistence: undefined,
    });

    execMock.mockClear();
    await session.hydrateWorkspace(snapshotBytes);
    const restoredEndpoint = await session.resolveExposedPort(3000);

    expect(createFromSnapshotMock).toHaveBeenCalledWith(
      'snap_runloop',
      {
        environment_variables: {},
        name: 'agent-devbox',
        exposed_ports: [3000],
      },
      undefined,
    );
    expect(shutdownMock).toHaveBeenCalledOnce();
    expect(session.state.devboxId).toBe('devbox_restored');
    expect(originalEndpoint.host).toBe('3000-devbox.tunnel.runloop.ai');
    expect(restoredEndpoint.host).toBe('3000-restored.tunnel.runloop.ai');
    expect(session.state.exposedPorts?.['3000']).toBe(restoredEndpoint);
    expect(getTunnelUrlMock).toHaveBeenCalledTimes(2);
    expect(
      execMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
  });

  test('shuts down replacement devboxes when snapshot mount restore fails', async () => {
    const replacementShutdownMock = vi.fn().mockResolvedValue(undefined);
    createFromSnapshotMock.mockResolvedValueOnce(
      mockRunloopDevbox({
        id: 'devbox_restored',
        shutdown: replacementShutdownMock,
      }),
    );
    const client = new RunloopSandboxClient();
    const session = await client.create(
      runloopCloudBucketManifest({ ephemeral: false }),
    );
    const snapshotBytes = await session.persistWorkspace();
    execMock.mockRejectedValueOnce(new Error('mount failed'));

    await expect(session.hydrateWorkspace(snapshotBytes)).rejects.toMatchObject(
      {
        details: {
          provider: 'runloop',
          devboxId: 'devbox_test',
          replacementDevboxId: 'devbox_restored',
          snapshotId: 'snap_runloop',
          cause: 'mount failed',
        },
      },
    );

    expect(shutdownMock).not.toHaveBeenCalled();
    expect(replacementShutdownMock).toHaveBeenCalledOnce();
    expect(session.state.devboxId).toBe('devbox_test');
  });

  test('falls back to tar persistence when Runloop snapshot API is unavailable', async () => {
    createMock.mockResolvedValueOnce(
      mockRunloopDevbox({
        snapshotDisk: undefined,
      }),
    );
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest());
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    downloadMock.mockResolvedValueOnce({
      buffer: async () => Buffer.from(archive),
    });

    const snapshotBytes = await session.persistWorkspace();

    expect(snapshotDiskMock).not.toHaveBeenCalled();
    expect(decodeNativeSnapshotRef(snapshotBytes)).toBeUndefined();
    expect(downloadMock).toHaveBeenCalled();
  });

  test('falls back to tar persistence when the workspace root is ephemeral', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(
      runloopManifest({
        entries: {
          '': {
            type: 'dir',
            ephemeral: true,
          },
        },
      }),
    );
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    downloadMock.mockResolvedValueOnce({
      buffer: async () => Buffer.from(archive),
    });

    const snapshotBytes = await session.persistWorkspace();

    expect(snapshotDiskMock).not.toHaveBeenCalled();
    expect(decodeNativeSnapshotRef(snapshotBytes)).toBeUndefined();
    expect(downloadMock).toHaveBeenCalled();
  });

  test('reports provider errors when native snapshot restore is unsupported', async () => {
    includeCreateFromSnapshotApi = false;
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest());
    const snapshotBytes = await session.persistWorkspace();

    await expect(session.hydrateWorkspace(snapshotBytes)).rejects.toMatchObject(
      {
        details: {
          provider: 'runloop',
          snapshotId: 'snap_runloop',
        },
      },
    );

    expect(createFromSnapshotMock).not.toHaveBeenCalled();
    expect(shutdownMock).not.toHaveBeenCalled();
    expect(session.state.devboxId).toBe('devbox_test');
  });

  test('surfaces shutdown failures when replacing native snapshot devboxes', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      name: 'agent-devbox',
    });
    const snapshotBytes = await session.persistWorkspace();
    shutdownMock
      .mockRejectedValueOnce(new Error('shutdown failed'))
      .mockResolvedValueOnce(undefined);

    let thrown: unknown;
    try {
      await session.hydrateWorkspace(snapshotBytes);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'runloop',
      devboxId: 'devbox_test',
      replacementDevboxId: 'devbox_restored',
      cause: 'shutdown failed',
    });
    expect(shutdownMock).toHaveBeenCalledTimes(2);
    expect(session.state.devboxId).toBe('devbox_test');
  });

  test('fails tar hydration when Runloop archive command exit code is unknown', async () => {
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest());
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    execMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return execResult({
          exitCode: 0,
          stdout: `${resolvedPath}\n`,
        });
      }
      if (command.includes(' -xf ')) {
        return execResult({
          exitCode: null,
          stderr: 'hydrate interrupted',
        });
      }
      return execResult({ exitCode: 0 });
    });

    await expect(session.hydrateWorkspace(archive)).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );
  });

  test('resolves configured exposed ports through Runloop tunnels', async () => {
    getTunnelUrlMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://3000-devbox.tunnel.runloop.ai');
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      exposedPorts: [3000],
    });

    const endpoint = await session.resolveExposedPort(3000);
    const cachedEndpoint = await session.resolveExposedPort(3000);

    expect(enableTunnelMock).toHaveBeenCalledWith({
      auth_mode: 'open',
      http_keep_alive: true,
      wake_on_http: false,
    });
    expect(getTunnelUrlMock).toHaveBeenCalledWith(3000);
    expect(getTunnelUrlMock).toHaveBeenCalledTimes(2);
    expect(endpoint).toMatchObject({
      host: '3000-devbox.tunnel.runloop.ai',
      port: 443,
      tls: true,
    });
    expect(cachedEndpoint).toBe(endpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('reuses configured tunnel policy when enabling missing tunnels', async () => {
    getTunnelUrlMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://3000-private.tunnel.runloop.ai');
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      exposedPorts: [3000],
      tunnel: {
        auth_mode: 'authenticated',
        http_keep_alive: false,
        wake_on_http: true,
      },
    });

    await session.resolveExposedPort(3000);

    expect(enableTunnelMock).toHaveBeenCalledWith({
      auth_mode: 'authenticated',
      http_keep_alive: false,
      wake_on_http: true,
    });
  });

  test('rejects exposed ports when Runloop getTunnelUrl API is unavailable', async () => {
    createMock.mockResolvedValueOnce(
      mockRunloopDevbox({
        getTunnelUrl: undefined,
      }),
    );
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      exposedPorts: [3000],
    });

    await expect(session.resolveExposedPort(3000)).rejects.toThrow(
      /requires getTunnelUrl/,
    );
    expect(enableTunnelMock).not.toHaveBeenCalled();
  });

  test('rejects exposed ports when Runloop tunnel enable API is unavailable', async () => {
    createMock.mockResolvedValueOnce(
      mockRunloopDevbox({
        net: undefined,
      }),
    );
    getTunnelUrlMock.mockResolvedValueOnce('');
    const client = new RunloopSandboxClient();
    const session = await client.create(runloopManifest(), {
      exposedPorts: [3000],
    });

    await expect(session.resolveExposedPort(3000)).rejects.toThrow(
      /requires a Runloop tunnel API/,
    );
    expect(enableTunnelMock).not.toHaveBeenCalled();
  });

  test('fails mount commands when Runloop exit code is unknown', async () => {
    const client = new RunloopSandboxClient();
    execMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      if (resolvedPath) {
        return execResult({
          exitCode: 0,
          stdout: `${resolvedPath}\n`,
        });
      }
      if (command.includes('test -c /dev/fuse')) {
        return execResult({
          exitCode: null,
          stderr: 'mount probe interrupted',
        });
      }
      return execResult({ exitCode: 0 });
    });

    await expect(
      client.create(runloopCloudBucketManifest()),
    ).rejects.toBeInstanceOf(SandboxMountError);
  });

  test('mounts cloud buckets with the Runloop rclone mount strategy', async () => {
    const client = new RunloopSandboxClient();

    const session = await client.create(runloopCloudBucketManifest());
    await session.close();

    expect(
      execMock.mock.calls.some(([command]) =>
        String(command).includes("'rclone' 'mount'"),
      ),
    ).toBe(true);
    expect(
      execMock.mock.calls.some(([command]) =>
        String(command).includes('/home/user/mounted/logs'),
      ),
    ).toBe(true);
    expect(
      execMock.mock.calls.some(([command]) => {
        const shellCommand = String(command);
        return (
          shellCommand.startsWith("sudo -n -u 'root' -- sh -lc ") &&
          shellCommand.includes('chmod a+rw /dev/fuse')
        );
      }),
    ).toBe(true);
    expect(
      execMock.mock.calls.some(([command]) =>
        String(command).includes('fusermount3 -u'),
      ),
    ).toBe(true);
  });

  test('does not export manifest environment into root mount commands', async () => {
    const client = new RunloopSandboxClient();

    await client.create(
      runloopManifest({
        environment: {
          PATH: '/tmp/attacker-bin',
        },
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'agent-logs',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountPath: 'mounted/logs',
            mountStrategy: new RunloopCloudBucketMountStrategy(),
          },
        },
      }),
    );

    const rootMountCommands = execMock.mock.calls
      .map(([command]) => String(command))
      .filter(
        (command) =>
          command.startsWith("sudo -n -u 'root' -- sh -lc ") &&
          command.includes('chmod a+rw /dev/fuse'),
      );

    expect(rootMountCommands.length).toBeGreaterThan(0);
    for (const command of rootMountCommands) {
      expect(command).not.toContain('export PATH=');
      expect(command).not.toContain('/tmp/attacker-bin');
    }
  });
});
