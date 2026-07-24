import type { AgentOutputType } from './agent';
import { convertAgentOutputTypeToSerializable } from './utils/tools';

type StructuralComparison = 'equal' | 'different' | 'unknown';

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

function getComparableObjectProperties(
  value: object,
): Record<string, PropertyDescriptor> | undefined {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_error) {
    return undefined;
  }

  const comparable: Record<string, PropertyDescriptor> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || key === 'toJSON') {
      continue;
    }
    if (!('value' in descriptor)) {
      return undefined;
    }
    if (
      descriptor.value === undefined ||
      typeof descriptor.value === 'function' ||
      typeof descriptor.value === 'symbol'
    ) {
      continue;
    }
    if (typeof descriptor.value === 'bigint') {
      return undefined;
    }
    comparable[key] = descriptor;
  }
  return comparable;
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

function compareJsonLikeValues(
  left: unknown,
  right: unknown,
  visited: WeakMap<object, WeakMap<object, StructuralComparison>>,
): StructuralComparison {
  if (Object.is(left, right)) {
    return 'equal';
  }
  if (left === null || right === null) {
    return 'different';
  }
  if (typeof left !== typeof right) {
    return 'different';
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    if (
      (typeof left === 'number' && !Number.isFinite(left)) ||
      (typeof right === 'number' && !Number.isFinite(right)) ||
      typeof left === 'bigint' ||
      typeof left === 'function' ||
      typeof left === 'symbol' ||
      typeof left === 'undefined'
    ) {
      return 'unknown';
    }
    return 'different';
  }

  const leftIsArray = detectArray(left);
  const rightIsArray = detectArray(right);
  if (leftIsArray === undefined || rightIsArray === undefined) {
    return 'unknown';
  }
  if (leftIsArray !== rightIsArray) {
    return 'different';
  }

  const priorComparison = visited.get(left)?.get(right);
  if (priorComparison) {
    return priorComparison === 'unknown' ? 'unknown' : priorComparison;
  }
  const rightComparisons = visited.get(left) ?? new WeakMap();
  visited.set(left, rightComparisons);
  rightComparisons.set(right, 'unknown');

  if (leftIsArray && rightIsArray) {
    const leftLength = readArrayLength(left);
    const rightLength = readArrayLength(right);
    if (leftLength === undefined || rightLength === undefined) {
      return 'unknown';
    }
    if (leftLength !== rightLength) {
      rightComparisons.set(right, 'different');
      return 'different';
    }
    for (let index = 0; index < leftLength; index += 1) {
      const leftValue = readOwnDataProperty(left, index);
      const rightValue = readOwnDataProperty(right, index);
      if (!leftValue || !rightValue) {
        return 'unknown';
      }
      const comparison = compareJsonLikeValues(
        leftValue.found ? leftValue.value : null,
        rightValue.found ? rightValue.value : null,
        visited,
      );
      if (comparison !== 'equal') {
        rightComparisons.set(right, comparison);
        return comparison;
      }
    }
    rightComparisons.set(right, 'equal');
    return 'equal';
  }

  const leftProperties = getComparableObjectProperties(left);
  const rightProperties = getComparableObjectProperties(right);
  if (!leftProperties || !rightProperties) {
    return 'unknown';
  }
  const leftKeys = Object.keys(leftProperties).sort();
  const rightKeys = Object.keys(rightProperties).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    rightComparisons.set(right, 'different');
    return 'different';
  }

  for (const key of leftKeys) {
    const comparison = compareJsonLikeValues(
      leftProperties[key].value,
      rightProperties[key].value,
      visited,
    );
    if (comparison !== 'equal') {
      rightComparisons.set(right, comparison);
      return comparison;
    }
  }
  rightComparisons.set(right, 'equal');
  return 'equal';
}

function compareStructuredOutputTypes(
  comparableLeft: unknown,
  comparableRight: unknown,
): StructuralComparison {
  if (comparableLeft === undefined || comparableRight === undefined) {
    return 'unknown';
  }
  return compareJsonLikeValues(comparableLeft, comparableRight, new WeakMap());
}

/**
 * Returns true only when different output types can be established without invoking schema
 * serialization hooks. Supported structured schemas are compared without exposing their details.
 *
 * @internal
 */
export function hasDefinitelyDifferentOutputTypes(
  outputTypes: unknown[],
): boolean {
  if (outputTypes.length < 2) {
    return false;
  }
  const comparableOutputTypes = outputTypes.map(getComparableOutputType);

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
      if (
        compareStructuredOutputTypes(
          comparableOutputTypes[leftIndex],
          comparableOutputTypes[rightIndex],
        ) === 'different'
      ) {
        return true;
      }
    }
  }
  return false;
}
