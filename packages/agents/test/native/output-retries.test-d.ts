import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import type { OutputSpec, Session, Turn } from '@openai/agents';

const prompted: OutputSpec<string> = {
  mode: 'prompted',
  schema: z.string(),
  maxRetries: 1,
};
expectTypeOf(prompted.maxRetries).toEqualTypeOf<number | undefined>();

const native: OutputSpec<string> = {
  mode: 'native',
  schema: z.string(),
  // @ts-expect-error Only explicit prompted output declares a repair budget.
  maxRetries: 0,
};
expectTypeOf(native).toMatchTypeOf<OutputSpec<string>>();

// @ts-expect-error Retry budgets must be numbers.
const invalid: OutputSpec<string> = {
  mode: 'prompted',
  schema: z.string(),
  maxRetries: '1',
};
expectTypeOf(invalid).toMatchTypeOf<OutputSpec<string>>();

declare const session: Session<string>;
expectTypeOf(
  session.submitWithOutput('Count', {
    mode: 'prompted',
    schema: z.number(),
    maxRetries: 1,
  }),
).toEqualTypeOf<Promise<Turn<number>>>();
