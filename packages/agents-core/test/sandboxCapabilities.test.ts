import { describe, expect, it } from 'vitest';
import {
  Capabilities,
  CompactionModelInfo,
  compaction,
  Manifest,
  memory,
  SandboxAgent,
  shell,
  StaticCompactionPolicy,
} from '../src/sandbox';

describe('Compaction', () => {
  it('uses a static threshold when configured', () => {
    const capability = compaction({
      policy: new StaticCompactionPolicy(123),
    });

    expect(capability.samplingParams({})).toEqual({
      context_management: [
        {
          type: 'compaction',
          compact_threshold: 123,
        },
      ],
    });
  });

  it('accepts provider-prefixed and pinned model ids', () => {
    const capability = compaction();

    expect(
      capability.samplingParams({ model: 'openai/gpt-5-mini' }),
    ).toMatchObject({
      context_management: [
        {
          type: 'compaction',
          compact_threshold: 360000,
        },
      ],
    });
    expect(
      capability.samplingParams({ model: 'gpt-5-2025-08-07' }),
    ).toMatchObject({
      context_management: [
        {
          type: 'compaction',
          compact_threshold: 360000,
        },
      ],
    });
  });

  it('tracks Python sandbox model context windows for compaction', () => {
    expect(CompactionModelInfo.forModel('o1-pro')?.contextWindow).toBe(200000);
    expect(CompactionModelInfo.forModel('o3-mini')?.contextWindow).toBe(200000);
    expect(CompactionModelInfo.forModel('o3-pro')?.contextWindow).toBe(200000);
    expect(
      CompactionModelInfo.forModel('o3-deep-research')?.contextWindow,
    ).toBe(200000);
    expect(
      CompactionModelInfo.forModel('o4-mini-deep-research')?.contextWindow,
    ).toBe(200000);
  });

  it('falls back to the static threshold for unknown models', () => {
    const capability = compaction();

    expect(
      capability.samplingParams({ model: 'custom-provider/future-model' }),
    ).toEqual({
      context_management: [
        {
          type: 'compaction',
          compact_threshold: 240000,
        },
      ],
    });
  });

  it('keeps items from the last compaction item onward', () => {
    const capability = compaction();
    const context = [
      { type: 'message', role: 'user', content: 'old-1' },
      { type: 'compaction', summary: 'first' },
      { type: 'message', role: 'assistant', content: 'between' },
      { type: 'compaction', summary: 'second' },
      { type: 'message', role: 'assistant', content: 'latest' },
    ] as any[];

    expect(capability.processContext(context)).toEqual(context.slice(3));
  });

  it('returns the original context when there is no compaction item', () => {
    const capability = compaction();
    const context = [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'world' },
    ] as any[];

    expect(capability.processContext(context)).toEqual(context);
  });
});

