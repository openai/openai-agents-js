import { z } from 'zod-deferred';
import { decode, jsonValue } from '../runtime/binding';
import { outputOf } from '../runtime/tools';
import { assembleManualTool, type ManualTool } from '../runtime/manual';
import { createDeferredCodec } from './deferred-codec';

const codecs = new WeakMap<
  ManualTool,
  ReturnType<typeof createDeferredCodec>
>();

/** @internal Recover the codec captured for this exact declaration, without rebuilding schemas. */
export function deferredToolCodec(tool: ManualTool) {
  return codecs.get(tool);
}

/**
 * Construct a deferred manual-tool declaration using the pinned schema builder.
 * Explicit construction runs application code and can evaluate Zod defaults
 * during conversion before refusing them. It does not roll those effects back.
 * Registration and recovery must use captured declarations, not this builder.
 */
export function deferredTool<
  P extends z.ZodType,
  R extends z.ZodType,
>(options: {
  name: string;
  description: string;
  deferLoading?: boolean;
  schemas: (builder: typeof z) => { parameters: P; result: R };
}): ManualTool<z.output<P>, z.input<R>> {
  const { parameters, result } = options.schemas(z);
  const resultSchema = decode(
    jsonValue,
    JSON.stringify(z.toJSONSchema(result, { io: 'input' })),
  );
  const inputSchema = decode(
    jsonValue,
    JSON.stringify(z.toJSONSchema(parameters, { io: 'input' })),
  );
  const codec = createDeferredCodec(parameters, result);
  const tool = assembleManualTool<z.output<P>, z.input<R>>(
    {
      name: options.name,
      description: options.description,
      deferLoading: options.deferLoading,
      parameters: inputSchema,
    },
    {
      resultSchema,
      parseInput: codec.parseInput,
      parseResult: (value) =>
        outputOf(jsonValue.parse(codec.parseResult(value))),
    },
  );
  codecs.set(tool, codec);
  return tool;
}
