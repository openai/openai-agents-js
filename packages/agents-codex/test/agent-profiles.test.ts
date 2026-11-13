import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NativeProvider } from '../src/runtime/provider';
import { Agent, captureAgentProfiles } from '../src/runtime/public-agent';
import { tool } from '../src/runtime/tools';
import { NativeAgents } from '../src/runtime/native-agents';
import { HttpMCP } from '../src/runtime/mcp';

it('captures cyclic Agent identity and resolves each synchronous target once', () => {
  const toB = vi.fn<() => Agent>(() => b);
  const a: Agent = new Agent({
    name: 'A',
    instructions: 'Original A',
    handoffs: [toB, toB],
  });
  const b: Agent = new Agent({
    name: 'B',
    instructions: 'Original B',
    handoffs: [() => a],
  });
  const profiles = captureAgentProfiles(a);
  expect(toB).toHaveBeenCalledOnce();
  expect(profiles.map((profile) => profile.agent)).toEqual([a, b]);
  expect({ ...profiles[0].handoffs }).toEqual({ transfer_to_b: 'agent_1' });
  expect({ ...profiles[1].handoffs }).toEqual({ transfer_to_a: 'agent_0' });
  a.instructions = 'changed';
  a.handoffs = [];
  expect(profiles[0].declaration.instructions).toBe('Original A');
  expect(profiles[0].declaration.handoffs).toHaveLength(2);
  expect(Object.isFrozen(profiles)).toBe(true);
  expect(Object.isFrozen(profiles[0].declaration)).toBe(true);
  expect(Object.isFrozen(profiles[0].handoffs)).toBe(true);
});

it('preserves distinct validators and retry policies when output wire encoding matches', () => {
  const b = new Agent({
    name: 'B',
    instructions: 'B',
    outputType: {
      mode: 'prompted',
      schema: z.string().refine((text) => text === 'accepted'),
      maxRetries: 2,
    },
  });
  const a = new Agent({
    name: 'A',
    instructions: 'A',
    outputType: { mode: 'prompted', schema: z.string(), maxRetries: 0 },
    handoffs: [b],
  });
  const profiles = captureAgentProfiles(a);
  expect(profiles).toHaveLength(2);
  expect(profiles[0].declaration.outputType).not.toBe(
    profiles[1].declaration.outputType,
  );
});

it('captures mixed text outputs and retains Realtime and child-role admission', () => {
  const plain = new Agent({ name: 'plain', instructions: 'x' });
  const prompted = new Agent({
    name: 'prompted',
    instructions: 'x',
    outputType: { mode: 'prompted', schema: z.string() },
    handoffs: [plain],
  });
  expect(captureAgentProfiles(prompted)).toHaveLength(2);
  expect(() =>
    captureAgentProfiles(prompted, prompted, true, undefined, undefined, true),
  ).toThrow('share output mode');
  const different = new Agent({
    name: 'different',
    instructions: 'x',
    outputType: { mode: 'prompted', schema: z.number() },
  });
  const root = new Agent({
    instructions: 'root',
    outputType: { mode: 'prompted', schema: z.string() },
    handoffs: [different as never],
  });
  expect(captureAgentProfiles(root)).toHaveLength(2);
  expect(() =>
    captureAgentProfiles(root, root, true, undefined, undefined, true),
  ).toThrow('share output mode');
  const child = new Agent({
    name: 'child',
    instructions: 'x',
    tools: [new NativeAgents({ maxDepth: 2 })],
  });
  expect(() =>
    captureAgentProfiles(
      new Agent({ instructions: 'root', handoffs: [child] }),
    ),
  ).toThrow('child-role');
});

it('rejects asynchronous or invalid resolvers, unnamed targets and ambiguous generated names', () => {
  expect(() =>
    captureAgentProfiles(
      new Agent({
        instructions: 'x',
        handoffs: [
          (() => Promise.resolve(new Agent({ instructions: 'x' }))) as never,
        ],
      }),
    ),
  ).toThrow('synchronous');
  expect(() =>
    captureAgentProfiles(
      new Agent({
        instructions: 'x',
        handoffs: [(() => ({ name: 'fake' })) as never],
      }),
    ),
  ).toThrow('native Agent');
  expect(() =>
    captureAgentProfiles(
      new Agent({
        instructions: 'x',
        handoffs: [new Agent({ instructions: 'x' })],
      }),
    ),
  ).toThrow('nonempty Agent.name');
  const a = new Agent({ name: 'same name', instructions: 'a' });
  const b = new Agent({ name: 'same_name', instructions: 'b' });
  expect(() =>
    captureAgentProfiles(new Agent({ instructions: 'x', handoffs: [a, b] })),
  ).toThrow('Duplicate handoff name');
});

