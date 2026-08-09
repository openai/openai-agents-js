import type { JsonObjectSchema } from '../types';
import { UserError } from '../errors';
import { readZodDefinition, readZodType } from './zodCompat';

type SyntheticNullableSchema = {
  schema: unknown;
};

type JsonSchemaNullability = 'allows' | 'disallows' | 'unknown';

type StrictSchemaPreparationContext = {
  originalRoot: unknown;
  preparedRoot: unknown;
  preparedSchemas: WeakMap<object, object>;
  references: Array<{
    originalReference: string;
    preparedSchema: Record<string, unknown>;
  }>;
  syntheticNullableSchemas: WeakMap<object, SyntheticNullableSchema>;
};

type PreparedOpenAIStrictToolSchema<T> = {
  schema: T;
  normalizeInput: (value: unknown) => unknown;
};

export function toOpenAIStrictToolSchema<T extends JsonObjectSchema<any>>(
  schema: T,
): T {
  return prepareOpenAIStrictToolSchemaInternal(schema, false).schema;
}

export function prepareOpenAIStrictToolSchema<T extends JsonObjectSchema<any>>(
  schema: T,
): PreparedOpenAIStrictToolSchema<T> {
  return prepareOpenAIStrictToolSchemaInternal(schema, true);
}

export function assertOpenAIStrictToolSchemaPreservesOpenObjects(
  schema: JsonObjectSchema<any>,
): void {
  validateOpenAIStrictJsonSchema(schema, schema, new WeakSet(), true, true);
}

function prepareOpenAIStrictToolSchemaInternal<T extends JsonObjectSchema<any>>(
  schema: T,
  requireUnambiguousNormalization: boolean,
): PreparedOpenAIStrictToolSchema<T> {
  validateOpenAIStrictProviderSchema(schema, schema);
  validateOpenAIStrictJsonSchema(
    schema,
    schema,
    new WeakSet(),
    requireUnambiguousNormalization,
  );
  const preparedSchemas = new WeakMap<object, object>();
  const syntheticNullableSchemas = new WeakMap<
    object,
    SyntheticNullableSchema
  >();
  const context: StrictSchemaPreparationContext = {
    originalRoot: schema,
    preparedRoot: undefined,
    preparedSchemas,
    references: [],
    syntheticNullableSchemas,
  };
  const strictSchema = ensureStrictSchemaEntry(
    structuredClone(schema),
    schema,
    context,
    true,
  ) as T;
  stabilizeLocalJsonSchemaReferences(strictSchema, context);
  context.preparedRoot = strictSchema;

  return {
    schema: strictSchema,
    normalizeInput: (value: unknown) =>
      normalizeStrictJsonSchemaValue(strictSchema, value, context),
  };
}

