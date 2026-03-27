import { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../types';
import {
  analyzeDiscriminatedObjectUnion,
  DiscriminatedObjectUnionVariant as ObjectUnionVariant,
  isSchemaObject,
  JsonSchemaProperties,
  JsonSchemaRecord,
  LiteralValue,
} from './generatedJsonSchemaUnion';
import {
  getComparableSchemaFingerprint,
  schemasAreEquivalent,
} from './jsonSchemaComparison';

type MergedVariantProperties = {
  properties: JsonSchemaProperties;
  required: string[];
};

type MergedVariantProperty = {
  required: boolean;
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

  const analysis = analyzeDiscriminatedObjectUnion(anyOf);
  if (!analysis) {
    return undefined;
  }

  const mergedProperties = mergeVariantProperties(
    analysis.variants,
    analysis.discriminatorKey,
  );
  if (!mergedProperties) {
    return undefined;
  }

  const mergedAdditionalProperties = mergeAdditionalProperties(
    analysis.variants,
  );
  if (!mergedAdditionalProperties.mergeable) {
    return undefined;
  }

  const loweredSchema: JsonSchemaRecord = {
    ...schema,
    type: 'object',
    properties: mergedProperties.properties,
    required: mergedProperties.required,
  };

  if (mergedAdditionalProperties.hasAdditionalProperties) {
    loweredSchema.additionalProperties =
      mergedAdditionalProperties.additionalProperties;
  } else {
    delete loweredSchema.additionalProperties;
  }

  delete loweredSchema.anyOf;
  return loweredSchema;
}

function mergeVariantProperties(
  variants: ObjectUnionVariant[],
  discriminatorKey: string,
): MergedVariantProperties | undefined {
  const propertyNames = collectPropertyNames(variants, discriminatorKey);
  const mergedProperties: JsonSchemaProperties = {};
  const requiredProperties: string[] = [];

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
      requiredProperties.push(propertyName);
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
    mergedProperties[propertyName] = mergedProperty.schema;
    if (mergedProperty.required) {
      requiredProperties.push(propertyName);
    }
  }

  return {
    properties: mergedProperties,
    required: requiredProperties,
  };
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
): MergedVariantProperty | undefined {
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

  const requiredInEveryPresentVariant = variantsWithProperty.every((variant) =>
    isPropertyRequired(variant.schema, propertyName),
  );

  if (variantsWithProperty.length === variants.length) {
    return {
      schema: mergedProperty,
      required: requiredInEveryPresentVariant,
    };
  }

  if (!requiredInEveryPresentVariant) {
    return {
      schema: mergedProperty,
      required: false,
    };
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
  return {
    schema: nullableProperty,
    required: true,
  };
}

function mergeCompatiblePropertySchemas(
  schemas: JsonSchemaRecord[],
): JsonSchemaRecord | undefined {
  if (schemas.length === 0) {
    return undefined;
  }

  const normalizedReference = getComparableSchemaFingerprint(schemas[0]);
  for (const schema of schemas.slice(1)) {
    if (getComparableSchemaFingerprint(schema) !== normalizedReference) {
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
  if ('$ref' in schema || Array.isArray(schema.allOf)) {
    return undefined;
  }

  const compositionalNullableSchema = makeCompositionalSchemaNullable(schema);
  if (compositionalNullableSchema) {
    return compositionalNullableSchema;
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

function makeCompositionalSchemaNullable(
  schema: JsonSchemaRecord,
): JsonSchemaRecord | undefined {
  if (!Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf)) {
    return undefined;
  }

  const keyword = Array.isArray(schema.anyOf) ? 'anyOf' : 'oneOf';
  const entries = structuredClone(schema[keyword]) as unknown[];
  if (entries.some(isNullTypeSchema)) {
    const nullableSchema = structuredClone(schema);
    if (keyword === 'oneOf') {
      nullableSchema.anyOf = entries;
      delete nullableSchema.oneOf;
    }
    return nullableSchema;
  }

  const nullableSchema = structuredClone(schema);
  nullableSchema.anyOf = [...entries, { type: 'null' }];
  if (keyword === 'oneOf') {
    delete nullableSchema.oneOf;
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

function mergeAdditionalProperties(variants: ObjectUnionVariant[]):
  | {
      mergeable: true;
      hasAdditionalProperties: boolean;
      additionalProperties?: unknown;
    }
  | { mergeable: false } {
  const firstVariant = variants[0];
  const hasAdditionalProperties = Object.prototype.hasOwnProperty.call(
    firstVariant.schema,
    'additionalProperties',
  );
  const referenceAdditionalProperties =
    firstVariant.schema.additionalProperties;

  for (const variant of variants.slice(1)) {
    const hasCurrentAdditionalProperties = Object.prototype.hasOwnProperty.call(
      variant.schema,
      'additionalProperties',
    );
    if (hasCurrentAdditionalProperties !== hasAdditionalProperties) {
      return { mergeable: false };
    }
    if (
      hasAdditionalProperties &&
      !schemasAreEquivalent(
        variant.schema.additionalProperties,
        referenceAdditionalProperties,
      )
    ) {
      return { mergeable: false };
    }
  }

  if (!hasAdditionalProperties) {
    return {
      mergeable: true,
      hasAdditionalProperties: false,
    };
  }

  return {
    mergeable: true,
    hasAdditionalProperties: true,
    additionalProperties: structuredClone(referenceAdditionalProperties),
  };
}

function isPropertyRequired(
  schema: JsonSchemaRecord,
  propertyName: string,
): boolean {
  return (
    Array.isArray(schema.required) && schema.required.includes(propertyName)
  );
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

function isNullTypeSchema(value: unknown): boolean {
  return isSchemaObject(value) && value.type === 'null';
}
