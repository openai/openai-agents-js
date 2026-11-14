import OpenAI from 'openai';
import type { JsonObject } from '../../src/runtime/binding';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxCapability,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import {
  Agent,
  Environment,
  NativeProvider,
  ChatCompletionsModel,
  tool,
  manualTool,
  shellTool,
  applyPatchTool,
  type ApplyPatchEditor,
  type ToolContext,
  type ShellCall,
  type ModelSettings,
  type ModelRequestContext,
  type SandboxAccess,
} from '../../src';
import { ModelServer, message, call } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import * as privateOpening from '../../src/runtime/private-opening-contribution';

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
  capabilities: readonly SandboxCapability[] | undefined,
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
it('has been retaining instruction-only capability text through an accepted graph transfer', async () => {
  const server = new ModelServer([
    [call('transfer_to_worker', {}, { callId: 'instruction-only-transfer' })],
    [message('Instruction-only graph completed.')],
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({
    name: 'worker',
    instructions: 'Worker',
    model: 'gpt-5.5',
  });
  const bindings: Bound[] = [];
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Root',
    handoffs: [target],
  }).session({ environment: sourceFor([new ProbeCapability(bindings)]) });
  expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
    'Instruction-only graph completed.',
  );
  for (const request of server.requests)
    expect(JSON.stringify(request.input)).toContain(
      'Per-acquisition capability instructions',
    );
  server.assertExhausted();
});

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