function ensureStrictSchemaEntry(
  entry: unknown,
  originalEntry: unknown,
  context: StrictSchemaPreparationContext,
  isRoot = false,
): unknown {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }

  const record = entry as Record<string, unknown>;
  const originalRecord = isRecord(originalEntry) ? originalEntry : undefined;
  if (originalRecord) {
    const preparedRecord = context.preparedSchemas.get(originalRecord);
    if (preparedRecord) {
      return preparedRecord;
    }
    context.preparedSchemas.set(originalRecord, record);
  }
  if (typeof originalRecord?.$ref === 'string') {
    context.references.push({
      originalReference: originalRecord.$ref,
      preparedSchema: record,
    });
  }
  const properties = isRecord(record.properties)
    ? record.properties
    : undefined;
  const originalProperties = isRecord(originalRecord?.properties)
    ? originalRecord.properties
    : undefined;
  const hasObjectKeywords =
    properties !== undefined || 'additionalProperties' in record;

  if (
    record.type === undefined &&
    hasObjectKeywords &&
    record.additionalProperties !== false
  ) {
    throw new UserError(
      'Cannot convert a typeless open JSON schema to strict mode. Set `type: "object"` with `additionalProperties: false`, or disable strict mode.',
    );
  }

  if (!isRoot && record.type === undefined && properties !== undefined) {
    record.type = 'object';
  }

  if (schemaConvertsObjectProperties(record) && properties !== undefined) {
    const preparedProperties = { ...properties };
    record.properties = preparedProperties;
    const originalRequired = new Set(
      Array.isArray(originalRecord?.required)
        ? originalRecord.required.map(String)
        : [],
    );

    for (const [key, value] of Object.entries(preparedProperties)) {
      const originalValue = originalProperties?.[key] ?? value;
      const optional = !originalRequired.has(key);
      const nullability = optional
        ? getKnownJsonSchemaNullability(originalValue, context.originalRoot)
        : undefined;
      const normalized = ensureStrictSchemaEntry(value, originalValue, context);
      preparedProperties[key] =
        nullability === 'disallows'
          ? wrapNullableSchema(normalized, context.syntheticNullableSchemas)
          : normalized;
    }

    record.required = Object.keys(preparedProperties);
    record.additionalProperties = false;
  }

  for (const key of ['$defs', 'definitions']) {
    const nested = record[key];
    const originalNested = isRecord(originalRecord?.[key])
      ? originalRecord[key]
      : undefined;
    if (
      typeof nested === 'object' &&
      nested !== null &&
      !Array.isArray(nested)
    ) {
      for (const [nestedKey, nestedValue] of Object.entries(
        nested as Record<string, unknown>,
      )) {
        (nested as Record<string, unknown>)[nestedKey] =
          ensureStrictSchemaEntry(
            nestedValue,
            originalNested?.[nestedKey] ?? nestedValue,
            context,
          );
      }
    }
  }

  for (const key of ['anyOf']) {
    const nested = record[key];
    const originalNested = Array.isArray(originalRecord?.[key])
      ? originalRecord[key]
      : [];
    if (Array.isArray(nested)) {
      record[key] = nested.map((value, index) =>
        ensureStrictSchemaEntry(value, originalNested[index] ?? value, context),
      );
    }
  }

  const items = record.items;
  const originalItems = originalRecord?.items;
  if (Array.isArray(items)) {
    const originalItemEntries = Array.isArray(originalItems)
      ? originalItems
      : [];
    record.items = items.map((value, index) =>
      ensureStrictSchemaEntry(
        value,
        originalItemEntries[index] ?? value,
        context,
      ),
    );
  } else if (typeof items === 'object' && items !== null) {
    record.items = ensureStrictSchemaEntry(
      items,
      originalItems ?? items,
      context,
    );
  }

  if (record.default === null) {
    delete record.default;
  }

  return record;
}

function schemaConvertsObjectProperties(
  schema: Record<string, unknown>,
): boolean {
  return (
    isRecord(schema.properties) &&
    (schema.type === 'object' ||
      (Array.isArray(schema.type) && schema.type.includes('object')) ||
      typeof schema.type === 'undefined')
  );
}

