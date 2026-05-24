import { UserError } from '@openai/agents-core';
import {
  Manifest,
  SandboxArchiveError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { allowConsole } from '../../../../helpers/tests/console-guard';
import { decodeNativeSnapshotRef } from '../../src/sandbox/shared';
import {
  TensorlakeSandboxClient,
  type TensorlakeSandboxClientOptions,
} from '../../src/sandbox/tensorlake';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const createMock = vi.fn();
const connectMock = vi.fn();
const runMock = vi.fn();
const writeFileMock = vi.fn();
const readFileMock = vi.fn();
const deleteFileMock = vi.fn();
const updateMock = vi.fn();
const suspendMock = vi.fn();
const resumeMock = vi.fn();
const terminateMock = vi.fn();
const checkpointMock = vi.fn();

const remoteFiles = new Map<string, Uint8Array>();

vi.mock('tensorlake', () => ({
  Sandbox: {
    create: createMock,
    connect: connectMock,
  },
}));

function makeSandboxInstance(
  sandboxId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sandboxId,
    name: null,
    run: runMock,
    writeFile: writeFileMock,
    readFile: readFileMock,
    deleteFile: deleteFileMock,
    update: updateMock,
    suspend: suspendMock,
    resume: resumeMock,
    terminate: terminateMock,
    checkpoint: checkpointMock,
    ...overrides,
  };
}

