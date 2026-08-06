import type { AgentOutputType } from './agent';
import { convertAgentOutputTypeToSerializable } from './utils/tools';

type ComparableJsonValue =
  | null
  | boolean
  | number
  | string
  | ComparableJsonValue[]
  | { [key: string]: ComparableJsonValue };

const NOT_COMPARABLE = Symbol('notComparable');

function isPrimitiveOutputType(value: unknown): boolean {
  return (
    value === null || (typeof value !== 'object' && typeof value !== 'function')
  );
}

function readOwnDataProperty(
  value: object,
  key: PropertyKey,
): { found: boolean; value?: unknown } | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      return { found: false };
    }
    if (!('value' in descriptor)) {
      return undefined;
    }
    return { found: true, value: descriptor.value };
  } catch (_error) {
    return undefined;
  }
}

function getComparableJsonSchemaOutputType(
  outputType: object,
): unknown | undefined {
  const type = readOwnDataProperty(outputType, 'type');
  if (type?.found && type.value === 'json_schema') {
    const name = readOwnDataProperty(outputType, 'name');
    const strict = readOwnDataProperty(outputType, 'strict');
    const schema = readOwnDataProperty(outputType, 'schema');
    if (!name?.found || !strict?.found || !schema?.found) {
      return undefined;
    }
    return {
      type: type.value,
      name: name.value,
      strict: strict.value,
      schema: schema.value,
    };
  }

  return undefined;
}

function getComparableOutputType(outputType: unknown): unknown | undefined {
  if (typeof outputType !== 'object' || outputType === null) {
    return outputType;
  }

  const outputTypeDiscriminator = readOwnDataProperty(outputType, 'type');
  if (!outputTypeDiscriminator) {
    return undefined;
  }
  if (
    outputTypeDiscriminator.found &&
    outputTypeDiscriminator.value === 'json_schema'
  ) {
    return getComparableJsonSchemaOutputType(outputType);
  }

  try {
    const serializedOutputType = convertAgentOutputTypeToSerializable(
      outputType as AgentOutputType,
    );
    if (
      typeof serializedOutputType !== 'object' ||
      serializedOutputType === null
    ) {
      return serializedOutputType;
    }
    return getComparableJsonSchemaOutputType(serializedOutputType);
  } catch (_error) {
    return undefined;
  }
}

function detectArray(value: object): boolean | undefined {
  try {
    return Array.isArray(value);
  } catch (_error) {
    return undefined;
  }
}

function readArrayLength(value: object): number | undefined {
  const length = readOwnDataProperty(value, 'length');
  return length?.found && typeof length.value === 'number'
    ? length.value
    : undefined;
}

function isOmittedJsonObjectValue(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  );
}

function toComparableJsonValue(
  value: unknown,
  ancestors: Set<object>,
): ComparableJsonValue | typeof NOT_COMPARABLE {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NOT_COMPARABLE;
  }
  if (typeof value !== 'object') {
    return NOT_COMPARABLE;
  }
  if (ancestors.has(value)) {
    return NOT_COMPARABLE;
  }

  const isArray = detectArray(value);
  if (isArray === undefined) {
    return NOT_COMPARABLE;
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const length = readArrayLength(value);
      if (length === undefined) {
        return NOT_COMPARABLE;
      }
      const comparable: ComparableJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const element = readOwnDataProperty(value, index);
        if (!element) {
          return NOT_COMPARABLE;
        }
        if (!element.found || isOmittedJsonObjectValue(element.value)) {
          comparable.push(null);
          continue;
        }
        const comparableElement = toComparableJsonValue(
          element.value,
          ancestors,
        );
        if (comparableElement === NOT_COMPARABLE) {
          return NOT_COMPARABLE;
        }
        comparable.push(comparableElement);
      }
      return comparable;
    }

    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch (_error) {
      return NOT_COMPARABLE;
    }

    const comparable: { [key: string]: ComparableJsonValue } =
      Object.create(null);
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) {
        continue;
      }
      if (!('value' in descriptor)) {
        return NOT_COMPARABLE;
      }
      if (isOmittedJsonObjectValue(descriptor.value)) {
        continue;
      }
      const comparableProperty = toComparableJsonValue(
        descriptor.value,
        ancestors,
      );
      if (comparableProperty === NOT_COMPARABLE) {
        return NOT_COMPARABLE;
      }
      comparable[key] = comparableProperty;
    }
    return comparable;
  } finally {
    ancestors.delete(value);
  }
}

function stringifyComparableJsonValue(value: ComparableJsonValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringifyComparableJsonValue).join(',')}]`;
  }
  return `{${Object.keys(value)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stringifyComparableJsonValue(value[key])}`,
    )
    .join(',')}}`;
}

function getOutputTypeFingerprint(outputType: unknown): string | undefined {
  const comparableOutputType = getComparableOutputType(outputType);
  if (comparableOutputType === undefined) {
    return undefined;
  }
  const comparableJsonValue = toComparableJsonValue(
    comparableOutputType,
    new Set(),
  );
  if (comparableJsonValue === NOT_COMPARABLE) {
    return undefined;
  }
  return stringifyComparableJsonValue(comparableJsonValue);
}

/**
 * Returns true only when different output types can be established from canonical snapshots that
 * do not invoke schema accessors or serialization hooks.
 *
 * @internal
 */
export function hasDefinitelyDifferentOutputTypes(
  outputTypes: unknown[],
): boolean {
  if (outputTypes.length < 2) {
    return false;
  }
  const outputTypeFingerprints = outputTypes.map(getOutputTypeFingerprint);

  for (let leftIndex = 0; leftIndex < outputTypes.length - 1; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < outputTypes.length;
      rightIndex += 1
    ) {
      const leftOutputType = outputTypes[leftIndex];
      const rightOutputType = outputTypes[rightIndex];
      if (Object.is(leftOutputType, rightOutputType)) {
        continue;
      }
      if (
        isPrimitiveOutputType(leftOutputType) ||
        isPrimitiveOutputType(rightOutputType)
      ) {
        return true;
      }
      const leftFingerprint = outputTypeFingerprints[leftIndex];
      const rightFingerprint = outputTypeFingerprints[rightIndex];
      if (
        leftFingerprint !== undefined &&
        rightFingerprint !== undefined &&
        leftFingerprint !== rightFingerprint
      ) {
        return true;
      }
    }
  }
  return false;
}
