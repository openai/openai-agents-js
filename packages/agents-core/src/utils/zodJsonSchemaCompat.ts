import type { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../types';
import { UserError } from '../errors';
import type { ZodObjectLike } from './zodCompat';
import {
  readZodDefinition,
  readZodDescription,
  readZodType,
} from './zodCompat';

/**
 * The JSON-schema helpers in openai/helpers/zod only emit complete schemas for
 * a subset of Zod constructs. In particular, Zod v4 and several decorators can
 * omit `type`, `properties`, or `required` metadata, which breaks tool execution
 * when a user relies on automatic schema extraction.
 *
 * This module provides a minimal, type-directed fallback converter that inspects
 * Zod internals and synthesises the missing JSON Schema bits on demand. The
 * converter only covers the constructs we actively depend on (objects, optionals,
 * unions, tuples, records, sets, etc.); anything more exotic simply returns
 * `undefined`, signalling to the caller that it should surface a user error.
 *
 * The implementation is intentionally explicit: helper functions isolate each
 * Zod shape, making the behaviour both testable and easier to trim back if the
 * upstream helper gains first-class support. See zodJsonSchemaCompat.test.ts for
 * the regression cases we guarantee.
 */

type LooseJsonObjectSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaDefinitionEntry>;
  required?: string[];
  additionalProperties?: boolean;
  $schema?: string;
  description?: string;
};

type ShapeCandidate = {
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
};

type ConversionContext = {
  lowerObjectIntersections: boolean;
  loweredObjectIntersection: boolean;
  loweredPrimitiveIntersection: boolean;
  losslessForWholeSchemaFallback: boolean;
};

export type OpenAIStrictZodSchemaConversion = {
  schema: JsonObjectSchema<any>;
  loweredObjectIntersection: boolean;
  loweredPrimitiveIntersection: boolean;
  losslessForWholeSchemaFallback: boolean;
};

const JSON_SCHEMA_DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const OPTIONAL_WRAPPERS = new Set(['optional']);
const DECORATOR_WRAPPERS = new Set([
  'brand',
  'branded',
  'catch',
  'default',
  'effects',
  'pipeline',
  'pipe',
  'prefault',
  'readonly',
  'refinement',
  'transform',
]);
const LOSSLESS_STRICT_FALLBACK_DECORATORS = new Set([
  'brand',
  'branded',
  'catch',
  'default',
  'prefault',
  'readonly',
]);

// Primitive leaf nodes map 1:1 to JSON Schema types; everything else is handled
// by the specialised builders further down.
const SIMPLE_TYPE_MAPPING: Record<string, JsonSchemaDefinitionEntry> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
};

export function hasJsonSchemaObjectShape(
  value: unknown,
): value is LooseJsonObjectSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === 'object' &&
    'properties' in value &&
    'additionalProperties' in value
  );
}

export function zodJsonSchemaCompat(
  input: ZodObjectLike,
): JsonObjectSchema<any> | undefined {
  return convertZodObjectSchema(input, {
    lowerObjectIntersections: false,
    loweredObjectIntersection: false,
    loweredPrimitiveIntersection: false,
    losslessForWholeSchemaFallback: true,
  })?.schema;
}

export function zodJsonSchemaCompatForOpenAIStrict(
  input: ZodObjectLike,
): OpenAIStrictZodSchemaConversion | undefined {
  return convertZodObjectSchema(input, {
    lowerObjectIntersections: true,
    loweredObjectIntersection: false,
    loweredPrimitiveIntersection: false,
    losslessForWholeSchemaFallback: true,
  });
}

