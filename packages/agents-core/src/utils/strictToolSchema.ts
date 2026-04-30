import type { JsonObjectSchema } from '../types';
import { readZodDefinition, readZodType } from './zodCompat';

export function toOpenAIStrictToolSchema<T extends JsonObjectSchema<any>>(
  schema: T,
): T {
  return ensureStrictSchemaEntry(structuredClone(schema)) as T;
}

function ensureStrictSchemaEntry(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }

  const record = entry as Record<string, unknown>;

  if (
    record.type === 'object' &&
    typeof record.properties === 'object' &&
    record.properties !== null &&
    !Array.isArray(record.properties)
  ) {
    const properties = record.properties as Record<string, unknown>;
    const originalRequired = new Set(
      Array.isArray(record.required) ? record.required.map(String) : [],
    );

    for (const [key, value] of Object.entries(properties)) {
      const normalized = ensureStrictSchemaEntry(value);
      properties[key] = originalRequired.has(key)
        ? normalized
        : wrapNullableSchema(normalized);
    }

    record.required = Object.keys(properties);
    record.additionalProperties = false;
  }

  for (const key of ['$defs', 'definitions']) {
    const nested = record[key];
    if (
      typeof nested === 'object' &&
      nested !== null &&
      !Array.isArray(nested)
    ) {
      for (const [nestedKey, nestedValue] of Object.entries(
        nested as Record<string, unknown>,
      )) {
        (nested as Record<string, unknown>)[nestedKey] =
          ensureStrictSchemaEntry(nestedValue);
      }
    }
  }

  for (const key of ['anyOf', 'allOf', 'oneOf']) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      record[key] = nested.map((value) => ensureStrictSchemaEntry(value));
    }
  }

  const items = record.items;
  if (Array.isArray(items)) {
    record.items = items.map((value) => ensureStrictSchemaEntry(value));
  } else if (typeof items === 'object' && items !== null) {
    record.items = ensureStrictSchemaEntry(items);
  }

  if (record.default === null) {
    delete record.default;
  }

  return record;
}

function wrapNullableSchema(schema: unknown): unknown {
  if (
    typeof schema !== 'object' ||
    schema === null ||
    isSchemaNullable(schema as Record<string, unknown>)
  ) {
    return schema;
  }

  const description =
    typeof (schema as { description?: unknown }).description === 'string'
      ? { description: (schema as { description: string }).description }
      : {};

  return {
    ...description,
    anyOf: [schema, { type: 'null' }],
  };
}

function isSchemaNullable(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === 'null') {
    return true;
  }
  if (Array.isArray(type) && type.includes('null')) {
    return true;
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const entries = schema[key];
    if (
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          isSchemaNullable(entry as Record<string, unknown>),
      )
    ) {
      return true;
    }
  }

  return false;
}

export function stripStrictNullsForJsonSchema(
  schema: unknown,
  value: unknown,
  optionalProperty: boolean = false,
): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    if (optionalProperty && !jsonSchemaAllowsNull(schema)) {
      return undefined;
    }
    return value;
  }

  if (Array.isArray(value)) {
    const schemaRecord = isRecord(schema) ? schema : undefined;
    const items = schemaRecord?.items;
    if (Array.isArray(items)) {
      return value.map((entry, index) =>
        stripStrictNullsForJsonSchema(items[index], entry),
      );
    }
    if (items && typeof items === 'object') {
      return value.map((entry) => stripStrictNullsForJsonSchema(items, entry));
    }
    return value;
  }

  if (!isRecord(value) || !isJsonSchemaObject(schema)) {
    return value;
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  const normalized: Record<string, unknown> = { ...value };

  for (const [key, propertySchema] of Object.entries(properties)) {
    const nextValue = stripStrictNullsForJsonSchema(
      propertySchema,
      normalized[key],
      !required.has(key),
    );
    if (typeof nextValue === 'undefined') {
      delete normalized[key];
    } else {
      normalized[key] = nextValue;
    }
  }

  return normalized;
}

function isJsonSchemaObject(schema: unknown): schema is Record<
  string,
  unknown
> & {
  properties?: Record<string, unknown>;
  required?: unknown[];
} {
  if (!isRecord(schema)) {
    return false;
  }

  return (
    schema.type === 'object' ||
    (isRecord(schema.properties) && !Array.isArray(schema.properties))
  );
}

function jsonSchemaAllowsNull(schema: unknown): boolean {
  return isRecord(schema) ? isSchemaNullable(schema) : false;
}

