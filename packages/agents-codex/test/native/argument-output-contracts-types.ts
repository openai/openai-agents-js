import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  manualTool,
  type AgentOptions,
  type ExecutorContext,
  type FunctionTool,
  type ManualTool,
} from '../../src';

// Checked by tsconfig.test.json; never executed.
export async function outputContracts(
  executor: ExecutorContext<{ account: string }>,
) {
  // @ts-expect-error Structured output requires an output schema.
  new Agent<undefined, { answer: number }>({ instructions: 'Answer.' });
  // @ts-expect-error AgentOptions also requires the structured output schema.
  const missing: AgentOptions<undefined, { answer: number }> = {
    instructions: 'Answer.',
  };
  const schema = z.object({ answer: z.number() });
  const inferred = new Agent({ instructions: 'Answer.', outputType: schema });
  expectTypeOf((await inferred.run('go')).finalOutput).toEqualTypeOf<{
    answer: number;
  }>();
  // @ts-expect-error Clearing an inferred structured schema would promise an object but return text.
  inferred.outputType = undefined;
  inferred.outputType = schema;
  const explicit = new Agent<undefined, { answer: number }>({
    instructions: 'Answer.',
    outputType: schema,
  });
  // @ts-expect-error Clearing an explicit structured schema is equally unsound.
  explicit.outputType = undefined;
  new Agent<undefined, unknown>({ instructions: 'Answer.' }).outputType =
    undefined;
  new Agent<undefined, string | { answer: number }>({
    instructions: 'Answer.',
  }).outputType = undefined;
  new Agent({ instructions: 'Answer.' }).outputType = undefined;
  // @ts-expect-error A string literal result also needs validation.
  new Agent<undefined, 'yes'>({ instructions: 'Answer.' });
  const prompted = new Agent({
    instructions: 'Answer.',
    outputType: { mode: 'prompted', schema },
  });
  expectTypeOf((await prompted.run('go')).finalOutput).toEqualTypeOf<{
    answer: number;
  }>();
  const native = new Agent({
    instructions: 'Answer.',
    outputType: { mode: 'native', schema },
  });
  expectTypeOf((await native.run('go')).finalOutput).toEqualTypeOf<{
    answer: number;
  }>();
  const completed = await executor.session.wait();
  expectTypeOf(completed.finalOutput).toEqualTypeOf<unknown>();
  // @ts-expect-error The executor does not know the Agent's output contract.
  completed.finalOutput.toUpperCase();
  expectTypeOf(executor.context).toEqualTypeOf<{ account: string }>();
  const wrongContext = {} as FunctionTool<{ cart: number[] }>;
  // @ts-expect-error Erasing output preserves the Session's application context.
  executor.session.update({ tools: [wrongContext] });
  void missing;
}

export function manualArgumentsContracts() {
  const parameters = z.object({
    count: z.string().transform(Number),
    label: z.string().optional(),
    tags: z.array(z.array(z.string()).readonly()).readonly(),
  });
  const tool = manualTool({
    name: 'lookup',
    description: '',
    parameters,
    result: z.string(),
  });
  expectTypeOf(tool).toEqualTypeOf<
    ManualTool<
      {
        count: number;
        label?: string | undefined;
        tags: readonly (readonly string[])[];
      },
      string
    >
  >();
  class Key {
    text() {
      return 'value';
    }
  }
  manualTool({
    name: 'class',
    description: '',
    // @ts-expect-error Rich parsed values cannot be delivered as JSON arguments.
    parameters: z.string().transform(() => new Key()),
    result: z.string(),
  });
  manualTool({
    name: 'date',
    description: '',
    // @ts-expect-error Date transforms must return an explicit JSON representation.
    parameters: z.string().transform((value) => new Date(value)),
    result: z.string(),
  });
  manualTool({
    name: 'map',
    description: '',
    // @ts-expect-error Map transforms must return an explicit JSON representation.
    parameters: z.string().transform((value) => new Map([[value, value]])),
    result: z.string(),
  });
}
