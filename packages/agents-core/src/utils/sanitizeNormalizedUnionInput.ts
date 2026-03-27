import {
  analyzeDiscriminatedObjectUnion,
  DiscriminatedObjectUnionVariant,
  isSchemaObject,
  JsonSchemaRecord,
} from './generatedJsonSchemaUnion';

type SelectedDiscriminatedUnionVariant = {
  branchOnlyPropertyNames: Set<string>;
  normalizedSchema: JsonSchemaRecord;
  variant: DiscriminatedObjectUnionVariant;
};

export function sanitizeNormalizedUnionInput<T>(
  input: T,
  originalSchema: unknown,
  normalizedSchema: unknown,
): T {
  return sanitizeInputForSchema(input, originalSchema, normalizedSchema) as T;
}

function sanitizeInputForSchema(
  input: unknown,
  originalSchema: unknown,
  normalizedSchema: unknown,
): unknown {
  if (Array.isArray(input)) {
    if (!isSchemaObject(originalSchema) && !isSchemaObject(normalizedSchema)) {
      return input;
    }

    const originalItems = isSchemaObject(originalSchema)
      ? originalSchema.items
      : undefined;
    const normalizedItems = isSchemaObject(normalizedSchema)
      ? normalizedSchema.items
      : undefined;

    if (Array.isArray(originalItems) || Array.isArray(normalizedItems)) {
      return input.map((item, index) =>
        sanitizeInputForSchema(
          item,
          Array.isArray(originalItems) ? originalItems[index] : originalItems,
          Array.isArray(normalizedItems)
            ? normalizedItems[index]
            : normalizedItems,
        ),
      );
    }
    return input.map((item) =>
      sanitizeInputForSchema(item, originalItems, normalizedItems),
    );
  }

  if (!isSchemaObject(input)) {
    return input;
  }

  const selectedVariant = selectMatchingDiscriminatedUnionVariant(
    originalSchema,
    normalizedSchema,
    input,
  );
  if (selectedVariant) {
    return sanitizeUnionVariantInput(input, selectedVariant);
  }

  const sanitizedInput = structuredClone(input);
  for (const [key, value] of Object.entries(input)) {
    const originalPropertySchema =
      isSchemaObject(originalSchema) &&
      isSchemaObject(originalSchema.properties) &&
      key in originalSchema.properties
        ? originalSchema.properties[key]
        : undefined;
    const normalizedPropertySchema =
      isSchemaObject(normalizedSchema) &&
      isSchemaObject(normalizedSchema.properties) &&
      key in normalizedSchema.properties
        ? normalizedSchema.properties[key]
        : undefined;

    if (
      typeof originalPropertySchema !== 'undefined' ||
      typeof normalizedPropertySchema !== 'undefined'
    ) {
      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        originalPropertySchema,
        normalizedPropertySchema,
      );
      continue;
    }

    const originalAdditionalProperties = isSchemaObject(originalSchema)
      ? originalSchema.additionalProperties
      : undefined;
    const normalizedAdditionalProperties = isSchemaObject(normalizedSchema)
      ? normalizedSchema.additionalProperties
      : undefined;
    if (
      isSchemaObject(originalAdditionalProperties) ||
      isSchemaObject(normalizedAdditionalProperties)
    ) {
      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        originalAdditionalProperties,
        normalizedAdditionalProperties,
      );
    }
  }
  return sanitizedInput;
}

function selectMatchingDiscriminatedUnionVariant(
  originalSchema: unknown,
  normalizedSchema: unknown,
  input: JsonSchemaRecord,
): SelectedDiscriminatedUnionVariant | undefined {
  if (!isSchemaObject(originalSchema) || !isSchemaObject(normalizedSchema)) {
    return undefined;
  }

  const anyOf = originalSchema.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length < 2) {
    return undefined;
  }

  if (Array.isArray(normalizedSchema.anyOf)) {
    return undefined;
  }

  const analysis = analyzeDiscriminatedObjectUnion(anyOf);
  if (!analysis) {
    return undefined;
  }

  const matchingVariant = analysis.variants.find(
    (variant) =>
      input[analysis.discriminatorKey] === variant.discriminatorValue,
  );
  if (!matchingVariant) {
    return undefined;
  }

  const branchOnlyPropertyNames = new Set<string>();
  for (const variant of analysis.variants) {
    if (variant === matchingVariant) {
      continue;
    }
    for (const propertyName of Object.keys(variant.properties)) {
      if (!(propertyName in matchingVariant.properties)) {
        branchOnlyPropertyNames.add(propertyName);
      }
    }
  }

  return {
    branchOnlyPropertyNames,
    normalizedSchema,
    variant: matchingVariant,
  };
}

