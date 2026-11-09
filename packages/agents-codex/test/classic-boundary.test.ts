import {
  Agent as ClassicAgent,
  MemorySession,
  RunContext,
  Runner as ClassicRunner,
  handoff,
  tool as classicTool,
  type Tool as ClassicTool,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '@openai/agents/classic/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Runner as NativeRunner } from '../src/runtime/public-agent';
import { NativeProvider } from '../src/runtime/provider';
import { manualTool } from '../src/runtime/manual';
import {
  createNamespacedFunctionTool,
  tool as functionTool,
  ToolOutput,
  type FunctionTool,
  type Tool,
} from '../src/runtime/tools';

// These host-only checks stop at provider acquisition. Keep only the native
// declaration preflight validators; the native suite covers their implementation.
vi.mock('../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/binding')>()),
  binding: async () => ({
    _validate_python_tool_declarations: () => undefined,
    _validate_application_instructions: () => undefined,
  }),
}));

const nativeLoad = vi.hoisted(() => vi.fn());
vi.mock('../native/index.js', () => {
  nativeLoad();
  throw new Error('Host-only boundary test attempted to load the native addon');
});

describe('Classic declaration boundaries', () => {
  const nativeTool = () =>
    functionTool({
      name: 'native_only',
      parameters: z.object({}),
      execute: () => 'native',
    });

  it.each([
    ['function', nativeTool],
    [
      'manual',
      () =>
        manualTool({
          name: 'native_manual',
          description: 'A native manual declaration.',
          parameters: z.object({}),
          result: z.string(),
        }),
    ],
  ])(
    'rejects a native %s declaration in a Classic constructor',
    (_name, create) => {
      expect(
        () =>
          new ClassicAgent({
            name: 'classic',
            tools: [create() as unknown as ClassicTool],
          }),
      ).toThrow('Classic tools');
    },
  );

  it('rejects a native handoff target in a Classic constructor', () => {
    const { provider, acquire } = openingProbe();
    const native = new Agent({ instructions: 'Native.', provider });
    expect(
      () =>
        new ClassicAgent({
          name: 'classic',
          handoffs: [native as unknown as ClassicAgent],
        }),
    ).toThrow('Classic agents and handoffs');
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rejects mutated tools before effects (stream=%s)',
    async (stream) => {
      const model = new ScriptedModel([
        modelResponse([assistantMessage('should not execute')]),
      ]);
      const instructions = vi.fn(() => 'Classic.');
      const execute = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: null,
      }));
      const agent = new ClassicAgent({
        name: 'classic',
        model,
        instructions,
        inputGuardrails: [{ name: 'observe', execute }],
      });
      agent.tools.push(nativeTool() as unknown as ClassicTool);
      const memory = new MemorySession();
      const read = vi.spyOn(memory, 'getItems');
      const write = vi.spyOn(memory, 'addItems');
      const mcp = vi.spyOn(agent, 'getMcpTools');
      const runner = new ClassicRunner({ tracingDisabled: true });
      const result = stream
        ? runner.run(agent, 'hello', { stream: true, session: memory })
        : runner.run(agent, 'hello', { session: memory });
      await expect(result).rejects.toThrow('Classic tools');
      expect(model.calls).toHaveLength(0);
      for (const effect of [instructions, execute, read, write, mcp])
        expect(effect).not.toHaveBeenCalled();
    },
  );

  it('checks mutated cyclic handoff graphs before memory access', async () => {
    const { provider, acquire } = openingProbe();
    const native = new Agent({ instructions: 'Native.', provider });
    const first = new ClassicAgent({ name: 'first' });
    const second = new ClassicAgent({ name: 'second', handoffs: [first] });
    first.handoffs.push(handoff(second));
    second.handoffs.push(native as unknown as ClassicAgent);
    const memory = new MemorySession();
    const read = vi.spyOn(memory, 'getItems');
    await expect(
      new ClassicRunner({ tracingDisabled: true }).run(first, 'hello', {
        session: memory,
      }),
    ).rejects.toThrow('Classic agents and handoffs');
    expect(read).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('checks direct tool collection before MCP and enabled callbacks', async () => {
    const isEnabled = vi.fn(async () => true);
    const agent = new ClassicAgent({
      name: 'classic',
      tools: [
        classicTool({
          name: 'valid',
          description: 'A valid Classic declaration.',
          parameters: z.object({}),
          execute: () => 'ok',
          isEnabled,
        }),
      ],
    });
    agent.tools.push(nativeTool() as unknown as ClassicTool);
    const mcp = vi.spyOn(agent, 'getMcpTools');
    await expect(agent.getAllTools(new RunContext())).rejects.toThrow(
      'Classic tools',
    );
    expect(mcp).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('preserves Classic subclasses, custom tools, and cyclic handoffs', async () => {
    class CustomAgent extends ClassicAgent {
      initialized = true;
    }
    Object.defineProperty(CustomAgent.prototype, 'getAllTools', {
      get(this: CustomAgent) {
        if (!this.initialized) throw new Error('Subclass is not initialized');
        return ClassicAgent.prototype.getAllTools;
      },
    });
    const invoke = vi.fn(async () => 'custom result');
    const model = new ScriptedModel([
      modelResponse([functionCall('custom', {}, { callId: 'custom_call' })]),
      modelResponse([assistantMessage('completed')]),
    ]);
    const agent = new CustomAgent({
      name: 'custom',
      model,
      tools: [
        {
          type: 'function',
          name: 'custom',
          description: 'A structural Classic tool.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
          strict: true,
          needsApproval: async () => false,
          isEnabled: async () => true,
          invoke,
        },
      ],
    });
    agent.handoffs.push(handoff(agent));
    const result = await new ClassicRunner({ tracingDisabled: true }).run(
      agent,
      'hello',
    );
    expect(result.finalOutput).toBe('completed');
    expect(model.calls).toHaveLength(2);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('rejects either runtime Agent in the other Runner before opening resources', async () => {
    const { provider, acquire } = openingProbe();
    const native = new Agent({ instructions: 'Native.', provider });
    const classic = new ClassicAgent({ name: 'classic' });
    const memory = new MemorySession();
    const read = vi.spyOn(memory, 'getItems');
    await expect(
      new ClassicRunner({ tracingDisabled: true }).run(
        native as unknown as ClassicAgent,
        'hello',
        { session: memory },
      ),
    ).rejects.toThrow('Classic agents and handoffs');
    expect(() =>
      NativeRunner.run(classic as unknown as Agent, 'hello'),
    ).toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  expect(nativeLoad).not.toHaveBeenCalled();
});

function openingProbe() {
  const provider = new NativeProvider({ apiKey: 'synthetic-test-key' });
  const acquire = vi.spyOn(provider, '_acquire').mockImplementation(() => {
    throw new Error('provider opening reached');
  });
  return { provider, acquire };
}

describe('native and Classic tool boundaries', () => {
  it('rejects a Classic tool before opening provider resources', async () => {
    const { provider, acquire } = openingProbe();
    const execute = vi.fn(() => 'legacy output');
    const legacy = classicTool({
      name: 'legacy',
      description: 'A retained Classic tool.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute,
    });
    const agent = new Agent({
      instructions: 'Use native declarations.',
      provider,
      tools: [legacy as unknown as FunctionTool],
    });

    await expect(agent.session()).rejects.toThrow('Native function tools');
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      'native',
      () =>
        functionTool({
          name: 'native',
          description: 'A native function.',
          parameters: z.object({}),
          execute: () => 'native output',
        }),
    ],
    [
      'captured native',
      () => ({
        ...functionTool({
          name: 'captured',
          description: 'A copied native declaration.',
          parameters: z.object({}),
          execute: () => 'native output',
        }),
      }),
    ],
    [
      'manual',
      () =>
        manualTool({
          name: 'manual',
          description: 'A manual declaration.',
          parameters: z.object({}),
          result: z.string(),
        }),
    ],
    [
      'borrowed MCP',
      () =>
        createNamespacedFunctionTool({
          namespace: { name: 'borrowed' },
          name: 'mcp',
          description: 'A borrowed MCP declaration.',
          parameters: { type: 'object', properties: {} },
          execute: async () => new ToolOutput([]),
        }),
    ],
  ] satisfies [string, () => Tool][])(
    'preserves opening for %s declarations',
    async (_name, declaration) => {
      const { provider, acquire } = openingProbe();
      const agent = new Agent({
        instructions: 'Use native declarations.',
        provider,
        tools: [declaration()],
      });

      await expect(agent.session()).rejects.toThrow('provider opening reached');
      expect(acquire).toHaveBeenCalledOnce();
    },
  );
});