describe('TensorlakeSandboxClient', () => {
  beforeEach(() => {
    remoteFiles.clear();
    createMock.mockReset();
    connectMock.mockReset();
    runMock.mockReset();
    writeFileMock.mockReset();
    readFileMock.mockReset();
    deleteFileMock.mockReset();
    updateMock.mockReset();
    suspendMock.mockReset();
    resumeMock.mockReset();
    terminateMock.mockReset();
    checkpointMock.mockReset();

    createMock.mockResolvedValue(makeSandboxInstance('sbx_test'));
    connectMock.mockResolvedValue(makeSandboxInstance('sbx_test'));
    writeFileMock.mockImplementation(
      async (path: string, content: string | Uint8Array) => {
        const bytes =
          typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;
        remoteFiles.set(path, bytes);
      },
    );
    readFileMock.mockImplementation(async (path: string) => {
      const value = remoteFiles.get(path);
      if (!value) {
        throw new Error(`not found: ${path}`);
      }
      return value;
    });
    deleteFileMock.mockImplementation(async (path: string) => {
      remoteFiles.delete(path);
    });
    runMock.mockImplementation(
      async (command: string, options?: { args?: string[] }) => {
        const shellCommand = options?.args?.[1] ?? '';
        const resolvedPath =
          resolvedRemotePathFromValidationCommand(shellCommand);
        if (resolvedPath) {
          return {
            stdout: `${resolvedPath}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (shellCommand === 'ls') {
          return {
            stdout: 'README.md\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (shellCommand.startsWith('test -e ')) {
          const path = shellCommand.match(/^test -e '(.+)'$/)?.[1] ?? '';
          return {
            stdout: '',
            stderr: '',
            exitCode: remoteFiles.has(path) ? 0 : 1,
          };
        }
        if (shellCommand.startsWith('mkdir -p -- ')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    updateMock.mockResolvedValue({});
    suspendMock.mockResolvedValue(undefined);
    resumeMock.mockResolvedValue(undefined);
    terminateMock.mockResolvedValue(undefined);
    checkpointMock.mockResolvedValue({ snapshotId: 'snap_test' });
  });

  test('rejects unsupported core snapshot create options', async () => {
    const client = new TensorlakeSandboxClient();

    await expect(
      client.create({
        manifest: new Manifest(),
        snapshot: { type: 'remote' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects manifests with mount entries before allocating a sandbox', async () => {
    const client = new TensorlakeSandboxClient();
    const manifest = new Manifest({
      entries: {
        data: {
          type: 's3_mount',
          bucket: 'agent-logs',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
          mountPath: 'mounted/logs',
        },
      },
    });

    await expect(client.create(manifest)).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test("collapses manifest identities to tl-user by default and warns once", async () => {
    // Default Tensorlake image only ships `tl-user` and no root; the provider
    // accepts user/group declarations at validation time but skips the
    // privileged commands at apply time. The caller should hear about it via
    // a single warn() summarizing what got dropped, and chmod for entry
    // permissions should still run.
    allowConsole(['warn']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new TensorlakeSandboxClient();
    const manifest = new Manifest({
      users: [{ name: 'alice' }, { name: 'bob' }],
      groups: [{ name: 'staff' }],
      entries: {
        'config.json': {
          type: 'file',
          content: '{}',
          permissions: {
            owner: 7,
            group: 4,
            other: 4,
          },
          group: { name: 'staff' },
        },
      },
    });

    await client.create(manifest);

    const shellCommands = runMock.mock.calls
      .map(([, opts]) => (opts as { args?: string[] })?.args?.[1] ?? '')
      .filter((s) => s.length > 0);

    expect(shellCommands.some((c) => c.includes('groupadd'))).toBe(false);
    expect(shellCommands.some((c) => c.includes('useradd'))).toBe(false);
    expect(shellCommands.some((c) => c.includes('usermod'))).toBe(false);
    expect(shellCommands.some((c) => c.includes('chown'))).toBe(false);
    expect(shellCommands.some((c) => c.includes('chgrp'))).toBe(false);
    expect(
      shellCommands.some((c) =>
        c.startsWith(`chmod `) &&
        c.includes(`/home/tl-user/workspace/config.json`),
      ),
    ).toBe(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(warnMessage).toContain('2 user(s)');
    expect(warnMessage).toContain('1 group(s)');
    expect(warnMessage).toContain('1 entry ownership setting(s)');
    expect(warnMessage).toContain('tl-user');
    expect(warnMessage).not.toContain('entr(y/ies)');
    warnSpy.mockRestore();
  });

  test("manifestIdentities: 'provision' runs account provisioning and entry chgrp", async () => {
    // Opt-in mode for custom images that expose root: the provider should
    // emit the original groupadd/useradd/usermod and chgrp commands. Note
    // that `chown` is only emitted when `applyManifest(manifest, runAs)` is
    // called, and Tensorlake currently rejects manifest `runAs` at the base
    // class (see the `rejects manifest runAs even in 'provision' mode` test
    // below), so this test deliberately does not assert `chown`.
    const client = new TensorlakeSandboxClient({
      manifestIdentities: 'provision',
    } satisfies TensorlakeSandboxClientOptions);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manifest = new Manifest({
      users: [{ name: 'alice' }],
      groups: [{ name: 'staff', users: [{ name: 'alice' }] }],
      entries: {
        'config.json': {
          type: 'file',
          content: '{}',
          group: { name: 'staff' },
        },
      },
    });

    await client.create(manifest);

    const shellCommands = runMock.mock.calls
      .map(([, opts]) => (opts as { args?: string[] })?.args?.[1] ?? '')
      .filter((s) => s.length > 0);

    expect(shellCommands.some((c) => c.includes('groupadd'))).toBe(true);
    expect(shellCommands.some((c) => c.includes('useradd'))).toBe(true);
    expect(shellCommands.some((c) => c.includes('usermod'))).toBe(true);
    expect(shellCommands.some((c) => c.includes('chgrp'))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("rejects manifest runAs even in 'provision' mode (not silently dropped)", async () => {
    // Manifest materialization `runAs` is the only path that would trigger
    // `chown` in the base class. Tensorlake does not override
    // `assertFilesystemRunAs`/`assertManifestRunAs`, so a caller asking for
    // manifest-time ownership via `runAs` gets a loud
    // `SandboxUnsupportedFeatureError` — never a silent collapse. This holds
    // in both 'collapse' and 'provision' modes.
    for (const manifestIdentities of ['collapse', 'provision'] as const) {
      const client = new TensorlakeSandboxClient({
        manifestIdentities,
      } satisfies TensorlakeSandboxClientOptions);
      const session = await client.create(new Manifest());
      await expect(session.applyManifest(new Manifest(), 'alice')).rejects.toBeInstanceOf(
        SandboxUnsupportedFeatureError,
      );
    }
  });

  test('rejects an unknown manifestIdentities value at create-time', async () => {
    const client = new TensorlakeSandboxClient({
      manifestIdentities: 'bogus' as unknown as 'collapse',
    } satisfies TensorlakeSandboxClientOptions);
    await expect(client.create(new Manifest())).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects snapshot persistence when timeoutSecs is below the SDK default checkpoint budget', async () => {
    // Caller omits checkpointTimeoutSecs, so the effective poll budget is the
    // SDK default (300s). timeoutSecs=60 would let the sandbox idle out
    // mid-checkpoint and orphan the snapshot.
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      timeoutSecs: 60,
    });

    await expect(client.create(new Manifest())).rejects.toBeInstanceOf(
      UserError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects snapshot persistence when timeoutSecs is below an explicit checkpoint budget', async () => {
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      timeoutSecs: 60,
      checkpointTimeoutSecs: 120,
    });

    await expect(client.create(new Manifest())).rejects.toBeInstanceOf(
      UserError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test('accepts snapshot persistence when timeoutSecs exceeds the SDK default checkpoint budget', async () => {
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      timeoutSecs: 600,
    });

    await expect(client.create(new Manifest())).resolves.toBeDefined();
  });

  test('creates a sandbox, materializes the manifest, and executes commands', async () => {
    const client = new TensorlakeSandboxClient();
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
    expect(writeFileMock).toHaveBeenCalledWith(
      '/home/tl-user/workspace/README.md',
      expect.any(Uint8Array),
    );
    expect(runMock).toHaveBeenCalledWith('/bin/bash', {
      args: ['-lc', 'ls'],
      env: {},
      workingDir: '/home/tl-user/workspace',
      // Default unbounded-exec safety cap is 24h (86400s).
      timeout: 86400,
    });
    expect(output).toContain('Process exited with code 0');
    expect(output).toContain('README.md');
    expect(session.state.sandboxId).toBe('sbx_test');
  });

  test('passes name, image, and resource options through to Sandbox.create', async () => {
    const client = new TensorlakeSandboxClient({
      name: 'demo',
      image: 'tensorlake/python',
      cpus: 2,
      memoryMb: 4096,
      timeoutSecs: 600,
      secretNames: ['OPENAI_API_KEY'],
      allowInternetAccess: true,
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_named', { name: 'demo' }),
    );

    await client.create(new Manifest());

    expect(createMock).toHaveBeenCalledWith({
      name: 'demo',
      image: 'tensorlake/python',
      cpus: 2,
      memoryMb: 4096,
      timeoutSecs: 600,
      secretNames: ['OPENAI_API_KEY'],
      allowInternetAccess: true,
    });
  });

  test('treats missing exit codes as failures', async () => {
    const client = new TensorlakeSandboxClient();
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

  test('writes manifest entries through the SDK and reads them back', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': { type: 'file', content: 'hello' },
        },
      }),
    );

    expect(writeFileMock).toHaveBeenCalledWith(
      '/home/tl-user/workspace/notes.txt',
      expect.any(Uint8Array),
    );

    const bytes = await session.readFile({
      path: '/home/tl-user/workspace/notes.txt',
    });
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  test('resolves exposed ports through update() and the proxy hostname', async () => {
    const client = new TensorlakeSandboxClient({
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_ports', { name: null }),
    );
    const session = await client.create(new Manifest());

    expect(updateMock).toHaveBeenCalledWith({ exposedPorts: [8080] });
    updateMock.mockClear();

    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint.url).toContain(
      'https://8080-sbx_ports.sandbox.tensorlake.ai',
    );
    expect(updateMock).not.toHaveBeenCalled();

    const onDemand = await session.resolveExposedPort(9090);
    expect(onDemand.url).toContain(
      'https://9090-sbx_ports.sandbox.tensorlake.ai',
    );
    expect(updateMock).toHaveBeenCalledWith({ exposedPorts: [8080, 9090] });
  });

  test('resolves exposed port hostname from sandbox.info() sandbox_url', async () => {
    const infoMock = vi.fn().mockResolvedValue({
      sandboxId: 'sbx_dev',
      sandbox_url: 'https://sbx-dev-instance.tensorlake.dev',
    });
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_dev', { name: 'demo', info: infoMock }),
    );
    const client = new TensorlakeSandboxClient({
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(8080);
    // The host comes from info().sandbox_url, not the public template.
    expect(endpoint.url).toContain(
      'https://8080-sbx-dev-instance.tensorlake.dev',
    );
  });

  test('falls back to the public template when sandbox.info() returns no URL', async () => {
    const infoMock = vi.fn().mockResolvedValue({ sandboxId: 'sbx_fallback' });
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_fallback', {
        name: 'demo',
        info: infoMock,
      }),
    );
    const client = new TensorlakeSandboxClient({
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint.url).toContain('https://8080-demo.sandbox.tensorlake.ai');
  });

  test('seeds sandbox id via info() when create returns it unpopulated', async () => {
    const infoMock = vi.fn().mockResolvedValue({ sandboxId: 'sbx_from_info' });
    // Empty sandboxId from create simulates the snapshot-restore lazy-id path.
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('', { info: infoMock }),
    );
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());

    expect(infoMock).toHaveBeenCalled();
    expect(session.state.sandboxId).toBe('sbx_from_info');
  });

  test('captures and restores native snapshots through checkpoint()', async () => {
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();
    expect(checkpointMock).toHaveBeenCalledOnce();
    // Default waitUntil mirrors Python's `'local_ready'` — sufficient for
    // `Sandbox.create({ snapshotId })` restore on the same backend and
    // avoids blocking on remote-storage upload.
    expect(checkpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: 'local_ready' }),
    );

    const ref = decodeNativeSnapshotRef(archive);
    expect(ref?.provider).toBe('tensorlake');
    expect(ref?.snapshotId).toBe('snap_test');

    // Hydrating with the same archive should call Sandbox.create with the
    // recorded snapshot id.
    createMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_restored'));
    await session.hydrateWorkspace(archive);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snap_test' }),
    );
    expect(session.state.sandboxId).toBe('sbx_restored');
  });

  test('suspendOnExit close suspends named sandboxes', async () => {
    const client = new TensorlakeSandboxClient({
      name: 'demo',
      suspendOnExit: true,
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_named', { name: 'demo' }),
    );
    const session = await client.create(new Manifest());

    await session.close();

    expect(suspendMock).toHaveBeenCalledOnce();
    expect(terminateMock).not.toHaveBeenCalled();
    expect(client.canPersistOwnedSessionState(session.state)).toBe(true);
  });

  test('falls back to terminate when suspend fails on close', async () => {
    suspendMock.mockRejectedValueOnce(new Error('cannot suspend'));
    const client = new TensorlakeSandboxClient({
      name: 'demo',
      suspendOnExit: true,
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_named', { name: 'demo' }),
    );
    const session = await client.create(new Manifest());

    await session.close();

    expect(suspendMock).toHaveBeenCalledOnce();
    expect(terminateMock).toHaveBeenCalledOnce();
    expect(session.state.suspendOnExit).toBe(false);
  });

  test('ephemeral sandboxes always terminate on close', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());

    await session.close();

    expect(suspendMock).not.toHaveBeenCalled();
    expect(terminateMock).toHaveBeenCalledOnce();
  });

  test('cleanup lifecycle suspends persistable sessions only once', async () => {
    const client = new TensorlakeSandboxClient({
      name: 'demo',
      suspendOnExit: true,
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_named', { name: 'demo' }),
    );
    const session = await client.create(new Manifest());

    await session.shutdown!({
      reason: 'cleanup',
      preserveOwnedSessions: true,
    });
    await session.delete!({
      reason: 'cleanup',
      preserveOwnedSessions: true,
    });

    expect(suspendMock).toHaveBeenCalledOnce();
    expect(terminateMock).not.toHaveBeenCalled();
  });

  test('cleanup lifecycle terminates ephemeral sessions only once', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());

    await session.shutdown!({ reason: 'cleanup' });
    await session.delete!({ reason: 'cleanup' });

    expect(suspendMock).not.toHaveBeenCalled();
    expect(terminateMock).toHaveBeenCalledOnce();
  });

  test('resume reconnects to a named sandbox by sandboxId', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    const serialized = await client.serializeSessionState(session.state);
    const state = await client.deserializeSessionState(serialized);

    connectMock.mockClear();
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo' }),
    );

    const resumed = await client.resume(state);
    expect(connectMock).toHaveBeenCalledWith({ sandboxId: 'sbx_test' });
    expect(resumeMock).toHaveBeenCalledOnce();
    expect(resumed.state.sandboxId).toBe('sbx_test');
  });

  test('resume recreates the sandbox when the original is gone', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    createMock.mockClear();
    const notFound = Object.assign(new Error('sandbox not found'), {
      status: 404,
    });
    connectMock.mockRejectedValueOnce(notFound);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    const resumed = await client.resume(state);

    expect(connectMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledOnce();
    expect(resumed.state.sandboxId).toBe('sbx_recreated');
  });

  test('resume recreates when sandbox.resume() reports the sandbox is gone', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    createMock.mockClear();
    resumeMock.mockReset();
    const notFound = Object.assign(new Error('sandbox not found'), {
      status: 404,
    });
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo' }),
    );
    resumeMock.mockRejectedValueOnce(notFound);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    const resumed = await client.resume(state);

    expect(connectMock).toHaveBeenCalledOnce();
    expect(resumeMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledOnce();
    expect(resumed.state.sandboxId).toBe('sbx_recreated');
  });

  test('resume probes unnamed sandboxes via status() so a stale session triggers recreate', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    // Leave the session unnamed so resume() cannot use sandbox.resume().
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    createMock.mockClear();
    const statusMock = vi.fn().mockResolvedValue(undefined);
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { status: statusMock }),
    );

    const resumed = await client.resume(state);

    expect(connectMock).toHaveBeenCalledOnce();
    expect(statusMock).toHaveBeenCalledOnce();
    expect(resumeMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(resumed.state.sandboxId).toBe('sbx_test');
  });

  test('resume recreates an unnamed sandbox when the status probe reports 404', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    createMock.mockClear();
    const notFound = Object.assign(new Error('sandbox not found'), {
      status: 404,
    });
    const statusMock = vi.fn().mockRejectedValueOnce(notFound);
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { status: statusMock }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    const resumed = await client.resume(state);

    expect(connectMock).toHaveBeenCalledOnce();
    expect(statusMock).toHaveBeenCalledOnce();
    expect(resumeMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledOnce();
    expect(resumed.state.sandboxId).toBe('sbx_recreated');
  });

  test('resume recreates an unnamed sandbox when status() returns "terminated"', async () => {
    // Tensorlake's SDK does not throw for a terminated sandbox; status()
    // returns the SandboxStatus enum value. The probe must treat that as
    // dead so the recreate path runs.
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    createMock.mockClear();
    const statusMock = vi.fn().mockResolvedValueOnce('terminated');
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { status: statusMock }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    const resumed = await client.resume(state);

    expect(connectMock).toHaveBeenCalledOnce();
    expect(statusMock).toHaveBeenCalledOnce();
    expect(resumeMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledOnce();
    expect(resumed.state.sandboxId).toBe('sbx_recreated');
  });

  test('resume recreates a named sandbox when status() returns "terminated"', async () => {
    // The SDK's resume() polls and throws SandboxError (not 404) when a
    // sandbox reaches a terminated state, which would skip the recreate
    // fallback. Probing status() first converts that into a tagged
    // not-found error so the named-sandbox path also reaches recreate.
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    createMock.mockClear();
    resumeMock.mockReset();
    const statusMock = vi.fn().mockResolvedValueOnce('terminated');
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo', status: statusMock }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    const resumed = await client.resume(state);

    expect(connectMock).toHaveBeenCalledOnce();
    expect(statusMock).toHaveBeenCalledOnce();
    expect(resumeMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledOnce();
    expect(resumed.state.sandboxId).toBe('sbx_recreated');
  });

  test('resume forwards configured apiKey to Sandbox.connect', async () => {
    const client = new TensorlakeSandboxClient({
      apiKey: 'secret-key',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo' }),
    );

    await client.resume(state);

    expect(connectMock).toHaveBeenCalledWith({
      sandboxId: 'sbx_test',
      apiKey: 'secret-key',
    });
  });

  test('snapshot restore re-applies configured exposed ports via update()', async () => {
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_orig'));
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();

    createMock.mockClear();
    updateMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_restored'));

    await session.hydrateWorkspace(archive);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snap_test' }),
    );
    // Sandbox.create does not accept exposedPorts.
    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty('exposedPorts');
    // The restored sandbox must have its ports re-applied via update().
    expect(updateMock).toHaveBeenCalledWith({ exposedPorts: [8080] });
  });

  test('snapshot restore seeds sandbox id via info() before applying ports', async () => {
    // Regression: Sandbox.create({ snapshotId }) can return an instance with
    // an unpopulated sandboxId; info() seeds the SDK's internal cache that
    // sandbox.update() relies on. resolveSandboxId() must run before
    // applyPortConfiguration() so the port update has a usable id.
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_orig'));
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();

    const callOrder: string[] = [];
    const infoMock = vi.fn().mockImplementation(async () => {
      callOrder.push('info');
      return { sandboxId: 'sbx_restored' };
    });
    updateMock.mockClear();
    updateMock.mockImplementation(async () => {
      callOrder.push('update');
    });
    createMock.mockClear();
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('', { info: infoMock }),
    );

    await session.hydrateWorkspace(archive);

    expect(infoMock).toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith({ exposedPorts: [8080] });
    expect(callOrder).toEqual(['info', 'update']);
    expect(session.state.sandboxId).toBe('sbx_restored');
  });

  test('snapshot restore terminates the previous unnamed sandbox', async () => {
    // Unnamed sessions don't have a rename path, so the previous sandbox is
    // still reachable on the backend after replaceSandboxFromSnapshot swaps
    // in the new one. It must be terminated or it leaks quota.
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_orig'));
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();

    createMock.mockClear();
    terminateMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_restored'));

    await session.hydrateWorkspace(archive);

    expect(session.state.sandboxId).toBe('sbx_restored');
    expect(terminateMock).toHaveBeenCalledOnce();
  });

  test('snapshot restore failure preserves the previous sandbox', async () => {
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_orig'));
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();

    createMock.mockClear();
    terminateMock.mockClear();
    createMock.mockRejectedValueOnce(new Error('capacity exhausted'));

    await expect(session.hydrateWorkspace(archive)).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
    // Previous sandbox must not be torn down when the restore fails — the
    // session is still pointing at it and can keep running.
    expect(terminateMock).not.toHaveBeenCalled();
    expect(session.state.sandboxId).toBe('sbx_orig');
  });

  test('snapshot restore preserves the configured name via update()', async () => {
    const client = new TensorlakeSandboxClient({
      name: 'demo',
      workspacePersistence: 'snapshot',
      suspendOnExit: true,
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_orig'));
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();

    createMock.mockClear();
    updateMock.mockClear();
    terminateMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_restored'));

    await session.hydrateWorkspace(archive);

    // Sandbox.create() must NOT pass the name (otherwise it would collide
    // with the still-live previous sandbox).
    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty('name');
    // After create succeeds, the previous sandbox is terminated and the new
    // one is renamed back to the configured name to preserve suspend/resume.
    expect(terminateMock).toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith({ name: 'demo' });
    expect(session.state.name).toBe('demo');
    // Named-lifecycle preserved → suspendOnExit stays true.
    expect(session.state.suspendOnExit).toBe(true);
  });

  test('snapshot restore degrades to ephemeral when rename fails', async () => {
    // logger.error is expected on this codepath.
    allowConsole(['error']);
    const client = new TensorlakeSandboxClient({
      name: 'demo',
      workspacePersistence: 'snapshot',
      suspendOnExit: true,
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_orig'));
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();

    createMock.mockClear();
    updateMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_restored'));
    // First update() is the rename; subsequent update() (e.g. port config)
    // should still succeed.
    updateMock.mockRejectedValueOnce(new Error('rename forbidden'));

    await session.hydrateWorkspace(archive);

    // Session adopts the ephemeral sandbox so the workspace isn't lost, but
    // marks suspendOnExit false and clears the name so the broken named
    // lifecycle is visible rather than silently degrading on close().
    expect(session.state.sandboxId).toBe('sbx_restored');
    expect(session.state.name).toBeUndefined();
    expect(session.state.suspendOnExit).toBe(false);
  });

  test('throws SandboxProviderError when run() rejects unexpectedly', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    runMock.mockRejectedValueOnce(new Error('network down'));

    await expect(
      session.execCommand({ cmd: 'never-runs' }),
    ).rejects.toBeInstanceOf(SandboxProviderError);
  });

  test('forwards control-plane and resource options to Sandbox.create', async () => {
    const client = new TensorlakeSandboxClient({
      diskMb: 8192,
      startupTimeout: 120,
      proxyUrl: 'https://proxy.tensorlake.dev',
      apiUrl: 'https://api.tensorlake.dev',
      namespace: 'default',
      organizationId: 'org_123',
      projectId: 'proj_456',
      poolId: 'pool_warm',
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_cp'));

    await client.create(new Manifest());

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        diskMb: 8192,
        startupTimeout: 120,
        proxyUrl: 'https://proxy.tensorlake.dev',
        apiUrl: 'https://api.tensorlake.dev',
        namespace: 'default',
        organizationId: 'org_123',
        projectId: 'proj_456',
        poolId: 'pool_warm',
      }),
    );
  });

  test('snapshot restore drops poolId (snapshot takes precedence)', async () => {
    // buildCreateOptions warns when poolId is dropped for snapshot restore.
    allowConsole(['warn']);
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      poolId: 'pool_warm',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());

    const archive = await session.persistWorkspace();

    createMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_restored'));
    await session.hydrateWorkspace(archive);

    const callArg = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.snapshotId).toBe('snap_test');
    expect(callArg).not.toHaveProperty('poolId');
  });

  test('auto-generates a name when suspendOnExit is set without one', async () => {
    const client = new TensorlakeSandboxClient({
      suspendOnExit: true,
    } satisfies TensorlakeSandboxClientOptions);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_auto'));

    const session = await client.create(new Manifest());

    const callArg = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const passedName = callArg.name as string | undefined;
    expect(passedName).toBeTypeOf('string');
    expect(passedName!.startsWith('openai-agents-')).toBe(true);
    expect(session.state.name).toBe(passedName);
  });

  test('does not auto-name ephemeral sandboxes', async () => {
    const client = new TensorlakeSandboxClient();
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_eph'));

    await client.create(new Manifest());

    const callArg = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('name');
  });

  test('forwards routingHint to Sandbox.connect on resume', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    session.state.routingHint = 'host-42';
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo' }),
    );

    await client.resume(state);

    expect(connectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: 'sbx_test',
        routingHint: 'host-42',
      }),
    );
  });

  test('respects custom timeouts on exec and manifest commands', async () => {
    const client = new TensorlakeSandboxClient({
      timeouts: {
        execTimeoutUnboundedSecs: 60,
        fastOpSecs: 5,
        snapshotTarSecs: 120,
      },
    } satisfies TensorlakeSandboxClientOptions);

    const session = await client.create(new Manifest());
    runMock.mockClear();
    await session.execCommand({ cmd: 'ls' });
    expect(runMock).toHaveBeenLastCalledWith(
      '/bin/bash',
      expect.objectContaining({ timeout: 60 }),
    );

    // mkdir-style call (kind: 'manifest') should use fastOpSecs.
    await session
      .readFile({ path: '/home/tl-user/workspace/README.md' })
      .catch(() => undefined);
    // Confirm at least one previous call ran with timeout: 5.
    const fastCalls = runMock.mock.calls.filter(
      ([, opts]) => (opts as { timeout?: number }).timeout === 5,
    );
    expect(fastCalls.length).toBeGreaterThan(0);
  });

  test('rejects invalid timeouts at create()', async () => {
    const client = new TensorlakeSandboxClient({
      timeouts: { fastOpSecs: -1 },
    } satisfies TensorlakeSandboxClientOptions);
    await expect(client.create(new Manifest())).rejects.toThrow(/positive/);
  });

  test('retries the tar persist command on transient HTTP errors', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());

    // Pre-seed an empty (valid) tar archive at the path the persist flow uses,
    // so that the post-tar readFile() succeeds.
    const emptyTar = new Uint8Array(1024); // two zero blocks
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith('.tar')) return emptyTar;
      const value = remoteFiles.get(path);
      if (!value) throw new Error(`not found: ${path}`);
      return value;
    });

    let tarCalls = 0;
    const baseRunMock = runMock.getMockImplementation()!;
    runMock.mockImplementation(async (command, options) => {
      const shellCommand = (options as { args?: string[] })?.args?.[1] ?? '';
      // The shared persist combines `mkdir -p -- ... && tar ...` into one call.
      if (
        shellCommand.startsWith('mkdir -p -- ') &&
        shellCommand.includes('tar ')
      ) {
        tarCalls += 1;
        if (tarCalls === 1) {
          throw Object.assign(new Error('upstream 503'), { status: 503 });
        }
      }
      return await baseRunMock(command, options);
    });

    await session.persistWorkspace();
    expect(tarCalls).toBeGreaterThanOrEqual(2);
  });

  test('hydrateWorkspace forwards per-call archiveLimits override to tar restore', async () => {
    // Regression: the override used to be dropped, so per-call stricter
    // limits and `archiveLimits: null` were both silently ignored.
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());

    const archive = makeTarArchive([
      { name: 'one.txt', content: '1' },
      { name: 'two.txt', content: '22' },
    ]);

    await expect(
      session.hydrateWorkspace(archive, {
        archiveLimits: {
          maxInputBytes: null,
          maxExtractedBytes: null,
          maxMembers: 1,
        },
      }),
    ).rejects.toBeInstanceOf(SandboxArchiveError);
  });

  test('forwards runAs through to sandbox.run() for exec', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    runMock.mockClear();

    await session.execCommand({ cmd: 'whoami', runAs: 'app' });

    expect(runMock).toHaveBeenLastCalledWith(
      '/bin/bash',
      expect.objectContaining({
        args: ['-lc', 'whoami'],
        user: 'app',
      }),
    );
  });

  test('tty exec runAs is unsupported because the Tensorlake SDK has no user option', async () => {
    const createPtyMock = vi.fn();
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_pty', { createPty: createPtyMock }),
    );
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'ls', tty: true, runAs: 'app' }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(createPtyMock).not.toHaveBeenCalled();
  });

  test('resume prefers trusted constructor control-plane options over serialized state', async () => {
    const createClient = new TensorlakeSandboxClient({
      proxyUrl: 'https://create-proxy.tensorlake.dev',
      apiUrl: 'https://create-api.tensorlake.dev',
      namespace: 'create-namespace',
      organizationId: 'org_create',
      projectId: 'proj_create',
      routingHint: 'create-host',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await createClient.create(new Manifest());
    session.state.name = 'demo';
    const serialized = await createClient.serializeSessionState(session.state);

    const resumeClient = new TensorlakeSandboxClient({
      proxyUrl: 'https://trusted-proxy.tensorlake.dev',
      apiUrl: 'https://trusted-api.tensorlake.dev',
      namespace: 'trusted-namespace',
      organizationId: 'org_trusted',
      projectId: 'proj_trusted',
      routingHint: 'trusted-host',
      apiKey: 'trusted-key',
    } satisfies TensorlakeSandboxClientOptions);
    const state = await resumeClient.deserializeSessionState({
      ...serialized,
      proxyUrl: 'https://serialized-proxy.tensorlake.dev',
      apiUrl: 'https://serialized-api.tensorlake.dev',
      namespace: 'serialized-namespace',
      organizationId: 'org_serialized',
      projectId: 'proj_serialized',
      routingHint: 'serialized-host',
    });

    connectMock.mockClear();
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo' }),
    );

    await resumeClient.resume(state);

    expect(connectMock).toHaveBeenCalledWith({
      sandboxId: 'sbx_test',
      proxyUrl: 'https://trusted-proxy.tensorlake.dev',
      apiUrl: 'https://trusted-api.tensorlake.dev',
      namespace: 'trusted-namespace',
      organizationId: 'org_trusted',
      projectId: 'proj_trusted',
      routingHint: 'trusted-host',
      apiKey: 'trusted-key',
    });
  });

  test('snapshot resume recreate prefers trusted constructor control-plane options', async () => {
    allowConsole(['warn']);
    const createClient = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      poolId: 'serialized-pool',
      proxyUrl: 'https://create-proxy.tensorlake.dev',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await createClient.create(new Manifest());
    session.state.name = 'demo';
    await session.persistWorkspace();
    const serialized = await createClient.serializeSessionState(session.state);

    const resumeClient = new TensorlakeSandboxClient({
      proxyUrl: 'https://trusted-proxy.tensorlake.dev',
      apiUrl: 'https://trusted-api.tensorlake.dev',
      namespace: 'trusted-namespace',
      organizationId: 'org_trusted',
      projectId: 'proj_trusted',
      routingHint: 'trusted-host',
      apiKey: 'trusted-key',
    } satisfies TensorlakeSandboxClientOptions);
    const state = await resumeClient.deserializeSessionState({
      ...serialized,
      proxyUrl: 'https://serialized-proxy.tensorlake.dev',
      apiUrl: 'https://serialized-api.tensorlake.dev',
      namespace: 'serialized-namespace',
      organizationId: 'org_serialized',
      projectId: 'proj_serialized',
      routingHint: 'serialized-host',
    });

    connectMock.mockClear();
    createMock.mockClear();
    connectMock.mockRejectedValueOnce(
      Object.assign(new Error('sandbox not found'), { status: 404 }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_from_snapshot'));

    await resumeClient.resume(state);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: 'snap_test',
        proxyUrl: 'https://trusted-proxy.tensorlake.dev',
        apiUrl: 'https://trusted-api.tensorlake.dev',
        namespace: 'trusted-namespace',
        organizationId: 'org_trusted',
        projectId: 'proj_trusted',
        apiKey: 'trusted-key',
      }),
    );
  });

  test('resume recreate prefers trusted constructor sensitive fields over tampered state', async () => {
    const createClient = new TensorlakeSandboxClient({
      secretNames: ['SAFE_SECRET'],
      allowInternetAccess: false,
      allowOut: ['allowlist.example.com'],
      denyOut: ['blocked.example.com'],
      image: 'trusted/image:1.0',
      entrypoint: ['/safe/entrypoint'],
      exposedPorts: [8080],
      allowUnauthenticatedAccess: false,
    } satisfies TensorlakeSandboxClientOptions);
    const session = await createClient.create(new Manifest());
    session.state.name = 'demo';
    const serialized = await createClient.serializeSessionState(session.state);

    // Simulate a tampered/persisted payload that swaps every sensitive
    // sandbox-config field for something the attacker would prefer.
    const tampered = {
      ...serialized,
      secretNames: ['ATTACKER_SECRET', 'AWS_ACCESS_KEY_ID'],
      allowInternetAccess: true,
      allowOut: [],
      denyOut: [],
      image: 'attacker/image:latest',
      entrypoint: ['/attacker/entrypoint'],
      configuredExposedPorts: [22, 9999],
      allowUnauthenticatedAccess: true,
    };

    const resumeClient = new TensorlakeSandboxClient({
      secretNames: ['SAFE_SECRET'],
      allowInternetAccess: false,
      allowOut: ['allowlist.example.com'],
      denyOut: ['blocked.example.com'],
      image: 'trusted/image:1.0',
      entrypoint: ['/safe/entrypoint'],
      exposedPorts: [8080],
      allowUnauthenticatedAccess: false,
    } satisfies TensorlakeSandboxClientOptions);
    const state = await resumeClient.deserializeSessionState(tampered);

    connectMock.mockClear();
    createMock.mockClear();
    connectMock.mockRejectedValueOnce(
      Object.assign(new Error('sandbox not found'), { status: 404 }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    await resumeClient.resume(state);

    expect(createMock).toHaveBeenCalledOnce();
    const passed = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).toEqual(
      expect.objectContaining({
        secretNames: ['SAFE_SECRET'],
        allowInternetAccess: false,
        allowOut: ['allowlist.example.com'],
        denyOut: ['blocked.example.com'],
        image: 'trusted/image:1.0',
        entrypoint: ['/safe/entrypoint'],
      }),
    );
  });

  test('snapshot resume recreate prefers trusted exposed-port / unauthenticated-access over tampered state', async () => {
    allowConsole(['warn']);
    const createClient = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      exposedPorts: [8080],
      allowUnauthenticatedAccess: false,
    } satisfies TensorlakeSandboxClientOptions);
    const session = await createClient.create(new Manifest());
    session.state.name = 'demo';
    await session.persistWorkspace();
    const serialized = await createClient.serializeSessionState(session.state);

    // Tamper the persisted port config so a resume that picks up this state
    // would re-expose attacker-controlled ports / disable auth — unless the
    // trusted in-process options win.
    const tampered = {
      ...serialized,
      configuredExposedPorts: [22, 9999],
      allowUnauthenticatedAccess: true,
    };

    const resumeClient = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      exposedPorts: [8080],
      allowUnauthenticatedAccess: false,
    } satisfies TensorlakeSandboxClientOptions);
    const state = await resumeClient.deserializeSessionState(tampered);

    connectMock.mockClear();
    createMock.mockClear();
    updateMock.mockClear();
    connectMock.mockRejectedValueOnce(
      Object.assign(new Error('sandbox not found'), { status: 404 }),
    );
    const restored = makeSandboxInstance('sbx_resumed');
    createMock.mockResolvedValueOnce(restored);

    const resumed = await resumeClient.resume(state);

    // Live sandbox must be configured from trusted options, not tampered
    // state — port 22 / 9999 / allowUnauthenticatedAccess:true must not leak
    // through into the update() call against the restored sandbox.
    expect(updateMock).toHaveBeenCalledWith({
      exposedPorts: [8080],
      allowUnauthenticatedAccess: false,
    });
    expect(updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ exposedPorts: [22, 9999] }),
    );
    // The session's port cache must also reflect trusted values so a later
    // resolveExposedPort() doesn't trust the tampered set.
    expect(resumed.state.configuredExposedPorts).toEqual([8080]);
    expect(resumed.state.allowUnauthenticatedAccess).toBe(false);
  });

  test('resume connect normalizes tampered exposed-port cache against trusted options', async () => {
    // Even on the connect path the live sandbox is not reconfigured, but the
    // session's port-cache must reflect trusted values — otherwise a later
    // on-demand resolveExposedPort() would push the attacker's ports through
    // sandbox.update() under the cover of a user-requested port change.
    const createClient = new TensorlakeSandboxClient({
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    const session = await createClient.create(new Manifest());
    session.state.name = 'demo';
    const serialized = await createClient.serializeSessionState(session.state);

    const tampered = {
      ...serialized,
      configuredExposedPorts: [22, 9999],
    };

    const resumeClient = new TensorlakeSandboxClient({
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    const state = await resumeClient.deserializeSessionState(tampered);

    connectMock.mockClear();
    updateMock.mockClear();
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo' }),
    );

    const resumed = await resumeClient.resume(state);

    expect(resumed.state.configuredExposedPorts).toEqual([8080]);
    // Asking for a new port should merge against the trusted set, not the
    // tampered one.
    await resumed.resolveExposedPort(7000);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ exposedPorts: [8080, 7000] }),
    );
  });

  test('resume recreate falls back to state sensitive fields when constructor leaves them unset', async () => {
    const createClient = new TensorlakeSandboxClient({
      secretNames: ['LEGIT_SECRET'],
      allowOut: ['legit.example.com'],
    } satisfies TensorlakeSandboxClientOptions);
    const session = await createClient.create(new Manifest());
    session.state.name = 'demo';
    const serialized = await createClient.serializeSessionState(session.state);

    // resumeClient supplies no sensitive options, so state values must
    // flow through to the recreate.
    const resumeClient = new TensorlakeSandboxClient();
    const state = await resumeClient.deserializeSessionState(serialized);

    connectMock.mockClear();
    createMock.mockClear();
    connectMock.mockRejectedValueOnce(
      Object.assign(new Error('sandbox not found'), { status: 404 }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    await resumeClient.resume(state);

    const passed = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).toEqual(
      expect.objectContaining({
        secretNames: ['LEGIT_SECRET'],
        allowOut: ['legit.example.com'],
      }),
    );
  });

  test("resume recreate preserves manifestIdentities: 'provision' from state", async () => {
    // A session created in 'provision' mode and then resumed by a fresh
    // client (which did not repeat the option) must still recreate in
    // 'provision' mode — otherwise manifest application silently drops back
    // to 'collapse' and skips account provisioning on the custom image.
    const manifest = new Manifest({
      users: [{ name: 'alice' }],
      groups: [{ name: 'staff', users: [{ name: 'alice' }] }],
    });
    const createClient = new TensorlakeSandboxClient({
      manifestIdentities: 'provision',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await createClient.create(manifest);
    session.state.name = 'demo';

    const resumeClient = new TensorlakeSandboxClient();
    const state = await resumeClient.deserializeSessionState(
      await createClient.serializeSessionState(session.state),
    );

    // Force the fallback recreate path and discard create-time shell calls
    // so the assertions below only count what fired during resume.
    connectMock.mockClear();
    createMock.mockClear();
    runMock.mockClear();
    connectMock.mockRejectedValueOnce(
      Object.assign(new Error('sandbox not found'), { status: 404 }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_recreated'));

    const resumed = await resumeClient.resume(state);
    expect(resumed.state.manifestIdentities).toBe('provision');

    const shellCommands = runMock.mock.calls
      .map(([, opts]) => (opts as { args?: string[] })?.args?.[1] ?? '')
      .filter((s) => s.length > 0);
    expect(shellCommands.some((c) => c.includes('groupadd'))).toBe(true);
    expect(shellCommands.some((c) => c.includes('useradd'))).toBe(true);
  });

  test('uses native sandbox.run for mkdir on prepareWorkspaceRoot', async () => {
    const client = new TensorlakeSandboxClient();
    runMock.mockClear();

    await client.create(new Manifest());

    // The first mkdir matches the manifest root; assert it goes through
    // sandbox.run('mkdir', { args: ['-p', '--', root] }) not a shell wrap.
    const mkdirCalls = runMock.mock.calls.filter(([cmd]) => cmd === 'mkdir');
    expect(mkdirCalls.length).toBeGreaterThanOrEqual(1);
    expect(mkdirCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        args: ['-p', '--', '/home/tl-user/workspace'],
      }),
    );
  });

  test('persistWorkspace caches snapshotId on state for resume fast-path', async () => {
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());

    expect(session.state.snapshotId).toBeUndefined();
    await session.persistWorkspace();
    expect(session.state.snapshotId).toBe('snap_test');
  });

  test('persistWorkspaceTar invalidates a cached snapshotId', async () => {
    // Mixing snapshot + tar persistence within a single session is unusual,
    // but the cached snapshotId must not survive a tar persist — otherwise
    // resume would restore stale state.
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());
    await session.persistWorkspace();
    expect(session.state.snapshotId).toBe('snap_test');

    // Switch to tar mode and persist again.
    session.state.workspacePersistence = 'tar';
    const emptyTar = new Uint8Array(1024);
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith('.tar')) return emptyTar;
      const value = remoteFiles.get(path);
      if (!value) throw new Error(`not found: ${path}`);
      return value;
    });

    await session.persistWorkspace();
    expect(session.state.snapshotId).toBeUndefined();
  });

  test('execCommand invalidates cached snapshotId post-snapshot', async () => {
    // After persistWorkspace caches a snapshotId, an exec that may have
    // mutated the workspace must clear the cache. Otherwise resume()'s
    // fast-path would silently restore the pre-mutation snapshot if the live
    // sandbox dies. Callers wanting partial recovery can still pass the
    // archive bytes to hydrateWorkspace() on the new session.
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());
    await session.persistWorkspace();
    expect(session.state.snapshotId).toBe('snap_test');

    await session.execCommand({ cmd: 'ls' });
    expect(session.state.snapshotId).toBeUndefined();
  });

  test('resume recreates from cached snapshotId without applyManifest', async () => {
    // The fast-path: when reconnect fails on a snapshot-persisted session,
    // resume() should create directly with snapshotId rather than building a
    // fresh sandbox and then having hydrateWorkspace tear it down. Confirm
    // that (a) Sandbox.create receives snapshotId, (b) no shell `groupadd`
    // or `useradd` round-trip fires (system preserved), and (c) the session
    // does not redo the workspace-root mkdir on later prepareWorkspaceRoot.
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    await session.persistWorkspace();
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );
    expect(state.snapshotId).toBe('snap_test');

    connectMock.mockClear();
    createMock.mockClear();
    runMock.mockClear();
    const notFound = Object.assign(new Error('sandbox not found'), {
      status: 404,
    });
    connectMock.mockRejectedValueOnce(notFound);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_from_snapshot'));

    const resumed = await client.resume(state);

    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snap_test' }),
    );
    expect(resumed.state.sandboxId).toBe('sbx_from_snapshot');
    // The snapshot image carries the workspace root + manifest accounts.
    expect(resumed.state.workspaceRootProvisioned).toBe(true);
    expect(resumed.state.systemSetupPreserved).toBe(true);

    // A follow-up prepareWorkspaceRoot must not re-issue mkdir.
    runMock.mockClear();
    await resumed.prepareWorkspaceRoot();
    const mkdirAfter = runMock.mock.calls.filter(([cmd]) => cmd === 'mkdir');
    expect(mkdirAfter).toHaveLength(0);
  });

  test('resume falls back to fresh create when the cached snapshotId is gone', async () => {
    // If the stored snapshot has been pruned on the backend, the fast-path
    // surfaces a 404 from Sandbox.create({ snapshotId }). The resume should
    // then continue with a normal fresh recreate rather than throwing.
    allowConsole(['warn']);
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    await session.persistWorkspace();
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    createMock.mockClear();
    const notFound = Object.assign(new Error('sandbox not found'), {
      status: 404,
    });
    connectMock.mockRejectedValueOnce(notFound);
    createMock.mockRejectedValueOnce(
      Object.assign(new Error('snapshot expired'), { status: 404 }),
    );
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_fresh'));

    const resumed = await client.resume(state);

    expect(createMock).toHaveBeenCalledTimes(2);
    // First create attempt used snapshotId; second was a fresh recreate.
    expect(createMock.mock.calls[0]?.[0]).toHaveProperty(
      'snapshotId',
      'snap_test',
    );
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty('snapshotId');
    expect(resumed.state.sandboxId).toBe('sbx_fresh');
  });

  test('snapshot-resume fast-path drops the previous sandbox exposed-port cache', async () => {
    // Regression: resolveExposedPort caches the resolved URL on
    // state.exposedPorts (keyed by port). The snapshot fast-path used to
    // spread the prior state verbatim into the resumed session, so a port
    // resolved on the old sandbox would return the deleted sandbox's URL
    // forever — useCachedExposedPortEndpoint() returns true by default.
    const client = new TensorlakeSandboxClient({
      workspacePersistence: 'snapshot',
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());
    // Unnamed: the fallback URL template embeds sandboxId, so a stale cache
    // is observable without depending on info().sandbox_url plumbing.
    const originalEndpoint = await session.resolveExposedPort(8080);
    expect(originalEndpoint.url).toContain('sbx_test');
    expect(session.state.exposedPorts).toBeDefined();

    await session.persistWorkspace();
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );
    // The bug premise: the stale cache survives serialization.
    expect(state.exposedPorts).toBeDefined();
    expect(state.snapshotId).toBe('snap_test');

    connectMock.mockClear();
    createMock.mockClear();
    updateMock.mockClear();
    const notFound = Object.assign(new Error('sandbox not found'), {
      status: 404,
    });
    connectMock.mockRejectedValueOnce(notFound);
    createMock.mockResolvedValueOnce(makeSandboxInstance('sbx_resumed'));

    const resumed = await client.resume(state);

    expect(resumed.state.sandboxId).toBe('sbx_resumed');
    // The cache for the deleted sandbox must be cleared so the next
    // resolveExposedPort() re-resolves against the restored sandbox.
    expect(resumed.state.exposedPorts).toBeUndefined();
    const newEndpoint = await resumed.resolveExposedPort(8080);
    expect(newEndpoint.url).toContain('sbx_resumed');
    expect(newEndpoint.url).not.toContain('sbx_test');
  });

  test('reconnect marks workspace + system state preserved', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    session.state.name = 'demo';
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    );

    connectMock.mockClear();
    connectMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_test', { name: 'demo' }),
    );

    const resumed = await client.resume(state);
    expect(resumed.state.workspaceRootProvisioned).toBe(true);
    expect(resumed.state.systemSetupPreserved).toBe(true);
  });

  test('falls back to public template (with warning) when custom proxyUrl deployment lacks sandbox_url', async () => {
    // The fallback emits a warn so callers know the public template likely
    // won't route to their custom deployment.
    allowConsole(['warn']);
    const infoMock = vi.fn().mockResolvedValue({ sandboxId: 'sbx_custom' });
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_custom', {
        name: 'demo',
        info: infoMock,
      }),
    );
    const client = new TensorlakeSandboxClient({
      proxyUrl: 'https://proxy.tensorlake.dev',
      exposedPorts: [8080],
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());
    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint.url).toContain('https://8080-demo.sandbox.tensorlake.ai');
  });

  test('deserializeSessionState rejects an invalid workspacePersistence value', async () => {
    const client = new TensorlakeSandboxClient();
    await expect(
      client.deserializeSessionState({
        sandboxId: 'sbx_test',
        workspacePersistence: 'bogus',
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('deserializeSessionState rejects an invalid snapshotCheckpointType value', async () => {
    const client = new TensorlakeSandboxClient();
    await expect(
      client.deserializeSessionState({
        sandboxId: 'sbx_test',
        snapshotCheckpointType: 'bogus',
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('tty exec without SDK PTY support throws SandboxUnsupportedFeatureError', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    await expect(
      session.execCommand({ cmd: 'ls', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('on-demand exposed port without sandbox.update throws SandboxUnsupportedFeatureError', async () => {
    createMock.mockResolvedValueOnce(
      makeSandboxInstance('sbx_no_update', { update: undefined }),
    );
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());

    await expect(session.resolveExposedPort(9090)).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
  });

  test('on-demand exposed port wraps update() errors in SandboxProviderError', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    updateMock.mockRejectedValueOnce(new Error('rate limited'));

    await expect(session.resolveExposedPort(9090)).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
  });

  test('suspend + terminate both failing during close raises SandboxProviderError', async () => {
    suspendMock.mockRejectedValueOnce(new Error('suspend boom'));
    terminateMock.mockRejectedValueOnce(new Error('terminate boom'));
    const client = new TensorlakeSandboxClient({
      name: 'demo',
      suspendOnExit: true,
    } satisfies TensorlakeSandboxClientOptions);
    const session = await client.create(new Manifest());

    await expect(session.close()).rejects.toBeInstanceOf(SandboxProviderError);
    expect(suspendMock).toHaveBeenCalledOnce();
    expect(terminateMock).toHaveBeenCalledOnce();
  });

  test.each([
    {
      label: 'SDK rejection',
      outcome: () => Promise.reject(new Error('disk full')),
    },
    {
      label: 'non-zero exit',
      outcome: () =>
        Promise.resolve({
          stdout: '',
          stderr: 'mkdir: permission denied',
          exitCode: 1,
        }),
    },
  ])(
    'create() surfaces mkdir $label as SandboxProviderError',
    async ({ outcome }) => {
      const client = new TensorlakeSandboxClient();
      runMock.mockImplementation(async (command: string) =>
        command === 'mkdir'
          ? await outcome()
          : { stdout: '', stderr: '', exitCode: 0 },
      );

      await expect(client.create(new Manifest())).rejects.toBeInstanceOf(
        SandboxProviderError,
      );
    },
  );

  test('readFile surfaces missing remote files as UserError', async () => {
    const client = new TensorlakeSandboxClient();
    const session = await client.create(new Manifest());
    readFileMock.mockRejectedValueOnce(new Error('not found'));

    await expect(
      session.readFile({ path: '/home/tl-user/workspace/missing.txt' }),
    ).rejects.toBeInstanceOf(UserError);
  });
});
