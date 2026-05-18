import { Manifest, SandboxProviderError } from '@openai/agents-core/sandbox';
import { promises as fs } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NorthflankSandboxClient } from '../../src/sandbox/northflank';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';

type StubClient = ReturnType<typeof makeStubClient>;

/**
 * In-memory stub of the @northflank/js-client surface NorthflankSandboxClient
 * touches. Models a single deployment service with an ephemeral filesystem
 * shared across mocked exec + file-copy calls.
 */
function makeStubClient() {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(['/', '/workspace']);
  const calls: { method: string; args: unknown[] }[] = [];

  let createdServiceId = 'sandbox-test-abc';
  let servicePaused = false;
  let deploymentStatus: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' =
    'COMPLETED';

  /**
   * Dispatch a `sh -c '<inner>'` shell line against our in-memory FS. The
   * provider only ever sends `sh -c '<inner>'` where `<inner>` looks like
   * `cd '<workdir>' && <user_command>`. We strip the cd prefix and match
   * the suffix against a handful of well-known forms.
   */
  function dispatchExec(argv: unknown): {
    stdOut: string;
    stdErr: string;
    exitCode: number;
  } {
    if (!Array.isArray(argv) || argv[0] !== 'sh' || argv[1] !== '-c') {
      return { stdOut: '', stdErr: 'expected sh -c argv', exitCode: 2 };
    }
    const rawInner = String(argv[2] ?? '');
    // The base class validates user-supplied paths by running an embedded
    // resolve-workspace-path.sh helper through exec. Echo the requested
    // path back so the validator sees an absolute resolution.
    const resolved = resolvedRemotePathFromValidationCommand(rawInner);
    if (resolved) {
      return { stdOut: `${resolved}\n`, stdErr: '', exitCode: 0 };
    }
    const inner = rawInner.replace(/^cd '[^']*' && /, '');

    const mkdir = inner.match(/^mkdir -p -- '([^']*)'$/);
    if (mkdir) {
      dirs.add(mkdir[1]);
      return { stdOut: '', stdErr: '', exitCode: 0 };
    }
    const rmrf = inner.match(/^rm -rf -- '([^']*)'$/);
    if (rmrf) {
      files.delete(rmrf[1]);
      dirs.delete(rmrf[1]);
      return { stdOut: '', stdErr: '', exitCode: 0 };
    }
    const teste = inner.match(/^test -e '([^']*)'$/);
    if (teste) {
      const path = teste[1];
      return {
        stdOut: '',
        stdErr: '',
        exitCode: files.has(path) || dirs.has(path) ? 0 : 1,
      };
    }
    const tarCreate = inner.match(/^tar czf '([^']*)' -C '([^']*)' \.$/);
    if (tarCreate) {
      const [, archivePath, root] = tarCreate;
      if (!dirs.has(root)) {
        return { stdOut: '', stdErr: 'no such dir', exitCode: 2 };
      }
      const prefix = root.endsWith('/') ? root : `${root}/`;
      const captured: Record<string, string> = {};
      for (const [fpath, content] of files) {
        if (fpath.startsWith(prefix)) {
          captured[fpath.slice(prefix.length)] = content.toString('utf8');
        }
      }
      files.set(archivePath, Buffer.from(JSON.stringify(captured)));
      return { stdOut: '', stdErr: '', exitCode: 0 };
    }
    const tarList = inner.match(/^tar -tzf '([^']*)'$/);
    if (tarList) {
      if (pendingTarListing !== null) {
        return { stdOut: pendingTarListing, stdErr: '', exitCode: 0 };
      }
      const blob = files.get(tarList[1]);
      if (!blob) return { stdOut: '', stdErr: 'no archive', exitCode: 2 };
      try {
        const obj = JSON.parse(blob.toString('utf8')) as Record<string, string>;
        return {
          stdOut: `${Object.keys(obj).join('\n')}\n`,
          stdErr: '',
          exitCode: 0,
        };
      } catch {
        return { stdOut: '', stdErr: 'corrupt archive', exitCode: 2 };
      }
    }
    const tarListVerbose = inner.match(/^tar -tvzf '([^']*)'$/);
    if (tarListVerbose) {
      if (pendingTarVerbose !== null) {
        return { stdOut: pendingTarVerbose, stdErr: '', exitCode: 0 };
      }
      const blob = files.get(tarListVerbose[1]);
      if (!blob) return { stdOut: '', stdErr: 'no archive', exitCode: 2 };
      try {
        const obj = JSON.parse(blob.toString('utf8')) as Record<string, string>;
        const lines = Object.keys(obj).map(
          (p) => `-rw-r--r-- 0/0 0 2025-01-01 00:00 ${p}`,
        );
        return { stdOut: `${lines.join('\n')}\n`, stdErr: '', exitCode: 0 };
      } catch {
        return { stdOut: '', stdErr: 'corrupt archive', exitCode: 2 };
      }
    }
    const tarExtract = inner.match(/^tar xzf '([^']*)' -C '([^']*)'$/);
    if (tarExtract) {
      const [, archivePath, root] = tarExtract;
      const blob = files.get(archivePath);
      if (!blob) return { stdOut: '', stdErr: 'no archive', exitCode: 2 };
      const prefix = root.endsWith('/') ? root : `${root}/`;
      const restored = JSON.parse(blob.toString('utf8')) as Record<
        string,
        string
      >;
      dirs.add(root);
      for (const [rel, content] of Object.entries(restored)) {
        files.set(`${prefix}${rel}`, Buffer.from(content, 'utf8'));
      }
      return { stdOut: '', stdErr: '', exitCode: 0 };
    }
    const rmf = inner.match(/^rm -f -- '([^']*)'$/);
    if (rmf) {
      files.delete(rmf[1]);
      return { stdOut: '', stdErr: '', exitCode: 0 };
    }
    const testf = inner.match(/^test -f '([^']*)'$/);
    if (testf) {
      return { stdOut: '', stdErr: '', exitCode: files.has(testf[1]) ? 0 : 1 };
    }
    const ls = inner.match(/^ls -1Ap -- '([^']*)'$/);
    if (ls) {
      const root = ls[1];
      if (!dirs.has(root)) {
        return { stdOut: '', stdErr: 'no such directory', exitCode: 2 };
      }
      const prefix = root.endsWith('/') ? root : `${root}/`;
      const entries: string[] = [];
      for (const f of files.keys()) {
        if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
          entries.push(f.slice(prefix.length));
        }
      }
      for (const d of dirs) {
        if (d === root) continue;
        if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
          entries.push(`${d.slice(prefix.length)}/`);
        }
      }
      return { stdOut: entries.join('\n'), stdErr: '', exitCode: 0 };
    }
    // Generic fallback for `execCommand` calls in tests.
    return { stdOut: 'ok', stdErr: '', exitCode: 0 };
  }

  const execServiceCommand = vi.fn(
    async (
      params: { projectId: string; serviceId: string; teamId?: string },
      data: { command: string | string[]; instanceName?: string },
    ) => {
      calls.push({ method: 'exec.execServiceCommand', args: [params, data] });
      const result = dispatchExec(data.command);
      return {
        commandResult: {
          exitCode: result.exitCode,
          status: result.exitCode === 0 ? 'Success' : 'Failure',
        },
        stdOut: result.stdOut,
        stdErr: result.stdErr,
      };
    },
  );

  const uploadServiceFiles = vi.fn(
    async (
      _params: unknown,
      options: { localPath: string; remotePath?: string },
    ) => {
      calls.push({
        method: 'fileCopy.uploadServiceFiles',
        args: [_params, options],
      });
      const buf = await fs.readFile(options.localPath);
      files.set(options.remotePath ?? '', buf);
      return { type: 'file-upload' };
    },
  );

  const downloadServiceFiles = vi.fn(
    async (
      _params: unknown,
      options: { localPath: string; remotePath?: string },
    ) => {
      calls.push({
        method: 'fileCopy.downloadServiceFiles',
        args: [_params, options],
      });
      const content = files.get(options.remotePath ?? '');
      if (content === undefined) {
        throw new Error(`download: no such file ${options.remotePath}`);
      }
      const target = `${options.localPath.replace(/\/$/, '')}/${(
        options.remotePath ?? ''
      )
        .split('/')
        .pop()}`;
      await fs.writeFile(target, content);
      return { type: 'file-download' };
    },
  );

  const getService = Object.assign(
    vi.fn(async () => ({
      data: {
        id: createdServiceId,
        servicePaused,
        status: { deployment: { status: deploymentStatus } },
      },
    })),
    {
      containers: vi.fn(async () => ({
        data: {
          containers: [
            { name: `${createdServiceId}-pod-0`, status: 'TASK_RUNNING' },
          ],
        },
      })),
    },
  );

  let volumeCounter = 0;
  const createVolume = vi.fn(async (opts: unknown) => {
    calls.push({ method: 'create.volume', args: [opts] });
    volumeCounter += 1;
    return { data: { id: `vol-${volumeCounter}` } };
  });
  const deleteVolume = vi.fn(async (opts: unknown) => {
    calls.push({ method: 'delete.volume', args: [opts] });
    return { data: {} };
  });
  const detachVolume = vi.fn(async (opts: unknown) => {
    calls.push({ method: 'detach.volume', args: [opts] });
    return { data: {} };
  });
  const attachVolume = vi.fn(async (opts: unknown) => {
    calls.push({ method: 'attach.volume', args: [opts] });
    return { data: {} };
  });

  let pendingTarListing: string | null = null;
  let pendingTarVerbose: string | null = null;

  const client = {
    create: {
      service: {
        deployment: vi.fn(async (...args: unknown[]) => {
          calls.push({ method: 'create.service.deployment', args });
          return { data: { id: createdServiceId } };
        }),
      },
      volume: createVolume,
    },
    get: { service: getService },
    delete: {
      service: vi.fn(async () => ({ data: {} })),
      volume: deleteVolume,
    },
    attach: { volume: attachVolume },
    detach: { volume: detachVolume },
    pause: { service: vi.fn(async () => ({ data: {} })) },
    resume: { service: vi.fn(async () => ({ data: {} })) },
    exec: { execServiceCommand },
    fileCopy: { uploadServiceFiles, downloadServiceFiles },
  };

  return {
    client,
    calls,
    files,
    setDeploymentStatus: (status: typeof deploymentStatus) => {
      deploymentStatus = status;
    },
    setServicePaused: (paused: boolean) => {
      servicePaused = paused;
    },
    setCreatedServiceId: (id: string) => {
      createdServiceId = id;
    },
    setTarListing: (listing: string | null) => {
      pendingTarListing = listing;
    },
    setTarVerbose: (verbose: string | null) => {
      pendingTarVerbose = verbose;
    },
  };
}