describe('SandboxAgent', () => {
  it('exposes the Python-compatible default capabilities helper', () => {
    const defaults = Capabilities.default();

    expect(defaults.map((capability) => capability.type)).toEqual([
      'filesystem',
      'shell',
      'compaction',
    ]);
    expect(Capabilities.default()[0]).not.toBe(defaults[0]);
  });

  it('defaults to filesystem, shell, and compaction capabilities', () => {
    const agent = new SandboxAgent({
      name: 'sandbox',
    });

    expect(agent.capabilities.map((capability) => capability.type)).toEqual([
      'filesystem',
      'shell',
      'compaction',
    ]);
  });

  it('clones sandbox-specific options and protects default manifests', () => {
    const defaultManifest = new Manifest({
      entries: {
        'seed.txt': {
          type: 'file',
          content: 'seed',
        },
      },
    });
    const capability = compaction({
      policy: new StaticCompactionPolicy(123),
    });
    const agent = new SandboxAgent({
      name: 'original',
      instructions: 'original instructions',
      defaultManifest,
      baseInstructions: 'base instructions',
      capabilities: [capability],
      runAs: 'sandbox-user',
    });

    (defaultManifest.entries['seed.txt'] as { content: string }).content =
      'mutated';
    const fallbackClone = agent.clone({});
    const overrideClone = agent.clone({
      name: 'override',
      defaultManifest: new Manifest({
        entries: {
          'override.txt': {
            type: 'file',
            content: 'override',
          },
        },
      }),
      baseInstructions: 'override base',
      capabilities: [shell()],
      runAs: 'other-user',
    });

    expect(
      (agent.defaultManifest?.entries['seed.txt'] as { content: string })
        .content,
    ).toBe('seed');
    expect(fallbackClone).not.toBe(agent);
    expect(fallbackClone.name).toBe('original');
    expect(fallbackClone.baseInstructions).toBe('base instructions');
    expect(fallbackClone.runAs).toBe('sandbox-user');
    expect(fallbackClone.defaultManifest).not.toBe(agent.defaultManifest);
    expect(fallbackClone.capabilities).toEqual([capability]);
    expect(overrideClone.name).toBe('override');
    expect(overrideClone.baseInstructions).toBe('override base');
    expect(overrideClone.runAs).toBe('other-user');
    expect(overrideClone.capabilities.map((item) => item.type)).toEqual([
      'shell',
    ]);
    expect(overrideClone.defaultManifest?.entries).toHaveProperty(
      'override.txt',
    );
  });

  it('clones default manifest environments without recursive resolvers', async () => {
    const agent = new SandboxAgent({
      name: 'sandbox',
      defaultManifest: new Manifest({
        environment: {
          STATIC_VALUE: 'static',
          DYNAMIC_VALUE: {
            value: 'fallback',
            resolve: () => 'dynamic',
          },
          SECRET_VALUE: {
            value: 'secret',
            ephemeral: true,
          },
        },
      }),
    });

    await expect(agent.defaultManifest?.resolveEnvironment()).resolves.toEqual({
      STATIC_VALUE: 'static',
      DYNAMIC_VALUE: 'dynamic',
      SECRET_VALUE: 'secret',
    });
    expect(agent.defaultManifest?.environment.SECRET_VALUE.ephemeral).toBe(
      true,
    );
  });

  it('accepts default manifest instances and init objects', () => {
    const instanceManifest = new Manifest({
      entries: {
        'instance.txt': {
          type: 'file',
          content: 'instance',
        },
      },
    });
    const initManifest = {
      entries: {
        'init.txt': {
          type: 'file' as const,
          content: 'init',
        },
      },
    };
    const instanceAgent = new SandboxAgent({
      name: 'instance',
      defaultManifest: instanceManifest,
    });
    const initAgent = new SandboxAgent({
      name: 'init',
      defaultManifest: initManifest,
    });

    (instanceManifest.entries['instance.txt'] as { content: string }).content =
      'mutated-instance';
    (initManifest.entries['init.txt'] as { content: string }).content =
      'mutated-init';

    expect(instanceAgent.defaultManifest).toBeInstanceOf(Manifest);
    expect(initAgent.defaultManifest).toBeInstanceOf(Manifest);
    expect(
      (
        instanceAgent.defaultManifest?.entries['instance.txt'] as {
          content: string;
        }
      ).content,
    ).toBe('instance');
    expect(
      (initAgent.defaultManifest?.entries['init.txt'] as { content: string })
        .content,
    ).toBe('init');
  });

  it('accepts typed runAs users', () => {
    const agent = new SandboxAgent({
      name: 'sandbox',
      runAs: { name: ' sandbox-user ' },
    });

    expect(agent.runAs).toEqual({ name: 'sandbox-user' });
  });
});