function convertZodObjectSchema(
  input: ZodObjectLike,
  context: ConversionContext,
): OpenAIStrictZodSchemaConversion | undefined {
  const rootDefinition = readZodDefinition(input);
  if (
    context.lowerObjectIntersections &&
    !isLosslessStrictFallbackNode('object', rootDefinition)
  ) {
    context.losslessForWholeSchemaFallback = false;
  }
  // Attempt to build an object schema from Zod's internal shape. If we cannot
  // understand the structure we return undefined, letting callers raise a
  // descriptive error instead of emitting an invalid schema.
  const schema = buildObjectSchema(input, context);
  if (!schema) {
    return undefined;
  }
  if (
    context.loweredObjectIntersection &&
    !context.losslessForWholeSchemaFallback
  ) {
    throwLossyZodIntersectionFallback();
  }

  if (!Array.isArray(schema.required)) {
    schema.required = [];
  }

  if (typeof schema.additionalProperties === 'undefined') {
    schema.additionalProperties = false;
  }

  if (typeof schema.$schema !== 'string') {
    schema.$schema = JSON_SCHEMA_DRAFT_07;
  }

  return {
    schema: schema as JsonObjectSchema<
      Record<string, JsonSchemaDefinitionEntry>
    >,
    loweredObjectIntersection: context.loweredObjectIntersection,
    loweredPrimitiveIntersection: context.loweredPrimitiveIntersection,
    losslessForWholeSchemaFallback: context.losslessForWholeSchemaFallback,
  };
}

export function assertLosslessOpenAIStrictZodSchemaConversion(
  conversion: OpenAIStrictZodSchemaConversion,
): void {
  if (!conversion.losslessForWholeSchemaFallback) {
    throwLossyZodIntersectionFallback();
  }
}

function throwLossyZodIntersectionFallback(): never {
  throw new UserError(
    'Cannot convert this Zod schema with an intersection to OpenAI strict mode without losing constraints. Use unconstrained compatible intersections, combine the fields into one Zod object, or disable strict mode.',
  );
}

export function mergeJsonSchemaDescriptions(
  target: JsonSchemaDefinitionEntry,
  source: JsonSchemaDefinitionEntry | undefined,
): void {
  if (
    typeof target !== 'object' ||
    target === null ||
    typeof source !== 'object' ||
    source === null
  ) {
    return;
  }

  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  if (
    typeof sourceRecord.description === 'string' &&
    sourceRecord.description.trim() &&
    !('description' in targetRecord)
  ) {
    targetRecord.description = sourceRecord.description;
  }

  if (
    targetRecord.type === 'object' &&
    sourceRecord.type === 'object' &&
    typeof targetRecord.properties === 'object' &&
    targetRecord.properties !== null &&
    typeof sourceRecord.properties === 'object' &&
    sourceRecord.properties !== null
  ) {
    for (const [key, value] of Object.entries(
      sourceRecord.properties as Record<string, JsonSchemaDefinitionEntry>,
    )) {
      const targetValue = (
        targetRecord.properties as Record<string, JsonSchemaDefinitionEntry>
      )[key];
      if (targetValue) {
        mergeJsonSchemaDescriptions(targetValue, value);
      }
    }
  }

  if (
    targetRecord.type === 'array' &&
    sourceRecord.type === 'array' &&
    'items' in targetRecord &&
    'items' in sourceRecord
  ) {
    const targetItems = targetRecord.items;
    const sourceItems = sourceRecord.items;
    if (Array.isArray(targetItems) && Array.isArray(sourceItems)) {
      const limit = Math.min(targetItems.length, sourceItems.length);
      for (let index = 0; index < limit; index += 1) {
        mergeJsonSchemaDescriptions(
          targetItems[index] as JsonSchemaDefinitionEntry,
          sourceItems[index] as JsonSchemaDefinitionEntry,
        );
      }
    } else if (
      typeof targetItems === 'object' &&
      targetItems !== null &&
      typeof sourceItems === 'object' &&
      sourceItems !== null
    ) {
      mergeJsonSchemaDescriptions(
        targetItems as JsonSchemaDefinitionEntry,
        sourceItems as JsonSchemaDefinitionEntry,
      );
    }
  }

  for (const keyword of ['anyOf', 'allOf', 'oneOf']) {
    const targetArray = targetRecord[keyword];
    const sourceArray = sourceRecord[keyword];
    if (Array.isArray(targetArray) && Array.isArray(sourceArray)) {
      const limit = Math.min(targetArray.length, sourceArray.length);
      for (let index = 0; index < limit; index += 1) {
        mergeJsonSchemaDescriptions(
          targetArray[index] as JsonSchemaDefinitionEntry,
          sourceArray[index] as JsonSchemaDefinitionEntry,
        );
      }
    }
  }
}

