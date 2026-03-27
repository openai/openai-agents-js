import { isSchemaObject } from './generatedJsonSchemaUnion';

export function getComparableSchemaFingerprint(input: unknown): string {
  return JSON.stringify(
    canonicalizeSchemaForComparison(stripDescriptionFields(input)),
  );
}

export function schemasAreEquivalent(left: unknown, right: unknown): boolean {
  return (
    getComparableSchemaFingerprint(left) ===
    getComparableSchemaFingerprint(right)
  );
}

function canonicalizeSchemaForComparison(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(canonicalizeSchemaForComparison);
  }

  if (!isSchemaObject(input)) {
    return input;
  }

  const sortedEntries = Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (
        (key === 'required' || key === 'enum' || key === 'type') &&
        Array.isArray(value)
      ) {
        return [
          key,
          [...value].sort((leftValue, rightValue) =>
            JSON.stringify(leftValue).localeCompare(JSON.stringify(rightValue)),
          ),
        ];
      }
      return [key, canonicalizeSchemaForComparison(value)];
    });

  return Object.fromEntries(sortedEntries);
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