it.each(['previous-capability', 'undeclared-collision'] as const)(
  'has been preserving edited restored capability files and rejecting occupied new paths: %s',
  async (kind) => {
    class EditedCapability extends ProbeCapability {
      clone() {
        return new EditedCapability(this.bindings);
      }
      bind(sandbox: SandboxSessionLike, user?: string) {
        expect(
          readFileSync(
            join(sandbox.state.workspaceRootPath as string, 'capability.txt'),
            'utf8',
          ),
        ).toBe('saved capability edit');
        return super.bind(sandbox, user);
      }
    }
    const archiveBase = await mkdtemp(
      join(tmpdir(), 'native-capability-edited-resume-'),
    );
    const client = new UnixLocalSandboxClient();
    const applicationManifest = new Manifest();
    const seedManifest =
      kind === 'previous-capability'
        ? new ProbeCapability([]).prepareManifest(applicationManifest)
        : applicationManifest;
    const seed = await client.create({
      manifest: seedManifest,
      snapshot: { type: 'local', baseDir: archiveBase },
    });
    try {
      await writeFile(
        join(seed.state.workspaceRootPath, 'capability.txt'),
        'saved capability edit',
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
      const actualResume = resumed.resume.bind(resumed);
      let materializations = 0;
      let restoredIdentity:
        { ino: number; mtimeMs: number; mode: number } | undefined;
      vi.spyOn(resumed, 'resume').mockImplementation(async (...args) => {
        const sandbox = await actualResume(...args);
        if (restoredIdentity === undefined)
          restoredIdentity = await stat(
            join(sandbox.state.workspaceRootPath, 'capability.txt'),
          );
        const materialize = sandbox.materializeEntry.bind(sandbox);
        vi.spyOn(sandbox, 'materializeEntry').mockImplementation(
          async (args) => {
            materializations++;
            await materialize(args);
          },
        );
        return sandbox;
      });
      const bindings: Bound[] = [];
      const server = new ModelServer(
        kind === 'previous-capability' ? [[message('preserved edit')]] : [],
      );
      await using provider = await providerFor(server);
      const source = sandboxEnvironment({
        client: resumed,
        manifest: applicationManifest,
        capabilities: [new EditedCapability(bindings)],
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
      if (kind === 'undeclared-collision') {
        await expect(opening).rejects.toThrow('already occupies');
        expect(bindings).toEqual([]);
        expect(server.requests).toEqual([]);
      } else {
        await using session = await opening;
        expect((await (await session.submit('go')).wait()).finalOutput).toBe(
          'preserved edit',
        );
        const after = await stat(
          join(
            bindings[0].sandbox.state.workspaceRootPath as string,
            'capability.txt',
          ),
        );
        expect({
          ino: after.ino,
          mtimeMs: after.mtimeMs,
          mode: after.mode,
        }).toEqual({
          ino: restoredIdentity!.ino,
          mtimeMs: restoredIdentity!.mtimeMs,
          mode: restoredIdentity!.mode,
        });
        server.assertExhausted();
      }
      expect(materializations).toBe(0);
    } finally {
      await seed.close();
      await rm(archiveBase, { recursive: true, force: true });
    }
  },
);

it('has been admitting bound capability tools and applying settings and context in declared root order', async () => {
  const bindings: Bound[] = [];
  const effects: string[] = [];
  const openingOrder: string[] = [];
  const application = { account: 'same-owner' };
  const input = (text: string): JsonObject => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  });
  class Contribution extends ProbeCapability {
    constructor(readonly label: string) {
      super(bindings);
    }
    clone() {
      return new Contribution(this.label);
    }
    tools() {
      openingOrder.push('tools:' + this.label);
      expect(this.bound).toBeDefined();
      return [
        tool({
          name: 'bound_' + this.label,
          description: 'Bound provider probe',
          parameters: z.object({}),
          execute: async (_args, context) => {
            expect(context.context).toBe(application);
            const result = await context.sandbox!.exec({
              cmd: 'cat capability.txt',
            });
            effects.push('tool:' + this.label);
            return result.stdout;
          },
        }),
      ];
    }
    samplingSettings(settings: ModelSettings): ModelSettings {
      openingOrder.push('settings:' + this.label);
      if (this.label === 'beta')
        expect(settings.metadata?.alpha).toBe('sampled');
      return { metadata: { ...settings.metadata, [this.label]: 'sampled' } };
    }
    transformContext(context: ModelRequestContext) {
      effects.push('context:' + this.label);
      if (this.label === 'beta')
        expect(JSON.stringify(context.items)).toContain('CAP_ALPHA');
      return [...context.items, input('CAP_' + this.label.toUpperCase())];
    }
  }
  const source = sourceFor([
    new Contribution('alpha'),
    new Contribution('beta'),
  ]);
  const server = new ModelServer([
    [call('bound_alpha', {}, { callId: 'bound-call' })],
    [message('bound result')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent<typeof application>({
    instructions: 'Use bound_alpha',
    model: 'fixture-capability-contributions',
    provider,
    modelSettings: { metadata: { agent: 'preserved' } },
    transformContext: (context) => {
      effects.push('context:agent');
      return [...context.items, input('AGENT_LAST')];
    },
  }).session({ environment: source, context: application });
  expect(openingOrder).toEqual([
    'tools:alpha',
    'tools:beta',
    'settings:alpha',
    'settings:beta',
  ]);
  (bindings[0].capability as Contribution).transformContext = () => {
    throw new Error(
      'Late method replacement must not change captured callbacks',
    );
  };
  expect((await (await session.submit('go')).wait()).finalOutput).toBe(
    'bound result',
  );
  expect(effects).toEqual([
    'context:alpha',
    'context:beta',
    'context:agent',
    'tool:alpha',
    'context:alpha',
    'context:beta',
    'context:agent',
  ]);
  for (const request of server.requests) {
    expect(request.metadata).toMatchObject({
      agent: 'preserved',
      alpha: 'sampled',
      beta: 'sampled',
    });
    expect(JSON.stringify(request.input)).toContain('AGENT_LAST');
  }
  expect(JSON.stringify(server.requests[1].input)).toContain(
    'prepared capability',
  );
  server.assertExhausted();
});

it.each(['duplicate', 'deferred'] as const)(
  'has been rejecting unsupported capability admission before tool dispatch: %s',
  async (kind) => {
    const execute = vi.fn(() => 'unexpected');
    const cleanup = vi.fn();
    class InvalidContribution extends ProbeCapability {
      clone() {
        return new InvalidContribution(this.bindings);
      }
      tools() {
        return [
          tool({
            name: 'lookup',
            description: 'Capability declaration',
            deferLoading: kind === 'deferred',
            parameters: z.object({}),
            execute,
          }),
        ];
      }
    }
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Root',
      provider,
      tools:
        kind === 'duplicate'
          ? [
              tool({
                name: 'lookup',
                description: 'Root declaration',
                parameters: z.object({}),
                execute,
              }),
            ]
          : [],
    });
    await expect(
      agent.session({
        environment: sourceFor([new InvalidContribution([])], { cleanup }),
      }),
    ).rejects.toThrow(
      kind === 'duplicate'
        ? 'Duplicate tool functions.lookup'
        : 'eager direct function tools',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual([]);
  },
);

it.each(['graph', 'manual-restore'] as const)(
  'has been rejecting capability callback replay outside a fresh root: %s',
  async (kind) => {
    let state;
    if (kind === 'manual-restore') {
      const seedModel = new ModelServer([
        [call('pending', {}, { callId: 'pending-capability-restore' })],
      ]);
      await using seedProvider = await providerFor(seedModel);
      await using seed = await new Agent({
        instructions: 'Request a manual decision',
        provider: seedProvider,
        tools: [
          manualTool({
            name: 'pending',
            description: 'Pending decision',
            parameters: z.object({}),
            result: z.string(),
          }),
        ],
      }).session();
      const turn = await seed.submit('pause');
      const completion = turn.wait().catch((error) => error);
      await turn.wait({ until: 'manual_tool' });
      state = await seed.suspend();
      await completion;
    }
    const factories = vi.fn(() => [
      tool({
        name: 'bound',
        description: 'Fresh bound function',
        parameters: z.object({}),
        execute: () => 'unused',
      }),
    ]);
    const cleanup = vi.fn();
    class RootOnly extends ProbeCapability {
      clone() {
        return new RootOnly(this.bindings);
      }
      tools() {
        return factories();
      }
    }
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const target = new Agent({
      name: 'worker',
      instructions: 'Target',
      provider,
      tools:
        kind === 'graph'
          ? [
              manualTool({
                name: 'review',
                description: 'Manual target decision',
                parameters: z.object({}),
                result: z.string(),
              }),
            ]
          : [],
    });
    const agent = new Agent({
      instructions: 'Root',
      provider,
      handoffs: kind === 'graph' ? [target] : [],
    });
    await expect(
      agent.session({
        environment: sourceFor([new RootOnly([])], { cleanup }),
        state,
      }),
    ).rejects.toThrow('fresh root');
    expect(factories).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual([]);
  },
);

it('has been rejecting lossy capability projections before later callbacks or provider dispatch', async () => {
  class Lossy extends ProbeCapability {
    clone() {
      return new Lossy(this.bindings);
    }
    transformContext() {
      return [
        { type: 'message', role: 'user', content: Number.POSITIVE_INFINITY },
      ];
    }
  }
  const original = vi.fn();
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Root',
    provider,
    transformContext: original,
  }).session({ environment: sourceFor([new Lossy([])]) });
  await expect((await session.submit('go')).wait()).rejects.toThrow(
    'finite JSON value',
  );
  expect(original).not.toHaveBeenCalled();
  expect(server.requests).toEqual([]);
});

it('has been joining a cancelled capability context hook and observing its late rejection', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const lateFailure = new Error('late capability rejection');
  const cleanup = vi.fn();
  const containsFailure = (error: unknown): boolean =>
    error === lateFailure ||
    (error instanceof AggregateError && error.errors.some(containsFailure)) ||
    (error instanceof Error &&
      error.cause !== undefined &&
      containsFailure(error.cause));
  let finished = false;
  let cancelled = false;
  class Held extends ProbeCapability {
    clone() {
      return new Held(this.bindings);
    }
    async transformContext(context: ModelRequestContext) {
      entered.resolve(context.signal);
      await release.promise;
      finished = true;
      throw lateFailure;
    }
  }
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const session = await new Agent({ instructions: 'Root', provider }).session({
    environment: sourceFor([new Held([])], { cleanup }),
  });
  const turn = await session.submit('cancel');
  const result = turn.wait().catch((error) => error);
  let cancellation: Promise<unknown> | undefined;
  try {
    const signal = await entered.promise;
    cancellation = turn.cancel().then(
      () => {
        cancelled = true;
      },
      (error) => {
        cancelled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(cancelled).toBe(false);
    expect(finished).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    release.resolve();
    expect(containsFailure(await cancellation)).toBe(true);
    expect(finished).toBe(true);
    expect(await result).toBeInstanceOf(Error);
    expect(server.requests).toEqual([]);
  } finally {
    release.resolve();
    await cancellation;
    await result;
    const closed = await session.close().catch((error) => error);
    expect(containsFailure(closed)).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  }
});

it('has been joining a cancelled capability tool factory before retiring its resource', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const execute = vi.fn(() => 'late tool');
  const cleanup = vi.fn();
  const bindings: Bound[] = [];
  const controller = new AbortController();
  const reason = new Error('opening cancellation');
  let settled = false;
  class Factory extends ProbeCapability {
    clone() {
      return new Factory(this.bindings);
    }
    async tools() {
      entered.resolve();
      await release.promise;
      return [
        tool({
          name: 'late',
          description: 'Cancelled factory result',
          parameters: z.object({}),
          execute,
        }),
      ];
    }
  }
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const opening = new Agent({ instructions: 'Root', provider }).session({
    environment: sourceFor([new Factory(bindings)], { cleanup }),
    signal: controller.signal,
  });
  const observed = opening.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await entered.promise;
    controller.abort(reason);
    expect(settled).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      await readFile(
        join(
          bindings[0].sandbox.state.workspaceRootPath as string,
          'capability.txt',
        ),
        'utf8',
      ),
    ).toBe('prepared capability');
  } finally {
    release.resolve();
  }
  expect(await observed).toBe(reason);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(server.requests).toEqual([]);
});