function stabilizeLocalJsonSchemaReferences(
  preparedRoot: unknown,
  context: StrictSchemaPreparationContext,
): void {
  if (!isRecord(preparedRoot)) {
    return;
  }

  // Strict conversion can wrap an optional property, replace
  // `additionalProperties`, or leave an inapplicable subschema untouched. A
  // local pointer into one of those locations would no longer identify the
  // target that was classified and normalized. Hoist only those unstable
  // targets so the provider schema and invocation normalizer share one
  // context-independent prepared node.
  const hoistedReferences = new WeakMap<object, string>();
  let nextDefinitionIndex = 0;

  for (let index = 0; index < context.references.length; index += 1) {
    const { originalReference, preparedSchema } = context.references[index];
    const originalTarget = resolveLocalJsonSchemaReference(
      originalReference,
      context.originalRoot,
    );
    if (typeof originalTarget === 'undefined') {
      continue;
    }

    const preparedTarget = isRecord(originalTarget)
      ? (context.preparedSchemas.get(originalTarget) ??
        ensureStrictSchemaEntry(
          structuredClone(originalTarget),
          originalTarget,
          context,
        ))
      : originalTarget;
    const pointerTarget = resolveLocalJsonSchemaReference(
      originalReference,
      preparedRoot,
    );
    if (pointerTarget === preparedTarget) {
      continue;
    }

    let definitionName = isRecord(originalTarget)
      ? hoistedReferences.get(originalTarget)
      : undefined;
    if (!definitionName) {
      const existingDefinitions = preparedRoot.$defs;
      if (
        typeof existingDefinitions !== 'undefined' &&
        !isRecord(existingDefinitions)
      ) {
        throw new UserError(
          'Cannot stabilize local JSON schema references because the root `$defs` value is not an object. Use an object-valued `$defs` or disable strict mode.',
        );
      }
      const definitions = isRecord(existingDefinitions)
        ? existingDefinitions
        : {};
      preparedRoot.$defs = definitions;
      do {
        definitionName = `__openai_strict_ref_${nextDefinitionIndex}`;
        nextDefinitionIndex += 1;
      } while (
        Object.prototype.hasOwnProperty.call(definitions, definitionName)
      );
      definitions[definitionName] = preparedTarget;
      if (isRecord(originalTarget)) {
        hoistedReferences.set(originalTarget, definitionName);
      }
    }
    preparedSchema.$ref = `#/$defs/${definitionName}`;
  }
}

function wrapNullableSchema(
  schema: unknown,
  syntheticNullableSchemas: WeakMap<object, SyntheticNullableSchema>,
): unknown {
  if (schema === false) {
    const nullableSchema = {
      anyOf: [false, { type: 'null' }],
    };
    syntheticNullableSchemas.set(nullableSchema, { schema });
    return nullableSchema;
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }

  const description =
    typeof (schema as { description?: unknown }).description === 'string'
      ? { description: (schema as { description: string }).description }
      : {};

  const nullableSchema = {
    ...description,
    anyOf: [schema, { type: 'null' }],
  };
  syntheticNullableSchemas.set(nullableSchema, {
    schema,
  });
  return nullableSchema;
}

export function stripStrictNullsForJsonSchema(
  schema: unknown,
  value: unknown,
): unknown {
  if (!isRecord(schema)) {
    return value;
  }

  return prepareOpenAIStrictToolSchema(
    schema as JsonObjectSchema<any>,
  ).normalizeInput(value);
}

function normalizeStrictJsonSchemaValue(
  schema: unknown,
  value: unknown,
  context: StrictSchemaPreparationContext,
): unknown {
  if (value === undefined) {
    return undefined;
  }

  let currentSchema = schema;
  if (isRecord(currentSchema)) {
    const syntheticNullableSchema =
      context.syntheticNullableSchemas.get(currentSchema);
    if (syntheticNullableSchema) {
      if (value === null) {
        return undefined;
      }
      currentSchema = syntheticNullableSchema.schema;
    }
  }
  const resolvedSchema = resolveLocalJsonSchema(currentSchema, context);
  if (resolvedSchema !== currentSchema) {
    return normalizeStrictJsonSchemaValue(resolvedSchema, value, context);
  }

  if (value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    const schemaRecord = isRecord(currentSchema) ? currentSchema : undefined;
    const items = schemaRecord?.items;
    if (Array.isArray(items)) {
      return value.map((entry, index) =>
        normalizeStrictJsonSchemaValue(items[index], entry, context),
      );
    }
    if (items && typeof items === 'object') {
      return value.map((entry) =>
        normalizeStrictJsonSchemaValue(items, entry, context),
      );
    }
    return value;
  }

  if (
    !isRecord(value) ||
    !isRecord(currentSchema) ||
    !schemaConvertsObjectProperties(currentSchema)
  ) {
    return value;
  }

  const properties = isRecord(currentSchema.properties)
    ? currentSchema.properties
    : {};
  const normalized: Record<string, unknown> = { ...value };

  for (const [key, propertySchema] of Object.entries(properties)) {
    const nextValue = normalizeStrictJsonSchemaValue(
      propertySchema,
      normalized[key],
      context,
    );
    if (typeof nextValue === 'undefined') {
      delete normalized[key];
    } else {
      normalized[key] = nextValue;
    }
  }

  return normalized;
}