it('rejects generated handoff/tool collisions and output views that silently replace an outgoing graph', () => {
  const b = new Agent({ name: 'B', instructions: 'b' });
  const collision = tool({
    name: 'transfer_to_b',
    parameters: z.object({}),
    execute: () => '',
  });
  const a = new Agent({ instructions: 'a', tools: [collision], handoffs: [b] });
  expect(() => captureAgentProfiles(a)).toThrow('conflicts with declared tool');
  expect(() => a.withOutputType(z.string())).toThrow(
    'without outgoing handoffs',
  );
});

it.each([
  tool({
    name: 'transfer_to_b',
    namespace: 'records',
    parameters: z.object({}),
    execute: () => '',
  }),
  new HttpMCP({
    name: 'transfer_to_b',
    url: 'https://mcp.example.test',
    tools: ['lookup'],
  }),
])(
  'allows distinct tool identities alongside a generated handoff: %s',
  (declaration) => {
    const b = new Agent({ name: 'B', instructions: 'b' });
    const a = new Agent({
      instructions: 'a',
      tools: [declaration],
      handoffs: [b],
    });
    const profiles = captureAgentProfiles(a);
    expect({ ...profiles[0].handoffs }).toEqual({ transfer_to_b: 'agent_1' });
    expect(profiles[0].declaration.tools[0]).toMatchObject({
      name: 'transfer_to_b',
    });
  },
);

it('rejects an explicit functions namespace collision with a generated handoff', () => {
  const b = new Agent({ name: 'B', instructions: 'b' });
  const a = new Agent({
    instructions: 'a',
    tools: [
      tool({
        name: 'transfer_to_b',
        namespace: 'functions',
        parameters: z.object({}),
        execute: () => '',
      }),
    ],
    handoffs: [b],
  });
  expect(() => captureAgentProfiles(a)).toThrow('conflicts with declared tool');
});

it('captures native tool parameters and output retry declarations before later application mutation', () => {
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    execute: () => '',
  });
  const output = {
    mode: 'prompted' as const,
    schema: z.string(),
    maxRetries: 1,
  };
  const a = new Agent({
    instructions: 'a',
    tools: [lookup],
    outputType: output,
  });
  const captured = captureAgentProfiles(a);
  (
    lookup.parameters as { properties: { key: { type: string } } }
  ).properties.key.type = 'number';
  output.maxRetries = 9;
  expect(
    (captured[0].declaration.tools[0] as typeof lookup).parameters,
  ).toMatchObject({ properties: { key: { type: 'string' } } });
  expect(captured[0].declaration.outputType).toMatchObject({ maxRetries: 1 });
});

it('consumes rejected async resolver promises while rejecting their unsupported declaration', async () => {
  const a = new Agent({
    instructions: 'a',
    handoffs: [
      (() => Promise.reject(new Error('async resolver failed'))) as never,
    ],
  });
  expect(() => captureAgentProfiles(a)).toThrow('synchronous');
  await Promise.resolve();
});

it('inherits default target providers and captures compatible explicit providers and rejects unsupported inference or runtime grants', () => {
  const child = new Agent({ name: 'B', instructions: 'b' });
  const root = new Agent({ instructions: 'a', handoffs: [child] });
  expect(captureAgentProfiles(root)[1].declaration.provider).toBe(
    root.provider,
  );
  const explicit = new Agent({
    name: 'C',
    instructions: 'c',
    provider: child.provider,
  });
  const routed = captureAgentProfiles(
    new Agent({ instructions: 'a', handoffs: [explicit] }),
  );
  expect(routed[1].nativeProviderId).toBe('sdk_profile_1');
  expect(routed[1].declaration.provider).toBe(child.provider);
  const incompatible = new Agent({
    name: 'D',
    instructions: 'd',
    provider: new NativeProvider({ responseMode: 'buffered' }),
  });
  expect(() =>
    captureAgentProfiles(
      new Agent({ instructions: 'a', handoffs: [incompatible] }),
    ),
  ).toThrow('compatible text inference providers');
  child.programmaticToolCalling = true;
  expect(() => captureAgentProfiles(root)).toThrow('runtime grants');
});
