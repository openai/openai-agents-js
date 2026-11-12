import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Manifest } from '@openai/agents-core/sandbox';
import {
  UnixLocalSandboxClient,
  localDirLazySkillSource,
} from '@openai/agents-core/sandbox/local';
import { Environment } from '../src/runtime/environment';
import {
  SandboxSkillBinding,
  SandboxSkillLease,
  skills,
} from '../src/runtime/sandbox-skills';

const MiB = 1024 * 1024;

async function fixture(secondMiB = 33) {
  const root = await mkdtemp(join(tmpdir(), 'skill-lease-budget-'));
  for (const [name, size] of [
    ['alpha', 33],
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
  const sandbox = await new UnixLocalSandboxClient().create(
    new Manifest({
      root: '/workspace',
      extraPathGrants: [{ path: root, readOnly: true }],
    }),
  );
  const workspace = sandbox.state.workspaceRootPath;
  const environment = new Environment({
    url: 'wss://fixture.invalid',
    cwd: workspace,
    capabilityDirectories: [join(workspace, '.agents')],
    tools: [],
  });
  const binding = new SandboxSkillBinding(
    skills({ lazyFrom: localDirLazySkillSource({ src: root, baseDir: root }) }),
  );
  const lease = new SandboxSkillLease(
    binding,
    sandbox,
    environment,
    sandbox.state.manifest,
    workspace,
  );
  await lease.activate();
  const load = (name: string) => lease.load(name, new AbortController().signal);
  return {
    sandbox,
    lease,
    load,
    async close() {
      lease.retire();
      await sandbox.close();
      await rm(root, { recursive: true, force: true });
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
  'coalesces concurrent duplicate skill loads and charges their destination once',
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
    const exists = f.sandbox.pathExists.bind(f.sandbox);
    let writes = 0;
    let checks = 0;
    f.sandbox.pathExists = async (path) => {
      checks++;
      return exists(path);
    };
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
      const checksWhileBlocked = checks;
      release();
      const results = await Promise.all([first, duplicate]);
      expect(checksWhileBlocked).toBe(1);
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
    const exists = f.sandbox.pathExists.bind(f.sandbox);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
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