// This guard defines the local argument normalizer's supported boundary; it is
// not a complete validator for every provider-specific JSON Schema keyword.
// Reject composition and reference forms whose nullability cannot be mapped
// without widening the caller's schema. Local `$ref` values must resolve within
// the root document and cannot carry assertion siblings. Plain `anyOf` branches
// that contain optional object fields are also rejected below, even when they
// have a discriminator, because this path has no runtime schema validator to
// select a branch. Nested `$id` resources are rejected because local pointers
// are resolved only within the root resource. Use Zod for branch-aware
// validation, make the affected fields required, move sibling constraints into
// the branch or target, or disable strict mode.
// Provider compatibility is checked across every retained schema location,
// including properties that the local null normalizer does not traverse.
// Schema applicators outside the traversal below are rejected rather than
// partially interpreted, even when a provider model may accept a subset.
const unsupportedStrictNormalizationKeywords = [
  '$dynamicRef',
  '$recursiveRef',
  'additionalItems',
  'allOf',
  'contains',
  'contentSchema',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'else',
  'if',
  'maxContains',
  'minContains',
  'not',
  'oneOf',
  'patternProperties',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;

const referenceMetadataKeywords = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$id',
  '$ref',
  '$schema',
  'default',
  'deprecated',
  'description',
  'definitions',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

const anyOfMetadataKeywords = new Set([...referenceMetadataKeywords, 'anyOf']);

function validateOpenAIStrictProviderSchema(
  schema: unknown,
  rootSchema: unknown,
  visitedSchemas: WeakSet<object> = new WeakSet(),
): void {
  if (typeof schema === 'boolean') {
    return;
  }
  if (!isRecord(schema)) {
    throw new UserError(
      'Cannot convert a JSON schema containing a non-boolean, non-object schema node to strict mode. Replace the invalid node with a JSON schema object or boolean, or disable strict mode.',
    );
  }
  if (visitedSchemas.has(schema)) {
    return;
  }
  visitedSchemas.add(schema);

  if (schema !== rootSchema && '$id' in schema) {
    throw new UserError(
      'Cannot convert a JSON schema with a nested `$id` resource to strict mode because local references are resolved only within the root resource. Remove the nested `$id` or disable strict mode.',
    );
  }

  for (const keyword of unsupportedStrictNormalizationKeywords) {
    if (keyword in schema) {
      throw new UserError(
        `Cannot convert a JSON schema using unsupported keyword \`${keyword}\` to strict mode. Remove the keyword or disable strict mode.`,
      );
    }
  }

  if ('$ref' in schema) {
    if (typeof schema.$ref !== 'string') {
      throw new UserError(
        'Cannot convert a JSON schema with a non-string `$ref` to strict mode.',
      );
    }
    const resolved = resolveLocalJsonSchemaReference(schema.$ref, rootSchema);
    if (typeof resolved === 'undefined') {
      throw new UserError(
        `Cannot convert unresolved or external JSON schema reference \`${schema.$ref}\` to strict mode. Use a local reference or disable strict mode.`,
      );
    }
    validateOpenAIStrictProviderSchema(resolved, rootSchema, visitedSchemas);
  }

  if ('anyOf' in schema) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new UserError(
        'Cannot convert a JSON schema with an invalid `anyOf` to strict mode.',
      );
    }
    for (const branch of schema.anyOf) {
      validateOpenAIStrictProviderSchema(branch, rootSchema, visitedSchemas);
    }
  }

  const properties = isRecord(schema.properties)
    ? schema.properties
    : undefined;
  if (properties) {
    for (const propertySchema of Object.values(properties)) {
      validateOpenAIStrictProviderSchema(
        propertySchema,
        rootSchema,
        visitedSchemas,
      );
    }
  }

  const items = schema.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      validateOpenAIStrictProviderSchema(item, rootSchema, visitedSchemas);
    }
  } else if (typeof items !== 'undefined') {
    validateOpenAIStrictProviderSchema(items, rootSchema, visitedSchemas);
  }

  if ('additionalProperties' in schema) {
    validateOpenAIStrictProviderSchema(
      schema.additionalProperties,
      rootSchema,
      visitedSchemas,
    );
  }

  for (const key of ['$defs', 'definitions']) {
    const definitions = schema[key];
    if (!isRecord(definitions)) {
      continue;
    }
    for (const definition of Object.values(definitions)) {
      validateOpenAIStrictProviderSchema(
        definition,
        rootSchema,
        visitedSchemas,
      );
    }
  }
}