it.each(['retained-resource', 'changed-policy'] as const)(
  'has been restoring idle capability callbacks only under the recorded executor authority: %s',
  async (kind) => {
    const bindings: Bound[] = [];
    let allocated = 0;
    const executions: string[] = [];
    let firstAccess: SandboxAccess | undefined;
    class Rebound extends ProbeCapability {
      serial = 0;
      clone() {
        return new Rebound(this.bindings);
      }
      bind(sandbox: SandboxSessionLike, user?: string) {
        this.serial = ++allocated;
        writeFileSync(
          join(sandbox.state.workspaceRootPath as string, 'capability.txt'),
          'resource-' + this.serial,
        );
        return super.bind(sandbox, user);
      }
      tools() {
        return [
          tool({
            name: 'current_resource',
            description: 'Read the current bound resource',
            parameters: z.object({}),
            execute: async (_args, context) => {
              firstAccess ??= context.sandbox;
              const value = (
                await context.sandbox!.exec({ cmd: 'cat capability.txt' })
              ).stdout;
              executions.push(this.serial + ':' + value);
              return value;
            },
          }),
        ];
      }
      samplingSettings(settings: ModelSettings): ModelSettings {
        return {
          metadata: { ...settings.metadata, opening: String(this.serial) },
        };
      }
      transformContext(context: ModelRequestContext) {
        return [
          ...context.items,
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'opening-' + this.serial }],
          },
        ];
      }
    }
    const server = new ModelServer([
      [call('current_resource', {}, { callId: 'first-resource' })],
      [message('first complete')],
      ...(kind === 'retained-resource'
        ? [
            [call('current_resource', {}, { callId: 'second-resource' })],
            [message('restored complete')],
          ]
        : []),
    ]);
    await using provider = await providerFor(server);
    const client = new UnixLocalSandboxClient();
    const borrowed =
      kind === 'retained-resource'
        ? await client.create({ manifest: new Manifest() })
        : undefined;
    const source = borrowed
      ? sandboxEnvironment({
          client,
          session: borrowed,
          manifest: new Manifest(),
          capabilities: [new Rebound(bindings)],
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
        })
      : sourceFor([new Rebound(bindings)]);
    try {
      const agent = new Agent({
        instructions: 'Read the bound resource',
        model: 'fixture-capability-restore',
        provider,
      });
      const first = await agent.session({ environment: source });
      let state;
      try {
        expect((await (await first.submit('first')).wait()).finalOutput).toBe(
          'first complete',
        );
        state = await first.saveState();
      } finally {
        await first.close();
      }
      await expect(
        firstAccess!.exec({ cmd: 'printf stale > capability.txt' }),
      ).rejects.toThrow();
      if (kind === 'changed-policy') {
        await expect(
          agent.session({ environment: source, state }),
        ).rejects.toThrow(
          'Restore requires the recorded executor write and network policy',
        );
        expect(executions).toEqual(['1:resource-1']);
        expect(server.requests).toHaveLength(2);
        server.assertExhausted();
        return;
      }
      await using restored = await agent.session({
        environment: source,
        state,
      });
      expect((await (await restored.submit('second')).wait()).finalOutput).toBe(
        'restored complete',
      );
      expect(executions).toEqual(['1:resource-1', '2:resource-2']);
      expect(bindings[0].sandbox).toBe(bindings[1].sandbox);
      expect(bindings[0].capability).not.toBe(bindings[1].capability);
      expect(server.requests[2].metadata).toMatchObject({ opening: '1' });
      expect(JSON.stringify(server.requests[2].input)).toContain('opening-2');
      expect(JSON.stringify(server.requests[3].input)).toContain('resource-2');
      server.assertExhausted();
    } finally {
      await borrowed?.close();
    }
  },
);

