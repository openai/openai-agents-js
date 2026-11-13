import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxCapability,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer?.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
type Bound = {
  capability: ProbeCapability;
  sandbox: SandboxSessionLike;
  user?: string;
};
class ProbeCapability implements SandboxCapability {
  readonly type = 'probe';
  bound?: SandboxSessionLike;
  runAs?: string;
  constructor(
    readonly bindings: Bound[],
    readonly required: readonly string[] = [],
    readonly instruction?: (clone: ProbeCapability) => Promise<string>,
  ) {}
  clone() {
    return new ProbeCapability(this.bindings, this.required, this.instruction);
  }
  requiredCapabilityTypes() {
    return this.required;
  }
  prepareManifest(manifest: Manifest) {
    return new Manifest({
      ...manifest,
      entries: {
        ...manifest.entries,
        'capability.txt': { type: 'file', content: 'prepared capability' },
      },
    });
  }
  bind(sandbox: SandboxSessionLike, user?: string) {
    this.bound = sandbox;
    this.bindings.push({ capability: this, sandbox, user });
    return this;
  }
  bindRunAs(user?: string) {
    this.runAs = user;
    return this;
  }
  instructions() {
    if (!this.bound) throw new Error('Missing acquisition binding');
    return (
      this.instruction?.(this) ?? 'Per-acquisition capability instructions'
    );
  }
}
function sourceFor(
  capabilities: readonly SandboxCapability[],
  options: { client?: UnixLocalSandboxClient; cleanup?: () => void } = {},
) {
  return sandboxEnvironment({
    client: options.client ?? new UnixLocalSandboxClient(),
    manifest: new Manifest(),
    capabilities,
    capabilityUser: 'root',
    connect: async (sandbox) =>
      Environment.lease(
        new Environment({
          url: peer.url,
          headers: peer.headers,
          cwd: sandbox.state.workspaceRootPath as string,
          tools: [],
        }),
        options.cleanup ?? (() => {}),
      ),
  });
}
it('has been preparing and binding isolated capability clones through actual native openings', async () => {
  const bindings: Bound[] = [];
  const original = new ProbeCapability(bindings);
  const source = sourceFor([original]);
  const first = new ModelServer([[message('first done')]]);
  const second = new ModelServer([[message('second done')]]);
  await using firstProvider = await providerFor(first);
  await using secondProvider = await providerFor(second);
  const [a, b] = await Promise.all([
    new Agent({ instructions: 'First', provider: firstProvider }).session({
      environment: source,
    }),
    new Agent({ instructions: 'Second', provider: secondProvider }).session({
      environment: source,
    }),
  ]);
  try {
    const results = await Promise.all([
      a.submit('go').then((turn) => turn.wait()),
      b.submit('go').then((turn) => turn.wait()),
    ]);
    expect(results.map((result) => result.finalOutput)).toEqual([
      'first done',
      'second done',
    ]);
    expect(bindings).toHaveLength(2);
    expect(bindings[0].sandbox).not.toBe(bindings[1].sandbox);
    expect(bindings[0].capability).not.toBe(bindings[1].capability);
    expect(original.bound).toBeUndefined();
    for (const binding of bindings) {
      expect(binding.capability.runAs).toBe('root');
      expect(
        await readFile(
          binding.sandbox.state.workspaceRootPath + '/capability.txt',
          'utf8',
        ),
      ).toBe('prepared capability');
    }
    for (const server of [first, second]) {
      expect(JSON.stringify(server.requests[0])).toContain(
        'Per-acquisition capability instructions',
      );
      server.assertExhausted();
    }
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
it('has been rejecting missing capability requirements before provider acquisition', async () => {
  const client = new UnixLocalSandboxClient();
  const create = vi.spyOn(client, 'create');
  const bindings: Bound[] = [];
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await expect(
    new Agent({ instructions: 'Root', provider }).session({
      environment: sourceFor([new ProbeCapability(bindings, ['missing'])], {
        client,
      }),
    }),
  ).rejects.toThrow('requires missing capabilities: missing');
  expect(create).not.toHaveBeenCalled();
  expect(bindings).toEqual([]);
  expect(server.requests).toEqual([]);
});
it('has been retaining the resource until every entered instruction hook settles', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const bindings: Bound[] = [];
  const cleanup = vi.fn();
  const failing = new ProbeCapability(bindings, [], async () => {
    throw new Error('instruction failure');
  });
  const held = new ProbeCapability(bindings, [], async () => {
    entered.resolve();
    await release.promise;
    return 'held';
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const opening = new Agent({ instructions: 'Root', provider }).session({
    environment: sourceFor([failing, held], { cleanup }),
  });
  let settled = false;
  void opening
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  try {
    await entered.promise;
    expect(settled).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      await readFile(
        bindings[0].sandbox.state.workspaceRootPath + '/capability.txt',
        'utf8',
      ),
    ).toBe('prepared capability');
  } finally {
    release.resolve();
  }
  await expect(opening).rejects.toThrow('instruction failure');
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(server.requests).toEqual([]);
});

it.each(['success', 'unsafe-entry-change', 'staging-failure'] as const)(
  'has been materializing resumed capability additions before bind while preserving saved edits: %s',
  async (kind) => {
    class ResumeCapability extends ProbeCapability {
      clone() {
        return new ResumeCapability(this.bindings);
      }
      bind(sandbox: SandboxSessionLike, user?: string) {
        expect(
          readFileSync(
            join(sandbox.state.workspaceRootPath as string, 'capability.txt'),
            'utf8',
          ),
        ).toBe('prepared capability');
        return super.bind(sandbox, user);
      }
    }
    const archiveBase = await mkdtemp(
      join(tmpdir(), 'native-capability-resume-'),
    );
    const client = new UnixLocalSandboxClient();
    const manifest = new Manifest({
      entries: {
        'notes.txt': { type: 'file', content: 'initial template' },
        ...(kind === 'unsafe-entry-change'
          ? {
              'capability.txt': {
                type: 'file' as const,
                content: 'saved original',
              },
            }
          : {}),
      },
    });
    const seed = await client.create({
      manifest,
      snapshot: { type: 'local', baseDir: archiveBase },
    });
    try {
      await writeFile(
        join(seed.state.workspaceRootPath, 'notes.txt'),
        'saved user edit',
      );
      const saved = await client.serializeSessionState(seed.state);
      const snapshot = saved.snapshot as { type: 'local'; path: string };
      await seed.close();
      const resumed = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: saved.workspaceRootPath as string,
          workspaceRootOwned: true,
          localSnapshotPath: snapshot.path,
        },
      });
      const state = await resumed.deserializeSessionState(saved);
      const resumeCall = vi.spyOn(resumed, 'resume');
      const acquired = new Set<SandboxSessionLike>();
      const closed = new Set<SandboxSessionLike>();
      if (kind === 'staging-failure') {
        const actualResume =
          UnixLocalSandboxClient.prototype.resume.bind(resumed);
        resumeCall.mockImplementation(async (...args) => {
          const sandbox = await actualResume(...args);
          vi.spyOn(sandbox, 'materializeEntry').mockRejectedValueOnce(
            new Error('staging failure'),
          );
          acquired.add(sandbox);
          const actualClose = sandbox.close.bind(sandbox);
          vi.spyOn(sandbox, 'close').mockImplementation(async () => {
            await actualClose();
            closed.add(sandbox);
          });
          return sandbox;
        });
      }

      const bindings: Bound[] = [];
      const server = new ModelServer(
        kind === 'success' ? [[message('resumed capability')]] : [],
      );
      await using provider = await providerFor(server);
      const source = sandboxEnvironment({
        client: resumed,
        manifest,
        capabilities: [new ResumeCapability(bindings)],
        authorizedResumeState: { backendId: resumed.backendId, state },
        connect: async (sandbox) =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: sandbox.state.workspaceRootPath as string,
              tools: [],
            }),
            () => {},
          ),
      });
      const opening = new Agent({
        instructions: 'Continue the workspace',
        provider,
      }).session({ environment: source });
      if (kind !== 'success') {
        await expect(opening).rejects.toThrow(
          kind === 'unsafe-entry-change'
            ? 'cannot change manifest entries'
            : 'staging failure',
        );
        expect(bindings).toEqual([]);
        expect(server.requests).toEqual([]);
        if (kind === 'unsafe-entry-change')
          expect(resumeCall).not.toHaveBeenCalled();
        else {
          expect(acquired.size).toBeGreaterThan(0);
          expect(closed).toEqual(acquired);
        }
        return;
      }
      await using session = await opening;
      expect((await (await session.submit('go')).wait()).finalOutput).toBe(
        'resumed capability',
      );
      expect(bindings).toHaveLength(1);
      expect(
        await readFile(
          join(
            bindings[0].sandbox.state.workspaceRootPath as string,
            'notes.txt',
          ),
          'utf8',
        ),
      ).toBe('saved user edit');
      server.assertExhausted();
    } finally {
      await seed.close();
      await rm(archiveBase, { recursive: true, force: true });
    }
  },
);
