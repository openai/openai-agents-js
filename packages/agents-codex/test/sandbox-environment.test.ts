import { describe, expect, it, vi } from 'vitest';
import {
  Manifest,
  s3Mount,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxSessionLike,
} from '@openai/agents-core/sandbox';
import { Environment } from '../src/runtime/environment';
import { acquireEnvironment } from '../src/runtime/environment-source';
import {
  renderStorageLayout,
  sandboxEnvironment,
} from '../src/runtime/sandbox-environment';

const mountManifest = () =>
  new Manifest({
    entries: {
      data: s3Mount({
        bucket: 'synthetic-bucket',
        secretAccessKey: 'synthetic-secret',
        accessKeyId: 'synthetic-id',
        mountStrategy: {
          type: 'modal_cloud_bucket',
        },
      }),
    },
  });
function fixture() {
  const events: string[] = [];
  const resource: SandboxSessionLike = {
    state: { manifest: new Manifest() },
    close: vi.fn(async () => {
      events.push('close');
    }),
  };
  const client: SandboxClient = {
    backendId: 'fixture',
    async create(args?: SandboxClientCreateArgs | Manifest) {
      events.push('create');
      resource.state.manifest = normalizeSandboxClientCreateArgs(args).manifest;
      return resource;
    },
    delete: vi.fn(async () => {
      events.push('delete');
    }),
  };
  const connect = vi.fn(
    async (_sandbox: SandboxSessionLike, _options: { signal: AbortSignal }) => {
      events.push('connect');
      return Environment.lease(
        new Environment({ url: 'wss://fixture.invalid', cwd: '/workspace' }),
        async () => {
          events.push('gateway');
        },
      );
    },
  );
  return { events, resource, client, connect };
}

