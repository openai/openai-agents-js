import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  NativeAgents,
  NativeProvider,
  StdioMCP,
  checklist,
  manualTool,
  nativeGoals,
  tool,
} from '../../src';
import * as nativeBinding from '../../src/runtime/binding';

afterEach(() => vi.restoreAllMocks());

const lookup = () =>
  tool({ name: 'lookup', parameters: z.object({}), execute: () => 'unused' });

describe('offline Agent declaration validation', () => {
  it('checks real native declarations without a provider, engine, discovery or callbacks', async () => {
    const native = await nativeBinding.binding();
    const engine = vi.spyOn(native, 'create_engine');
    const provider = new NativeProvider();
    await provider.close();
    const acquire = vi.spyOn(provider, '_acquire');
    const execute = vi.fn(() => 'unused');
    const parseInput = vi.fn(() => true);
    const parseOutput = vi.fn(() => true);
    const agent = new Agent({
      instructions: 'Validate declarations only.',
      provider,
      outputType: z.object({ answer: z.string() }).refine(parseOutput),
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({ key: z.string() }).refine(parseInput),
          execute,
        }),
        manualTool({
          name: 'approval',
          description: 'Supply an approval.',
          parameters: z.object({}),
          result: z.boolean(),
        }),
        new HttpMCP({
          name: 'offline_http',
          tools: ['lookup'],
          url: 'http://127.0.0.1:1/mcp',
        }),
        new StdioMCP({
          name: 'offline_stdio',
          tools: ['lookup'],
          command: '/nonexistent/agent-validation-mcp',
        }),
      ],
    });
    Object.defineProperty(agent, 'provider', {
      get() {
        throw new Error('Validation must not read the provider');
      },
    });

    const validation = agent.validate();
    expectTypeOf(validation).toEqualTypeOf<Promise<void>>();
    await expect(validation).resolves.toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
    expect(engine).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(parseInput).not.toHaveBeenCalled();
    expect(parseOutput).not.toHaveBeenCalled();
  });

  it('captures default tools, nested declarations and output before addon loading yields', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const binding = nativeBinding.binding;
    vi.spyOn(nativeBinding, 'binding').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return binding();
    });
    const parameters = { type: 'object', properties: {} };
    const agent = new Agent<undefined, unknown>({
      instructions: 'Validate the captured defaults.',
      tools: [{ ...lookup(), parameters }],
      outputType: z.object({ answer: z.string() }),
    });
    const validation = agent.validate();
    try {
      await entered.promise;
      parameters.type = 'null';
      agent.tools = [{ ...lookup(), name: 'exec_command' }];
      agent.outputType = z.unknown();
    } finally {
      release.resolve();
      await expect(validation).resolves.toBeUndefined();
    }
    await expect(agent.validate()).rejects.toThrow();
  });

  it('checks defaults without requiring Session context or NativeAgents destination prerequisites', async () => {
    const agent = new Agent<{ tenant: string }>({
      instructions: 'Validate defaults without opening.',
      tools: [new NativeAgents()],
    });
    const acquire = vi.spyOn(agent.provider, '_acquire');
    await expect(agent.validate()).resolves.toBeUndefined();
    await expect(
      agent.session({ context: { tenant: 'fixture' } }),
    ).rejects.toThrow('NativeAgents requires an Environment');
    expect(acquire).not.toHaveBeenCalled();
    await agent.provider.close();
  });

  it.each([
    { kind: 'function', declaration: { ...lookup(), name: 'update_plan' } },
    {
      kind: 'manual',
      declaration: manualTool({
        name: 'update_plan',
        description: 'Supply the application update.',
        parameters: z.object({}),
        result: z.string(),
      }),
    },
  ])(
    'allows an ordinary $kind update_plan without Checklist',
    async ({ declaration }) => {
      const provider = new NativeProvider();
      await provider.close();
      const agent = new Agent({
        instructions: 'Validate the application declaration.',
        provider,
        tools: [declaration],
      });
      await expect(agent.validate()).resolves.toBeUndefined();
      // Opening must pass declaration checks and reach provider acquisition.
      await expect(agent.session()).rejects.toThrow('NativeProvider is closed');
    },
  );

  it('allows an application create_goal when NativeGoals is absent', async () => {
    const provider = new NativeProvider();
    await provider.close();
    const agent = new Agent({
      instructions: 'Use the application goal tool.',
      provider,
      tools: [{ ...lookup(), name: 'create_goal' }],
    });
    await expect(agent.validate()).resolves.toBeUndefined();
    await expect(agent.session()).rejects.toThrow('NativeProvider is closed');
  });

  it('allows distinct function and MCP identities in the same projected namespace', async () => {
    const provider = new NativeProvider();
    await provider.close();
    const agent = new Agent({
      instructions: 'Validate distinct tools offline.',
      provider,
      tools: [
        { ...lookup(), namespace: 'mcp__records', name: 'other' },
        new HttpMCP({
          name: 'records',
          tools: ['lookup'],
          url: 'http://127.0.0.1:1/mcp',
        }),
      ],
    });
    await expect(agent.validate()).resolves.toBeUndefined();
    await expect(agent.session()).rejects.toThrow('NativeProvider is closed');
  });

  it('validates each handoff profile without merging its identities with other profiles', async () => {
    const target = new Agent({
      name: 'Target',
      instructions: 'Read a record.',
      tools: [
        new HttpMCP({
          name: 'records',
          tools: ['lookup'],
          url: 'http://127.0.0.1:1/mcp',
        }),
      ],
    });
    const agent = new Agent({
      instructions: 'Delegate when needed.',
      tools: [{ ...lookup(), namespace: 'mcp__records' }],
      handoffs: [target],
    });
    await expect(agent.validate()).resolves.toBeUndefined();
    await agent.provider.close();
    await expect(agent.session()).rejects.toThrow('NativeProvider is closed');
    target.tools = [
      ...target.tools,
      { ...lookup(), namespace: 'mcp__records' },
    ];
    await expect(agent.validate()).rejects.toThrow(
      'Duplicate selected tool mcp__records.lookup',
    );
    await expect(agent.session()).rejects.toThrow(
      'Duplicate selected tool mcp__records.lookup',
    );
    await agent.provider.close();
    await target.provider.close();
  });

  const invalidDefaults = [
    {
      name: 'function and projected MCP identity collision',
      make: () => ({
        tools: [
          { ...lookup(), namespace: 'mcp__records' },
          new HttpMCP({
            name: 'records',
            tools: ['lookup'],
            url: 'http://127.0.0.1:1/mcp',
          }),
        ],
      }),
    },
    {
      name: 'NativeGoals and application create_goal collision',
      make: () => ({
        tools: [nativeGoals(), { ...lookup(), name: 'create_goal' }],
      }),
    },
    {
      name: 'reserved native name',
      make: () => ({ tools: [{ ...lookup(), name: 'exec_command' }] }),
    },
    {
      name: 'duplicate function name',
      make: () => ({ tools: [lookup(), lookup()] }),
    },
    {
      name: 'invalid native parameter schema',
      make: () => ({ tools: [{ ...lookup(), parameters: { type: 'null' } }] }),
    },
    {
      name: 'unsupported strict output schema',
      make: () => ({ outputType: z.record(z.string(), z.string()) }),
    },
    {
      name: 'colliding projected MCP namespaces',
      make: () => ({
        tools: ['team-a', 'team_a'].map(
          (name) =>
            new HttpMCP({
              name,
              tools: ['lookup'],
              url: 'http://127.0.0.1:1/mcp',
            }),
        ),
      }),
    },
    {
      name: 'duplicate NativeAgents declaration',
      make: () => ({ tools: [new NativeAgents(), new NativeAgents()] }),
    },
    {
      name: 'Checklist and function update_plan collision',
      make: () => ({
        tools: [checklist(), { ...lookup(), name: 'update_plan' }],
      }),
    },
    {
      name: 'Checklist and manual update_plan collision',
      make: () => ({
        tools: [
          checklist(),
          manualTool({
            name: 'update_plan',
            description: 'Supply the application update.',
            parameters: z.object({}),
            result: z.string(),
          }),
        ],
      }),
    },
  ];

  it.each(invalidDefaults)(
    'agrees with opening on isolated invalid defaults: $name',
    async ({ make }) => {
      const agent = new Agent<undefined, unknown>({
        instructions: 'Reject before opening resources.',
        ...make(),
      });
      const acquire = vi.spyOn(agent.provider, '_acquire');
      let validationError: unknown;
      try {
        await agent.validate();
      } catch (error) {
        validationError = error;
      }
      expect(validationError).toBeInstanceOf(Error);
      if (!(validationError instanceof Error))
        throw new Error('Expected declaration validation to reject');
      await expect(agent.session()).rejects.toMatchObject({
        name: validationError.name,
        message: validationError.message,
      });
      expect(acquire).not.toHaveBeenCalled();
      await agent.provider.close();
    },
  );
});