function buildObjectSchema(
  value: unknown,
  context: ConversionContext,
): LooseJsonObjectSchema | undefined {
  const shape = readShape(value);
  if (!shape) {
    return undefined;
  }

  const properties: Record<string, JsonSchemaDefinitionEntry> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const { schema, optional } = convertProperty(field, context);
    if (!schema) {
      return undefined;
    }

    const description = readZodDescription(field);
    if (
      description &&
      typeof schema === 'object' &&
      schema !== null &&
      !('description' in schema)
    ) {
      (schema as JsonSchemaDefinitionEntry).description = description;
    }
    properties[key] = schema;
    if (!optional) {
      required.push(key);
    }
  }

  const schema: LooseJsonObjectSchema = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
  const description = readZodDescription(value);
  if (description) {
    schema.description = description;
  }
  return schema;
}

function convertProperty(
  value: unknown,
  context: ConversionContext,
): {
  schema?: JsonSchemaDefinitionEntry;
  optional: boolean;
} {
  if (
    context.lowerObjectIntersections &&
    hasUnsupportedStrictFallbackDecorator(value)
  ) {
    context.losslessForWholeSchemaFallback = false;
  }
  // Remove wrapper decorators (brand, transform, etc.) before attempting to
  // classify the node, tracking whether we crossed an `optional` boundary so we
  // can populate the `required` array later.
  let current = unwrapDecorators(value);
  let optional = false;

  while (OPTIONAL_WRAPPERS.has(readZodType(current) ?? '')) {
    optional = true;
    const def = readZodDefinition(current);
    const next = unwrapDecorators(def?.innerType);
    if (!next || next === current) {
      break;
    }
    current = next;
  }

  return { schema: convertSchema(current, context), optional };
}

function convertSchema(
  value: unknown,
  context: ConversionContext,
): JsonSchemaDefinitionEntry | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    context.lowerObjectIntersections &&
    hasUnsupportedStrictFallbackDecorator(value)
  ) {
    context.losslessForWholeSchemaFallback = false;
  }

  const unwrapped = unwrapDecorators(value);
  const type = readZodType(unwrapped);
  const def = readZodDefinition(unwrapped);

  if (!type) {
    return undefined;
  }
  if (
    context.lowerObjectIntersections &&
    !isLosslessStrictFallbackNode(type, def)
  ) {
    context.losslessForWholeSchemaFallback = false;
  }

  let schema: JsonSchemaDefinitionEntry | undefined;
  if (type in SIMPLE_TYPE_MAPPING) {
    schema = { ...SIMPLE_TYPE_MAPPING[type] };
  } else {
    switch (type) {
      case 'object':
        schema = buildObjectSchema(unwrapped, context);
        break;
      case 'array':
        schema = buildArraySchema(def, context);
        break;
      case 'tuple':
        schema = buildTupleSchema(def, context);
        break;
      case 'union':
      case 'discriminatedunion':
        schema = buildUnionSchema(def, context);
        break;
      case 'intersection':
        schema = buildIntersectionSchema(def, context);
        break;
      case 'literal':
        schema = buildLiteral(def);
        break;
      case 'enum':
      case 'nativeenum':
        schema = buildEnum(def);
        break;
      case 'record':
        schema = buildRecordSchema(def, context);
        break;
      case 'nullable':
        schema = buildNullableSchema(def, context);
        break;
      default:
        return undefined;
    }
  }

  const description = readZodDescription(value);
  if (schema && description) {
    schema.description = description;
  }
  return schema;
}

// --- JSON Schema builders -------------------------------------------------

function buildArraySchema(
  def: Record<string, unknown> | undefined,
  context: ConversionContext,
): JsonSchemaDefinitionEntry | undefined {
  const items = convertSchema(
    extractFirst(def, 'element', 'items', 'type'),
    context,
  );
  return items ? { type: 'array', items } : undefined;
}