function ownedWorkspaceCallbacks(effects: string[]) {
  const editor: ApplyPatchEditor = {
    createFile: async (operation, context) => {
      effects.push('patch');
      return context.sandbox!.createEditor().createFile(operation, context);
    },
    updateFile: async (operation, context) => {
      effects.push('patch');
      return context.sandbox!.createEditor().updateFile(operation, context);
    },
    deleteFile: (operation, context) =>
      context.sandbox!.createEditor().deleteFile(operation, context),
  };
  return {
    patch: applyPatchTool({ editor }),
    shell: shellTool({
      execute: async (call: ShellCall, context: ToolContext) => {
        effects.push('shell');
        const output = [];
        for (const cmd of call.action.commands) {
          const result = await context.sandbox!.exec({ cmd, login: false });
          output.push({
            stdout: result.stdout,
            stderr: result.stderr,
            outcome:
              result.exitCode == null
                ? { type: 'timeout' as const }
                : { type: 'exit' as const, exit_code: result.exitCode },
          });
        }
        return { output };
      },
    }),
  };
}

it.each(['both', 'patch', 'shell'] as const)(
  'has been admitting owned capability workspace callbacks with existing declarations: %s',
  async (contribution) => {
    const effects: string[] = [];
    const bindings: Bound[] = [];
    const callbacks = ownedWorkspaceCallbacks(effects);
    class Workspace extends ProbeCapability {
      clone() {
        return new Workspace(bindings);
      }
      tools() {
        return contribution === 'both'
          ? [callbacks.patch, callbacks.shell]
          : [callbacks[contribution]];
      }
    }
    const patchFirst = contribution !== 'shell';
    const patch: JsonObject = {
      type: 'apply_patch_call',
      call_id: 'owned-patch',
      operation: patchFirst
        ? { type: 'create_file', path: 'result.txt', diff: '+owned-patch\n' }
        : {
            type: 'update_file',
            path: 'result.txt',
            diff: '@@\n-shell-owned\n+patched-after-shell\n',
          },
    };
    const shell: JsonObject = {
      type: 'shell_call',
      call_id: 'owned-shell',
      action: {
        commands: [
          patchFirst ? 'cat result.txt' : 'printf shell-owned > result.txt',
        ],
      },
    };
    const server = new ModelServer([
      [...(patchFirst ? [patch, shell] : [shell, patch])],
      [message('owned callbacks done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use the bound workspace callbacks.',
      provider,
      tools:
        contribution === 'both'
          ? []
          : [callbacks[contribution === 'patch' ? 'shell' : 'patch']],
    }).session({ environment: sourceFor([new Workspace(bindings)]) });
    expect(
      (await (await session.submit('Apply both operations.')).wait())
        .finalOutput,
    ).toBe('owned callbacks done');
    expect(effects).toEqual(
      patchFirst ? ['patch', 'shell'] : ['shell', 'patch'],
    );
    expect(
      await readFile(
        join(
          bindings[0].sandbox.state.workspaceRootPath as string,
          'result.txt',
        ),
        'utf8',
      ),
    ).toBe(patchFirst ? 'owned-patch' : 'patched-after-shell');
    expect(JSON.stringify(server.requests[1].input)).toContain('owned-patch');
    server.assertExhausted();
  },
);

it('has been holding a contributed Shell behind a later fatal automatic sibling', async () => {
  const effects: string[] = [];
  const bindings: Bound[] = [];
  const callbacks = ownedWorkspaceCallbacks(effects);
  class Workspace extends ProbeCapability {
    clone() {
      return new Workspace(bindings);
    }
    tools() {
      return [callbacks.shell];
    }
  }
  const server = new ModelServer([
    [
      {
        type: 'shell_call',
        call_id: 'must-not-mutate',
        action: { commands: ['printf forbidden > forbidden.txt'] },
      },
      call('fatal', {}, { callId: 'fatal-later' }),
    ],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the current callbacks.',
    provider,
    tools: [
      tool({
        name: 'fatal',
        parameters: z.object({}),
        errorFunction: null,
        execute: () => {
          effects.push('fatal');
          throw new Error('fatal automatic callback');
        },
      }),
    ],
  }).session({ environment: sourceFor([new Workspace(bindings)]) });
  await expect(
    (await session.submit('Run the batch.')).wait(),
  ).rejects.toThrow();
  expect(effects).toEqual(['fatal']);
  await expect(
    stat(
      join(
        bindings[0].sandbox.state.workspaceRootPath as string,
        'forbidden.txt',
      ),
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  server.assertExhausted();
});

it('has been preserving private opening direct-function admission after capability binding', async () => {
  const effects: string[] = [];
  const bindings: Bound[] = [];
  const callbacks = ownedWorkspaceCallbacks(effects);
  class Workspace extends ProbeCapability {
    clone() {
      return new Workspace(bindings);
    }
    tools() {
      return [callbacks.shell];
    }
  }
  vi.spyOn(privateOpening, 'privateOpeningContribution').mockReturnValue({
    beforeComplete: () => undefined,
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await expect(
    new Agent({ instructions: 'Use the current callbacks.', provider }).session(
      { environment: sourceFor([new Workspace(bindings)]) },
    ),
  ).rejects.toThrow(
    'Private opening contributions require a fresh root with eager direct function tools',
  );
  expect(effects).toEqual([]);
  expect(server.requests).toEqual([]);
});

it('has been preserving the default provider compaction policy with omitted capabilities', async () => {
  const server = new ModelServer([[message('Default policy completed.')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'fixture-default-capability-policy',
    instructions: 'Root',
  }).session({ environment: sourceFor(undefined) });
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'Default policy completed.',
  );
  expect(server.requests[0].context_management).toEqual([
    { type: 'compaction', compact_threshold: 240000 },
  ]);
  server.assertExhausted();
});

it.each([
  ['empty capabilities', [], undefined, undefined],
  ['explicit clear', undefined, { providerCompaction: null }, undefined],
  [
    'explicit static policy',
    undefined,
    { providerCompaction: { type: 'static', threshold: 1234 } },
    [{ type: 'compaction', compact_threshold: 1234 }],
  ],
  [
    'explicit context management',
    undefined,
    { contextManagement: [{ type: 'compaction', compact_threshold: 5678 }] },
    [{ type: 'compaction', compact_threshold: 5678 }],
  ],
] as const)(
  'has been respecting %s before default capability policy',
  async (_mode, capabilities, modelSettings, expected) => {
    const server = new ModelServer([[message('Policy completed.')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'fixture-default-capability-policy',
      instructions: 'Root',
      modelSettings,
    }).session({ environment: sourceFor(capabilities) });
    expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
      'Policy completed.',
    );
    expect(server.requests[0].context_management).toEqual(expected);
    server.assertExhausted();
  },
);

it('has been trimming actual provider compaction history under the omitted default', async () => {
  const server = new ModelServer([
    [message('OLD_DEFAULT_HISTORY_SENTINEL')],
    [
      { type: 'compaction', encrypted_content: 'OPAQUE_DEFAULT_COMPACTION' },
      message('CURRENT_DEFAULT_HISTORY_SENTINEL'),
    ],
    [message('Default history completed.')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'fixture-default-capability-policy',
    instructions: 'Root',
  }).session({ environment: sourceFor(undefined) });
  await (await session.submit('First.')).wait();
  await (await session.submit('Compact.')).wait();
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'Default history completed.',
  );
  const input = JSON.stringify(server.requests[2].input);
  expect(input).toContain('OPAQUE_DEFAULT_COMPACTION');
  expect(input).toContain('CURRENT_DEFAULT_HISTORY_SENTINEL');
  expect(input).not.toContain('OLD_DEFAULT_HISTORY_SENTINEL');
  server.assertExhausted();
});

it.each([
  ['default root to empty destination', undefined, [], undefined],
  [
    'empty root to default destination',
    [],
    undefined,
    [{ type: 'compaction', compact_threshold: expect.any(Number) }],
  ],
] as const)(
  'has been rebinding %s without inheriting another capability policy',
  async (_mode, rootCapabilities, targetCapabilities, expected) => {
    const server = new ModelServer([
      [
        call(
          'transfer_to_default_worker',
          {},
          { callId: 'default-policy-transfer' },
        ),
      ],
      [message('Destination policy completed.')],
    ]);
    await using provider = await providerFor(server);
    const worker = new Agent({
      name: 'default_worker',
      provider,
      model: 'gpt-5.5',
      instructions: 'Worker',
      environment: sourceFor(targetCapabilities),
    });
    const root = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Root',
      handoffs: [worker],
    });
    await using session = await root.session({
      environment: sourceFor(rootCapabilities),
    });
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'Destination policy completed.',
    );
    expect(server.requests[1].context_management).toEqual(expected);
    if (expected !== undefined) {
      const [policy] = server.requests[1].context_management as {
        compact_threshold: number;
      }[];
      expect(policy.compact_threshold).toBeGreaterThan(0);
    }
    server.assertExhausted();
  },
);

it('has been skipping only implicit default compaction on native Lite', async () => {
  const server = new ModelServer([[message('Lite default completed.')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'gpt-5.6-sol',
    instructions: 'Root',
  }).session({ environment: sourceFor(undefined) });
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'Lite default completed.',
  );
  expect(server.requests[0].context_management).toBeUndefined();
  server.assertExhausted();
});

it('has been keeping opaque Chat producers outside implicit Responses controls', async () => {
  let requests = 0;
  const client = new OpenAI({
    apiKey: 'fixture',
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body)) as JsonObject;
      expect(body.context_management).toBeUndefined();
      expect(body.sdk_default_provider_compaction).toBeUndefined();
      return Response.json({
        id: 'chat-default',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Chat default completed.' },
          },
        ],
      });
    },
  });
  await using provider = new NativeProvider({
    modelBackend: new ChatCompletionsModel(client, 'fixture-default-chat'),
    responseMode: 'buffered',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    provider,
    model: 'fixture-default-chat',
    instructions: 'Root',
  }).session({ environment: sourceFor(undefined) });
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'Chat default completed.',
  );
  expect(requests).toBe(1);
});

