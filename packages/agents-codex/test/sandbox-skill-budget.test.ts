import {
  mkdir,
  readFile,
  symlink,
  mkdtemp,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Manifest } from '@openai/agents-core/sandbox';
import {
  UnixLocalSandboxClient,
  localDirLazySkillSource,
} from '@openai/agents-core/sandbox/local';
import { Environment } from '../src/runtime/environment';
import { acquireEnvironment } from '../src/runtime/environment-source';
import { sandboxEnvironment } from '../src/runtime/sandbox-environment';
import {
  SandboxSkillBinding,
  SandboxSkillLease,
  skills,
} from '../src/runtime/sandbox-skills';

const MiB = 1024 * 1024;

async function fixture(
  secondMiB = 33,
  snapshot: boolean | 'noop' = false,
  firstMiB = 33,
) {
  const root = await mkdtemp(join(tmpdir(), 'skill-lease-budget-'));
  for (const [name, size] of [
    ['alpha', firstMiB],
    ['beta', secondMiB],
  ] as const) {
    await mkdir(join(root, name));
    await writeFile(
      join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: LEASE_BUDGET\n---\nbody`,
    );
    const asset = join(root, name, 'asset');
    await writeFile(asset, '');
    await truncate(asset, size * MiB);
  }
  const archiveBase =
    snapshot === true
      ? await mkdtemp(join(tmpdir(), 'skill-budget-snapshot-'))
      : undefined;
  const client = new UnixLocalSandboxClient();
  const sandbox = await client.create({
    manifest: new Manifest({
      root: '/workspace',
      extraPathGrants: [{ path: root, readOnly: true }],
    }),
    ...(snapshot === 'noop' ? { snapshot: { type: 'noop' as const } } : {}),
    ...(archiveBase
      ? { snapshot: { type: 'local' as const, baseDir: archiveBase } }
      : {}),
  });
  const binding = new SandboxSkillBinding(
    skills({ lazyFrom: localDirLazySkillSource({ src: root, baseDir: root }) }),
  );
  const leases: SandboxSkillLease[] = [];
  const newLease = (resource = sandbox, activeBinding = binding) => {
    const workspace = resource.state.workspaceRootPath;
    const environment = new Environment({
      url: 'wss://fixture.invalid',
      cwd: workspace,
      capabilityDirectories: [
        join(workspace, activeBinding.configuration.skillsPath),
      ],
      tools: [],
    });
    const lease = new SandboxSkillLease(
      activeBinding,
      resource,
      environment,
      resource.state.manifest,
      workspace,
    );
    leases.push(lease);
    return lease;
  };
  const lease = newLease();
  await lease.activate();
  const load = (name: string) => lease.load(name, new AbortController().signal);
  return {
    sandbox,
    client,
    lease,
    load,
    newLease,
    async close() {
      for (const lease of leases) lease.retire();
      await sandbox.close();
      await rm(root, { recursive: true, force: true });
      if (archiveBase) await rm(archiveBase, { recursive: true, force: true });
    },
  };
}

const unixIt = it.skipIf(process.platform === 'win32');

unixIt(
  'bounds retained skill snapshots across sequential loads in one lease',
  async () => {
    const f = await fixture();
    try {
      expect((await f.load('alpha')).status).toBe('loaded');
      await expect(f.load('beta')).rejects.toThrow(/skill tree byte limit/i);
      expect(await f.sandbox.pathExists('.agents/alpha/SKILL.md')).toBe(true);
      expect(await f.sandbox.pathExists('.agents/beta/SKILL.md')).toBe(false);
    } finally {
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'shares the retained skill budget across concurrent distinct loads',
  async () => {
    const f = await fixture();
    try {
      const results = await Promise.allSettled([
        f.load('alpha'),
        f.load('beta'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(await f.sandbox.pathExists('.agents/alpha/SKILL.md')).toBe(true);
      expect(await f.sandbox.pathExists('.agents/beta/SKILL.md')).toBe(false);
    } finally {
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'serializes concurrent duplicate loads and charges their destination once',
  async () => {
    const f = await fixture(30);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const materialize = f.sandbox.materializeEntry.bind(f.sandbox);
    let writes = 0;
    f.sandbox.materializeEntry = async (args) => {
      if (++writes === 1) {
        entered();
        await gate;
      }
      await materialize(args);
    };
    try {
      const first = f.load('alpha');
      await started;
      const duplicate = f.load('alpha');
      release();
      const results = await Promise.all([first, duplicate]);
      expect(results.map((result) => result.status)).toEqual([
        'loaded',
        'already_loaded',
      ]);
      expect(writes).toBe(1);
      expect((await f.load('beta')).status).toBe('loaded');
      expect(writes).toBe(2);
    } finally {
      release();
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'isolates cancellation of the first caller from a live queued duplicate',
  async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const exists = f.sandbox.pathExists.bind(f.sandbox);
    let checks = 0;
    f.sandbox.pathExists = async (path) => {
      const result = await exists(path);
      if (++checks === 1) {
        entered();
        await gate;
      }
      return result;
    };
    try {
      const cancelled = new AbortController();
      const first = f.lease.load('alpha', cancelled.signal);
      await started;
      const live = f.load('alpha');
      cancelled.abort(new Error('first caller cancelled'));
      release();
      const results = await Promise.allSettled([first, live]);
      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        'fulfilled',
      ]);
      expect(await f.sandbox.pathExists('.agents/alpha/SKILL.md')).toBe(true);
    } finally {
      release();
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'retains captured-byte admission after a borrowed sandbox receives another lease',
  async () => {
    const f = await fixture();
    try {
      expect((await f.load('alpha')).status).toBe('loaded');
      f.lease.retire();
      const next = f.newLease();
      await next.activate();
      await expect(
        next.load('beta', new AbortController().signal),
      ).rejects.toThrow(/skill tree byte limit/i);
      expect(await f.sandbox.pathExists('.agents/alpha/SKILL.md')).toBe(true);
      expect(await f.sandbox.pathExists('.agents/beta/SKILL.md')).toBe(false);
    } finally {
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'shares captured-byte admission across concurrent leases of one borrowed sandbox',
  async () => {
    const f = await fixture();
    try {
      const other = f.newLease();
      await other.activate();
      const results = await Promise.allSettled([
        f.load('alpha'),
        other.load('beta', new AbortController().signal),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(await f.sandbox.pathExists('.agents/alpha/SKILL.md')).toBe(true);
      expect(await f.sandbox.pathExists('.agents/beta/SKILL.md')).toBe(false);
    } finally {
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'preserves captured-byte admission through a trusted live sandbox resume',
  async () => {
    const f = await fixture();
    let resumed: typeof f.sandbox | undefined;
    try {
      await f.load('alpha');
      f.lease.retire();
      resumed = await new UnixLocalSandboxClient().resume(f.sandbox.state);
      expect(resumed.state.workspaceRootPath).toBe(
        f.sandbox.state.workspaceRootPath,
      );
      const next = f.newLease(resumed);
      await next.activate();
      await expect(
        next.load('beta', new AbortController().signal),
      ).rejects.toThrow(/skill tree byte limit/i);
      expect(await resumed.pathExists('.agents/beta/SKILL.md')).toBe(false);
    } finally {
      await resumed?.close();
      await f.close();
    }
  },
  30_000,
);

unixIt.each(['.agents', '.other'])(
  'seeds capture admission from a serialized cold sandbox resume with %s',
  async (namespace) => {
    const f = await fixture(33, true);
    let resumed: typeof f.sandbox | undefined;
    try {
      await f.load('alpha');
      f.lease.retire();
      const saved = JSON.parse(
        JSON.stringify(await f.client.serializeSessionState(f.sandbox.state)),
      );
      const snapshot = saved.snapshot as { path: string };
      const originalRoot = f.sandbox.state.workspaceRootPath;
      await f.sandbox.close();
      const client = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: originalRoot,
          workspaceRootOwned: true,
          localSnapshotPath: snapshot.path,
        },
      });
      resumed = await client.resume(
        await client.deserializeSessionState(saved),
      );
      expect(resumed.state.workspaceRootPath).not.toBe(originalRoot);
      const binding = new SandboxSkillBinding(
        skills({
          skillsPath: namespace,
          lazyFrom: f.lease.binding.configuration.lazyFrom,
        }),
      );
      const next = f.newLease(resumed, binding);
      await next.activate();
      await expect(
        next.load('beta', new AbortController().signal),
      ).rejects.toThrow(/skill tree byte limit/i);
      expect(await resumed.pathExists('.agents/alpha/SKILL.md')).toBe(true);
      expect(await resumed.pathExists(`${namespace}/beta/SKILL.md`)).toBe(
        false,
      );
    } finally {
      await resumed?.close();
      await f.close();
    }
  },
  60_000,
);

unixIt(
  'preserves captured binary payloads through provider JSON serialization',
  async () => {
    const f = await fixture(0, true, 0);
    try {
      await f.load('alpha');
      const saved = JSON.parse(
        JSON.stringify(await f.client.serializeSessionState(f.sandbox.state)),
      );
      const restored = await f.client.deserializeSessionState(saved);
      const file = (
        restored.manifest.entries['.agents/alpha'] as {
          children: Record<string, { content: unknown }>;
        }
      ).children['SKILL.md'];
      expect(file.content).toBeInstanceOf(Uint8Array);
    } finally {
      await f.close();
    }
  },
  30_000,
);

unixIt.each([false, true])(
  'preserves fresh trusted inline resources with snapshot policy %s',
  async (snapshot) => {
    const f = await fixture(0, false, 0);
    const snapshotBase = await mkdtemp(join(tmpdir(), 'fresh-skill-snapshot-'));
    let fresh: typeof f.sandbox | undefined;
    try {
      fresh = await f.client.create({
        manifest: new Manifest({
          root: '/workspace',
          extraPathGrants: f.sandbox.state.manifest.extraPathGrants,
          entries: {
            'unrelated.txt': { type: 'file', content: 'x'.repeat(65 * MiB) },
          },
        }),
        snapshot: snapshot
          ? { type: 'local', baseDir: snapshotBase }
          : { type: 'noop' },
      });
      if (snapshot) {
        await f.client.serializeSessionState(fresh.state);
        expect(fresh.state.snapshot?.type).toBe('local');
      }
      const lease = f.newLease(fresh);
      await lease.activate();
      expect(
        (await lease.load('alpha', new AbortController().signal)).status,
      ).toBe('loaded');
    } finally {
      await fresh?.close();
      await f.close();
      await rm(snapshotBase, { recursive: true, force: true });
    }
  },
  30_000,
);

unixIt(
  'recounts serialized restoration without a durable snapshot',
  async () => {
    const f = await fixture(33, 'noop');
    let resumed: typeof f.sandbox | undefined;
    try {
      await f.load('alpha');
      f.lease.retire();
      const saved = JSON.parse(
        JSON.stringify(await f.client.serializeSessionState(f.sandbox.state)),
      );
      expect(saved.snapshot).toBeNull();
      const client = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: f.sandbox.state.workspaceRootPath,
          workspaceRootOwned: false,
        },
      });
      resumed = await client.resume(
        await client.deserializeSessionState(saved),
      );
      const next = f.newLease(resumed);
      await next.activate();
      await expect(
        next.load('beta', new AbortController().signal),
      ).rejects.toThrow(/skill tree byte limit/i);
    } finally {
      await resumed?.close();
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'refuses rotating assets after the indexed skill sentinel disappears',
  async () => {
    const f = await fixture();
    try {
      const root = f.sandbox.state.manifest.extraPathGrants[0].path;
      await rm(join(root, 'alpha', 'SKILL.md'));
      const outcomes: string[] = [];
      let previous = 'asset';
      for (const name of ['asset-one', 'asset-two']) {
        await rename(join(root, 'alpha', previous), join(root, 'alpha', name));
        previous = name;
        outcomes.push(
          await f.load('alpha').then(
            (result) => result.status,
            (error) => error.message,
          ),
        );
      }
      let retainedBytes = 0;
      for (const name of ['asset-one', 'asset-two']) {
        try {
          retainedBytes += (
            await stat(
              join(f.sandbox.state.workspaceRootPath, '.agents', 'alpha', name),
            )
          ).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      expect(retainedBytes).toBe(0);
      expect(outcomes).toEqual([
        'Captured skill requires a regular SKILL.md',
        'Captured skill requires a regular SKILL.md',
      ]);
      expect(await f.sandbox.pathExists('.agents/alpha/asset-one')).toBe(false);
      expect(await f.sandbox.pathExists('.agents/alpha/asset-two')).toBe(false);
    } finally {
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'refuses overlay reload after a materialized sentinel is removed',
  async () => {
    const f = await fixture();
    try {
      await f.load('alpha');
      const root = f.sandbox.state.manifest.extraPathGrants[0].path;
      await rm(
        join(f.sandbox.state.workspaceRootPath, '.agents', 'alpha', 'SKILL.md'),
      );
      await rename(
        join(root, 'alpha', 'asset'),
        join(root, 'alpha', 'replacement'),
      );
      await expect(f.load('alpha')).rejects.toThrow(
        /Skill destination cannot be reloaded/,
      );
      expect(await f.sandbox.pathExists('.agents/alpha/asset')).toBe(true);
      expect(await f.sandbox.pathExists('.agents/alpha/replacement')).toBe(
        false,
      );
    } finally {
      await f.close();
    }
  },
  30_000,
);

unixIt(
  'preserves the allowance through the generic authorized source resume',
  async () => {
    const f = await fixture(33, true);
    let owner: Awaited<ReturnType<typeof acquireEnvironment>> | undefined;
    try {
      await f.load('alpha');
      f.lease.retire();
      const saved = JSON.parse(
        JSON.stringify(await f.client.serializeSessionState(f.sandbox.state)),
      );
      const original = f.sandbox.state.workspaceRootPath;
      await f.sandbox.close();
      const client = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: original,
          workspaceRootOwned: true,
          localSnapshotPath: saved.snapshot.path,
        },
      });
      const state = await client.deserializeSessionState(saved);
      const source = sandboxEnvironment({
        client,
        manifest: new Manifest({
          root: '/workspace',
          extraPathGrants: f.sandbox.state.manifest.extraPathGrants,
        }),
        authorizedResumeState: { backendId: client.backendId, state },
        skills: f.lease.binding.configuration,
        connect: async (resource) =>
          Environment.lease(
            new Environment({
              url: 'wss://fixture.invalid',
              cwd: String(resource.state.workspaceRootPath),
              capabilityDirectories: [
                join(String(resource.state.workspaceRootPath), '.agents'),
              ],
              tools: [],
            }),
            async () => {},
          ),
      });
      owner = await acquireEnvironment(source);
      await expect(
        owner.skillLease!.load('beta', new AbortController().signal),
      ).rejects.toThrow(/skill tree byte limit/i);
    } finally {
      await owner?.dispose();
      await f.close();
    }
  },
  60_000,
);

unixIt.each([false, true])(
  'measures only owned fresh opaque resources with created=%s',
  async (created) => {
    const f = await fixture(created ? 0 : 33, false, created ? 0 : 33);
    let next: SandboxSkillLease | undefined;
    try {
      if (!created) await f.load('alpha');
      f.lease.retire();
      let writes = 0;
      const opaque = {
        state: { ...f.sandbox.state },
        pathExists: f.sandbox.pathExists.bind(f.sandbox),
        materializeEntry: async (
          args: Parameters<typeof f.sandbox.materializeEntry>[0],
        ) => {
          writes++;
          await f.sandbox.materializeEntry(args);
        },
      };
      const root = f.sandbox.state.workspaceRootPath;
      const environment = new Environment({
        url: 'wss://fixture.invalid',
        cwd: root,
        capabilityDirectories: [join(root, '.agents')],
        tools: [],
      });
      next = new SandboxSkillLease(
        f.lease.binding,
        opaque,
        environment,
        opaque.state.manifest,
        root,
        created ? true : undefined,
      );
      await next.activate();
      const pending = next.load(
        created ? 'alpha' : 'beta',
        new AbortController().signal,
      );
      if (created) {
        expect((await pending).status).toBe('loaded');
        expect(writes).toBe(1);
      } else {
        await expect(pending).rejects.toThrow(
          /configured native Skills quota cannot be measured/,
        );
        expect(writes).toBe(0);
        expect(await f.sandbox.pathExists('.agents/beta/SKILL.md')).toBe(false);
      }
    } finally {
      next?.retire();
      await f.close();
    }
  },
  30_000,
);

unixIt.each(['local_file', 'local_dir'] as const)(
  'recounts a restored workspace with a nested %s declaration',
  async (kind) => {
    const f = await fixture(0, true, 0);
    let resumed: typeof f.sandbox | undefined;
    try {
      const sourceRoot = f.sandbox.state.manifest.extraPathGrants[0].path;
      await f.sandbox.materializeEntry({
        path: 'resources',
        entry: {
          type: 'dir',
          children: {
            nested: {
              type: kind,
              src: join(
                sourceRoot,
                'alpha',
                ...(kind === 'local_file' ? ['SKILL.md'] : []),
              ),
            },
          },
        },
      });
      const saved = JSON.parse(
        JSON.stringify(await f.client.serializeSessionState(f.sandbox.state)),
      );
      const originalRoot = f.sandbox.state.workspaceRootPath;
      await f.sandbox.close();
      const client = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: originalRoot,
          workspaceRootOwned: true,
          localSnapshotPath: saved.snapshot.path,
        },
      });
      resumed = await client.resume(
        await client.deserializeSessionState(saved),
      );
      const lease = f.newLease(resumed);
      await lease.activate();
      expect(
        (await lease.load('beta', new AbortController().signal)).status,
      ).toBe('loaded');
      expect(await resumed.pathExists('.agents/beta/SKILL.md')).toBe(true);
      expect(
        await resumed.pathExists(
          kind === 'local_file'
            ? 'resources/nested'
            : 'resources/nested/SKILL.md',
        ),
      ).toBe(true);
    } finally {
      await resumed?.close();
      await f.close();
    }
  },
  30_000,
);

unixIt.each(['source', 'sentinel', 'extra-asset', 'symlink'] as const)(
  'rejects an existing lazy tree after its %s changes',
  async (change) => {
    const f = await fixture(0, false, 0);
    try {
      await f.load('alpha');
      const sourceRoot = f.sandbox.state.manifest.extraPathGrants[0].path;
      const destination = join(
        f.sandbox.state.workspaceRootPath,
        '.agents/alpha',
      );
      if (change === 'source')
        await writeFile(
          join(sourceRoot, 'alpha/SKILL.md'),
          'new source document',
        );
      else if (change === 'sentinel')
        await writeFile(
          join(destination, 'SKILL.md'),
          'stale workspace document',
        );
      else if (change === 'extra-asset')
        await writeFile(join(destination, 'untracked'), 'unverified asset');
      else {
        await rm(join(destination, 'asset'));
        await symlink(
          join(sourceRoot, 'alpha/SKILL.md'),
          join(destination, 'asset'),
        );
      }
      const before = await readFile(join(destination, 'SKILL.md'), 'utf8');
      await expect(f.load('alpha')).rejects.toThrow();
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe(
        before,
      );
    } finally {
      await f.close();
    }
  },
  30_000,
);

it('rejects an existing lazy tree for a provider without current-content verification', async () => {
  const manifest = new Manifest();
  const binding = new SandboxSkillBinding(
    skills({
      lazyFrom: {
        source: {
          type: 'dir',
          children: {
            report: {
              type: 'dir',
              children: { 'SKILL.md': { type: 'file', content: 'current' } },
            },
          },
        },
        index: [{ name: 'report', description: 'current report' }],
      },
    }),
  );
  let writes = 0;
  const lease = new SandboxSkillLease(
    binding,
    {
      state: { manifest },
      pathExists: async () => true,
      materializeEntry: async () => {
        writes++;
      },
    },
    new Environment({
      url: 'wss://fixture.invalid',
      cwd: '/workspace',
      capabilityDirectories: ['/workspace/.agents'],
      tools: [],
    }),
    manifest,
    '/workspace',
  );
  try {
    await lease.activate();
    await expect(
      lease.load('report', new AbortController().signal),
    ).rejects.toThrow(/cannot be verified for this provider/);
    expect(writes).toBe(0);
  } finally {
    lease.retire();
  }
});
