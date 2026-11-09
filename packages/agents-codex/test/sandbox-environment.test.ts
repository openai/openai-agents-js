import { setImmediate } from 'node:timers/promises';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { describe, expect, it, vi } from 'vitest';
import {
  Manifest,
  inContainerMountStrategy,
  s3Mount,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxSessionLike,
} from '@openai/agents-core/sandbox';
import {
  markSandboxSessionStateUnsafe,
  recordLiveMountCredentialAuthority,
  captureLiveMountCredentialAuthorityIfAbsent,
} from '@openai/agents-core/sandbox/internal';
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
  it('borrows a live session without starting, closing or deleting it', async () => {
    const f = fixture();
    f.resource.start = vi.fn();
    const owner = await acquireEnvironment(
      sandboxEnvironment({
        ...f,
        manifest: new Manifest(),
        session: f.resource,
      }),
    );
    await owner.dispose();
    expect(f.events).toEqual(['connect', 'gateway']);
    expect(f.resource.start).not.toHaveBeenCalled();
    expect(f.resource.close).not.toHaveBeenCalled();
    expect(f.client.delete).not.toHaveBeenCalled();
  });
  it('resumes explicitly authorized state with current authority and owns cleanup', async () => {
    const f = fixture();
    const saved = {
      manifest: new Manifest({ root: '/current' }),
      providerId: 'synthetic-id',
    };
    f.client.resume = vi.fn(async (state, options) => {
      f.events.push('resume');
      expect(state.manifest.root).toBe('/current');
      expect(options?.trustedManifest?.root).toBe('/current');
      expect(state.providerId).toBe('synthetic-id');
      return f.resource;
    });
    const owner = await acquireEnvironment(
      sandboxEnvironment({
        ...f,
        manifest: new Manifest({ root: '/current' }),
        authorizedResumeState: { backendId: 'fixture', state: saved },
      }),
    );
    await owner.dispose();
    expect(saved.manifest.root).toBe('/current');
    expect(f.events).toEqual([
      'resume',
      'connect',
      'gateway',
      'close',
      'delete',
    ]);
  });
  it('acquires an authorized resume resource only once, including overlapping openings', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.client.resume = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
      return f.resource;
    });
    const source = sandboxEnvironment({
      ...f,
      manifest: new Manifest(),
      authorizedResumeState: { backendId: 'fixture', state: f.resource.state },
    });
    const first = acquireEnvironment(source);
    await entered.promise;
    await expect(acquireEnvironment(source)).rejects.toThrow(
      'already been acquired',
    );
    expect(f.client.resume).toHaveBeenCalledTimes(1);
    expect(f.client.delete).not.toHaveBeenCalled();
    finish.resolve();
    const owner = await first;
    await owner.dispose();
    await expect(acquireEnvironment(source)).rejects.toThrow(
      'already been acquired',
    );
    expect(f.client.resume).toHaveBeenCalledTimes(1);
    expect(f.client.delete).toHaveBeenCalledTimes(1);
  });
  it('checks recorded live mount authority before rebinding or provider effects', () => {
    const f = fixture();
    const original = mountManifest();
    const persisted = mountManifest();
    recordLiveMountCredentialAuthority(persisted, original);
    // Live processes still own the old principal even if persisted fields are edited.
    (persisted.entries.data as { accessKeyId: string }).accessKeyId =
      'rotated-id';
    const current = mountManifest();
    (current.entries.data as { accessKeyId: string }).accessKeyId =
      'rotated-id';
    f.client.resume = vi.fn();
    f.client.validateSessionStateForResume = vi.fn();
    expect(() =>
      sandboxEnvironment({
        ...f,
        manifest: current,
        authorizedResumeState: {
          backendId: 'fixture',
          state: { manifest: persisted },
        },
      }),
    ).toThrow('mount authority');
    expect(f.client.resume).not.toHaveBeenCalled();
    expect(f.client.validateSessionStateForResume).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it('rejects backend mismatch and conflicting ownership before effects', () => {
    const f = fixture();
    expect(() =>
      sandboxEnvironment({
        ...f,
        manifest: new Manifest(),
        authorizedResumeState: {
          backendId: 'different',
          state: f.resource.state,
        },
      }),
    ).toThrow('matching backend');
    expect(() =>
      sandboxEnvironment({
        ...f,
        manifest: new Manifest(),
        session: f.resource,
        authorizedResumeState: {
          backendId: 'fixture',
          state: f.resource.state,
        },
      }),
    ).toThrow('mutually exclusive');
    expect(f.events).toEqual([]);
  });
  it('forwards resource snapshots and materialization budgets on creation', async () => {
    const f = fixture();
    const capture = vi.spyOn(f.client, 'create');
    const owner = await acquireEnvironment(
      sandboxEnvironment({
        ...f,
        manifest: new Manifest(),
        concurrencyLimits: { manifestEntries: 3 },
        archiveLimits: { maxMembers: 8 },
      }),
    );
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      concurrencyLimits: { manifestEntries: 3 },
      archiveLimits: { maxMembers: 8 },
    });
    await owner.dispose();
  });

  it('rejects serialized provider secret selectors before provider effects', () => {
    const f = fixture();
    const manifest = {
      entries: {
        data: s3Mount({
          bucket: 'synthetic-bucket',
          mountStrategy: {
            type: 'modal_cloud_bucket',
            secretName: 'synthetic-application-secret',
            secretEnvironmentName: 'synthetic-environment',
          },
        }),
      },
    } as unknown as Manifest;
    expect(() => sandboxEnvironment({ ...f, manifest })).toThrow(
      'trusted Manifest',
    );
    expect(() => renderStorageLayout(manifest)).toThrow('trusted Manifest');
    expect(f.events).toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('preserves application-authorized provider secret selection', async () => {
    const f = fixture();
    const manifest = new Manifest({
      entries: {
        data: s3Mount({
          bucket: 'synthetic-bucket',
          mountStrategy: {
            type: 'modal_cloud_bucket',
            secretName: 'synthetic-application-secret',
            secretEnvironmentName: 'synthetic-environment',
          },
        }),
      },
    });
    const owner = await acquireEnvironment(
      sandboxEnvironment({ ...f, manifest }),
    );
    expect(f.resource.state.manifest).not.toBe(manifest);
    expect(f.resource.state.manifest.entries.data).toEqual(
      manifest.entries.data,
    );
    expect(renderStorageLayout(f.resource.state.manifest)).not.toContain(
      'synthetic-application-secret',
    );
    await owner.dispose();
  });
  it('rejects even empty manifest init objects', () => {
    const f = fixture();
    const manifest = {} as Manifest;
    expect(() => sandboxEnvironment({ ...f, manifest })).toThrow(
      'trusted Manifest',
    );
    expect(() => renderStorageLayout(manifest)).toThrow('trusted Manifest');
    expect(f.events).toEqual([]);
  });
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
        manifest: new Manifest({ entries: { data: s3Mount({ bucket: 'x' }) } }),
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
      const output = renderStorageLayout(
        new Manifest({
          entries: {
            drive: {
              type: 'mount',
              driveName: 'synthetic',
              driveReadOnly,
              readOnly,
              mountStrategy: { type: 'blaxel_drive' },
            },
          },
        }),
      );
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

it.each(['root', 'topology', 'credential'])(
  'rejects borrowed %s authority mismatch before the gateway without taking resource ownership',
  async (mismatch) => {
    const f = fixture();
    f.resource.state.manifest = mountManifest();
    let current: Manifest = mountManifest();
    if (mismatch === 'root')
      current = new Manifest({ root: '/other', entries: current.entries });
    else if (mismatch === 'topology') delete current.entries.data;
    else
      (current.entries.data as { accessKeyId: string }).accessKeyId =
        'rotated-principal';
    await expect(
      acquireEnvironment(
        sandboxEnvironment({ ...f, manifest: current, session: f.resource }),
      ),
    ).rejects.toThrow('mount authority');
    expect(f.events).toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.resource.close).not.toHaveBeenCalled();
    expect(f.client.delete).not.toHaveBeenCalled();
  },
);

function environmentMountManifest(
  access = 'synthetic-access',
  safe = 'current',
) {
  return new Manifest({
    entries: {
      remote: s3Mount({
        bucket: 'synthetic',
        mountStrategy: inContainerMountStrategy(),
      }),
    },
    environment: {
      AWS_ACCESS_KEY_ID: access,
      AWS_SECRET_ACCESS_KEY: 'synthetic-secret',
      SAFE: safe,
    },
  }).withInContainerMountBroadCredentialExposureAcknowledged('remote');
}

it('rejects rotated borrowed environment authority before connecting or taking ownership', async () => {
  const f = fixture();
  f.resource.state.manifest = environmentMountManifest();
  f.resource.state.environment =
    await f.resource.state.manifest.resolveEnvironment();
  captureLiveMountCredentialAuthorityIfAbsent(
    f.resource.state.manifest,
    f.resource.state.environment,
  );
  await expect(
    acquireEnvironment(
      sandboxEnvironment({
        ...f,
        manifest: environmentMountManifest('rotated-access'),
        session: f.resource,
      }),
    ),
  ).rejects.toThrow('mount environment authority');
  expect(f.events).toEqual([]);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.resource.close).not.toHaveBeenCalled();
  expect(f.client.delete).not.toHaveBeenCalled();
});

