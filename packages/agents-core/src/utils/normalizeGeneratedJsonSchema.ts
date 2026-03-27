import { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../types';

type JsonSchemaRecord = Record<string, any>;
type JsonSchemaProperties = Record<string, JsonSchemaDefinitionEntry>;
type LiteralValue = string | number | boolean | null;

type ObjectUnionVariant = {
  discriminatorValue: LiteralValue;
  properties: JsonSchemaProperties;
  schema: JsonSchemaRecord;
};

export function normalizeGeneratedJsonSchema<
  T extends JsonObjectSchema<Record<string, JsonSchemaDefinitionEntry>>,
>(schema: T): T {
  const normalized = structuredClone(schema) as JsonSchemaRecord;
  normalizeJsonSchemaNode(normalized);
  return normalized as T;
}

function normalizeJsonSchemaNode(schema: unknown): void {
  if (!isSchemaObject(schema)) {
    return;
  }

  if (isSchemaObject(schema.properties)) {
    for (const propertySchema of Object.values(schema.properties)) {
      normalizeJsonSchemaNode(propertySchema);
    }
  }

  if (Array.isArray(schema.items)) {
    for (const itemSchema of schema.items) {
      normalizeJsonSchemaNode(itemSchema);
    }
  } else {
    normalizeJsonSchemaNode(schema.items);
  }

  if (isSchemaObject(schema.additionalProperties)) {
    normalizeJsonSchemaNode(schema.additionalProperties);
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const entries = schema[keyword];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        normalizeJsonSchemaNode(entry);
      }
    }
  }

  const loweredUnion = lowerDiscriminatedObjectUnion(schema);
  if (loweredUnion) {
    replaceSchema(schema, loweredUnion);
  }
}

