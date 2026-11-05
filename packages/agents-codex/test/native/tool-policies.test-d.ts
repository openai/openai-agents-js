import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  tool,
  ToolOutput,
  type FunctionTool,
  type ToolContext,
} from '@openai/agents';

type Context = { prefix: string };
const defined = tool({
  name: 'typed_policy',
  parameters: z.object({ text: z.string().transform((value) => value.length) }),
  result: z.string().transform((value) => ({ length: value.length })),
  before(context: ToolContext<Context>) {
    expectTypeOf(context.context).toEqualTypeOf<Context>();
    // Replacement uses the schema's input, while execute receives its output.
    return {
      action: 'replaceArguments',
      arguments: { text: context.context.prefix },
    };
  },
  execute(args, context) {
    expectTypeOf(args).toEqualTypeOf<{ text: number }>();
    expectTypeOf(context.context).toEqualTypeOf<Context>();
    // Execution returns the result schema's input, not its transformed output.
    return String(args.text);
  },
  after(output, context) {
    expectTypeOf(output).toEqualTypeOf<ToolOutput>();
    expectTypeOf(context.context).toEqualTypeOf<Context>();
    return output;
  },
});
expectTypeOf(defined).toEqualTypeOf<FunctionTool<Context>>();

tool({
  name: 'invalid_result_input',
  parameters: z.object({}),
  result: z.string().transform((value) => value.length),
  // @ts-expect-error The callback must return the result schema's string input.
  execute: () => 42,
});

tool({
  name: 'invalid_replacement_input',
  parameters: z.object({ text: z.string().transform((value) => value.length) }),
  // @ts-expect-error Replacement arguments must use the parameter schema's string input.
  before: () => ({ action: 'replaceArguments', arguments: { text: 42 } }),
  execute: () => 'done',
});