function sanitizeUnionVariantInput(
  input: JsonSchemaRecord,
  selectedVariant: SelectedDiscriminatedUnionVariant,
): JsonSchemaRecord {
  const sanitizedInput = structuredClone(input);

  for (const [key, value] of Object.entries(input)) {
    if (key in selectedVariant.variant.properties) {
      const normalizedPropertySchema = isSchemaObject(
        selectedVariant.normalizedSchema.properties,
      )
        ? selectedVariant.normalizedSchema.properties[key]
        : undefined;
      if (
        value === null &&
        !isPropertyRequired(selectedVariant.variant.schema, key) &&
        !schemaAllowsNull(selectedVariant.variant.properties[key]) &&
        schemaAllowsNull(normalizedPropertySchema)
      ) {
        delete sanitizedInput[key];
        continue;
      }

      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        selectedVariant.variant.properties[key],
        normalizedPropertySchema,
      );
      continue;
    }

    if (
      selectedVariant.branchOnlyPropertyNames.has(key) &&
      shouldStripBranchOnlyKey(selectedVariant, value)
    ) {
      delete sanitizedInput[key];
      continue;
    }

    if (isSchemaObject(selectedVariant.variant.schema.additionalProperties)) {
      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        selectedVariant.variant.schema.additionalProperties,
        selectedVariant.normalizedSchema.additionalProperties,
      );
    }
  }

  return sanitizedInput;
}

function shouldStripBranchOnlyKey(
  selectedVariant: SelectedDiscriminatedUnionVariant,
  value: unknown,
): boolean {
  const additionalProperties =
    selectedVariant.variant.schema.additionalProperties;
  if (additionalProperties === true) {
    return false;
  }

  if (isSchemaObject(additionalProperties)) {
    return !schemaCouldAcceptValue(additionalProperties, value);
  }

  return true;
}

function isPropertyRequired(
  schema: JsonSchemaRecord,
  propertyName: string,
): boolean {
  return (
    Array.isArray(schema.required) && schema.required.includes(propertyName)
  );
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!schema) {
    return false;
  }

  if (schema === true) {
    return true;
  }

  if (!isSchemaObject(schema)) {
    return false;
  }

  if (schema.const === null) {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    return true;
  }

  if (schema.type === 'null') {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.some(schemaAllowsNull)) {
    return true;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.some(schemaAllowsNull)) {
    return true;
  }

  return false;
}

function schemaCouldAcceptValue(schema: unknown, value: unknown): boolean {
  if (schema === true) {
    return true;
  }

  if (!isSchemaObject(schema)) {
    return false;
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((entry) => schemaCouldAcceptValue(entry, value));
  }

  if (Array.isArray(schema.oneOf)) {
    return (
      schema.oneOf.filter((entry) => schemaCouldAcceptValue(entry, value))
        .length === 1
    );
  }

  if (Array.isArray(schema.allOf)) {
    return schema.allOf.every((entry) => schemaCouldAcceptValue(entry, value));
  }

  if ('const' in schema) {
    return Object.is(schema.const, value);
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.some((entry) => Object.is(entry, value));
  }

  if (Array.isArray(schema.type)) {
    return schema.type.some((type) => jsonSchemaTypeMatchesValue(type, value));
  }

  if (typeof schema.type === 'string') {
    return jsonSchemaTypeMatchesValue(schema.type, value);
  }

  if (isSchemaObject(schema.properties) || 'additionalProperties' in schema) {
    return isSchemaObject(value);
  }

  if ('items' in schema) {
    return Array.isArray(value);
  }

  return true;
}

function jsonSchemaTypeMatchesValue(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isSchemaObject(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}
