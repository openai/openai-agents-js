import type { ZodObject } from 'zod';
import type { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../types';

type ZodDefinition = Record<string, unknown> | undefined;
type ZodLike = {
  _def?: Record<string, unknown>;
  def?: Record<string, unknown>;
  _zod?: { def?: Record<string, unknown> };
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
};

type LooseJsonObjectSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaDefinitionEntry>;
  required?: string[];
  additionalProperties?: boolean;
  $schema?: string;
};

const JSON_SCHEMA_DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const OPTIONAL_WRAPPERS = new Set(['optional']);
const DECORATOR_WRAPPERS = new Set([
  'brand',
  'catch',
  'default',
  'effects',
  'pipeline',
  'prefault',
  'readonly',
  'refinement',
  'transform',
]);

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

export function fallbackJsonSchemaFromZodObject(
  input: ZodObject<any>,
): JsonObjectSchema<any> | undefined {
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
  let current = unwrapDecorators(value);
  let optional = false;

  while (OPTIONAL_WRAPPERS.has(readType(current) ?? '')) {
    optional = true;
    const def = readDefinition(current);
    const next = unwrapDecorators(def?.innerType);
    if (!next || next === current) {
      break;
    }
    current = next;
  }

  return { schema: convertSchema(current), optional };
}

function convertSchema(value: unknown): JsonSchemaDefinitionEntry | undefined {
  const type = readType(value);
  const def = readDefinition(value);

  switch (type) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'bigint':
      return { type: 'integer' };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date-time' };
    case 'literal': {
      const literal = (def?.value ?? def?.literal) as
        | string
        | number
        | boolean
        | null;
      return literal === undefined
        ? undefined
        : { const: literal, type: literal === null ? 'null' : typeof literal };
    }
    case 'enum':
    case 'nativeenum': {
      const values = ((Array.isArray(def?.values) && def?.values) ||
        (Array.isArray(def?.options) && def?.options) ||
        (def?.values &&
          typeof def?.values === 'object' &&
          Object.values(def.values)) ||
        (def?.enum &&
          typeof def?.enum === 'object' &&
          Object.values(def.enum))) as unknown[] | undefined;
      return values && values.length
        ? { enum: values as unknown[] }
        : undefined;
    }
    case 'array': {
      const element = def?.element ?? def?.items ?? def?.type;
      const items = convertSchema(element);
      return items ? { type: 'array', items } : undefined;
    }
    case 'tuple': {
      const tupleItems = Array.isArray(def?.items) ? def?.items : [];
      const converted = tupleItems
        .map((item) => convertSchema(item))
        .filter(Boolean) as JsonSchemaDefinitionEntry[];
      if (!converted.length) {
        return undefined;
      }
      const schema: JsonSchemaDefinitionEntry = {
        type: 'array',
        items: converted,
        minItems: converted.length,
      };
      if (!def?.rest) {
        schema.maxItems = converted.length;
      }
      return schema;
    }
    case 'union': {
      const options =
        (Array.isArray(def?.options) && def?.options) ||
        (Array.isArray(def?.schemas) && def?.schemas);
      if (!options) {
        return undefined;
      }
      const anyOf = options
        .map((option) => convertSchema(option))
        .filter(Boolean) as JsonSchemaDefinitionEntry[];
      return anyOf.length ? { anyOf } : undefined;
    }
    case 'intersection': {
      const left = convertSchema(def?.left);
      const right = convertSchema(def?.right);
      return left && right ? { allOf: [left, right] } : undefined;
    }
    case 'record': {
      const valueSchema = convertSchema(def?.valueType ?? def?.values);
      return valueSchema
        ? { type: 'object', additionalProperties: valueSchema }
        : undefined;
    }
    case 'map': {
      const valueSchema = convertSchema(def?.valueType ?? def?.values);
      return valueSchema ? { type: 'array', items: valueSchema } : undefined;
    }
    case 'set': {
      const valueSchema = convertSchema(def?.valueType);
      return valueSchema
        ? { type: 'array', items: valueSchema, uniqueItems: true }
        : undefined;
    }
    case 'nullable': {
      const inner = convertSchema(def?.innerType ?? def?.type);
      return inner ? { anyOf: [inner, { type: 'null' }] } : undefined;
    }
    case 'object':
      return buildObjectSchema(value);
    default:
      return undefined;
  }
}

function readDefinition(input: unknown): ZodDefinition {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const candidate = input as ZodLike;
  return candidate._zod?.def || candidate._def || candidate.def;
}

function readType(input: unknown): string | undefined {
  const def = readDefinition(input);
  const rawType =
    (typeof def?.typeName === 'string' && def?.typeName) ||
    (typeof def?.type === 'string' && def?.type);
  if (!rawType) {
    return undefined;
  }
  const lower = rawType.toLowerCase();
  return lower.startsWith('zod') ? lower.slice(3) : lower;
}

function unwrapDecorators(value: unknown): unknown {
  let current = value;
  while (DECORATOR_WRAPPERS.has(readType(current) ?? '')) {
    const def = readDefinition(current);
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

function readShape(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as ZodLike;
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

  const def = readDefinition(candidate);
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