function validateOpenAIStrictJsonSchema(
  schema: unknown,
  rootSchema: unknown,
  visitedSchemas: WeakSet<object> = new WeakSet(),
  requireUnambiguousNormalization = true,
  rejectOpenObjects = false,
): void {
  if (typeof schema === 'boolean') {
    return;
  }
  if (!isRecord(schema) || visitedSchemas.has(schema)) {
    return;
  }
  visitedSchemas.add(schema);

  if ('$ref' in schema) {
    if (typeof schema.$ref !== 'string') {
      throw new UserError(
        'Cannot convert a JSON schema with a non-string `$ref` to strict mode.',
      );
    }
    const unsupportedSibling = Object.keys(schema).find(
      (key) => !referenceMetadataKeywords.has(key),
    );
    if (unsupportedSibling) {
      throw new UserError(
        `Cannot convert a JSON schema combining \`$ref\` with sibling keyword \`${unsupportedSibling}\` to strict mode. Move the constraint into the referenced schema or disable strict mode.`,
      );
    }
    const resolved = resolveLocalJsonSchemaReference(schema.$ref, rootSchema);
    if (typeof resolved === 'undefined') {
      throw new UserError(
        `Cannot convert unresolved or external JSON schema reference \`${schema.$ref}\` to strict mode. Use a local reference or disable strict mode.`,
      );
    }
    validateOpenAIStrictJsonSchema(
      resolved,
      rootSchema,
      visitedSchemas,
      requireUnambiguousNormalization,
      rejectOpenObjects,
    );
  }

  if ('anyOf' in schema) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new UserError(
        'Cannot convert a JSON schema with an invalid `anyOf` to strict mode.',
      );
    }
    const unsupportedSibling = Object.keys(schema).find(
      (key) => !anyOfMetadataKeywords.has(key),
    );
    if (unsupportedSibling) {
      throw new UserError(
        `Cannot convert a JSON schema combining \`anyOf\` with sibling keyword \`${unsupportedSibling}\` to strict mode. Move the constraint into each branch or disable strict mode.`,
      );
    }
    for (const branch of schema.anyOf) {
      validateOpenAIStrictJsonSchema(
        branch,
        rootSchema,
        visitedSchemas,
        requireUnambiguousNormalization,
        rejectOpenObjects,
      );
    }
    // Plain JSON Schema tools do not have a runtime validator that selects the
    // matching branch. Supporting even discriminated branches here would add a
    // second partial schema interpreter alongside the Zod validation path.
    if (
      requireUnambiguousNormalization &&
      schema.anyOf.some((branch) =>
        jsonSchemaRequiresSyntheticNullStripping(branch, rootSchema),
      )
    ) {
      throw new UserError(
        'Cannot convert an `anyOf` branch containing optional object properties to strict mode because plain JSON Schema tools do not select a branch during input normalization. Use a Zod schema, make the branch properties required, or disable strict mode.',
      );
    }
  }

  const properties = isRecord(schema.properties)
    ? schema.properties
    : undefined;
  const hasObjectType =
    schema.type === 'object' ||
    (Array.isArray(schema.type) && schema.type.includes('object'));
  const hasDeclaredProperties =
    properties !== undefined && Object.keys(properties).length > 0;
  if (
    rejectOpenObjects &&
    hasObjectType &&
    schema.additionalProperties !== false &&
    (!hasDeclaredProperties || 'additionalProperties' in schema)
  ) {
    throw new UserError(
      'Cannot convert an open JSON schema object to strict mode without changing its accepted values. Set `additionalProperties: false`, declare at least one property, or disable strict mode.',
    );
  }
  if (schemaConvertsObjectProperties(schema) && properties) {
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.map(String) : [],
    );
    for (const [key, propertySchema] of Object.entries(properties)) {
      validateOpenAIStrictJsonSchema(
        propertySchema,
        rootSchema,
        visitedSchemas,
        requireUnambiguousNormalization,
        rejectOpenObjects,
      );
      if (!required.has(key)) {
        getKnownJsonSchemaNullability(propertySchema, rootSchema);
      }
    }
  }

  const items = schema.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      validateOpenAIStrictJsonSchema(
        item,
        rootSchema,
        visitedSchemas,
        requireUnambiguousNormalization,
        rejectOpenObjects,
      );
    }
  } else if (typeof items !== 'undefined') {
    validateOpenAIStrictJsonSchema(
      items,
      rootSchema,
      visitedSchemas,
      requireUnambiguousNormalization,
      rejectOpenObjects,
    );
  }

  for (const key of ['$defs', 'definitions']) {
    const definitions = schema[key];
    if (!isRecord(definitions)) {
      continue;
    }
    for (const definition of Object.values(definitions)) {
      validateOpenAIStrictJsonSchema(
        definition,
        rootSchema,
        visitedSchemas,
        requireUnambiguousNormalization,
        rejectOpenObjects,
      );
    }
  }
}

