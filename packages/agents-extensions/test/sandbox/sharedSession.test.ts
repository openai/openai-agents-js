import {
  file,
  gcsMount,
  Manifest,
  s3Mount,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  type SandboxSessionState,
} from '@openai/agents-core/sandbox';
import { withExclusiveSandboxManifestMutation } from '@openai/agents-core/sandbox/internal';
import { describe, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ONE_BY_ONE_PNG } from './imageFixture';
import {
  assertCoreConcurrencyLimitsUnsupported,
  assertCoreSnapshotUnsupported,
  assertRemoteSandboxSessionStateCanResume,
  assertResumeRecreateAllowed,
  deserializeRemoteSandboxSessionStateValues,
  isProviderSandboxNotFoundError,
  closeRemoteSessionOnManifestError,
  serializeRemoteSandboxSessionState,
  withProviderError,
  providerErrorRetryability,
  RemoteSandboxSessionBase,
  serializeManifestRecord,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../../src/sandbox/shared';
import {
  captureRcloneMountEnvironmentAuthorityForManifest,
  rcloneMountEnvironmentAuthorityMatches,
  validateRcloneMountEnvironmentCredentialExposure,
} from '../../src/sandbox/shared/inContainerMounts';
import { makeTarArchive } from './tarFixture';

type FakeRemoteSessionState = SandboxSessionState & {
  configuredExposedPorts?: number[];
  environment: Record<string, string>;
  workspacePersistence?: string;
};

class FakeRemoteSession extends RemoteSandboxSessionBase<FakeRemoteSessionState> {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly commands: Array<{
    command: string;
    options: RemoteSandboxCommandOptions;
  }> = [];

  constructor() {
    super({
      state: {
        manifest: new Manifest({ root: '/workspace' }),
        environment: {},
        configuredExposedPorts: [8080],
      },
      options: {
        providerName: 'FakeSandboxClient',
        providerId: 'fake',
      },
    });
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    this.commands.push({ command, options });
    if (command === 'true') {
      return { status: 0 };
    }
    if (command.startsWith('test -e ')) {
      const path = command.slice('test -e '.length).replace(/^'|'$/g, '');
      return {
        status: this.files.has(path) || this.dirs.has(path) ? 0 : 1,
      };
    }
    if (command.startsWith('test -d ')) {
      const path = command
        .slice('test -d '.length, command.indexOf(' && test -x '))
        .replace(/^'|'$/g, '');
      return { status: this.dirs.has(path) ? 0 : 1 };
    }
    if (command.includes('head -c ')) {
      const path = command.match(/exec 3< '([^']+)'/)?.[1] ?? '';
      const maxBytes = Number(command.match(/head -c (\d+)/)?.[1]);
      const bytes = this.files.get(path);
      return bytes
        ? {
            status: 0,
            stdout: Buffer.concat([
              Buffer.from(bytes.subarray(0, maxBytes)),
              Buffer.from('\n000\n'),
            ]).toString('base64'),
          }
        : { status: 66 };
    }
    return {
      status: 0,
      stdout: `ran ${command}`,
      stderr: 'warning',
    };
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    this.dirs.add(path);
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`missing ${path}`);
    }
    return content;
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.files.set(
      path,
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : Uint8Array.from(content),
    );
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    this.files.delete(path);
  }

  protected override async resolveRemotePath(path?: string): Promise<string> {
    return this.resolveAbsolutePath(path);
  }

  protected override assertFilesystemRunAs(_runAs?: string): void {}

  protected override exposedPortSource(): string {
    return 'fake endpoint';
  }

  protected override async resolveRemoteExposedPort(
    port: number,
  ): Promise<string> {
    return `https://sandbox.example.com:${port}`;
  }
}

// Execute the provider wire command locally to measure bytes crossing its boundary.
class LocalImageReadSession extends FakeRemoteSession {
  transferredBytes = 0;

  constructor(root: string) {
    super();
    this.state.manifest = new Manifest({ root });
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    const bytes = await readFile(path);
    this.transferredBytes += bytes.byteLength;
    return bytes;
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    this.commands.push({ command, options });
    const { stdout, stderr } = await promisify(execFile)(
      '/bin/sh',
      ['-c', command],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    this.transferredBytes += Buffer.from(stdout, 'base64').byteLength;
    return { status: 0, stdout, stderr };
  }
}

class LocalArchiveSession extends LocalImageReadSession {
  readonly writes: string[] = [];