function buildTupleSchema(
  def: Record<string, unknown> | undefined,
  context: ConversionContext,
): JsonSchemaDefinitionEntry | undefined {
  const items = convertAllOrFail(coerceArray(def?.items), context);
  if (!items || !items.length) {
    return undefined;
  }
  const schema: JsonSchemaDefinitionEntry = {
    type: 'array',
    items,
    minItems: items.length,
  };
  if (!def?.rest) {
    schema.maxItems = items.length;
  }
  return schema;
}

function buildUnionSchema(
  def: Record<string, unknown> | undefined,
  context: ConversionContext,
): JsonSchemaDefinitionEntry | undefined {
  const options = convertAllOrFail(
    coerceArray(def?.options ?? def?.schemas),
    context,
  );
  return options && options.length ? { anyOf: options } : undefined;
}

/**
 * Converts every member or fails the whole collection. Silently dropping an
 * unconvertible member would emit a schema that looks valid but forbids
 * outputs the Zod schema accepts — e.g. a discriminated-union action variant
 * containing `z.preprocess` disappears from the union, so a model constrained
 * by the emitted schema can never produce that action. Returning `undefined`
 * propagates the failure so callers surface a descriptive error instead.
 */
function convertAllOrFail(
  members: unknown[],
  context: ConversionContext,
): JsonSchemaDefinitionEntry[] | undefined {
  const converted: JsonSchemaDefinitionEntry[] = [];
  for (const member of members) {
    const schema = convertSchema(member, context);
    if (!schema) {
      return undefined;
    }
    converted.push(schema);
  }
  return converted;
}

function buildIntersectionSchema(
  def: Record<string, unknown> | undefined,
  context: ConversionContext,
): JsonSchemaDefinitionEntry | undefined {
  const leftSource = def?.left;
  const rightSource = def?.right;
  const left = convertSchema(leftSource, context);
  const right = convertSchema(rightSource, context);
  if (!left || !right) {
    return undefined;
  }
  if (!context.lowerObjectIntersections) {
    return { allOf: [left, right] };
  }

  // OpenAI Structured Outputs does not support `allOf`. The strict tool path
  // therefore lowers only closed object intersections that can be represented
  // without changing what the authoritative Zod parser forwards to the tool.
  if (
    !isClosedZodObjectIntersectionOperand(leftSource) ||
    !isClosedZodObjectIntersectionOperand(rightSource)
  ) {
    const mergedPrimitive = mergePrimitiveIntersectionSchemas(left, right);
    if (mergedPrimitive) {
      context.loweredPrimitiveIntersection = true;
      return mergedPrimitive;
    }
    context.losslessForWholeSchemaFallback = false;
    return { allOf: [left, right] };
  }
  const merged = mergeObjectIntersectionSchemas(left, right);
  if (!merged) {
    throwUnsupportedZodIntersection();
  }
  context.loweredObjectIntersection = true;
  return merged;
}

function buildRecordSchema(
  def: Record<string, unknown> | undefined,
  context: ConversionContext,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType ?? def?.values, context);
  return valueSchema
    ? { type: 'object', additionalProperties: valueSchema }
    : undefined;
}

function buildNullableSchema(
  def: Record<string, unknown> | undefined,
  context: ConversionContext,
): JsonSchemaDefinitionEntry | undefined {
  const inner = convertSchema(def?.innerType ?? def?.type, context);
  return inner ? { anyOf: [inner, { type: 'null' }] } : undefined;
}

function isClosedZodObjectIntersectionOperand(value: unknown): boolean {
  const unwrapped = unwrapDecorators(value);
  const type = readZodType(unwrapped);
  if (type === 'intersection') {
    return true;
  }
  if (type !== 'object') {
    return false;
  }

  const def = readZodDefinition(unwrapped);
  const catchall = def?.catchall;
  // Zod v3 strict object intersections reject the other branch's distinct
  // properties during parsing, so flattening them would widen the provider
  // schema beyond what the authoritative parser accepts.
  if (
    !def ||
    def.unknownKeys === 'strict' ||
    def.unknownKeys === 'passthrough' ||
    (typeof catchall !== 'undefined' && readZodType(catchall) !== 'never')
  ) {
    throwUnsupportedZodIntersection();
  }
  return true;
}

