import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  decode,
  losslessJsonValueSchema,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from './binding';

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

/** Sensitive diagnostic from the captured validator; access with care like rawOutput. */
export interface OutputValidationIssue {
  readonly code: string;
  /** Application-data path; native SDK response wrappers are omitted. Wrapper failures use []. */
  readonly path: readonly PropertyKey[];
}

/** Local final-output validation failed. Ordinary error display omits sensitive data. */
export class OutputValidationError extends Error {
  #rawOutput: string;
  #issues: readonly OutputValidationIssue[];

  constructor(
    rawOutput: string,
    issues: readonly OutputValidationIssue[] = [],
  ) {
    super('Final output did not match the requested output type');
    this.name = 'OutputValidationError';
    this.#rawOutput = rawOutput;
    this.#issues = Object.freeze(
      issues.map(({ code, path }) =>
        Object.freeze({ code, path: Object.freeze([...path]) }),
      ),
    );
  }

  /** Deliberate sensitive access to rejected provider output. */
  get rawOutput(): string {
    return this.#rawOutput;
  }

  /** Deliberate sensitive access: custom codes and field names can contain private data. */
  get issues(): readonly OutputValidationIssue[] {
    return this.#issues;
  }
}

/** @internal Retain diagnostic codes and paths without retaining the validator exception. */
export function outputValidationIssues(
  error: unknown,
  wrapped = false,
): OutputValidationIssue[] {
  return error instanceof z.ZodError
    ? error.issues.map(({ code, path }) => ({
        code,
        path: wrapped ? (path[0] === 'response' ? path.slice(1) : []) : path,
      }))
    : [{ code: 'validation_error', path: [] }];
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
  /** Private native non-object response wrapper. */
  readonly wrapped?: boolean;
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
        decode(
          jsonObject,
          JSON.stringify(z.toJSONSchema(z.string(), { io: 'input' })),
        ),
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
    (parse: (text: string) => Output, wrapped = false) =>
    (text: string): Output => {
      try {
        return parse(text);
      } catch (error) {
        // Retain only explicitly accessed codes/paths, never the validator exception.
        throw new OutputValidationError(
          text,
          outputValidationIssues(error, wrapped),
        );
      }
    };
  if (explicit && output.mode === 'prompted') {
    const prompted = decode(
      jsonObject,
      JSON.stringify(z.toJSONSchema(schema, { io: 'input' })),
    );
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
  let native = decode(jsonObject, JSON.stringify(z.toJSONSchema(schema)));
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
    native = decode(
      jsonObject,
      JSON.stringify(z.toJSONSchema(z.object({ response: schema }))),
    );

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
    wrapped,
    parse: validate((text) => {
      const value = JSON.parse(text);
      return wrapped
        ? z.strictObject({ response: schema }).parse(value).response
        : schema.parse(value);
    }, wrapped),
  };
}

/** Convert the final settled body once. This path never invokes output repair. */
export function parseToolCompletion(
  output: PreparedOutput,
  content: unknown,
): { value: unknown; json: JsonValue } {
  // Core supplies canonical FunctionCallOutputBody content, never the earlier callback value.
  const body = z.array(
    z.object({ type: z.literal('input_text'), text: z.string() }).strict(),
  );
  let text = '';
  try {
    if (typeof content === 'string') text = content;
    else {
      const items = body.parse(content);
      if (items.length !== 1) throw new Error('Expected one text item');
      text = items[0].text;
    }
    const candidate = output.wrapped
      ? JSON.stringify(
          losslessJsonValueSchema.parse({ response: JSON.parse(text) }),
        )
      : text;
    const value = output.parse ? output.parse(candidate) : text;
    // Validate JSON data without repeating the captured output validator.
    return { value, json: losslessJsonValueSchema.parse(value) };
  } catch (error) {
    if (error instanceof OutputValidationError) throw error;
    throw new OutputValidationError(text, outputValidationIssues(error));
  }
}
