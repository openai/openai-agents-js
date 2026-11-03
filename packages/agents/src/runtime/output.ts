import { z } from 'zod';
import { createHash } from 'node:crypto';
import { jsonObject, type JsonObject, type JsonValue } from './binding';

/** A captured Zod contract using native JSON generation or prompted text. */
export type OutputSpec<Output> =
  | z.ZodType<Output>
  | {
      readonly mode: 'native';
      readonly schema: z.ZodType<Output>;
    }
  | {
      readonly mode: 'prompted';
      readonly schema: z.ZodType<Output>;
      readonly maxRetries?: number;
    };

/** Local final-output validation failed. The message never includes rejected text. */
export class OutputValidationError extends Error {
  constructor(readonly rawOutput: string) {
    super('Final output did not match the requested output type');
    this.name = 'OutputValidationError';
  }
}

/** Portable schema meaning, not identity of application parser code. */
export interface OutputIdentity {
  readonly version: 1;
  readonly mode: 'plain' | 'native' | 'prompted';
  readonly budget: number;
  readonly fingerprint: string;
}

function captureOutputIdentity(
  mode: OutputIdentity['mode'],
  schema: JsonObject | null,
  budget = 0,
): OutputIdentity {
  const canonical = (value: JsonValue): string => {
    if (value === null || typeof value !== 'object')
      return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  };
  const fingerprint = createHash('sha256')
    .update(canonical({ mode, schema, budget }))
    .digest('hex');
  return Object.freeze({ version: 1, mode, budget, fingerprint });
}

/** One captured generation contract and local parser, shared by runtime owners. */
export interface PreparedOutput<Output = unknown> {
  readonly identity: OutputIdentity;
  readonly schema?: JsonObject;
  readonly prompt?: string;
  readonly parse?: (text: string) => Output;
  readonly repair?: {
    readonly schema: JsonObject;
    readonly maxRetries: number;
  };
}

/** Capture generation guidance and one local parser before opening resources. */
export function prepareOutput<Output>(
  output: OutputSpec<Output> | undefined,
): PreparedOutput<Output> {
  if (!output)
    return {
      identity: captureOutputIdentity(
        'plain',
        jsonObject.parse(z.toJSONSchema(z.string(), { io: 'input' })),
      ),
    };
  const explicit = 'mode' in output;
  let budget = 0;
  if (explicit) {
    if (output.mode !== 'native' && output.mode !== 'prompted')
      throw new TypeError('Output mode must be native or prompted');
    if (output.mode === 'native' && 'maxRetries' in output)
      throw new TypeError('Native output cannot declare maxRetries');
    if (output.mode === 'prompted') {
      const maxRetries = output.maxRetries;
      if (maxRetries !== undefined) {
        if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
          throw new TypeError(
            'Output maxRetries must be a nonnegative safe integer',
          );
        budget = maxRetries;
      }
    }
  }
  const schema = explicit ? output.schema : output;
  const validate =
    (parse: (text: string) => Output) =>
    (text: string): Output => {
      try {
        return parse(text);
      } catch {
        // Keep validator issues and rejected values out of messages and causes.
        throw new OutputValidationError(text);
      }
    };
  if (explicit && output.mode === 'prompted') {
    const prompted = jsonObject.parse(z.toJSONSchema(schema, { io: 'input' }));
    return {
      identity: captureOutputIdentity('prompted', prompted, budget),
      ...(budget ? { repair: { schema: prompted, maxRetries: budget } } : {}),
      prompt:
        'Return only JSON that matches this output schema: ' +
        JSON.stringify(prompted) +
        '\nUse this format only for this request, including its automatic ' +
        'continuations and tool results. This output format instruction ' +
        'does not apply to later requests.',
      parse: validate((text) => schema.parse(JSON.parse(text))),
    };
  }
  let native = jsonObject.parse(z.toJSONSchema(schema));
  if (
    !explicit &&
    native.type === 'string' &&
    Object.keys(native).every((key) => ['type', '$schema'].includes(key))
  )
    return {
      identity: captureOutputIdentity('plain', native),
      parse: validate((text) => schema.parse(text)),
    };
  const wrapped = native.type !== 'object';
  const identity = captureOutputIdentity('native', { schema: native, wrapped });
  if (wrapped)
    native = jsonObject.parse(z.toJSONSchema(z.object({ response: schema })));

  const close = (node: JsonObject): void => {
    if (!('type' in node || '$ref' in node || 'anyOf' in node))
      throw new TypeError('Output schemas cannot contain unconstrained values');
    if (
      ['oneOf', 'allOf', 'prefixItems', 'uniqueItems'].some(
        (key) => key in node,
      )
    )
      throw new TypeError('Unsupported strict output schema');
    delete node.default;
    if (node.type === 'object') {
      if (
        node.additionalProperties !== undefined &&
        node.additionalProperties !== false
      )
        throw new TypeError('Output schemas cannot contain open maps');
      const properties = jsonObject.parse(node.properties ?? {});
      node.additionalProperties = false;
      node.required = Object.keys(properties);
      node.properties = properties;
      for (const child of Object.values(properties)) close(child as JsonObject);
    }
    if (node.$defs)
      for (const child of Object.values(node.$defs)) close(child as JsonObject);
    if (node.items) close(node.items as JsonObject);
    if (Array.isArray(node.anyOf))
      for (const child of node.anyOf) close(child as JsonObject);
  };
  close(native);
  return {
    identity,
    schema: native,
    parse: validate((text) => {
      const value = JSON.parse(text);
      return wrapped
        ? z.strictObject({ response: schema }).parse(value).response
        : schema.parse(value);
    }),
  };
}