  constructor(
    root: string,
    private readonly mountPaths: string[],
  ) {
    super(root);
  }

  protected override activeWorkspaceMountPaths(): Iterable<string> {
    return this.mountPaths;
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.writes.push(path);
    await writeFile(path, content);
  }
}

class FailedPathProbeSession extends FakeRemoteSession {
  constructor(private readonly result: RemoteSandboxCommandResult) {
    super();
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    if (command.startsWith('test -e ')) {
      return this.result;
    }
    return await super.runRemoteCommand(command, options);
  }
}

class CredentialMountFakeSession extends FakeRemoteSession {
  beforeApplyCalls = 0;
  deleteCalls = 0;
  failMount = false;
  beforeApplyGate?: Promise<void>;
  materializeGate?: Promise<void>;
  observedAccessKeys: Array<string | undefined> = [];
  observedAmbientCredentialPolicy: boolean[] = [];

  protected override manifestMetadataSupport() {
    return { mounts: true };
  }

  protected override manifestMaterializationOptions() {
    return {
      validateManifest: validateRcloneMountEnvironmentCredentialExposure,
      materializeMount: async (
        _path: string,
        _entry: unknown,
        context: {
          environment?: Readonly<Record<string, string>>;
          allowAmbientCredentials?: boolean;
        },
      ) => {
        this.observedAccessKeys.push(context.environment?.AWS_ACCESS_KEY_ID);
        this.observedAmbientCredentialPolicy.push(
          context.allowAmbientCredentials === true,
        );
        await this.materializeGate;
        if (this.failMount) {
          throw new Error('mount failed');
        }
      },
    };
  }

  protected override async beforeApplyManifest(): Promise<void> {
    this.beforeApplyCalls += 1;
    await this.beforeApplyGate;
  }

  protected override afterManifestMutationCommitted(
    materializedManifest: Manifest,
  ): void {
    captureRcloneMountEnvironmentAuthorityForManifest(
      this.state,
      materializedManifest,
    );
  }