function makeSandbox(stub: StubClient, options: Record<string, unknown> = {}) {
  return new NorthflankSandboxClient({
    apiClient: stub.client as never,
    projectId: 'p',
    image: 'img',
    pollIntervalMs: 1,
    ...options,
  });
}

describe('NorthflankSandboxClient', () => {
  let stub: StubClient;

  beforeEach(() => {
    stub = makeStubClient();
  });

  test('requires projectId and image', () => {
    const incomplete = new NorthflankSandboxClient({
      apiClient: stub.client as never,
    });
    return expect(incomplete.create()).rejects.toThrow(/projectId/);
  });

  test('creates a deployment service and materializes the manifest', async () => {
    const sandbox = makeSandbox(stub);
    const manifest = new Manifest({
      root: '/workspace',
      entries: { 'README.md': { type: 'file', content: '# Hello\n' } },
    });

    const session = await sandbox.create(manifest);

    expect(session.state.serviceId).toBeTruthy();
    expect(session.state.workspaceRoot).toBe('/workspace');
    // create.service.deployment was called with instances pinned to 1
    const createCall = stub.calls.find(
      (c) => c.method === 'create.service.deployment',
    )!;
    const data = (
      createCall.args[0] as {
        data: {
          deployment: { instances: number; external: { imagePath: string } };
        };
      }
    ).data;
    expect(data.deployment.instances).toBe(1);
    expect(data.deployment.external.imagePath).toBe('img');
    // README.md ended up in the in-memory FS via uploadServiceFiles
    expect(stub.files.get('/workspace/README.md')?.toString('utf8')).toBe(
      '# Hello\n',
    );
    // Every fileCopy call is pinned to the resolved instance
    const uploadCall = stub.calls.find(
      (c) => c.method === 'fileCopy.uploadServiceFiles',
    )!;
    expect((uploadCall.args[1] as { instanceName?: string }).instanceName).toBe(
      session.state.instanceName,
    );
  });

  test('execCommand wraps user commands as `sh -c` and pins the instance', async () => {
    const sandbox = makeSandbox(stub);
    const session = await sandbox.create(new Manifest());
    await session.execCommand({ cmd: 'echo hi' });
    const execCall = [...stub.calls]
      .reverse()
      .find(
        (c: any) =>
          c.method === 'exec.execServiceCommand' &&
          Array.isArray((c.args[1] as { command?: unknown }).command) &&
          String((c.args[1] as { command: string[] }).command[2]).includes(
            'echo hi',
          ),
      );
    expect(execCall).toBeDefined();
    const data = execCall!.args[1] as {
      command: string[];
      shell?: string;
      instanceName?: string;
    };
    expect(data.command[0]).toBe('sh');
    expect(data.command[1]).toBe('-c');
    expect(data.shell).toBe('none');
    expect(data.instanceName).toBe(session.state.instanceName);
  });

  test('writeFile + readFile round-trip via fileCopy', async () => {
    const sandbox = makeSandbox(stub);
    const session = await sandbox.create(new Manifest({ root: '/workspace' }));

    await (
      session as unknown as {
        writeRemoteFile: (path: string, content: string) => Promise<void>;
      }
    ).writeRemoteFile('/workspace/hi.txt', 'world');
    const bytes = await (
      session as unknown as {
        readRemoteFile: (path: string) => Promise<Uint8Array>;
      }
    ).readRemoteFile('/workspace/hi.txt');
    expect(Buffer.from(bytes).toString('utf8')).toBe('world');
  });

  test('throws when the deployment never reaches COMPLETED', async () => {
    stub.setDeploymentStatus('FAILED');
    const sandbox = makeSandbox(stub);
    await expect(sandbox.create()).rejects.toBeInstanceOf(SandboxProviderError);
  });

  test('serializeSessionState → deserializeSessionState round-trips', async () => {
    const sandbox = makeSandbox(stub);
    const session = await sandbox.create(
      new Manifest({ entries: { 'a.txt': { type: 'file', content: 'A' } } }),
    );
    const serialized = await sandbox.serializeSessionState(session.state);
    const round = JSON.parse(JSON.stringify(serialized));
    const restored = await sandbox.deserializeSessionState(round);
    expect(restored.serviceId).toBe(session.state.serviceId);
    expect(restored.workspaceRoot).toBe(session.state.workspaceRoot);
    expect(restored.pauseOnExit).toBe(false);
  });

  test('close() deletes by default, pauses when pauseOnExit is true', async () => {
    const sandbox = makeSandbox(stub);
    const ephemeral = await sandbox.create(new Manifest());
    await ephemeral.close();
    expect(stub.client.delete.service).toHaveBeenCalled();
    expect(stub.client.pause.service).not.toHaveBeenCalled();

    const persisted = await makeSandbox(stub, { pauseOnExit: true }).create(
      new Manifest(),
    );
    await persisted.close();
    expect(stub.client.pause.service).toHaveBeenCalled();
  });

  test('stop() is a no-op without pauseOnExit so runtime stop+delete is safe', async () => {
    const sandbox = makeSandbox(stub);
    const session = await sandbox.create(new Manifest());
    await session.stop();
    expect(stub.client.pause.service).not.toHaveBeenCalled();
    expect(stub.client.delete.service).not.toHaveBeenCalled();
    await session.delete();
    expect(stub.client.delete.service).toHaveBeenCalledTimes(1);
  });

  test('delete() is idempotent', async () => {
    const sandbox = makeSandbox(stub);
    const session = await sandbox.create(new Manifest());
    await session.delete();
    await session.delete();
    expect(stub.client.delete.service).toHaveBeenCalledTimes(1);
  });

  test('delete() pauses instead of tearing down during runtime cleanup of a persistable session', async () => {
    // The Agents runtime calls stop(opts) then delete(opts) during cleanup
    // with { reason: 'cleanup', preserveOwnedSessions: true }. With
    // pauseOnExit, the session must survive that sequence so the
    // serialized state remains resumable.
    const sandbox = makeSandbox(stub, { pauseOnExit: true });
    const session = await sandbox.create(new Manifest());
    const cleanupOptions = {
      reason: 'cleanup',
      preserveOwnedSessions: true,
    };
    await session.stop(cleanupOptions);
    await session.delete(cleanupOptions);
    expect(stub.client.pause.service).toHaveBeenCalled();
    expect(stub.client.delete.service).not.toHaveBeenCalled();

    // After a paused cleanup, an explicit user-initiated delete() (no
    // cleanup options) should still tear down the service.
    await session.delete();
    expect(stub.client.delete.service).toHaveBeenCalledTimes(1);
  });

  test('delete() preserves volume-mode sessions during cleanup so resume can reach the volume', async () => {
    const sandbox = makeSandbox(stub, {
      workspacePersistence: 'volume',
      pauseOnExit: true,
    });
    const session = await sandbox.create(new Manifest());
    const volumeId = session.state.volumeId!;
    await session.delete({ reason: 'cleanup', preserveOwnedSessions: true });
    expect(stub.client.pause.service).toHaveBeenCalled();
    expect(stub.client.delete.service).not.toHaveBeenCalled();
    expect(stub.client.delete.volume).not.toHaveBeenCalled();
    expect(session.state.volumeId).toBe(volumeId);
  });

  test('delete() with cleanup options still tears down when the session is not persistable', async () => {
    const sandbox = makeSandbox(stub);
    const session = await sandbox.create(new Manifest());
    await session.delete({ reason: 'cleanup', preserveOwnedSessions: true });
    expect(stub.client.pause.service).not.toHaveBeenCalled();
    expect(stub.client.delete.service).toHaveBeenCalledTimes(1);
  });

  test('env merge: manifest environment wins over options.env on key collision', async () => {
    const sandbox = makeSandbox(stub, {
      env: { SHARED: 'from-options', FROM_OPTIONS: 'opt' },
    });
    const session = await sandbox.create(
      new Manifest({
        environment: {
          SHARED: { value: 'from-manifest' },
          FROM_MANIFEST: { value: 'man' },
        },
      }),
    );
    expect(session.state.environment).toEqual({
      SHARED: 'from-manifest',
      FROM_OPTIONS: 'opt',
      FROM_MANIFEST: 'man',
    });
    const createCall = stub.calls.find(
      (c) => c.method === 'create.service.deployment',
    )!;
    const runtimeEnvironment = (
      createCall.args[0] as {
        data: { runtimeEnvironment: Record<string, string> };
      }
    ).data.runtimeEnvironment;
    expect(runtimeEnvironment.SHARED).toBe('from-manifest');
  });

  test('rejects env keys with shell metacharacters', async () => {
    const sandbox = new NorthflankSandboxClient({
      apiClient: stub.client as never,
      projectId: 'p',
      image: 'img',
      env: { 'FOO; rm -rf /': 'oops' },
      pollIntervalMs: 1,
    });
    await expect(sandbox.create(new Manifest())).rejects.toThrow(
      /Invalid environment variable/,
    );
  });

  test('resume() un-pauses a paused service then reconnects', async () => {
    const sandbox = makeSandbox(stub, { pauseOnExit: true });
    const session = await sandbox.create(new Manifest());
    stub.setServicePaused(true);
    const resumed = await sandbox.resume(session.state);
    expect(stub.client.resume.service).toHaveBeenCalled();
    expect(resumed.state.serviceId).toBe(session.state.serviceId);
  });

  test('volume persistence: create attaches a provider-owned volume mounted at workspaceRoot', async () => {
    const sandbox = makeSandbox(stub, {
      workspacePersistence: 'volume',
      volumeSpec: { storageSize: 2048, accessMode: 'ReadWriteOnce' },
    });
    const session = await sandbox.create(new Manifest({ root: '/workspace' }));
    expect(session.state.workspacePersistence).toBe('volume');
    expect(session.state.volumeId).toBeTruthy();
    expect(session.state.volumeProviderCreated).toBe(true);

    const volumeCall = stub.calls.find((c) => c.method === 'create.volume')!;
    const body = (
      volumeCall.args[0] as {
        data: {
          name: string;
          mounts: { containerMountPath: string }[];
          spec: {
            storageSize: number;
            accessMode: string;
            storageClassName?: string;
          };
          attachedObjects: { id: string; type: string }[];
        };
      }
    ).data;
    expect(body.mounts[0].containerMountPath).toBe('/workspace');
    expect(body.spec.storageSize).toBe(2048);
    expect(body.spec.accessMode).toBe('ReadWriteOnce');
    expect(body.attachedObjects[0]).toEqual({
      id: session.state.serviceId,
      type: 'service',
    });
  });

  test('volume persistence: default volume is ReadWriteMany on nf-multi-rw at the cluster minimum size', async () => {
    const sandbox = makeSandbox(stub, { workspacePersistence: 'volume' });
    await sandbox.create(new Manifest({ root: '/workspace' }));
    const volumeCall = stub.calls.find((c) => c.method === 'create.volume')!;
    const spec = (
      volumeCall.args[0] as {
        data: {
          spec: {
            storageSize: number;
            accessMode: string;
            storageClassName?: string;
          };
        };
      }
    ).data.spec;
    expect(spec.accessMode).toBe('ReadWriteMany');
    expect(spec.storageClassName).toBe('nf-multi-rw');
    expect(spec.storageSize).toBe(5120);
  });

  test('volume persistence: existing volumeId is attached to the service and not deleted on teardown', async () => {
    const sandbox = makeSandbox(stub, {
      workspacePersistence: 'volume',
      volumeId: 'caller-owned-volume',
    });
    const session = await sandbox.create(new Manifest());
    expect(stub.client.create.volume).not.toHaveBeenCalled();
    expect(session.state.volumeId).toBe('caller-owned-volume');
    expect(session.state.volumeProviderCreated).toBe(false);

    // Caller-owned volumes must be attached to the freshly-created service
    // — otherwise the service runs on ephemeral storage despite state
    // claiming a volume is in play.
    expect(stub.client.attach.volume).toHaveBeenCalledTimes(1);
    const attachCall = stub.calls.find((c) => c.method === 'attach.volume')!;
    const attachArgs = attachCall.args[0] as {
      parameters: { projectId: string; volumeId: string };
      data: { nfObject: { id: string; type: 'service' | 'job' } };
    };
    expect(attachArgs.parameters.volumeId).toBe('caller-owned-volume');
    expect(attachArgs.data.nfObject).toEqual({
      id: session.state.serviceId,
      type: 'service',
    });

    await session.delete();
    expect(stub.client.delete.volume).not.toHaveBeenCalled();
  });

  test('volume persistence: delete() detaches then removes the provider-created volume', async () => {
    const sandbox = makeSandbox(stub, { workspacePersistence: 'volume' });
    const session = await sandbox.create(new Manifest());
    const volumeId = session.state.volumeId!;
    await session.delete();
    expect(stub.client.delete.volume).toHaveBeenCalledTimes(1);
    expect(stub.client.detach.volume).toHaveBeenCalledTimes(1);
    // detach.volume must run before delete.volume — Northflank rejects
    // delete.volume while the volume is still attached.
    const indexes = stub.calls.map((c) => c.method);
    expect(indexes.indexOf('detach.volume')).toBeLessThan(
      indexes.indexOf('delete.volume'),
    );
    const deleteCall = stub.calls.find((c) => c.method === 'delete.volume')!;
    const params = (
      deleteCall.args[0] as {
        parameters: { projectId: string; volumeId: string };
      }
    ).parameters;
    expect(params.volumeId).toBe(volumeId);
    expect(session.state.volumeId).toBeUndefined();
  });

  test('tar persistence: stop() captures workspace; serialize round-trip restores it on resume()', async () => {
    const sandbox = makeSandbox(stub, {
      workspacePersistence: 'tar',
      pauseOnExit: true,
    });
    const session = await sandbox.create(
      new Manifest({
        root: '/workspace',
        entries: { 'snap.txt': { type: 'file', content: 'before' } },
      }),
    );

    // Write a fresh file inside the live session so the captured tar must
    // pick up state beyond the initial manifest.
    await (
      session as unknown as {
        writeRemoteFile: (path: string, content: string) => Promise<void>;
      }
    ).writeRemoteFile('/workspace/fresh.txt', 'after');

    await session.stop();
    expect(session.state.workspaceTar).toBeTruthy();
    expect(stub.client.pause.service).toHaveBeenCalled();

    const serialized = await sandbox.serializeSessionState(session.state);
    expect(typeof (serialized as { workspaceTar?: unknown }).workspaceTar).toBe(
      'string',
    );

    // Simulate the workspace being wiped between pause and resume.
    stub.files.delete('/workspace/snap.txt');
    stub.files.delete('/workspace/fresh.txt');

    stub.setServicePaused(true);
    const restoredState = await sandbox.deserializeSessionState(
      JSON.parse(JSON.stringify(serialized)),
    );
    const resumed = await sandbox.resume(restoredState);
    expect(resumed.state.workspacePersistence).toBe('tar');
    expect(stub.files.get('/workspace/snap.txt')?.toString('utf8')).toBe(
      'before',
    );
    expect(stub.files.get('/workspace/fresh.txt')?.toString('utf8')).toBe(
      'after',
    );
    // Snapshot consumed — subsequent serialize emits no workspaceTar.
    expect(resumed.state.workspaceTar).toBeUndefined();
  });

  test('tar persistence: canPersistOwnedSessionState is true even without pauseOnExit', async () => {
    const sandbox = makeSandbox(stub, { workspacePersistence: 'tar' });
    const session = await sandbox.create(new Manifest());
    expect(sandbox.canPersistOwnedSessionState(session.state)).toBe(true);
  });

  test('tar persistence: rejects archives containing absolute paths', async () => {
    const sandbox = makeSandbox(stub, { workspacePersistence: 'tar' });
    const session = await sandbox.create(new Manifest({ root: '/workspace' }));
    stub.setTarListing('/etc/passwd\n');
    stub.setTarVerbose('-rw-r--r-- 0/0 0 2025-01-01 00:00 /etc/passwd\n');
    const restore = (
      session as unknown as {
        restoreWorkspaceFromTar: (b: string) => Promise<void>;
      }
    ).restoreWorkspaceFromTar(Buffer.from('any', 'utf8').toString('base64'));
    await expect(restore).rejects.toMatchObject({
      code: 'provider_error',
      details: expect.objectContaining({
        operation: 'validate workspace tar',
      }),
    });
    await expect(restore).rejects.toThrow(/absolute path/);
  });

  test('tar persistence: rejects archives containing parent-traversal entries', async () => {
    const sandbox = makeSandbox(stub, { workspacePersistence: 'tar' });
    const session = await sandbox.create(new Manifest({ root: '/workspace' }));
    stub.setTarListing('safe.txt\n../outside.txt\n');
    stub.setTarVerbose(
      '-rw-r--r-- 0/0 0 2025-01-01 00:00 safe.txt\n-rw-r--r-- 0/0 0 2025-01-01 00:00 ../outside.txt\n',
    );
    const restore = (
      session as unknown as {
        restoreWorkspaceFromTar: (b: string) => Promise<void>;
      }
    ).restoreWorkspaceFromTar(Buffer.from('any', 'utf8').toString('base64'));
    await expect(restore).rejects.toThrow(/parent-traversal/);
  });

  test('tar persistence: rejects archives containing symlinks', async () => {
    const sandbox = makeSandbox(stub, { workspacePersistence: 'tar' });
    const session = await sandbox.create(new Manifest({ root: '/workspace' }));
    stub.setTarListing('link\n');
    stub.setTarVerbose(
      'lrwxrwxrwx 0/0 0 2025-01-01 00:00 link -> /etc/passwd\n',
    );
    const restore = (
      session as unknown as {
        restoreWorkspaceFromTar: (b: string) => Promise<void>;
      }
    ).restoreWorkspaceFromTar(Buffer.from('any', 'utf8').toString('base64'));
    await expect(restore).rejects.toThrow(/unsupported link entry/);
  });
});