function getKnownJsonSchemaNullability(
  schema: unknown,
  rootSchema: unknown,
): Exclude<JsonSchemaNullability, 'unknown'> {
  const nullability = getJsonSchemaNullability(schema, rootSchema);
  if (nullability === 'unknown') {
    throw new UserError(
      'Cannot determine whether an optional JSON schema property accepts `null`. Make its nullability explicit with a supported schema form, make the property required, or disable strict mode.',
    );
  }
  return nullability;
}

function getJsonSchemaNullability(
  schema: unknown,
  rootSchema: unknown,
  visitedReferences: ReadonlySet<string> = new Set(),
): JsonSchemaNullability {
  if (schema === true) {
    return 'allows';
  }
  if (schema === false) {
    return 'disallows';
  }
  if (!isRecord(schema)) {
    return 'unknown';
  }

  const type = schema.type;
  if ('type' in schema) {
    if (typeof type !== 'string' && !Array.isArray(type)) {
      return 'unknown';
    }
    if (type !== 'null' && !(Array.isArray(type) && type.includes('null'))) {
      return 'disallows';
    }
  }

  if ('enum' in schema) {
    if (!Array.isArray(schema.enum)) {
      return 'unknown';
    }
    if (!schema.enum.includes(null)) {
      return 'disallows';
    }
  }

  if ('const' in schema && schema.const !== null) {
    return 'disallows';
  }

  if ('$ref' in schema) {
    const referencedNullability = getReferencedJsonSchemaNullability(
      schema.$ref,
      rootSchema,
      visitedReferences,
    );
    if (referencedNullability !== 'allows') {
      return referencedNullability;
    }
  }

  if ('anyOf' in schema) {
    if (!Array.isArray(schema.anyOf)) {
      return 'unknown';
    }
    const entries = schema.anyOf.map((entry) =>
      getJsonSchemaNullability(entry, rootSchema, visitedReferences),
    );
    if (entries.includes('allows')) {
      return 'allows';
    }
    return entries.every((entry) => entry === 'disallows')
      ? 'disallows'
      : 'unknown';
  }

  // Strict conversion infers an object type for nested schemas that declare
  // properties. Preserve that released interpretation when deciding whether an
  // optional property needs a synthetic nullable wrapper.
  if (!('type' in schema) && isRecord(schema.properties)) {
    return 'disallows';
  }

  return 'allows';
}

