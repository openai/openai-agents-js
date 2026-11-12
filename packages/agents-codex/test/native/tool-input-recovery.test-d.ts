import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import { tool } from '@openai/agents';

tool({
  name: 'checked',
  parameters: z.object({ key: z.string() }),
  inputErrorFunction(_context, error, original) {
    if (error instanceof SyntaxError) {
      expectTypeOf(error).toEqualTypeOf<SyntaxError>();
      return typeof original === 'string'
        ? `Invalid JSON: ${original}`
        : error.message;
    }
    expectTypeOf(error).toEqualTypeOf<z.ZodError>();
    // @ts-expect-error Unvalidated original JSON; no schema-derived properties.
    const key: string = original.key;
    void key;
    return error.issues.map((issue) => issue.message).join('; ');
  },
  execute: ({ key }) => key,
});

tool({
  name: 'narrow_formatter',
  parameters: z.object({ key: z.string() }),
  // @ts-expect-error Native syntax failures in the formatter's error union.
  inputErrorFunction: (_context, error: z.ZodError) => error.message,
  execute: ({ key }) => key,
});
