import { expectTypeOf } from 'vitest';
import { z as ordinaryZod } from 'zod';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { deferredDefault } from '../../src/experimental/deferred-codec';
import { Agent } from '../../src/runtime/public-agent';
import { manualTool, type ManualTool } from '../../src/runtime/manual';

const ordinary = manualTool({
  name: 'ordinary',
  description: 'Unchanged owner',
  parameters: ordinaryZod.strictObject({ id: ordinaryZod.string() }),
  result: ordinaryZod.boolean(),
});
const declaration = deferredTool({
  name: 'render',
  description: 'Inferred alias-owned schemas',
  schemas: (z) => ({
    parameters: z.strictObject({
      id: z.string(),
      attempts: deferredDefault(z.int().min(1), 1),
    }),
    result: z.strictObject({ bytes: z.int().min(0) }),
  }),
});
expectTypeOf(ordinary).toEqualTypeOf<ManualTool<{ id: string }, boolean>>();
expectTypeOf(declaration).toEqualTypeOf<
  ManualTool<{ id: string; attempts: number }, { bytes: number }>
>();
new Agent({
  instructions: 'Use existing declarations',
  tools: [ordinary, declaration],
});
const request = declaration.match({});
if (request) {
  expectTypeOf(request.arguments).toEqualTypeOf<{
    id: string;
    attempts: number;
  }>();
  request.reply({ bytes: 1 });
  // @ts-expect-error the inferred result requires a numeric byte count.
  request.reply({ bytes: 'one' });
  // @ts-expect-error required result fields cannot be omitted.
  request.reply({});
}
deferredTool({
  name: 'async',
  description: 'Unsupported builder',
  // @ts-expect-error declaration construction is synchronous.
  schemas: async (z) => ({
    parameters: z.strictObject({}),
    result: z.strictObject({}),
  }),
});
