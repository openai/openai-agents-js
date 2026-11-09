import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import * as agents from '@openai/agents';
import * as codex from '@openai/agents-codex';

const agent = new agents.Agent({
  instructions: 'Answer.',
  decisions: new agents.OpenAIDecisions(),
});
expectTypeOf(agent.decide('Ready?', { input: 'Explicit.' })).toEqualTypeOf<
  Promise<boolean>
>();
expectTypeOf(
  agent.decide('Choose.', {
    input: 'Explicit.',
    choices: [false, 'false', 0, null] as const,
  }),
).toEqualTypeOf<Promise<false | 'false' | 0 | null>>();
expectTypeOf(
  agent.decide('Classify.', {
    input: 'Explicit.',
    outputType: z.object({ ready: z.boolean() }),
  }),
).toEqualTypeOf<Promise<{ ready: boolean }>>();
// @ts-expect-error Decisions are bound to Agents and callback contexts.
void agents.decide;
// @ts-expect-error The provider protocol has no typed decision convenience method.
void new agents.OpenAIDecisions().decide;
// @ts-expect-error The implementation package has no standalone decision export.
void codex.decide;
// @ts-expect-error Standalone call options are no longer public.
expectTypeOf<agents.DecisionOptions>();
// @ts-expect-error Explicit input is required.
agent.decide('Ready?', {});
agent.decide('Ready?', {
  input: 'Explicit.',
  // @ts-expect-error Choices and outputType are mutually exclusive.
  choices: [true],
  outputType: z.boolean(),
});
