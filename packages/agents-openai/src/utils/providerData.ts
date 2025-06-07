/**
 * Converts camelCase keys of an object to snake_case recursively.
 */
export function camelToSnakeCase<T extends Record<string, any> | undefined>(
  providerData: T | undefined,
): Record<string, any> | undefined {
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
    result[snakeKey] = camelToSnakeCase(value);
  }
  return result;
}

/**
 * Converts snake_case keys of an object to camelCase recursively.
 * Symmetric with camelToSnakeCase.
 */
export function snakeToCamelCase<T extends Record<string, any>>(
  providerData: T | undefined,
): Record<string, any> | undefined {
  if (
    !providerData ||
    typeof providerData !== 'object' ||
    Array.isArray(providerData)
  ) {
    return providerData;
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(providerData)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = snakeToCamelCase(value);
  }
  return result;
}