it.each([
  'in_container',
  'e2b_cloud_bucket',
  'daytona_cloud_bucket',
  'vercel_cloud_bucket',
] as const)(
  'rejects rotated environment-backed %s resume before any provider effects',
  (type) => {
    const f = fixture();
    const saved = environmentMountManifest();
    const current = environmentMountManifest('rotated-access');
    for (const manifest of [saved, current]) {
      (
        manifest.entries.remote as { mountStrategy: { type: string } }
      ).mountStrategy = { type };
    }
    f.client.resume = vi.fn();
    f.client.validateSessionStateForResume = vi.fn();
    expect(() =>
      sandboxEnvironment({
        ...f,
        manifest: current,
        authorizedResumeState: {
          backendId: 'fixture',
          state: { manifest: saved },
        },
      }),
    ).toThrow('cannot be resumed safely');
    expect(f.client.resume).not.toHaveBeenCalled();
    expect(f.client.validateSessionStateForResume).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  },
);

it('waits for an actual local manifest mutation before inspecting a borrowed session', async () => {
  const client = new UnixLocalSandboxClient();
  const session = await client.create(new Manifest());
  const trusted = new Manifest({ root: session.state.manifest.root });
  let mutationEntered!: () => void;
  let finishMutation!: () => void;
  const entered = new Promise<void>((resolve) => {
    mutationEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishMutation = resolve;
  });
  const f = fixture();
  const mutation = session.applyManifest(
    new Manifest({
      root: session.state.manifest.root,
      environment: {
        FLAG: async () => {
          mutationEntered();
          await gate;
          return 'changed';
        },
      },
    }),
  );
  try {
    await entered;
    const opening = acquireEnvironment(
      sandboxEnvironment({
        client,
        manifest: trusted,
        session,
        connect: f.connect,
      }),
    );
    await setImmediate();
    expect(f.connect).not.toHaveBeenCalled();
    finishMutation();
    await mutation;
    const owner = await opening;
    expect(session.state.environment.FLAG).toBe('changed');
    expect(f.connect).toHaveBeenCalledOnce();
    await owner.dispose();
  } finally {
    finishMutation();
    await mutation;
    await session.close();
    await session.delete();
  }
});