function mergeObjectIntersectionSchemas(
  left: JsonSchemaDefinitionEntry,
  right: JsonSchemaDefinitionEntry,
): JsonSchemaDefinitionEntry | undefined {
  if (!isClosedJsonObjectSchema(left) || !isClosedJsonObjectSchema(right)) {
    return undefined;
  }

  const properties = { ...left.properties };
  for (const [key, value] of Object.entries(right.properties)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      return undefined;
    }
    properties[key] = value;
  }

  const required = new Set<string>();
  for (const schema of [left, right]) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        required.add(String(key));
      }
    }
  }
  const descriptions = [left.description, right.description].filter(
    (description): description is string => typeof description === 'string',
  );
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
    ...(descriptions.length > 0
      ? { description: descriptions.join('\n\n') }
      : {}),
  };
}

function mergePrimitiveIntersectionSchemas(
  left: JsonSchemaDefinitionEntry,
  right: JsonSchemaDefinitionEntry,
): JsonSchemaDefinitionEntry | undefined {
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null ||
    typeof left.type !== 'string' ||
    left.type !== right.type ||
    !['string', 'number', 'boolean'].includes(left.type) ||
    Object.keys(left).some((key) => !['type', 'description'].includes(key)) ||
    Object.keys(right).some((key) => !['type', 'description'].includes(key))
  ) {
    return undefined;
  }

  const descriptions = [left.description, right.description].filter(
    (description): description is string => typeof description === 'string',
  );
  return {
    type: left.type,
    ...(descriptions.length > 0
      ? { description: descriptions.join('\n\n') }
      : {}),
  };
}

function isClosedJsonObjectSchema(
  value: JsonSchemaDefinitionEntry,
): value is JsonSchemaDefinitionEntry & {
  type: 'object';
  properties: Record<string, JsonSchemaDefinitionEntry>;
  required?: unknown[];
  additionalProperties: false;
  description?: string;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'object' &&
    typeof value.properties === 'object' &&
    value.properties !== null &&
    value.additionalProperties === false
  );
}

function throwUnsupportedZodIntersection(): never {
  throw new UserError(
    'Cannot convert this Zod intersection to an OpenAI strict schema. Use compatible Zod object intersections with distinct properties and closed object branches, combine the fields into one Zod object, or disable strict mode.',
  );
}

function hasUnsupportedStrictFallbackDecorator(value: unknown): boolean {
  let current = value;
  while (true) {
    const type = readZodType(current);
    if (!type) {
      return false;
    }
    if (OPTIONAL_WRAPPERS.has(type)) {
      const inner = readZodDefinition(current)?.innerType;
      if (!inner || inner === current) {
        return false;
      }
      current = inner;
      continue;
    }
    if (!DECORATOR_WRAPPERS.has(type)) {
      return false;
    }
    if (!LOSSLESS_STRICT_FALLBACK_DECORATORS.has(type)) {
      return true;
    }
    const def = readZodDefinition(current);
    const next =
      def?.innerType ??
      def?.schema ??
      def?.base ??
      def?.type ??
      def?.wrapped ??
      def?.underlying;
    if (!next || next === current) {
      return true;
    }
    current = next;
  }
}

function isLosslessStrictFallbackNode(
  type: string,
  def: Record<string, unknown> | undefined,
): boolean {
  if (!def) {
    return false;
  }
  if (Array.isArray(def.checks) && def.checks.length > 0) {
    return false;
  }
  if (typeof def.check === 'string') {
    return false;
  }
  if (
    type === 'array' &&
    [def.minLength, def.maxLength, def.exactLength].some(
      (constraint) => constraint !== null && constraint !== undefined,
    )
  ) {
    return false;
  }
  if (type === 'tuple' && typeof def.rest !== 'undefined') {
    return false;
  }
  if (type === 'record') {
    return false;
  }
  if (type === 'object') {
    const catchall = def.catchall;
    return (
      def.unknownKeys !== 'passthrough' &&
      (typeof catchall === 'undefined' || readZodType(catchall) === 'never')
    );
  }
  return true;
}

