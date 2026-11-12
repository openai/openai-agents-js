import { expect, it } from 'vitest';
import { z } from 'zod';
import { hostedTool, tool } from '../src';
import { hostedToolSpecs } from '../src/runtime/hosted-tools';
import { splitToolDeclarations } from '../src/runtime/tool-declarations';

it('captures separate provider identities without registering local callbacks', () => {
  const raw = { type: 'future_a', future: { values: [true, null] } };
  const declaration = hostedTool(raw);
  raw.future.values.push(false);
  const selected = splitToolDeclarations([
    declaration,
    hostedTool({ type: 'future_b' }),
  ]);
  expect(selected.tools).toEqual([]);
  expect(hostedToolSpecs(selected.hostedTools)).toEqual([
    {
      type: 'provider_only',
      definition: { type: 'future_a', future: { values: [true, null] } },
    },
    { type: 'provider_only', definition: { type: 'future_b' } },
  ]);
  expect(() => splitToolDeclarations([declaration, declaration])).toThrow(
    /only once/,
  );
});

it.each([
  'function',
  'namespace',
  'custom',
  'computer',
  'apply_patch',
  'mcp',
  'shell',
  'tool_search',
])('keeps %s on its typed authority route', (type) => {
  expect(() => hostedTool({ type, name: 'ordinary' })).toThrow(
    /typed declaration/,
  );
});

it.each(['type', 'name'] as const)(
  'rejects a captured %s collision with an application function',
  (field) => {
    const ordinary = tool({
      name: 'ordinary',
      parameters: z.object({}),
      execute: () => 'unused',
    });
    const remote = hostedTool(
      field === 'type'
        ? { type: 'ordinary' }
        : { type: 'future_hosted', name: 'ordinary' },
    );
    expect(() => splitToolDeclarations([ordinary, remote])).toThrow(
      /reserves the tool name/,
    );
  },
);
