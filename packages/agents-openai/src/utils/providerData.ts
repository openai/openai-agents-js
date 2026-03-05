/**
 * Converts camelCase or snake_case keys of an object to snake_case recursively.
 */
export function camelOrSnakeToSnakeCase<
  T extends Record<string, any> | undefined,
>(providerData: T | undefined): Record<string, any> | undefined {
  if (
    !providerData ||
    typeof providerData !== 'object' ||
    Array.isArray(providerData)
  ) {
    return providerData;
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(providerData)) {
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    result[snakeKey] = camelOrSnakeToSnakeCase(value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns providerData with reserved top-level keys removed.
 */
export function getProviderDataWithoutReservedKeys(
  value: unknown,
  reservedKeys: readonly string[],
): Record<string, any> {
  if (!isRecord(value)) {
    return {};
  }

  const reserved = new Set(reservedKeys);
  const result: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (reserved.has(key)) {
      continue;
    }
    result[key] = entry;
  }
  return result;
}
