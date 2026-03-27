import {
  analyzeDiscriminatedObjectUnion,
  DiscriminatedObjectUnionVariant,
  isSchemaObject,
  JsonSchemaRecord,
} from './generatedJsonSchemaUnion';

type SelectedDiscriminatedUnionVariant = {
  branchOnlyPropertyNames: Set<string>;
  variant: DiscriminatedObjectUnionVariant;
};

export function sanitizeNormalizedUnionInput<T>(
  input: T,
  originalSchema: unknown,
): T {
  return sanitizeInputForSchema(input, originalSchema) as T;
}

function sanitizeInputForSchema(input: unknown, schema: unknown): unknown {
  if (Array.isArray(input)) {
    if (!isSchemaObject(schema)) {
      return input;
    }
    if (Array.isArray(schema.items)) {
      return input.map((item, index) =>
        sanitizeInputForSchema(item, schema.items[index]),
      );
    }
    return input.map((item) => sanitizeInputForSchema(item, schema.items));
  }

  if (!isSchemaObject(input) || !isSchemaObject(schema)) {
    return input;
  }

  const selectedVariant = selectMatchingDiscriminatedUnionVariant(
    schema,
    input,
  );
  if (selectedVariant) {
    return sanitizeUnionVariantInput(input, selectedVariant);
  }

  const sanitizedInput = structuredClone(input);
  for (const [key, value] of Object.entries(input)) {
    if (isSchemaObject(schema.properties) && key in schema.properties) {
      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        schema.properties[key],
      );
      continue;
    }
    if (isSchemaObject(schema.additionalProperties)) {
      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        schema.additionalProperties,
      );
    }
  }
  return sanitizedInput;
}

function selectMatchingDiscriminatedUnionVariant(
  schema: JsonSchemaRecord,
  input: JsonSchemaRecord,
): SelectedDiscriminatedUnionVariant | undefined {
  const anyOf = schema.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length < 2) {
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
      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        selectedVariant.variant.properties[key],
      );
      continue;
    }

    if (value === null && selectedVariant.branchOnlyPropertyNames.has(key)) {
      delete sanitizedInput[key];
      continue;
    }

    if (isSchemaObject(selectedVariant.variant.schema.additionalProperties)) {
      sanitizedInput[key] = sanitizeInputForSchema(
        value,
        selectedVariant.variant.schema.additionalProperties,
      );
    }
  }

  return sanitizedInput;
}