it('holds borrowed inspection through gateway acquisition against actual local mutation', async () => {
  const client = new UnixLocalSandboxClient();
  const session = await client.create(new Manifest());
  let connected!: () => void;
  let finishConnect!: () => void;
  const entered = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishConnect = resolve;
  });
  let mutated = false;
  const f = fixture();
  const opening = acquireEnvironment(
    sandboxEnvironment({
      client,
      manifest: new Manifest({ root: session.state.manifest.root }),
      session,
      connect: async (...args) => {
        connected();
        await gate;
        return f.connect(...args);
      },
    }),
  );
  try {
    await entered;
    const mutation = session.applyManifest(
      new Manifest({
        root: session.state.manifest.root,
        environment: {
          FLAG: () => {
            mutated = true;
            return 'changed';
          },
        },
      }),
    );
    await setImmediate();
    expect(mutated).toBe(false);
    finishConnect();
    const owner = await opening;
    await mutation;
    expect(mutated).toBe(true);
    await owner.dispose();
  } finally {
    finishConnect();
    await session.close();
    await session.delete();
  }
});

it.each([
  ['daytona', '/home/daytona/workspace'],
  ['vercel', '/vercel/sandbox'],
])(
  'normalizes borrowed %s authority using the current provider configuration',
  async (backend, root) => {
    const provider =
      backend === 'daytona'
        ? new (
            await import('../../agents-extensions/src/sandbox/daytona')
          ).DaytonaSandboxClient()
        : new (
            await import('../../agents-extensions/src/sandbox/vercel')
          ).VercelSandboxClient();
    const f = fixture();
    f.resource.state.manifest = new Manifest({ root });
    const client: SandboxClient = {
      ...f.client,
      resolveTrustedManifestForResume:
        provider.resolveTrustedManifestForResume.bind(provider),
    };
    const owner = await acquireEnvironment(
      sandboxEnvironment({
        ...f,
        client,
        session: f.resource,
        manifest: new Manifest(),
      }),
    );
    expect(f.connect).toHaveBeenCalledOnce();
    await owner.dispose();
    expect(f.resource.close).not.toHaveBeenCalled();
    f.connect.mockClear();
    await expect(async () => {
      await acquireEnvironment(
        sandboxEnvironment({
          ...f,
          client,
          session: f.resource,
          manifest: new Manifest({ root: '/different-authority' }),
        }),
      );
    }).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  },
);

