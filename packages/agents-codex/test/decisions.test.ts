import { expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import * as agents from '@openai/agents';
import * as codex from '../src';
import {
  Agent,
  DecisionError,
  OutputValidationError,
  type DecisionProvider,
  type DecisionRequest,
} from '../src';

function provider(value: unknown): DecisionProvider {
  return { getDecision: vi.fn(async () => ({ value })) };
}

it('gives providers the direct boolean schema and accepts a boolean value', async () => {
  const selected = provider(true);
  const result = new Agent({
    instructions: 'Answer.',
    decisions: selected,
  }).decide('Ready?', { input: 'Explicit.' });
  expectTypeOf(result).toEqualTypeOf<Promise<boolean>>();
  await expect(result).resolves.toBe(true);
  expect(selected.getDecision).toHaveBeenCalledWith(
    expect.objectContaining({
      outputSchema: expect.objectContaining({ type: 'boolean' }),
    }),
    { signal: undefined },
  );
  expect(
    vi.mocked(selected.getDecision).mock.calls[0]![0].outputSchema,
  ).not.toHaveProperty('properties.response');
});

it.each([false, 'false', 0, null] as const)(
  'preserves the scalar choice %s',
  async (value) => {
    const result = new Agent({
      instructions: 'Answer.',
      decisions: provider(value),
    }).decide('Choose.', {
      input: 'Explicit.',
      choices: [false, 'false', 0, null] as const,
    });
    expectTypeOf(result).toEqualTypeOf<Promise<false | 'false' | 0 | null>>();
    await expect(result).resolves.toBe(value);
  },
);

it('validates raw values before application transforms', async () => {
  const schema = z.object({ value: z.string().min(1).transform(Number) });
  const result = new Agent({
    instructions: 'Answer.',
    decisions: provider({ value: '7' }),
  }).decide('Parse.', { input: 'Explicit.', outputType: schema });
  expectTypeOf(result).toEqualTypeOf<Promise<{ value: number }>>();
  await expect(result).resolves.toEqual({ value: 7 });
});

it.each(['yes', 1, null, { response: true }])(
  'rejects invalid raw boolean output %s',
  async (value) => {
    await expect(
      new Agent({ instructions: 'Answer.', decisions: provider(value) }).decide(
        'Approve?',
        { input: 'Explicit.' },
      ),
    ).rejects.toBeInstanceOf(OutputValidationError);
  },
);

it('does not fabricate a required approval from a Zod default', async () => {
  let advertised: DecisionRequest | undefined;
  const agent = new Agent({
    instructions: 'Answer.',
    decisions: {
      async getDecision(request) {
        advertised = request;
        return { value: {} };
      },
    },
  });
  await expect(
    agent.decide('Approve?', {
      input: 'Explicit.',
      outputType: z.object({ allow: z.boolean().default(true) }),
    }),
  ).rejects.toBeInstanceOf(OutputValidationError);
  expect(advertised?.outputSchema.required).toEqual(['allow']);
  expect(advertised?.outputSchema.properties).toEqual({
    allow: { type: 'boolean' },
  });
});

it('keeps validation independent when a provider adapts its schema copy', async () => {
  const agent = new Agent({
    instructions: 'Answer.',
    decisions: {
      async getDecision(request) {
        request.outputSchema.required = [];
        return { value: {} };
      },
    },
  });
  await expect(
    agent.decide('Approve?', {
      input: 'Explicit.',
      outputType: z.object({ allow: z.boolean().default(true) }),
    }),
  ).rejects.toBeInstanceOf(OutputValidationError);
});

it('rejects extra fields before Zod can strip them', async () => {
  await expect(
    new Agent({
      instructions: 'Answer.',
      decisions: provider({ allow: true, injected: true }),
    }).decide('Approve?', {
      input: 'Explicit.',
      outputType: z.object({ allow: z.boolean() }),
    }),
  ).rejects.toBeInstanceOf(OutputValidationError);
});

it.each([NaN, Infinity, undefined])(
  'rejects non-JSON values without lossy coercion',
  async (value) => {
    await expect(
      new Agent({ instructions: 'Answer.', decisions: provider(value) }).decide(
        'Value?',
        { input: 'Explicit.', outputType: z.null() },
      ),
    ).rejects.toBeInstanceOf(DecisionError);
  },
);

it('captures explicit input and keeps per-call providers separate from Agent defaults', async () => {
  const initial = [{ role: 'user', content: 'ORIGINAL_INPUT' }];
  const configured = provider(true),
    override = provider(false);
  const agent = new Agent({ instructions: 'Answer.', decisions: configured });
  const pending = agent.decide('Ready?', { input: initial });
  initial[0]!.content = 'MUTATED_INPUT';
  await expect(pending).resolves.toBe(true);
  expect(vi.mocked(configured.getDecision).mock.calls[0]![0].input).toEqual([
    { role: 'user', content: 'ORIGINAL_INPUT' },
  ]);
  await expect(
    agent.decide('Ready?', { input: 'Explicit.', provider: override }),
  ).resolves.toBe(false);
  expect(agent.decisions).toBe(configured);
});

it('requires a provider and explicit input, and propagates an already-aborted signal', async () => {
  await expect(
    new Agent({ instructions: 'Answer.' }).decide('Ready?', {
      input: 'Explicit.',
    }),
  ).rejects.toThrow('decision provider');
  const selected = provider(true);
  const agent = new Agent({ instructions: 'Answer.', decisions: selected });
  const reason = new Error('application cancelled');
  await expect(
    agent.decide('Ready?', {
      input: 'Explicit.',
      signal: AbortSignal.abort(reason),
    }),
  ).rejects.toBe(reason);
  expect(selected.getDecision).not.toHaveBeenCalled();
});

it('exposes decisions only through Agents and existing callback contexts', () => {
  expect(agents).not.toHaveProperty('decide');
  expect(codex).not.toHaveProperty('decide');
  expect(new agents.OpenAIDecisions()).not.toHaveProperty('decide');
});

it('validates local recursive references against raw application JSON', async () => {
  type Node = { next: Node | null };
  const node: z.ZodType<Node> = z.lazy(() =>
    z.object({ next: node.nullable() }),
  );
  const agent = new Agent({
    instructions: 'Answer.',
    decisions: provider({ next: { next: null } }),
  });
  await expect(
    agent.decide('Link.', { input: 'Explicit.', outputType: node }),
  ).resolves.toEqual({ next: { next: null } });
});