function jsonSchemaRequiresSyntheticNullStripping(
  schema: unknown,
  rootSchema: unknown,
  visitedSchemas: WeakSet<object> = new WeakSet(),
): boolean {
  if (!isRecord(schema) || visitedSchemas.has(schema)) {
    return false;
  }
  visitedSchemas.add(schema);

  if (typeof schema.$ref === 'string') {
    const resolved = resolveLocalJsonSchemaReference(schema.$ref, rootSchema);
    return jsonSchemaRequiresSyntheticNullStripping(
      resolved,
      rootSchema,
      visitedSchemas,
    );
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((branch) =>
      jsonSchemaRequiresSyntheticNullStripping(
        branch,
        rootSchema,
        visitedSchemas,
      ),
    );
  }

  const properties =
    schemaConvertsObjectProperties(schema) && isRecord(schema.properties)
      ? schema.properties
      : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (
      (!required.has(key) &&
        getKnownJsonSchemaNullability(propertySchema, rootSchema) ===
          'disallows') ||
      jsonSchemaRequiresSyntheticNullStripping(
        propertySchema,
        rootSchema,
        visitedSchemas,
      )
    ) {
      return true;
    }
  }

  const items = schema.items;
  return Array.isArray(items)
    ? items.some((item) =>
        jsonSchemaRequiresSyntheticNullStripping(
          item,
          rootSchema,
          visitedSchemas,
        ),
      )
    : jsonSchemaRequiresSyntheticNullStripping(
        items,
        rootSchema,
        visitedSchemas,
      );
}

function getReferencedJsonSchemaNullability(
  reference: unknown,
  rootSchema: unknown,
  visitedReferences: ReadonlySet<string>,
): JsonSchemaNullability {
  if (typeof reference !== 'string' || visitedReferences.has(reference)) {
    return 'unknown';
  }

  const resolved = resolveLocalJsonSchemaReference(reference, rootSchema);
  if (typeof resolved === 'undefined') {
    return 'unknown';
  }
  return getJsonSchemaNullability(
    resolved,
    rootSchema,
    new Set([...visitedReferences, reference]),
  );
}

function resolveLocalJsonSchema(
  schema: unknown,
  context: StrictSchemaPreparationContext,
): unknown {
  let current = schema;
  const visitedReferences = new Set<string>();

  while (isRecord(current) && typeof current.$ref === 'string') {
    const reference = current.$ref;
    if (visitedReferences.has(reference)) {
      return schema;
    }
    visitedReferences.add(reference);

    const resolved = resolveLocalJsonSchemaReference(
      reference,
      context.preparedRoot,
    );
    if (typeof resolved === 'undefined') {
      return schema;
    }
    current = resolved;
  }

  return current;
}

function resolveLocalJsonSchemaReference(
  reference: string,
  rootSchema: unknown,
): unknown {
  if (!reference.startsWith('#')) {
    return undefined;
  }
  return reference === '#'
    ? rootSchema
    : resolveJsonPointer(rootSchema, reference);
}

function resolveJsonPointer(root: unknown, reference: string): unknown {
  let current = root;
  let pointer: string;

  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  if (!pointer.startsWith('/')) {
    return undefined;
  }

  for (const rawToken of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(rawToken)) {
      return undefined;
    }
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      typeof current !== 'object' ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, token)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }

  return current;
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

  if (type === 'intersection') {
    const left = stripStrictNullsForZodSchema(def?.left, value);
    return stripStrictNullsForZodSchema(def?.right, left);
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
