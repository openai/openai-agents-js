export type JsonCompatibleValue =
  | null
  | string
  | number
  | boolean
  | JsonCompatibleValue[]
  | { [key: string]: JsonCompatibleValue };

export type SanitizeJsonCompatibleValueOptions = {
  maxDepth?: number;
};

function hasToJSON(value: object): value is object & { toJSON: () => unknown } {
  try {
    return typeof (value as { toJSON?: unknown }).toJSON === 'function';
  } catch {
    return false;
  }
}

/** Converts arbitrary values into JSON-compatible data without throwing. */
export function sanitizeJsonCompatibleValue(
  value: unknown,
  options: SanitizeJsonCompatibleValueOptions = {},
): JsonCompatibleValue | undefined {
  return sanitizeValue(value, new Set(), 0, options.maxDepth ?? 1_000);
}

function sanitizeValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
  maxDepth: number,
): JsonCompatibleValue | undefined {
  if (depth >= maxDepth) return undefined;

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (value && typeof value === 'object' && hasToJSON(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      return sanitizeValue(value.toJSON(), seen, depth + 1, maxDepth);
    } catch {
      return undefined;
    } finally {
      seen.delete(value);
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const sanitized: JsonCompatibleValue[] = [];
    try {
      for (const nestedValue of value) {
        sanitized.push(
          sanitizeValue(nestedValue, seen, depth + 1, maxDepth) ?? null,
        );
      }
    } catch {
      return undefined;
    } finally {
      seen.delete(value);
    }
    return sanitized;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const sanitized: Record<string, JsonCompatibleValue> = {};
    try {
      for (const [key, nestedValue] of Object.entries(value)) {
        const sanitizedNested = sanitizeValue(
          nestedValue,
          seen,
          depth + 1,
          maxDepth,
        );
        if (sanitizedNested !== undefined) {
          sanitized[key] = sanitizedNested;
        }
      }
    } catch {
      return undefined;
    } finally {
      seen.delete(value);
    }
    return sanitized;
  }

  return undefined;
}