it.each(['construction', 'acquisition'] as const)(
  'rejects the original unusable resume state at %s before cloning or provider work',
  async (stage) => {
    const client = new UnixLocalSandboxClient();
    const session = await client.create(new Manifest());
    const f = fixture();
    const build = () =>
      sandboxEnvironment({
        client,
        manifest: new Manifest({ root: session.state.manifest.root }),
        authorizedResumeState: {
          backendId: client.backendId,
          state: session.state,
        },
        connect: f.connect,
      });
    const source = stage === 'acquisition' ? build() : undefined;
    markSandboxSessionStateUnsafe(session.state);
    try {
      await expect(client.serializeSessionState(session.state)).rejects.toThrow(
        'privileged manifest transition',
      );
      const resume = vi.spyOn(client, 'resume');
      await expect(async () => {
        const owner = await acquireEnvironment(source ?? build());
        await owner.dispose();
      }).rejects.toThrow('privileged manifest transition');
      expect(resume).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await session.delete();
    }
  },
);

it('holds original resume inspection through asynchronous provider policy and gateway acquisition', async () => {
  const { withExclusiveSandboxManifestMutation } =
    await import('@openai/agents-core/sandbox/internal');
  const f = fixture();
  const original = { manifest: new Manifest() };
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.client.serializedSessionStateRequiresFreshCreationForOptions = async () => {
    entered();
    await gate;
    return false;
  };
  f.client.resume = vi.fn(async (state) => {
    f.resource.state = state;
    return f.resource;
  });
  const opening = acquireEnvironment(
    sandboxEnvironment({
      ...f,
      manifest: new Manifest(),
      authorizedResumeState: { backendId: 'fixture', state: original },
    }),
  );
  let mutated = false;
  try {
    await ready;
    const mutation = withExclusiveSandboxManifestMutation(
      original,
      async () => {
        mutated = true;
        markSandboxSessionStateUnsafe(original);
      },
    );
    await setImmediate();
    expect(mutated).toBe(false);
    release();
    const owner = await opening;
    await mutation;
    expect(mutated).toBe(true);
    expect(f.connect).toHaveBeenCalledOnce();
    await owner.dispose();
  } finally {
    release();
    await opening.then(
      (owner) => owner.dispose(),
      () => {},
    );
  }
});

it('does not fall back after provider environment validation fails', async () => {
  const f = fixture();
  const failure = new Error('provider environment refused');
  f.client.resolveTrustedEnvironment = async () => {
    throw failure;
  };
  await expect(
    acquireEnvironment(
      sandboxEnvironment({
        ...f,
        manifest: new Manifest(),
        session: f.resource,
      }),
    ),
  ).rejects.toBe(failure);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.resource.close).not.toHaveBeenCalled();
});

it.each(['e2b', 'daytona', 'modal', 'vercel'] as const)(
  'resolves trusted %s provider environment with creation precedence without changing the manifest',
  async (backend) => {
    const environment = { CONSTRUCTOR_ONLY: 'synthetic', VALUE: 'constructor' };
    const client =
      backend === 'e2b'
        ? new (
            await import('../../agents-extensions/src/sandbox/e2b')
          ).E2BSandboxClient({ env: environment })
        : backend === 'daytona'
          ? new (
              await import('../../agents-extensions/src/sandbox/daytona')
            ).DaytonaSandboxClient({ env: environment })
          : backend === 'modal'
            ? new (
                await import('../../agents-extensions/src/sandbox/modal')
              ).ModalSandboxClient({ env: environment })
            : new (
                await import('../../agents-extensions/src/sandbox/vercel')
              ).VercelSandboxClient({ env: environment });
    const manifest = new Manifest({ environment: { VALUE: 'manifest' } });
    await expect(client.resolveTrustedEnvironment(manifest)).resolves.toEqual({
      CONSTRUCTOR_ONLY: 'synthetic',
      VALUE: 'manifest',
    });
    await expect(
      client.resolveTrustedEnvironment(manifest, {
        appName: 'synthetic',
        env: { CALL_ONLY: 'synthetic', VALUE: 'call' },
      }),
    ).resolves.toEqual({
      ...(backend === 'modal' ? { CONSTRUCTOR_ONLY: 'synthetic' } : {}),
      CALL_ONLY: 'synthetic',
      VALUE: 'manifest',
    });
    expect(Object.keys(manifest.environment)).toEqual(['VALUE']);
  },
);
