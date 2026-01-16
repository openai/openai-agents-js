import type { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../types';
import type { ZodObjectLike } from './zodCompat';
import { readZodDefinition, readZodType } from './zodCompat';

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
};

type ShapeCandidate = {
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
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

// Primitive leaf nodes map 1:1 to JSON Schema types; everything else is handled
// by the specialised builders further down.
const SIMPLE_TYPE_MAPPING: Record<string, JsonSchemaDefinitionEntry> = {
  string: { type: 'string' },
  number: { type: 'number' },
  bigint: { type: 'integer' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
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
  // Attempt to build an object schema from Zod's internal shape. If we cannot
  // understand the structure we return undefined, letting callers raise a
  // descriptive error instead of emitting an invalid schema.
  const schema = buildObjectSchema(input);
  if (!schema) {
    return undefined;
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

  return schema as JsonObjectSchema<Record<string, JsonSchemaDefinitionEntry>>;
}

function buildObjectSchema(value: unknown): LooseJsonObjectSchema | undefined {
  const shape = readShape(value);
  if (!shape) {
    return undefined;
  }

  const properties: Record<string, JsonSchemaDefinitionEntry> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const { schema, optional } = convertProperty(field);
    if (!schema) {
      return undefined;
    }

    properties[key] = schema;
    if (!optional) {
      required.push(key);
    }
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

function convertProperty(value: unknown): {
  schema?: JsonSchemaDefinitionEntry;
  optional: boolean;
} {
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

  return { schema: convertSchema(current), optional };
}

function convertSchema(value: unknown): JsonSchemaDefinitionEntry | undefined {
  if (value === undefined) {
    return undefined;
  }

  const unwrapped = unwrapDecorators(value);
  const type = readZodType(unwrapped);
  const def = readZodDefinition(unwrapped);

  if (!type) {
    return undefined;
  }

  if (type in SIMPLE_TYPE_MAPPING) {
    return SIMPLE_TYPE_MAPPING[type];
  }

  switch (type) {
    case 'object':
      return buildObjectSchema(unwrapped);
    case 'array':
      return buildArraySchema(def);
    case 'tuple':
      return buildTupleSchema(def);
    case 'union':
      return buildUnionSchema(def);
    case 'intersection':
      return buildIntersectionSchema(def);
    case 'literal':
      return buildLiteral(def);
    case 'enum':
    case 'nativeenum':
      return buildEnum(def);
    case 'record':
      return buildRecordSchema(def);
    case 'map':
      return buildMapSchema(def);
    case 'set':
      return buildSetSchema(def);
    case 'nullable':
      return buildNullableSchema(def);
    default:
      return undefined;
  }
}

// --- JSON Schema builders -------------------------------------------------

function buildArraySchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const items = convertSchema(extractFirst(def, 'element', 'items', 'type'));
  return items ? { type: 'array', items } : undefined;
}

function buildTupleSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const items = coerceArray(def?.items)
    .map((item) => convertSchema(item))
    .filter(Boolean) as JsonSchemaDefinitionEntry[];
  if (!items.length) {
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
): JsonSchemaDefinitionEntry | undefined {
  const options = coerceArray(def?.options ?? def?.schemas)
    .map((option) => convertSchema(option))
    .filter(Boolean) as JsonSchemaDefinitionEntry[];
  return options.length ? { anyOf: options } : undefined;
}

function buildIntersectionSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const left = convertSchema(def?.left);
  const right = convertSchema(def?.right);
  return left && right ? { allOf: [left, right] } : undefined;
}

function buildRecordSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType ?? def?.values);
  return valueSchema
    ? { type: 'object', additionalProperties: valueSchema }
    : undefined;
}

function buildMapSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType ?? def?.values);
  return valueSchema ? { type: 'array', items: valueSchema } : undefined;
}

function buildSetSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType);
  return valueSchema
    ? { type: 'array', items: valueSchema, uniqueItems: true }
    : undefined;
}

function buildNullableSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const inner = convertSchema(def?.innerType ?? def?.type);
  return inner ? { anyOf: [inner, { type: 'null' }] } : undefined;
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
    | string
    | number
    | boolean
    | null
    | undefined;
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
  if (Array.isArray(def.values)) {
    return { enum: def.values as unknown[] };
  }
  if (def.entries && typeof def.entries === 'object') {
    return { enum: Object.values(def.entries as Record<string, unknown>) };
  }
  if (Array.isArray(def.options)) {
    return { enum: def.options as unknown[] };
  }
  if (def.values && typeof def.values === 'object') {
    return { enum: Object.values(def.values as Record<string, unknown>) };
  }
  if (def.enum && typeof def.enum === 'object') {
    return { enum: Object.values(def.enum as Record<string, unknown>) };
  }
  return undefined;
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