  async delete(): Promise<void> {
    this.deleteCalls += 1;
  }
}

class RedirectedCredentialMountFakeSession extends CredentialMountFakeSession {
  protected override async resolveRemotePath(path?: string): Promise<string> {
    if (path === 'remote' || path === '/workspace/remote') {
      return '/workspace/redirected';
    }
    return await super.resolveRemotePath(path);
  }
}

describe('shared sandbox session helpers', () => {
  test
    .skipIf(process.platform === 'win32')
    .each(['empty', 'populated', 'alias'])(
    'round-trips a workspace with a %s non-ephemeral mount',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'agents-mounted-roundtrip-'));
      try {
        const physical = join(root, 'physical');
        const attached = join(physical, 'mounted[1]*?');
        await mkdir(attached, { recursive: true });
        const usesAlias = kind.includes('alias');
        if (usesAlias) {
          await symlink(physical, join(root, 'alias'));
        }
        const mountedFile = join(attached, 'remote.txt');
        if (kind !== 'empty') {
          await writeFile(mountedFile, 'remote object');
        }
        const session = new LocalArchiveSession(root, [attached]);
        session.state.manifest = new Manifest({
          root,
          entries: {
            data: s3Mount({
              bucket: 'synthetic-bucket',
              mountPath: `${usesAlias ? 'alias' : 'physical'}/mounted[1]*?`,
              ephemeral: false,
              readOnly: false,
            }),
          },
        });
        await writeFile(join(root, 'ordinary.txt'), 'saved workspace');
        const archive = await session.persistWorkspace();
        expect(
          Buffer.from(archive!).includes(Buffer.from('remote object')),
        ).toBe(false);
        await writeFile(join(root, 'ordinary.txt'), 'changed workspace');
        await writeFile(join(root, 'stale.txt'), 'remove during restore');

        await session.hydrateWorkspace(archive!);

        expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe(
          'saved workspace',
        );
        await expect(stat(join(root, 'stale.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect((await stat(attached)).isDirectory()).toBe(true);
        if (kind !== 'empty') {
          expect(await readFile(mountedFile, 'utf8')).toBe('remote object');
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32').each(['mount', 'workspace'])(
    'rejects archive operations after a configured %s alias changes',
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'agents-mount-binding-'));
      try {
        const physicalRoot = join(directory, 'workspace');
        const root =
          kind === 'workspace' ? join(directory, 'root') : physicalRoot;
        const attached = join(physicalRoot, 'physical', 'mounted');
        const other =
          kind === 'workspace' ? join(directory, 'other') : join(root, 'other');
        const ordinaryTarget = join(
          other,
          ...(kind === 'workspace' ? ['physical', 'mounted'] : ['mounted']),
        );
        await mkdir(attached, { recursive: true });
        await mkdir(ordinaryTarget, { recursive: true });
        if (kind === 'workspace') {
          await symlink(physicalRoot, root);
        } else {
          await symlink(join(physicalRoot, 'physical'), join(root, 'alias'));
        }
        const session = new LocalArchiveSession(root, [attached]);
        session.state.manifest = new Manifest({
          root,
          entries: {
            data: s3Mount({
              bucket: 'synthetic-bucket',
              mountPath: `${kind === 'workspace' ? 'physical' : 'alias'}/mounted`,
              ephemeral: false,
              readOnly: false,
            }),
          },
        });
        await writeFile(join(attached, 'remote.txt'), 'remote object');
        await writeFile(join(root, 'ordinary.txt'), 'saved workspace');
        const archive = await session.persistWorkspace();
        const stale = join(ordinaryTarget, 'stale.txt');
        await writeFile(stale, 'ordinary workspace data');
        const alias = kind === 'workspace' ? root : join(root, 'alias');
        await rm(alias);
        await symlink(other, alias);
        session.writes.length = 0;
        session.commands.length = 0;

        await expect(session.hydrateWorkspace(archive!)).rejects.toThrow(
          kind === 'workspace'
            ? 'Workspace tar hydration requires a physical workspace root'
            : 'Workspace mount no longer matches an active attachment',
        );
        await expect(session.persistWorkspace()).rejects.toThrow(
          'Workspace mount no longer matches an active attachment',
        );

        expect(await readFile(stale, 'utf8')).toBe('ordinary workspace data');
        expect(await readFile(join(attached, 'remote.txt'), 'utf8')).toBe(
          'remote object',
        );
        expect(session.writes).toHaveLength(0);
        expect(
          session.commands.some(
            ({ command }) =>
              command.includes('tar ') || command.includes('find '),
          ),
        ).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects hydration through a stable workspace root alias before archive upload',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agents-root-binding-'));
      try {
        const physical = join(directory, 'physical');
        const root = join(directory, 'root');
        const attached = join(physical, 'mounted');
        await mkdir(attached, { recursive: true });
        await symlink(physical, root);
        await writeFile(join(attached, 'remote.txt'), 'remote object');
        await writeFile(join(root, 'ordinary.txt'), 'saved workspace');
        const session = new LocalArchiveSession(root, [attached]);
        session.state.manifest = new Manifest({
          root,
          entries: {
            data: s3Mount({
              bucket: 'synthetic-bucket',
              mountPath: 'mounted',
              ephemeral: false,
              readOnly: false,
            }),
          },
        });
        const archive = await session.persistWorkspace();
        await writeFile(join(root, 'stale.txt'), 'ordinary workspace data');
        session.writes.length = 0;
        session.commands.length = 0;

        await expect(session.hydrateWorkspace(archive!)).rejects.toThrow(
          'Workspace tar hydration requires a physical workspace root',
        );

        expect(session.writes).toHaveLength(0);
        expect(await readFile(join(root, 'stale.txt'), 'utf8')).toBe(
          'ordinary workspace data',
        );
        expect(await readFile(join(attached, 'remote.txt'), 'utf8')).toBe(
          'remote object',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'clears ordinary data behind an overridden ephemeral mount logical alias',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agents-logical-mount-alias-'));
      try {
        const attached = join(root, 'physical', 'mounted');
        const other = join(root, 'other');
        await mkdir(attached, { recursive: true });
        await mkdir(other);
        await symlink(other, join(root, 'data'));
        await writeFile(join(attached, 'remote.txt'), 'remote object');
        const session = new LocalArchiveSession(root, [attached]);
        session.state.manifest = new Manifest({
          root,
          entries: {
            data: s3Mount({
              bucket: 'synthetic-bucket',
              mountPath: 'physical/mounted',
              ephemeral: true,
              readOnly: false,
            }),
          },
        });
        await writeFile(join(root, 'ordinary.txt'), 'saved workspace');
        await writeFile(join(other, 'saved.txt'), 'saved ordinary target');
        const archive = await session.persistWorkspace();
        await writeFile(join(other, 'stale.txt'), 'ordinary workspace data');
        await writeFile(join(other, 'saved.txt'), 'changed ordinary target');
        await writeFile(join(root, 'ordinary.txt'), 'changed workspace');

        await session.hydrateWorkspace(archive!);

        await expect(stat(join(other, 'stale.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe(
          'saved workspace',
        );
        expect(await readFile(join(other, 'saved.txt'), 'utf8')).toBe(
          'saved ordinary target',
        );
        expect(await readFile(join(attached, 'remote.txt'), 'utf8')).toBe(
          'remote object',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test('restores mount credentials only from current configured environment', () => {
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: { type: 'daytona_cloud_bucket' },
        }),
      },
    });

    const restored = deserializeRemoteSandboxSessionStateValues(
      {
        manifest: serializeManifestRecord(manifest),
        environment: {
          AWS_ACCESS_KEY_ID: 'STALE_ENV_AK',
          AWS_SECRET_ACCESS_KEY: 'STALE_ENV_SK',
          SAFE_RUNTIME_VALUE: 'persisted-safe',
        },
      },
      {
        AWS_ACCESS_KEY_ID: 'TRUSTED_ENV_AK',
        AWS_SECRET_ACCESS_KEY: 'TRUSTED_ENV_SK',
      },
    );

    expect(restored.environment).toEqual({
      SAFE_RUNTIME_VALUE: 'persisted-safe',
      AWS_ACCESS_KEY_ID: 'TRUSTED_ENV_AK',
      AWS_SECRET_ACCESS_KEY: 'TRUSTED_ENV_SK',
    });
  });

  test('validates ambient mount credentials before provider hooks', async () => {
    const session = new CredentialMountFakeSession();

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            remote: s3Mount({
              bucket: 'private',
              mountStrategy: { type: 'e2b_cloud_bucket' },
            }),
          },
          environment: {
            AWS_ACCESS_KEY_ID: 'untrusted-key',
            AWS_SECRET_ACCESS_KEY: 'untrusted-secret',
          },
        }),
      ),
    ).rejects.toThrow(/model-controlled sandbox/u);

    expect(session.beforeApplyCalls).toBe(0);
    expect(session.deleteCalls).toBe(0);
    expect(session.observedAccessKeys).toEqual([]);
    expect(session.observedAmbientCredentialPolicy).toEqual([]);
  });

  test('materializes mounts with staged environment and commits afterward', async () => {
    const session = new CredentialMountFakeSession();
    const update = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'rotated-key',
        AWS_SECRET_ACCESS_KEY: 'rotated-secret',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

    await session.applyManifest(update);

    expect(session.observedAccessKeys).toEqual(['rotated-key']);
    expect(session.observedAmbientCredentialPolicy).toEqual([true]);
    expect(session.state.environment.AWS_ACCESS_KEY_ID).toBe('rotated-key');
  });

  test('rejects replacing active mounts before provider effects', async () => {
    const session = new CredentialMountFakeSession();
    const mounted = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'trusted-key',
        AWS_SECRET_ACCESS_KEY: 'trusted-secret',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');
    await session.applyManifest(mounted);

    await expect(
      session.materializeEntry({ path: 'remote', entry: { type: 'dir' } }),
    ).rejects.toThrow(/cannot be removed or replaced.*remote/u);
    await expect(
      session.applyManifest(
        new Manifest({ entries: { remote: { type: 'dir' } } }),
      ),
    ).rejects.toThrow(/cannot be removed or replaced.*remote/u);

    expect(session.beforeApplyCalls).toBe(1);
    expect(session.observedAccessKeys).toEqual(['trusted-key']);
    expect(session.state.manifest.entries.remote?.type).toBe('s3_mount');
  });

  test('materializes the same immutable delta that passed validation', async () => {
    const session = new CredentialMountFakeSession();
    let releaseBeforeApply!: () => void;
    session.beforeApplyGate = new Promise<void>((resolve) => {
      releaseBeforeApply = resolve;
    });
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'trusted-key',
        AWS_SECRET_ACCESS_KEY: 'trusted-secret',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

    const applying = session.applyManifest(manifest);
    await vi.waitFor(() => expect(session.beforeApplyCalls).toBe(1));
    (manifest.entries as Record<string, typeof manifest.entries.remote>).other =
      s3Mount({
        bucket: 'mutated',
        mountStrategy: { type: 'e2b_cloud_bucket' },
      });
    releaseBeforeApply();
    await applying;

    expect(session.state.manifest.entries).toHaveProperty('remote');
    expect(session.state.manifest.entries).not.toHaveProperty('other');
    expect(session.observedAccessKeys).toEqual(['trusted-key']);
  });

  test('serializes overlapping manifest mutations before provider effects', async () => {
    const session = new CredentialMountFakeSession();
    let releaseMaterialization!: () => void;
    session.materializeGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const first = new Manifest({
      entries: {
        first: s3Mount({
          bucket: 'first',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'first-key',
        AWS_SECRET_ACCESS_KEY: 'first-secret',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('first');
    const second = new Manifest({
      entries: {
        second: s3Mount({
          bucket: 'second',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'second-key',
        AWS_SECRET_ACCESS_KEY: 'second-secret',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('second');

    const applyingFirst = session.applyManifest(first);
    await vi.waitFor(() =>
      expect(session.observedAccessKeys).toEqual(['first-key']),
    );
    const applyingSecond = session.applyManifest(second);
    expect(session.observedAccessKeys).toEqual(['first-key']);
    releaseMaterialization();
    await Promise.all([applyingFirst, applyingSecond]);
    expect(session.observedAccessKeys).toEqual(['first-key', 'second-key']);
    expect(session.state.manifest.entries).toHaveProperty('first');
    expect(session.state.manifest.entries).toHaveProperty('second');
  });

  test('validates credential opt-ins against resolved effective paths', async () => {
    const session = new RedirectedCredentialMountFakeSession();
    const manifest = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          accessKeyId: 'trusted-key',
          secretAccessKey: 'trusted-secret',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

    await expect(session.applyManifest(manifest)).rejects.toThrow(
      /model-controlled sandbox/u,
    );
    expect(session.observedAccessKeys).toEqual([]);
    expect(session.beforeApplyCalls).toBe(0);
    expect(session.deleteCalls).toBe(0);
    await expect(session.execCommand({ cmd: 'true' })).resolves.toContain(
      'Process exited with code 0',
    );
  });

  test('rejects direct serialization during a manifest mutation', async () => {
    const session = new CredentialMountFakeSession();
    let releaseMutation!: () => void;
    let signalMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      signalMutationStarted = resolve;
    });
    const mutation = withExclusiveSandboxManifestMutation(
      session.state,
      async () => {
        signalMutationStarted();
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
      },
    );
    await mutationStarted;

    expect(() => serializeRemoteSandboxSessionState(session.state)).toThrow(
      /cannot be inspected while a manifest mutation is in progress/u,
    );

    releaseMutation();
    await mutation;
  });

  test('holds manifest mutations until workspace hydration finishes', async () => {
    let signalCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanup = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    class BlockingHydrationSession extends FakeRemoteSession {
      protected override async runRemoteCommand(
        command: string,
        options: RemoteSandboxCommandOptions,
      ): Promise<RemoteSandboxCommandResult> {
        if (command.includes('OPENAI_AGENTS_RESOLVE_PATH')) {
          return { status: 0, stdout: '/workspace\n' };
        }
        if (command.includes('find ') && command.includes('tar -C ')) {
          signalCleanup();
          await cleanupGate;
          return { status: 0 };
        }
        return await super.runRemoteCommand(command, options);
      }
    }
    const session = new BlockingHydrationSession();
    const hydrating = session.hydrateWorkspace(makeTarArchive([]));
    await cleanupStarted;

    let mutationApplied = false;
    const mutation = withExclusiveSandboxManifestMutation(
      session.state,
      async () => {
        session.state.manifest = new Manifest({
          root: '/workspace',
          entries: { later: file({ content: 'later' }) },
        });
        mutationApplied = true;
      },
    );
    await Promise.resolve();
    expect(mutationApplied).toBe(false);
    releaseCleanup();
    await hydrating;
    await mutation;
    expect(mutationApplied).toBe(true);
    expect(session.state.manifest.entries).toHaveProperty('later');
  });

  test('retains actual mount authority for environment-only updates', async () => {
    const session = new CredentialMountFakeSession();
    const mounted = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'old-key',
        AWS_SECRET_ACCESS_KEY: 'old-secret',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');
    await session.applyManifest(mounted);

    await session.applyManifest(
      new Manifest({ environment: { AWS_ACCESS_KEY_ID: 'new-key' } }),
    );

    expect(session.observedAccessKeys).toEqual(['old-key']);
    expect(
      rcloneMountEnvironmentAuthorityMatches(
        session.state,
        session.state.manifest,
        session.state.environment,
      ),
    ).toBe(false);
  });

  test('poisons and deletes sessions after failed privileged transitions', async () => {
    const session = new CredentialMountFakeSession();
    const editor = session.createEditor();
    session.failMount = true;
    const update = new Manifest({
      entries: {
        remote: s3Mount({
          bucket: 'private',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
      environment: {
        AWS_ACCESS_KEY_ID: 'trusted-key',
        AWS_SECRET_ACCESS_KEY: 'trusted-secret',
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

    await expect(session.applyManifest(update)).rejects.toThrow('mount failed');
    expect(session.deleteCalls).toBe(1);
    await expect(session.execCommand({ cmd: 'true' })).rejects.toThrow(
      /privileged manifest transition failed/u,
    );
    expect(() => serializeRemoteSandboxSessionState(session.state)).toThrow(
      /privileged manifest transition failed/u,
    );
    await expect(
      editor.createFile({
        type: 'create_file',
        path: 'after-failure.txt',
        diff: 'blocked',
      }),
    ).rejects.toThrow(/privileged manifest transition failed/u);
  });

  test('rejects direct resume when native host paths need trusted rebinding', () => {
    const serialized = serializeRemoteSandboxSessionState({
      manifest: new Manifest({
        extraPathGrants: [
          {
            path: '/mnt/shared-data',
            hostPath: process.cwd(),
            readOnly: true,
          },
        ],
      }),
      environment: {},
    });
    const deserialized = deserializeRemoteSandboxSessionStateValues(serialized);

    expect(serialized.__openaiAgentsRedactedHostPathGrantPaths).toEqual([
      '/mnt/shared-data',
    ]);
    expect(deserialized.manifest.extraPathGrants).toEqual([
      {
        path: '/mnt/shared-data',
        readOnly: true,
      },
    ]);
    expect(() =>
      assertRemoteSandboxSessionStateCanResume(deserialized),
    ).toThrow(
      'Sandbox session state requires trusted hostPath values for these path grants: /mnt/shared-data.',
    );
  });

  test('rejects resolved credential files before remote state persistence', () => {
    const manifest = new Manifest({
      environment: {
        GOOGLE_APPLICATION_CREDENTIALS: async () => '/workspace/gcp.json',
      },
      entries: {
        'gcp.json': file({ content: 'GCP_FILE_SECRET_SENTINEL' }),
        remote: gcsMount({
          bucket: 'private',
          mountStrategy: { type: 'e2b_cloud_bucket' },
        }),
      },
    }).withInContainerMountBroadCredentialExposureAcknowledged('remote');

    expect(() =>
      serializeRemoteSandboxSessionState({
        manifest,
        environment: {
          GOOGLE_APPLICATION_CREDENTIALS: '/workspace/gcp.json',
        },
      }),
    ).toThrow(/serialized manifest entry/u);
  });

  test('rejects unsupported core create options for provider clients', () => {
    expect(() =>
      assertCoreSnapshotUnsupported('ProviderSandboxClient', { type: 'noop' }),
    ).not.toThrow();
    expect(() =>
      assertCoreConcurrencyLimitsUnsupported('ProviderSandboxClient', {}),
    ).not.toThrow();

    expect(() =>
      assertCoreSnapshotUnsupported('ProviderSandboxClient', {
        type: 'remote',
      }),
    ).toThrow(SandboxUnsupportedFeatureError);
    expect(() =>
      assertCoreConcurrencyLimitsUnsupported('ProviderSandboxClient', {
        manifestEntries: 2,
      }),
    ).toThrow(SandboxUnsupportedFeatureError);
  });

  test('detects not-found provider errors from status fields and responses', () => {
    expect(isProviderSandboxNotFoundError({ status: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError({ statusCode: '404' })).toBe(true);
    expect(isProviderSandboxNotFoundError({ httpStatus: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError({ httpStatusCode: '404' })).toBe(
      true,
    );
    expect(
      isProviderSandboxNotFoundError({
        response: {
          status: 404,
        },
      }),
    ).toBe(true);
  });

  test('detects not-found provider errors from codes, messages, and causes', () => {
    expect(isProviderSandboxNotFoundError({ code: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError({ code: 'not_found' })).toBe(true);
    expect(isProviderSandboxNotFoundError({ code: 'resource-not-found' })).toBe(
      true,
    );
    expect(isProviderSandboxNotFoundError(new Error('404'))).toBe(true);
    expect(isProviderSandboxNotFoundError(new Error('not found'))).toBe(true);
    expect(
      isProviderSandboxNotFoundError(
        new Error('sandbox instance does not exist'),
      ),
    ).toBe(true);
    expect(
      isProviderSandboxNotFoundError(
        new Error('missing sandbox instance from provider'),
      ),
    ).toBe(true);
    expect(isProviderSandboxNotFoundError(new Error('devbox not found'))).toBe(
      true,
    );
    expect(
      isProviderSandboxNotFoundError({
        cause: {
          code: 'notfound',
        },
      }),
    ).toBe(true);
  });

  test('ignores unrelated provider errors and recursive causes', () => {
    const cyclic: { cause?: unknown; message: string } = {
      message: 'request timeout',
    };
    cyclic.cause = cyclic;

    expect(isProviderSandboxNotFoundError(undefined)).toBe(false);
    expect(isProviderSandboxNotFoundError('')).toBe(false);
    expect(isProviderSandboxNotFoundError(new Error('request timeout'))).toBe(
      false,
    );
    expect(isProviderSandboxNotFoundError({ code: 'timeout' })).toBe(false);
    expect(isProviderSandboxNotFoundError(cyclic)).toBe(false);
  });

  test('allows resume recreation only for not-found provider errors', () => {
    expect(() =>
      assertResumeRecreateAllowed(new Error('devbox not found'), {
        providerName: 'E2BSandboxClient',
        provider: 'e2b',
        details: { devboxId: 'devbox_test' },
      }),
    ).not.toThrow();

    let thrown: unknown;
    try {
      assertResumeRecreateAllowed(new Error('request timeout'), {
        providerName: 'E2BSandboxClient',
        provider: 'e2b',
        details: { devboxId: 'devbox_test' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'e2b',
      operation: 'resume',
      devboxId: 'devbox_test',
      cause: 'request timeout',
    });
  });

  test('wraps provider SDK errors with structured diagnostics', async () => {
    const sdkError = Object.assign(new Error('request failed'), {
      code: 'rate_limit',
      statusCode: 429,
      requestId: 'req_123',
      response: {
        status: 429,
        statusText: 'Too Many Requests',
        data: {
          error: {
            code: 'rate_limit',
            message: 'slow down',
          },
        },
      },
    });

    let thrown: unknown;
    try {
      await withProviderError(
        'ProviderSandboxClient',
        'provider',
        'create sandbox',
        async () => {
          throw sdkError;
        },
        { sandboxId: 'sandbox_123' },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as Error).message).toContain('request failed');
    expect((thrown as Error).message).toContain('responseStatus: 429');
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'provider',
      operation: 'create sandbox',
      sandboxId: 'sandbox_123',
      errorCode: 'rate_limit',
      status: 429,
      requestId: 'req_123',
      responseStatus: 429,
      responseStatusText: 'Too Many Requests',
      responseBody: {
        error: {
          code: 'rate_limit',
          message: 'slow down',
        },
      },
      retryable: true,
      cause: expect.stringContaining('request failed'),
    });
    expect((thrown as SandboxProviderError).retryable).toBe(true);
  });

  test('classifies provider retryability from statuses and typed errors', () => {
    expect(providerErrorRetryability({ status: 400 })).toBe(false);
    expect(providerErrorRetryability({ status: 404 })).toBe(false);
    expect(providerErrorRetryability({ status: 408 })).toBe(true);
    expect(providerErrorRetryability({ status: 429 })).toBe(true);
    expect(providerErrorRetryability({ status: 503 })).toBe(true);
    expect(providerErrorRetryability({ name: 'ProviderValidationError' })).toBe(
      false,
    );
    expect(providerErrorRetryability({ name: 'ProviderTimeoutError' })).toBe(
      true,
    );
    expect(
      providerErrorRetryability({
        response: {
          data: {
            error: {
              retryable: false,
            },
          },
        },
      }),
    ).toBe(false);
  });

  test('keeps provider details when manifest cleanup also fails', async () => {
    const manifestError = new SandboxProviderError(
      'ProviderSandboxClient failed to apply manifest.',
      {
        provider: 'provider',
        operation: 'apply manifest',
        cause: 'mkdir failed',
      },
    );
    const closeError = Object.assign(new Error('delete failed'), {
      response: {
        status: 502,
        data: {
          error: {
            code: 'pool_error',
            message: 'failed to stop sandbox',
          },
        },
      },
    });

    await expect(
      closeRemoteSessionOnManifestError(
        'Provider',
        {
          close: async () => {
            throw closeError;
          },
        },
        manifestError,
      ),
    ).rejects.toThrow(
      /Manifest error: ProviderSandboxClient failed to apply manifest\..*mkdir failed.*Close error: delete failed.*responseStatus: 502.*pool_error/s,
    );
  });

  test('base session handles common exec, filesystem, image, and port helpers', async () => {
    const session = new FakeRemoteSession();
    session.files.set('/workspace/image.png', ONE_BY_ONE_PNG);

    const execResult = await session.execCommand({
      cmd: 'echo hello',
      maxOutputTokens: 200,
    });
    expect(execResult).toContain('ran echo hello');
    expect(execResult).toContain('warning');

    expect(await session.pathExists('image.png')).toBe(true);
    expect(await session.pathExists('missing.png')).toBe(false);
    session.dirs.add('/workspace/tasks');
    expect(await session.directoryExists('tasks')).toBe(true);
    expect(await session.directoryExists('image.png')).toBe(false);
    expect(await session.running()).toBe(true);

    const image = await session.viewImage({ path: 'image.png' });
    if (
      !image.image ||
      typeof image.image !== 'object' ||
      !('mediaType' in image.image)
    ) {
      throw new Error('Expected viewImage to return inline image data.');
    }
    expect(image.image.mediaType).toBe('image/png');

    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint).toMatchObject({
      host: 'sandbox.example.com',
      port: 8080,
      tls: true,
    });
  });

  test.each([
    { status: 1, stderr: 'Permission denied' },
    { status: 2, stderr: 'Input/output error' },
  ])('preserves failed remote path probes: %j', async (result) => {
    const session = new FailedPathProbeSession(result);

    await expect(session.pathExists('blocked')).rejects.toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'fake',
        path: '/workspace/blocked',
        status: result.status,
      },
    });
  });

  test('applies manifest runAs metadata during full manifest materialization', async () => {
    const session = new FakeRemoteSession();

    await session.applyManifest(
      new Manifest({
        entries: {
          'notes.txt': file({ content: 'hello' }),
        },
      }),
      'sandbox-user',
    );

    expect(session.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining('chown'),
          options: expect.objectContaining({
            kind: 'manifest',
            workdir: '/',
          }),
        }),
      ]),
    );
    const chownCommand = session.commands.find((call) =>
      call.command.includes('chown'),
    )?.command;
    expect(chownCommand).toContain('sandbox-user');
    expect(chownCommand).toContain('/workspace/notes.txt');
  });
});

describe('remote image transfer limit', () => {
  test.each([undefined, 'sandbox-user'])(
    'rejects oversized images after a bounded transfer with runAs=%s',
    async (runAs) => {
      const root = await mkdtemp(join(tmpdir(), 'agents-image-limit-'));
      try {
        const handle = await open(join(root, 'large.png'), 'w');
        try {
          await handle.write(ONE_BY_ONE_PNG);
          await handle.truncate(32 * 1024 * 1024);
        } finally {
          await handle.close();
        }
        const session = new LocalImageReadSession(root);
        await expect(
          session.viewImage({ path: 'large.png', runAs }),
        ).rejects.toThrow('Image file exceeds the 10 MB limit: large.png');
        expect(session.transferredBytes).toBeLessThanOrEqual(
          10 * 1024 * 1024 + 6,
        );
        if (runAs) {
          expect(session.commands.at(-1)?.options.runAs).toBe(runAs);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each([ONE_BY_ONE_PNG.byteLength, 10 * 1024 * 1024])(
    'preserves supported images of %i bytes',
    async (size) => {
      const root = await mkdtemp(join(tmpdir(), 'agents-image-control-'));
      try {
        const bytes = new Uint8Array(size);
        bytes.set(ONE_BY_ONE_PNG);
        await writeFile(join(root, 'image.png'), bytes);
        const image = await new LocalImageReadSession(root).viewImage({
          path: 'image.png',
        });
        const payload = image.image as { data: Uint8Array; mediaType: string };
        expect(payload.mediaType).toBe('image/png');
        expect(Buffer.from(payload.data).equals(bytes)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