function lowerDiscriminatedObjectUnion(
  schema: JsonSchemaRecord,
): JsonSchemaRecord | undefined {
  const anyOf = schema.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length < 2) {
    return undefined;
  }

  const discriminatorKey = findDiscriminatorKey(anyOf);
  if (!discriminatorKey) {
    return undefined;
  }

  const variants = getObjectUnionVariants(anyOf, discriminatorKey);
  if (!variants) {
    return undefined;
  }

  const mergedProperties = mergeVariantProperties(variants, discriminatorKey);
  if (!mergedProperties) {
    return undefined;
  }

  const loweredSchema: JsonSchemaRecord = {
    ...schema,
    type: 'object',
    properties: mergedProperties,
    required: Object.keys(mergedProperties),
    additionalProperties: false,
  };

  delete loweredSchema.anyOf;
  return loweredSchema;
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
): ObjectUnionVariant[] | undefined {
  const variants: ObjectUnionVariant[] = [];

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

function mergeVariantProperties(
  variants: ObjectUnionVariant[],
  discriminatorKey: string,
): JsonSchemaProperties | undefined {
  const propertyNames = collectPropertyNames(variants, discriminatorKey);
  const mergedProperties: JsonSchemaProperties = {};

  for (const propertyName of propertyNames) {
    if (propertyName === discriminatorKey) {
      const mergedDiscriminator = mergeDiscriminatorProperty(
        variants,
        propertyName,
      );
      if (!mergedDiscriminator) {
        return undefined;
      }
      mergedProperties[propertyName] = mergedDiscriminator;
      continue;
    }

    const mergedProperty = mergeVariantProperty(
      variants,
      propertyName,
      discriminatorKey,
    );
    if (!mergedProperty) {
      return undefined;
    }
    mergedProperties[propertyName] = mergedProperty;
  }

  return mergedProperties;
}

function mergeDiscriminatorProperty(
  variants: ObjectUnionVariant[],
  discriminatorKey: string,
): JsonSchemaRecord | undefined {
  const schemas = variants.map(
    (variant) => variant.properties[discriminatorKey] as JsonSchemaRecord,
  );
  const literalValues = variants.map((variant) => variant.discriminatorValue);
  const discriminatorType = inferDiscriminatorType(schemas, literalValues);
  if (!discriminatorType) {
    return undefined;
  }

  const mergedSchema = structuredClone(schemas[0]);
  delete mergedSchema.const;
  if (
    Array.isArray(mergedSchema.enum) &&
    mergedSchema.enum.length === 1 &&
    mergedSchema.enum[0] === literalValues[0]
  ) {
    delete mergedSchema.enum;
  }
  mergedSchema.type = discriminatorType;
  mergedSchema.enum = literalValues;
  return mergedSchema;
}

function mergeVariantProperty(
  variants: ObjectUnionVariant[],
  propertyName: string,
  discriminatorKey: string,
): JsonSchemaRecord | undefined {
  const variantsWithProperty = variants.filter(
    (variant) => propertyName in variant.properties,
  );
  if (variantsWithProperty.length === 0) {
    return undefined;
  }

  const mergedProperty = mergeCompatiblePropertySchemas(
    variantsWithProperty.map(
      (variant) => variant.properties[propertyName] as JsonSchemaRecord,
    ),
  );
  if (!mergedProperty) {
    return undefined;
  }

  if (variantsWithProperty.length === variants.length) {
    return mergedProperty;
  }

  const nullableProperty = makeSchemaNullable(mergedProperty);
  if (!nullableProperty) {
    return undefined;
  }

  nullableProperty.description = appendConditionDescription(
    nullableProperty.description,
    discriminatorKey,
    variantsWithProperty.map((variant) => variant.discriminatorValue),
  );
  return nullableProperty;
}

function mergeCompatiblePropertySchemas(
  schemas: JsonSchemaRecord[],
): JsonSchemaRecord | undefined {
  if (schemas.length === 0) {
    return undefined;
  }

  const normalizedReference = JSON.stringify(
    stripDescriptionFields(schemas[0]),
  );
  for (const schema of schemas.slice(1)) {
    if (
      JSON.stringify(stripDescriptionFields(schema)) !== normalizedReference
    ) {
      return undefined;
    }
  }

  const mergedSchema = structuredClone(schemas[0]);
  const mergedDescription = mergeDescriptions(
    schemas.map((schema) => schema.description),
  );
  if (mergedDescription) {
    mergedSchema.description = mergedDescription;
  }
  return mergedSchema;
}

function makeSchemaNullable(
  schema: JsonSchemaRecord,
): JsonSchemaRecord | undefined {
  if (
    '$ref' in schema ||
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.allOf)
  ) {
    return undefined;
  }

  const nullableSchema = structuredClone(schema);
  const baseType = inferSchemaType(nullableSchema);
  if (!baseType) {
    return undefined;
  }

  if (Array.isArray(nullableSchema.type)) {
    if (!nullableSchema.type.includes('null')) {
      nullableSchema.type = [...nullableSchema.type, 'null'];
    }
  } else if (typeof nullableSchema.type === 'string') {
    if (nullableSchema.type !== 'null') {
      nullableSchema.type = [nullableSchema.type, 'null'];
    }
  } else {
    nullableSchema.type = [baseType, 'null'];
  }

  if ('const' in nullableSchema) {
    nullableSchema.enum = [nullableSchema.const, null];
    delete nullableSchema.const;
    return nullableSchema;
  }

  if (
    Array.isArray(nullableSchema.enum) &&
    !nullableSchema.enum.includes(null)
  ) {
    nullableSchema.enum = [...nullableSchema.enum, null];
  }

  return nullableSchema;
}

function inferDiscriminatorType(
  schemas: JsonSchemaRecord[],
  literalValues: LiteralValue[],
): string | undefined {
  const declaredTypes = schemas
    .map((schema) => schema.type)
    .filter((type): type is string => typeof type === 'string');

  if (
    declaredTypes.length === schemas.length &&
    declaredTypes.every((type) => type === declaredTypes[0])
  ) {
    return declaredTypes[0];
  }

  return inferLiteralType(literalValues);
}