export function stripStrictNullsForZodSchema(
  schema: unknown,
  value: unknown,
): unknown {
  const { inner, optional, nullable } = unwrapZodOptionalNullable(schema);

  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    if (optional && !nullable && !zodSchemaAccepts(inner, null)) {
      return undefined;
    }
    return value;
  }

  const type = readZodType(inner);
  const def = readZodDefinition(inner);

  if ((type === 'union' || type === 'discriminatedunion') && value !== null) {
    for (const option of readZodUnionOptions(def)) {
      const normalized = stripStrictNullsForZodSchema(option, value);
      if (zodSchemaAccepts(option, normalized)) {
        return normalized;
      }
    }
  }

  if (type === 'object' && isRecord(value)) {
    const shape = readShape(inner);
    if (!shape) {
      return value;
    }

    const normalized: Record<string, unknown> = { ...value };
    for (const [key, field] of Object.entries(shape)) {
      const nextValue = stripStrictNullsForZodSchema(field, normalized[key]);
      if (typeof nextValue === 'undefined') {
        delete normalized[key];
      } else {
        normalized[key] = nextValue;
      }
    }
    return normalized;
  }

  if (type === 'array' && Array.isArray(value)) {
    const itemSchema = extractFirst(def, 'element', 'items', 'type');
    return value.map((entry) =>
      stripStrictNullsForZodSchema(itemSchema, entry),
    );
  }

  if (type === 'tuple' && Array.isArray(value)) {
    const items = coerceArray(def?.items);
    return value.map((entry, index) =>
      stripStrictNullsForZodSchema(items[index], entry),
    );
  }

  if (type === 'record' && isRecord(value)) {
    const valueSchema = def?.valueType ?? def?.values;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const normalized = stripStrictNullsForZodSchema(valueSchema, entry);
        return typeof normalized === 'undefined' ? [] : [[key, normalized]];
      }),
    );
  }

  if (type === 'set' && Array.isArray(value)) {
    const valueSchema = def?.valueType;
    return value.map((entry) =>
      stripStrictNullsForZodSchema(valueSchema, entry),
    );
  }

  return value;
}

function unwrapZodOptionalNullable(schema: unknown): {
  inner: unknown;
  optional: boolean;
  nullable: boolean;
} {
  let current = unwrapDecorators(schema);
  let optional = false;
  let nullable = false;
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const type = readZodType(current);
    const def = readZodDefinition(current);

    if (type === 'optional') {
      optional = true;
      const next = unwrapDecorators(def?.innerType);
      if (!next || next === current) {
        break;
      }
      current = next;
      continue;
    }

    if (type === 'nullable') {
      nullable = true;
      const next = unwrapDecorators(def?.innerType ?? def?.type);
      if (!next || next === current) {
        break;
      }
      current = next;
      continue;
    }

    break;
  }

  return { inner: current, optional, nullable };
}

function unwrapDecorators(schema: unknown): unknown {
  let current = schema;
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const type = readZodType(current);
    if (
      !type ||
      !new Set([
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
      ]).has(type)
    ) {
      break;
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
      break;
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
      return def[key];
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

function readZodUnionOptions(
  def: Record<string, unknown> | undefined,
): unknown[] {
  const options = def?.options;
  if (Array.isArray(options)) {
    return options;
  }
  if (options instanceof Map) {
    return [...options.values()];
  }
  if (options && typeof options === 'object') {
    return Object.values(options);
  }

  const optionsMap = def?.optionsMap;
  if (optionsMap instanceof Map) {
    return [...optionsMap.values()];
  }
  if (optionsMap && typeof optionsMap === 'object') {
    return Object.values(optionsMap);
  }

  return [];
}

function zodSchemaAccepts(schema: unknown, value: unknown): boolean {
  const candidate = unwrapDecorators(schema) as {
    safeParse?: (value: unknown) => { success: boolean };
    parse?: (value: unknown) => unknown;
  };

  if (typeof candidate?.safeParse === 'function') {
    try {
      return candidate.safeParse(value).success;
    } catch {
      return false;
    }
  }

  if (typeof candidate?.parse === 'function') {
    try {
      candidate.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function readShape(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as {
    shape?: Record<string, unknown> | (() => Record<string, unknown>);
  };
  if (candidate.shape && typeof candidate.shape === 'object') {
    return candidate.shape;
  }
  if (typeof candidate.shape === 'function') {
    try {
      return candidate.shape();
    } catch {
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
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
