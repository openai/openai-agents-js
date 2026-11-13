import { expect, it } from 'vitest';
import { z } from 'zod';
import { tool, hostedTool } from '../src';
it('keeps programmatic distinct from local code in the captured declaration', () => {
  const only = tool({
    name: 'lookup',
    description: 'Return a synthetic value.',
    parameters: z.object({}),
    allowedCallers: ['programmatic'],
    execute: async () => 'ok',
  });
  expect(only.allowedCallers).toEqual(['programmatic']);
  const mixed = tool({
    name: 'mixed',
    description: 'Return a synthetic value.',
    parameters: z.object({}),
    allowedCallers: ['programmatic', 'direct'],
    execute: async () => 'ok',
  });
  expect(mixed.allowedCallers).toEqual(['direct', 'programmatic']);
  expect(mixed.allowedCallers).not.toContain('code');
});
it('retains omitted caller policy and rejects duplicates', () => {
  expect(
    tool({
      name: 'plain',
      description: 'Plain.',
      parameters: z.object({}),
      execute: async () => 'ok',
    }).allowedCallers,
  ).toBeUndefined();
  expect(() =>
    tool({
      name: 'bad',
      description: 'Bad.',
      parameters: z.object({}),
      allowedCallers: ['programmatic', 'programmatic'],
      execute: async () => 'ok',
    }),
  ).toThrow(/distinct/);
});

it('rejects custom-string declarations through the opaque provider entry point', () => {
  expect(() =>
    hostedTool({
      type: 'custom',
      name: 'raw',
      description: 'Synthetic.',
      format: { type: 'text' },
      allowed_callers: ['programmatic'],
    }),
  ).toThrow(/typed declaration/);
});
