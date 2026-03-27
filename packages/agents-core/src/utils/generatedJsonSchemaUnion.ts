import { JsonSchemaDefinitionEntry } from '../types';

export type JsonSchemaRecord = Record<string, any>;
export type JsonSchemaProperties = Record<string, JsonSchemaDefinitionEntry>;
export type LiteralValue = string | number | boolean | null;

export type DiscriminatedObjectUnionVariant = {
  discriminatorValue: LiteralValue;
  properties: JsonSchemaProperties;
  schema: JsonSchemaRecord;
};

export function analyzeDiscriminatedObjectUnion(anyOf: unknown[]):
  | {
      discriminatorKey: string;
      variants: DiscriminatedObjectUnionVariant[];
    }
  | undefined {
  const discriminatorKey = findDiscriminatorKey(anyOf);
  if (!discriminatorKey) {
    return undefined;
  }

  const variants = getObjectUnionVariants(anyOf, discriminatorKey);
  if (!variants) {
    return undefined;
  }

  return {
    discriminatorKey,
    variants,
  };
}

export function getLiteralValue(schema: unknown): LiteralValue | undefined {
  if (!isSchemaObject(schema)) {
    return undefined;
  }

  if (
    'const' in schema &&
    (typeof schema.const === 'string' ||
      typeof schema.const === 'number' ||
      typeof schema.const === 'boolean' ||
      schema.const === null)
  ) {
    return schema.const;
  }

  if (
    Array.isArray(schema.enum) &&
    schema.enum.length === 1 &&
    (typeof schema.enum[0] === 'string' ||
      typeof schema.enum[0] === 'number' ||
      typeof schema.enum[0] === 'boolean' ||
      schema.enum[0] === null)
  ) {
    return schema.enum[0];
  }

  return undefined;
}

export function isSchemaObject(value: unknown): value is JsonSchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findDiscriminatorKey(anyOf: unknown[]): string | undefined {
  const firstVariant = anyOf[0];
  if (!isObjectSchemaVariant(firstVariant)) {
    return undefined;
  }

  const orderedKeys = Object.keys(firstVariant.properties);
  const candidateKeys = orderedKeys.filter((key) =>
    anyOf.every((variant) => {
      if (!isObjectSchemaVariant(variant)) {
        return false;
      }

      if (!Array.isArray(variant.required) || !variant.required.includes(key)) {
        return false;
      }

      return getLiteralValue(variant.properties[key]) !== undefined;
    }),
  );

  candidateKeys.sort((left, right) => {
    if (left === 'type') {
      return -1;
    }
    if (right === 'type') {
      return 1;
    }
    return 0;
  });

  for (const key of candidateKeys) {
    const serializedValues = new Set(
      anyOf.map((variant) =>
        serializeLiteralValue(
          getLiteralValue((variant as JsonSchemaRecord).properties[key])!,
        ),
      ),
    );
    if (serializedValues.size === anyOf.length) {
      return key;
    }
  }

  return undefined;
}

function getObjectUnionVariants(
  anyOf: unknown[],
  discriminatorKey: string,
): DiscriminatedObjectUnionVariant[] | undefined {
  const variants: DiscriminatedObjectUnionVariant[] = [];

  for (const entry of anyOf) {
    if (!isObjectSchemaVariant(entry)) {
      return undefined;
    }

    const discriminatorValue = getLiteralValue(
      entry.properties[discriminatorKey],
    );
    if (discriminatorValue === undefined) {
      return undefined;
    }

    variants.push({
      discriminatorValue,
      properties: entry.properties,
      schema: entry,
    });
  }

  return variants;
}

function isObjectSchemaVariant(schema: unknown): schema is {
  type: 'object';
  properties: JsonSchemaProperties;
  required?: string[];
  additionalProperties?: unknown;
} {
  return (
    isSchemaObject(schema) &&
    schema.type === 'object' &&
    isSchemaObject(schema.properties)
  );
}

function serializeLiteralValue(value: LiteralValue): string {
  return `${typeof value}:${String(value)}`;
}
