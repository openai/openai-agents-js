import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  checklist,
  manualTool,
  tool,
} from '../../src';
import * as nativeBinding from '../../src/runtime/binding';
import { splitToolDeclarations } from '../../src/runtime/mcp';
import { readChecklist } from '../../src/runtime/state';

it('returns a frozen opening declaration and preserves absent versus empty data', () => {
  expect(checklist()).toEqual({ kind: 'checklist' });
  expect(Object.isFrozen(checklist())).toBe(true);
  expect(readChecklist('null')).toBeNull();
  const empty = readChecklist(
    JSON.stringify({
      thread_id: 'root',
      turn_id: 'turn',
      explanation: '',
      plan: [],
    }),
  );
  expect(empty).toEqual({
    threadId: 'root',
    turnId: 'turn',
    explanation: '',
    plan: [],
  });
  expect(Object.isFrozen(empty)).toBe(true);
  expect(Object.isFrozen(empty!.plan)).toBe(true);
  const value = readChecklist(
    JSON.stringify({
      thread_id: 'root',
      turn_id: 'turn',
      plan: [{ step: 'first', status: 'pending' }],
    }),
  )!;
  expect(value.explanation).toBeNull();
  expect(Reflect.set(value.plan[0], 'step', 'changed')).toBe(false);
  expect(value.plan[0].step).toBe('first');
  expect(() => readChecklist('{')).toThrow();
  expect(() =>
    readChecklist(
      JSON.stringify({
        thread_id: 'root',
        turn_id: 'turn',
        plan: [{ step: 'bad', status: 'done' }],
      }),
    ),
  ).toThrow();
});

it.each([
  { tools: [checklist(), checklist()] },
  {
    tools: [
      checklist(),
      tool({
        name: 'update_plan',
        parameters: z.object({}),
        execute: () => '',
      }),
    ],
  },
  {
    tools: [
      checklist(),
      manualTool({
        name: 'update_plan',
        description: 'Conflicting manual tool.',
        parameters: z.object({}),
        result: z.string(),
      }),
    ],
  },
])(
  'refuses unsupported opening authority before acquiring resources: %j',
  async (options) => {
    const provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    const agent = new Agent({ instructions: 'Inspect.', provider });
    try {
      await expect(agent.session(options)).rejects.toBeInstanceOf(TypeError);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await provider.close();
    }
  },
);

it.each([
  tool({ name: 'update_plan', parameters: z.object({}), execute: () => '' }),
  manualTool({
    name: 'update_plan',
    description: 'Supply a plan.',
    parameters: z.object({}),
    result: z.string(),
  }),
])(
  'agrees on invalid checklist defaults before native validation',
  async (leaf) => {
    const binding = vi
      .spyOn(nativeBinding, 'binding')
      .mockRejectedValue(
        new Error('Invalid declarations reached native validation'),
      );
    const agent = new Agent({
      instructions: 'Validate defaults.',
      tools: [leaf, checklist()],
    });
    const acquire = vi.spyOn(agent.provider, '_acquire');
    try {
      await expect(agent.validate()).rejects.toThrow(
        'Checklist reserves the tool name update_plan',
      );
      await expect(agent.session()).rejects.toThrow(
        'Checklist reserves the tool name update_plan',
      );
      expect(binding).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      binding.mockRestore();
      await agent.provider.close();
    }
  },
);

it('keeps valid checklist grants, ordinary plan leaves and MCP namespaces', () => {
  const ordinary = tool({
    name: 'update_plan',
    parameters: z.object({}),
    execute: () => '',
  });
  const manual = manualTool({
    name: 'update_plan',
    description: 'Supply a plan.',
    parameters: z.object({}),
    result: z.string(),
  });
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute: () => '',
  });
  const mcp = new HttpMCP({
    name: 'plans',
    tools: ['update_plan'],
    url: 'http://127.0.0.1:1/mcp',
  });
  expect(() => splitToolDeclarations([checklist()])).not.toThrow();
  expect(() => splitToolDeclarations([ordinary])).not.toThrow();
  expect(() => splitToolDeclarations([manual])).not.toThrow();
  expect(() => splitToolDeclarations([checklist(), lookup, mcp])).not.toThrow();
});
