type UnknownRecord = Record<string, unknown>;

type SnakeCaseKey<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${SnakeCaseKey<Tail>}`
  : S;

type CamelCaseKey<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCaseKey<Tail>>}`
  : S;

type SnakeCased<T> = T extends readonly unknown[]
  ? T
  : T extends UnknownRecord
    ? {
        [K in keyof T as K extends string ? SnakeCaseKey<K> : K]: SnakeCased<
          T[K]
        >;
      }
    : T;

type CamelCased<T> = T extends readonly unknown[]
  ? {
      [K in keyof T]: CamelCased<T[K]>;
    }
  : T extends UnknownRecord
    ? {
        [K in keyof T as K extends string ? CamelCaseKey<K> : K]: CamelCased<
          T[K]
        >;
      }
    : T;

/**
 * Converts object keys to snake_case recursively while preserving array entries as-is.
 */
export function camelOrSnakeToSnakeCase<T>(value: T): SnakeCased<T> {
  if (Array.isArray(value)) {
    return value.slice() as SnakeCased<T>;
  }

  if (!isRecord(value)) {
    return value as SnakeCased<T>;
  }

  const result: UnknownRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    result[snakeKey] = camelOrSnakeToSnakeCase(entry);
  }
  return result as SnakeCased<T>;
}

/**
 * Converts snake_case or camelCase keys of a JSON-like value to camelCase recursively.
 */
export function snakeOrCamelToCamelCase<T>(value: T): CamelCased<T> {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      snakeOrCamelToCamelCase(entry),
    ) as CamelCased<T>;
  }

  if (!isRecord(value)) {
    return value as CamelCased<T>;
  }

  const result: UnknownRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const camelKey = key.replace(/_([a-z])/g, (_match, char: string) =>
      char.toUpperCase(),
    );
    result[camelKey] = snakeOrCamelToCamelCase(entry);
  }
  return result as CamelCased<T>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSnakeCase(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function omitReservedKeys(
  value: unknown,
  reservedKeys: ReadonlySet<string>,
): UnknownRecord {
  if (!isRecord(value)) {
    return {};
  }

  const result: UnknownRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (reservedKeys.has(key)) {
      continue;
    }
    result[key] = entry;
  }
  return result;
}

/**
 * Returns providerData with reserved top-level keys removed.
 */
export function getProviderDataWithoutReservedKeys(
  value: unknown,
  reservedKeys: readonly string[],
): UnknownRecord {
  return omitReservedKeys(value, new Set(reservedKeys));
}

/**
 * Normalizes providerData keys to snake_case, then removes reserved top-level keys.
 */
export function getSnakeCasedProviderDataWithoutReservedKeys(
  value: unknown,
  reservedKeys: readonly string[],
): UnknownRecord {
  return omitReservedKeys(
    camelOrSnakeToSnakeCase(value),
    new Set(reservedKeys.map((key) => toSnakeCase(key))),
  );
}
