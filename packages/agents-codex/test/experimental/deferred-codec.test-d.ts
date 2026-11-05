import { z } from 'zod-deferred';
import { expectTypeOf } from 'vitest';
import {
  createDeferredCodec,
  deferredDefault,
} from '../../src/experimental/deferred-codec';
const attempts = deferredDefault(z.number().int().min(1), 1);
expectTypeOf<z.input<typeof attempts>>().toEqualTypeOf<number | undefined>();
expectTypeOf<z.output<typeof attempts>>().toEqualTypeOf<number>();
const parameters = z.strictObject({ id: z.string(), attempts });
expectTypeOf<z.input<typeof parameters>>().toEqualTypeOf<{
  id: string;
  attempts?: number | undefined;
}>();
expectTypeOf<z.output<typeof parameters>>().toEqualTypeOf<{
  id: string;
  attempts: number;
}>();
const codec = createDeferredCodec(
  parameters,
  z.strictObject({ done: z.boolean() }),
);
expectTypeOf(codec.parseInput({ id: 'one' })).toEqualTypeOf<{
  id: string;
  attempts: number;
}>();
expectTypeOf(codec.parseResult({ done: true })).toEqualTypeOf<{
  done: boolean;
}>();
// @ts-expect-error a factory is not a scalar
void deferredDefault(z.number(), () => 1);
// @ts-expect-error the scalar must match the original schema output
void deferredDefault(z.string(), 1);
// @ts-expect-error object defaults are outside the supported subset
void deferredDefault(z.strictObject({ id: z.string() }), { id: 'one' });