it.each([
  [
    'omitted defaults',
    undefined,
    undefined,
    [{ type: 'compaction', compact_threshold: 240000 }],
  ],
  ['explicit empty parent', [], undefined, undefined],
  [
    'explicit disabled child',
    undefined,
    { providerCompaction: null },
    undefined,
  ],
] as const)(
  'has been retaining %s through the captured configured-child opening',
  async (_mode, capabilities, childSettings, expected) => {
    const server = new ModelServer([
      [
        call(
          'default_delegate',
          { input: 'Child task.' },
          { callId: 'default-child-call' },
        ),
      ],
      [message('Child default completed.')],
      [message('Parent default completed.')],
    ]);
    await using provider = await providerFor(server);
    const child = new Agent({
      provider,
      model: 'fixture-default-child',
      instructions: 'Child',
      modelSettings: childSettings,
    });
    const root = new Agent({
      provider,
      model: 'fixture-default-parent',
      instructions: 'Parent',
      tools: [
        child.asTool({
          toolName: 'default_delegate',
          toolDescription: 'Run the captured child.',
        }),
      ],
    });
    await using session = await root.session({
      environment: sourceFor(capabilities),
    });
    expect((await (await session.submit('Delegate.')).wait()).finalOutput).toBe(
      'Parent default completed.',
    );
    expect(server.requests).toHaveLength(3);
    expect(server.requests[1].model).toBe('fixture-default-child');
    expect(server.requests[1].context_management).toEqual(expected);
    const rootDefault =
      capabilities === undefined
        ? [{ type: 'compaction', compact_threshold: 240000 }]
        : undefined;
    expect(server.requests[0].context_management).toEqual(rootDefault);
    expect(server.requests[2].context_management).toEqual(rootDefault);
    server.assertExhausted();
  },
);