function inferSchemaType(schema: JsonSchemaRecord): string | undefined {
  if (typeof schema.type === 'string') {
    return schema.type;
  }

  if (isSchemaObject(schema.properties)) {
    return 'object';
  }

  if ('items' in schema) {
    return 'array';
  }

  if (Array.isArray(schema.enum)) {
    return inferLiteralType(schema.enum.filter((value) => value !== null));
  }

  if ('const' in schema) {
    return inferLiteralType([schema.const]);
  }

  return undefined;
}

function inferLiteralType(values: unknown[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const literalTypes = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string') {
      literalTypes.add('string');
      continue;
    }
    if (typeof value === 'boolean') {
      literalTypes.add('boolean');
      continue;
    }
    if (typeof value === 'number') {
      literalTypes.add(Number.isInteger(value) ? 'integer' : 'number');
      continue;
    }
    if (value === null) {
      literalTypes.add('null');
      continue;
    }
    return undefined;
  }

  return literalTypes.size === 1 ? [...literalTypes][0] : undefined;
}

function collectPropertyNames(
  variants: ObjectUnionVariant[],
  discriminatorKey: string,
): string[] {
  const propertyNames: string[] = [];
  const seen = new Set<string>();

  for (const variant of variants) {
    for (const propertyName of Object.keys(variant.properties)) {
      if (seen.has(propertyName)) {
        continue;
      }
      seen.add(propertyName);
      propertyNames.push(propertyName);
    }
  }

  propertyNames.sort((left, right) => {
    if (left === discriminatorKey) {
      return -1;
    }
    if (right === discriminatorKey) {
      return 1;
    }
    return 0;
  });

  return propertyNames;
}

function appendConditionDescription(
  description: unknown,
  discriminatorKey: string,
  values: LiteralValue[],
): string {
  const condition =
    values.length === 1
      ? `${discriminatorKey} is ${formatLiteralValue(values[0])}`
      : `${discriminatorKey} is one of ${values
          .map((value) => formatLiteralValue(value))
          .join(', ')}`;
  const suffix = `Set to null unless ${condition}.`;

  if (typeof description !== 'string' || description.trim().length === 0) {
    return suffix;
  }

  const trimmed = description.trim();
  const prefix = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `${prefix} ${suffix}`;
}

function mergeDescriptions(descriptions: unknown[]): string | undefined {
  const uniqueDescriptions = [
    ...new Set(
      descriptions.filter(
        (description): description is string =>
          typeof description === 'string' && description.trim().length > 0,
      ),
    ),
  ];

  if (uniqueDescriptions.length === 0) {
    return undefined;
  }

  return uniqueDescriptions.join(' ');
}

function stripDescriptionFields(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(stripDescriptionFields);
  }

  if (!isSchemaObject(input)) {
    return input;
  }

  const clone = structuredClone(input);
  delete clone.description;
  for (const [key, value] of Object.entries(clone)) {
    clone[key] = stripDescriptionFields(value);
  }
  return clone;
}

function getLiteralValue(schema: unknown): LiteralValue | undefined {
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

function serializeLiteralValue(value: LiteralValue): string {
  return `${typeof value}:${String(value)}`;
}

function formatLiteralValue(value: LiteralValue): string {
  return value === null ? 'null' : JSON.stringify(value);
}

function replaceSchema(
  target: JsonSchemaRecord,
  replacement: JsonSchemaRecord,
) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, replacement);
}

function isObjectSchemaVariant(schema: unknown): schema is {
  type: 'object';
  properties: JsonSchemaProperties;
  required?: string[];
  additionalProperties?: boolean;
} {
  return (
    isSchemaObject(schema) &&
    schema.type === 'object' &&
    isSchemaObject(schema.properties)
  );
}

function isSchemaObject(value: unknown): value is JsonSchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