function unwrapDecorators(value: unknown): unknown {
  let current = value;
  while (DECORATOR_WRAPPERS.has(readZodType(current) ?? '')) {
    const def = readZodDefinition(current);
    const next =
      def?.innerType ??
      def?.schema ??
      def?.base ??
      def?.type ??
      def?.wrapped ??
      def?.underlying;
    if (!next || next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function extractFirst(
  def: Record<string, unknown> | undefined,
  ...keys: string[]
): unknown {
  if (!def) {
    return undefined;
  }
  for (const key of keys) {
    if (key in def && def[key] !== undefined) {
      return (def as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

function buildLiteral(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  if (!def) {
    return undefined;
  }
  const literal = extractFirst(def, 'value', 'literal') as
    string | number | boolean | null | undefined;
  if (literal === undefined && Array.isArray(def.values)) {
    const values = def.values as Array<string | number | boolean | null>;
    if (values.length === 1) {
      const [value] = values;
      return {
        const: value,
        type: value === null ? 'null' : typeof value,
      };
    }
    if (values.length > 1) {
      return {
        enum: values,
        type: [
          ...new Set(
            values.map((value) => (value === null ? 'null' : typeof value)),
          ),
        ],
      };
    }
  }
  if (literal === undefined) {
    return undefined;
  }
  return {
    const: literal,
    type: literal === null ? 'null' : typeof literal,
  };
}

function buildEnum(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  if (!def) {
    return undefined;
  }
  let values: unknown[] | undefined;
  if (Array.isArray(def.values)) {
    // Zod v3 z.enum() — values is a string array
    values = def.values as unknown[];
  } else if (def.entries && typeof def.entries === 'object') {
    // Zod v4 z.enum() / z.nativeEnum() — entries is an object
    values = resolveNativeEnumValues(def.entries as Record<string, unknown>);
  } else if (Array.isArray(def.options)) {
    values = def.options as unknown[];
  } else if (def.values && typeof def.values === 'object') {
    // Zod v3 z.nativeEnum() — values is the TS enum object
    values = resolveNativeEnumValues(def.values as Record<string, unknown>);
  } else if (def.enum && typeof def.enum === 'object') {
    // Fallback for alternative Zod internals
    values = resolveNativeEnumValues(def.enum as Record<string, unknown>);
  }
  if (!values || !values.length) {
    return undefined;
  }
  // @see https://github.com/StefanTerdell/zod-to-json-schema/blob/master/src/parsers/enum.ts
  const parsedTypes = Array.from(new Set(values.map((v) => typeof v)));
  const type =
    parsedTypes.length === 1
      ? parsedTypes[0] === 'string'
        ? 'string'
        : 'number'
      : ['string', 'number'];
  return { type, enum: values };
}

/**
 * Filter TypeScript's reverse-mapping keys from numeric native enums.
 * e.g. `enum E { A = 0 }` compiles to `{ A: 0, "0": "A" }` — keep only forward mappings.
 * @see https://github.com/StefanTerdell/zod-to-json-schema/blob/master/src/parsers/nativeEnum.ts#L12-L15
 */
function resolveNativeEnumValues(enumObj: Record<string, unknown>): unknown[] {
  const actualKeys = Object.keys(enumObj).filter(
    (key) => typeof enumObj[enumObj[key] as string] !== 'number',
  );
  return actualKeys.map((key) => enumObj[key]);
}

function readShape(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as ShapeCandidate;
  if (candidate.shape && typeof candidate.shape === 'object') {
    return candidate.shape;
  }
  if (typeof candidate.shape === 'function') {
    try {
      return candidate.shape();
    } catch (_error) {
      return undefined;
    }
  }

  const def = readZodDefinition(candidate);
  const shape = def?.shape;
  if (shape && typeof shape === 'object') {
    return shape as Record<string, unknown>;
  }
  if (typeof shape === 'function') {
    try {
      return shape();
    } catch (_error) {
      return undefined;
    }
  }

  return undefined;
}