describe('Memory', () => {
  it('adds Python-compatible memory instructions and required capabilities', () => {
    const capability = memory({
      read: { liveUpdate: true },
      generate: { enabled: true, model: 'gpt-5.4-mini' },
      layout: {
        directory: 'memories',
        summaryFile: 'memory_summary.md',
      },
    });

    expect([...capability.requiredCapabilityTypes()].sort()).toEqual([
      'filesystem',
      'shell',
    ]);
    expect(capability.layout).toMatchObject({
      memoriesDir: 'memories',
      sessionsDir: 'sessions',
      summaryFile: 'memory_summary.md',
    });
    expect(capability.generate).toMatchObject({
      enabled: true,
      phaseOneModel: 'gpt-5.4-mini',
      phaseTwoModel: 'gpt-5.4-mini',
    });
  });

  it('matches Python memory defaults and validation', () => {
    const capability = memory();

    expect([...capability.requiredCapabilityTypes()].sort()).toEqual([
      'filesystem',
      'shell',
    ]);
    expect(capability.read).toEqual({ enabled: true, liveUpdate: true });
    expect(capability.generate).toMatchObject({
      enabled: true,
      maxRawMemoriesForConsolidation: 256,
      phaseOneModel: 'gpt-5.4-mini',
      phaseTwoModel: 'gpt-5.4',
    });
    expect(() => memory({ read: false, generate: false })).toThrow(
      'Memory requires at least one of `read` or `generate`.',
    );
    expect(() => memory({ layout: { memoriesDir: '../memories' } })).toThrow(
      'layout.memoriesDir',
    );
    expect(() =>
      memory({
        generate: { maxRawMemoriesForConsolidation: 4097 },
      }),
    ).toThrow(
      'MemoryGenerateConfig.maxRawMemoriesForConsolidation must be an integer between 1 and 4096.',
    );
  });

  it('rejects known snake_case memory config aliases', () => {
    const cases: Array<{ args: unknown; key: string }> = [
      {
        args: { read: { live_update: false } },
        key: 'live_update',
      },
      {
        args: {
          generate: { max_raw_memories_for_consolidation: 128 },
        },
        key: 'max_raw_memories_for_consolidation',
      },
      {
        args: { generate: { phase_one_model: 'gpt-5.4-mini' } },
        key: 'phase_one_model',
      },
      {
        args: { generate: { phase_one_model_settings: {} } },
        key: 'phase_one_model_settings',
      },
      {
        args: { generate: { phase_two_model: 'gpt-5.4' } },
        key: 'phase_two_model',
      },
      {
        args: { generate: { phase_two_model_settings: {} } },
        key: 'phase_two_model_settings',
      },
      {
        args: { generate: { extra_prompt: 'Prefer concise memories.' } },
        key: 'extra_prompt',
      },
      {
        args: { layout: { memories_dir: 'memories' } },
        key: 'memories_dir',
      },
      {
        args: { layout: { sessions_dir: 'sessions' } },
        key: 'sessions_dir',
      },
      {
        args: { layout: { summary_file: 'memory_summary.md' } },
        key: 'summary_file',
      },
    ];

    for (const { args, key } of cases) {
      expect(() => memory(args as any)).toThrow(
        `snake_case key "${key}" is not supported`,
      );
    }
  });

  it('materializes memory directories only when writes can occur', () => {
    const writable = memory();
    const readOnly = memory({
      read: { liveUpdate: false },
      generate: false,
    });
    const manifest = new Manifest();
    const readOnlyManifest = new Manifest();

    expect(writable.processManifest(manifest).entries).toMatchObject({
      memories: { type: 'dir' },
      sessions: { type: 'dir' },
    });
    expect(readOnly.processManifest(readOnlyManifest).entries).toEqual({});
  });

  it('renders memory read prompts from the sandbox summary file', async () => {
    const capability = memory({ generate: false }).bind({
      state: { manifest: new Manifest() },
      pathExists: async (path: string) => path === 'memories/memory_summary.md',
      readFile: async () =>
        new TextEncoder().encode('Use pnpm for package commands.'),
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain('========= MEMORY_SUMMARY BEGINS =========');
    expect(instructions).toContain('Use pnpm for package commands.');
    expect(instructions).toContain(
      'Memory is writable. You are authorized to edit memories/MEMORY.md',
    );
  });

  it('omits memory read prompts when no summary exists', async () => {
    const capability = memory({ generate: false }).bind({
      state: { manifest: new Manifest() },
      pathExists: async () => false,
      readFile: async () => {
        throw new Error('must not be called');
      },
    });

    await expect(capability.instructions(new Manifest())).resolves.toBeNull();
  });

  it('can read memory summaries through shell-only sessions', async () => {
    const capability = memory({
      read: { liveUpdate: false },
      generate: false,
    }).bind({
      state: { manifest: new Manifest() },
      execCommand: async () =>
        [
          'Chunk ID: abc123',
          'Wall time: 0.0001 seconds',
          'Process exited with code 0',
          'Output:',
          '__OPENAI_AGENTS_MEMORY_SUMMARY_BEGIN__',
          'Remember to run node --test.',
          '__OPENAI_AGENTS_MEMORY_SUMMARY_END__',
        ].join('\n'),
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain('Remember to run node --test.');
    expect(instructions).toContain(
      'Never update memories. You can only read them.',
    );
  });
});