describe('native sandbox environment', () => {
  it('captures trusted manifest/options and preserves provider mount declarations and readonly default', async () => {
    const f = fixture();
    const manifest = mountManifest();
    const options = { nested: { region: 'initial' } };
    const create = f.client.create!;
    const observed: SandboxClientCreateArgs[] = [];
    f.client.create = async (args?: SandboxClientCreateArgs | Manifest) => {
      observed.push(args as SandboxClientCreateArgs);
      return create(args as SandboxClientCreateArgs);
    };
    const source = sandboxEnvironment({ ...f, manifest, options });
    (manifest.entries.data as { bucket: string }).bucket = 'changed';
    options.nested.region = 'changed';
    const owner = await acquireEnvironment(source);
    expect(observed[0].options).toEqual({ nested: { region: 'initial' } });
    expect(f.resource.state.manifest.entries.data).toMatchObject({
      bucket: 'synthetic-bucket',
      readOnly: true,
      mountStrategy: { type: 'modal_cloud_bucket' },
    });
    expect(f.connect.mock.calls[0][0]).toBe(f.resource);
    await owner.dispose();
    await owner.dispose();
    expect(f.events).toEqual([
      'create',
      'connect',
      'gateway',
      'close',
      'delete',
    ]);
  });
  it('preserves trusted opaque handles and functions while capturing plain provider options', async () => {
    const f = fixture();
    class Handle {
      command() {
        return 'provider-owned';
      }
    }
    const handle = new Handle();
    const callback = () => handle.command();
    const options = { image: handle, resolve: callback, nested: { cpu: 1 } };
    const create = f.client.create!;
    let captured: Record<string, unknown> | undefined;
    f.client.create = async (args?: SandboxClientCreateArgs | Manifest) => {
      captured = (args as SandboxClientCreateArgs).options;
      return create(args as SandboxClientCreateArgs);
    };
    const source = sandboxEnvironment({
      ...f,
      manifest: new Manifest(),
      options,
    });
    options.nested.cpu = 9;
    const owner = await acquireEnvironment(source);
    expect(captured?.image).toBe(handle);
    expect(captured?.resolve).toBe(callback);
    expect(captured?.nested).toEqual({ cpu: 1 });
    expect((captured?.image as Handle).command()).toBe('provider-owned');
    await owner.dispose();
  });
  it('starts a newly created inactive session before connecting', async () => {
    const f = fixture();
    f.resource.start = async () => {
      f.events.push('start');
    };
    f.resource.running = async () => false;
    const owner = await acquireEnvironment(
      sandboxEnvironment({ ...f, manifest: new Manifest() }),
    );
    expect(f.events).toEqual(['create', 'start', 'connect']);
    await owner.dispose();
  });
  it('rejects pre-abort and implicit strategies before creation', async () => {
    const f = fixture();
    const source = sandboxEnvironment({ ...f, manifest: mountManifest() });
    await expect(
      acquireEnvironment(source, AbortSignal.abort('cancel')),
    ).rejects.toBe('cancel');
    expect(() =>
      sandboxEnvironment({
        ...f,
        manifest: { entries: { data: s3Mount({ bucket: 'x' }) } },
      }),
    ).toThrow('explicit mountStrategy');
    expect(f.events).toEqual([]);
  });
  it('joins late creation and cleanup after cancellation without connecting', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.client.create = async () => {
      entered.resolve();
      await finish.promise;
      return f.resource;
    };
    const controller = new AbortController();
    const opening = acquireEnvironment(
      sandboxEnvironment({ ...f, manifest: new Manifest() }),
      controller.signal,
    ).catch((error) => error);
    await entered.promise;
    controller.abort('cancelled');
    finish.resolve();
    expect(await opening).toBe('cancelled');
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.events).toEqual(['close', 'delete']);
  });
  it('joins a late connector lease and cleanup after opening cancellation', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const controller = new AbortController();
    const source = sandboxEnvironment({
      ...f,
      manifest: new Manifest(),
      connect: async () => {
        entered.resolve();
        await finish.promise;
        return Environment.lease(
          new Environment({ url: 'wss://fixture.invalid', cwd: '/workspace' }),
          () => {
            f.events.push('gateway');
          },
        );
      },
    });
    const opening = acquireEnvironment(source, controller.signal).catch(
      (error) => error,
    );
    await entered.promise;
    controller.abort('cancelled');
    finish.resolve();
    expect(await opening).toBe('cancelled');
    expect(f.events).toEqual(['create', 'gateway', 'close', 'delete']);
  });
  it('cleans up a start failure without connecting', async () => {
    const f = fixture();
    f.resource.start = async () => {
      throw Error('start failed');
    };
    await expect(
      acquireEnvironment(
        sandboxEnvironment({ ...f, manifest: new Manifest() }),
      ),
    ).rejects.toThrow('start failed');
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.events).toEqual(['create', 'close', 'delete']);
  });
  it('preserves connector signal authority after composition', async () => {
    const f = fixture();
    const controller = new AbortController();
    const owner = await acquireEnvironment(
      sandboxEnvironment({
        ...f,
        manifest: new Manifest(),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: 'wss://fixture.invalid',
              cwd: '/workspace',
            }),
            async () => {
              f.events.push('gateway');
            },
            controller.signal,
          ),
      }),
    );
    controller.abort('source cancelled');
    expect(owner.signal.aborted).toBe(true);
    await owner.dispose();
    expect(f.events).toEqual(['create', 'gateway', 'close', 'delete']);
  });
  it('attempts all cleanup owners and reports every failure', async () => {
    const f = fixture();
    f.resource.close = async () => {
      f.events.push('close');
      throw Error('close failed');
    };
    f.client.delete = async () => {
      f.events.push('delete');
      throw Error('delete failed');
    };
    const owner = await acquireEnvironment(
      sandboxEnvironment({
        ...f,
        manifest: new Manifest(),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: 'wss://fixture.invalid',
              cwd: '/workspace',
            }),
            () => {
              f.events.push('gateway');
              throw Error('gateway failed');
            },
          ),
      }),
    );
    const failure = await owner.dispose().catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((e: Error) => e.message)).toEqual([
      'gateway failed',
      'close failed',
      'delete failed',
    ]);
    expect(f.events).toEqual(['create', 'gateway', 'close', 'delete']);
  });
  it('rolls back connector failure and supports providers whose close performs deletion', async () => {
    const f = fixture();
    delete f.client.delete;
    await expect(
      acquireEnvironment(
        sandboxEnvironment({
          ...f,
          manifest: new Manifest(),
          connect: async () => {
            throw Error('gateway opening failed');
          },
        }),
      ),
    ).rejects.toThrow('gateway opening failed');
    expect(f.events).toEqual(['create', 'close']);
  });
  it('delegates ownership to providers and rejects absent cleanup', async () => {
    const f = fixture();
    f.resource.state.ownsSandbox = false;
    const owner = await acquireEnvironment(
      sandboxEnvironment({ ...f, manifest: new Manifest() }),
    );
    await owner.dispose();
    expect(f.events).toEqual([
      'create',
      'connect',
      'gateway',
      'close',
      'delete',
    ]);
    delete f.resource.close;
    delete f.client.delete;
    await expect(
      acquireEnvironment(
        sandboxEnvironment({ ...f, manifest: new Manifest() }),
      ),
    ).rejects.toThrow('cleanup route');
  });
  it('does not resolve environment credentials when rendering storage layout', () => {
    const resolve = vi.fn(async () => 'synthetic-environment-secret');
    const manifest = new Manifest({
      entries: mountManifest().entries,
      environment: { PRIVATE: resolve },
    });
    const output = renderStorageLayout(manifest);
    expect(resolve).not.toHaveBeenCalled();
    expect(output).not.toContain('PRIVATE');
    expect(output).not.toContain('synthetic-environment-secret');
  });
  it.each([
    [false, undefined, 'read_write'],
    [true, false, 'read_only'],
    [undefined, false, 'read_write'],
    [undefined, undefined, 'read_only'],
  ] as const)(
    'renders Blaxel drive access using its provider override (%s, %s)',
    (driveReadOnly, readOnly, access) => {
      const output = renderStorageLayout({
        entries: {
          drive: {
            type: 'mount',
            driveName: 'synthetic',
            driveReadOnly,
            readOnly,
            mountStrategy: { type: 'blaxel_drive' },
          },
        },
      });
      expect(JSON.parse(output).storage).toEqual([
        { path: '/workspace/drive', access },
      ]);
    },
  );
  it('renders only safe paths, access and intentional descriptions', () => {
    const manifest = mountManifest();
    manifest.entries.data.description = 'Read customer reference data';
    const output = renderStorageLayout(manifest);
    expect(JSON.parse(output)).toEqual({
      workspace: '/workspace',
      storage: [
        {
          path: '/workspace/data',
          access: 'read_only',
          description: 'Read customer reference data',
        },
      ],
    });
    for (const secret of [
      'synthetic-secret',
      'synthetic-id',
      'synthetic-bucket',
      'mountpoint',
      'secretAccessKey',
    ])
      expect(output).not.toContain(secret);
  });
});
